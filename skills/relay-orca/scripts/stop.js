#!/usr/bin/env node
"use strict";

// relay-orca `stop` — COORDINATOR-ONLY stop (issue #946 D5). It loads the reconstructible
// receipt through the shipped receipt-io (fail-closed codes 50-52 verbatim), invokes the
// ONLY mutating Orca subcommand it may ever use — `orca orchestration run-stop` — and
// records a bounded stop record (`stopped_at` + `stop_reason`) into the receipt. It MUST
// NOT terminate relay executors, delete worktrees, close PRs/issues, invoke `reset`, or
// invoke any task-create / task-update / dispatch / terminal subcommand, and it emits NO
// language claiming the program or its outcomes are cancelled or complete. Relay/fleet
// artifacts stay discoverable through normal relay tooling — nothing is moved or renamed.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const {
  CanonicalizationError,
  resolveRepoContext,
  receiptPathFor,
  readReceiptFile,
  receiptExists,
  writeReceiptAtomic,
} = require("./receipt-io");
const { parseReceipt, serializeReceiptWithStop, boundStopReason } = require("./lib/receipt");
const { boundedExcerpt } = require("./lib/bounded-excerpt");
const { StatusError, USAGE_EXIT, reject: rejectReceipt } = require("./lib/status-reasons");
const { resolveOrcaBin } = require("./lib/resolve-orca-bin");
const { StopError, REASONS: STOP_REASONS } = require("./lib/stop-reasons");

const RUN_TIMEOUT_MS = 15000;
const RUN_MAX_BUFFER = 4 * 1024 * 1024;

function usageError(message) {
  process.stderr.write(`relay-orca stop: ${message}\n`);
  process.stderr.write("usage: stop.js --program-id <id> [--reason <text>] [--json] [--orca-bin <path>] [--repo-root <path>]\n");
  process.exit(USAGE_EXIT);
}

function requireValue(value, flag) {
  if (value === undefined || value === null || (typeof value === "string" && value.startsWith("-"))) usageError(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const opts = { programId: null, reason: "", json: false, orcaBin: null, repoRoot: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--program-id" || arg === "-p") opts.programId = requireValue(argv[(i += 1)], "--program-id");
    else if (arg === "--reason") opts.reason = requireValue(argv[(i += 1)], "--reason");
    else if (arg === "--json") opts.json = true;
    else if (arg === "--orca-bin") opts.orcaBin = requireValue(argv[(i += 1)], "--orca-bin");
    else if (arg === "--repo-root") opts.repoRoot = requireValue(argv[(i += 1)], "--repo-root");
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else usageError(`unrecognized argument: ${arg}`);
  }
  return opts;
}

function resolveOrca(opts) {
  const resolved = resolveOrcaBin({ orcaBinOverride: opts.orcaBin || null });
  return resolved.path || null;
}

// The ONE mutating Orca boundary for stop. Structurally refuses EVERY mutating surface
// except `run-stop` (belt-and-suspenders alongside the fixture poison): no reset, no
// worktree, no task-create/task-update/dispatch, no terminal subcommand is ever built.
function assertRunStopOnly(argv) {
  const forbidden = argv.includes("reset")
    || argv.includes("worktree")
    || argv.includes("task-create")
    || argv.includes("task-update")
    || (argv[0] === "orchestration" && argv[1] === "dispatch")
    || argv[0] === "terminal";
  if (forbidden) throw new Error(`relay-orca stop must never invoke a mutating Orca subcommand other than run-stop (got: ${argv.join(" ")})`);
}

// Invoke `orca orchestration run-stop --json` and normalize the result. `coordinator_stopped`
// is true only on a well-formed ok envelope; an explicit `stopped:false` keeps it false.
function runStop(orcaBin) {
  const argv = ["orchestration", "run-stop", "--json"];
  assertRunStopOnly(argv);
  let proc;
  try {
    const stdout = execFileSync(orcaBin, argv, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: RUN_TIMEOUT_MS, maxBuffer: RUN_MAX_BUFFER });
    proc = { status: 0, stdout: String(stdout || ""), stderr: "" };
  } catch (error) {
    proc = { status: typeof error.status === "number" ? error.status : 1, stdout: error.stdout ? String(error.stdout) : "", stderr: error.stderr ? String(error.stderr) : "" };
  }
  let value = null;
  try {
    value = JSON.parse(String(proc.stdout || "").trim());
  } catch {
    value = null;
  }
  const ok = proc.status === 0 && value && value.ok === true;
  const result = ok && value.result && typeof value.result === "object" ? value.result : {};
  return { ok: Boolean(ok), coordinatorStopped: Boolean(ok) && result.stopped !== false, proc };
}

function loadReceipt(receiptPath, requestedProgramId) {
  if (!receiptExists(receiptPath)) rejectReceipt("RECEIPT_NOT_FOUND", `no receipt found at ${receiptPath}`);
  const parsed = parseReceipt(readReceiptFile(receiptPath));
  if (!parsed.ok) rejectReceipt("RECEIPT_CORRUPT", parsed.reason);
  if (parsed.receipt.program_id !== requestedProgramId) {
    rejectReceipt(
      "RECEIPT_CORRUPT",
      `receipt program_id ${boundedExcerpt(parsed.receipt.program_id)} does not match the requested --program-id ${boundedExcerpt(requestedProgramId)}`,
    );
  }
  return parsed.receipt;
}

function existingStop(receipt) {
  return typeof receipt.stopped_at === "string" && receipt.stopped_at !== "";
}

// Record the bounded stop record into the receipt ONCE (D5). `stopped_at` is the only
// generated timestamp in stop; `stop_reason` is the bounded operator reason. Preserves
// every other field verbatim (serializeReceiptWithStop appends ONLY the two stop keys,
// so a byte comparison shows exactly the stop fields changed). Idempotent: a receipt that
// already carries a stop record is left byte-identical (D9.13) — no rewrite.
function recordStop(receipt, receiptPath, reason) {
  receipt.stopped_at = new Date().toISOString();
  receipt.stop_reason = boundStopReason(reason);
  writeReceiptAtomic(receiptPath, serializeReceiptWithStop(receipt));
}

function buildReport({ opts, receiptPath, coordinatorStopped, stoppedAt, stopReason, blockingReasons }) {
  return {
    ok: blockingReasons.length === 0,
    program_id: opts.programId,
    receipt_path: receiptPath,
    coordinator_stopped: coordinatorStopped,
    stopped_at: stoppedAt,
    stop_reason: stopReason,
    blocking_reasons: blockingReasons,
  };
}

function printReport(body, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }
  const stream = body.ok ? process.stdout : process.stderr;
  stream.write(`relay-orca stop for ${body.program_id} (coordinator_stopped=${body.coordinator_stopped}, stopped_at=${body.stopped_at || "-"})\n`);
  body.blocking_reasons.forEach((reason) => stream.write(`  blocked [${reason.reason_code}]: ${reason.message}\n`));
}

function failReceipt(error, json) {
  const body = { ok: false, reason_code: error.reasonCode, message: error.message, remediation: error.remediation || "" };
  if (json) process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  else process.stderr.write(`relay-orca stop rejected [${error.reasonCode}]: ${error.message}\n`);
  process.exit(error.exitCode);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) usageError("coordinator-only stop for an accepted program");
  if (!opts.programId) usageError("--program-id is required");

  let receipt;
  let receiptPath;
  try {
    const repo = resolveRepoContext({ repoRootOverride: opts.repoRoot });
    receiptPath = receiptPathFor(repo.slug, opts.programId);
    receipt = loadReceipt(receiptPath, opts.programId);
    if (receipt.repo && receipt.repo.slug !== repo.slug) {
      rejectReceipt("RECEIPT_REPO_MISMATCH", `receipt repo.slug ${receipt.repo.slug} does not match the current repo slug ${repo.slug}`);
    }
  } catch (error) {
    if (error instanceof StatusError || error instanceof CanonicalizationError) failReceipt(error, opts.json);
    throw error;
  }

  const alreadyStopped = existingStop(receipt);
  const stop = runStop(resolveOrca(opts));
  const blockingReasons = [];
  if (!stop.coordinatorStopped) {
    blockingReasons.push({ reason_code: "COORDINATOR_STOP_FAILED", message: boundedExcerpt(`orca orchestration run-stop did not succeed${stop.proc.stderr ? `: ${stop.proc.stderr}` : ""}`) });
  } else if (!alreadyStopped) {
    // First successful stop: record the bounded stop record once. A prior record is left
    // byte-identical (idempotent) — a second stop reports the live run-stop result and the
    // ORIGINAL stopped_at/stop_reason without rewriting the receipt.
    recordStop(receipt, receiptPath, opts.reason);
  }

  const body = buildReport({
    opts,
    receiptPath,
    coordinatorStopped: stop.coordinatorStopped,
    stoppedAt: existingStop(receipt) ? receipt.stopped_at : null,
    stopReason: existingStop(receipt) ? receipt.stop_reason : "",
    blockingReasons,
  });
  printReport(body, opts.json);
  process.exitCode = stop.coordinatorStopped ? 0 : STOP_REASONS.COORDINATOR_STOP_FAILED;
}

if (require.main === module) main();

module.exports = { assertRunStopOnly, existingStop, StopError };
