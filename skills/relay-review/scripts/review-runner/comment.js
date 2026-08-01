const { gh } = require("./common");

const REVIEW_MARKER = "<!-- relay-review -->";
const REVIEW_ROUND_MARKER = "<!-- relay-review-round -->";

function formatIssueList(issues, { includeConfidence = false } = {}) {
  return issues.map((issue) => {
    const confidence = includeConfidence && issue.confidence ? `[${issue.confidence}] ` : "";
    return `- ${issue.file}:${issue.line} — ${confidence}${issue.title}: ${issue.body}`;
  }).join("\n");
}

function appendCommentWarnings(commentBody, warnings = []) {
  if (!Array.isArray(warnings) || warnings.length === 0) return commentBody;
  return [
    commentBody,
    "",
    "Review warnings:",
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

function formatStatus(value) {
  return String(value || "unknown").toUpperCase();
}

function buildCommentBody(
  verdict,
  round,
  {
    warnings = [],
    gateFailure = null,
    appliedVerdict = null,
    originalReviewerVerdict = null,
    relayEscalation = null,
  } = {}
) {
  if (gateFailure) {
    const gateVerdict = appliedVerdict === "escalated" || verdict.verdict === "escalated"
      ? "ESCALATED"
      : "CHANGES_REQUESTED";
    const recoveryCommand = gateFailure.recoveryCommand
      ? `Recovery command: ${gateFailure.recoveryCommand}`
      : "Recovery command: unavailable after escalation";
    return appendCommentWarnings([
      REVIEW_ROUND_MARKER,
      `## Relay Review Round ${round}`,
      `Verdict: ${gateVerdict}`,
      `Summary: ${gateFailure.summary}`,
      `Reviewer verdict: ${String(verdict.verdict || "unknown").toUpperCase()} (next_action=${verdict.next_action || "unknown"})`,
      `Contract: ${formatStatus(verdict.contract_status)}`,
      `Quality Review: ${formatStatus(verdict.quality_review_status)}`,
      `Quality Execution: ${formatStatus(verdict.quality_execution_status)}`,
      `Gate status: ${gateFailure.status}`,
      `Layer: ${gateFailure.layer}`,
      `Rubric state: ${gateFailure.rubricState} (anchor status: ${gateFailure.rubricStatus})`,
      recoveryCommand,
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
      `Contract: ${formatStatus(verdict.contract_status)}`,
      `Quality Review: ${formatStatus(verdict.quality_review_status)}`,
      `Quality Execution: ${formatStatus(verdict.quality_execution_status)}`,
      `Rounds: ${round}`,
    ].join("\n"), warnings);
  }

  if (verdict.verdict === "changes_requested") {
    return appendCommentWarnings([
      REVIEW_ROUND_MARKER,
      `## Relay Review Round ${round}`,
      "Verdict: CHANGES_REQUESTED",
      `Summary: ${verdict.summary}`,
      `Contract: ${formatStatus(verdict.contract_status)}`,
      `Quality Review: ${formatStatus(verdict.quality_review_status)}`,
      `Quality Execution: ${formatStatus(verdict.quality_execution_status)}`,
      "Issues:",
      formatIssueList(verdict.issues),
    ].join("\n"), warnings);
  }

  const escalationAudit = relayEscalation
    ? [
      `Reviewer verdict: ${formatStatus(originalReviewerVerdict?.verdict)} (next_action=${originalReviewerVerdict?.next_action || "unknown"})`,
      `Escalation trigger: ${relayEscalation.trigger || "unknown"} (reason=${relayEscalation.reason || "unknown"})`,
    ]
    : [];
  return appendCommentWarnings([
    REVIEW_MARKER,
    "## Relay Review",
    "Verdict: ESCALATED",
    `Summary: ${verdict.summary}`,
    ...escalationAudit,
    `Contract: ${formatStatus(verdict.contract_status)}`,
    `Quality Review: ${formatStatus(verdict.quality_review_status)}`,
    `Quality Execution: ${formatStatus(verdict.quality_execution_status)}`,
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
  formatStatus,
  formatIssueList,
  formatScopeDrift,
  postComment,
};
