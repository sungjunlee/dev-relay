"use strict";

const fs = require("fs");
const {
  reapAdvisoryLaneLeases,
} = require("../../../relay-dispatch/scripts/run-runtime-state");
const { writeJson } = require("./common");

function matchRoundReviewer(round, reviewer) {
  return (entry) => {
    const entryRound = entry.lease?.round ?? entry.round;
    const entryReviewer = entry.lease?.reviewer ?? entry.reviewer;
    return Number(entryRound) === Number(round) && String(entryReviewer) === String(reviewer);
  };
}

/**
 * Reap every live (or stale) lane lease for a (round, reviewer) before spawning
 * a new attempt. Host-mismatch leases are skipped+reported without blocking.
 */
function reapPriorAdvisoryLaneAttempts({
  runDir,
  round,
  reviewer,
  dryRun = false,
  graceMs,
  host,
} = {}) {
  if (!runDir || !Number.isInteger(Number(round)) || !reviewer) return [];
  return reapAdvisoryLaneLeases({
    runDir,
    dryRun,
    graceMs,
    host,
    match: matchRoundReviewer(round, reviewer),
  });
}

// Outcome-class precedence for the primary `lane_reap` field. Within a class,
// the last matching entry wins (leases arrive attempt-ascending → newest attempt).
const LANE_REAP_PRIMARY_PRECEDENCE = [
  ["reap_failed"],
  ["reaped", "would_reap"],
  ["stale", "would_remove_stale", "skipped_pid_reuse", "would_skip_pid_reuse"],
  ["corrupt", "would_remove_corrupt"],
  ["skipped_host_mismatch"],
];

function selectPrimaryLaneReapOutcome(outcomes) {
  for (const classOutcomes of LANE_REAP_PRIMARY_PRECEDENCE) {
    const classSet = new Set(classOutcomes);
    let last = null;
    for (const entry of outcomes) {
      if (classSet.has(entry?.outcome)) last = entry;
    }
    if (last) return last;
  }
  return outcomes[outcomes.length - 1];
}

function buildLaneReapField(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    return { outcome: "stale", pgid: null };
  }
  const primary = selectPrimaryLaneReapOutcome(outcomes);
  const field = {
    outcome: primary.outcome,
    pgid: primary.pgid ?? null,
  };
  if (primary.signaled_kill === true) field.signaled_kill = true;
  if (primary.signaled_kill === false) field.signaled_kill = false;
  if (outcomes.length > 1) field.all = outcomes;
  return field;
}

/**
 * After the runner consumes a settled `status: "timeout"` lane result, reap that
 * lane's lease-recorded pgid (wait for worker pid first), then record the outcome
 * onto the lane result artifact as `lane_reap`.
 */
function reapTimeoutAdvisoryLane({
  runDir,
  round,
  reviewer,
  resultPath = null,
  result = null,
  dryRun = false,
  graceMs,
  host,
  workerExitWaitMs,
} = {}) {
  const outcomes = reapAdvisoryLaneLeases({
    runDir,
    dryRun,
    graceMs,
    host,
    match: matchRoundReviewer(round, reviewer),
    waitForWorkerPid: true,
    workerExitWaitMs,
  });
  const laneReap = buildLaneReapField(outcomes);
  let nextResult = result;
  if (resultPath && typeof resultPath === "string") {
    try {
      const existing = nextResult && typeof nextResult === "object"
        ? nextResult
        : JSON.parse(fs.readFileSync(resultPath, "utf-8"));
      nextResult = { ...existing, lane_reap: laneReap };
      if (!dryRun) {
        // Same atomic publish as the worker: settlement readers must never see
        // this artifact truncated mid-patch.
        writeJson(resultPath, nextResult);
      }
    } catch {
      // Best-effort: reap still happened even if the artifact cannot be patched.
      if (nextResult && typeof nextResult === "object") {
        nextResult = { ...nextResult, lane_reap: laneReap };
      }
    }
  } else if (nextResult && typeof nextResult === "object") {
    nextResult = { ...nextResult, lane_reap: laneReap };
  }
  return { outcomes, laneReap, result: nextResult };
}

module.exports = {
  buildLaneReapField,
  matchRoundReviewer,
  reapPriorAdvisoryLaneAttempts,
  reapTimeoutAdvisoryLane,
};
