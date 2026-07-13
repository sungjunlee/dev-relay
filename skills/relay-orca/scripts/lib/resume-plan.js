"use strict";

// Pure `resume` action planner (#946 D2/D3/D4/D6). Given the parsed receipt and the
// live reconciliation report produced by the imported #945 status pipeline, it decides
// — with NO I/O — whether resumption is safe and, if so, exactly which outcomes are
// reused, re-dispatched, reacquire a terminal, or are left untouched. All subprocess
// and fs work happens in the top-level resume.js via injected adapters; this module is
// pure so plan.js's frozen lib source-scan keeps passing.
//
// Completion authority stays with the imported classifier (D6): a worker_done outcome
// with an open PR / non-terminal manifest is `inconsistent` here too, and resume never
// re-dispatches it — it surfaces as a decision. The re-dispatch predicate is the D3
// conjunction: an outcome is re-dispatched ONLY when its Orca dispatch is verifiably
// absent AND its relay side shows no in-flight/durable work AND the wave rules allow it.
const { boundedExcerpt } = require("./bounded-excerpt");
const { REASONS, exitCodeFor, decisionEntry } = require("./resume-reasons");
const { actionEntry } = require("./resume-report");

function reportOutcomeById(report, outcomeId) {
  return (report.outcomes || []).find((outcome) => outcome.outcome_id === outcomeId) || null;
}

function diagsFor(report, outcomeId) {
  return (report.diagnostics || []).filter((diagnostic) => diagnostic.outcome_id === outcomeId);
}

function hasDiag(diags, code) {
  return diags.some((diagnostic) => diagnostic.code === code);
}

// A DUPLICATE_MAPPING diagnostic OR a dispatch id that drifted under the mapping (a
// MISSING_DISPATCH carrying a live_dispatch_id, #945 A10) is a contradictory mapping.
function driftedDispatch(diags) {
  return diags.some((diagnostic) => diagnostic.code === "MISSING_DISPATCH" && diagnostic.ids && "live_dispatch_id" in diagnostic.ids);
}

// D2 code 63: the receipt records a dispatch (a live dispatch therefore exists — no
// MISSING_DISPATCH fired) but its provenance is incomplete (no assignee), so resume
// cannot verify which terminal owns the live dispatch.
function missingProvenance(task) {
  return Boolean(task.orca_task_id) && Boolean(task.dispatch_id) && !isNonEmpty(task.assignee);
}

// D2 code 63, crash window (owner amendment A1, #946 R1): a live dispatch-show read
// reports a dispatch PRESENT for this task, but the receipt records NO provenance
// (dispatch_id and/or assignee absent) — the signature of `dispatch --inject` landing a
// live dispatch and the receipt write that records it never happening. The live dispatch
// is real, so re-injecting would DUPLICATE operator work: a null receipt dispatch_id here
// is NOT verifiable absence, and resume fails closed (RESUME_MISSING_PROVENANCE) with
// zero mutation rather than re-dispatching.
function liveDispatchWithoutProvenance(task, livePresent) {
  return livePresent === true && isNonEmpty(task.orca_task_id) && (!isNonEmpty(task.dispatch_id) || !isNonEmpty(task.assignee));
}

// Per-outcome live dispatch fact threaded from resume's reconciliation pass (the pipeline
// already performs the per-task dispatch-show reads): `{ present, absent }` where
// `present` = a reachable, runtime-attributed dispatch-show reported a dispatch id, and
// `absent` = it reported none. Both false = UNKNOWN (untrusted runtime, an unattributable
// per-task read, or a task missing from the runtime) — which NEVER qualifies as verifiable
// absence. Accepts a Map or a plain object; a missing entry degrades to unknown.
function liveDispatchFact(liveDispatch, outcomeId) {
  if (liveDispatch && typeof liveDispatch.get === "function") return liveDispatch.get(outcomeId) || {};
  if (liveDispatch && typeof liveDispatch === "object") return liveDispatch[outcomeId] || {};
  return {};
}

function isNonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function relayIds(task) {
  return task.relay_ids && typeof task.relay_ids === "object" ? task.relay_ids : {};
}

// D3 relay-side cleanliness: no mapped relay run, no mapped fleet, and no PR — the only
// state in which re-dispatch cannot duplicate in-flight/durable relay work.
function relayClean(task, outcome) {
  const ids = relayIds(task);
  return !isNonEmpty(ids.run) && !isNonEmpty(ids.fleet) && !(outcome && outcome.pr_url);
}

// A fully valid live mapping: task + dispatch + terminal all present and unbroken.
function mappingLive(task, diags) {
  return (
    isNonEmpty(task.orca_task_id) &&
    isNonEmpty(task.dispatch_id) &&
    isNonEmpty(task.assignee) &&
    !hasDiag(diags, "MISSING_TASK") &&
    !hasDiag(diags, "MISSING_DISPATCH") &&
    !hasDiag(diags, "MISSING_TERMINAL")
  );
}

// D4 terminal reacquisition: the Orca task + dispatch survive but the operator terminal
// is gone. The surface is re-established through the SAME verified path as a dispatch.
function needsTerminalReacquire(task, diags) {
  return (
    isNonEmpty(task.orca_task_id) &&
    isNonEmpty(task.dispatch_id) &&
    hasDiag(diags, "MISSING_TERMINAL") &&
    !hasDiag(diags, "MISSING_TASK") &&
    !hasDiag(diags, "MISSING_DISPATCH")
  );
}

// D3 re-dispatch: the Orca dispatch is VERIFIABLY absent, the materialized task still
// exists, the relay side is clean, and the wave rule allows it (v0 dispatches only wave
// 1, matching the #944 run anchor). "Verifiably absent" (owner amendment A1, #946 R1) is
// satisfied ONLY by `liveAbsent` — a live dispatch-show read for THIS task, threaded from
// the reconciliation pass, that reports NO dispatch. A null receipt `dispatch_id` alone
// NEVER qualifies: in the crash window (dispatch --inject landed a live dispatch but the
// receipt write that records it never happened) the receipt id is null yet a live dispatch
// is present, and re-injecting there would duplicate operator work — that case fails closed
// as RESUME_MISSING_PROVENANCE in planDecisions instead of re-dispatching here.
function isRedispatchCandidate(task, diags, outcome, liveAbsent) {
  return (
    liveAbsent === true &&
    !isNonEmpty(task.dispatch_id) &&
    isNonEmpty(task.orca_task_id) &&
    !hasDiag(diags, "MISSING_TASK") &&
    task.wave === 1 &&
    relayClean(task, outcome)
  );
}

// Program-level fail-closed decisions (D2). Deduped by reason_code and ordered by exit
// code so the process exit is deterministic (60 < 61 < 62 < 63).
function planDecisions(receipt, report, liveDispatch) {
  const decisions = [];
  const add = (code, message) => {
    if (!decisions.some((entry) => entry.reason_code === code)) decisions.push(decisionEntry(code, message));
  };
  if (report.runtime === "mismatch") {
    add("RESUME_RUNTIME_CHANGED", "live Orca runtime id does not match the receipt runtime_id; resume performs no mutation until it is reconciled");
  }
  if (report.runtime === "foreign_state" || report.runtime === "unreachable") {
    add("RESUME_AMBIGUOUS_STATE", `live runtime is ${report.runtime}; resume cannot attribute Orca facts, so it performs no mutation`);
  }
  if ((report.diagnostics || []).some((diagnostic) => diagnostic.code === "DUPLICATE_MAPPING")) {
    add("RESUME_CONFLICTING_MAPPING", "receipt carries duplicate/contradictory mappings (DUPLICATE_MAPPING); resume performs no mutation");
  }
  receipt.tasks.forEach((task) => {
    const diags = diagsFor(report, task.outcome_id);
    const live = liveDispatchFact(liveDispatch, task.outcome_id);
    if (driftedDispatch(diags)) add("RESUME_CONFLICTING_MAPPING", `outcome ${task.outcome_id} dispatch id changed under the mapping; resume performs no mutation`);
    if (missingProvenance(task) && !hasDiag(diags, "MISSING_DISPATCH")) {
      add("RESUME_MISSING_PROVENANCE", `outcome ${task.outcome_id} has a live dispatch but its recorded provenance is incomplete; resume performs no mutation`);
    }
    // Crash window (A1): a live dispatch-show read reports a dispatch present but the
    // receipt recorded no provenance for it. A null receipt dispatch_id is NOT absence
    // here — re-injecting would duplicate operator work — so fail closed with zero mutation.
    if (liveDispatchWithoutProvenance(task, live.present)) {
      add("RESUME_MISSING_PROVENANCE", `outcome ${task.outcome_id} has a live dispatch but the receipt records no dispatch provenance; resume performs no mutation`);
    }
  });
  const inconsistent = (report.outcomes || []).filter((outcome) => outcome.state === "inconsistent");
  if (inconsistent.length) {
    add("RESUME_AMBIGUOUS_STATE", `outcome ${inconsistent[0].outcome_id} is inconsistent (durable evidence conflicts with a lifecycle signal); resume performs no mutation`);
  }
  return decisions.sort((a, b) => exitCodeFor(a.reason_code) - exitCodeFor(b.reason_code));
}

// Internal action carrier: the report entry plus an `exec` plan the top-level executor
// consumes. `exec` is null for reused/skipped/decision_required (no mutation).
function makeAction(task, action, reason, exec) {
  return { outcome_id: task.outcome_id, action, reason: boundedExcerpt(reason), exec: exec || null };
}

function execPlan(task, type) {
  return { type, outcome_id: task.outcome_id, orca_task_id: task.orca_task_id, kind: task.kind, wave: task.wave };
}

// Program-level "unmapped relay work" signal (D3 no-duplicate-work): reconciliation
// discovered a relay run manifest that references this program but is ABSENT from the
// receipt mapping. It cannot be attributed to a specific outcome, so re-dispatching ANY
// verifiably-absent outcome could duplicate that unmapped work — such outcomes are skipped
// (left for a supervised reconcile) rather than re-dispatched. Reuse/reacquisition of
// already-mapped outcomes is unaffected.
function hasUnmappedRelayWork(report) {
  return (report.repair_candidates || []).some((candidate) => candidate.kind === "adopt_relay_run");
}

// Classify ONE outcome into a safe action (only reached when NO program-level decision
// fired). Completion/escalation are terminal (skipped); a live mapping is reused; a lost
// terminal is reacquired; a verifiably-absent, relay-clean, wave-1 outcome is
// re-dispatched; everything else (in-flight/durable child, later wave, or unattributable
// unmapped relay work) is left untouched.
function classifyAction(task, report, unmappedRelayWork, liveDispatch) {
  const outcome = reportOutcomeById(report, task.outcome_id) || {};
  const diags = diagsFor(report, task.outcome_id);
  const live = liveDispatchFact(liveDispatch, task.outcome_id);
  if (outcome.state === "complete_with_evidence") return makeAction(task, "skipped", "already complete with live evidence; nothing to resume");
  if (outcome.state === "escalated") return makeAction(task, "skipped", "escalated; requires operator action, not automatic resume");
  if (needsTerminalReacquire(task, diags)) return makeAction(task, "redispatched", `outcome ${task.outcome_id} operator terminal is gone; reacquiring through the verified inject->dispatch-show->prompt path`, execPlan(task, "reacquire_terminal"));
  if (mappingLive(task, diags)) return makeAction(task, "reused", `outcome ${task.outcome_id} has a valid live mapping (task+dispatch+terminal); reused, not re-dispatched`);
  if (isRedispatchCandidate(task, diags, outcome, live.absent)) {
    if (unmappedRelayWork) return makeAction(task, "skipped", `outcome ${task.outcome_id} is absent, but unmapped relay work references this program; not re-dispatched to avoid duplicating it`);
    return makeAction(task, "redispatched", `outcome ${task.outcome_id} Orca dispatch verifiably absent and relay side clean; re-dispatching through the verified path`, execPlan(task, "redispatch"));
  }
  return makeAction(task, "skipped", `outcome ${task.outcome_id} has in-flight/durable relay work or is a later wave; left untouched`);
}

// The whole plan: program-level decisions plus per-outcome actions. When any decision
// fires, EVERY outcome is `decision_required` (resume performs zero mutation, D2).
function planResume({ receipt, report, liveDispatch }) {
  const decisions = planDecisions(receipt, report, liveDispatch);
  if (decisions.length) {
    const reason = boundedExcerpt(`blocked: ${decisions[0].reason_code}`);
    const actions = receipt.tasks.map((task) => makeAction(task, "decision_required", reason, null));
    const blockingReasons = decisions.map((decision) => ({ reason_code: decision.reason_code, message: decision.message }));
    return { decisions, actions, blockingReasons, exitCode: exitCodeFor(decisions[0].reason_code) };
  }
  const unmappedRelayWork = hasUnmappedRelayWork(report);
  const actions = receipt.tasks.map((task) => classifyAction(task, report, unmappedRelayWork, liveDispatch));
  return { decisions: [], actions, blockingReasons: [], exitCode: 0 };
}

module.exports = {
  REASONS,
  planResume,
  planDecisions,
  classifyAction,
  hasUnmappedRelayWork,
  relayClean,
  mappingLive,
  needsTerminalReacquire,
  isRedispatchCandidate,
  missingProvenance,
  liveDispatchWithoutProvenance,
  driftedDispatch,
};
