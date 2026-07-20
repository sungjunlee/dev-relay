#!/usr/bin/env node
"use strict";

// relay-orca `resume` — crash-safe, receipt-driven, reconcile-first, idempotent
// resumption (issue #946). It loads the reconstructible bridge receipt through the
// shipped receipt-io (fail-closed codes 50-52 verbatim), runs the SAME live
// reconciliation as `status` (the imported #945 pipeline) before any runtime restoration,
// and only then plans and executes bounded restoration: valid live mappings are REUSED, a lost
// operator terminal is REACQUIRED, and an outcome whose Orca dispatch is verifiably
// absent AND whose relay side is clean is RE-DISPATCHED through the SAME verified path as
// `run` (inject -> dispatch-show -> prompt). Reconciliation results that make resumption
// unsafe fail closed with a `decision_required` report and ZERO automatic mutation
// (codes 60-63). The explicit `--map-relay-run` coordination-metadata intake is validated
// and atomically recorded before reconciliation by its separate supervised contract.
// It NEVER invokes `orca orchestration reset` (D7) or any `orca worktree` subcommand
// (D7), never deletes a task/worktree/branch/PR, and never force-closes a relay run.
const fs = require("node:fs");
const path = require("node:path");
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
  withIntegrationLifecycleLock,
  readIntegrationEvidenceFile,
} = require("./receipt-io");
const { parseReceipt, serializeReceiptWithRecords } = require("./lib/receipt");
const { applyOperatorRecords } = require("./lib/operator-records");
const { boundedExcerpt } = require("./lib/bounded-excerpt");
const { parseManifest } = require("./lib/manifest-parse");
const { deriveStatusReport } = require("./lib/status-derive");
const { StatusError, USAGE_EXIT, reject: rejectReceipt } = require("./lib/status-reasons");
const { resolveOrcaBin } = require("./lib/resolve-orca-bin");
const { assertOrcaReadOnly, assertGhReadOnly } = require("./status.js");
const { dispatchTask, showDispatch, sendPrompt } = require("./lib/run-orca");
const { provenanceMismatch } = require("./lib/run-orchestrator");
const { buildOperatorPrompt } = require("./lib/operator-prompt");
const { routeFor, defaultEvidenceFor } = require("./lib/task-kinds");
const { planResume, earlierWavesComplete } = require("./lib/resume-plan");
const { orderReport } = require("./lib/resume-report");
const { validateRelayRunMappings, applyRelayRunMappings } = require("./lib/resume-mapping");
const {
  IntegrationLifecycleError,
  prepareIntegrationGate,
  advanceIntegrationGate,
  integrationReportPath,
} = require("./lib/integration-lifecycle");

const READ_TIMEOUT_MS = 15000;
const READ_MAX_BUFFER = 4 * 1024 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 30000;
const RUN_MAX_BUFFER = 4 * 1024 * 1024;

function usageError(message) {
  process.stderr.write(`relay-orca resume: ${message}\n`);
  process.stderr.write(
    "usage: resume.js --program-id <id> [--json] [--operator-handle <handle> ...] " +
      "[--program-file <accepted-program.json>] [--map-relay-run <outcome_id>=<run_id> ...] " +
      "[--coordinator-handle <handle>] [--gate-evidence-dir <dir>] [--orca-bin <path>] [--gh-bin <path>] [--repo-root <path>]\n",
  );
  process.exit(USAGE_EXIT);
}

function requireValue(value, flag) {
  if (!value || value.startsWith("-")) usageError(`${flag} requires a value`);
  return value;
}

function parseRelayRunMapping(value) {
  const raw = requireValue(value, "--map-relay-run");
  const separator = raw.indexOf("=");
  if (separator < 0 || separator === 0 || separator === raw.length - 1) {
    usageError("--map-relay-run requires <outcome_id>=<run_id> with both ids non-empty");
  }
  return { outcome_id: raw.slice(0, separator), run_id: raw.slice(separator + 1) };
}

function parseArgs(argv) {
  const opts = {
    programId: null,
    json: false,
    operatorHandles: [],
    coordinatorHandle: null,
    gateEvidenceDir: null,
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
    mapRelayRuns: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--program-id" || arg === "-p") opts.programId = requireValue(argv[(i += 1)], "--program-id");
    else if (arg === "--json") opts.json = true;
    else if (arg === "--operator-handle") opts.operatorHandles.push(requireValue(argv[(i += 1)], "--operator-handle"));
    else if (arg === "--coordinator-handle") opts.coordinatorHandle = requireValue(argv[(i += 1)], "--coordinator-handle");
    else if (arg === "--gate-evidence-dir") opts.gateEvidenceDir = requireValue(argv[(i += 1)], "--gate-evidence-dir");
    else if (arg === "--resolve-decision") opts.resolveDecision = requireValue(argv[(i += 1)], "--resolve-decision");
    else if (arg === "--resolution") opts.resolution = requireValue(argv[(i += 1)], "--resolution");
    else if (arg === "--resolver") opts.resolver = requireValue(argv[(i += 1)], "--resolver");
    else if (arg === "--record-authorization") opts.recordAuthorization = requireValue(argv[(i += 1)], "--record-authorization");
    else if (arg === "--authorizer") opts.authorizer = requireValue(argv[(i += 1)], "--authorizer");
    else if (arg === "--program-file") opts.programFile = requireValue(argv[(i += 1)], "--program-file");
    else if (arg === "--map-relay-run") opts.mapRelayRuns.push(parseRelayRunMapping(argv[(i += 1)]));
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
  if (opts.mapRelayRuns.length > 0 && !opts.programFile) usageError("--map-relay-run requires --program-file");
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
  if (argv.includes("task-update")) throw new Error("relay-orca resume must never invoke orca orchestration task-update (#1019)");
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

// The imported #945 reconciliation, run before any runtime restoration (D1). Reads only.
// An explicit, already-validated relay run mapping may have been recorded up front. The
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
    strictIntegration: true,
  });
  return { report, liveDispatch };
}

function makeIntegrationReportPathResolver(opts, receiptPath) {
  const configured = opts.gateEvidenceDir || (process.env.RELAY_ORCA_GATE_EVIDENCE_ROOT || "").trim();
  const root = path.resolve(configured || path.join(path.dirname(receiptPath), "integration-gates"));
  return (outcomeId) => integrationReportPath(root, outcomeId);
}

function requireIntegrationOptions(receipt, opts, receiptPath) {
  const hasIntegration = receipt.tasks.some((task) => task && task.kind === "integration_gate");
  if (!hasIntegration) return () => null;
  if (!opts.coordinatorHandle) {
    throw new IntegrationLifecycleError(
      "INTEGRATION_COORDINATOR_PROVENANCE_MISSING",
      "integration_gate resume requires explicit --coordinator-handle; never infer coordinator identity from stale receipt/history",
    );
  }
  return makeIntegrationReportPathResolver(opts, receiptPath);
}

// Persist the live receipt object atomically, preserving created_at and any stop record
// (D5/scenario 8) and bumping updated_at. Used for supervised mapping intake and at the
// A16 (terminal recorded) / A2 (provenance verified) points during execution.
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

function acceptedProgramFromFile(programFile, receiptProgramId) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(programFile, "utf-8"));
  } catch (error) {
    usageError(`cannot read program file ${programFile}: ${error.message}`);
  }
  const program = parsed && parsed.program && typeof parsed.program === "object" ? parsed.program : parsed;
  if (!program || typeof program !== "object" || Array.isArray(program)) {
    usageError(`program file ${programFile} is not a program object`);
  }
  if (program.id !== receiptProgramId) {
    usageError(`program file id ${boundedExcerpt(program.id)} does not match the receipt program id ${boundedExcerpt(receiptProgramId)}`);
  }
  return program;
}

function mappingFailureReport(opts, receiptPath, receipt, validation) {
  const decision = validation.decision;
  return orderReport({
    ok: false,
    program_id: opts.programId,
    receipt_path: receiptPath,
    runtime: "unreachable",
    reconciliation: [],
    actions: receipt.tasks.map((task) => ({
      outcome_id: task.outcome_id,
      action: "decision_required",
      reason: boundedExcerpt(`blocked: ${decision.reason_code}`),
    })),
    terminals_created: [],
    decision_required: [decision],
    blocking_reasons: [{ reason_code: decision.reason_code, message: decision.message }],
    reconciliation_required: true,
  });
}

function validateAndRecordRelayRunMappings(receipt, receiptPath, repo, opts) {
  if (opts.mapRelayRuns.length === 0) return { ok: true, exitCode: 0 };
  const program = acceptedProgramFromFile(opts.programFile, receipt.program_id);
  const manifests = listManifestFiles(repo.slug).map((entry) => ({
    run_id: entry.run_id,
    parsed: parseManifest(entry.text),
  }));
  const validation = validateRelayRunMappings({
    receipt,
    program,
    requested: opts.mapRelayRuns,
    manifests,
  });
  if (!validation.ok) return validation;
  if (applyRelayRunMappings(receipt, validation.mappings)) {
    makeReceiptPersistor(receipt, receiptPath)();
  }
  return validation;
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

// Acquire an operator handle: EXPLICIT --operator-handle only (never adopting a terminal it
// did not receive, and never self-creating one — a bare `terminal create` yields an
// agent-less terminal that cannot accept --inject, D3). Exhausting the provided handles
// returns null; the zero-handle case is caught upfront by planResume (RESUME_NO_OPERATOR_HANDLE)
// so a partial-handle shortfall is the only null path reachable here.
function acquireHandle(ctx) {
  return ctx.index < ctx.explicit.length ? ctx.explicit[ctx.index++] : null;
}

function blockingReason(reasonCode, message) {
  return { reason_code: reasonCode, message: boundedExcerpt(message) };
}

// Blocking entry for a non-ok integration lifecycle advance. When the lifecycle is awaiting
// the operator's explicit worker_done, surface the authoritative explicit-flag command
// (complete, not bounded/truncated) so a restarted coordinator/operator can recover it
// straight from the resume report instead of a prior pane message. (#1019 R2)
function integrationBlockingEntry(result) {
  const entry = blockingReason(result.reason_code, `${result.reason_code}: operator must send the fresh explicit worker_done command exactly once after gate resolution`);
  const copyPaste = result.completion_command && result.completion_command.copy_paste;
  if (copyPaste) entry.completion_command = copyPaste;
  return entry;
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
  let integrationGate = null;
  if (receiptTask.kind === "integration_gate") {
    try {
      integrationGate = prepareIntegrationGate({
        run: ctx.runOrca,
        orcaBin: ctx.orcaBin,
        programId: ctx.receipt.program_id,
        outcomeId: receiptTask.outcome_id,
        taskId: orcaTaskId,
        dispatchId: show.dispatchId,
        assignee: show.assignee,
        coordinatorHandle: ctx.coordinatorHandle,
        runtimeId: ctx.receipt.runtime_id,
        reportPath: ctx.integrationReportPath(receiptTask.outcome_id),
        programSegment,
        withLock: (lockKey, callback) => withIntegrationLifecycleLock({
          programId: ctx.receipt.program_id,
          outcomeId: receiptTask.outcome_id,
          taskId: orcaTaskId,
          lockRoot: ctx.integrationLockRoot,
          lockKey,
        }, callback),
        readReport: readIntegrationEvidenceFile,
      });
    } catch (error) {
      if (!(error instanceof IntegrationLifecycleError)) throw error;
      ctx.blocking.push(blockingReason(error.reasonCode, `integration lifecycle failed before operator prompt for outcome ${receiptTask.outcome_id}: ${error.message}`));
      return;
    }
  }
  const prompt = buildOperatorPrompt(syntheticTask(receiptTask), { id: ctx.receipt.program_id }, {}, programSegment, { integrationGate });
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
    coordinatorHandle: opts.coordinatorHandle,
    integrationReportPath: opts.integrationReportPath,
    integrationLockRoot: opts.integrationLockRoot,
    taskByOutcome: new Map(receipt.tasks.map((task) => [task.outcome_id, task])),
  };
  actions.forEach((action) => {
    if (action.exec) executeAction(action, ctx);
  });
  return { reportTerminals: ctx.reportTerminals, blocking: ctx.blocking };
}

function isNonEmptyStr(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Advance ONLY a currently-dispatched, wave-eligible integration gate. A materialized but
// undispatched integration_gate (null dispatch_id/assignee — the #1019 live shape, where the
// integration gate is wave 2 and wave-1 resume has not reached it) stays INERT: advancing it
// would hit INTEGRATION_DISPATCH_PROVENANCE_MISSING and flip an otherwise-idempotent wave-1
// resume to ok:false. A gate whose earlier waves are not yet complete_with_evidence is never
// advanced either — even if it was dispatched out of band — so its canonical gate can never be
// resolved ahead of the program's wave order. planResume already skips these outcomes; this is
// the matching guard on the coordinator-owned lifecycle advance.
function integrationGateAdvanceable(task, report) {
  const dispatched = isNonEmptyStr(task.dispatch_id) && isNonEmptyStr(task.assignee);
  const waveEligible = task.wave === 1 || earlierWavesComplete(task, report);
  return dispatched && waveEligible;
}

function advanceIntegrationTasks({ receipt, opts, orcaBin, report }) {
  const blocking = [];
  receipt.tasks
    .filter((task) => task && task.kind === "integration_gate" && integrationGateAdvanceable(task, report))
    .forEach((task) => {
    try {
      const result = advanceIntegrationGate({
        run: runOrcaMutating,
        orcaBin,
        programId: receipt.program_id,
        outcomeId: task.outcome_id,
        taskId: task.orca_task_id,
        dispatchId: task.dispatch_id,
        assignee: task.assignee,
        coordinatorHandle: opts.coordinatorHandle,
        runtimeId: receipt.runtime_id,
        reportPath: opts.integrationReportPath(task.outcome_id),
        programSegment,
        withLock: (lockKey, callback) => withIntegrationLifecycleLock({
          programId: receipt.program_id,
          outcomeId: task.outcome_id,
          taskId: task.orca_task_id,
          lockRoot: opts.integrationLockRoot,
          lockKey,
        }, callback),
        readReport: readIntegrationEvidenceFile,
      });
      if (!result.ok) blocking.push(integrationBlockingEntry(result));
    } catch (error) {
      if (!(error instanceof IntegrationLifecycleError)) throw error;
      blocking.push(blockingReason(error.reasonCode, error.message));
    }
  });
  return blocking;
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
    opts.integrationReportPath = requireIntegrationOptions(receipt, opts, receiptPath);
    const mappingValidation = validateAndRecordRelayRunMappings(receipt, receiptPath, repo, opts);
    if (!mappingValidation.ok) {
      printReport(mappingFailureReport(opts, receiptPath, receipt, mappingValidation), opts.json);
      process.exitCode = mappingValidation.exitCode;
      return;
    }
    // #947: an explicit --resolve-decision / --record-authorization writes its record to the
    // receipt up front, so the decision persists regardless of the reconciliation verdict.
    recordOperatorDecisions(receipt, receiptPath, opts);
    ({ report, liveDispatch } = reconcile({ receipt, opts, repo, receiptPath }));
  } catch (error) {
    if (error instanceof StatusError || error instanceof CanonicalizationError) failReceipt(error, opts.json);
    if (error instanceof IntegrationLifecycleError) {
      const body = { ok: false, reason_code: error.reasonCode, message: error.message, remediation: "Re-run with fresh coordinator provenance and never use task-update, reset, receipt edits, or manual dispatch replay." };
      if (opts.json) process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
      else process.stderr.write(`relay-orca resume rejected [${error.reasonCode}]: ${error.message}\n`);
      process.exitCode = 63;
      return;
    }
    throw error;
  }

  // Reconciliation is complete; the plan is pure. A program-level decision performs ZERO
  // mutation and exits 60-63; otherwise the safe actions execute through the verified path.
  const plan = planResume({ receipt, report, liveDispatch, hasOperatorHandle: opts.operatorHandles.length > 0 });
  let terminalsCreated = [];
  let blockingReasons = plan.blockingReasons.slice();
  if (plan.exitCode === 0) {
    const persist = makeReceiptPersistor(receipt, receiptPath);
    const executed = executeActions({ receipt, actions: plan.actions, opts, orcaBin: resolveOrca(opts), persist });
    terminalsCreated = executed.reportTerminals;
    blockingReasons = executed.blocking;
    blockingReasons = blockingReasons.concat(advanceIntegrationTasks({ receipt, opts, orcaBin: resolveOrca(opts), report }));
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

module.exports = { syntheticTask, reportActions, integrationBlockingEntry, integrationGateAdvanceable, advanceIntegrationTasks };
