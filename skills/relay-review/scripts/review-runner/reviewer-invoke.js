const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { STATES } = require("../../../relay-dispatch/scripts/manifest/lifecycle");
const { writeManifest } = require("../../../relay-dispatch/scripts/manifest/store");
const { appendRunEvent } = require("../../../relay-dispatch/scripts/relay-events");
const { applyPolicyViolationToManifest } = require("./manifest-apply");
const { git, readText, writeText } = require("./common");

function resolveReviewerName(data, reviewerArg) {
  const manifestReviewer = data.roles?.reviewer;
  if (reviewerArg) return reviewerArg;
  if (manifestReviewer && manifestReviewer !== "unknown") return manifestReviewer;
  return process.env.RELAY_REVIEWER || "codex";
}

function resolveReviewerScript(reviewerName, reviewerScriptArg) {
  if (reviewerScriptArg) {
    return path.resolve(reviewerScriptArg);
  }

  if (!/^[a-z0-9-]+$/.test(reviewerName)) {
    throw new Error(`Invalid reviewer name '${reviewerName}': must be lowercase alphanumeric/hyphens only. Use --reviewer-script for custom paths.`);
  }
  const candidate = path.join(__dirname, "..", `invoke-reviewer-${reviewerName}.js`);
  if (!fs.existsSync(candidate)) {
    throw new Error(`No reviewer adapter found for '${reviewerName}'. Provide --reviewer-script or --review-file.`);
  }
  return candidate;
}

function invokeReviewer({
  repoPath,
  promptPath,
  reviewerName,
  reviewerScript,
  reviewerModel,
}) {
  const execArgs = [
    reviewerScript,
    "--repo", repoPath,
    "--prompt-file", promptPath,
    "--json",
  ];
  if (reviewerModel) {
    execArgs.push("--model", reviewerModel);
  }

  const rawText = execFileSync("node", execArgs, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
    maxBuffer: 10 * 1024 * 1024,
  }).trim();

  return {
    reviewerName,
    reviewerScript,
    rawText,
  };
}

function captureGitStatus(repoPath) {
  return git(repoPath, "status", "--short", "--untracked-files=all").trim();
}

function loadReviewText({ body, data, manifestPath, prNumber, promptPath, reviewFile, reviewRepoPath, reviewedHeadSha, reviewerModel, reviewerName, reviewerScript, round, runDir, runRepoPath }) {
  if (reviewFile) {
    return { rawResponsePath: null, reviewText: readText(reviewFile) };
  }

  const statusBeforeReviewer = captureGitStatus(reviewRepoPath);
  const invoked = invokeReviewer({
    repoPath: reviewRepoPath,
    promptPath,
    reviewerModel,
    reviewerName,
    reviewerScript,
  });
  const statusAfterReviewer = captureGitStatus(reviewRepoPath);
  if (statusBeforeReviewer !== statusAfterReviewer) {
    const violationPath = path.join(runDir, `review-round-${round}-policy-violation.txt`);
    const violationText = [
      "Reviewer write policy violation detected.",
      "",
      `Reviewer: ${reviewerName}`,
      `Script: ${reviewerScript}`,
      "",
      "Status before reviewer:",
      statusBeforeReviewer || "(clean)",
      "",
      "Status after reviewer:",
      statusAfterReviewer || "(clean)",
    ].join("\n");
    writeText(violationPath, `${violationText}\n`);

    const escalatedManifest = applyPolicyViolationToManifest(
      data,
      round,
      prNumber,
      reviewedHeadSha,
      "policy_violation"
    );
    writeManifest(manifestPath, escalatedManifest, body);
    appendRunEvent(runRepoPath, data.run_id, {
      event: "review_apply",
      state_from: data.state,
      state_to: STATES.ESCALATED,
      head_sha: reviewedHeadSha,
      round,
      reason: "policy_violation",
    });
    throw new Error(`Reviewer write policy violation detected; manifest escalated and details saved to ${violationPath}`);
  }

  const rawResponsePath = path.join(runDir, `review-round-${round}-raw-response.txt`);
  writeText(rawResponsePath, `${invoked.rawText}\n`);
  return { rawResponsePath, reviewText: invoked.rawText };
}

module.exports = {
  captureGitStatus,
  invokeReviewer,
  loadReviewText,
  resolveReviewerName,
  resolveReviewerScript,
};
