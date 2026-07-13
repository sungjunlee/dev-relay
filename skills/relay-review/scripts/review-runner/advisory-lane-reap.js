"use strict";

const fs = require("fs");
const {
  reapAdvisoryLaneLeases,
} = require("../../../relay-dispatch/scripts/run-runtime-state");

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

function buildLaneReapField(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    return { outcome: "stale", pgid: null };
  }
  const primary = outcomes[0];
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
        fs.writeFileSync(resultPath, `${JSON.stringify(nextResult, null, 2)}\n`, "utf-8");
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
