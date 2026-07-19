const { printResult } = require("./output");
const { analyzeVerdict } = require("./round-analysis");
const { persistVerdictArtifacts } = require("./round-artifact-finalize");
const { persistManifestAndEvents } = require("./round-persistence");

function finalizeRound(context) {
  const analysis = analyzeVerdict(context);
  if (analysis.assuranceMetadata) {
    context.result.reviewAssuranceDecision = analysis.assuranceMetadata;
  }
  const artifacts = persistVerdictArtifacts(context, analysis);
  const persisted = persistManifestAndEvents(context, analysis, artifacts);
  Object.assign(context.result, {
    appliedVerdict: artifacts.appliedVerdict,
    confidenceDowngrade: persisted.reportedConfidenceDowngrade,
    convergenceSummary: artifacts.convergenceSummary,
    nextState: persisted.updatedManifest.state,
    redispatchPath: artifacts.redispatchPath,
    repeatedIssueCount: analysis.repeatedIssueCount,
    lineageSummary: (
      analysis.escalationDecision.lineage_summary
      || analysis.lineageSummary
    ),
    reviewGate: artifacts.rubricGateFailure
      ? {
        layer: artifacts.rubricGateFailure.layer,
        reason: artifacts.rubricGateFailure.reason,
        recovery: artifacts.rubricGateFailure.recovery,
        recoveryCommand: artifacts.rubricGateFailure.recoveryCommand,
        rubricState: artifacts.rubricGateFailure.rubricState,
        rubricStatus: artifacts.rubricGateFailure.rubricStatus,
        status: artifacts.rubricGateFailure.status,
      }
      : null,
    state: persisted.updatedManifest.state,
    verdictPath: artifacts.verdictPath,
  });
  printResult({
    doneCriteriaPath: context.doneCriteriaPath,
    diffPath: context.diffPath,
    jsonOut: context.jsonOut,
    manifestPath: context.manifestPath,
    originalState: context.data.state,
    prepareOnly: context.prepareOnly,
    prNumber: context.prNumber,
    promptPath: context.promptPath,
    redispatchPath: artifacts.redispatchPath,
    result: context.result,
    updatedManifest: persisted.updatedManifest,
    verdictPath: artifacts.verdictPath,
  });
}

module.exports = { finalizeRound };
