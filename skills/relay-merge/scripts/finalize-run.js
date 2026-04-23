#!/usr/bin/env node
/**
 * Merge a ready relay run, then finalize cleanup and manifest metadata.
 * Operator-only escape hatch: `--force-finalize-nonready --reason <text>`
 * bypasses the manifest state gate for non-terminal runs, emits a loud
 * `force_finalize` audit event, and records `last_force` in the manifest
 * before the merge side effect.
 *
 * Usage:
 *   ./finalize-run.js --repo <path> --run-id <id> [options]
 *   ./finalize-run.js --repo <path> --pr <number> [options]
 *   ./finalize-run.js --manifest <path> [options]
 *
 * Options:
 *   --repo <path>          Repository root (default: .)
 *   --run-id <id>          Relay run identifier
 *   --manifest <path>      Explicit manifest path
 *   --branch <name>        Override branch name
 *   --pr <number>          Pull request number (optional when stored in manifest)
 *   --merge-method <name>  squash | merge | rebase (default: squash)
 *   --skip-review <reason> Bypass the fresh-review gate with an audit reason
 *   --force-finalize-nonready
 *                          Operator-only: bypass non-ready state gate
 *   --reason <text>        Required with --force-finalize-nonready
 *   --skip-merge           Skip the PR merge step and run cleanup only
 *   --no-issue-close       Skip linked issue close
 *   --dry-run              Print what would happen without writing
 *   --json                 Output JSON
 *   --help, -h             Show usage
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  getCanonicalRepoRoot,
  getRunDir,
  validateManifestPaths,
} = require("../../relay-dispatch/scripts/manifest/paths");
const {
  STATES,
  forceUpdateManifestState,
  updateManifestState,
} = require("../../relay-dispatch/scripts/manifest/lifecycle");
const {
  getActorName,
  summarizeError,
  writeManifest,
} = require("../../relay-dispatch/scripts/manifest/store");
const { resolveManifestRecord } = require("../../relay-dispatch/scripts/relay-resolver");
const { appendRunEvent } = require("../../relay-dispatch/scripts/relay-events");
const { runCleanup } = require("../../relay-dispatch/scripts/manifest/cleanup");
const { getArg: sharedGetArg, hasFlag: sharedHasFlag } = require("../../relay-dispatch/scripts/cli-args");
const {
  buildSkipReviewGateFailure,
  buildSkipComment,
  evaluateReviewGate,
  summarizeRubricAuditForSkip,
} = require("./review-gate");

const args = process.argv.slice(2);
const KNOWN_FLAGS = [
  "--repo", "--run-id", "--manifest", "--branch", "--pr", "--merge-method", "--skip-review",
  "--force-finalize-nonready", "--reason",
  "--skip-merge", "--no-issue-close", "--dry-run", "--json", "--help", "-h",
];
const LEGACY_BOOTSTRAP_REASON_PREFIX = /^\s*bootstrap:/i;

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: finalize-run.js (--repo <path> --run-id <id> | --repo <path> --pr <number> | --manifest <path>) [options]");
  console.log("\nMerge a ready relay run, then finalize cleanup and manifest metadata.");
  console.log("\nOptions:");
  console.log("  --repo <path>          Repository root (default: .)");
  console.log("  --run-id <id>          Relay run identifier");
  console.log("  --manifest <path>      Explicit manifest path");
  console.log("  --branch <name>        Override branch name");
  console.log("  --pr <number>          Pull request number (optional when stored in manifest)");
  console.log("  --merge-method <name>  squash | merge | rebase (default: squash)");
  console.log("  --skip-review <reason> Bypass the fresh-review gate with an audit reason");
  console.log("  --force-finalize-nonready");
  console.log("                         Operator-only: bypass non-ready state gate");
  console.log("  --reason <text>        Required with --force-finalize-nonready");
  console.log("  --skip-merge           Skip the PR merge step and run cleanup only");
  console.log("  --no-issue-close       Skip linked issue close");
  console.log("  --dry-run              Print what would happen without writing");
  console.log("  --json                 Output JSON");
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

const getArg = (flag, fallback) => sharedGetArg(args, flag, fallback, { reservedFlags: KNOWN_FLAGS });
const hasFlag = (flag) => sharedHasFlag(args, flag);

function parsePositiveInt(value, label) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function hasLegacyBootstrapReasonPrefix(reason) {
  return LEGACY_BOOTSTRAP_REASON_PREFIX.exec(String(reason || "")) !== null;
}

function gh(ghBin, repoPath, ...ghArgs) {
  return execFileSync(ghBin, ghArgs, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function git(gitBin, repoPath, ...gitArgs) {
  return execFileSync(gitBin, ["-C", repoPath, ...gitArgs], {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function looksLikeGitRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, ".git"));
}

function getExpectedManifestRepoRoot(repoPath, repoArg) {
  if (!repoArg && !looksLikeGitRepo(repoPath)) {
    return undefined;
  }
  return getCanonicalRepoRoot(repoPath);
}

function resolveBranch(ghBin, repoPath, prNumber, branchArg, manifestData) {
  if (branchArg) return branchArg;
  if (manifestData?.git?.working_branch) return manifestData.git.working_branch;
  if (!prNumber) return null;
  const raw = gh(ghBin, repoPath, "pr", "view", String(prNumber), "--json", "headRefName");
  return JSON.parse(raw).headRefName;
}

function mergeFlag(method) {
  switch (method) {
    case "squash":
      return "--squash";
    case "merge":
      return "--merge";
    case "rebase":
      return "--rebase";
    default:
      throw new Error(`Unsupported merge method: ${method}`);
  }
}

function fetchPreMergeContext(ghBin, repoPath, prNumber) {
  const raw = gh(ghBin, repoPath, "pr", "view", String(prNumber),
    "--json", "comments,commits,mergeable,statusCheckRollup");
  const parsed = JSON.parse(raw);
  const checks = parsed.statusCheckRollup || [];
  return {
    comments: parsed.comments || [],
    commits: parsed.commits || [],
    mergeable: parsed.mergeable || null,
    checks,
    failing: checks.filter((c) => c.conclusion === "FAILURE"),
  };
}

function fetchPrMergeState(ghBin, repoPath, prNumber) {
  const raw = gh(ghBin, repoPath, "pr", "view", String(prNumber), "--json", "state,mergeCommit");
  const parsed = JSON.parse(raw);
  return {
    state: parsed.state || null,
    mergeCommitSha: parsed.mergeCommit?.oid || null,
  };
}

function assertPreMergeSafety(preMerge, prNumber) {
  if (preMerge.mergeable === "CONFLICTING") {
    throw new Error(
      `PR #${prNumber} has merge conflicts with the base branch. Resolve conflicts and push, then retry.`
    );
  }
  if (preMerge.failing.length > 0) {
    const names = preMerge.failing.map((c) => c.name || c.context || "unknown").join(", ");
    throw new Error(
      `PR #${prNumber} has failing CI checks: ${names}. Fix these before merging.`
    );
  }
}

function resolveRemoteName(gitBin, repoPath, branch) {
  if (!branch) return null;
  try {
    return git(gitBin, repoPath, "config", `branch.${branch}.remote`) || "origin";
  } catch {
    return "origin";
  }
}

function hasRemote(gitBin, repoPath, remoteName) {
  if (!remoteName) return false;
  try {
    git(gitBin, repoPath, "remote", "get-url", remoteName);
    return true;
  } catch {
    return false;
  }
}

function remoteBranchExists(gitBin, repoPath, remoteName, branch) {
  if (!remoteName || !branch) return false;
  try {
    git(gitBin, repoPath, "ls-remote", "--exit-code", "--heads", remoteName, branch);
    return true;
  } catch {
    return false;
  }
}

function deleteRemoteBranch(gitBin, repoPath, branch) {
  const remoteName = resolveRemoteName(gitBin, repoPath, branch);
  if (!remoteName || !hasRemote(gitBin, repoPath, remoteName)) {
    return {
      remoteName,
      attempted: false,
      deleted: false,
      warning: null,
    };
  }
  if (!remoteBranchExists(gitBin, repoPath, remoteName, branch)) {
    return {
      remoteName,
      attempted: false,
      deleted: true,
      warning: null,
    };
  }
  try {
    git(gitBin, repoPath, "push", remoteName, "--delete", branch);
    return {
      remoteName,
      attempted: true,
      deleted: true,
      warning: null,
    };
  } catch (error) {
    return {
      remoteName,
      attempted: true,
      deleted: false,
      warning: summarizeError(error),
    };
  }
}

function main() {
  const repoArg = getArg("--repo");
  let repoPath = path.resolve(repoArg || ".");
  const manifestArg = getArg("--manifest");
  const runId = getArg("--run-id");
  let prNumber = parsePositiveInt(getArg("--pr"), "--pr");
  const mergeMethod = getArg("--merge-method") || "squash";
  const skipReviewReason = getArg("--skip-review");
  const forceFinalizeNonready = hasFlag("--force-finalize-nonready");
  const forceFinalizeReason = getArg("--reason");
  const dryRun = hasFlag("--dry-run");
  const skipMerge = hasFlag("--skip-merge");
  const skipIssueClose = hasFlag("--no-issue-close");
  const jsonOut = hasFlag("--json");
  const ghBin = process.env.RELAY_GH_BIN || "gh";
  const gitBin = process.env.RELAY_GIT_BIN || "git";
  if (forceFinalizeNonready && !String(forceFinalizeReason || "").trim()) {
    throw new Error("--force-finalize-nonready requires --reason <non-empty-text>");
  }
  if (forceFinalizeNonready && hasLegacyBootstrapReasonPrefix(forceFinalizeReason)) {
    console.error(
      "Warning: bootstrap-prefixed --force-finalize-nonready reasons are deprecated. " +
      "Use relay-reconcile-artifact --artifact-path <path> --writer-pr <pr> --reason <reason>."
    );
  }

  let branch = getArg("--branch");
  let manifestRecord = resolveManifestRecord({
    repoRoot: repoPath,
    manifestPath: manifestArg,
    runId,
    branch,
    prNumber,
    includeTerminal: skipMerge,
  });
  const selectorExpectedRepoRoot = manifestArg
    ? undefined
    : getExpectedManifestRepoRoot(repoPath, repoArg);
  let validatedPaths = validateManifestPaths(manifestRecord.data?.paths, {
    expectedRepoRoot: selectorExpectedRepoRoot,
    manifestPath: manifestRecord.manifestPath,
    runId: manifestRecord.data?.run_id,
    caller: "finalize-run",
  });
  repoPath = validatedPaths.repoRoot;
  if ((manifestArg || runId) && !repoArg) {
    manifestRecord = resolveManifestRecord({
      repoRoot: repoPath,
      manifestPath: manifestArg,
      runId,
      branch,
      prNumber,
      includeTerminal: skipMerge,
    });
    validatedPaths = validateManifestPaths(manifestRecord.data?.paths, {
      expectedRepoRoot: manifestArg ? undefined : repoPath,
      manifestPath: manifestRecord.manifestPath,
      runId: manifestRecord.data?.run_id,
      caller: "finalize-run",
    });
  }

  const { manifestPath, data, body } = manifestRecord;
  const safeData = {
    ...data,
    paths: {
      ...(data.paths || {}),
      repo_root: validatedPaths.repoRoot,
      worktree: validatedPaths.worktree,
    },
  };
  const FORCE_FINALIZE_ALLOWED_STATES = new Set([
    STATES.DRAFT,
    STATES.DISPATCHED,
    STATES.REVIEW_PENDING,
    STATES.CHANGES_REQUESTED,
    STATES.ESCALATED,
    STATES.READY_TO_MERGE,
  ]);
  prNumber = prNumber || safeData.git?.pr_number || null;
  branch = resolveBranch(ghBin, repoPath, prNumber, branch, safeData);
  if (!skipMerge && !prNumber) {
    throw new Error("PR number is required for merge finalization");
  }
  if (forceFinalizeNonready && (safeData.state === STATES.MERGED || safeData.state === STATES.CLOSED)) {
    throw new Error(`force-finalize cannot be used from terminal state ${safeData.state}`);
  }
  if (forceFinalizeNonready && !FORCE_FINALIZE_ALLOWED_STATES.has(safeData.state)) {
    throw new Error(`force-finalize cannot be used from state ${safeData.state}`);
  }
  if (skipMerge && safeData.state !== STATES.MERGED) {
    throw new Error("--skip-merge can only be used for runs that are already in the merged state");
  }
  if (!skipMerge && !forceFinalizeNonready && safeData.state !== STATES.READY_TO_MERGE) {
    if (safeData.state !== STATES.MERGED) {
      throw new Error(`Expected relay run to be ${STATES.READY_TO_MERGE} before merge, got ${safeData.state}`);
    }
  }
  const mergeAllowed = !skipMerge && (safeData.state === STATES.READY_TO_MERGE || forceFinalizeNonready);
  const operatorName = getActorName(repoPath);

  let updated = safeData;
  let mergePerformed = false;
  let mergeRecovered = false;
  let prMergeState = dryRun ? { state: "MERGED", mergeCommitSha: null } : null;
  let remoteBranchDeleted = false;
  let remoteBranchDeleteWarning = null;
  let remoteBranchDeleteAttempted = false;
  let remoteName = null;
  let issueClosed = false;
  let issueCloseWarning = null;
  let reviewGate = null;
  let currentHeadSha = safeData.git?.head_sha || null;
  const skipReviewRubricAudit = summarizeRubricAuditForSkip(safeData, {
    runDir: getRunDir(validatedPaths.repoRoot, safeData.run_id),
  });
  const skipReviewRubricStatus = skipReviewRubricAudit.rubricStatus;

  if (mergeAllowed) {
    currentHeadSha = git(gitBin, validatedPaths.worktree, "rev-parse", "HEAD");
    if (skipReviewReason) {
      const skipReviewFailure = buildSkipReviewGateFailure(prNumber, skipReviewRubricAudit);
      if (skipReviewFailure) {
        if (!dryRun) {
          appendRunEvent(repoPath, safeData.run_id, {
            event: "merge_blocked",
            state_from: safeData.state,
            state_to: safeData.state,
            head_sha: currentHeadSha,
            round: safeData.review?.rounds || null,
            reason: skipReviewFailure.status,
          });
        }
        throw new Error(`Fresh review gate failed: ${skipReviewFailure.status}`);
      }
      reviewGate = {
        status: "skipped",
        pr: prNumber,
        reason: skipReviewReason,
        rubricStatus: skipReviewRubricStatus,
        readyToMerge: safeData.state === STATES.READY_TO_MERGE,
      };
      if (!dryRun) {
        const skipComment = buildSkipComment(skipReviewReason, skipReviewRubricAudit);
        appendRunEvent(repoPath, safeData.run_id, {
          event: "skip_review",
          state_from: safeData.state,
          state_to: safeData.state,
          head_sha: currentHeadSha,
          round: safeData.review?.rounds || null,
          reason: skipReviewReason,
          rubric_status: skipReviewRubricStatus,
        });
        gh(ghBin, repoPath, "pr", "comment", String(prNumber), "--body", skipComment);
      }
    } else if (safeData.state === STATES.READY_TO_MERGE) {
      const preMerge = fetchPreMergeContext(ghBin, repoPath, prNumber);
      reviewGate = evaluateReviewGate({
        prNumber,
        comments: preMerge.comments,
        commits: preMerge.commits,
        manifestData: safeData,
        expectedReviewerLogin: safeData.review?.reviewer_login || null,
        runDir: getRunDir(validatedPaths.repoRoot, safeData.run_id),
      });
      if (!reviewGate.readyToMerge) {
        if (!dryRun) {
          appendRunEvent(repoPath, safeData.run_id, {
            event: "merge_blocked",
            state_from: safeData.state,
            state_to: safeData.state,
            head_sha: reviewGate.latestCommit || currentHeadSha,
            round: safeData.review?.rounds || null,
            reason: reviewGate.status,
          });
        }
        throw new Error(`Fresh review gate failed: ${reviewGate.status}`);
      }
      assertPreMergeSafety(preMerge, prNumber);
    } else if (forceFinalizeNonready) {
      const preMerge = fetchPreMergeContext(ghBin, repoPath, prNumber);
      assertPreMergeSafety(preMerge, prNumber);
    }
  }

  if (mergeAllowed) {
    if (forceFinalizeNonready && !dryRun) {
      appendRunEvent(repoPath, safeData.run_id, {
        event: "force_finalize",
        state_from: safeData.state,
        state_to: STATES.MERGED,
        head_sha: currentHeadSha,
        round: safeData.review?.rounds || null,
        reason: forceFinalizeReason,
        pr_number: prNumber,
        last_reviewed_sha: safeData.review?.last_reviewed_sha,
      });
    }

    prMergeState = dryRun ? prMergeState : fetchPrMergeState(ghBin, repoPath, prNumber);
    if (!dryRun && prMergeState.state !== "MERGED") {
      try {
        gh(ghBin, repoPath, "pr", "merge", String(prNumber), mergeFlag(mergeMethod));
        mergePerformed = true;
        prMergeState = fetchPrMergeState(ghBin, repoPath, prNumber);
      } catch (error) {
        prMergeState = fetchPrMergeState(ghBin, repoPath, prNumber);
        if (prMergeState.state !== "MERGED") {
          throw error;
        }
        mergeRecovered = true;
      }
    } else if (!dryRun && prMergeState.state === "MERGED") {
      mergeRecovered = true;
    } else if (dryRun) {
      mergePerformed = true;
    }
    // Merge queue support: if PR isn't immediately MERGED, poll for completion.
    // Repos with merge queues transition through an intermediate state before merging.
    if (!dryRun && prMergeState.state !== "MERGED") {
      const MERGE_QUEUE_POLL_INTERVAL_MS = parseInt(process.env.RELAY_MERGE_QUEUE_POLL_MS || "30000", 10);
      const MERGE_QUEUE_MAX_POLLS = parseInt(process.env.RELAY_MERGE_QUEUE_MAX_POLLS || "60", 10);
      if (!Number.isFinite(MERGE_QUEUE_POLL_INTERVAL_MS) || MERGE_QUEUE_POLL_INTERVAL_MS < 100) {
        throw new Error(`Invalid RELAY_MERGE_QUEUE_POLL_MS: must be >= 100 (got ${process.env.RELAY_MERGE_QUEUE_POLL_MS})`);
      }
      if (!Number.isFinite(MERGE_QUEUE_MAX_POLLS) || MERGE_QUEUE_MAX_POLLS < 1) {
        throw new Error(`Invalid RELAY_MERGE_QUEUE_MAX_POLLS: must be >= 1 (got ${process.env.RELAY_MERGE_QUEUE_MAX_POLLS})`);
      }
      const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
      if (!jsonOut) {
        console.log(`  PR #${prNumber} is in a merge queue. Polling every ${MERGE_QUEUE_POLL_INTERVAL_MS / 1000}s...`);
      }
      for (let i = 0; i < MERGE_QUEUE_MAX_POLLS; i++) {
        Atomics.wait(sleepBuf, 0, 0, MERGE_QUEUE_POLL_INTERVAL_MS);
        prMergeState = fetchPrMergeState(ghBin, repoPath, prNumber);
        if (prMergeState.state === "MERGED") break;
        if (prMergeState.state === "OPEN") {
          appendRunEvent(repoPath, safeData.run_id, {
            event: "merge_blocked",
            state_from: safeData.state,
            state_to: safeData.state,
            head_sha: reviewGate?.latestCommit || currentHeadSha,
            round: safeData.review?.rounds || null,
            reason: "removed_from_merge_queue",
          });
          throw new Error(
            `PR #${prNumber} was removed from the merge queue (state reverted to OPEN). Check the GitHub merge queue page.`
          );
        }
      }
      if (prMergeState.state !== "MERGED") {
        appendRunEvent(repoPath, safeData.run_id, {
          event: "merge_blocked",
          state_from: safeData.state,
          state_to: safeData.state,
          head_sha: reviewGate?.latestCommit || currentHeadSha,
          round: safeData.review?.rounds || null,
          reason: `merge_queue_timeout:${prMergeState.state || "unknown"}`,
        });
        const totalWaitMin = Math.round((MERGE_QUEUE_POLL_INTERVAL_MS * MERGE_QUEUE_MAX_POLLS) / 60000);
        throw new Error(
          `PR #${prNumber} did not merge after ~${totalWaitMin} minutes in the merge queue (state=${prMergeState.state || "unknown"}). Check the GitHub merge queue page.`
        );
      }
    }
    if (!dryRun) {
      const remoteDelete = deleteRemoteBranch(gitBin, repoPath, branch);
      remoteName = remoteDelete.remoteName;
      remoteBranchDeleteAttempted = remoteDelete.attempted;
      remoteBranchDeleted = remoteDelete.deleted;
      remoteBranchDeleteWarning = remoteDelete.warning;
    } else {
      remoteBranchDeleted = true;
    }
    updated = forceFinalizeNonready
      ? forceUpdateManifestState(updated, STATES.MERGED, "manual_cleanup_required", {
        reason: forceFinalizeReason,
        operator: operatorName,
      })
      : updateManifestState(updated, STATES.MERGED, "manual_cleanup_required");
    updated = {
      ...updated,
      git: {
        ...(updated.git || {}),
        head_sha: currentHeadSha || reviewGate?.latestCommit || updated.review?.last_reviewed_sha || updated.git?.head_sha || null,
      },
    };
    if (!dryRun) {
      appendRunEvent(repoPath, safeData.run_id, {
        event: "merge_finalize",
        state_from: safeData.state,
        state_to: STATES.MERGED,
        head_sha: updated.git?.head_sha || null,
        round: updated.review?.rounds || null,
        reason: skipReviewReason
          ? `skip_review:${skipReviewReason}`
          : (mergeRecovered ? "already_merged" : mergeMethod),
      });
    }
  }

  const issueNumber = updated.issue?.number || null;
  if (!skipIssueClose && issueNumber) {
    if (!dryRun) {
      try {
        gh(ghBin, repoPath, "issue", "close", String(issueNumber), "--comment", `Resolved in PR #${prNumber}`);
        issueClosed = true;
      } catch (error) {
        issueCloseWarning = summarizeError(error);
      }
    }
  }

  const cleanupResult = runCleanup({
    repoRoot: repoPath,
    data: updated,
    gitBin,
    dryRun,
    deleteMergedBranch: updated.state === STATES.MERGED,
  });
  updated = cleanupResult.updatedData;
  if (!dryRun) {
    appendRunEvent(repoPath, updated.run_id, {
      event: "cleanup_result",
      state_from: updated.state,
      state_to: updated.state,
      head_sha: updated.git?.head_sha || null,
      round: updated.review?.rounds || null,
      reason: cleanupResult.summary.cleanupStatus === "succeeded"
        ? "cleanup_succeeded"
        : cleanupResult.summary.error,
    });
  }

  if (!dryRun) {
    writeManifest(manifestPath, updated, body);
  }

  const result = {
    manifestPath,
    previousState: safeData.state,
    state: updated.state,
    nextAction: updated.next_action,
    branch,
    prNumber,
    issueNumber,
    mergePerformed,
    mergeRecovered,
    prMergeState: prMergeState?.state || null,
    mergeMethod,
    remoteName,
    remoteBranchDeleteAttempted,
    remoteBranchDeleted,
    remoteBranchDeleteWarning,
    reviewGate,
    issueClosed,
    issueCloseWarning,
    cleanup: cleanupResult.summary,
    dryRun,
    forceFinalized: forceFinalizeNonready,
    forceFinalizeReason: forceFinalizeNonready ? forceFinalizeReason : null,
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Finalized relay run: ${manifestPath}`);
    console.log(`  State:        ${safeData.state} -> ${updated.state}`);
    console.log(`  Next action:  ${updated.next_action}`);
    console.log(`  Merge:        ${mergePerformed ? `performed (${mergeMethod})` : (skipMerge ? "skipped" : "already merged")}`);
    if (!skipMerge) {
      console.log(`  Remote branch:${remoteBranchDeleted ? " deleted" : (remoteBranchDeleteAttempted ? " warning" : " skipped")}`);
      if (remoteBranchDeleteWarning) console.log(`  Remote note:  ${remoteBranchDeleteWarning}`);
    }
    console.log(`  Issue close:  ${issueNumber ? (issueClosed ? "closed" : (issueCloseWarning ? `warning: ${issueCloseWarning}` : "skipped")) : "none"}`);
    console.log(`  Cleanup:      ${cleanupResult.summary.cleanupStatus}`);
    if (cleanupResult.summary.error) console.log(`  Cleanup note: ${cleanupResult.summary.error}`);
    if (dryRun) console.log("  dry-run:      no changes written");
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
