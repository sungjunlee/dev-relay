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

function normalizeRubricGateFailure(rubricGateFailure, appliedVerdict) {
  if (!rubricGateFailure || appliedVerdict !== "escalated") {
    return rubricGateFailure;
  }

  const recovery = (
    "Automatic rubric repair re-dispatch is unavailable because the run exhausted "
    + "its substantive failure budget and escalated. Inspect the review failure; "
    + "continuation requires an explicit owner decision through the documented "
    + "review-policy extension and escalated-state recovery paths."
  );
  return {
    ...rubricGateFailure,
    recoveryCommand: null,
    recovery,
    summary: `review-runner fail-closed: the rubric gate exhausted the repair budget. ${recovery}`,
  };
}

function persistVerdictArtifacts(context, analysis) {
  const {
    advisoryResults,
    churnGrowth,
    doneCriteria,
    doneCriteriaSource,
    hardenedAssurance,
    reviewedHeadSha,
    round,
    runDir,
  } = context;
  const {
    analysisVerdict,
    assuranceMetadata,
    confidenceDowngradeApplied,
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

  const confidenceDowngradeAppliedAsFinalPass = (
    confidenceDowngradeApplied
    && !rubricGateFailure
  );
  const appliedVerdict = analysis.verdict.verdict === "escalated"
    ? "escalated"
    : rubricGateFailure
      ? "changes_requested"
      : confidenceDowngradeAppliedAsFinalPass
        ? "pass"
        : analysis.verdict.verdict;
  const persistedRubricGateFailure = normalizeRubricGateFailure(
    rubricGateFailure,
    appliedVerdict
  );
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
    : { ...reviewerVerdict, applied_verdict: appliedVerdict };
  writeText(verdictPath, `${JSON.stringify(verdictRecord, null, 2)}\n`);

  let redispatchPath = null;
  if (
    analysis.verdict.verdict !== "escalated"
    && (
      (
        analysis.verdict.verdict === "changes_requested"
        && !confidenceDowngradeAppliedAsFinalPass
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
        { advisoryResults, assuranceMetadata, hardenedAssurance }
      );
    writeText(redispatchPath, `${redispatchPrompt}\n`);
  }

  return {
    appliedVerdict,
    confidenceDowngradeAppliedAsFinalPass,
    convergenceSummary,
    redispatchPath,
    rubricGateFailure: persistedRubricGateFailure,
    verdictPath,
  };
}

module.exports = { persistVerdictArtifacts };
