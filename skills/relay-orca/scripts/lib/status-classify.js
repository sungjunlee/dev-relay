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
const { boundedExcerpt, boundedIds } = require("./bounded-excerpt");
const { isTerminalManifestState, isEscalatedManifestState } = require("./manifest-parse");

// Named live-evidence checks per task kind (D4). Each kind carries its OWN evidence
// contract mirroring the FROZEN expected-evidence defaults in references/task-kinds.md
// (relay manifest merged; every fleet child terminal; gate check passes live; etc.).
// An outcome is `complete_with_evidence` ONLY when every check in its kind's contract
// holds `true`; a null check is "unknown" (source not yet resolvable) and never
// completes. No kind is left unclassifiable — every kind names ≥1 concrete check.
const EVIDENCE_CONTRACTS = Object.freeze({
  relay_run: ["manifest_terminal", "pr_merged", "issue_closed"],
  relay_fleet: ["fleet_children_terminal", "fleet_manifest_closed"],
  integration_gate: ["gate_report_present", "gate_check_passes"],
  advisory_review: ["advisory_evidence_posted", "blocking_findings_triaged"],
  tracker_reconciliation: ["tracker_reconciled"],
});

function requiredEvidenceFor(kind) {
  return EVIDENCE_CONTRACTS[kind] || EVIDENCE_CONTRACTS.relay_run;
}

// relay_run: relay manifest merged AND PR merged AND tracker issue closed.
function relayRunEvidence(facts) {
  const { manifest, pr, issue } = facts;
  return {
    manifest_terminal: manifest ? isTerminalManifestState(manifest.state) : null,
    pr_merged: pr ? pr.state === "MERGED" || Boolean(pr.mergedAt) : null,
    issue_closed: issue ? issue.state === "CLOSED" : null,
  };
}

// relay_fleet: EVERY fleet child terminal AND the fleet manifest closed. The fleet
// manifest is resolved via relay_ids.fleet in status-derive.js, and each child's
// terminal flag is resolved there against the same runs root.
function relayFleetEvidence(facts) {
  const { fleetManifest, fleetChildren } = facts;
  const children = Array.isArray(fleetChildren) ? fleetChildren : [];
  let childrenTerminal = null;
  if (fleetManifest) childrenTerminal = children.length > 0 && children.every((child) => child.terminal === true);
  return {
    fleet_children_terminal: childrenTerminal,
    fleet_manifest_closed: fleetManifest ? isTerminalManifestState(fleetManifest.fleet_state) : null,
  };
}

// A decision/review gate "passes" when its live status is an explicit pass token.
function gatePasses(gate) {
  return Boolean(gate && ["passed", "approved", "resolved"].includes(gate.status));
}

// integration_gate (read-only): the outcome's live integration gate exists AND its
// check passes. The gate is receipt-referenced via the outcome's orca_task_id (see
// receipt-and-status.md). When Orca is untrusted the checks degrade to null.
function integrationGateEvidence(facts, orcaTrusted) {
  if (!orcaTrusted) return { gate_report_present: null, gate_check_passes: null };
  const gates = Array.isArray(facts.outcomeGates) ? facts.outcomeGates : [];
  const gate = gates.find((candidate) => !candidate.kind || candidate.kind === "integration") || null;
  return { gate_report_present: Boolean(gate), gate_check_passes: gate ? gatePasses(gate) : false };
}

// advisory_review (read-only): advisory evidence posted AND every blocking finding
// triaged (the advisory gate resolved). Same receipt-referenced gate source.
function advisoryReviewEvidence(facts, orcaTrusted) {
  if (!orcaTrusted) return { advisory_evidence_posted: null, blocking_findings_triaged: null };
  const gates = Array.isArray(facts.outcomeGates) ? facts.outcomeGates : [];
  const gate = gates.find((candidate) => candidate.kind === "advisory") || gates[0] || null;
  return { advisory_evidence_posted: Boolean(gate), blocking_findings_triaged: gate ? gatePasses(gate) : false };
}

// tracker_reconciliation (read-only): the mapped relay run's tracker issue state is
// reconciled against the durable manifest — a terminal manifest with its issue closed.
function trackerReconciliationEvidence(facts) {
  const { manifest, issue } = facts;
  if (!manifest || !issue) return { tracker_reconciled: null };
  return { tracker_reconciled: isTerminalManifestState(manifest.state) && issue.state === "CLOSED" };
}

// Dispatch to the kind's evidence contract. Unknown kinds fall back to relay_run so
// no outcome is ever unclassifiable (plan already rejects unsupported kinds).
function computeEvidence(facts, orcaTrusted) {
  switch (facts.receiptTask.kind) {
    case "relay_fleet":
      return relayFleetEvidence(facts);
    case "integration_gate":
      return integrationGateEvidence(facts, orcaTrusted);
    case "advisory_review":
      return advisoryReviewEvidence(facts, orcaTrusted);
    case "tracker_reconciliation":
      return trackerReconciliationEvidence(facts);
    case "relay_run":
    default:
      return relayRunEvidence(facts);
  }
}

function isComplete(evidence) {
  const keys = Object.keys(evidence);
  return keys.length > 0 && keys.every((key) => evidence[key] === true);
}

// Every subprocess-derived value that reaches a diagnostic — inside `message` AND
// inside `ids` — is bounded (≤256 chars, marker included) so a wedged/adversarial CLI
// can never inflate or line-inject the status report (D7).
function diag(code, outcomeId, message, ids) {
  return { code, outcome_id: outcomeId ?? null, message: boundedExcerpt(message), ids: boundedIds(ids) };
}

// A dispatch is "missing" only when dispatch-show actually REPORTED (reachable) yet
// returned no dispatch id — never when the read itself failed transiently. A failed
// dispatch-show leaves `dispatchId` undefined AND `reachable` false, so gating on
// `reachable` avoids a false MISSING_DISPATCH on a flaky/timed-out read (mirrors the
// strict `terminalPresent === false` check used for MISSING_TERMINAL).
function dispatchMissing(orcaTrusted, receiptTask, dispatch) {
  return Boolean(orcaTrusted && receiptTask.dispatch_id && dispatch && dispatch.reachable && !dispatch.dispatchId);
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
  if (dispatchMissing(orcaTrusted, receiptTask, dispatch)) {
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

// A relay manifest in a terminal state that is NOT a merge (`closed`) is a
// force-closed / abandoned run. It can never yield completion evidence again, so it
// must surface as `escalated` rather than falling through to `running` (D5). The
// merge-happy terminal (`merged`) is handled by the completion + PR/issue detectors.
function isAbandonedManifest(manifest) {
  return Boolean(manifest && manifest.state === "closed");
}

function outcomeState(facts, evidence, complete, flags, orcaTrusted, isDuplicate) {
  const { manifest, receiptTask, orcaTaskMissing, dispatch, mappedRunMissing, gateBlocking } = facts;
  if (flags.staleWorkerDone || flags.issueReopened || flags.prChanged || isDuplicate) return "inconsistent";
  if (complete) return "complete_with_evidence";
  if (manifest && (isEscalatedManifestState(manifest.state) || isAbandonedManifest(manifest))) return "escalated";
  if (gateBlocking) return "awaiting_decision";
  const terminalMissing = orcaTrusted && receiptTask.assignee && dispatch && dispatch.terminalPresent === false;
  const runtimeMappingBroken = orcaTrusted && (orcaTaskMissing || dispatchMissing(orcaTrusted, receiptTask, dispatch) || terminalMissing);
  const orcaUnavailable = !orcaTrusted && Boolean(receiptTask.orca_task_id);
  if (mappedRunMissing || runtimeMappingBroken || orcaUnavailable) return "stale_missing";
  return "running";
}

// Classify one outcome. `facts` is the gathered fact bundle; `orcaTrusted` is false
// when the runtime is a mismatch / foreign / unreachable (Orca facts degrade to
// stale_missing per D6). `isDuplicate` marks outcomes sharing a mapping (D7).
function classifyOutcome(facts, { orcaTrusted, isDuplicate }) {
  const { receiptTask } = facts;
  const evidence = computeEvidence(facts, orcaTrusted);
  const complete = isComplete(evidence);
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
  EVIDENCE_CONTRACTS,
  requiredEvidenceFor,
  computeEvidence,
  classifyOutcome,
  deriveProgramState,
};
