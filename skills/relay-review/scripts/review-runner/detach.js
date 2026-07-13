"use strict";

// Crash-only review rounds. Mirrors the dispatch.js detach scaffold
// (skills/relay-dispatch/scripts/dispatch.js: --detach, DETACH_RECEIPT_ENV,
// launchDetachedAndExit/waitForDetachReceipt/writeDetachReceiptIfRequested) so a
// review round survives the death of the invoking shell. The child re-execs
// review-runner.js with the receipt env var set, writes a run-dir lease using the
// shared run-runtime-state.js conventions, prints a receipt, and runs the existing
// round end-to-end; on settle it writes a completion sentinel.
//
// The lease/receipt/sentinel are ONLY produced when the receipt env var is set
// (i.e. inside the detached child). Foreground review-runner never enters this
// code path, keeping the no-detach behavior byte-identical.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn: nodeSpawn } = require("child_process");
const { writeRunLease } = require("../../../relay-dispatch/scripts/run-runtime-state");

const DETACH_RECEIPT_ENV = "RELAY_REVIEW_DETACH_RECEIPT_PATH";
const DETACH_STDOUT_LOG_ENV = "RELAY_REVIEW_DETACH_STDOUT_LOG";
const DETACH_STDERR_LOG_ENV = "RELAY_REVIEW_DETACH_STDERR_LOG";
// Review rounds have no fixed --timeout; the lease timeout only feeds remaining_s
// for staleness reporting. Operators identify/kill the owned pgid regardless.
const DEFAULT_REVIEW_LEASE_TIMEOUT_S = 3600;
const RECEIPT_WAIT_TIMEOUT_MS = 60000;

// Child-side supervisor handle, set by beginDetachSupervisorIfRequested and
// consumed by finishDetachSupervisor. Null in the foreground/parent, so both
// functions are no-ops outside a detached child.
let activeSupervisor = null;

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function removeDetachFlag(argv) {
  return argv.filter((arg) => arg !== "--detach" && !String(arg).startsWith("--detach="));
}

function tailFile(filePath, maxBytes = 8192) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf-8").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function writeJsonFileAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function sentinelPathFor(runDir, round) {
  return path.join(runDir, `review-round-${round}.done`);
}

function recoverCommandForReceipt(runRepoPath, runId, round, runDir) {
  return (
    `node skills/relay-review/scripts/review-runner.js --repo ${shellQuote(runRepoPath)} --run-id ${runId} ` +
    `--review-file ${shellQuote(path.join(runDir, `review-round-${round}-raw-response.txt`))} ` +
    `--manual-review-reason "reapply persisted verdict after detached-round kill"`
  );
}

// ---- Child side: lease + receipt + sentinel ------------------------------

function isDetachChild() {
  return Boolean(process.env[DETACH_RECEIPT_ENV]);
}

// Called inside run() once runId/round/runDir are known (after ensureRunLayout).
// In the foreground (no receipt env) this is a no-op and returns null, so no
// lease/receipt/sentinel file is written and behavior stays byte-identical.
function beginDetachSupervisorIfRequested({ runRepoPath, runId, round, runDir, manifestPath, leaseTimeoutS }) {
  const receiptPath = process.env[DETACH_RECEIPT_ENV];
  if (!receiptPath) return null;
  if (activeSupervisor) return activeSupervisor;

  // Spawned with detached:true, so the child is its own process-group leader:
  // process.pid == pgid. Operators kill only this owned pgid.
  const pgid = process.pid;
  const { lease, leasePath } = writeRunLease(runRepoPath, runId, {
    pid: process.pid,
    pgid,
    timeoutS: leaseTimeoutS || DEFAULT_REVIEW_LEASE_TIMEOUT_S,
  });
  const sentinelPath = sentinelPathFor(runDir, round);
  const receipt = {
    runId,
    round,
    pid: process.pid,
    pgid,
    logPath: process.env[DETACH_STDOUT_LOG_ENV] || null,
    stderrPath: process.env[DETACH_STDERR_LOG_ENV] || null,
    sentinelPath,
    leasePath,
    manifestPath: manifestPath || null,
    recoverCommand: recoverCommandForReceipt(runRepoPath, runId, round, runDir),
  };
  writeJsonFileAtomically(receiptPath, receipt);
  // Don't let the receipt env leak into any nested child processes (e.g. the
  // reviewer adapter) that must not think they are the detached supervisor.
  delete process.env[DETACH_RECEIPT_ENV];
  activeSupervisor = { runRepoPath, runId, round, runDir, sentinelPath, leasePath, lease, receipt };
  return activeSupervisor;
}

// Called from the module entry after run() settles. Writes the completion
// sentinel (success or failure). No-op in the foreground/parent.
function finishDetachSupervisor(outcome = {}) {
  if (!activeSupervisor) return null;
  const { runId, round, sentinelPath } = activeSupervisor;
  const status = outcome.status === "failed" ? "failed" : "complete";
  const sentinel = {
    runId,
    round,
    status,
    exitCode: Number.isInteger(outcome.exitCode) ? outcome.exitCode : status === "complete" ? 0 : 1,
    finishedAt: new Date().toISOString(),
    ...(outcome.error ? { error: String(outcome.error) } : {}),
  };
  writeJsonFileAtomically(sentinelPath, sentinel);
  const finished = { ...activeSupervisor, sentinel };
  activeSupervisor = null;
  return finished;
}

// ---- Parent side: launch the detached supervisor -------------------------

function assertDetachCompatible(options) {
  if (options.prepareOnly) {
    throw new Error(
      "--detach cannot be combined with --prepare-only: --prepare-only only emits the prompt bundle, so there is nothing long-running to supervise."
    );
  }
  if (options.reviewFile) {
    throw new Error(
      "--detach cannot be combined with --review-file: a --review-file invocation applies an already-produced verdict without invoking the reviewer, so detaching adds nothing. Run the apply in the foreground."
    );
  }
}

async function waitForDetachReceipt({ receiptPath, stderrPath, stdoutPath, child, timeoutMs = RECEIPT_WAIT_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  let childExit = null;
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });
  while (true) {
    if (fs.existsSync(receiptPath)) {
      let receipt;
      try {
        receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
      } catch {
        await sleepAsync(25);
        continue;
      }
      if (!receipt.runId) {
        throw new Error(`detached review wrote an invalid receipt without runId: ${receiptPath}`);
      }
      return receipt;
    }
    if (childExit) {
      const detail = tailFile(stderrPath) || tailFile(stdoutPath) || `child exited code=${childExit.code} signal=${childExit.signal || "none"}`;
      throw new Error(`detached review exited before receipt: ${detail}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `detached review did not write a receipt within ${Math.round(timeoutMs / 1000)}s; ` +
        `the supervisor may still be resolving context (logs: ${stdoutPath}, ${stderrPath}).`
      );
    }
    await sleepAsync(50);
  }
}

async function launchDetachedReviewAndExit({ entryPath, args, options, jsonOut }) {
  assertDetachCompatible(options);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-detach-"));
  const receiptPath = path.join(tmpDir, "receipt.json");
  const stdoutPath = path.join(tmpDir, "supervisor-stdout.log");
  const stderrPath = path.join(tmpDir, "supervisor-stderr.log");
  const childArgs = removeDetachFlag(args);
  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");
  let child;
  try {
    child = nodeSpawn(process.execPath, [entryPath, ...childArgs], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [DETACH_RECEIPT_ENV]: receiptPath,
        [DETACH_STDOUT_LOG_ENV]: stdoutPath,
        [DETACH_STDERR_LOG_ENV]: stderrPath,
      },
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    try { fs.closeSync(stdoutFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}
  }
  child.unref();
  const receipt = await waitForDetachReceipt({ receiptPath, stderrPath, stdoutPath, child });
  const output = { status: "detached", ...receipt, supervisorPid: child.pid };
  if (jsonOut) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Detached review round launched: ${output.runId} (round ${output.round})`);
    console.log(`  PID/PGID:  ${output.pid}/${output.pgid}`);
    console.log(`  Log:       ${output.logPath}`);
    console.log(`  Sentinel:  ${output.sentinelPath}`);
    console.log(`  Lease:     ${output.leasePath}`);
    console.log(`  Recover:   ${output.recoverCommand}`);
  }
  return output;
}

// Module entry dispatcher. Parent side of --detach (no receipt env yet) launches a
// detached supervisor and exits; otherwise (foreground or the detached child) run()
// executes and, when a supervisor is active, writes the completion sentinel on settle.
function dispatchReviewEntry({ options, args, entryPath, jsonOut, preflight, run, printFailureAndExit }) {
  try {
    if (!process.env[DETACH_RECEIPT_ENV]) preflight?.();
  } catch (error) {
    printFailureAndExit(error, { jsonOut });
    return;
  }
  if (options.detach && !process.env[DETACH_RECEIPT_ENV]) {
    launchDetachedReviewAndExit({ entryPath, args, options, jsonOut }).catch((error) => {
      printFailureAndExit(error, { jsonOut });
    });
    return;
  }
  Promise.resolve(run())
    .then(() => { finishDetachSupervisor({ status: "complete" }); })
    .catch((error) => {
      finishDetachSupervisor({ status: "failed", error: error.message });
      printFailureAndExit(error, { jsonOut });
    });
}

module.exports = {
  DEFAULT_REVIEW_LEASE_TIMEOUT_S,
  DETACH_RECEIPT_ENV,
  DETACH_STDERR_LOG_ENV,
  DETACH_STDOUT_LOG_ENV,
  assertDetachCompatible,
  beginDetachSupervisorIfRequested,
  dispatchReviewEntry,
  finishDetachSupervisor,
  isDetachChild,
  launchDetachedReviewAndExit,
  removeDetachFlag,
  sentinelPathFor,
  waitForDetachReceipt,
};
