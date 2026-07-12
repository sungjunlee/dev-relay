"use strict";

// Pure per-outcome classification + program-state derivation for `status`
// (#945 D4/D5/D7). Given already-gathered live facts (durable relay manifest, live
// GitHub, live Orca runtime signals), this module computes each outcome's evidence
// checks, its detector diagnostics, and its D5 state, then derives the program-level
// state. It performs NO I/O — the top-level script and status-derive.js do the
// subprocess/fs work — so plan.js's frozen lib source-scan keeps passing.
//
// Completion authority is durable-only: an outcome is `complete_with_evidence` ONLY
// when its required live durable evidence holds. Orca task status and `worker_done`
// are lifecycle signals, NEVER completion authority.
const { boundedExcerpt } = require("./bounded-excerpt");
const { isTerminalManifestState, isEscalatedManifestState } = require("./manifest-parse");

// Required durable evidence per task kind (D4). Evidence expectations mirror the
// task kind's expected-evidence defaults: a relay_run is complete only when its
// manifest is terminal AND its PR merged AND its tracker issue closed.
const REQUIRED_EVIDENCE = Object.freeze({
  relay_run: ["manifest_terminal", "pr_merged", "issue_closed"],
  relay_fleet: ["manifest_terminal", "pr_merged"],
  integration_gate: ["manifest_terminal"],
  advisory_review: ["manifest_terminal"],
  tracker_reconciliation: ["manifest_terminal"],
});

function requiredEvidenceFor(kind) {
  return REQUIRED_EVIDENCE[kind] || ["manifest_terminal"];
}

function computeEvidence(facts) {
  const { manifest, pr, issue } = facts;
  return {
    manifest_terminal: manifest ? isTerminalManifestState(manifest.state) : null,
    pr_merged: pr ? pr.state === "MERGED" || Boolean(pr.mergedAt) : null,
    issue_closed: issue ? issue.state === "CLOSED" : null,
  };
}

function diag(code, outcomeId, message, ids) {
  return { code, outcome_id: outcomeId ?? null, message: boundedExcerpt(message), ids: ids || {} };
}

// Emit the receipt↔live detector diagnostics for one outcome (D7). Returns the
// diagnostics plus the contradiction flags that drive the `inconsistent` state.
function detectOutcome(facts, evidence, orcaTrusted, complete) {
  const { receiptTask, manifest, orcaTask, orcaTaskMissing, dispatch, mappedRunMissing, mappedRunId, pr } = facts;
  const outcomeId = receiptTask.outcome_id;
  const orcaTaskId = receiptTask.orca_task_id;
  const diagnostics = [];
  const flags = { staleWorkerDone: false, issueReopened: false, prChanged: false };

  if (orcaTrusted && orcaTaskId && orcaTaskMissing) {
    diagnostics.push(diag("MISSING_TASK", outcomeId, `Orca task ${orcaTaskId} is absent from the live task-list`, { orca_task_id: orcaTaskId }));
  }
  const missingDispatch = orcaTrusted && receiptTask.dispatch_id && dispatch && !dispatch.dispatchId;
  if (missingDispatch) {
    diagnostics.push(diag("MISSING_DISPATCH", outcomeId, `dispatch ${receiptTask.dispatch_id} for task ${orcaTaskId} is no longer reported`, { orca_task_id: orcaTaskId, dispatch_id: receiptTask.dispatch_id }));
  }
  if (orcaTrusted && receiptTask.assignee && dispatch && dispatch.terminalPresent === false) {
    diagnostics.push(diag("MISSING_TERMINAL", outcomeId, `operator terminal ${receiptTask.assignee} for task ${orcaTaskId} is gone`, { orca_task_id: orcaTaskId, assignee: receiptTask.assignee }));
  }
  if (mappedRunMissing) {
    diagnostics.push(diag("MISSING_RELAY_RUN", outcomeId, `mapped relay run ${mappedRunId} has no manifest`, { run: mappedRunId }));
  }

  const taskCompleted = Boolean(orcaTask && (orcaTask.status === "completed" || orcaTask.worker_done === true));
  if (taskCompleted && !complete) {
    const prOpen = pr && pr.state !== "MERGED" && !pr.mergedAt;
    const manifestNonTerminal = manifest && !isTerminalManifestState(manifest.state);
    if (prOpen || manifestNonTerminal) {
      flags.staleWorkerDone = true;
      diagnostics.push(diag("STALE_WORKER_DONE", outcomeId, `Orca task ${orcaTaskId} reports done but durable evidence is incomplete`, { orca_task_id: orcaTaskId, pr: manifest ? manifest.pr_number : null, run: mappedRunId }));
    }
  }

  const requiresClosure = requiredEvidenceFor(receiptTask.kind).includes("issue_closed");
  if (requiresClosure && facts.issue && facts.issue.state === "OPEN" && evidence.pr_merged === true && evidence.manifest_terminal === true) {
    flags.issueReopened = true;
    diagnostics.push(diag("ISSUE_REOPENED", outcomeId, `issue ${manifest ? manifest.issue_number : ""} is open though the outcome's evidence contract requires closure`, { issue: manifest ? manifest.issue_number : null }));
  }

  if (manifest && manifest.state === "merged" && pr) {
    if (pr.state !== "MERGED") {
      flags.prChanged = true;
      diagnostics.push(diag("PR_CHANGED", outcomeId, `PR ${manifest.pr_number} state regressed to ${pr.state} though the relay manifest merged it`, { pr: manifest.pr_number, expected: "MERGED", live: pr.state }));
    } else if (manifest.head_sha && pr.headRefOid && manifest.head_sha !== pr.headRefOid) {
      flags.prChanged = true;
      diagnostics.push(diag("PR_CHANGED", outcomeId, `PR ${manifest.pr_number} head moved after merge`, { pr: manifest.pr_number, expected_head: manifest.head_sha, live_head: pr.headRefOid }));
    }
  }

  return { diagnostics, flags };
}

function outcomeState(facts, evidence, complete, flags, orcaTrusted, isDuplicate) {
  const { manifest, receiptTask, orcaTaskMissing, dispatch, mappedRunMissing, gateBlocking } = facts;
  if (flags.staleWorkerDone || flags.issueReopened || flags.prChanged || isDuplicate) return "inconsistent";
  if (complete) return "complete_with_evidence";
  if (manifest && isEscalatedManifestState(manifest.state)) return "escalated";
  if (gateBlocking) return "awaiting_decision";
  const missingDispatch = orcaTrusted && receiptTask.dispatch_id && dispatch && !dispatch.dispatchId;
  const terminalMissing = orcaTrusted && receiptTask.assignee && dispatch && dispatch.terminalPresent === false;
  const runtimeMappingBroken = orcaTrusted && (orcaTaskMissing || missingDispatch || terminalMissing);
  const orcaUnavailable = !orcaTrusted && Boolean(receiptTask.orca_task_id);
  if (mappedRunMissing || runtimeMappingBroken || orcaUnavailable) return "stale_missing";
  return "running";
}

// Classify one outcome. `facts` is the gathered fact bundle; `orcaTrusted` is false
// when the runtime is a mismatch / foreign / unreachable (Orca facts degrade to
// stale_missing per D6). `isDuplicate` marks outcomes sharing a mapping (D7).
function classifyOutcome(facts, { orcaTrusted, isDuplicate }) {
  const { receiptTask } = facts;
  const evidence = computeEvidence(facts);
  const complete = requiredEvidenceFor(receiptTask.kind).every((key) => evidence[key] === true);
  const { diagnostics, flags } = detectOutcome(facts, evidence, orcaTrusted, complete);
  const state = outcomeState(facts, evidence, complete, flags, orcaTrusted, isDuplicate);
  const started = Boolean(receiptTask.dispatch_id || (receiptTask.relay_ids && receiptTask.relay_ids.run) || facts.pr);
  return {
    outcome: {
      outcome_id: receiptTask.outcome_id,
      kind: receiptTask.kind,
      wave: receiptTask.wave,
      state,
      orca_task_id: receiptTask.orca_task_id ?? null,
      dispatch_id: receiptTask.dispatch_id ?? null,
      relay_ids: receiptTask.relay_ids,
      issue_url: facts.issueUrl ?? null,
      pr_url: facts.prUrl ?? null,
      evidence,
    },
    diagnostics,
    started,
    complete,
  };
}

// Derive the program-level state (D5). `ready_for_next_wave` requires every outcome
// in the preceding waves of the lowest incomplete wave to be complete_with_evidence,
// no outcome escalated/inconsistent, and the next wave not yet started.
function deriveProgramState(entries) {
  const states = entries.map((entry) => entry.outcome.state);
  if (states.includes("inconsistent")) return "inconsistent";
  if (states.includes("escalated")) return "escalated";
  if (states.length > 0 && states.every((state) => state === "complete_with_evidence")) return "complete_with_evidence";
  if (states.includes("awaiting_decision")) return "awaiting_decision";
  const nonComplete = entries.filter((entry) => entry.outcome.state !== "complete_with_evidence");
  if (nonComplete.length === 0) return "running";
  const lowestIncompleteWave = Math.min(...nonComplete.map((entry) => entry.outcome.wave));
  const precedingComplete = entries
    .filter((entry) => entry.outcome.wave < lowestIncompleteWave)
    .every((entry) => entry.outcome.state === "complete_with_evidence");
  const waveStarted = nonComplete
    .filter((entry) => entry.outcome.wave === lowestIncompleteWave)
    .some((entry) => entry.started);
  if (lowestIncompleteWave > 1 && precedingComplete && !waveStarted) return "ready_for_next_wave";
  if (states.includes("stale_missing")) return "stale_missing";
  return "running";
}

module.exports = {
  REQUIRED_EVIDENCE,
  requiredEvidenceFor,
  computeEvidence,
  classifyOutcome,
  deriveProgramState,
};
