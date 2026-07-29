const { STATES } = require("../../../relay-dispatch/scripts/manifest/lifecycle");
const { writeManifest } = require("../../../relay-dispatch/scripts/manifest/store");
const { appendRunEvent, EVENTS } = require("../../../relay-dispatch/scripts/relay-events");
const {
  DEFAULT_MAX_REVIEW_ROUNDS,
  getMaxReviewRounds,
  getReviewRoundBudget,
} = require("../../../relay-dispatch/scripts/manifest/review-budget");
const { applyPolicyViolationToManifest } = require("./manifest-apply");
const { summarizeLineage } = require("./redispatch");

function shouldEscalateRepairCycle({ data, blocking, phase }) {
  if (!blocking) return false;
  const budget = getReviewRoundBudget(data, { phase });
  return budget.substantive_failures.consumed + 1 >= budget.limit;
}

function enforceRoundCap({
  body,
  data,
  manifestPath,
  phase,
  prNumber,
  reviewedHeadSha,
  round,
  runRepoPath,
}) {
  const budget = getReviewRoundBudget(data, { phase });
  if (budget.substantive_failures.consumed < budget.limit) return budget;
  const previousRound = Number(data.review?.rounds || 0);
  const escalationDecision = {
    round: previousRound,
    trigger: "max_rounds",
    factors: [],
    traces: [],
    lineage_summary: summarizeLineage([]),
    decision: "escalate",
    reason: "max_rounds_exceeded",
    review_phase: phase,
    review_budget: budget,
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
  throw new Error(
    `Review substantive failure cap exhausted before round ${round}: `
    + `consumed=${budget.substantive_failures.consumed}, max_rounds=${budget.limit}`
  );
}

module.exports = {
  DEFAULT_MAX_REVIEW_ROUNDS,
  enforceRoundCap,
  getMaxReviewRounds,
  shouldEscalateRepairCycle,
};
