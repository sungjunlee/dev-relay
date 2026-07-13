"use strict";

// relay-orca `resume` fail-closed DECISION matrix (#946 D2). A NEW module in the
// 60-range so it never collides with plan.js's 2-21 codes, the probe's 30-37, run's
// 40-44, status/receipt's 50-52, or Node's own fatal/exec codes (<=125). Existing
// reason modules stay untouched. 64 (usage errors) and 65 (stop's
// COORDINATOR_STOP_FAILED) are deliberately avoided.
//
// These are the ONLY conditions that make resumption unsafe. In any of them
// resume performs NO automatic mutation: it emits a `decision_required` report and
// exits with the matching code. Receipt-layer failures re-use status's 50-52
// verbatim (imported by resume.js); these decision codes are surfaced through the
// report's `decision_required` array, never a task/terminal/dispatch mutation.
const { boundedExcerpt } = require("./bounded-excerpt");

const REASONS = Object.freeze({
  RESUME_RUNTIME_CHANGED: 60, // live runtime id != receipt runtime_id
  RESUME_AMBIGUOUS_STATE: 61, // foreign/unreachable runtime, or an unclassifiable outcome
  RESUME_CONFLICTING_MAPPING: 62, // duplicate or contradictory (changed) mappings
  RESUME_MISSING_PROVENANCE: 63, // a mapping's dispatch context/assignee is missing where a live dispatch exists
  RESUME_NO_OPERATOR_HANDLE: 66, // an outcome needs (re)dispatch but no --operator-handle was provided (64 = usage, 65 = stop's COORDINATOR_STOP_FAILED)
});

// Bounded recovery options per decision code (D2). Each option names a concrete
// operator command to run and stays under the shared excerpt limit. Options NEVER
// name `orca orchestration reset`, task deletion, worktree deletion, or relay
// force-close — resume never performs a destructive action and never advises one.
const OPTIONS = Object.freeze({
  RESUME_RUNTIME_CHANGED: [
    "Inspect the live runtime: `node scripts/status.js --program-id <id> --json`.",
    "Only after confirming no duplicate work: re-run `node scripts/run.js --program-file <program>` against the new runtime.",
    "See references/recovery.md § RESUME_RUNTIME_CHANGED for the bounded manual steps.",
  ],
  RESUME_AMBIGUOUS_STATE: [
    "Inspect the foreign/ambiguous runtime: `node scripts/status.js --program-id <id> --json`.",
    "Resolve the ambiguous outcome by hand, then re-run resume.",
    "See references/recovery.md § RESUME_AMBIGUOUS_STATE for the bounded manual steps.",
  ],
  RESUME_CONFLICTING_MAPPING: [
    "Inspect the duplicate/changed mapping: `node scripts/status.js --program-id <id> --json`.",
    "Reconcile the conflicting mapping by hand before resuming.",
    "See references/recovery.md § RESUME_CONFLICTING_MAPPING for the bounded manual steps.",
  ],
  RESUME_MISSING_PROVENANCE: [
    "Verify the live dispatch: `orca orchestration dispatch-show --task <orca_task_id> --json`.",
    "Restore the missing dispatch context/assignee in the receipt by hand before resuming.",
    "See references/recovery.md § RESUME_MISSING_PROVENANCE for the bounded manual steps.",
  ],
  RESUME_NO_OPERATOR_HANDLE: [
    "Create an operator terminal running an agent CLI: `orca terminal create --command \"<agent-cli>\" --json`.",
    "Re-run resume with the terminal handle: `node scripts/resume.js --program-id <id> --operator-handle <handle> --json`.",
    "See references/recovery.md § RESUME_NO_OPERATOR_HANDLE for the bounded manual steps.",
  ],
});

function exitCodeFor(reasonCode) {
  const code = REASONS[reasonCode];
  if (code === undefined) throw new Error(`unknown resume reason code: ${reasonCode}`);
  return code;
}

// Build a decision_required report entry (D8). `message` is a bounded excerpt so a
// subprocess-derived detail can never inflate or line-inject the report; `options`
// come from the pinned bounded set above (each already ≤ the excerpt limit).
function decisionEntry(reasonCode, message) {
  return {
    reason_code: reasonCode,
    message: boundedExcerpt(message),
    options: (OPTIONS[reasonCode] || []).map((option) => boundedExcerpt(option)),
  };
}

module.exports = { REASONS, OPTIONS, exitCodeFor, decisionEntry };
