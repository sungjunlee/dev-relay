"use strict";

// Probe rejection matrix (D7). Exit codes stay in 30–37 so they never collide with
// plan.js's 2–21 range or Node's fatal/exec codes (<=125).
const REASONS = {
  BINARY_NOT_FOUND: 30,
  RUNTIME_NOT_READY: 31,
  ORCHESTRATION_UNAVAILABLE: 32,
  MALFORMED_OUTPUT: 33,
  EXISTING_ORCHESTRATION_STATE: 34,
  AMBIGUOUS_GLOBAL_STATE: 35,
  SMOKE_FAILED: 36,
  SMOKE_CLEANUP_FAILED: 37,
};

const USAGE_EXIT = 64;

const REMEDIATION = {
  BINARY_NOT_FOUND:
    "Install Orca, ensure `orca` is on PATH, or pass --orca-bin <path> to the CLI binary.",
  RUNTIME_NOT_READY:
    "Start the Orca desktop app and wait until status reports app running with runtime/graph ready.",
  ORCHESTRATION_UNAVAILABLE:
    "Enable the experimental Orca orchestration surface, then re-run the probe.",
  MALFORMED_OUTPUT:
    "Upgrade or reinstall Orca so status/orchestration --json responses match the mid-2026 CLI shape.",
  EXISTING_ORCHESTRATION_STATE:
    "Finish or clear active (non-terminal) Orca tasks/gates manually. Historical completed/failed tasks are ignored by admission. When appropriate, scoped `orca orchestration reset --tasks` is a manual between-programs operator step; relay-orca never invokes reset automatically.",
  AMBIGUOUS_GLOBAL_STATE:
    "Inspect orca status and orchestration list outputs for inconsistent runtime IDs, counts, or unknown task statuses; resolve manually.",
  SMOKE_FAILED:
    "Fix task-create/dispatch --inject so they return non-empty task, dispatch, and assignee IDs matching --smoke-to. Pass a live recognized-agent terminal via --smoke-to.",
  SMOKE_CLEANUP_FAILED:
    "Terminalize leftover smoke-created task IDs named in the message with a real status (e.g. failed); do not run orchestration reset.",
};

class ProbeError extends Error {
  constructor(reasonCode, message, remediation) {
    super(message);
    this.name = "ProbeError";
    this.reasonCode = reasonCode;
    this.exitCode = REASONS[reasonCode];
    this.remediation = remediation || REMEDIATION[reasonCode] || "";
    if (this.exitCode === undefined) {
      throw new Error(`unknown probe reason code: ${reasonCode}`);
    }
  }
}

function reject(reasonCode, message, remediation) {
  throw new ProbeError(reasonCode, message, remediation);
}

module.exports = { REASONS, REMEDIATION, USAGE_EXIT, ProbeError, reject };
