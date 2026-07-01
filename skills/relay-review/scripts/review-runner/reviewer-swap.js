const { STATES, forceTransitionState } = require("../../../relay-dispatch/scripts/manifest/lifecycle");
const { writeManifest } = require("../../../relay-dispatch/scripts/manifest/store");
const { appendRunEvent, EVENTS } = require("../../../relay-dispatch/scripts/relay-events");
const { resolveReviewerName } = require("./reviewer-invoke");

function maybeSwapReviewer(data, reviewerArg, body, manifestPath, runRepoPath, options = {}) {
  if (data.state !== STATES.ESCALATED) return data;
  if (!reviewerArg) return data;

  const newReviewerName = resolveReviewerName(data, reviewerArg);
  const lastReviewer = data.review?.last_reviewer || null;
  const independentReviewReason = String(options.independentReviewReason || "").trim();
  if (newReviewerName === lastReviewer && !independentReviewReason) {
    throw new Error(
      `Independent review attempt requires evidence; --reviewer '${newReviewerName}' matches review.last_reviewer. ` +
      "Pass a different adapter, or provide --independent-review-reason <text> for a same-adapter fresh-context attempt."
    );
  }
  const reason = independentReviewReason || `different_reviewer:${lastReviewer || "unknown"}->${newReviewerName}`;

  // Delayed-publication runs with no PR yet must retry the retained worktree, not a public PR review.
  const prePublicationReview = !data.git?.pr_number && data.dispatch?.publish_policy === "after-internal-review";
  const targetState = prePublicationReview ? STATES.INTERNAL_REVIEW_PENDING : STATES.REVIEW_PENDING;
  const nextAction = prePublicationReview ? "run_internal_review" : "run_review";
  const swappedManifest = forceTransitionState(data, targetState, nextAction);
  swappedManifest.review = {
    ...(swappedManifest.review || {}),
    reviewer_swap_count: Number(data.review?.reviewer_swap_count || 0) + 1,
  };
  writeManifest(manifestPath, swappedManifest, body);
  appendRunEvent(runRepoPath, data.run_id, {
    event: EVENTS.REVIEWER_SWAP,
    state_from: STATES.ESCALATED,
    state_to: targetState,
    from_reviewer: lastReviewer,
    to_reviewer: newReviewerName,
    reason,
    reviewer_swap_count: swappedManifest.review.reviewer_swap_count,
  });
  return swappedManifest;
}

module.exports = { maybeSwapReviewer };
