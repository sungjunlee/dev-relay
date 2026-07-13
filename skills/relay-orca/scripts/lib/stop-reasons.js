"use strict";

// relay-orca `stop` reason matrix (#946 D5). Receipt-layer failures re-use status's
// 50-52 verbatim (imported by stop.js), so this module only owns the ONE stop-specific
// failure: the coordinator run-stop itself did not succeed. Code 65 stays clear of
// plan's 2-21, the probe's 30-37, run's 40-44, status/receipt's 50-52, resume's 60-63,
// and the 64 usage slot. Existing reason modules stay untouched.
const REASONS = Object.freeze({
  COORDINATOR_STOP_FAILED: 65, // `orca orchestration run-stop` returned non-ok / non-zero
});

const REMEDIATION = Object.freeze({
  COORDINATOR_STOP_FAILED:
    "The coordinator run-stop did not succeed; inspect the Orca runtime and retry `stop`. No relay run, worktree, PR, or issue is ever touched by stop.",
});

const USAGE_EXIT = 64;

class StopError extends Error {
  constructor(reasonCode, message, remediation) {
    super(message);
    this.name = "StopError";
    this.reasonCode = reasonCode;
    this.exitCode = REASONS[reasonCode];
    this.remediation = remediation || REMEDIATION[reasonCode] || "";
    if (this.exitCode === undefined) {
      throw new Error(`unknown stop reason code: ${reasonCode}`);
    }
  }
}

module.exports = { REASONS, REMEDIATION, USAGE_EXIT, StopError };
