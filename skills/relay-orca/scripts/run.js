#!/usr/bin/env node
"use strict";

// relay-orca `run` — admission-gated materialization and provenance-injected
// operator dispatch for an already-accepted program (issue #944). It compiles
// the program through the FROZEN plan library, requires capability admission
// through the FROZEN #942 probe, materializes the wave plan as Orca
// orchestration tasks, dispatches provenance-injected relay/fleet operators, and
// emits a stable machine-readable run report. It never creates an Orca worktree
// (D5) and never invokes orchestration reset (D2). Relay remains the sole creator
// of implementation worktrees and manifests.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { PlanError } = require("./lib/reasons");
const { orchestrate } = require("./lib/run-orchestrator");
const { orderedReport } = require("./lib/run-report");
const { buildReceiptMapping, serializeReceipt } = require("./lib/receipt");
const {
  resolveRepoContext,
  receiptPathFor,
  writeReceiptAtomic,
  readReceiptFile,
  receiptExists,
} = require("./receipt-io");

const USAGE_EXIT = 64;
const RUN_MAX_BUFFER = 4 * 1024 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 30000;

// The ONE subprocess boundary for run. lib/ modules stay child_process-free
// (plan.js's frozen D6 source scan forbids it there); the pure adapter step
// functions call back into this injected runner. Two surfaces are structurally
// refused here, independent of any fixture poison: `orca orchestration reset`
// (D2) and any `orca worktree` subcommand (D5) — no run code path builds either.
function resolveRunTimeoutMs() {
  const raw = process.env.RELAY_ORCA_RUN_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_RUN_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_TIMEOUT_MS;
}

function runOrca(orcaBin, args, options = {}) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (argv.includes("reset")) throw new Error("relay-orca run must never invoke orca orchestration reset (D2)");
  if (argv.includes("worktree")) throw new Error("relay-orca run must never invoke any orca worktree subcommand (D5)");
  const hasInput = options.input !== undefined && options.input !== null;
  try {
    const stdout = execFileSync(orcaBin, argv, {
      encoding: "utf-8",
      stdio: hasInput ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      timeout: resolveRunTimeoutMs(),
      maxBuffer: RUN_MAX_BUFFER,
      ...(hasInput ? { input: String(options.input) } : {}),
    });
    return { status: 0, stdout: String(stdout || ""), stderr: "" };
  } catch (error) {
    return {
      status: typeof error.status === "number" ? error.status : 1,
      stdout: error.stdout ? String(error.stdout) : "",
      stderr: error.stderr ? String(error.stderr) : "",
    };
  }
}

function usageError(message) {
  process.stderr.write(`relay-orca run: ${message}\n`);
  process.stderr.write(
    "usage: run.js --program-file <accepted-program.json> [--json] [--concurrency N] " +
      "[--operator-handle <handle> ...] [--orca-bin <path>]\n",
  );
  process.exit(USAGE_EXIT);
}

function parseArgs(argv) {
  const opts = { programFile: null, json: false, concurrency: undefined, operatorHandles: [], orcaBin: null, repoRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--program-file" || arg === "-f") opts.programFile = argv[(i += 1)];
    else if (arg === "--json") opts.json = true;
    else if (arg === "--concurrency") opts.concurrency = Number(argv[(i += 1)]);
    else if (arg === "--operator-handle") opts.operatorHandles.push(requireValue(argv[(i += 1)], "--operator-handle"));
    else if (arg === "--orca-bin") opts.orcaBin = requireValue(argv[(i += 1)], "--orca-bin");
    else if (arg === "--repo-root") opts.repoRoot = requireValue(argv[(i += 1)], "--repo-root");
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!arg.startsWith("-") && !opts.programFile) opts.programFile = arg;
    else usageError(`unrecognized argument: ${arg}`);
  }
  return opts;
}

// D2 receipt persistence closure. Repo context (canonical root + slug) is resolved
// lazily on first write, so plan-library rejections and admission rejections never
// touch the filesystem. created_at is preserved across the materialize/dispatch
// rewrites; only the atomic write + timestamps live here (top-level), while the pure
// mapping is built by lib/receipt.js.
function makeReceiptPersistor(opts) {
  let repo = null;
  return function persistReceipt(core) {
    if (!repo) repo = resolveRepoContext({ repoRootOverride: opts.repoRoot });
    const finalPath = receiptPathFor(repo.slug, core.program_id);
    const nowIso = new Date().toISOString();
    let createdAt = nowIso;
    if (receiptExists(finalPath)) {
      try {
        const prior = JSON.parse(readReceiptFile(finalPath));
        if (typeof prior.created_at === "string" && prior.created_at) createdAt = prior.created_at;
      } catch {
        createdAt = nowIso;
      }
    }
    const mapping = buildReceiptMapping({
      program_id: core.program_id,
      source: opts.programFile,
      repo: { slug: repo.slug, root: repo.root },
      runtimeId: core.runtime_id,
      tasks: core.tasks,
      terminalsCreated: core.terminals_created,
    });
    mapping.created_at = createdAt;
    mapping.updated_at = nowIso;
    writeReceiptAtomic(finalPath, serializeReceipt(mapping));
    return finalPath;
  };
}

function requireValue(value, flag) {
  if (!value || value.startsWith("-")) usageError(`${flag} requires a value`);
  return value;
}

function readProgram(programFile) {
  if (!programFile) usageError("--program-file is required");
  let text;
  try {
    text = fs.readFileSync(programFile, "utf-8");
  } catch (error) {
    usageError(`cannot read program file ${programFile}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    usageError(`program file ${programFile} is not valid JSON: ${error.message}`);
  }
}

function printReport(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(orderedReport(report), null, 2)}\n`);
    return;
  }
  const stream = report.ok ? process.stdout : process.stderr;
  stream.write(`relay-orca run for ${report.program_id} (admitted=${report.admission.admitted}, ok=${report.ok}, receipt=${report.receipt_path || "none"})\n`);
  report.tasks.forEach((task) => {
    stream.write(`  ${task.task_id} [${task.status}] orca=${task.orca_task_id} assignee=${task.assignee}\n`);
  });
  report.blocking_reasons.forEach((reason) => {
    stream.write(`  blocked [${reason.reason_code}]: ${reason.message}\n`);
  });
}

// Plan-library rejections re-raise unchanged (D1): same reason_code, same exit
// code, same JSON rejection object shape as `plan`.
function failPlan(error, json) {
  const body = { ok: false, reason_code: error.reasonCode, message: error.message };
  if (json) process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  else process.stderr.write(`relay-orca run rejected [${error.reasonCode}]: ${error.message}\n`);
  process.exit(error.exitCode);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) usageError("admission-gated operator dispatch for an accepted program");
  const program = readProgram(opts.programFile);
  let result;
  try {
    result = orchestrate(program, {
      concurrency: opts.concurrency,
      operatorHandles: opts.operatorHandles,
      orcaBin: opts.orcaBin,
      runOrca,
      persistReceipt: makeReceiptPersistor(opts),
    });
  } catch (error) {
    if (error instanceof PlanError) failPlan(error, opts.json);
    throw error;
  }
  printReport(result.report, opts.json);
  process.exitCode = result.exitCode;
}

main();
