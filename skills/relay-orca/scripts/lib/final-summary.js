"use strict";

// Program-level completion declaration (#947 D6). Pure: no I/O, no generated
// timestamps/randomness — the summary is REPRODUCIBLE from live state (re-running against
// unchanged live systems yields identical bytes). Given the #945 reconciliation report,
// the receipt, the evaluated gates, and the merged follow-ups, it declares
// `program_complete` under the FULL D6 conjunction and maps the reason completion cannot
// be declared to a single `stopped_on` token.
const { boundedExcerpt } = require("./bounded-excerpt");
const { allGatesPassed } = require("./gate-evaluate");

// Priority-ordered stop conditions (D6). The FIRST present condition becomes `stopped_on`
// (most-severe-first); `blocking_reasons` lists them all. When completion is declared,
// `stopped_on` is null.
const STOP_PRIORITY = Object.freeze([
  "graph_ambiguous",
  "relay_escalated",
  "orca_lifecycle_failure",
  "integration_gate_failed",
  "budget_ceiling_reached",
  "gate_failed",
  "gate_unevaluable",
  "awaiting_decision",
  "unaccepted_follow_up",
  "outcomes_incomplete",
]);

const LIFECYCLE_DIAGNOSTICS = new Set(["MISSING_TASK", "MISSING_DISPATCH", "MISSING_TERMINAL", "RUNTIME_MISMATCH"]);

function diagnosticCodes(report) {
  return new Set((report.diagnostics || []).map((diagnostic) => diagnostic.code));
}

function gatesOfKindFailed(gates, kind) {
  return gates.some((gate) => gate.kind === kind && gate.state === "failed");
}

// Detect which stop conditions are present. Each maps to a distinct token (D6).
function detectStops({ report, gates, followUps, outcomesComplete }) {
  const outcomes = report.outcomes || [];
  const codes = diagnosticCodes(report);
  const present = new Set();
  if (codes.has("DUPLICATE_MAPPING") || (report.repair_candidates || []).length > 0) present.add("graph_ambiguous");
  if (outcomes.some((outcome) => outcome.state === "escalated" || outcome.state === "inconsistent")) present.add("relay_escalated");
  if (report.runtime === "mismatch" || report.runtime === "foreign_state" || [...codes].some((code) => LIFECYCLE_DIAGNOSTICS.has(code))) {
    present.add("orca_lifecycle_failure");
  }
  if (gatesOfKindFailed(gates, "integration")) present.add("integration_gate_failed");
  if (gatesOfKindFailed(gates, "budget")) present.add("budget_ceiling_reached");
  if (gates.some((gate) => gate.state === "failed" && gate.kind !== "integration" && gate.kind !== "budget")) present.add("gate_failed");
  if (gates.some((gate) => gate.state === "unevaluable")) present.add("gate_unevaluable");
  if (outcomes.some((outcome) => outcome.state === "awaiting_decision") || gates.some((gate) => gate.state === "awaiting_decision")) {
    present.add("awaiting_decision");
  }
  if ((followUps.blocking || []).length > 0) present.add("unaccepted_follow_up");
  if (!outcomesComplete && present.size === 0) present.add("outcomes_incomplete");
  return present;
}

function pickStoppedOn(present) {
  for (const token of STOP_PRIORITY) {
    if (present.has(token)) return token;
  }
  return null;
}

function evidenceNames(evidence) {
  if (!evidence || typeof evidence !== "object") return [];
  return Object.keys(evidence).filter((key) => evidence[key] === true);
}

// A decision record "touches" an outcome when its downstream_wave targets that outcome's
// wave (the wave the decision gates). Deterministic linkage (D6).
function decisionsTouching(outcome, decisions) {
  return (Array.isArray(decisions) ? decisions : [])
    .filter((record) => record && Number.isInteger(record.downstream_wave) && record.downstream_wave === outcome.wave)
    .map((record) => record.id);
}

function linkedOutcome(outcome, decisions) {
  return {
    outcome_id: outcome.outcome_id,
    state: outcome.state,
    wave: outcome.wave,
    relay_ids: outcome.relay_ids,
    issue_url: outcome.issue_url ?? null,
    pr_url: outcome.pr_url ?? null,
    evidence_names: evidenceNames(outcome.evidence),
    decisions: decisionsTouching(outcome, decisions),
  };
}

// Bound the string fields of a decision record for the report (D8 bounded-excerpt rule).
// resolved_at is echoed verbatim from the receipt (a stored, stable value — NOT generated
// here), so reproducibility holds.
function boundedDecision(record) {
  return {
    id: boundedExcerpt(record.id != null ? record.id : ""),
    question: boundedExcerpt(record.question != null ? record.question : ""),
    options: (Array.isArray(record.options) ? record.options : []).map((option) => boundedExcerpt(option)),
    resolution: boundedExcerpt(record.resolution != null ? record.resolution : ""),
    resolver: boundedExcerpt(record.resolver != null ? record.resolver : ""),
    resolved_at: boundedExcerpt(record.resolved_at != null ? record.resolved_at : ""),
    downstream_wave: Number.isInteger(record.downstream_wave) ? record.downstream_wave : null,
  };
}

function buildBlockingReasons({ report, gateBlocking, followUps, outcomesComplete }) {
  const reasons = [];
  (gateBlocking || []).forEach((reason) => reasons.push({ reason_code: reason.reason_code, message: boundedExcerpt(reason.message) }));
  (report.outcomes || []).forEach((outcome) => {
    if (outcome.state !== "complete_with_evidence" && !["running", "stale_missing"].includes(outcome.state)) {
      reasons.push({ reason_code: `OUTCOME_${outcome.state.toUpperCase()}`, message: boundedExcerpt(`outcome ${outcome.outcome_id} reconciled ${outcome.state}`) });
    }
  });
  (followUps.blocking || []).forEach((followUp) => {
    reasons.push({ reason_code: "UNACCEPTED_FOLLOW_UP", message: boundedExcerpt(`unaccepted follow-up ${followUp.id} targets accepted scope`) });
  });
  if (!outcomesComplete && reasons.length === 0) {
    reasons.push({ reason_code: "OUTCOMES_INCOMPLETE", message: boundedExcerpt("not every accepted outcome is complete_with_evidence") });
  }
  return reasons;
}

// Assemble the D6/D8 final-summary body (11 keys). `gateEval` is evaluateGates' output;
// `followUps` is mergeFollowUps' { blocking, deferred }; `decisions` is receipt.decisions.
function buildFinalSummary({ programId, receiptPath, report, gateEval, followUps, decisions }) {
  const outcomes = report.outcomes || [];
  const outcomesComplete = outcomes.length > 0 && outcomes.every((outcome) => outcome.state === "complete_with_evidence");
  const gatesPassed = allGatesPassed(gateEval.gates);
  const noBlockingFollowUp = (followUps.blocking || []).length === 0;
  const programComplete = outcomesComplete && gateEval.prerequisites_met && gatesPassed && noBlockingFollowUp;

  const present = detectStops({ report, gates: gateEval.gates, followUps, outcomesComplete });
  const stoppedOn = programComplete ? null : pickStoppedOn(present);
  const decisionRecords = (Array.isArray(decisions) ? decisions : []).map(boundedDecision);

  return {
    ok: true,
    program_id: programId,
    receipt_path: receiptPath,
    program_complete: programComplete,
    stopped_on: stoppedOn,
    outcomes: outcomes.map((outcome) => linkedOutcome(outcome, decisions)),
    gates: gateEval.gates,
    follow_ups: followUps.blocking || [],
    deferred: followUps.deferred || [],
    decisions: decisionRecords,
    blocking_reasons: buildBlockingReasons({ report, gateBlocking: gateEval.blocking_reasons, followUps, outcomesComplete }),
  };
}

module.exports = { STOP_PRIORITY, detectStops, pickStoppedOn, linkedOutcome, buildFinalSummary };
