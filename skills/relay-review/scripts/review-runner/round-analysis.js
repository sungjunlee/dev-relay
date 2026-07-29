const path = require("path");
const {
  buildReviewRunnerRubricGateFailure,
} = require("../../../relay-dispatch/scripts/manifest/rubric");
const {
  buildLaneCapEscalationDecision,
  getReviewAssuranceMetadata,
} = require("./assurance");
const {
  computeFactorStatusFlips,
  computeRepeatedIssueCount,
  decideFlipFlopEscalation,
  summarizeLineage,
  toEscalatedVerdict,
} = require("./redispatch");
const { shouldEscalateRepairCycle } = require("./round-cap");

function analyzeVerdict({
  data,
  gateResult,
  internalReview,
  round,
  rubricLoad,
  runDir,
  verdict,
}) {
  const confidenceDowngrade = gateResult.confidenceDowngrade;
  const assuranceMetadata = getReviewAssuranceMetadata(verdict);
  const confidenceDowngradeApplied = (
    confidenceDowngrade.applied
    && gateResult.passEquivalentVerdict.verdict === "pass"
  );
  let analysisVerdict = confidenceDowngradeApplied
    ? gateResult.passEquivalentVerdict
    : verdict;
  const blockingChangesRequested = (
    verdict.verdict === "changes_requested"
    && !confidenceDowngradeApplied
  );
  const repeatedIssueCount = blockingChangesRequested
    ? computeRepeatedIssueCount(runDir, round, analysisVerdict.issues)
    : 0;
  const lineageSummary = summarizeLineage(analysisVerdict.issues);
  let escalationDecision = {
    round,
    trigger: "none",
    factors: [],
    traces: [],
    lineage_summary: lineageSummary,
    decision: "continue",
    reason: "no_trigger",
  };

  if (assuranceMetadata?.laneCapEscalated) {
    escalationDecision = buildLaneCapEscalationDecision(
      round,
      lineageSummary,
      assuranceMetadata
    );
  }
  if (blockingChangesRequested && repeatedIssueCount >= 3) {
    verdict = toEscalatedVerdict(
      verdict,
      `Repeated identical review issues hit ${repeatedIssueCount} consecutive rounds.`
    );
    escalationDecision = {
      ...escalationDecision,
      trigger: "repeated_issues",
      decision: "escalate",
      reason: "repeated_issues",
    };
    analysisVerdict = verdict;
  }

  const factorFlips = computeFactorStatusFlips(runDir, round, analysisVerdict);
  if (factorFlips.length && escalationDecision.trigger === "none") {
    escalationDecision = {
      round,
      trigger: "flip_flop",
      ...decideFlipFlopEscalation({
        verdict: analysisVerdict,
        factorFlips,
        repeatedIssueCount,
      }),
    };
  }
  if (
    escalationDecision.decision === "escalate"
    && escalationDecision.trigger === "flip_flop"
  ) {
    verdict = toEscalatedVerdict(
      verdict,
      factorFlips.map(({ factor, trace }) => (
        `Rubric factor '${factor}' status flipped across 3 rounds `
        + `(trace: ${trace.join("→")}). Owner decision required — reviewer cannot converge autonomously.`
      )).join("; ")
    );
    analysisVerdict = verdict;
  }
  const rubricGateFailure = (
    escalationDecision.decision !== "escalate"
    && (
      verdict.verdict === "pass"
      || confidenceDowngradeApplied
    )
  )
    ? buildReviewRunnerRubricGateFailure(
      data.run_id,
      path.join(runDir, `review-round-${round}-redispatch.md`),
      rubricLoad
    )
    : null;
  const substantiveFailure = (
    blockingChangesRequested
    || Boolean(rubricGateFailure)
  );
  if (
    escalationDecision.decision !== "escalate"
    && shouldEscalateRepairCycle({
      data,
      blocking: substantiveFailure,
      phase: internalReview ? "internal" : "post_publication",
    })
  ) {
    verdict = toEscalatedVerdict(
      verdict,
      `The corrected result still has substantive review failures after ${round} independent reviews. Owner decision required.`
    );
    escalationDecision = {
      round,
      trigger: "repair_cycle_exhausted",
      factors: [],
      traces: [],
      lineage_summary: lineageSummary,
      decision: "escalate",
      reason: "repair_cycle_exhausted",
    };
    analysisVerdict = verdict;
  }

  return {
    analysisVerdict,
    assuranceMetadata,
    blockingChangesRequested,
    confidenceDowngrade,
    confidenceDowngradeApplied,
    escalationDecision,
    factorFlips,
    lineageSummary,
    repeatedIssueCount,
    rubricGateFailure,
    substantiveFailure,
    verdict,
  };
}

module.exports = { analyzeVerdict };
