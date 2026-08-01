const {
  readManifest,
  withManifestTransaction,
  writeManifestUnlocked,
} = require("../../../relay-dispatch/scripts/manifest/store");
const {
  appendIterationScore,
  appendRunEvent,
  EVENTS,
} = require("../../../relay-dispatch/scripts/relay-events");
const { applyReviewerIdentity } = require("./context");
const { buildCommentBody, postComment } = require("./comment");
const { toIterationScoreEventEntry } = require("./score-utils");
const { applyVerdictToManifest } = require("./manifest-apply");
const { applyPendingChecksMarker } = require("./check-wait");

function persistManifestAndEvents(context, analysis, artifacts) {
  const {
    body,
    checkWait,
    data,
    manifestPath,
    manualReviewReason,
    noComment,
    prNumber,
    result,
    reviewedHeadSha,
    reviewerName,
    round,
    runRepoPath,
    internalReview,
  } = context;
  const {
    blockingChangesRequested,
    escalationDecision,
    lineageSummary,
    repeatedIssueCount,
    reviewerVerdict,
    substantiveFailure,
    verdict,
  } = analysis;
  const {
    appliedVerdict,
    relayEscalation,
    rubricGateFailure,
  } = artifacts;

  const commentVerdict = rubricGateFailure ? reviewerVerdict : verdict;
  const commentBody = buildCommentBody(commentVerdict, round, {
    appliedVerdict,
    gateFailure: rubricGateFailure,
    originalReviewerVerdict: reviewerVerdict,
    relayEscalation,
    warnings: result.reviewWarnings || [],
  });
  if (!noComment && !internalReview) {
    postComment(runRepoPath, prNumber, commentBody);
    result.commentPosted = true;
  }

  let updatedManifest = applyVerdictToManifest(
    data,
    verdict,
    round,
    prNumber,
    reviewedHeadSha,
    repeatedIssueCount,
    {
      rubricGateFailure,
      escalationDecision,
      lineageSummary: escalationDecision.lineage_summary || lineageSummary,
      reviewPhase: internalReview ? "internal" : "post_publication",
      substantiveFailure,
    }
  );
  updatedManifest = {
    ...updatedManifest,
    review: {
      ...(updatedManifest.review || {}),
      last_reviewer: reviewerName,
      ...(manualReviewReason ? { manual_review_reason: manualReviewReason } : {}),
    },
  };
  updatedManifest.review = applyPendingChecksMarker(updatedManifest.review, {
    appliedVerdict,
    checkWait,
    reviewedHeadSha,
    round,
  });
  updatedManifest = applyReviewerIdentity(
    updatedManifest,
    noComment || internalReview,
    runRepoPath
  );
  withManifestTransaction(manifestPath, () => {
    readManifest(manifestPath);
    writeManifestUnlocked(manifestPath, updatedManifest, body);
  });
  appendRunEvent(runRepoPath, data.run_id, {
    event: EVENTS.ESCALATION_DECISION,
    state_from: data.state,
    state_to: updatedManifest.state,
    head_sha: reviewedHeadSha,
    ...escalationDecision,
  });

  const reviewApplyReason = rubricGateFailure
    ? rubricGateFailure.status
    : verdict.verdict;
  appendRunEvent(runRepoPath, data.run_id, {
    event: EVENTS.REVIEW_APPLY,
    state_from: data.state,
    state_to: updatedManifest.state,
    head_sha: reviewedHeadSha,
    round,
    reviewer: reviewerName,
    reason: reviewApplyReason,
    lineage_summary: escalationDecision.lineage_summary || lineageSummary,
  });
  if (Array.isArray(verdict.rubric_scores) && verdict.rubric_scores.length > 0) {
    appendIterationScore(runRepoPath, data.run_id, {
      round,
      scores: verdict.rubric_scores.map(toIterationScoreEventEntry),
    });
  }
  return { updatedManifest };
}

module.exports = { persistManifestAndEvents };
