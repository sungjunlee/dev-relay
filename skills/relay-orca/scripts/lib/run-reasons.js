"use strict";

// relay-orca `run` rejection matrix (D9). Each fail-closed reason maps to a
// DISTINCT non-zero exit code plus a stable reason_code string. Codes stay in
// 40–44 so they never collide with plan.js's 2–21 range, the probe's 30–37
// range, or Node's own fatal/exec codes (<=125). This is a NEW module: plan's
// lib/reasons.js and the probe's lib/probe-reasons.js are frozen and untouched.
const REASONS = {
  ADMISSION_REJECTED: 40, // D3 probe rejected or admitted:false
  TASK_MATERIALIZE_FAILED: 41, // D4 orchestration task-create failure
  INJECTION_UNDELIVERED: 42, // D6 dispatch --inject step failed / prompt hand-off failed
  PROVENANCE_MISMATCH: 43, // D6 dispatch-show null/empty/mismatched provenance
  OPERATOR_DISPATCH_FAILED: 44, // D7 no valid operator target for an eligible task
};

const REMEDIATION = {
  ADMISSION_REJECTED:
    "Resolve the Orca capability probe rejection (run probe-orca.js --json) before dispatching operators.",
  TASK_MATERIALIZE_FAILED:
    "Inspect the failing orca orchestration task-create response; already-created tasks are listed and left in place.",
  INJECTION_UNDELIVERED:
    "Re-run once the Orca dispatch surface delivers the injected operator context; the task is left escalated.",
  PROVENANCE_MISMATCH:
    "Reconcile the dispatch-show provenance (task id, dispatch id, assignee); never advance a program on unverified provenance.",
  OPERATOR_DISPATCH_FAILED:
    "Provide an --operator-handle or ensure orca terminal create yields a usable handle for the eligible task.",
};

class RunError extends Error {
  constructor(reasonCode, message, remediation) {
    super(message);
    this.name = "RunError";
    this.reasonCode = reasonCode;
    this.exitCode = REASONS[reasonCode];
    this.remediation = remediation || REMEDIATION[reasonCode] || "";
    if (this.exitCode === undefined) {
      throw new Error(`unknown run reason code: ${reasonCode}`);
    }
  }
}

function reject(reasonCode, message, remediation) {
  throw new RunError(reasonCode, message, remediation);
}

module.exports = { REASONS, REMEDIATION, RunError, reject };
