"use strict";

// relay-orca `status` fail-closed reason matrix (#945 D8). A NEW module in the
// 50-range so it never collides with plan.js's 2–21 codes, the probe's 30–37, run's
// 40–44, or Node's own fatal/exec codes (<=125). Existing reason modules
// (lib/reasons.js, lib/probe-reasons.js, lib/run-reasons.js) stay untouched.
//
// These three are the ONLY conditions that fail the command. A successfully derived
// view — even one full of `inconsistent`/`stale_missing` outcomes, a runtime
// mismatch, or an unreachable Orca/GitHub — exits 0 (the information is the product).
const REASONS = Object.freeze({
  RECEIPT_NOT_FOUND: 50, // no receipt for --program-id under the programs root
  RECEIPT_CORRUPT: 51, // unparseable JSON, wrong schema, or missing required keys
  RECEIPT_REPO_MISMATCH: 52, // receipt repo.slug does not match the current repo
});

const REMEDIATION = Object.freeze({
  RECEIPT_NOT_FOUND:
    "Run relay-orca `run` for this program first, or pass the correct --program-id; the receipt is written under the relay-owned programs root.",
  RECEIPT_CORRUPT:
    "The receipt is unparseable or schema-invalid; re-run relay-orca `run` to rewrite a fresh atomic receipt (never hand-edit it).",
  RECEIPT_REPO_MISMATCH:
    "The receipt was written for a different repository; invoke `status` from the same repo (or pass --repo-root) that produced the receipt.",
});

const USAGE_EXIT = 64;

class StatusError extends Error {
  constructor(reasonCode, message, remediation) {
    super(message);
    this.name = "StatusError";
    this.reasonCode = reasonCode;
    this.exitCode = REASONS[reasonCode];
    this.remediation = remediation || REMEDIATION[reasonCode] || "";
    if (this.exitCode === undefined) {
      throw new Error(`unknown status reason code: ${reasonCode}`);
    }
  }
}

function reject(reasonCode, message, remediation) {
  throw new StatusError(reasonCode, message, remediation);
}

module.exports = { REASONS, REMEDIATION, USAGE_EXIT, StatusError, reject };
