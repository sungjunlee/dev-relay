const { STATES } = require("../../../relay-dispatch/scripts/manifest/lifecycle");
const { classifyPostDecisionPhase } = require("../../../relay-dispatch/scripts/advisory-timing");
const { assertRelayPolicyGate } = require("../../../relay-dispatch/scripts/relay-policy-gate");
const { buildAdvisoryPrompt } = require("./advisory-prompt");
const {
  finishAdvisoryReview,
  buildAdvisoryReviewerPolicy,
  parseNonNegativeSeconds,
  parsePositiveSeconds,
  resolveAdvisoryModel,
  startAdvisoryReview,
  validateAdvisoryProfile,
  writeAdvisoryDecision,
} = require("./advisory");

const HARDENED_EVENT_BINDING_WAIT_MS = 1000;

function resolveAdvisoryConfig({
  advisoryGraceArg,
  advisoryProfileArg,
  advisoryReviewerArg,
  advisoryReviewerModel,
  advisoryTimeoutArg,
  data,
  routePlan = null,
}) {
  const planned = routePlan?.phases?.advisory_review && typeof routePlan.phases.advisory_review === "object"
    ? routePlan.phases.advisory_review
    : {};
  const routed = data?.routing?.selected?.advisory_review && typeof data.routing.selected.advisory_review === "object"
    ? data.routing.selected.advisory_review
    : {};
  const reviewer = advisoryReviewerArg || planned.reviewer || routed.reviewer || null;
  if (!reviewer && (advisoryProfileArg || advisoryReviewerModel || advisoryTimeoutArg || advisoryGraceArg)) {
    throw new Error("--advisory-reviewer is required when advisory options are supplied and no manifest routing advisory reviewer is selected");
  }
  return {
    graceSeconds: reviewer ? parseNonNegativeSeconds(advisoryGraceArg) : null,
    model: reviewer ? (advisoryReviewerModel || planned.model || routed.model || routed.reviewer_model || null) : null,
    profile: reviewer ? validateAdvisoryProfile(advisoryProfileArg || planned.profile || routed.profile || "blindspot") : null,
    reviewer,
    source: reviewer ? (advisoryReviewerArg ? "cli" : planned.reviewer ? "route_plan" : "routing") : null,
    timeoutSeconds: reviewer ? parsePositiveSeconds(advisoryTimeoutArg) : null,
  };
}

function startConfiguredAdvisory({
  branch,
  config,
  data,
  diffText,
  doneCriteria,
  doneCriteriaSource,
  issueNumber,
  prNumber,
  reviewedHeadSha,
  reviewRepoPath,
  round,
  rubricLoad,
  runDir,
  runRepoPath,
}) {
  if (!config.reviewer) return { advisoryRun: null, resultAdvisory: undefined };
  const advisoryModel = resolveAdvisoryModel(data, config.reviewer, config.model);
  const reviewerPolicy = buildAdvisoryReviewerPolicy(config.reviewer);
  let policyDecision;
  try {
    policyDecision = assertRelayPolicyGate({
      repoRoot: runRepoPath,
      phase: "advisory_review",
      reviewer: config.reviewer,
      model: advisoryModel,
    });
  } catch (error) {
    error.adapterCapability = reviewerPolicy;
    throw error;
  }
  const promptText = buildAdvisoryPrompt({
    branch,
    diffText,
    doneCriteria,
    doneCriteriaSource,
    issueNumber,
    prNumber,
    profile: config.profile,
    round,
    rubricLoad,
  });
  const advisoryRun = startAdvisoryReview({
    headSha: reviewedHeadSha,
    profile: config.profile,
    promptText,
    reviewerModel: advisoryModel,
    reviewerName: config.reviewer,
    reviewerPolicy,
    policyDecision,
    reviewRepoPath,
    round,
    runDir,
    runId: data.run_id,
    runRepoPath,
    state: data.state,
    timeoutSeconds: config.timeoutSeconds,
  });
  return {
    advisoryRun,
    resultAdvisory: {
      profile: config.profile,
      reviewer: config.reviewer,
      source: config.source,
      status: "running",
      policy_decision: policyDecision,
    },
  };
}

async function settleAdvisoryForVerdict({ advisoryRun, config, hardenedAssurance, verdict }) {
  if (!advisoryRun) return { advisoryResult: null, resultAdvisory: undefined };
  const waitStartedAt = Date.now();
  const waitMs = hardenedAssurance ? config.timeoutSeconds * 1000 : config.graceSeconds * 1000;
  const decisionState = verdict.verdict === "changes_requested" ? STATES.CHANGES_REQUESTED : STATES.READY_TO_MERGE;
  let advisoryResult = await finishAdvisoryReview({
    advisoryRun,
    consumedByPhase: "review",
    criticalPathWaitMs: 0,
    waitMs,
  });
  const criticalPathWaitMs = Date.now() - waitStartedAt;
  if (advisoryResult?.status === "deferred") {
    const consumedByPhase = classifyPostDecisionPhase(decisionState);
    writeAdvisoryDecision(advisoryRun, {
      consumedByPhase,
      criticalPathWaitMs,
      nextState: decisionState,
      phaseDecisionWaited: criticalPathWaitMs > 0,
    });
    advisoryResult = {
      ...advisoryResult,
      consumedByPhase,
      criticalPathWaitMs,
      phaseDecisionWaited: criticalPathWaitMs > 0,
    };
  } else {
    writeAdvisoryDecision(advisoryRun, {
      consumedByPhase: "review",
      criticalPathWaitMs,
      nextState: decisionState,
      phaseDecisionWaited: criticalPathWaitMs > 0,
    });
    advisoryResult = {
      ...advisoryResult,
      consumedByPhase: "review",
      criticalPathWaitMs,
      phaseDecisionWaited: criticalPathWaitMs > 0,
    };
  }
  if (hardenedAssurance && advisoryResult?.status === "success") {
    advisoryResult = await finishAdvisoryReview({
      advisoryRun,
      consumedByPhase: "review",
      criticalPathWaitMs,
      requireEventBoundSuccess: true,
      waitMs: HARDENED_EVENT_BINDING_WAIT_MS,
    });
    advisoryResult = {
      ...advisoryResult,
      consumedByPhase: "review",
      criticalPathWaitMs,
      phaseDecisionWaited: criticalPathWaitMs > 0,
    };
  }
  return {
    advisoryResult,
    resultAdvisory: { ...advisoryResult, source: config.source },
  };
}

module.exports = {
  resolveAdvisoryConfig,
  settleAdvisoryForVerdict,
  startConfiguredAdvisory,
};
