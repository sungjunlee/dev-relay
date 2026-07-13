#!/usr/bin/env node
"use strict";

// relay-orca `resume` — crash-safe, receipt-driven, reconcile-first, idempotent
// resumption (issue #946). It loads the reconstructible bridge receipt through the
// shipped receipt-io (fail-closed codes 50-52 verbatim), runs the SAME live
// reconciliation as `status` (the imported #945 pipeline) BEFORE any mutation, and only
// then plans and executes bounded restoration: valid live mappings are REUSED, a lost
// operator terminal is REACQUIRED, and an outcome whose Orca dispatch is verifiably
// absent AND whose relay side is clean is RE-DISPATCHED through the SAME verified path as
// `run` (inject -> dispatch-show -> prompt). Reconciliation results that make resumption
// unsafe fail closed with a `decision_required` report and ZERO mutation (codes 60-63).
// It NEVER invokes `orca orchestration reset` (D7) or any `orca worktree` subcommand
// (D7), never deletes a task/worktree/branch/PR, and never force-closes a relay run.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const {
  CanonicalizationError,
  resolveRepoContext,
  receiptPathFor,
  readReceiptFile,
  receiptExists,
  listManifestFiles,
  listFleetManifestFiles,
  makeUrlResolver,
  writeReceiptAtomic,
  programSegment,
} = require("./receipt-io");
const { parseReceipt, serializeReceiptWithRecords } = require("./lib/receipt");
const { applyOperatorRecords } = require("./lib/operator-records");
const { boundedExcerpt } = require("./lib/bounded-excerpt");
const { parseManifest } = require("./lib/manifest-parse");
const { deriveStatusReport } = require("./lib/status-derive");
const { StatusError, USAGE_EXIT, reject: rejectReceipt } = require("./lib/status-reasons");
const { resolveOrcaBin } = require("./lib/resolve-orca-bin");
const { assertOrcaReadOnly, assertGhReadOnly } = require("./status.js");
const { dispatchTask, showDispatch, createTerminal, sendPrompt } = require("./lib/run-orca");
const { provenanceMismatch } = require("./lib/run-orchestrator");
const { buildOperatorPrompt } = require("./lib/operator-prompt");
const { routeFor, defaultEvidenceFor } = require("./lib/task-kinds");
const { planResume } = require("./lib/resume-plan");
const { orderReport } = require("./lib/resume-report");

const READ_TIMEOUT_MS = 15000;
const READ_MAX_BUFFER = 4 * 1024 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 30000;
const RUN_MAX_BUFFER = 4 * 1024 * 1024;

function usageError(message) {
  process.stderr.write(`relay-orca resume: ${message}\n`);
  process.stderr.write(
    "usage: resume.js --program-id <id> [--json] [--operator-handle <handle> ...] " +
      "[--orca-bin <path>] [--gh-bin <path>] [--repo-root <path>]\n",
  );
  process.exit(USAGE_EXIT);
}

function requireValue(value, flag) {
  if (!value || value.startsWith("-")) usageError(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const opts = {
    programId: null,
    json: false,
    operatorHandles: [],
    orcaBin: null,
    ghBin: null,
    repoRoot: null,
    help: false,
    // #947 additive operator-record flags (D4/D5) — a decision/authorization record is
    // written into the receipt ONLY when its explicit flag is present, never automatically.
    // `--program-file` is OPTIONAL and sources the decision-gate provenance
    // (question/options/downstream_wave) when resolving a decision from resume.
    resolveDecision: null,
    resolution: null,
    resolver: null,
    recordAuthorization: null,
    authorizer: null,
    programFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--program-id" || arg === "-p") opts.programId = requireValue(argv[(i += 1)], "--program-id");
    else if (arg === "--json") opts.json = true;
    else if (arg === "--operator-handle") opts.operatorHandles.push(requireValue(argv[(i += 1)], "--operator-handle"));
    else if (arg === "--resolve-decision") opts.resolveDecision = requireValue(argv[(i += 1)], "--resolve-decision");
    else if (arg === "--resolution") opts.resolution = requireValue(argv[(i += 1)], "--resolution");
    else if (arg === "--resolver") opts.resolver = requireValue(argv[(i += 1)], "--resolver");
    else if (arg === "--record-authorization") opts.recordAuthorization = requireValue(argv[(i += 1)], "--record-authorization");
    else if (arg === "--authorizer") opts.authorizer = requireValue(argv[(i += 1)], "--authorizer");
    else if (arg === "--program-file") opts.programFile = requireValue(argv[(i += 1)], "--program-file");
    else if (arg === "--orca-bin") opts.orcaBin = requireValue(argv[(i += 1)], "--orca-bin");
    else if (arg === "--gh-bin") opts.ghBin = requireValue(argv[(i += 1)], "--gh-bin");
    else if (arg === "--repo-root") opts.repoRoot = requireValue(argv[(i += 1)], "--repo-root");
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else usageError(`unrecognized argument: ${arg}`);
  }
  if (opts.resolveDecision && (!opts.resolution || !opts.resolver)) {
    usageError("--resolve-decision requires --resolution and --resolver");
  }
  if (opts.recordAuthorization && !opts.authorizer) usageError("--record-authorization requires --authorizer");
  return opts;
}

function resolveRunTimeoutMs() {
  const raw = process.env.RELAY_ORCA_RUN_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_RUN_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_TIMEOUT_MS;
}

// The MUTATING Orca boundary (execution phase only). Two surfaces are structurally
// refused here, independent of any fixture poison: `orca orchestration reset` (D7) and
// any `orca worktree` subcommand (D7) — no resume code path builds either. Task deletion
// is never built at all.
function runOrcaMutating(orcaBin, args, options = {}) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (argv.includes("reset")) throw new Error("relay-orca resume must never invoke orca orchestration reset (D7)");
  if (argv.includes("worktree")) throw new Error("relay-orca resume must never invoke any orca worktree subcommand (D7)");
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

// Read-only runner for the reconciliation phase (D1). Reuses status.js's exported
// read-only guards, so a mutating Orca/gh subcommand can never run during reconciliation.
function makeReadRunner(bin, assertReadOnly, cwd) {
  if (!bin) return null;
  return (_bin, args) => {
    const argv = (Array.isArray(args) ? args : []).map(String);
    assertReadOnly(argv);
    try {
      const stdout = execFileSync(bin, argv, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        cwd: cwd || undefined,
        timeout: READ_TIMEOUT_MS,
        maxBuffer: READ_MAX_BUFFER,
      });
      return { status: 0, stdout: String(stdout || ""), stderr: "" };
    } catch (error) {
      return {
        status: typeof error.status === "number" ? error.status : 1,
        stdout: error.stdout ? String(error.stdout) : "",
        stderr: error.stderr ? String(error.stderr) : "",
      };
    }
  };
}

function resolveGhBin(opts) {
  if (opts.ghBin) return opts.ghBin;
  const env = process.env.RELAY_ORCA_GH_BIN;
  return env && env.trim() !== "" ? env.trim() : "gh";
}

function resolveOrca(opts) {
  const resolved = resolveOrcaBin({ orcaBinOverride: opts.orcaBin || null });
  return resolved.path || null;
}

// Load + validate the receipt (fail-closed codes 50-52 verbatim, D2). Identical contract
// to `status`: not-found -> 50, corrupt/schema/identity mismatch -> 51, repo mismatch -> 52.
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

// The imported #945 reconciliation, run BEFORE any mutation (D1). Reads only. The
// reconciliation's per-task dispatch-show reads are captured into `liveDispatch` and
// returned alongside the report so the planner can decide "verifiably absent" from a live
// read (owner amendment A1, #946 R1), never from a null receipt dispatch_id.
function reconcile({ receipt, opts, repo, receiptPath }) {
  const manifests = listManifestFiles(repo.slug).map((entry) => ({ run_id: entry.run_id, text: entry.text, parsed: parseManifest(entry.text) }));
  const fleetManifests = listFleetManifestFiles(repo.slug).map((entry) => ({ run_id: entry.run_id, text: entry.text, parsed: parseManifest(entry.text) }));
  const liveDispatch = new Map();
  const report = deriveStatusReport({
    receipt,
    programId: opts.programId,
    receiptPath,
    manifests,
    fleetManifests,
    orca: makeReadRunner(resolveOrca(opts), assertOrcaReadOnly, repo.root),
    gh: makeReadRunner(resolveGhBin(opts), assertGhReadOnly, repo.root),
    urlFor: makeUrlResolver(repo.root),
    programSegment,
    liveDispatchSink: liveDispatch,
  });
  return { report, liveDispatch };
}

// Persist the live receipt object atomically, preserving created_at and any stop record
// (D5/scenario 8) and bumping updated_at. Used at the A16 (terminal recorded) and A2
// (provenance verified) write points during execution.
function makeReceiptPersistor(receipt, receiptPath) {
  return function persist() {
    receipt.updated_at = new Date().toISOString();
    // serializeReceiptWithRecords preserves the optional stop record AND the #947 additive
    // records (follow_ups/decisions/authorizations); with none present it is byte-identical
    // to serializeReceiptWithStop, so existing resume receipt assertions are unchanged.
    writeReceiptAtomic(receiptPath, serializeReceiptWithRecords(receipt));
    return receiptPath;
  };
}

// Source a decision-gate definition (question/options/downstream_wave provenance) from an
// OPTIONAL --program-file so a resume-written decision record carries full provenance.
function decisionGateDefFromFile(programFile, decisionId) {
  if (!programFile) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(programFile, "utf-8"));
    const prog = parsed && parsed.program && typeof parsed.program === "object" ? parsed.program : parsed;
    const gates = prog && Array.isArray(prog.decision_gates) ? prog.decision_gates : [];
    return gates.find((gate) => gate && gate.id === decisionId) || null;
  } catch {
    return null;
  }
}

// #947 D4/D5: write an operator decision/authorization record into the live receipt when
// the explicit flag is present, BEFORE reconciliation, so the record persists even if
// resume later fails closed on unsafe runtime state. Flagless resume writes NOTHING here,
// preserving the existing byte-identity-on-abort invariant.
function recordOperatorDecisions(receipt, receiptPath, opts) {
  if (!opts.resolveDecision && !opts.recordAuthorization) return false;
  const nowIso = new Date().toISOString();
  applyOperatorRecords(receipt, {
    decision: opts.resolveDecision
      ? { id: opts.resolveDecision, resolution: opts.resolution, resolver: opts.resolver, resolvedAt: nowIso, gateDef: decisionGateDefFromFile(opts.programFile, opts.resolveDecision) }
      : null,
    authorization: opts.recordAuthorization ? { id: opts.recordAuthorization, authorizer: opts.authorizer } : null,
  });
  receipt.updated_at = nowIso;
  writeReceiptAtomic(receiptPath, serializeReceiptWithRecords(receipt));
  return true;
}

// Synthesize the operator prompt inputs from the receipt alone (resume starts from the
// receipt, not the program file — D1). Route + expected evidence come from the FROZEN
// task-kinds defaults; the accepted-outcome/leaf detail is not in the receipt, so the
// prompt is best-effort but structurally identical to run's.
function syntheticTask(receiptTask) {
  return {
    outcome_id: receiptTask.outcome_id,
    task_id: receiptTask.task_id,
    kind: receiptTask.kind,
    wave: receiptTask.wave,
    recommended_route: routeFor(receiptTask.kind),
    expected_evidence: defaultEvidenceFor(receiptTask.kind),
  };
}

// Acquire an operator handle: an explicit --operator-handle first (never adopting a
// terminal it did not receive — D4), else a freshly created terminal recorded in the
// receipt IMMEDIATELY (A16) before the dispatch that may fail.
function acquireHandle(ctx) {
  if (ctx.explicit.length) return ctx.index < ctx.explicit.length ? ctx.explicit[ctx.index++] : null;
  const term = createTerminal(ctx.runOrca, ctx.orcaBin);
  if (!term.ok) return null;
  ctx.receipt.terminals_created.push(term.handle);
  ctx.reportTerminals.push(term.handle);
  ctx.persist();
  return term.handle;
}

function blockingReason(reasonCode, message) {
  return { reason_code: reasonCode, message: boundedExcerpt(message) };
}

// Execute ONE re-dispatch / terminal-reacquisition action through the SAME verified path
// as run: inject -> dispatch-show (provenance trio) -> prompt, persisting the receipt at
// A16 (handle) and A2 (verified provenance) write points.
function executeAction(action, ctx) {
  const receiptTask = ctx.taskByOutcome.get(action.outcome_id);
  const orcaTaskId = action.exec.orca_task_id;
  const handle = acquireHandle(ctx);
  if (!handle) return void ctx.blocking.push(blockingReason("RESUME_REDISPATCH_FAILED", `no operator handle available for outcome ${action.outcome_id}`));
  const disp = dispatchTask(ctx.runOrca, ctx.orcaBin, { orcaTaskId, handle });
  if (!disp.ok) return void ctx.blocking.push(blockingReason("RESUME_REDISPATCH_FAILED", `dispatch --inject failed for outcome ${action.outcome_id}`));
  const show = showDispatch(ctx.runOrca, ctx.orcaBin, { orcaTaskId });
  const mismatch = provenanceMismatch(show, orcaTaskId);
  if (mismatch) return void ctx.blocking.push(blockingReason("RESUME_REDISPATCH_FAILED", `dispatch-show provenance verification failed for outcome ${action.outcome_id}: ${mismatch}`));
  receiptTask.dispatch_id = show.dispatchId;
  receiptTask.assignee = show.assignee;
  ctx.persist();
  const prompt = buildOperatorPrompt(syntheticTask(receiptTask), { id: ctx.receipt.program_id }, {});
  const sent = sendPrompt(ctx.runOrca, ctx.orcaBin, { orcaTaskId, handle, prompt });
  if (!sent.ok) ctx.blocking.push(blockingReason("RESUME_REDISPATCH_FAILED", `operator prompt hand-off failed for outcome ${action.outcome_id}`));
}

// Execute every action carrying an `exec` plan (redispatch / reacquire_terminal). Actions
// without an `exec` (reused / skipped) are no-ops. Returns the terminals created THIS
// invocation and any blocking reasons.
function executeActions({ receipt, actions, opts, orcaBin, persist }) {
  const ctx = {
    receipt,
    runOrca: runOrcaMutating,
    orcaBin,
    explicit: Array.isArray(opts.operatorHandles) ? opts.operatorHandles.slice() : [],
    index: 0,
    reportTerminals: [],
    blocking: [],
    persist,
    taskByOutcome: new Map(receipt.tasks.map((task) => [task.outcome_id, task])),
  };
  actions.forEach((action) => {
    if (action.exec) executeAction(action, ctx);
  });
  return { reportTerminals: ctx.reportTerminals, blocking: ctx.blocking };
}

function reportActions(actions) {
  return actions.map((action) => ({ outcome_id: action.outcome_id, action: action.action, reason: action.reason }));
}

function buildReport({ opts, receiptPath, report, plan, terminalsCreated, blockingReasons, decisions }) {
  const ok = plan.exitCode === 0 && blockingReasons.length === 0;
  return orderReport({
    ok,
    program_id: opts.programId,
    receipt_path: receiptPath,
    runtime: report.runtime,
    reconciliation: report.outcomes,
    actions: reportActions(plan.actions),
    terminals_created: terminalsCreated,
    decision_required: decisions,
    blocking_reasons: blockingReasons,
    reconciliation_required: true,
  });
}

function printReport(body, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }
  const stream = body.ok ? process.stdout : process.stderr;
  stream.write(`relay-orca resume for ${body.program_id} (runtime=${body.runtime}, ok=${body.ok})\n`);
  body.actions.forEach((entry) => stream.write(`  ${entry.outcome_id} [${entry.action}]: ${entry.reason}\n`));
  body.decision_required.forEach((decision) => stream.write(`  decision_required [${decision.reason_code}]: ${decision.message}\n`));
}

function failReceipt(error, json) {
  const body = { ok: false, reason_code: error.reasonCode, message: error.message, remediation: error.remediation || "" };
  if (json) process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  else process.stderr.write(`relay-orca resume rejected [${error.reasonCode}]: ${error.message}\n`);
  process.exit(error.exitCode);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) usageError("crash-safe receipt-driven resumption for an accepted program");
  if (!opts.programId) usageError("--program-id is required");

  let repo;
  let receipt;
  let receiptPath;
  let report;
  let liveDispatch;
  try {
    repo = resolveRepoContext({ repoRootOverride: opts.repoRoot });
    receiptPath = receiptPathFor(repo.slug, opts.programId);
    receipt = loadReceipt(receiptPath, opts.programId);
    if (receipt.repo && receipt.repo.slug !== repo.slug) {
      rejectReceipt("RECEIPT_REPO_MISMATCH", `receipt repo.slug ${receipt.repo.slug} does not match the current repo slug ${repo.slug}`);
    }
    // #947: an explicit --resolve-decision / --record-authorization writes its record to the
    // receipt up front, so the decision persists regardless of the reconciliation verdict.
    recordOperatorDecisions(receipt, receiptPath, opts);
    ({ report, liveDispatch } = reconcile({ receipt, opts, repo, receiptPath }));
  } catch (error) {
    if (error instanceof StatusError || error instanceof CanonicalizationError) failReceipt(error, opts.json);
    throw error;
  }

  // Reconciliation is complete; the plan is pure. A program-level decision performs ZERO
  // mutation and exits 60-63; otherwise the safe actions execute through the verified path.
  const plan = planResume({ receipt, report, liveDispatch });
  let terminalsCreated = [];
  let blockingReasons = plan.blockingReasons.slice();
  if (plan.exitCode === 0) {
    const persist = makeReceiptPersistor(receipt, receiptPath);
    const executed = executeActions({ receipt, actions: plan.actions, opts, orcaBin: resolveOrca(opts), persist });
    terminalsCreated = executed.reportTerminals;
    blockingReasons = executed.blocking;
  }

  const body = buildReport({ opts, receiptPath, report, plan, terminalsCreated, blockingReasons, decisions: plan.decisions });
  printReport(body, opts.json);
  // Only the fail-closed decision codes (60-63) are non-zero exits. A best-effort
  // execution shortfall (a dispatch surface that broke mid-resume) is surfaced through
  // ok:false + blocking_reasons with the receipt left in its A16/A2 recorded state — it
  // never invents a new exit code and never leaves torn Orca state.
  process.exitCode = plan.exitCode;
}

// Run as a CLI only when invoked directly; importing this module exercises the helpers
// without triggering a real resume run.
if (require.main === module) main();

module.exports = { syntheticTask, reportActions };
