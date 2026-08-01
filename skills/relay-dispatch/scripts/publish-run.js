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
const CLI_ARG_OPTIONS = {
  reservedFlags: KNOWN_FLAGS,
  booleanFlags: ["--dry-run", "--json", "--help", "-h"],
  verbatimValueFlags: ["--repo", "--branch", "--manifest"],
};

function printUsage() {
  console.log("Usage: publish-run.js --repo <repo> --run-id <id> [options]");
  console.log("       publish-run.js --manifest <path> [options]");
  console.log("\nOptions:");
  console.log(`  --repo      ${modeLabel("--repo", CLI_ARG_OPTIONS)} Repository root`);
  console.log(`  --run-id    ${modeLabel("--run-id", CLI_ARG_OPTIONS)} Relay run id`);
  console.log(`  --branch    ${modeLabel("--branch", CLI_ARG_OPTIONS)} Resolve run by working branch`);
  console.log(`  --manifest  ${modeLabel("--manifest", CLI_ARG_OPTIONS)} Relay manifest path`);
  console.log(`  --dry-run   ${modeLabel("--dry-run", CLI_ARG_OPTIONS)} Validate and print without pushing`);
  console.log(`  --json      ${modeLabel("--json", CLI_ARG_OPTIONS)} Output as JSON`);
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

function publishPreflightError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function buildPublishPreflightError({ reviewedHeadSha, headSha, branchHeadSha, dirtyStatus }) {
  // Fail closed from missing review evidence to progressively narrower drift cases.
  if (!reviewedHeadSha) {
    return publishPreflightError(
      "publish_missing_review_anchor",
      "publish-run requires review.last_reviewed_sha before publishing. " +
      "Run internal review again so the PR publication has a reviewed HEAD anchor."
    );
  }
  if (headSha !== reviewedHeadSha) {
    return publishPreflightError(
      "publish_head_drift",
      `Refusing to publish unreviewed HEAD ${headSha}: internal review approved ${reviewedHeadSha}. ` +
      "Run review again before publishing."
    );
  }
  if (branchHeadSha !== reviewedHeadSha) {
    return publishPreflightError(
      "publish_branch_ref_drift",
      `Refusing to publish unreviewed branch ref ${branchHeadSha}: internal review approved ${reviewedHeadSha}. ` +
      "Check out/reset the manifest branch to the reviewed commit and run review again before publishing."
    );
  }
  if (dirtyStatus) {
    return publishPreflightError(
      "publish_dirty_worktree",
      "Refusing to publish with uncommitted worktree changes after internal review. " +
      "Commit/recover the changes and run review again before publishing."
    );
  }
  return null;
}

function publishPreflightReviewFields(error) {
  const code = error?.code || "publish_preflight_failed";
  const byCode = {
    publish_missing_review_anchor: {
      latestVerdict: "publish_missing_review_anchor",
      nextAction: "run_internal_review",
    },
    publish_head_drift: {
      latestVerdict: "publish_head_drift",
      nextAction: "inspect_publish_head_drift",
    },
    publish_branch_ref_drift: {
      latestVerdict: "publish_branch_ref_drift",
      nextAction: "inspect_publish_branch_ref_drift",
    },
    publish_dirty_worktree: {
      latestVerdict: "publish_dirty_worktree",
      nextAction: "inspect_publish_dirty_worktree",
    },
  };
  return { code, ...(byCode[code] || { latestVerdict: code, nextAction: "inspect_publish_preflight_failure" }) };
}

function escalatePublishPreflightFailure({ data, body, manifestPath, validatedPaths, headSha, branchHeadSha, branch, error }) {
  const preflight = publishPreflightReviewFields(error);
  const escalated = updateManifestState(data, STATES.ESCALATED, preflight.nextAction);
  writeManifest(manifestPath, {
    ...escalated,
    git: {
      ...(escalated.git || {}),
      head_sha: headSha,
    },
    review: {
      ...(escalated.review || {}),
      latest_verdict: preflight.latestVerdict,
    },
  }, body);
  appendRunEvent(validatedPaths.repoRoot, data.run_id, {
    event: EVENTS.PUBLISH_RESULT,
    state_from: data.state,
    state_to: STATES.ESCALATED,
    head_sha: headSha,
    branch_head_sha: branchHeadSha,
    last_reviewed_sha: getReviewedHeadSha(data),
    branch,
    preflight_code: preflight.code,
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
  const branchHeadSha = execFileSync("git", ["-C", validatedPaths.worktree, "rev-parse", "--verify", `refs/heads/${branch}`], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  const dirtyStatus = execFileSync("git", ["-C", validatedPaths.worktree, "status", "--porcelain"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  const reviewedHeadSha = getReviewedHeadSha(data);
  const preflightError = buildPublishPreflightError({ reviewedHeadSha, headSha, branchHeadSha, dirtyStatus });
  if (preflightError) {
    if (!options.dryRun) {
      escalatePublishPreflightFailure({
        data,
        body,
        manifestPath,
        validatedPaths,
        headSha,
        branchHeadSha,
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
      branchHeadSha,
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
    branchHeadSha,
    reviewedHeadSha,
    prNumber: prResult.prNumber,
    prCreatedByUs: prResult.createdByUs,
  };
}

async function main(argv) {
  const unknown = findUnknownFlags(argv, CLI_ARG_OPTIONS);
  if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  const cliArgs = bindCliArgs(argv, CLI_ARG_OPTIONS);
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
