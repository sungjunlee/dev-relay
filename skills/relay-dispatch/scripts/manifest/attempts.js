const path = require("path");

const {
  ensureRunLayout,
  getRunDir,
  nowIso,
} = require("./paths");
const {
  readTextFileWithoutFollowingSymlinks,
  writeTextFileWithoutFollowingSymlinks,
} = require("./rubric");

function getAttemptsPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), "previous-attempts.json");
}

function readPreviousAttempts(repoRoot, runId) {
  const attemptsPath = getAttemptsPath(repoRoot, runId);
  let rawText;
  try {
    rawText = readTextFileWithoutFollowingSymlinks(attemptsPath);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    if (error.code === "ELOOP") {
      throw new Error(
        `Refusing to read symlinked previous-attempts.json at ${attemptsPath}: ${error.message}`
      );
    }
    throw error;
  }
  try {
    return JSON.parse(rawText);
  } catch {
    console.error(`Warning: corrupted previous-attempts.json at ${attemptsPath}, ignoring`);
    return [];
  }
}

function captureAttempt(repoRoot, runId, attemptData) {
  if (!runId) {
    throw new Error("run_id is required to capture an attempt");
  }
  if (!attemptData || typeof attemptData !== "object") {
    throw new Error("attemptData must be an object");
  }

  ensureRunLayout(repoRoot, runId);
  const attempts = readPreviousAttempts(repoRoot, runId);
  const record = {
    dispatch_number: attempts.length + 1,
    timestamp: attemptData.timestamp || nowIso(),
    score_log: attemptData.score_log || null,
    reviewer_feedback: attemptData.reviewer_feedback || null,
    failed_approaches: attemptData.failed_approaches || [],
  };
  attempts.push(record);
  try {
    writeTextFileWithoutFollowingSymlinks(
      getAttemptsPath(repoRoot, runId),
      JSON.stringify(attempts, null, 2)
    );
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new Error(
        `Refusing to write symlinked previous-attempts.json at ${getAttemptsPath(repoRoot, runId)}: ${error.message}`
      );
    }
    throw error;
  }
  return record;
}

function formatAttemptsForPrompt(attempts) {
  if (!attempts || attempts.length === 0) return "";

  const sections = attempts.map((attempt) => {
    const lines = [`## Previous Attempt (dispatch #${attempt.dispatch_number})`];
    if (attempt.score_log) {
      lines.push("", "### Score Log", attempt.score_log);
    }
    if (attempt.reviewer_feedback) {
      lines.push("", "### Reviewer Feedback", attempt.reviewer_feedback);
    }
    if (attempt.failed_approaches && attempt.failed_approaches.length > 0) {
      lines.push("", "### Do NOT Repeat");
      attempt.failed_approaches.forEach((a) => lines.push(`- ${a}`));
    }
    return lines.join("\n");
  });

  return sections.join("\n\n") + "\n\n";
}

module.exports = {
  captureAttempt,
  formatAttemptsForPrompt,
  getAttemptsPath,
  readPreviousAttempts,
};
