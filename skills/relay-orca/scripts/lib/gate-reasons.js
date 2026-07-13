"use strict";

// relay-orca `status --gates` / `status --final-summary` fail-closed reason matrix
// (#947 D7). A NEW module in the 70-range so it never collides with plan.js's 2–21
// codes, the probe's 30–37, run's 40–44, status/resume/receipt's 50–63, or Node's own
// fatal/exec codes (<=125). Existing reason modules (lib/reasons.js,
// lib/probe-reasons.js, lib/run-reasons.js, lib/status-reasons.js, lib/resume-reasons.js,
// lib/stop-reasons.js) stay untouched.
//
// These three are the ONLY conditions that fail a gate/completion command, and ONLY
// under `--strict`. Without `--strict` the mode exits 0 with the truthful report
// (information is the product, matching status's house rule). Receipt-layer failures
// reuse the shipped 50–52 (StatusError); usage stays 64. Pure: no I/O.
const REASONS = Object.freeze({
  GATES_NOT_EVALUABLE: 70, // --gates/--final-summary before prerequisites reconcile, under --strict
  GATE_FAILED: 71, // any exit gate failed, under --strict
  COMPLETION_BLOCKED: 72, // --final-summary and program_complete is false, under --strict
});

const REMEDIATION = Object.freeze({
  GATES_NOT_EVALUABLE:
    "Exit gates evaluate only after every accepted outcome reconciles complete_with_evidence; drive the blocking outcomes to completion (relay/relay-fleet) before evaluating gates, or drop --strict to see the truthful report.",
  GATE_FAILED:
    "At least one exit gate failed against live evidence; address the failing gate (fix the integration check, resolve the decision, stay under budget, record authorization) and re-evaluate, or drop --strict.",
  COMPLETION_BLOCKED:
    "program_complete is false; consult stopped_on / blocking_reasons for the specific stop condition, resolve it, and re-run --final-summary, or drop --strict to see the truthful report.",
});

const USAGE_EXIT = 64;

class GateError extends Error {
  constructor(reasonCode, message, remediation) {
    super(message);
    this.name = "GateError";
    this.reasonCode = reasonCode;
    this.exitCode = REASONS[reasonCode];
    this.remediation = remediation || REMEDIATION[reasonCode] || "";
    if (this.exitCode === undefined) {
      throw new Error(`unknown gate reason code: ${reasonCode}`);
    }
  }
}

function reject(reasonCode, message, remediation) {
  throw new GateError(reasonCode, message, remediation);
}

module.exports = { REASONS, REMEDIATION, USAGE_EXIT, GateError, reject };
