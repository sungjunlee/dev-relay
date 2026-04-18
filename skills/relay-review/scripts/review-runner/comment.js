const { gh } = require("./common");

const REVIEW_MARKER = "<!-- relay-review -->";
const REVIEW_ROUND_MARKER = "<!-- relay-review-round -->";

function formatIssueList(issues) {
  return issues.map((issue) => `- ${issue.file}:${issue.line} — ${issue.title}: ${issue.body}`).join("\n");
}

function appendCommentWarnings(commentBody, warnings = []) {
  if (!Array.isArray(warnings) || warnings.length === 0) return commentBody;
  return [
    commentBody,
    "",
    "Score divergence warnings:",
    ...warnings.map((warning) => `- ${warning}`),
  ].join("\n");
}

function formatScopeDrift(scopeDrift) {
  if (!scopeDrift) return "";
  const parts = [];
  if (scopeDrift.creep && scopeDrift.creep.length) {
    parts.push("Scope creep (revert these out-of-scope changes):");
    parts.push(...scopeDrift.creep.map((entry) => `- ${entry.file}: ${entry.reason}`));
  }
  if (scopeDrift.missing && scopeDrift.missing.length) {
    const actionable = scopeDrift.missing.filter((entry) => entry.status !== "verified");
    if (actionable.length) {
      parts.push("Missing/incomplete requirements:");
      parts.push(...actionable.map((entry) => `- [${entry.status.toUpperCase()}] ${entry.criteria}`));
    }
  }
  return parts.join("\n");
}

function buildCommentBody(verdict, round, { warnings = [], gateFailure = null } = {}) {
  if (gateFailure) {
    return appendCommentWarnings([
      REVIEW_ROUND_MARKER,
      `## Relay Review Round ${round}`,
      "Verdict: CHANGES_REQUESTED",
      `Summary: ${gateFailure.summary}`,
      `Reviewer verdict: ${String(verdict.verdict || "unknown").toUpperCase()} (next_action=${verdict.next_action || "unknown"})`,
      `Gate status: ${gateFailure.status}`,
      `Layer: ${gateFailure.layer}`,
      `Rubric state: ${gateFailure.rubricState} (anchor status: ${gateFailure.rubricStatus})`,
      `Recovery command: ${gateFailure.recoveryCommand}`,
      "Issues:",
      `- Rubric gate failed closed: ${gateFailure.reason}. ${gateFailure.recovery}`,
    ].join("\n"), warnings);
  }

  if (verdict.verdict === "pass") {
    return appendCommentWarnings([
      REVIEW_MARKER,
      "## Relay Review",
      "Verdict: LGTM",
      `Summary: ${verdict.summary}`,
      `Contract: ${verdict.contract_status.toUpperCase()}`,
      `Quality: ${verdict.quality_status.toUpperCase()}`,
      `Rounds: ${round}`,
    ].join("\n"), warnings);
  }

  if (verdict.verdict === "changes_requested") {
    return appendCommentWarnings([
      REVIEW_ROUND_MARKER,
      `## Relay Review Round ${round}`,
      "Verdict: CHANGES_REQUESTED",
      `Summary: ${verdict.summary}`,
      "Issues:",
      formatIssueList(verdict.issues),
    ].join("\n"), warnings);
  }

  return appendCommentWarnings([
    REVIEW_MARKER,
    "## Relay Review",
    "Verdict: ESCALATED",
    `Summary: ${verdict.summary}`,
    `Rounds: ${round}`,
    "Issues:",
    formatIssueList(verdict.issues),
  ].join("\n"), warnings);
}

function postComment(repoPath, prNumber, commentBody) {
  if (!prNumber) {
    throw new Error("PR number is required to post a review comment");
  }
  gh(repoPath, "pr", "comment", String(prNumber), "--body", commentBody);
}

module.exports = {
  appendCommentWarnings,
  buildCommentBody,
  formatIssueList,
  formatScopeDrift,
  postComment,
};
