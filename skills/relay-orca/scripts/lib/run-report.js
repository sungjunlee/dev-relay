"use strict";

// Stable machine-readable run report (D10). EXACTLY these eight top-level keys,
// verbatim and in this order. The report is built once from the compiled plan and
// mutated in place as the run progresses so it stays truthful on EVERY early-exit
// path: an admission rejection, a mid-materialization failure, and an escalation
// all emit the same key set with truthful per-task statuses.
const REPORT_KEYS = Object.freeze([
  "ok",
  "program_id",
  "admission",
  "concurrency",
  "tasks",
  "terminals_created",
  "blocking_reasons",
  "reconciliation_required",
]);

const STATUS = Object.freeze({
  PENDING: "pending",
  DISPATCHED: "dispatched",
  ESCALATED: "escalated",
});

// One report task entry per plan task. Provenance starts null; a task only ever
// reaches "dispatched" after its dispatch-show provenance trio is verified (D6).
function initTaskEntry(task) {
  return {
    task_id: task.task_id,
    outcome_id: task.outcome_id,
    kind: task.kind,
    wave: task.wave,
    orca_task_id: null,
    dispatch_id: null,
    assignee: null,
    status: STATUS.PENDING,
  };
}

function initReport(plan) {
  return {
    ok: false,
    program_id: plan.program_id,
    admission: { admitted: false, runtime_id: null },
    concurrency: plan.concurrency,
    tasks: plan.tasks.map(initTaskEntry),
    terminals_created: [],
    blocking_reasons: [],
    reconciliation_required: true, // literal true in EVERY report (live reconcile is #945)
  };
}

function blockingReason(error) {
  return {
    reason_code: error.reasonCode,
    message: error.message,
    remediation: error.remediation || "",
  };
}

// Emit exactly REPORT_KEYS, in order, regardless of insertion order above.
function orderedReport(report) {
  const ordered = {};
  REPORT_KEYS.forEach((key) => {
    ordered[key] = report[key];
  });
  return ordered;
}

module.exports = {
  REPORT_KEYS,
  STATUS,
  initReport,
  blockingReason,
  orderedReport,
};
