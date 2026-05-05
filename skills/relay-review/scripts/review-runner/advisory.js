const { spawn } = require("child_process");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { resolveExecutorDefaultModel } = require("../../../relay-dispatch/scripts/executor-model-config");
const { appendRunEvent, EVENTS } = require("../../../relay-dispatch/scripts/relay-events");
const { parseAdvisoryReview, validateAdvisoryProfile } = require("../advisory-review-schema");
const { captureGitStatus, resolveReviewerScript } = require("./reviewer-invoke");
const { writeText } = require("./common");

const DEFAULT_ADVISORY_TIMEOUT_SECONDS = 900;

function parsePositiveSeconds(value, fallback = DEFAULT_ADVISORY_TIMEOUT_SECONDS) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--advisory-timeout must be a positive integer number of seconds");
  }
  return parsed;
}

function resolveAdvisoryModel(data, reviewerName, explicitModel) {
  if (explicitModel) return explicitModel;
  const hinted = data?.model_hints?.advisory_review;
  if (typeof hinted === "string" && hinted.trim()) return hinted.trim();
  return resolveExecutorDefaultModel(reviewerName, { relayHome: process.env.RELAY_HOME });
}

function createAdvisoryWorktree(reviewRepoPath, runDir, reviewerName) {
  const parent = path.join(runDir, "advisory-worktrees");
  fs.mkdirSync(parent, { recursive: true });
  const worktreePath = path.join(parent, `${reviewerName}-${process.pid}-${Date.now()}`);
  execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
    cwd: reviewRepoPath,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return worktreePath;
}

function cleanupAdvisoryWorktree(baseRepoPath, worktreePath) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: baseRepoPath,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {}
}

function startAdvisoryReview({
  promptText,
  reviewerModel,
  reviewerName,
  reviewRepoPath,
  round,
  runDir,
}) {
  const promptPath = path.join(runDir, `review-round-${round}-advisory-${reviewerName}-prompt.md`);
  writeText(promptPath, `${promptText}\n`);
  const reviewerScript = resolveReviewerScript(reviewerName, null);
  const advisoryRepoPath = createAdvisoryWorktree(reviewRepoPath, runDir, reviewerName);
  const statusBefore = captureGitStatus(advisoryRepoPath);
  const execArgs = [reviewerScript, "--repo", reviewRepoPath, "--prompt-file", promptPath, "--json"];
  if (reviewerModel) execArgs.push("--model", reviewerModel);
  const startedAt = Date.now();
  execArgs[execArgs.indexOf("--repo") + 1] = advisoryRepoPath;
  const child = spawn(process.execPath, execArgs, { cwd: advisoryRepoPath, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
  const completion = new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: null, error }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return { advisoryRepoPath, baseRepoPath: reviewRepoPath, child, completion, promptPath, reviewerModel, reviewerName, reviewerScript, startedAt, statusBefore, stderr: () => stderr, stdout: () => stdout };
}

function writeRawResponse(runDir, round, reviewerName, stdout, stderr) {
  const rawResponsePath = path.join(runDir, `review-round-${round}-advisory-${reviewerName}-raw-response.txt`);
  const text = stderr.trim()
    ? [stdout.trim(), "", "stderr:", stderr.trim()].filter(Boolean).join("\n")
    : stdout.trim();
  writeText(rawResponsePath, `${text}\n`);
  return rawResponsePath;
}

async function finishAdvisoryReview({
  advisoryRun,
  data,
  headSha,
  profile,
  round,
  runDir,
  runRepoPath,
  timeoutSeconds,
}) {
  const timeoutMs = parsePositiveSeconds(timeoutSeconds) * 1000;
  const elapsed = () => Date.now() - advisoryRun.startedAt;
  let artifactPath = null;
  let failureReason = null;
  let rawResponsePath = null;
  let status = "success";
  let counts = { required_count: 0, advisory_count: 0, duplicate_low_confidence_count: 0 };

  try {
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(() => {
        advisoryRun.child.kill("SIGTERM");
        resolve({ code: null, signal: "SIGTERM", timeout: true });
      }, timeoutMs);
      advisoryRun.completion.then(() => clearTimeout(timer));
    });
    const outcome = await Promise.race([advisoryRun.completion, timeout]);
    const stdout = advisoryRun.stdout();
    const stderr = advisoryRun.stderr();
    rawResponsePath = writeRawResponse(runDir, round, advisoryRun.reviewerName, stdout, stderr);
    const statusAfter = captureGitStatus(advisoryRun.advisoryRepoPath);
    if (advisoryRun.statusBefore !== statusAfter) {
      status = "policy_violation";
      failureReason = "advisory_reviewer_modified_worktree";
      artifactPath = path.join(runDir, `review-round-${round}-advisory-${advisoryRun.reviewerName}-policy-violation.txt`);
      writeText(artifactPath, [
        "Advisory reviewer write policy violation detected.",
        "",
        `Reviewer: ${advisoryRun.reviewerName}`,
        `Script: ${advisoryRun.reviewerScript}`,
        "",
        "Status before advisory reviewer:",
        advisoryRun.statusBefore || "(clean)",
        "",
        "Status after advisory reviewer:",
        statusAfter || "(clean)",
      ].join("\n") + "\n");
    } else if (outcome.timeout) {
      status = "timeout";
      failureReason = `advisory reviewer exceeded ${timeoutMs / 1000}s timeout`;
    } else if (outcome.error || outcome.code !== 0) {
      status = "failed";
      failureReason = outcome.error ? outcome.error.message : `advisory reviewer exited with code ${outcome.code}`;
    } else {
      const parsed = parseAdvisoryReview(stdout, { profile });
      artifactPath = path.join(runDir, `review-round-${round}-advisory-${advisoryRun.reviewerName}.json`);
      writeText(artifactPath, `${JSON.stringify(parsed, null, 2)}\n`);
      counts = {
        required_count: parsed.required_findings.length,
        advisory_count: parsed.advisory_findings.length,
        duplicate_low_confidence_count: parsed.duplicate_or_low_confidence.length,
      };
    }
  } catch (error) {
    status = "failed";
    failureReason = error.message;
  }

  const result = { artifactPath, elapsedMs: elapsed(), failureReason, profile, rawResponsePath, reviewer: advisoryRun.reviewerName, status, ...counts };
  try {
    appendRunEvent(runRepoPath, data.run_id, {
      event: EVENTS.ADVISORY_REVIEW,
      state_from: data.state,
      state_to: data.state,
      head_sha: headSha,
      round,
      reviewer: advisoryRun.reviewerName,
      model: advisoryRun.reviewerModel,
      profile,
      status,
      artifact_path: artifactPath,
      raw_response_path: rawResponsePath,
      elapsed_ms: result.elapsedMs,
      failure_reason: failureReason,
      ...counts,
    });
  } catch (error) {
    result.status = "failed";
    result.failureReason = `advisory event write failed: ${error.message}`;
  } finally {
    cleanupAdvisoryWorktree(advisoryRun.baseRepoPath, advisoryRun.advisoryRepoPath);
  }
  return result;
}

module.exports = {
  finishAdvisoryReview,
  parsePositiveSeconds,
  resolveAdvisoryModel,
  startAdvisoryReview,
  validateAdvisoryProfile,
};
