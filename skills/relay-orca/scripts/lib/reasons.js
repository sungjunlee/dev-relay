"use strict";

// Every plan rejection maps to a DISTINCT non-zero exit code plus a stable
// reason_code string. The seven Done-Criteria D7 cases are marked below; the
// remaining codes are structural guards. Exit codes stay <= 125 so they never
// collide with Node's own fatal/exec exit codes.
const REASONS = {
  // --- structural guards ---
  INVALID_INPUT: 2,
  DUPLICATE_OUTCOME_ID: 3,
  UNKNOWN_DEPENDENCY: 4,
  INVALID_WAVE_DECLARATION: 5,
  // --- D7 enumerated rejection matrix ---
  VAGUE_INTENT: 10, // D7(a) raw/vague intent lacking accepted outcomes
  MISSING_EXIT_GATES: 11, // D7(b) program missing exit gates
  UNPREPARED_FLEET_LEAF: 12, // D7(c) relay_fleet route without prepared prompt/rubric/DC
  DEPENDENCY_CYCLE: 13, // D7(d) dependency cycle
  SAME_WAVE_DEPENDENCY: 14, // D7(e) dependency does not resolve to a strictly earlier wave
  UNSUPPORTED_TASK_KIND: 15, // D7(f) task kind outside the five supported
  CONCURRENCY_EXCEEDED: 16, // D7(g) concurrency above the hard maximum of 4
  // --- D9 depth / nesting rejections ---
  NESTED_RELAY_ORCA: 20, // relay-orca nested inside a relay-orca program
  EXCESSIVE_DEPTH: 21, // orchestration depth beyond coordinator -> operator -> executor/reviewer
};

class PlanError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "PlanError";
    this.reasonCode = reasonCode;
    this.exitCode = REASONS[reasonCode];
    if (this.exitCode === undefined) {
      throw new Error(`unknown plan reason code: ${reasonCode}`);
    }
  }
}

function reject(reasonCode, message) {
  throw new PlanError(reasonCode, message);
}

module.exports = { REASONS, PlanError, reject };
