const { applyReviewAssurancePolicy, getReviewAssuranceMetadata } = require("./assurance");
const {
  buildExecutionEvidenceFailureVerdict,
  buildMissingExecutionEvidenceVerdict,
} = require("./execution-evidence");
const { passNextActionsFor } = require("./round-artifacts");
const {
  buildConfidenceDowngrade,
  buildLowConfidencePassGateVerdict,
  validateReviewVerdict,
} = require("./verdict");

function isLaneDrivenDemotion(verdict) {
  const metadata = getReviewAssuranceMetadata(verdict);
  return metadata?.reason === "lane_required_findings" || metadata?.reason === "lane_demotion_cap";
}

function applyPassEquivalentGates(verdict, {
  advisoryResult,
  advisoryResults,
  disallowPassReason,
  executionStatus,
  expectedAdvisoryCount = null,
  hardenedAssurance,
  internalReview,
  laneDemotionCount = 0,
  manualReviewReason,
  reviewFile,
}) {
  const passNextActions = passNextActionsFor(internalReview);
  const initialConfidenceDowngrade = buildConfidenceDowngrade(verdict);
  let confidenceDowngrade = initialConfidenceDowngrade;
  let gateVerdict = confidenceDowngrade.applied
    ? buildLowConfidencePassGateVerdict(verdict, passNextActions)
    : verdict;

  gateVerdict = applyReviewAssurancePolicy(gateVerdict, {
    advisoryResult,
    advisoryResults,
    expectedAdvisoryCount,
    hardenedAssurance,
    laneDemotionCount,
    manualReviewReason,
    reviewFile,
  });
  if (gateVerdict.verdict === "pass" && executionStatus.status !== "pass") {
    gateVerdict = executionStatus.status === "missing"
      ? buildMissingExecutionEvidenceVerdict(gateVerdict)
      : buildExecutionEvidenceFailureVerdict(gateVerdict);
  }
  validateReviewVerdict(gateVerdict, { passNextActions, disallowPassReason });
  if (gateVerdict.verdict !== "pass" || !confidenceDowngrade.applied) {
    verdict = gateVerdict;
    confidenceDowngrade = initialConfidenceDowngrade.applied && isLaneDrivenDemotion(gateVerdict)
      ? initialConfidenceDowngrade
      : buildConfidenceDowngrade(verdict);
  }
  validateReviewVerdict(verdict, { passNextActions, disallowPassReason });

  const passEquivalentVerdict = initialConfidenceDowngrade.applied ? gateVerdict : verdict;

  return { confidenceDowngrade, passEquivalentVerdict, verdict };
}

module.exports = { applyPassEquivalentGates };
