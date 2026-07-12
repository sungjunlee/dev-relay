#!/usr/bin/env node
"use strict";

/**
 * Run the pre-merge test gate one file at a time under a machine-wide lock.
 * The public process launches a detached copy of this script and waits for its
 * sentinel. The detached process owns both the test process group and lock.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const {
  bindCliArgs,
  findUnknownFlags,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");

const DEFAULT_SUITES = [
  "tests/relay-ready/scripts/*.test.js",
  "tests/relay-plan/scripts/*.test.js",
  "tests/relay-dispatch/scripts/*.test.js",
  "tests/relay-review/scripts/*.test.js",
  "tests/relay-merge/scripts/*.test.js",
  "tests/relay/scripts/*.test.js",
  "tests/relay-config/scripts/*.test.js",
  "tests/relay-fleet/scripts/*.test.js",
  "tests/skills-lint/scripts/*.test.js",
];
const KNOWN_FLAGS = [
  "--repo", "--suites", "--output", "--lock-timeout", "--json", "--help", "-h",
];
const LOCK_POLL_MS = 100;
const SENTINEL_POLL_MS = 100;
const DEFAULT_LOCK_TIMEOUT_SECONDS = 600;
const INTERNAL_CONFIG_ENV = "RELAY_FULL_GATE_RUNNER_CONFIG";

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

function globToRegExp(pattern) {
  let source = "^";
  const normalized = pattern.replaceAll("\\", "/");
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function globBase(pattern) {
  const normalized = pattern.replaceAll("\\", "/");
  const wildcard = normalized.search(/[?*]/);
  const prefix = wildcard === -1 ? normalized : normalized.slice(0, wildcard);
  const directory = prefix.endsWith("/") ? prefix.slice(0, -1) : path.posix.dirname(prefix);
  return directory || ".";
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function expandSuites(repo, patterns) {
  const matched = new Set();
  for (const rawPattern of patterns) {
    const absolutePattern = path.isAbsolute(rawPattern) ? path.normalize(rawPattern) : path.resolve(repo, rawPattern);
    const expression = globToRegExp(absolutePattern.replaceAll("\\", "/"));
    const base = path.normalize(globBase(absolutePattern));
    for (const filePath of walkFiles(base)) {
      if (expression.test(path.resolve(filePath).replaceAll("\\", "/"))) matched.add(path.resolve(filePath));
    }
  }
  return [...matched].sort();
}

function evidenceName(repo, filePath) {
  const relative = path.relative(repo, filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

function writeSentinel(config, result) {
  atomicWriteJson(config.sentinelPath, result);
}

function runDetached(config) {
  const startedAt = Date.now();
  const owner = {
    pid: process.pid,
    pgid: process.pid,
    host: os.hostname(),
    started_at: new Date(startedAt).toISOString(),
  };
  updateStatus(config, { state: "starting", lock_wait: null });
  const lockWait = acquireLock(config, owner);
  if (!lockWait.acquired) {
    const result = {
      result: "lock_timeout",
      exit_code: 2,
      duration_ms: Date.now() - startedAt,
      output: config.output,
      sentinel: config.sentinelPath,
      lock_wait: {
        did_wait: lockWait.didWait,
        waited_ms: lockWait.waitedMs,
        owner: lockWait.owner,
        stale_reclaimed: lockWait.staleReclaimed,
      },
    };
    updateStatus(config, { state: "lock_timeout", lock_wait: result.lock_wait });
    writeSentinel(config, result);
    return;
  }

  try {
    fs.mkdirSync(path.dirname(config.output), { recursive: true });
    const files = expandSuites(config.repo, config.suites);
    if (!files.length) {
      throw new Error(`no test files matched --suites: ${config.suites.join(",")}`);
    }
    const failedFiles = [];
    fs.writeFileSync(config.output, "", "utf-8");
    for (const filePath of files) {
      const label = evidenceName(config.repo, filePath);
      fs.appendFileSync(config.output, `===== ${label} =====\n`, "utf-8");
      const testResult = spawnSync(process.execPath, ["--test", filePath], {
        cwd: config.repo,
        encoding: "utf-8",
        env: process.env,
      });
      fs.appendFileSync(config.output, testResult.stdout || "", "utf-8");
      fs.appendFileSync(config.output, testResult.stderr || "", "utf-8");
      if (testResult.status !== 0) failedFiles.push(label);
      fs.appendFileSync(config.output, "\n", "utf-8");
    }
    for (const failedFile of failedFiles) {
      fs.appendFileSync(config.output, `FAILED_FILE: ${failedFile}\n`, "utf-8");
    }
    fs.appendFileSync(config.output, `TOTAL_FAILED_FILES: ${failedFiles.length}\nTOTAL_FILES: ${files.length}\n`, "utf-8");
    const result = {
      result: failedFiles.length ? "fail" : "pass",
      exit_code: failedFiles.length ? 1 : 0,
      duration_ms: Date.now() - startedAt,
      output: config.output,
      sentinel: config.sentinelPath,
      total_files: files.length,
      total_failed_files: failedFiles.length,
      failed_files: failedFiles,
      lock_wait: {
        did_wait: lockWait.didWait,
        waited_ms: lockWait.waitedMs,
        owner: lockWait.owner,
        stale_reclaimed: lockWait.staleReclaimed,
      },
    };
    updateStatus(config, { state: "complete", lock_wait: result.lock_wait, result: result.result });
    writeSentinel(config, result);
  } catch (error) {
    const message = error?.stack || String(error);
    try {
      fs.mkdirSync(path.dirname(config.output), { recursive: true });
      fs.appendFileSync(config.output, `GATE_RUNNER_ERROR: ${message}\nTOTAL_FAILED_FILES: 1\n`, "utf-8");
    } catch {}
    const result = {
      result: "runner_error",
      exit_code: 3,
      duration_ms: Date.now() - startedAt,
      output: config.output,
      sentinel: config.sentinelPath,
      error: message,
      lock_wait: {
        did_wait: lockWait.didWait,
        waited_ms: lockWait.waitedMs,
        owner: lockWait.owner,
        stale_reclaimed: lockWait.staleReclaimed,
      },
    };
    updateStatus(config, { state: "runner_error", lock_wait: result.lock_wait, error: message });
    writeSentinel(config, result);
  } finally {
    releaseLock(config.lockPath, owner);
  }
}

function parseNonNegativeSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("--lock-timeout must be a non-negative number of seconds");
  }
  return seconds;
}

function parsePublicArgs(args) {
  const unknownFlags = findUnknownFlags(args, "run-full-gate");
  if (unknownFlags.length) throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  const cli = bindCliArgs(args, { commandName: "run-full-gate", reservedFlags: KNOWN_FLAGS });
  const repoArg = cli.getArg("--repo");
  if (!repoArg) throw new Error("--repo <worktree> is required");
  const repo = path.resolve(repoArg);
  if (!fs.statSync(repo).isDirectory()) throw new Error(`--repo is not a directory: ${repo}`);
  const suiteArg = cli.getArg("--suites");
  const suites = suiteArg
    ? suiteArg.split(",").map((entry) => entry.trim()).filter(Boolean)
    : DEFAULT_SUITES;
  if (!suites.length) throw new Error("--suites must contain at least one glob");
  const outputArg = cli.getArg("--output");
  const output = outputArg
    ? path.resolve(outputArg)
    : path.join(repo, ".relay", `full-gate-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.log`);
  const lockTimeoutSeconds = parseNonNegativeSeconds(cli.getArg("--lock-timeout", DEFAULT_LOCK_TIMEOUT_SECONDS));
  return {
    repo,
    suites,
    output,
    sentinelPath: `${output}.done`,
    statusPath: `${output}.status.json`,
    lockPath: path.join(os.homedir(), ".relay", "locks", "full-gate.lock"),
    lockTimeoutMs: lockTimeoutSeconds * 1000,
    json: cli.hasFlag("--json"),
  };
}

function printHelp() {
  console.log("Usage: run-full-gate.js --repo <worktree> [options]");
  console.log("\nRun pre-merge test files serially in a detached, machine-locked process.");
  console.log("\nOptions:");
  console.log(`  --repo <worktree>       ${modeLabel("--repo")} Required repository/worktree root`);
  console.log(`  --suites <glob-set>     ${modeLabel("--suites")} Comma-separated globs (default: nine CI suite globs)`);
  console.log(`  --output <path>         ${modeLabel("--output")} Evidence log (default: <repo>/.relay/full-gate-<timestamp>-<pid>.log)`);
  console.log(`  --lock-timeout <secs>   ${modeLabel("--lock-timeout")} Maximum lock wait (default: 600)`);
  console.log(`  --json                  ${modeLabel("--json")} Emit one JSON result object`);
  console.log("  --help, -h              Show this help");
}

function waitForDetached(config) {
  let announcedState = null;
  while (true) {
    const result = readJson(config.sentinelPath);
    if (result) {
      // The runner may acquire the lock and finish (fast suites) within a single
      // SENTINEL_POLL_MS window, so the "running" status is never observed below.
      // The sentinel proves the lock was actually acquired (as opposed to a
      // lock_timeout, where acquisition never happened) whenever we already
      // announced waiting_for_lock but never announced running.
      if (!config.json && announcedState === "waiting_for_lock" && result.result !== "lock_timeout") {
        console.log("Full-gate lock acquired; running suites serially...");
      }
      return result;
    }
    const status = readJson(config.statusPath);
    if (!config.json && status?.state === "waiting_for_lock" && announcedState !== status.state) {
      const owner = status.lock_wait?.owner || {};
      console.log(`Waiting for full-gate lock owned by pid ${owner.pid ?? "unknown"} (pgid ${owner.pgid ?? "unknown"}, host ${owner.host ?? "unknown"})...`);
      announcedState = status.state;
    } else if (!config.json && status?.state === "running" && announcedState === "waiting_for_lock") {
      console.log("Full-gate lock acquired; running suites serially...");
      announcedState = status.state;
    }
    sleep(SENTINEL_POLL_MS);
  }
}

function main() {
  if (process.env[INTERNAL_CONFIG_ENV]) {
    const config = JSON.parse(Buffer.from(process.env[INTERNAL_CONFIG_ENV], "base64url").toString("utf-8"));
    runDetached(config);
    return;
  }

  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const config = parsePublicArgs(args);
  for (const artifact of [config.sentinelPath, config.statusPath]) {
    try { fs.unlinkSync(artifact); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  fs.mkdirSync(path.dirname(config.output), { recursive: true });
  const encodedConfig = Buffer.from(JSON.stringify(config)).toString("base64url");
  const runner = spawn(process.execPath, [__filename], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [INTERNAL_CONFIG_ENV]: encodedConfig },
  });
  runner.unref();
  const result = waitForDetached(config);
  if (config.json) {
    console.log(JSON.stringify(result));
  } else if (result.result === "pass") {
    console.log(`Full gate passed (${result.total_files} files, ${result.duration_ms} ms). Evidence: ${result.output}`);
  } else if (result.result === "fail") {
    console.error(`Full gate failed (${result.total_failed_files}/${result.total_files} files, ${result.duration_ms} ms). Evidence: ${result.output}`);
  } else if (result.result === "lock_timeout") {
    console.error(`Timed out waiting for the full-gate lock after ${result.lock_wait.waited_ms} ms.`);
  } else {
    console.error(`Full-gate runner error. Evidence: ${result.output}`);
  }
  process.exitCode = result.exit_code;
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 3;
}

module.exports = {
  DEFAULT_SUITES,
  expandSuites,
  globToRegExp,
  isProcessAlive,
  waitForDetached,
};
