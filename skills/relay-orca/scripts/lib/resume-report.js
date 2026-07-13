"use strict";

// Stable machine-readable `resume` report shape (#946 D8). EXACTLY these ten
// top-level keys, verbatim and in order, on EVERY resume-report path — a successful
// resume, a decision-required abort (exit 60-63), and an idempotent re-run.
// `reconciliation_required` is literally `true` in every report (live reconciliation
// is #945, and resume never claims completion). Pure: no subprocess, no fs mutation,
// so plan.js's frozen lib source-scan keeps passing.

const REPORT_KEYS = Object.freeze([
  "ok",
  "program_id",
  "receipt_path",
  "runtime",
  "reconciliation",
  "actions",
  "terminals_created",
  "decision_required",
  "blocking_reasons",
  "reconciliation_required",
]);

// D8 per-outcome action taxonomy — exactly these four tokens. `reused` = valid live
// mapping left untouched; `redispatched` = the operator surface was re-established
// through the verified inject->dispatch-show->prompt path (a re-dispatch or a
// terminal reacquisition); `skipped` = left alone (in-flight/durable child or a
// later wave); `decision_required` = blocked pending an operator decision.
const ACTIONS = Object.freeze(["reused", "redispatched", "skipped", "decision_required"]);

// One report action entry per receipt outcome (D8). `reason` is a bounded excerpt.
function actionEntry(outcomeId, action, reason) {
  return { outcome_id: outcomeId, action, reason };
}

// Emit exactly REPORT_KEYS, in order, regardless of insertion order above.
function orderReport(report) {
  const ordered = {};
  REPORT_KEYS.forEach((key) => {
    ordered[key] = report[key];
  });
  return ordered;
}

module.exports = {
  REPORT_KEYS,
  ACTIONS,
  actionEntry,
  orderReport,
};
