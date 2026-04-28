const { STATES, forceTransitionState } = require("../../../relay-dispatch/scripts/manifest/lifecycle");
const { writeManifest } = require("../../../relay-dispatch/scripts/manifest/store");
const { appendRunEvent, EVENTS } = require("../../../relay-dispatch/scripts/relay-events");
const { resolveReviewerName } = require("./reviewer-invoke");

function maybeSwapReviewer(data, reviewerArg, body, manifestPath, runRepoPath) {
  if (data.state !== STATES.ESCALATED) return data;
  if (!reviewerArg) return data;

  const newReviewerName = resolveReviewerName(data, reviewerArg);
  const lastReviewer = data.review?.last_reviewer || null;
  if (newReviewerName === lastReviewer) {
    throw new Error(
      `Reviewer-swap requires a different reviewer; --reviewer '${newReviewerName}' matches review.last_reviewer. ` +
      "Pass a different adapter (e.g., --reviewer claude) or close the run."
    );
  }

  const swappedManifest = forceTransitionState(data, STATES.REVIEW_PENDING, "run_review");
  swappedManifest.review = {
    ...(swappedManifest.review || {}),
    reviewer_swap_count: Number(data.review?.reviewer_swap_count || 0) + 1,
  };
  writeManifest(manifestPath, swappedManifest, body);
  appendRunEvent(runRepoPath, data.run_id, {
    event: EVENTS.REVIEWER_SWAP,
    state_from: STATES.ESCALATED,
    state_to: STATES.REVIEW_PENDING,
    from_reviewer: lastReviewer,
    to_reviewer: newReviewerName,
    reviewer_swap_count: swappedManifest.review.reviewer_swap_count,
  });
  return swappedManifest;
}

module.exports = { maybeSwapReviewer };
