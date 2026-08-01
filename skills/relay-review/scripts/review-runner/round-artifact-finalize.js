const path = require("path");
const { writeText } = require("./common");
const {
  buildRedispatchPrompt,
  buildRubricGateRedispatchPrompt,
} = require("./redispatch");
const {
  buildConvergenceSummary,
  formatConvergenceMarkdown,
} = require("./convergence");

function buildRelayEscalationAudit({
  appliedVerdict,
  escalationDecision,
  persistedRubricGateFailure,
  reviewerVerdict,
  verdict,
}) {
  if (
    persistedRubricGateFailure
    || appliedVerdict !== "escalated"
    || verdict.verdict !== "escalated"
    || reviewerVerdict.verdict === "escalated"
  ) {
    return null;
  }
  return {
    ...escalationDecision,
    summary: verdict.summary,
  };
}

function persistVerdictArtifacts(context, analysis) {
  const {
    churnGrowth,
    doneCriteria,
    doneCriteriaSource,
    reviewedHeadSha,
    round,
    runDir,
  } = context;
  const {
    analysisVerdict,
    escalationDecision,
    factorFlips,
    repeatedIssueCount,
    reviewerVerdict,
    rubricGateFailure,
  } = analysis;
  const convergenceSummary = buildConvergenceSummary({
    runDir,
    round,
    verdict: analysisVerdict,
    factorFlips,
    repeatedIssueCount,
  });
  if (convergenceSummary) {
    writeText(
      path.join(runDir, `review-round-${round}-convergence.md`),
      `${formatConvergenceMarkdown(convergenceSummary)}\n`
    );
  }

  const appliedVerdict = analysis.verdict.verdict === "escalated"
    ? "escalated"
    : rubricGateFailure
      ? "changes_requested"
      : analysis.verdict.verdict;
  const persistedRubricGateFailure = rubricGateFailure;
  const relayEscalation = buildRelayEscalationAudit({
    appliedVerdict,
    escalationDecision,
    persistedRubricGateFailure,
    reviewerVerdict,
    verdict: analysis.verdict,
  });
  const verdictPath = path.join(runDir, `review-round-${round}-verdict.json`);
  const verdictRecord = persistedRubricGateFailure
    ? {
      ...reviewerVerdict,
      applied_verdict: appliedVerdict,
      relay_gate: {
        status: persistedRubricGateFailure.status,
        layer: persistedRubricGateFailure.layer,
        rubric_state: persistedRubricGateFailure.rubricState,
        rubric_status: persistedRubricGateFailure.rubricStatus,
        reason: persistedRubricGateFailure.reason,
        recovery_command: persistedRubricGateFailure.recoveryCommand,
        recovery: persistedRubricGateFailure.recovery,
      },
    }
    : {
      ...analysis.verdict,
      applied_verdict: appliedVerdict,
      ...(relayEscalation
        ? {
          original_reviewer_verdict: reviewerVerdict,
          relay_escalation: relayEscalation,
        }
        : {}),
    };
  writeText(verdictPath, `${JSON.stringify(verdictRecord, null, 2)}\n`);

  let redispatchPath = null;
  if (
    analysis.verdict.verdict !== "escalated"
    && (
      (
        analysis.verdict.verdict === "changes_requested"
      )
      || persistedRubricGateFailure
    )
  ) {
    redispatchPath = path.join(runDir, `review-round-${round}-redispatch.md`);
    const redispatchPrompt = persistedRubricGateFailure
      ? buildRubricGateRedispatchPrompt(
        persistedRubricGateFailure,
        doneCriteria,
        doneCriteriaSource,
        convergenceSummary
      )
      : buildRedispatchPrompt(
        analysis.verdict,
        doneCriteria,
        runDir,
        round,
        churnGrowth,
        doneCriteriaSource,
        reviewedHeadSha,
        convergenceSummary,
      );
    writeText(redispatchPath, `${redispatchPrompt}\n`);
  }

  return {
    appliedVerdict,
    convergenceSummary,
    redispatchPath,
    relayEscalation,
    rubricGateFailure: persistedRubricGateFailure,
    verdictPath,
  };
}

module.exports = { persistVerdictArtifacts };
