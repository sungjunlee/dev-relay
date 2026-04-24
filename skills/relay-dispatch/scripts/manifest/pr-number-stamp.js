"use strict";

const fs = require("fs");
const path = require("path");

const { STATES } = require("./lifecycle");
const {
  getCanonicalRepoRoot,
  getRunDir,
  validateManifestPaths,
} = require("./paths");
const { readManifest, writeManifest } = require("./store");
const { appendRunEvent, readRunEvents } = require("../relay-events");

function parsePositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const PR_NUMBER_STAMP_LOCK_NAME = ".pr_number_stamp.lock";
const PR_NUMBER_STAMP_LOCK_TIMEOUT_MS = parsePositiveIntEnv("RELAY_PR_NUMBER_STAMP_LOCK_TIMEOUT_MS", 5000);
const PR_NUMBER_STAMP_LOCK_POLL_MS = parsePositiveIntEnv("RELAY_PR_NUMBER_STAMP_LOCK_POLL_MS", 50);
const PR_NUMBER_STAMP_WAIT_STATE = new Int32Array(new SharedArrayBuffer(4));
// Rule 7 (#177 / #166): whitelist non-terminal states so tampered or missing
// state values fail-closed (skip stamping) at the inside-lock recheck.
const NON_TERMINAL_STATES_FOR_PR_STAMP = new Set(
  Object.values(STATES).filter((state) => state !== STATES.MERGED && state !== STATES.CLOSED)
);

function isNonTerminalStateForPrStamp(state) {
  return NON_TERMINAL_STATES_FOR_PR_STAMP.has(state);
}

function defaultRepoRoot() {
  return getCanonicalRepoRoot(process.cwd());
}

function readFreshManifestRecord(manifestRecord) {
  const fresh = readManifest(manifestRecord.manifestPath);
  return {
    ...manifestRecord,
    data: fresh.data,
    body: fresh.body,
  };
}

function waitForPrNumberStampLock(lockPath) {
  const deadline = Date.now() + PR_NUMBER_STAMP_LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      // Rule 1 layer A (#166): serialize the read-check-write-append branch so only one
      // process performs first-resolution stamping for a run at a time.
      return fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      Atomics.wait(PR_NUMBER_STAMP_WAIT_STATE, 0, 0, PR_NUMBER_STAMP_LOCK_POLL_MS);
    }
  }

  return null;
}

function stampPrNumberUnderLock(manifestRecord, numericPrNumber, options = {}) {
  const caller = options.caller || "PR number stamping";
  const expectedRepoRoot = options.expectedRepoRoot === undefined
    ? defaultRepoRoot()
    : options.expectedRepoRoot;
  const eventReason = options.reason
    || `Stamped git.pr_number=${numericPrNumber} during PR resolution`;
  const validatedPaths = validateManifestPaths(manifestRecord.data?.paths, {
    expectedRepoRoot,
    manifestPath: manifestRecord.manifestPath,
    runId: manifestRecord.data?.run_id,
    caller,
  });
  const repoRoot = validatedPaths.repoRoot;
  const runDir = getRunDir(repoRoot, manifestRecord.data?.run_id);
  const lockPath = path.join(runDir, PR_NUMBER_STAMP_LOCK_NAME);
  let lockFd = null;

  fs.mkdirSync(runDir, { recursive: true });
  lockFd = waitForPrNumberStampLock(lockPath);
  if (lockFd === null) {
    // #185 / meta-rule 1 recursive: the timeout fallthrough serves two downstream
    // consumers. Audit-trail dedup is still fail-safe, but callers must fail-closed
    // if a stale lock or peer crash left git.pr_number unset. Re-read first so
    // healthy contention still succeeds when the peer finished stamping during our wait.
    const freshRecord = readFreshManifestRecord(manifestRecord);
    if (!isNonTerminalStateForPrStamp(freshRecord.data?.state)) {
      return freshRecord;
    }
    const freshPrNumber = freshRecord.data?.git?.pr_number;
    if (freshPrNumber !== undefined && freshPrNumber !== null) {
      return freshRecord;
    }
    throw new Error(
      `${caller}: .pr_number_stamp.lock contention timeout left git.pr_number unset after a fresh re-read. `
      + "This may indicate a stale lock, peer crash, or a still-running holder on a slow filesystem. "
      + `Inspect ${JSON.stringify(lockPath)} and clear it only after confirming no active holder is still stamping. `
      + "See #185 / #166 for background."
    );
  }

  try {
    const freshRecord = readFreshManifestRecord(manifestRecord);

    // Rule 4 (#166): re-apply the non-terminal whitelist after the fresh read.
    // A concurrent close-run / finalize-run may have transitioned the manifest
    // during our bounded wait. Fail-safe skip preserves the caller's contract
    // without turning the race into a throw.
    if (!isNonTerminalStateForPrStamp(freshRecord.data?.state)) {
      return freshRecord;
    }

    if (freshRecord.data?.git?.pr_number !== undefined && freshRecord.data?.git?.pr_number !== null) {
      return freshRecord;
    }

    const updatedData = {
      ...freshRecord.data,
      git: {
        ...(freshRecord.data?.git || {}),
        pr_number: numericPrNumber,
      },
    };

    writeManifest(manifestRecord.manifestPath, updatedData, freshRecord.body);

    // Rule 1 layer B (#166): dedupe against the committed journal so even a future lock
    // regression cannot emit duplicate first-resolution pr_number_stamped events.
    const alreadyStamped = readRunEvents(repoRoot, updatedData.run_id)
      .some((entry) => entry.event === "pr_number_stamped");

    if (!alreadyStamped) {
      appendRunEvent(repoRoot, updatedData.run_id, {
        event: "pr_number_stamped",
        state_from: updatedData.state,
        state_to: updatedData.state,
        head_sha: updatedData.git?.head_sha || null,
        round: updatedData.review?.rounds || null,
        reason: eventReason,
      });
    }

    return {
      ...freshRecord,
      data: updatedData,
    };
  } finally {
    try {
      fs.closeSync(lockFd);
    } catch {}
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

module.exports = {
  PR_NUMBER_STAMP_LOCK_NAME,
  stampPrNumberUnderLock,
};
