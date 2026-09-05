"use strict";

/** Machine-wide full-gate lock, stale reclaim, and status IO helpers. */

const fs = require("fs");
const os = require("os");
const path = require("path");

const LOCK_POLL_MS = 100;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, "utf-8");
  fs.renameSync(temporaryPath, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function sameOwner(left, right) {
  return left?.pid === right?.pid
    && left?.pgid === right?.pgid
    && left?.host === right?.host
    && left?.started_at === right?.started_at;
}

function createLockAtomically(lockPath, owner) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const candidatePath = `${lockPath}.${process.pid}.${Date.now()}.candidate`;
  fs.writeFileSync(candidatePath, `${JSON.stringify(owner)}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    fs.linkSync(candidatePath, lockPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    try { fs.unlinkSync(candidatePath); } catch {}
  }
}

function releaseLock(lockPath, owner) {
  const current = readJson(lockPath);
  if (sameOwner(current, owner)) {
    try { fs.unlinkSync(lockPath); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function updateStatus(config, status) {
  atomicWriteJson(config.statusPath, {
    runner_pid: process.pid,
    runner_pgid: process.pid,
    ...status,
  });
}

function acquireLock(config, owner) {
  const waitStarted = Date.now();
  let didWait = false;
  let firstOwner = null;
  let staleReclaimed = false;

  while (true) {
    if (createLockAtomically(config.lockPath, owner)) {
      const waitedMs = Date.now() - waitStarted;
      updateStatus(config, {
        state: "running",
        lock_wait: { did_wait: didWait, waited_ms: waitedMs, owner: firstOwner, stale_reclaimed: staleReclaimed },
      });
      return { acquired: true, didWait, waitedMs, owner: firstOwner, staleReclaimed };
    }

    const current = readJson(config.lockPath);
    const localOwner = current?.host === os.hostname();
    const stale = !current || (localOwner && !isProcessAlive(current.pid));
    if (stale) {
      const observed = fs.existsSync(config.lockPath) ? fs.readFileSync(config.lockPath, "utf-8") : null;
      const latest = readJson(config.lockPath);
      if (observed !== null && sameOwner(current, latest)) {
        try {
          fs.unlinkSync(config.lockPath);
          staleReclaimed = true;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      continue;
    }

    didWait = true;
    if (!firstOwner) firstOwner = current;
    const waitedMs = Date.now() - waitStarted;
    updateStatus(config, {
      state: "waiting_for_lock",
      lock_wait: { did_wait: true, waited_ms: waitedMs, owner: current, stale_reclaimed: staleReclaimed },
    });
    if (waitedMs >= config.lockTimeoutMs) {
      return { acquired: false, didWait: true, waitedMs, owner: firstOwner, staleReclaimed };
    }
    sleep(Math.min(LOCK_POLL_MS, config.lockTimeoutMs - waitedMs));
  }
}

module.exports = {
  acquireLock,
  atomicWriteJson,
  createLockAtomically,
  isProcessAlive,
  readJson,
  releaseLock,
  sameOwner,
  sleep,
  updateStatus,
};
