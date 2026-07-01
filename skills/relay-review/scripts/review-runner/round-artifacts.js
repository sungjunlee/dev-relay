const path = require("path");
const { loadRubricFromRunDir } = require("../../../relay-dispatch/scripts/manifest/rubric");
const { writeText } = require("./common");
const {
  loadDiff,
  loadDoneCriteria,
  loadPrReviewSignals,
} = require("./context");
const { buildPrompt } = require("./prompt");
const { writePrBodySnapshot } = require("./pr-body-snapshot");

function reviewPhaseFor(internalReview) {
  return internalReview ? "internal" : "post_publication";
}

function passNextActionsFor(internalReview) {
  return [internalReview ? "publish_pending" : "ready_to_merge"];
}

function writeRoundArtifacts({
  branch,
  data,
  diffFile,
  doneCriteriaFile,
  internalReview,
  issueNumber,
  prNumber,
  reviewRepoPath,
  round,
  runDir,
  runRepoPath,
}) {
  const { source: doneCriteriaSource, text: doneCriteria } = loadDoneCriteria(
    runRepoPath,
    issueNumber,
    prNumber,
    doneCriteriaFile,
    data
  );
  const diffText = loadDiff(runRepoPath, prNumber, diffFile, {
    internalReview,
    manifestData: data,
    reviewRepoPath,
  });
  const rubricLoad = loadRubricFromRunDir(runDir, data);
  const prReviewSignals = internalReview ? null : loadPrReviewSignals(runRepoPath, prNumber);
  const doneCriteriaPath = path.join(runDir, `review-round-${round}-done-criteria.md`);
  const diffPath = path.join(runDir, `review-round-${round}-diff.patch`);
  const prBodyPath = path.join(runDir, `review-round-${round}-pr-body.md`);
  const promptPath = path.join(runDir, `review-round-${round}-prompt.md`);
  const prBodySnapshot = internalReview
    ? { status: "not_available", reason: "internal_review_before_pr" }
    : writePrBodySnapshot({ repoPath: runRepoPath, runId: data.run_id, round, prNumber, prBodyPath });
  const reviewPhase = reviewPhaseFor(internalReview);
  const promptText = buildPrompt({
    round,
    prNumber,
    branch,
    issueNumber,
    doneCriteria,
    doneCriteriaSource,
    diffText,
    reviewRepoPath,
    runDir,
    rubricLoad,
    prBodyPath: internalReview ? null : prBodyPath,
    prBodySnapshot,
    reviewPhase,
    prReviewSignals,
  });
  writeText(doneCriteriaPath, `${doneCriteria}\n`);
  writeText(diffPath, `${diffText}\n`);
  writeText(promptPath, `${promptText}\n`);

  return {
    diffPath,
    diffText,
    doneCriteria,
    doneCriteriaPath,
    doneCriteriaSource,
    prBodyPath,
    prBodySnapshot,
    prReviewSignals,
    promptPath,
    reviewPhase,
    rubricLoad,
  };
}

module.exports = {
  passNextActionsFor,
  reviewPhaseFor,
  writeRoundArtifacts,
};
