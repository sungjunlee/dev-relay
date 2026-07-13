"use strict";

// Stable machine-readable report shapes for `status --gates` and `status --final-summary`
// (#947 D8). EXACTLY these verbatim, ordered top-level keys on EVERY path — success,
// failed, not-yet-evaluable, or degraded. No timestamps or randomness are generated in
// either report body (D6/D8 reproducibility); any receipt-stored timestamp passes through
// verbatim. Pure: no I/O.

// `status --gates --json` — the seven verbatim top-level keys (D8).
const GATES_REPORT_KEYS = Object.freeze([
  "ok",
  "program_id",
  "receipt_path",
  "prerequisites_met",
  "gates",
  "follow_ups",
  "blocking_reasons",
]);

// `status --final-summary --json` — the eleven verbatim top-level keys (D8).
const FINAL_SUMMARY_KEYS = Object.freeze([
  "ok",
  "program_id",
  "receipt_path",
  "program_complete",
  "stopped_on",
  "outcomes",
  "gates",
  "follow_ups",
  "deferred",
  "decisions",
  "blocking_reasons",
]);

// Per-gate entry shape (D8). Deterministic key set on every path.
const GATE_ENTRY_KEYS = Object.freeze(["gate", "kind", "state", "evidence", "message"]);

// The verbatim gate-state enum (D8).
const GATE_STATES = Object.freeze([
  "passed",
  "failed",
  "not_yet_evaluable",
  "awaiting_decision",
  "unevaluable",
]);

// The distinct `stopped_on` values (D6). Each stop condition maps to exactly one token.
const STOPPED_ON_VALUES = Object.freeze([
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

function orderGate(gate) {
  const ordered = {};
  GATE_ENTRY_KEYS.forEach((key) => {
    ordered[key] = gate[key];
  });
  return ordered;
}

// A follow-up carries EXACTLY one source key (`source_gate` OR `source_outcome`, D3), so
// the ordered entry emits whichever is present — never both, never neither.
function orderFollowUp(followUp) {
  const ordered = { id: followUp.id };
  if (followUp.source_gate != null) ordered.source_gate = followUp.source_gate;
  else ordered.source_outcome = followUp.source_outcome != null ? followUp.source_outcome : null;
  ordered.description = followUp.description;
  ordered.proposed_wave = followUp.proposed_wave;
  ordered.status = followUp.status;
  return ordered;
}

function orderGatesReport(report) {
  const ordered = {};
  GATES_REPORT_KEYS.forEach((key) => {
    ordered[key] = report[key];
  });
  ordered.gates = (report.gates || []).map(orderGate);
  ordered.follow_ups = (report.follow_ups || []).map(orderFollowUp);
  return ordered;
}

function orderFinalSummary(report) {
  const ordered = {};
  FINAL_SUMMARY_KEYS.forEach((key) => {
    ordered[key] = report[key];
  });
  ordered.gates = (report.gates || []).map(orderGate);
  ordered.follow_ups = (report.follow_ups || []).map(orderFollowUp);
  ordered.deferred = (report.deferred || []).map(orderFollowUp);
  return ordered;
}

module.exports = {
  GATES_REPORT_KEYS,
  FINAL_SUMMARY_KEYS,
  GATE_ENTRY_KEYS,
  GATE_STATES,
  STOPPED_ON_VALUES,
  orderGate,
  orderFollowUp,
  orderGatesReport,
  orderFinalSummary,
};
