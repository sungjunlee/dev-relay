"use strict";

// #1019 integration-gate lifecycle. This module owns the coordinator-side transition
// boundary but receives the subprocess runner from run.js/resume.js. It deliberately
// never builds task-update, reset, worktree, or raw-payload commands.
const crypto = require("node:crypto");
const path = require("node:path");
const { coordinationMarkerFor, shellQuote } = require("./coordination-marker");
const { boundedExcerpt } = require("./bounded-excerpt");

const CANONICAL_OPTIONS = Object.freeze(["passed", "failed"]);
class IntegrationLifecycleError extends Error {
  constructor(reasonCode, message, details = {}) {
    super(message);
    this.name = "IntegrationLifecycleError";
    this.reasonCode = reasonCode;
    this.details = details;
    this.mutationSafe = false;
  }
}

function fail(reasonCode, message, details = {}) {
  throw new IntegrationLifecycleError(reasonCode, boundedExcerpt(message), details);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function unwrap(value) {
  return value && typeof value === "object" ? value : {};
}

function parseEnvelope(proc, command) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(proc && proc.stdout ? proc.stdout : ""));
  } catch (error) {
    fail("INTEGRATION_CAPABILITY_GAP", `${command} returned non-JSON output: ${error.message}`);
  }
  if (!proc || proc.status !== 0 || !parsed || parsed.ok !== true) {
    const detail = proc && proc.stderr ? `: ${boundedExcerpt(proc.stderr)}` : "";
    fail("INTEGRATION_CAPABILITY_GAP", `${command} is unavailable or rejected by the installed Orca contract${detail}`);
  }
  return parsed;
}

function runJson(ctx, args, label) {
  if (!ctx || typeof ctx.run !== "function" || !nonEmpty(ctx.orcaBin)) {
    fail("INTEGRATION_CAPABILITY_GAP", `${label} cannot run: injected Orca runner is missing`);
  }
  const proc = ctx.run(ctx.orcaBin, args, {});
  return parseEnvelope(proc, label);
}

function resultOf(payload) {
  return unwrap(payload && payload.result);
}

function runtimeId(payload) {
  const result = resultOf(payload);
  const runtime = unwrap(result.runtime);
  const meta = unwrap(payload && payload._meta);
  return [runtime.runtimeId, result.runtime_id, meta.runtimeId].find(nonEmpty) || null;
}

function coordinatorFrom(payload) {
  const result = resultOf(payload);
  const coordinator = unwrap(result.coordinator);
  const runtime = unwrap(result.runtime);
  const preamble = unwrap(result.preamble);
  return [
    result.coordinator_handle,
    result.coordinatorHandle,
    coordinator.handle,
    coordinator.id,
    runtime.coordinator_handle,
    runtime.coordinatorHandle,
    preamble.coordinator_handle,
    preamble.coordinatorHandle,
  ].find(nonEmpty) || null;
}

function taskRows(payload) {
  const result = resultOf(payload);
  return Array.isArray(result.tasks) ? result.tasks : null;
}

function gateRows(payload) {
  const result = resultOf(payload);
  return Array.isArray(result.gates) ? result.gates : null;
}

function gateId(gate) {
  return gate && [gate.id, gate.gate_id, gate.gateId].find(nonEmpty) || null;
}

function gateTaskId(gate) {
  return gate && [gate.task_id, gate.task, gate.taskId].find(nonEmpty) || null;
}

function gateResolution(gate) {
  if (!gate || typeof gate !== "object") return { state: "missing", value: null };
  const explicitValues = [gate.resolution, gate.result, gate.outcome].filter(nonEmpty);
  const explicitKinds = new Set(explicitValues);
  if (explicitKinds.size > 1) return { state: "conflict", value: explicitValues.join(",") };
  const explicit = explicitValues[0] || null;
  const status = typeof gate.status === "string" ? gate.status : "";
  if (explicit) {
    if (!CANONICAL_OPTIONS.includes(explicit)) return { state: "conflict", value: explicit };
    if (status === "passed" && explicit !== "passed") return { state: "conflict", value: explicit };
    if (status === "failed" && explicit !== "failed") return { state: "conflict", value: explicit };
    if (status && ["pending", "ready", "open"].includes(status)) return { state: "conflict", value: explicit };
    return { state: explicit === "passed" ? "passed" : "failed", value: explicit };
  }
  // A status of passed/failed is an explicit terminal result. A generic resolved
  // status is intentionally NOT completion evidence without its canonical resolution.
  if (status === "passed") return { state: "passed", value: "passed" };
  if (status === "failed") return { state: "failed", value: "failed" };
  if (status === "resolved") return { state: "conflict", value: null };
  return { state: "pending", value: null };
}

function sanitizeArtifactName(ref) {
  return String(ref == null ? "" : ref)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "gate";
}

function integrationReportPath(root, outcomeId) {
  if (!nonEmpty(root) || !path.isAbsolute(root)) {
    fail("INTEGRATION_REPORT_PROVENANCE_MISSING", "integration evidence root must be an absolute deterministic path");
  }
  if (!nonEmpty(outcomeId)) fail("INTEGRATION_REPORT_PROVENANCE_MISSING", "integration evidence outcome id is missing");
  return path.join(root, `${sanitizeArtifactName(outcomeId)}.json`);
}

function canonicalIntegrationQuestion(programId, outcomeId, segmentEncoder) {
  if (!nonEmpty(programId) || !nonEmpty(outcomeId) || typeof segmentEncoder !== "function") {
    fail("INTEGRATION_CAPABILITY_GAP", "canonical integration gate identity requires program id, outcome id, and the #1016 program-segment encoder");
  }
  const marker = coordinationMarkerFor(programId, outcomeId, segmentEncoder);
  return `Integration evidence for ${marker} passed?`;
}

function canonicalGateKey({ taskId, question, options = CANONICAL_OPTIONS }) {
  if (!nonEmpty(taskId) || !nonEmpty(question) || JSON.stringify(options) !== JSON.stringify(CANONICAL_OPTIONS)) {
    fail("INTEGRATION_CAPABILITY_GAP", "canonical integration gate identity requires the verified task id, exact question, and options [\"passed\",\"failed\"]");
  }
  return { task_id: taskId, question, options: [...CANONICAL_OPTIONS] };
}

function gateIsCanonical(gate, identity) {
  return gateTaskId(gate) === identity.task_id
    && gate && gate.question === identity.question
    && Array.isArray(gate.options)
    && JSON.stringify(gate.options) === JSON.stringify(identity.options);
}

function inspectCanonicalGates(gates, identity) {
  const rows = Array.isArray(gates) ? gates : [];
  const dedicated = rows.filter((gate) => gateTaskId(gate) === identity.task_id);
  const exact = dedicated.filter((gate) => gateIsCanonical(gate, identity));
  if (dedicated.some((gate) => !gateIsCanonical(gate, identity))) {
    return { ok: false, reasonCode: "INTEGRATION_GATE_NONCANONICAL", message: `dedicated integration task ${identity.task_id} has a noncanonical gate; refusing further mutation` };
  }
  if (exact.length > 1) {
    return { ok: false, reasonCode: "INTEGRATION_GATE_DUPLICATE", message: `dedicated integration task ${identity.task_id} has ${exact.length} exact canonical gates; refusing further mutation` };
  }
  if (exact.length === 0) return { ok: true, state: "missing", gate: null, exact: [] };
  const gate = exact[0];
  if (!gateId(gate)) return { ok: false, reasonCode: "INTEGRATION_GATE_IDENTITY_UNAVAILABLE", message: "canonical gate has no physical id; the installed Orca contract cannot safely resolve it" };
  const resolution = gateResolution(gate);
  if (resolution.state === "conflict") {
    return { ok: false, reasonCode: "INTEGRATION_GATE_CONFLICT", message: `canonical integration gate ${gateId(gate)} has a conflicting or noncanonical resolution` };
  }
  return { ok: true, state: resolution.state, gate, exact };
}

function lockName(ctx) {
  const key = `${ctx.programId}\0${ctx.outcomeId}\0${ctx.taskId}`;
  return crypto.createHash("sha256").update(key).digest("hex");
}

function withBoundedLock(ctx, callback) {
  if (!ctx || typeof ctx.withLock !== "function") {
    fail("INTEGRATION_LOCK_UNAVAILABLE", "bounded integration lifecycle lock is unavailable; no mutation was attempted");
  }
  try {
    return ctx.withLock(lockName(ctx), callback);
  } catch (error) {
    // A fail-closed decision from inside the locked section already carries its own specific
    // reason code (e.g. gate/provenance/report codes); surfacing it verbatim is what makes the
    // reason-code contract diagnosable. Only a genuine lock-acquisition failure — a non-lifecycle
    // error from ctx.withLock itself — is mapped to INTEGRATION_LOCK_UNAVAILABLE.
    if (error instanceof IntegrationLifecycleError) throw error;
    fail("INTEGRATION_LOCK_UNAVAILABLE", `integration lifecycle lock cannot be acquired: ${error.message}`);
  }
}

function identityFor(ctx) {
  return canonicalGateKey({
    taskId: ctx.taskId,
    question: canonicalIntegrationQuestion(ctx.programId, ctx.outcomeId, ctx.programSegment),
  });
}

function listGates(ctx) {
  const payload = runJson(ctx, ["orchestration", "gate-list", "--task", ctx.taskId, "--json"], "orca orchestration gate-list");
  const rows = gateRows(payload);
  if (!rows) fail("INTEGRATION_CAPABILITY_GAP", "orca orchestration gate-list returned no gates array");
  const result = resultOf(payload);
  if (result.count !== undefined && result.count !== rows.length) {
    fail("INTEGRATION_GATE_CONFLICT", "orca orchestration gate-list count disagrees with its gate array; refusing mutation");
  }
  return rows;
}

function ensureCanonicalGateUnlocked(ctx, identity) {
  const first = inspectCanonicalGates(listGates(ctx), identity);
  if (!first.ok) fail(first.reasonCode, first.message);
  if (first.state === "failed") {
    fail("INTEGRATION_GATE_CONFLICT", `canonical integration gate ${gateId(first.gate)} resolved failed; refusing further mutation`);
  }
  if (first.state !== "missing") return { ...first, adopted: true };

  const createArgs = [
    "orchestration", "gate-create", "--task", identity.task_id,
    "--question", identity.question, "--options", JSON.stringify(CANONICAL_OPTIONS), "--json",
  ];
  const created = ctx.run(ctx.orcaBin, createArgs, {});
  // The create response is deliberately non-authoritative. Always re-list, including
  // an exit/non-JSON response, so a lost response cannot cause a duplicate create.
  const second = inspectCanonicalGates(listGates(ctx), identity);
  if (!second.ok) fail(second.reasonCode, second.message);
  if (second.state === "missing") {
    const detail = created && created.stderr ? `: ${boundedExcerpt(created.stderr)}` : "";
    fail("INTEGRATION_GATE_CREATE_UNCONFIRMED", `gate-create did not produce exactly one adoptable canonical gate${detail}`);
  }
  if (second.state === "failed") {
    fail("INTEGRATION_GATE_CONFLICT", `canonical integration gate ${gateId(second.gate)} resolved failed; refusing further mutation`);
  }
  return { ...second, adopted: false, create_status: created && created.status };
}

function ensureCanonicalGate(ctx) {
  const identity = identityFor(ctx);
  return withBoundedLock(ctx, () => ensureCanonicalGateUnlocked(ctx, identity));
}

function currentProvenance(ctx) {
  const statusPayload = runJson(ctx, ["status", "--json"], "orca status");
  const currentRuntime = runtimeId(statusPayload);
  if (!nonEmpty(currentRuntime)) fail("INTEGRATION_RUNTIME_PROVENANCE_MISSING", "live Orca runtime id is unavailable; coordinator mutation is unsafe");
  if (ctx.runtimeId && currentRuntime !== ctx.runtimeId) fail("INTEGRATION_RUNTIME_PROVENANCE_MISMATCH", `live Orca runtime ${currentRuntime} does not match verified runtime ${ctx.runtimeId}`);
  const currentCoordinator = coordinatorFrom(statusPayload);
  if (nonEmpty(currentCoordinator) && currentCoordinator !== ctx.coordinatorHandle) {
    fail("INTEGRATION_COORDINATOR_PROVENANCE_MISMATCH", `coordinator handle ${ctx.coordinatorHandle} is stale; live coordinator is ${currentCoordinator}`);
  }

  const taskPayload = runJson(ctx, ["orchestration", "task-list", "--json"], "orca orchestration task-list");
  const tasks = taskRows(taskPayload);
  if (!tasks) fail("INTEGRATION_CAPABILITY_GAP", "orca orchestration task-list returned no tasks array");
  const task = tasks.find((candidate) => candidate && candidate.id === ctx.taskId);
  if (!task) fail("INTEGRATION_TASK_PROVENANCE_MISMATCH", `verified integration task ${ctx.taskId} is absent from the current task-list`);
  if (!nonEmpty(ctx.assignee) || !nonEmpty(ctx.dispatchId)) fail("INTEGRATION_DISPATCH_PROVENANCE_MISSING", "fresh integration dispatch id and assignee are required before lifecycle mutation");
  const dispatchPayload = runJson(ctx, ["orchestration", "dispatch-show", "--task", ctx.taskId, "--preamble", "--from", ctx.assignee, "--json"], "orca orchestration dispatch-show");
  const result = resultOf(dispatchPayload);
  const dispatch = unwrap(result.dispatch);
  const liveTask = dispatch.task_id || dispatch.taskId;
  const liveDispatch = dispatch.id || dispatch.dispatch_id || dispatch.dispatchId;
  const liveAssignee = dispatch.assignee_handle || dispatch.assignee || dispatch.to;
  const dispatchCoordinator = coordinatorFrom(dispatchPayload);
  const verifiedCoordinator = dispatchCoordinator || currentCoordinator;
  if (!nonEmpty(verifiedCoordinator)) fail("INTEGRATION_COORDINATOR_PROVENANCE_MISSING", "live/current coordinator handle is unavailable; never infer it from stale receipt or history");
  if (verifiedCoordinator !== ctx.coordinatorHandle) {
    fail("INTEGRATION_COORDINATOR_PROVENANCE_MISMATCH", `coordinator handle ${ctx.coordinatorHandle} is stale; live coordinator is ${verifiedCoordinator}`);
  }
  if (liveTask !== ctx.taskId || liveDispatch !== ctx.dispatchId || liveAssignee !== ctx.assignee || dispatch.terminal_present === false || result.terminal_present === false) {
    fail("INTEGRATION_DISPATCH_PROVENANCE_MISMATCH", `fresh dispatch provenance mismatch (task=${liveTask || "missing"}, dispatch=${liveDispatch || "missing"}, assignee=${liveAssignee || "missing"})`);
  }
  return { runtimeId: currentRuntime, coordinator: verifiedCoordinator, task, tasks, dispatch };
}

// The evidence artifact lives at a DETERMINISTIC path derived from the program/outcome alone,
// so the same path is reused across runtimes, dispatches, and restarts. The path is therefore
// NOT proof of freshness: a reused evidence directory or a prior-run artifact for the same
// outcome would otherwise authorize gate-resolve on a new canonical gate. Every field below
// must be present AND equal to the freshly verified live provenance. (#1019 R3)
const EVIDENCE_PROVENANCE_FIELDS = Object.freeze(["runtime_id", "task_id", "dispatch_id", "assignee"]);

// `provenance` is the result of the immediately preceding currentProvenance() read, which has
// already proven that ctx.taskId/dispatchId/assignee are the LIVE trio. Binding the artifact to
// it therefore binds it to live state, not to caller-supplied hopes.
function expectedEvidenceProvenance(ctx, provenance) {
  return {
    runtime_id: provenance.runtimeId,
    task_id: ctx.taskId,
    dispatch_id: ctx.dispatchId,
    assignee: ctx.assignee,
  };
}

function describeProvenance(fields, source) {
  return fields.map((field) => `${field}=${source[field]}`).join(", ");
}

// A missing id fails closed as INTEGRATION_REPORT_PROVENANCE_MISSING and a contradicting id as
// INTEGRATION_REPORT_PROVENANCE_MISMATCH, so stale evidence can never resolve a gate. Crash
// recovery for the SAME dispatch still passes: a restart of the same runtime/task/dispatch/
// assignee re-reads its own artifact and still matches.
function bindReportProvenance(ctx, provenance, value) {
  const expected = expectedEvidenceProvenance(ctx, provenance || {});
  const missing = EVIDENCE_PROVENANCE_FIELDS.filter((field) => !nonEmpty(value[field]));
  if (missing.length) {
    fail("INTEGRATION_REPORT_PROVENANCE_MISSING", `integration report ${ctx.reportPath} omits required lifecycle provenance (${missing.join(", ")}); deterministic evidence must be bound to the live runtime/task/dispatch/assignee`);
  }
  const mismatched = EVIDENCE_PROVENANCE_FIELDS.filter((field) => !nonEmpty(expected[field]) || value[field] !== expected[field]);
  if (mismatched.length) {
    fail(
      "INTEGRATION_REPORT_PROVENANCE_MISMATCH",
      `integration report ${ctx.reportPath} was written by a different lifecycle (${describeProvenance(mismatched, value)}); the current lifecycle is ${describeProvenance(mismatched, expected)}; refusing to authorize gate-resolve on stale evidence`,
    );
  }
}

function readReport(ctx, provenance) {
  if (!ctx || !nonEmpty(ctx.reportPath)) fail("INTEGRATION_REPORT_PROVENANCE_MISSING", "deterministic integration report path is required");
  if (typeof ctx.readReport !== "function") fail("INTEGRATION_REPORT_PROVENANCE_MISSING", "deterministic integration report reader is unavailable");
  const source = ctx.readReport(ctx.reportPath);
  if (!source || source.present === false) return { present: false };
  const value = source.value !== undefined ? source.value : source;
  if (!value || value.passed !== true || !nonEmpty(value.evidence)) {
    fail("INTEGRATION_REPORT_INVALID", `integration report ${ctx.reportPath} must contain passed:true and deterministic evidence text`);
  }
  bindReportProvenance(ctx, provenance, value);
  return { present: true, passed: true, evidence: value.evidence };
}

function completionCommand(ctx) {
  const marker = coordinationMarkerFor(ctx.programId, ctx.outcomeId, ctx.programSegment);
  const subject = `worker_done: ${marker}`;
  const body = `Canonical integration gate passed for ${marker}. Send this command exactly once from the current dispatched pane.`;
  const argv = [
    "orchestration", "send", "--to", ctx.coordinatorHandle, "--subject", subject,
    "--from", ctx.assignee, "--body", body, "--type", "worker_done",
    "--task-id", ctx.taskId, "--dispatch-id", ctx.dispatchId, "--report-path", ctx.reportPath,
    "--phase", "integration_gate", "--json",
  ];
  const copyPaste = ["orca", ...argv.map((token) => shellQuote(token))].join(" ");
  return { argv, copy_paste: copyPaste, subject, body };
}

function completionInstruction(ctx) {
  const command = completionCommand(ctx);
  return {
    argv: [
      "orchestration", "send", "--to", ctx.assignee, "--subject", `integration_gate ready: ${ctx.outcomeId}`,
      "--from", ctx.coordinatorHandle, "--body", command.copy_paste,
      "--type", "integration_gate_completion", "--task-id", ctx.taskId, "--dispatch-id", ctx.dispatchId,
      "--report-path", ctx.reportPath, "--phase", "integration_gate", "--json",
    ],
    command,
  };
}

function sendCompletionInstruction(ctx) {
  const instruction = completionInstruction(ctx);
  runJson(ctx, instruction.argv, "orca orchestration send integration completion instruction");
  return instruction;
}

function prepareIntegrationGate(ctx) {
  return withBoundedLock(ctx, () => {
    const provenance = currentProvenance(ctx);
    const gate = ensureCanonicalGateUnlocked(ctx, identityFor(ctx));
    return {
      ok: true,
      state: gate.state,
      gate: gate.gate,
      adopted: gate.adopted,
      task: provenance.task,
      coordinator: provenance.coordinator,
      question: identityFor(ctx).question,
      report_path: ctx.reportPath,
      completion_command: completionCommand(ctx),
      // The exact identity the deterministic evidence artifact must carry so a later advance
      // can bind it to THIS dispatch (#1019 H2). Surfaced here so the operator prompt can quote
      // the required values; without them the artifact fails closed instead of resolving a gate.
      // The advance-side readReport rejects anything else. (#1019 R3)
      evidence_provenance: expectedEvidenceProvenance(ctx, provenance),
    };
  });
}

// Re-issue the worker-owned completion instruction (never a coordinator-side worker_done)
// after a fresh provenance re-read, then require task-list to observe status=completed. This
// stays idempotent: the instruction only asks the operator to send the explicit worker_done
// exactly once, so replaying it after a lost instruction or a second resume cannot
// double-complete the task or create a duplicate gate.
function reissueCompletionInstruction(ctx, gateRow) {
  sendCompletionInstruction(ctx);
  const afterInstruction = currentProvenance(ctx);
  if (afterInstruction.task.status !== "completed") {
    return {
      ok: false,
      state: "awaiting_worker_done",
      reason_code: "INTEGRATION_WORKER_DONE_REQUIRED",
      gate: gateRow,
      report_path: ctx.reportPath,
      completion_command: completionCommand(ctx),
    };
  }
  return { ok: true, state: "completed", gate: gateRow, report_path: ctx.reportPath };
}

// The program-owned integration task may still advance toward `completed` ONLY from a live,
// still-running status. This mirrors probe-orca's authoritative active-task set
// (pending/ready/dispatched/blocked); `completed`/`failed` are the two terminal states, and only
// `completed` is a legitimate integration success. Any status outside this set that is not
// `completed` — a terminal `failed`, or any unrecognized/ambiguous status — fails closed rather
// than being mutated toward completion. (#1019 R7)
const ADVANCEABLE_TASK_STATUSES = Object.freeze(["pending", "ready", "dispatched", "blocked"]);

function advanceIntegrationGate(ctx) {
  return withBoundedLock(ctx, () => {
    const provenance = currentProvenance(ctx);
    // Refuse a task that can never legitimately complete BEFORE any gate materialization,
    // gate-resolve, or completion send. `completed` is the ONE success terminal (the terminal
    // paths below own it); every OTHER terminal or non-completable status — `failed`, or any
    // status outside the still-advancing live set — is one-way. A still-verifying historical
    // dispatch plus provenance-bound evidence must not flip the canonical gate to passed or
    // re-issue worker_done against such a task: that strands a passed gate on a task that can
    // never reach completion, a harder residue than failing closed. This fires here with zero
    // further mutation. (#1019 R7)
    const taskStatus = provenance.task && provenance.task.status;
    if (taskStatus !== "completed" && !ADVANCEABLE_TASK_STATUSES.includes(taskStatus)) {
      fail(
        "INTEGRATION_TASK_NOT_COMPLETABLE",
        `integration task ${ctx.taskId} is in terminal/non-completable status "${taskStatus}"; refusing to resolve the canonical gate passed or send worker_done against a task that cannot reach completion — resolve the task's failure at its source rather than forcing the integration gate`,
      );
    }
    // Evidence is validated and provenance-bound BEFORE any gate inspection or mutation,
    // so a stale artifact fails closed with zero lifecycle mutation.
    const report = readReport(ctx, provenance);
    const identity = identityFor(ctx);
    const first = inspectCanonicalGates(listGates(ctx), identity);
    if (!first.ok) fail(first.reasonCode, first.message);
    // A verified live integration dispatch must always carry exactly one canonical gate, and the
    // documented operator ordering is gate-before-evidence. Materialize it here — create-or-adopt
    // through the same post-create re-read and duplicate/conflict defenses — instead of returning
    // awaiting_evidence against no gate at all, which left the lifecycle contract unsatisfied and
    // gave the operator nothing to write evidence against. (#1019 R4)
    const gate = first.state === "missing" ? ensureCanonicalGateUnlocked(ctx, identity) : first;
    const resolution = gateResolution(gate.gate);
    // The canonical gate now exists but no live evidence has landed: resolve nothing, complete
    // nothing, and hand the operator back the same gate on every later pass (idempotent).
    if (!report.present && resolution.state === "pending") {
      return { ok: true, state: "awaiting_evidence", gate: gate.gate, report_path: ctx.reportPath };
    }
    if (provenance.task.status === "completed" && resolution.state !== "passed") {
      fail("INTEGRATION_WORKER_DONE_BEFORE_GATE", "integration task is already completed before the canonical gate resolved passed; refusing to reorder or repair lifecycle state");
    }
    if (resolution.state === "failed") fail("INTEGRATION_GATE_CONFLICT", "canonical integration gate resolved failed; no completion mutation is safe");
    if (resolution.state === "conflict") fail("INTEGRATION_GATE_CONFLICT", "canonical integration gate has a noncanonical/conflicting resolution");
    if (resolution.state === "pending") {
      // report.present is guaranteed here: a pending gate without evidence already returned above.
      const resolvePayload = runJson(ctx, ["orchestration", "gate-resolve", "--id", gateId(gate.gate), "--resolution", "passed", "--json"], "orca orchestration gate-resolve");
      void resolvePayload;
      const reread = inspectCanonicalGates(listGates(ctx), identityFor(ctx));
      if (!reread.ok || reread.state !== "passed") fail(reread.reasonCode || "INTEGRATION_GATE_RESOLUTION_UNCONFIRMED", reread.message || "canonical gate resolution was not re-read as passed");
      return reissueCompletionInstruction(ctx, reread.gate);
    }
    if (!report.present) fail("INTEGRATION_REPORT_PROVENANCE_MISSING", "canonical gate is passed but its deterministic live evidence report is unavailable");
    // Passed canonical gate + valid live evidence + a still-active task is the exact live
    // residue after a lost completion instruction or a second resume. Re-issue the worker-owned
    // completion instruction idempotently (revalidating provenance) instead of failing closed,
    // so the program-owned task can terminalize without a coordinator task-update. (#1019 R2)
    if (provenance.task.status !== "completed") return reissueCompletionInstruction(ctx, gate.gate);
    return { ok: true, state: "completed", gate: gate.gate, report_path: ctx.reportPath };
  });
}

module.exports = {
  CANONICAL_OPTIONS,
  EVIDENCE_PROVENANCE_FIELDS,
  IntegrationLifecycleError,
  gateId,
  canonicalIntegrationQuestion,
  canonicalGateKey,
  gateResolution,
  integrationReportPath,
  inspectCanonicalGates,
  completionCommand,
  ensureCanonicalGate,
  prepareIntegrationGate,
  advanceIntegrationGate,
};
