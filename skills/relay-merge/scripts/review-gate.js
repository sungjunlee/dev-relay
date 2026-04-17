const { getRubricAnchorStatus } = require("../../relay-dispatch/scripts/relay-manifest");

const REVIEW_MARKER_PATTERN = /^\s*<!-- relay-review(?:-round)? -->\s*$/m;
const SKIP_AUDIT_RUBRIC_STATUSES = Object.freeze([
  "persisted",
  "grandfathered",
  "missing",
  "unresolved-manifest",
]);
const MISSING_SKIP_AUDIT_RUBRIC_STATUSES = new Set([
  "missing",
  "missing_path",
  "empty",
  "not_file",
  "outside_run_dir",
  "run_dir_unavailable",
  "symlink_escape",
  "follows_outside_run_dir",
  "unreadable",
]);

function toIsoOrNull(value) {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : new Date(millis).toISOString();
}

function hasRelayReviewMarker(body) {
  return REVIEW_MARKER_PATTERN.test(String(body || ""));
}

function summarizeRubricStatusForSkip(manifestData, options = {}) {
  if (!manifestData) {
    return "unresolved-manifest";
  }

  const rubricAnchor = getRubricAnchorStatus(manifestData, options.runDir ? { runDir: options.runDir } : undefined);
  if (rubricAnchor.status === "satisfied") {
    return "persisted";
  }
  if (rubricAnchor.status === "grandfathered") {
    return "grandfathered";
  }
  if (MISSING_SKIP_AUDIT_RUBRIC_STATUSES.has(rubricAnchor.status)) {
    return "missing";
  }
  return "missing";
}

function buildSkipComment(reason, rubricStatus = "unresolved-manifest") {
  return [
    "<!-- relay-review-skip -->",
    "## Relay Review — Skipped",
    `Reason: ${reason}`,
    `rubric_status: ${rubricStatus}`,
  ].join("\n");
}

function normalizeCommentRecords(comments) {
  return (comments || []).map((comment, index) => (
    typeof comment === "string"
      ? { body: comment, author: null, createdAt: null, index }
      : {
          body: comment.body,
          author: typeof comment.author === "string"
            ? comment.author
            : (comment.author?.login || null),
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

function withRubricNote(result, rubricAnchor) {
  if (!rubricAnchor) return result;
  const next = {
    ...result,
    rubricStatus: rubricAnchor.status,
  };
  if (rubricAnchor.rubricPath) {
    next.rubricPath = rubricAnchor.rubricPath;
  }
  if (rubricAnchor.resolvedPath) {
    next.rubricResolvedPath = rubricAnchor.resolvedPath;
  }
  if (rubricAnchor.note) {
    next.note = rubricAnchor.note;
  }
  if (rubricAnchor.status === "grandfathered") {
    next.rubricGrandfathered = true;
  }
  return next;
}

function buildRubricGateFailure(prNumber, rubricAnchor) {
  switch (rubricAnchor?.status) {
    case "missing_path":
      return withRubricNote({
        status: "missing_rubric_path",
        pr: prNumber,
        readyToMerge: false,
        reason: "anchor.rubric_path is required before merge unless anchor.rubric_grandfathered=true",
      }, rubricAnchor);
    case "missing":
      return withRubricNote({
        status: "missing_rubric_file",
        pr: prNumber,
        readyToMerge: false,
        reason: rubricAnchor.error,
      }, rubricAnchor);
    case "empty":
      return withRubricNote({
        status: "empty_rubric_file",
        pr: prNumber,
        readyToMerge: false,
        reason: rubricAnchor.error,
      }, rubricAnchor);
    case "outside_run_dir":
    case "follows_outside_run_dir":
    case "symlink_escape":
    case "run_dir_unavailable":
      return withRubricNote({
        status: "invalid_rubric_path",
        pr: prNumber,
        readyToMerge: false,
        reason: rubricAnchor.error,
      }, rubricAnchor);
    default:
      return withRubricNote({
        status: "invalid_rubric_file",
        pr: prNumber,
        readyToMerge: false,
        reason: rubricAnchor?.error || "anchor.rubric_path did not resolve to a readable rubric file",
      }, rubricAnchor);
  }
}

function evaluateReviewGate({ prNumber, comments, commits, manifestData, expectedReviewerLogin, runDir }) {
  const commentRecords = normalizeCommentRecords(comments);
  const { latestCommit, latestCommitAt } = extractLatestCommit(commits);
  const rubricAnchor = manifestData
    ? getRubricAnchorStatus(manifestData, runDir ? { runDir } : undefined)
    : null;

  if (manifestData && !rubricAnchor.satisfied) {
    return buildRubricGateFailure(prNumber, rubricAnchor);
  }

  let lastReviewComment = null;
  let hasUnauthorizedReview = false;
  for (const comment of commentRecords) {
    if (hasRelayReviewMarker(comment.body || "")) {
      if (expectedReviewerLogin && comment.author?.toLowerCase() !== expectedReviewerLogin.toLowerCase()) {
        hasUnauthorizedReview = true;
        continue;
      }
      lastReviewComment = comment;
    }
  }

  if (!lastReviewComment) {
    if (hasUnauthorizedReview) {
      return withRubricNote({
        status: "unauthorized_reviewer",
        pr: prNumber,
        expectedReviewerLogin,
        readyToMerge: false,
      }, rubricAnchor);
    }
    return withRubricNote({ status: "missing", pr: prNumber, readyToMerge: false }, rubricAnchor);
  }

  const verdictMatch = lastReviewComment.body.match(/Verdict:\s*(LGTM|PASS|CHANGES_REQUESTED|ESCALATED)/);
  if (!verdictMatch) {
    return withRubricNote({ status: "missing", pr: prNumber, readyToMerge: false }, rubricAnchor);
  }

  const verdict = verdictMatch[1];
  if (verdict === "CHANGES_REQUESTED") {
    const issuesMatch = lastReviewComment.body.match(/Issues:\s*([\s\S]+)/);
    return withRubricNote({
      status: "changes_requested",
      pr: prNumber,
      issues: issuesMatch ? issuesMatch[1].trim() : null,
      readyToMerge: false,
    }, rubricAnchor);
  }

  if (verdict === "ESCALATED") {
    const issuesMatch = lastReviewComment.body.match(/Issues?:\s*(.+?)(?:\n|$)/);
    return withRubricNote({
      status: "escalated",
      pr: prNumber,
      issues: issuesMatch ? issuesMatch[1] : null,
      readyToMerge: false,
    }, rubricAnchor);
  }

  const reviewedSha = manifestData?.review?.last_reviewed_sha || null;
  if (manifestData && !reviewedSha) {
    return withRubricNote({
      status: "missing",
      pr: prNumber,
      readyToMerge: false,
      latestCommit,
      latestCommitAt,
    }, rubricAnchor);
  }

  if (manifestData && latestCommit && reviewedSha && latestCommit !== reviewedSha) {
    return withRubricNote({
      status: "stale",
      pr: prNumber,
      latestCommit,
      latestCommitAt,
      reviewedAt: lastReviewComment.createdAt,
      reviewedSha,
      readyToMerge: false,
    }, rubricAnchor);
  }

  if (
    !manifestData &&
    latestCommitAt &&
    lastReviewComment.createdAt &&
    lastReviewComment.createdAt < latestCommitAt
  ) {
    return withRubricNote({
      status: "stale",
      pr: prNumber,
      latestCommit,
      latestCommitAt,
      reviewedAt: lastReviewComment.createdAt,
      readyToMerge: false,
    }, rubricAnchor);
  }

  const roundMatch = lastReviewComment.body.match(/Rounds?:\s*(\d+)/);
  return withRubricNote({
    status: "lgtm",
    pr: prNumber,
    round: roundMatch ? roundMatch[1] : null,
    readyToMerge: true,
    reviewedAt: lastReviewComment.createdAt,
    latestCommit,
    latestCommitAt,
    reviewedSha,
  }, rubricAnchor);
}

module.exports = {
  buildSkipComment,
  evaluateReviewGate,
  hasRelayReviewMarker,
  normalizeCommentRecords,
  SKIP_AUDIT_RUBRIC_STATUSES,
  summarizeRubricStatusForSkip,
  toIsoOrNull,
};
