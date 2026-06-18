"use strict";

const CONSUMED_BY_PHASES = Object.freeze(["none", "dispatch", "review", "redispatch", "metrics"]);
const CONSUMED_BY_PHASE_SET = new Set(CONSUMED_BY_PHASES);

function nonNegativeInteger(value, fieldName) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${fieldName} must be a non-negative finite number`);
  }
  return Math.round(number);
}

function normalizeConsumedByPhase(value, fallback = "none") {
  const phase = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!CONSUMED_BY_PHASE_SET.has(phase)) {
    throw new Error(`consumed_by_phase must be one of: ${CONSUMED_BY_PHASES.join(", ")}`);
  }
  return phase;
}

function buildArtifactTimingFields({
  elapsedMs = 0,
  criticalPathWaitMs = 0,
  consumedByPhase = "none",
  phaseDecisionWaited = false,
  frontierStepReplaced = false,
} = {}) {
  const elapsed = nonNegativeInteger(elapsedMs, "elapsed_ms");
  const fields = {
    elapsed_ms: elapsed,
    critical_path_wait_ms: nonNegativeInteger(criticalPathWaitMs, "critical_path_wait_ms"),
    consumed_by_phase: normalizeConsumedByPhase(consumedByPhase),
    phase_decision_waited: phaseDecisionWaited === true,
    frontier_step_replaced: frontierStepReplaced === true,
    advisory_elapsed_ms: elapsed,
  };
  return fields;
}

function classifyPostDecisionPhase(nextState) {
  if (nextState === "changes_requested" || nextState === "escalated") {
    return "redispatch";
  }
  if (nextState === "dispatched") {
    return "dispatch";
  }
  return "metrics";
}

function timingFieldsFromEventData(eventData = {}) {
  const fields = {};
  for (const key of [
    "advisory_elapsed_ms",
    "critical_path_wait_ms",
    "consumed_by_phase",
    "phase_decision_waited",
    "frontier_step_replaced",
  ]) {
    if (eventData[key] !== undefined) fields[key] = eventData[key];
  }
  return fields;
}

module.exports = {
  buildArtifactTimingFields,
  classifyPostDecisionPhase,
  CONSUMED_BY_PHASES,
  normalizeConsumedByPhase,
  timingFieldsFromEventData,
};
