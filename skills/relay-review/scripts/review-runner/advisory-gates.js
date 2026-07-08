const { applyPassEquivalentGates } = require("./confidence-downgrade");
const {
  appendAdvisoryRunsForTrigger,
  createAdvisorySettlementDeadline,
  settleConfiguredAdvisories,
} = require("./advisory-orchestration");

async function settleAdvisoryGatesForRound({
  advisoryConfig,
  advisoryRuns,
  currentState,
  executionStatus,
  hardenedAssurance,
  internalReview,
  laneDemotionCount = 0,
  manualReviewReason,
  prSignalsPassBlockReason,
  result,
  reviewFile,
  startOptions,
  verdict,
}) {
  const advisoryLanes = advisoryConfig.lanes || [];
  const everyRoundLaneCount = advisoryLanes.filter((lane) => lane.trigger === "every_round").length;
  const settlementDeadlineMs = advisoryLanes.length
    ? createAdvisorySettlementDeadline({ config: advisoryConfig, hardenedAssurance })
    : null;
  let advisoryResult = null;
  let advisoryResults = [];

  ({ advisoryResult, advisoryResults } = await settleConfiguredAdvisories({
    advisoryRuns: advisoryRuns.filter((run) => run.trigger === "every_round"),
    config: advisoryConfig,
    currentState,
    hardenedAssurance,
    result,
    settlementDeadlineMs,
    verdict,
  }));
  let gateResult = applyPassEquivalentGates(verdict, {
    advisoryResult,
    advisoryResults,
    disallowPassReason: prSignalsPassBlockReason,
    executionStatus,
    expectedAdvisoryCount: everyRoundLaneCount,
    hardenedAssurance,
    internalReview,
    laneDemotionCount,
    manualReviewReason,
    reviewFile,
  });

  if (gateResult.passEquivalentVerdict.verdict === "pass") {
    const alreadyStarted = advisoryRuns.length;
    advisoryRuns = appendAdvisoryRunsForTrigger({ advisoryRuns, result, startOptions, trigger: "on_pass" });
    const onPassRuns = advisoryRuns.slice(alreadyStarted).filter((run) => run.trigger === "on_pass");
    if (onPassRuns.length) {
      ({ advisoryResult, advisoryResults } = await settleConfiguredAdvisories({
        advisoryRuns: onPassRuns,
        config: advisoryConfig,
        currentState,
        hardenedAssurance,
        priorAdvisoryResults: advisoryResults,
        result,
        settlementDeadlineMs,
        verdict: gateResult.passEquivalentVerdict,
      }));
      gateResult = applyPassEquivalentGates(verdict, {
        advisoryResult,
        advisoryResults,
        disallowPassReason: prSignalsPassBlockReason,
        executionStatus,
        expectedAdvisoryCount: advisoryLanes.length,
        hardenedAssurance,
        internalReview,
        laneDemotionCount,
        manualReviewReason,
        reviewFile,
      });
    }
  }

  return {
    advisoryResult,
    advisoryResults,
    advisoryRuns,
    gateResult,
    verdict: gateResult.verdict,
  };
}

module.exports = { settleAdvisoryGatesForRound };
