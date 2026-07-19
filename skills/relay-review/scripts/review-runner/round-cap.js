const { STATES } = require("../../../relay-dispatch/scripts/manifest/lifecycle");
const { writeManifest } = require("../../../relay-dispatch/scripts/manifest/store");
const { appendRunEvent, EVENTS } = require("../../../relay-dispatch/scripts/relay-events");
const { applyPolicyViolationToManifest } = require("./manifest-apply");
const { summarizeLineage } = require("./redispatch");

const DEFAULT_MAX_REVIEW_ROUNDS = 2;

function getMaxReviewRounds(data) {
  const configured = Number(data?.review?.max_rounds);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_REVIEW_ROUNDS;
}

function shouldEscalateRepairCycle({ data, round, blocking }) {
  return Boolean(blocking) && Number(round) >= getMaxReviewRounds(data);
}

function enforceRoundCap({ body, data, manifestPath, prNumber, reviewedHeadSha, round, runRepoPath }) {
  const maxRounds = getMaxReviewRounds(data);
  if (round <= maxRounds) return;
  const previousRound = Number(data.review?.rounds || 0);
  const escalationDecision = {
    round: previousRound,
    trigger: "max_rounds",
    factors: [],
    traces: [],
    lineage_summary: summarizeLineage([]),
    decision: "escalate",
    reason: "max_rounds_exceeded",
  };
  const escalatedManifest = applyPolicyViolationToManifest(
    data,
    previousRound,
    prNumber,
    reviewedHeadSha,
    "max_rounds_exceeded",
    { escalationDecision }
  );
  writeManifest(manifestPath, escalatedManifest, body);
  appendRunEvent(runRepoPath, data.run_id, { event: EVENTS.ESCALATION_DECISION, state_from: data.state, state_to: STATES.ESCALATED, head_sha: reviewedHeadSha, ...escalationDecision });
  appendRunEvent(runRepoPath, data.run_id, {
    event: EVENTS.REVIEW_APPLY,
    state_from: data.state,
    state_to: STATES.ESCALATED,
    head_sha: reviewedHeadSha,
    round: previousRound,
    reason: "max_rounds_exceeded",
    origin: "system",
  });
  throw new Error(`Review round cap exceeded: next round ${round} would exceed max_rounds=${maxRounds}`);
}

module.exports = {
  DEFAULT_MAX_REVIEW_ROUNDS,
  enforceRoundCap,
  getMaxReviewRounds,
  shouldEscalateRepairCycle,
};
