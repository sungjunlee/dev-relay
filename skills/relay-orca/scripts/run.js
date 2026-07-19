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
const { COMMAND_FLAGS, FLAGS } = require("../../relay-dispatch/scripts/cli-schema");
const { orchestrate } = require("./lib/run-orchestrator");
const { orderedReport } = require("./lib/run-report");
const { buildReceiptMapping, serializeReceiptWithRecords } = require("./lib/receipt");
const { applyOperatorRecords } = require("./lib/operator-records");
const {
  CanonicalizationError,
  resolveRepoContext,
  receiptPathFor,
  writeReceiptAtomic,
  readReceiptFile,
  receiptExists,
  programSegment,
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
  const opts = {
    programFile: null,
    json: false,
    concurrency: undefined,
    operatorHandles: [],
    orcaBin: null,
    repoRoot: null,
    // #947 additive operator-record flags. A decision/authorization record is written
    // into the receipt ONLY when its explicit flag is present (never automatically, D4/D5).
    resolveDecision: null,
    resolution: null,
    resolver: null,
    recordAuthorization: null,
    authorizer: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--program-file" || arg === "-f") opts.programFile = argv[(i += 1)];
    else if (arg === "--json") opts.json = true;
    else if (arg === "--concurrency") opts.concurrency = Number(argv[(i += 1)]);
    else if (arg === "--operator-handle") opts.operatorHandles.push(requireValue(argv[(i += 1)], "--operator-handle"));
    else if (arg === "--resolve-decision") opts.resolveDecision = requireValue(argv[(i += 1)], "--resolve-decision");
    else if (arg === "--resolution") opts.resolution = requireValue(argv[(i += 1)], "--resolution");
    else if (arg === "--resolver") opts.resolver = requireValue(argv[(i += 1)], "--resolver");
    else if (arg === "--record-authorization") opts.recordAuthorization = requireValue(argv[(i += 1)], "--record-authorization");
    else if (arg === "--authorizer") opts.authorizer = requireValue(argv[(i += 1)], "--authorizer");
    else if (arg === "--orca-bin") opts.orcaBin = requireValue(argv[(i += 1)], "--orca-bin");
    else if (arg === "--repo-root") opts.repoRoot = requireValue(argv[(i += 1)], "--repo-root");
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!arg.startsWith("-") && !opts.programFile) opts.programFile = arg;
    else usageError(`unrecognized argument: ${arg}`);
  }
  if (opts.resolveDecision && (!opts.resolution || !opts.resolver)) {
    usageError("--resolve-decision requires --resolution and --resolver");
  }
  if (opts.recordAuthorization && !opts.authorizer) usageError("--record-authorization requires --authorizer");
  return opts;
}

// D2 receipt persistence closure. A27: repo context (canonical root + slug) is resolved
// EAGERLY when this factory runs — at run startup, BEFORE orchestrate performs any
// admission/materialization mutation. A git-canonicalization failure (A24) therefore
// throws CanonicalizationError NOW, so `run` exits 52 with ZERO mutating Orca invocations
// instead of after the first successful task-create had already mutated Orca (the exact
// receipt-loss condition A12 forbids: the created task's mapping would never be persisted).
// created_at is preserved across the materialize/dispatch rewrites; only the atomic write +
// timestamps live here (top-level), while the pure mapping is built by lib/receipt.js.
function decisionGateDef(program, decisionId) {
  const prog = program && program.program && typeof program.program === "object" ? program.program : program;
  const gates = prog && Array.isArray(prog.decision_gates) ? prog.decision_gates : [];
  return gates.find((gate) => gate && gate.id === decisionId) || null;
}

// Build the operator-record inputs (#947 D4/D5) from the explicit flags. A decision/
// authorization record is produced ONLY when its flag is present; the decision's
// question/options/downstream_wave provenance is sourced from the program's declared
// decision_gates entry, and resolved_at is stamped at write time (top-level).
function operatorRecordInputs(opts, program, nowIso) {
  return {
    decision: opts.resolveDecision
      ? { id: opts.resolveDecision, resolution: opts.resolution, resolver: opts.resolver, resolvedAt: nowIso, gateDef: decisionGateDef(program, opts.resolveDecision) }
      : null,
    authorization: opts.recordAuthorization ? { id: opts.recordAuthorization, authorizer: opts.authorizer } : null,
  };
}

function makeReceiptPersistor(opts, program) {
  const repo = resolveRepoContext({ repoRootOverride: opts.repoRoot });
  return function persistReceipt(core) {
    const finalPath = receiptPathFor(repo.slug, core.program_id);
    const nowIso = new Date().toISOString();
    let createdAt = nowIso;
    let prior = null;
    if (receiptExists(finalPath)) {
      try {
        prior = JSON.parse(readReceiptFile(finalPath));
        if (typeof prior.created_at === "string" && prior.created_at) createdAt = prior.created_at;
      } catch {
        createdAt = nowIso;
        prior = null;
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
    // Carry forward any prior additive records across the rewrite and apply the operator
    // flags' decision/authorization records. With no prior records and no flags, this is a
    // no-op and the serialized bytes are IDENTICAL to the pre-#947 receipt.
    applyOperatorRecords(mapping, { priorReceipt: prior, ...operatorRecordInputs(opts, program, nowIso) });
    writeReceiptAtomic(finalPath, serializeReceiptWithRecords(mapping));
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

function assertRelayMarkerPersistenceCapability() {
  const definition = FLAGS.find((entry) => entry.flag === "--coordination-marker");
  if (
    !COMMAND_FLAGS.dispatch.includes("--coordination-marker")
    || !definition
    || definition.kind !== "value"
    || definition.mode !== "verbatim"
  ) {
    throw new PlanError(
      "INVALID_INPUT",
      "relay-orca relay_run dispatch requires the first-class relay --coordination-marker CLI surface; refusing to dispatch without exact marker persistence",
    );
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

// Fail-closed rejection: plan-library rejections re-raise unchanged (D1) — same
// reason_code, exit code, and JSON shape as `plan` — and a repo root that cannot be
// git-canonicalized (A24) rejects with RECEIPT_REPO_MISMATCH (exit 52) through the same
// path. Every carrier exposes reasonCode / message / exitCode.
function failReject(error, json) {
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
    // Check the local authoritative relay CLI/schema before admission or any
    // Orca materialization. The operator contract is fail-closed at this boundary.
    assertRelayMarkerPersistenceCapability();
    // A27: build the persistor FIRST. This eagerly canonicalizes the repo and resolves the
    // receipt path before orchestrate runs ANY admission/materialization mutation — a
    // git-canonicalization failure exits 52 here (CanonicalizationError, caught below) with
    // zero mutating Orca invocations.
    const persistReceipt = makeReceiptPersistor(opts, program);
    result = orchestrate(program, {
      concurrency: opts.concurrency,
      operatorHandles: opts.operatorHandles,
      orcaBin: opts.orcaBin,
      runOrca,
      persistReceipt,
      // A26: the task-title program marker embeds the SAME collision-resistant segment
      // used for the receipt path, injected as a pure function (lib/ stays subprocess-free).
      programSegment,
    });
  } catch (error) {
    if (error instanceof PlanError || error instanceof CanonicalizationError) failReject(error, opts.json);
    throw error;
  }
  printReport(result.report, opts.json);
  process.exitCode = result.exitCode;
}

main();
