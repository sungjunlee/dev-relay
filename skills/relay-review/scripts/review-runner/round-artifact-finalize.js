const path = require("path");
const { buildReviewRunnerRubricGateFailure } = require("../../../relay-dispatch/scripts/manifest/rubric");
const { writeText } = require("./common");
const {
  buildRedispatchPrompt,
  buildRubricGateRedispatchPrompt,
} = require("./redispatch");
const {
  buildConvergenceSummary,
  formatConvergenceMarkdown,
} = require("./convergence");

function persistVerdictArtifacts(context, analysis) {
  const {
    advisoryResults,
    churnGrowth,
    data,
    doneCriteria,
    doneCriteriaSource,
    hardenedAssurance,
    reviewedHeadSha,
    round,
    rubricLoad,
    runDir,
  } = context;
  const {
    analysisVerdict,
    assuranceMetadata,
    confidenceDowngradeApplied,
    factorFlips,
    repeatedIssueCount,
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

  const rubricGateRedispatchPath = path.join(
    runDir,
    `review-round-${round}-redispatch.md`
  );
  const rubricGateFailure = (
    analysis.verdict.verdict === "pass"
    || confidenceDowngradeApplied
  )
    ? buildReviewRunnerRubricGateFailure(
      data.run_id,
      rubricGateRedispatchPath,
      rubricLoad
    )
    : null;
  const confidenceDowngradeAppliedAsFinalPass = (
    confidenceDowngradeApplied
    && !rubricGateFailure
  );
  const appliedVerdict = rubricGateFailure
    ? "changes_requested"
    : confidenceDowngradeAppliedAsFinalPass
      ? "pass"
      : analysis.verdict.verdict;
  const verdictPath = path.join(runDir, `review-round-${round}-verdict.json`);
  const verdictRecord = rubricGateFailure
    ? {
      ...analysis.verdict,
      applied_verdict: appliedVerdict,
      relay_gate: {
        status: rubricGateFailure.status,
        layer: rubricGateFailure.layer,
        rubric_state: rubricGateFailure.rubricState,
        rubric_status: rubricGateFailure.rubricStatus,
        reason: rubricGateFailure.reason,
        recovery_command: rubricGateFailure.recoveryCommand,
        recovery: rubricGateFailure.recovery,
      },
    }
    : { ...analysis.verdict, applied_verdict: appliedVerdict };
  writeText(verdictPath, `${JSON.stringify(verdictRecord, null, 2)}\n`);

  let redispatchPath = null;
  if (
    (
      analysis.verdict.verdict === "changes_requested"
      && !confidenceDowngradeAppliedAsFinalPass
    )
    || rubricGateFailure
  ) {
    redispatchPath = rubricGateFailure
      ? rubricGateRedispatchPath
      : path.join(runDir, `review-round-${round}-redispatch.md`);
    const redispatchPrompt = rubricGateFailure
      ? buildRubricGateRedispatchPrompt(
        rubricGateFailure,
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
    rubricGateFailure,
    verdictPath,
  };
}

module.exports = { persistVerdictArtifacts };
