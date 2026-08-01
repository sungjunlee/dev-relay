const path = require("path");
const {
  buildReviewRunnerRubricGateFailure,
} = require("../../../relay-dispatch/scripts/manifest/rubric");
const {
  computeFactorStatusFlips,
  computeRepeatedIssueCount,
  decideFlipFlopEscalation,
  summarizeLineage,
  toEscalatedVerdict,
} = require("./redispatch");

function analyzeVerdict({
  data,
  internalReview,
  primaryReviewerVerdict,
  round,
  rubricLoad,
  runDir,
  verdict,
}) {
  const reviewerVerdict = primaryReviewerVerdict || verdict;
  let analysisVerdict = verdict;
  const blockingChangesRequested = verdict.verdict === "changes_requested";
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
  return {
    analysisVerdict,
    blockingChangesRequested,
    escalationDecision,
    factorFlips,
    lineageSummary,
    repeatedIssueCount,
    rubricGateFailure,
    substantiveFailure,
    reviewerVerdict,
    verdict,
  };
}

module.exports = { analyzeVerdict };
