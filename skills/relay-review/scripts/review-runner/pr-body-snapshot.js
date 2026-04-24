const { appendRunEvent } = require("../../../relay-dispatch/scripts/relay-events");
const { gh, writeText } = require("./common");

const PR_BODY_SNAPSHOT_TIMEOUT_MS = 15000;

function collapseWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function summarizeGhFailure(error) {
  const status = error?.status ?? error?.signal ?? "unknown";
  const stderr = collapseWhitespace(error?.stderr || "");
  const message = collapseWhitespace(error?.message || String(error));
  const detail = stderr || message || "unknown error";
  const truncated = detail.length > 500 ? `${detail.slice(0, 497)}...` : detail;
  return `gh pr view failed (status: ${status}): ${truncated}`;
}

function buildFailureSentinel({ runId, round, prNumber, reason }) {
  return [
    "# PR Body Snapshot Unavailable",
    "",
    "```json",
    JSON.stringify({
      status: "failed",
      runId,
      round,
      prNumber: prNumber ?? null,
      reason,
    }, null, 2),
    "```",
    "",
    "The PR body / PR description could not be fetched for this review round.",
  ].join("\n");
}

function writePrBodySnapshot({ repoPath, runId, round, prNumber, prBodyPath }) {
  if (!prNumber) {
    const reason = "PR number is unavailable; cannot fetch PR body";
    writeText(prBodyPath, `${buildFailureSentinel({ runId, round, prNumber, reason })}\n`);
    appendRunEvent(repoPath, runId, {
      event: "pr_body_snapshot_failed",
      round,
      pr_number: prNumber ?? null,
      reason,
    });
    return { status: "failed", reason };
  }

  try {
    const body = gh(
      repoPath,
      "pr", "view", String(prNumber), "--json", "body", "-q", ".body",
      { timeout: PR_BODY_SNAPSHOT_TIMEOUT_MS }
    );
    writeText(prBodyPath, `${String(body).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n?$/, "\n")}`);
    return { status: "loaded", reason: null };
  } catch (error) {
    const reason = summarizeGhFailure(error);
    writeText(prBodyPath, `${buildFailureSentinel({ runId, round, prNumber, reason })}\n`);
    appendRunEvent(repoPath, runId, {
      event: "pr_body_snapshot_failed",
      round,
      pr_number: prNumber,
      reason,
    });
    return { status: "failed", reason };
  }
}

module.exports = {
  PR_BODY_SNAPSHOT_TIMEOUT_MS,
  buildFailureSentinel,
  summarizeGhFailure,
  writePrBodySnapshot,
};
