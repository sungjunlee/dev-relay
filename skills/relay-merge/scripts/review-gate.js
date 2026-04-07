const REVIEW_MARKER_PATTERN = /^\s*<!-- relay-review(?:-round)? -->\s*$/m;

function toIsoOrNull(value) {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : new Date(millis).toISOString();
}

function hasRelayReviewMarker(body) {
  return REVIEW_MARKER_PATTERN.test(String(body || ""));
}

function buildSkipComment(reason) {
  return [
    "<!-- relay-review-skip -->",
    "## Relay Review — Skipped",
    `Reason: ${reason}`,
  ].join("\n");
}

function normalizeCommentRecords(comments) {
  return (comments || []).map((comment, index) => (
    typeof comment === "string"
      ? { body: comment, author: null, createdAt: null, index }
      : {
          body: comment.body,
          author: comment.author?.login || comment.author || null,
          createdAt: toIsoOrNull(comment.createdAt),
          index,
        }
  ));
}

function extractLatestCommit(commits) {
  let latestCommit = null;
  let latestCommitAt = null;
  for (const commit of commits || []) {
    const committedAt = toIsoOrNull(commit.committedDate || commit.authoredDate);
    if (committedAt && (!latestCommitAt || committedAt > latestCommitAt)) {
      latestCommitAt = committedAt;
      latestCommit = commit.oid || null;
    }
  }
  return { latestCommit, latestCommitAt };
}

function evaluateReviewGate({ prNumber, comments, commits, manifestData, expectedReviewerLogin }) {
  const commentRecords = normalizeCommentRecords(comments);
  const { latestCommit, latestCommitAt } = extractLatestCommit(commits);

  let lastReviewComment = null;
  let hasUnauthorizedReview = false;
  for (const comment of commentRecords) {
    if (hasRelayReviewMarker(comment.body || "")) {
      if (expectedReviewerLogin && comment.author && comment.author !== expectedReviewerLogin) {
        hasUnauthorizedReview = true;
        continue;
      }
      lastReviewComment = comment;
    }
  }

  if (!lastReviewComment) {
    if (hasUnauthorizedReview) {
      return {
        status: "unauthorized_reviewer",
        pr: prNumber,
        expectedReviewerLogin,
        readyToMerge: false,
      };
    }
    return { status: "missing", pr: prNumber, readyToMerge: false };
  }

  const verdictMatch = lastReviewComment.body.match(/Verdict:\s*(LGTM|PASS|CHANGES_REQUESTED|ESCALATED)/);
  if (!verdictMatch) {
    return { status: "missing", pr: prNumber, readyToMerge: false };
  }

  const verdict = verdictMatch[1];
  if (verdict === "CHANGES_REQUESTED") {
    const issuesMatch = lastReviewComment.body.match(/Issues:\s*([\s\S]+)/);
    return {
      status: "changes_requested",
      pr: prNumber,
      issues: issuesMatch ? issuesMatch[1].trim() : null,
      readyToMerge: false,
    };
  }

  if (verdict === "ESCALATED") {
    const issuesMatch = lastReviewComment.body.match(/Issues?:\s*(.+?)(?:\n|$)/);
    return {
      status: "escalated",
      pr: prNumber,
      issues: issuesMatch ? issuesMatch[1] : null,
      readyToMerge: false,
    };
  }

  const reviewedSha = manifestData?.review?.last_reviewed_sha || null;
  if (manifestData && !reviewedSha) {
    return {
      status: "missing",
      pr: prNumber,
      readyToMerge: false,
      latestCommit,
      latestCommitAt,
    };
  }

  if (manifestData && latestCommit && reviewedSha && latestCommit !== reviewedSha) {
    return {
      status: "stale",
      pr: prNumber,
      latestCommit,
      latestCommitAt,
      reviewedAt: lastReviewComment.createdAt,
      reviewedSha,
      readyToMerge: false,
    };
  }

  if (
    !manifestData &&
    latestCommitAt &&
    lastReviewComment.createdAt &&
    lastReviewComment.createdAt < latestCommitAt
  ) {
    return {
      status: "stale",
      pr: prNumber,
      latestCommit,
      latestCommitAt,
      reviewedAt: lastReviewComment.createdAt,
      readyToMerge: false,
    };
  }

  const roundMatch = lastReviewComment.body.match(/Rounds?:\s*(\d+)/);
  return {
    status: "lgtm",
    pr: prNumber,
    round: roundMatch ? roundMatch[1] : null,
    readyToMerge: true,
    reviewedAt: lastReviewComment.createdAt,
    latestCommit,
    latestCommitAt,
    reviewedSha,
  };
}

module.exports = {
  buildSkipComment,
  evaluateReviewGate,
  hasRelayReviewMarker,
  normalizeCommentRecords,
  toIsoOrNull,
};
