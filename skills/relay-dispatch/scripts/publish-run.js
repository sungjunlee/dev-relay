#!/usr/bin/env node
const path = require("path");
const { execFileSync } = require("child_process");
const { bindCliArgs, findUnknownFlags, modeLabel } = require("./cli-args");
const { pushAndOpenPR } = require("./dispatch-publish");
const { validateManifestPaths, getExpectedManifestRepoRoot, getRunDir } = require("./manifest/paths");
const { readManifest, writeManifest } = require("./manifest/store");
const { STATES, updateManifestState } = require("./manifest/lifecycle");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent, EVENTS } = require("./relay-events");

const KNOWN_FLAGS = ["--repo", "--run-id", "--branch", "--manifest", "--dry-run", "--json", "--help", "-h"];

function printUsage() {
  console.log("Usage: publish-run.js --repo <repo> --run-id <id> [options]");
  console.log("       publish-run.js --manifest <path> [options]");
  console.log("\nOptions:");
  console.log(`  --repo      ${modeLabel("--repo")} Repository root`);
  console.log(`  --run-id    ${modeLabel("--run-id")} Relay run id`);
  console.log(`  --branch    ${modeLabel("--branch")} Resolve run by working branch`);
  console.log(`  --manifest  ${modeLabel("--manifest")} Relay manifest path`);
  console.log(`  --dry-run   ${modeLabel("--dry-run")} Validate and print without pushing`);
  console.log(`  --json      ${modeLabel("--json")} Output as JSON`);
}

function readDispatchResult(repoRoot, runId) {
  try {
    return require("fs").readFileSync(path.join(getRunDir(repoRoot, runId), "dispatch-result.txt"), "utf-8");
  } catch {
    return "";
  }
}

function normalizeSha(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getReviewedHeadSha(data) {
  return normalizeSha(data.review?.last_reviewed_sha);
}

function buildPublishPreflightError({ reviewedHeadSha, headSha, dirtyStatus }) {
  if (!reviewedHeadSha) {
    return new Error(
      "publish-run requires review.last_reviewed_sha before publishing. " +
      "Run internal review again so the PR publication has a reviewed HEAD anchor."
    );
  }
  if (headSha !== reviewedHeadSha) {
    return new Error(
      `Refusing to publish unreviewed HEAD ${headSha}: internal review approved ${reviewedHeadSha}. ` +
      "Run review again before publishing."
    );
  }
  if (dirtyStatus) {
    return new Error(
      "Refusing to publish with uncommitted worktree changes after internal review. " +
      "Commit/recover the changes and run review again before publishing."
    );
  }
  return null;
}

function escalatePublishPreflightFailure({ data, body, manifestPath, validatedPaths, headSha, branch, error }) {
  const escalated = updateManifestState(data, STATES.ESCALATED, "inspect_publish_head_drift");
  writeManifest(manifestPath, {
    ...escalated,
    git: {
      ...(escalated.git || {}),
      head_sha: headSha,
    },
    review: {
      ...(escalated.review || {}),
      latest_verdict: "publish_head_drift",
    },
  }, body);
  appendRunEvent(validatedPaths.repoRoot, data.run_id, {
    event: EVENTS.PUBLISH_RESULT,
    state_from: data.state,
    state_to: STATES.ESCALATED,
    head_sha: headSha,
    last_reviewed_sha: getReviewedHeadSha(data),
    branch,
    reason: String(error.message || error).split("\n")[0],
  });
}

async function publishRun(options) {
  const repoPath = path.resolve(options.repoArg || ".");
  const manifestRecord = resolveManifestRecord({
    repoRoot: repoPath,
    manifestPath: options.manifestPathArg,
    runId: options.runIdArg,
    branch: options.branchArg,
  });
  const { body, manifestPath } = manifestRecord;
  let { data } = manifestRecord;
  const validatedPaths = validateManifestPaths(data?.paths, {
    expectedRepoRoot: options.manifestPathArg ? undefined : getExpectedManifestRepoRoot(repoPath, options.repoArg),
    manifestPath,
    runId: data?.run_id,
    requireWorktree: true,
    caller: "publish-run",
  });
  data = {
    ...data,
    paths: {
      ...(data.paths || {}),
      repo_root: validatedPaths.repoRoot,
      worktree: validatedPaths.worktree,
    },
  };

  if (data.state !== STATES.PUBLISH_PENDING) {
    throw new Error(`publish-run requires state=${STATES.PUBLISH_PENDING}, got ${data.state}`);
  }
  const branch = data.git?.working_branch;
  if (!branch) throw new Error("manifest is missing git.working_branch");
  const baseBranch = data.git?.base_branch || "main";
  const headSha = execFileSync("git", ["-C", validatedPaths.worktree, "rev-parse", "HEAD"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  const dirtyStatus = execFileSync("git", ["-C", validatedPaths.worktree, "status", "--porcelain"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  const reviewedHeadSha = getReviewedHeadSha(data);
  const preflightError = buildPublishPreflightError({ reviewedHeadSha, headSha, dirtyStatus });
  if (preflightError) {
    if (!options.dryRun) {
      escalatePublishPreflightFailure({
        data,
        body,
        manifestPath,
        validatedPaths,
        headSha,
        branch,
        error: preflightError,
      });
    }
    throw preflightError;
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      runId: data.run_id,
      manifestPath,
      state: data.state,
      nextState: STATES.REVIEW_PENDING,
      branch,
      baseBranch,
      headSha,
      reviewedHeadSha,
      prNumber: data.git?.pr_number || null,
    };
  }

  let prResult;
  try {
    prResult = await pushAndOpenPR({
      wtPath: validatedPaths.worktree,
      branch,
      baseBranch,
      resultPreview: readDispatchResult(validatedPaths.repoRoot, data.run_id),
      runId: data.run_id,
      executor: data.roles?.executor || "unknown",
    });
  } catch (error) {
    const escalated = updateManifestState(data, STATES.ESCALATED, "inspect_publish_failure");
    writeManifest(manifestPath, {
      ...escalated,
      git: {
        ...(escalated.git || {}),
        head_sha: headSha,
      },
      review: {
        ...(escalated.review || {}),
        latest_verdict: "publish_failed",
      },
    }, body);
    appendRunEvent(validatedPaths.repoRoot, data.run_id, {
      event: EVENTS.PUBLISH_RESULT,
      state_from: data.state,
      state_to: STATES.ESCALATED,
      head_sha: headSha,
      branch,
      reason: String(error.message || error).split("\n")[0],
    });
    throw error;
  }

  const updated = updateManifestState(data, STATES.REVIEW_PENDING, "run_review");
  const updatedManifest = {
    ...updated,
    git: {
      ...(updated.git || {}),
      pr_number: prResult.prNumber,
      head_sha: headSha,
    },
    github: {
      ...(updated.github || {}),
      pr_created_by_orchestrator: prResult.createdByUs,
    },
  };
  writeManifest(manifestPath, updatedManifest, body);
  appendRunEvent(validatedPaths.repoRoot, data.run_id, {
    event: EVENTS.PUBLISH_RESULT,
    state_from: data.state,
    state_to: updatedManifest.state,
    head_sha: headSha,
    branch,
    pr_number: prResult.prNumber,
    pr_created_by_orchestrator: prResult.createdByUs,
    reason: prResult.createdByUs ? "created_pr" : "reused_pr",
  });

  return {
    ok: true,
    dryRun: false,
    runId: data.run_id,
    manifestPath,
    state: updatedManifest.state,
    previousState: data.state,
    branch,
    baseBranch,
    headSha,
    reviewedHeadSha,
    prNumber: prResult.prNumber,
    prCreatedByUs: prResult.createdByUs,
  };
}

async function main(argv) {
  const unknown = findUnknownFlags(argv, KNOWN_FLAGS);
  if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  const cliArgs = bindCliArgs(argv, { commandName: "publish-run", reservedFlags: KNOWN_FLAGS });
  if (!argv.length || cliArgs.hasFlag(["--help", "-h"])) {
    printUsage();
    process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
  }
  const result = await publishRun({
    branchArg: cliArgs.getArg("--branch"),
    dryRun: cliArgs.hasFlag("--dry-run"),
    manifestPathArg: cliArgs.getArg("--manifest"),
    repoArg: cliArgs.getArg("--repo"),
    runIdArg: cliArgs.getArg("--run-id"),
  });
  if (cliArgs.hasFlag("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Published run ${result.runId}: state=${result.state}, PR=#${result.prNumber || "pending"}`);
    console.log(`Manifest: ${result.manifestPath}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  publishRun,
};
