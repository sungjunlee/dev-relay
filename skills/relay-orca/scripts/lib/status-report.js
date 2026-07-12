"use strict";

// Stable machine-readable `status` report shape (#945 D9). EXACTLY these nine
// top-level keys, verbatim and in order, on EVERY path — success, degraded, or
// runtime-mismatch. `evidence_checked` is literally `true` (status always checks
// live durable evidence). No timestamps or randomness are generated in the report
// body; receipt timestamps pass through the caller verbatim. Pure: no subprocess,
// no fs mutation.

const REPORT_KEYS = Object.freeze([
  "ok",
  "program_id",
  "receipt_path",
  "runtime",
  "program_state",
  "outcomes",
  "diagnostics",
  "repair_candidates",
  "evidence_checked",
]);

// Per-outcome entry shape (D9). Deterministic key set on every path.
const OUTCOME_KEYS = Object.freeze([
  "outcome_id",
  "kind",
  "wave",
  "state",
  "orca_task_id",
  "dispatch_id",
  "relay_ids",
  "issue_url",
  "pr_url",
  "evidence",
]);

// D5 outcome-level taxonomy — exactly these six tokens.
const OUTCOME_STATES = Object.freeze([
  "running",
  "awaiting_decision",
  "complete_with_evidence",
  "escalated",
  "stale_missing",
  "inconsistent",
]);

// D5 program-level taxonomy — the six outcome tokens plus `ready_for_next_wave`.
const PROGRAM_STATES = Object.freeze([...OUTCOME_STATES, "ready_for_next_wave"]);

// D6/D9 runtime attribution.
const RUNTIME_STATES = Object.freeze(["ok", "mismatch", "foreign_state", "unreachable"]);

// D7 detector matrix — the nine verbatim diagnostic codes.
const DIAGNOSTIC_CODES = Object.freeze([
  "RUNTIME_MISMATCH",
  "MISSING_TERMINAL",
  "MISSING_TASK",
  "MISSING_DISPATCH",
  "DUPLICATE_MAPPING",
  "MISSING_RELAY_RUN",
  "PR_CHANGED",
  "ISSUE_REOPENED",
  "STALE_WORKER_DONE",
]);

function orderOutcome(outcome) {
  const ordered = {};
  OUTCOME_KEYS.forEach((key) => {
    ordered[key] = outcome[key];
  });
  return ordered;
}

function orderReport(report) {
  const ordered = {};
  REPORT_KEYS.forEach((key) => {
    ordered[key] = report[key];
  });
  ordered.outcomes = (report.outcomes || []).map(orderOutcome);
  return ordered;
}

module.exports = {
  REPORT_KEYS,
  OUTCOME_KEYS,
  OUTCOME_STATES,
  PROGRAM_STATES,
  RUNTIME_STATES,
  DIAGNOSTIC_CODES,
  orderOutcome,
  orderReport,
};
