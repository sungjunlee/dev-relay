const { applyReviewAssurancePolicy } = require("./assurance");
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

function applyPassEquivalentGates(verdict, {
  advisoryResult,
  disallowPassReason,
  executionStatus,
  hardenedAssurance,
  internalReview,
  manualReviewReason,
  reviewFile,
}) {
  const passNextActions = passNextActionsFor(internalReview);
  let confidenceDowngrade = buildConfidenceDowngrade(verdict);
  let gateVerdict = confidenceDowngrade.applied
    ? buildLowConfidencePassGateVerdict(verdict, passNextActions)
    : verdict;

  gateVerdict = applyReviewAssurancePolicy(gateVerdict, {
    advisoryResult,
    hardenedAssurance,
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
    confidenceDowngrade = buildConfidenceDowngrade(verdict);
  }
  validateReviewVerdict(verdict, { passNextActions, disallowPassReason });

  return { confidenceDowngrade, verdict };
}

module.exports = { applyPassEquivalentGates };
