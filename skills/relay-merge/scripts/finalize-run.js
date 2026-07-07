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
 *   --allow-stacked-base-hazard <reason>
 *                          Override non-default stacked PR base hazard block
 *   --skip-merge           Skip the PR merge step and run cleanup only
 *   --no-issue-close       Skip linked issue close
 *   --dry-run              Print what would happen without writing
 *   --json                 Output JSON
 *   --help, -h             Show usage
 */

const path = require("path");
const fs = require("fs");
const {
  getExpectedManifestRepoRoot,
  getRunDir,
  parsePositiveInt,
  summarizeFailure,
  validateManifestPaths,
} = require("../../relay-dispatch/scripts/manifest/paths");
const {
  STATES,
  forceUpdateManifestState,
  updateManifestState,
} = require("../../relay-dispatch/scripts/manifest/lifecycle");
const {
  getActorName,
  listManifestRecords,
  writeManifest,
} = require("../../relay-dispatch/scripts/manifest/store");
const { resolveManifestRecord } = require("../../relay-dispatch/scripts/relay-resolver");
const { appendRunEvent, EVENTS } = require("../../relay-dispatch/scripts/relay-events");
const { runCleanup } = require("../../relay-dispatch/scripts/manifest/cleanup");
const { execGit, execGh } = require("../../relay-dispatch/scripts/exec");
const {
  bindCliArgs,
  findUnknownFlags,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const {
  buildSkipReviewGateFailure,
  buildSkipComment,
  evaluateReviewGate,
  summarizeRubricAuditForSkip,
} = require("./review-gate");
const { STATUS: LEARNING_STATUS, appendLearnings } = require("./append-learnings");

const ALLOWED_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

const args = process.argv.slice(2);
const KNOWN_FLAGS = [
  "--repo", "--run-id", "--manifest", "--branch", "--pr", "--merge-method", "--skip-review",
  "--force-finalize-nonready", "--reason",
  "--allow-stacked-base-hazard",
  "--skip-merge", "--no-issue-close", "--dry-run", "--json", "--help", "-h",
];
const cliArgs = bindCliArgs(args, {
  commandName: "finalize-run",
  reservedFlags: KNOWN_FLAGS,
});
const helpRequested = cliArgs.hasFlag(["--help", "-h"]);

if (!args.length || helpRequested) {
  console.log("Usage: finalize-run.js (--repo <path> --run-id <id> | --repo <path> --pr <number> | --manifest <path>) [options]");
  console.log("\nMerge a ready relay run, then finalize cleanup and manifest metadata.");
  console.log("\nOptions:");
  console.log(`  --repo <path>          ${modeLabel("--repo")} Repository root (default: .)`);
  console.log(`  --run-id <id>          ${modeLabel("--run-id")} Relay run identifier`);
  console.log(`  --manifest <path>      ${modeLabel("--manifest")} Explicit manifest path`);
  console.log(`  --branch <name>        ${modeLabel("--branch")} Override branch name`);
  console.log(`  --pr <number>          ${modeLabel("--pr")} Pull request number (optional when stored in manifest)`);
  console.log(`  --merge-method <name>  ${modeLabel("--merge-method")} squash | merge | rebase (default: squash)`);
  console.log(`  --skip-review <reason> ${modeLabel("--skip-review")} Bypass the fresh-review gate with an audit reason`);
  console.log(`  --force-finalize-nonready ${modeLabel("--force-finalize-nonready")}`);
  console.log("                         Operator-only: bypass non-ready state gate");
  console.log(`  --reason <text>        ${modeLabel("--reason")} Required with --force-finalize-nonready`);
  console.log(`  --allow-stacked-base-hazard <reason> ${modeLabel("--allow-stacked-base-hazard")} Override non-default stacked PR base hazard block`);
  console.log(`  --skip-merge           ${modeLabel("--skip-merge")} Skip the PR merge step and run cleanup only`);
  console.log(`  --no-issue-close       ${modeLabel("--no-issue-close")} Skip linked issue close`);
  console.log(`  --dry-run              ${modeLabel("--dry-run")} Print what would happen without writing`);
  console.log(`  --json                 ${modeLabel("--json")} Output JSON`);
  console.log("\nReview-bypass decision tree:");
  console.log("  State is 'review_pending' + you want to skip review:     --skip-review <reason>");
  console.log("  State is 'changes_requested' + reviewer-bundle limit:    --force-finalize-nonready --reason <text>");
  console.log("  State is 'escalated' + dispatch-level failure resolved:  --force-finalize-nonready --reason <text>");
  console.log("  State is 'ready_to_merge':                               neither - just run finalize-run");
  process.exit(helpRequested ? 0 : 1);
}

function resolveBranch(repoPath, prNumber, branchArg, manifestData) {
  if (branchArg) return branchArg;
  if (manifestData?.git?.working_branch) return manifestData.git.working_branch;
  if (!prNumber) return null;
  const raw = execGh(repoPath, ["pr", "view", String(prNumber), "--json", "headRefName"]);
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

function buildMergeFinalizeReason({
  mergeMethod,
  mergeRecovered,
  skipReviewReason,
  stackedBaseGuard,
}) {
  const mergeReason = skipReviewReason
    ? `skip_review:${skipReviewReason}`
    : (mergeRecovered ? "already_merged" : mergeMethod);

  if (stackedBaseGuard?.status !== "overridden") {
    return mergeReason;
  }

  return `stacked_base_override:${stackedBaseGuard.reason};${mergeReason}`;
}

function buildStackedBaseOverrideAuditFields(stackedBaseGuard, prNumber, headSha, priorState) {
  if (stackedBaseGuard?.status !== "overridden") {
    return {};
  }

  return {
    override_class: "stacked_base_hazard",
    affected_head_sha: headSha,
    prior_state: priorState,
    required_reason: stackedBaseGuard.overrideReason,
    operator_initiated: true,
    pr_number: prNumber,
  };
}

// Fetch only the inputs the fresh review gate needs, without pulling
// statusCheckRollup/mergeable/base. Used on the already-merged retry path where
// CI, mergeability, and stacked-base checks are moot but the review marker must
// still be validated.
function fetchReviewContext(repoPath, prNumber) {
  const raw = execGh(repoPath, ["pr", "view", String(prNumber),
    "--json", "comments,commits,headRefOid"]);
  const parsed = JSON.parse(raw);
  return {
    comments: parsed.comments || [],
    commits: parsed.commits || [],
    headRefOid: parsed.headRefOid || null,
  };
}

function fetchPreMergeContext(repoPath, prNumber) {
  const raw = execGh(repoPath, ["pr", "view", String(prNumber),
    "--json", "baseRefName,comments,commits,mergeable,statusCheckRollup,headRefOid"]);
  const parsed = JSON.parse(raw);
  const checks = parsed.statusCheckRollup || [];
  return {
    baseRefName: parsed.baseRefName || null,
    comments: parsed.comments || [],
    commits: parsed.commits || [],
    mergeable: parsed.mergeable || null,
    headRefOid: parsed.headRefOid || null,
    checks,
    unsafeChecks: checks.filter(isUnsafeStatusCheck),
  };
}

// Enforce the skip-review rubric gate. Throws (after journaling MERGE_BLOCKED)
// when the operator's --skip-review is not admissible. Shared by the normal and
// already-merged finalize paths so both apply the identical audit check.
function assertSkipReviewGate(repoPath, safeData, { prNumber, currentHeadSha, dryRun, skipReviewRubricAudit }) {
  const skipReviewFailure = buildSkipReviewGateFailure(prNumber, skipReviewRubricAudit);
  if (!skipReviewFailure) {
    return;
  }
  if (!dryRun) {
    appendRunEvent(repoPath, safeData.run_id, {
      event: EVENTS.MERGE_BLOCKED,
      state_from: safeData.state,
      state_to: safeData.state,
      head_sha: currentHeadSha,
      round: safeData.review?.rounds || null,
      reason: skipReviewFailure.status,
    });
  }
  throw new Error(`Fresh review gate failed: ${skipReviewFailure.status}`);
}

// Record the operator skip-review audit trail (SKIP_REVIEW event + relay-review-skip
// PR comment) and return the skipped reviewGate. Shared by the normal and
// already-merged finalize paths so the audit is identical on both.
function recordSkipReviewAudit(repoPath, safeData, { prNumber, currentHeadSha, dryRun, skipReviewReason, skipReviewRubricStatus, skipReviewRubricAudit }) {
  if (!dryRun) {
    const skipComment = buildSkipComment(skipReviewReason, skipReviewRubricAudit);
    appendRunEvent(repoPath, safeData.run_id, {
      event: EVENTS.SKIP_REVIEW,
      state_from: safeData.state,
      state_to: safeData.state,
      head_sha: currentHeadSha,
      round: safeData.review?.rounds || null,
      reason: skipReviewReason,
      rubric_status: skipReviewRubricStatus,
    });
    execGh(repoPath, ["pr", "comment", String(prNumber), "--body", skipComment]);
  }
  return {
    status: "skipped",
    pr: prNumber,
    reason: skipReviewReason,
    rubricStatus: skipReviewRubricStatus,
    readyToMerge: safeData.state === STATES.READY_TO_MERGE,
  };
}

function normalizeStatusCheckValue(value) {
  return String(value || "").trim().toUpperCase();
}

function statusCheckName(check) {
  return check?.name || check?.context || "unknown";
}

function describeStatusCheck(check) {
  const status = normalizeStatusCheckValue(check?.status);
  const conclusion = normalizeStatusCheckValue(check?.conclusion);
  const state = normalizeStatusCheckValue(check?.state);
  const details = [];
  if (status) details.push(`status=${status}`);
  if (conclusion) details.push(`conclusion=${conclusion}`);
  if (state) details.push(`state=${state}`);
  if (!details.length) details.push("state=UNKNOWN");
  return `${statusCheckName(check)} (${details.join(", ")})`;
}

function isUnsafeStatusCheck(check) {
  const status = normalizeStatusCheckValue(check?.status);
  if (status && status !== "COMPLETED") return true;

  const conclusion = normalizeStatusCheckValue(check?.conclusion);
  if (conclusion) {
    return !ALLOWED_CHECK_CONCLUSIONS.has(conclusion);
  }

  const state = normalizeStatusCheckValue(check?.state);
  if (state) return state !== "SUCCESS";

  return true;
}

function fetchPrMergeState(repoPath, prNumber) {
  const raw = execGh(repoPath, ["pr", "view", String(prNumber), "--json", "state,mergeCommit"]);
  const parsed = JSON.parse(raw);
  return {
    state: parsed.state || null,
    mergeCommitSha: parsed.mergeCommit?.oid || null,
  };
}

function isMergedPrState(prMergeState) {
  return prMergeState?.state === "MERGED";
}

function manifestHeadShaFallback(manifestData) {
  return manifestData?.git?.head_sha || manifestData?.review?.last_reviewed_sha || null;
}

function resolveCurrentHeadSha(worktreePath, manifestData) {
  if (worktreePath && fs.existsSync(worktreePath)) {
    return execGit(worktreePath, ["rev-parse", "HEAD"]);
  }
  return manifestHeadShaFallback(manifestData);
}

function fetchDefaultBranchName(repoPath) {
  try {
    const raw = execGh(repoPath, ["repo", "view", "--json", "defaultBranchRef"]);
    const parsed = JSON.parse(raw);
    return parsed.defaultBranchRef?.name || null;
  } catch {
    return null;
  }
}

function fetchPrsForHeadBranch(repoPath, branchName) {
  try {
    const raw = execGh(repoPath, [
      "pr",
      "list",
      "--head",
      String(branchName),
      "--state",
      "all",
      "--json",
      "number,state,mergedAt,headRefName,url",
    ]);
    return JSON.parse(raw || "[]");
  } catch {
    return [];
  }
}

function normalizePrState(value) {
  return String(value || "").trim().toUpperCase();
}

function buildStackedBaseGuard(repoPath, prNumber, baseRefName, overrideReason = null) {
  if (!baseRefName) {
    return {
      status: "skipped",
      reason: "missing_base_ref",
      prNumber,
      baseRefName: null,
      defaultBranchName: null,
      basePr: null,
      overrideReason: null,
    };
  }

  const defaultBranchName = fetchDefaultBranchName(repoPath);
  if (!defaultBranchName || baseRefName === defaultBranchName) {
    return {
      status: "clear",
      reason: defaultBranchName ? "default_branch_base" : "default_branch_unknown",
      prNumber,
      baseRefName,
      defaultBranchName,
      basePr: null,
      overrideReason: null,
    };
  }

  const candidates = fetchPrsForHeadBranch(repoPath, baseRefName)
    .filter((entry) => !entry.headRefName || entry.headRefName === baseRefName);
  const merged = candidates.find((entry) => normalizePrState(entry.state) === "MERGED" || Boolean(entry.mergedAt));
  if (merged) {
    return {
      status: "clear",
      reason: "base_pr_merged",
      prNumber,
      baseRefName,
      defaultBranchName,
      basePr: {
        number: Number(merged.number),
        state: merged.state || null,
        mergedAt: merged.mergedAt || null,
        url: merged.url || null,
      },
      overrideReason: null,
    };
  }

  const selected = candidates.find((entry) => normalizePrState(entry.state) === "OPEN")
    || candidates.find((entry) => normalizePrState(entry.state) === "CLOSED")
    || candidates[0]
    || null;
  const selectedState = normalizePrState(selected?.state);
  const reason = !selected
    ? "base_pr_missing"
    : selectedState === "CLOSED"
      ? "base_pr_closed"
      : "base_pr_unmerged";
  return {
    status: overrideReason ? "overridden" : "blocked",
    reason,
    prNumber,
    baseRefName,
    defaultBranchName,
    basePr: selected
      ? {
          number: Number(selected.number),
          state: selected.state || null,
          mergedAt: selected.mergedAt || null,
          url: selected.url || null,
        }
      : null,
    overrideReason: overrideReason || null,
  };
}

function assertStackedBaseGuard(guard, prNumber) {
  if (!guard || guard.status !== "blocked") return;
  const basePrText = guard.basePr?.number
    ? `; base PR #${guard.basePr.number} is ${guard.basePr.state || "unmerged"}`
    : "; no base PR was found";
  throw new Error(
    `Stacked PR base hazard: PR #${prNumber} targets non-default base '${guard.baseRefName}' ` +
    `(default: '${guard.defaultBranchName || "unknown"}')${basePrText}. ` +
    "Merge the base PR first or rerun with --allow-stacked-base-hazard <reason>."
  );
}

function assertPreMergeSafety(preMerge, prNumber) {
  if (preMerge.mergeable === "CONFLICTING") {
    throw new Error(
      `PR #${prNumber} has merge conflicts with the base branch. Resolve conflicts and push, then retry.`
    );
  }
  if (preMerge.unsafeChecks.length > 0) {
    const names = preMerge.unsafeChecks.map(describeStatusCheck).join(", ");
    throw new Error(
      `PR #${prNumber} has non-success CI checks: ${names}. Fix these before merging.`
    );
  }
}

function resolveRemoteName(repoPath, branch) {
  if (!branch) return null;
  try {
    return execGit(repoPath, ["config", `branch.${branch}.remote`]) || "origin";
  } catch {
    return "origin";
  }
}

function hasRemote(repoPath, remoteName) {
  if (!remoteName) return false;
  try {
    execGit(repoPath, ["remote", "get-url", remoteName]);
    return true;
  } catch {
    return false;
  }
}

function remoteBranchExists(repoPath, remoteName, branch) {
  if (!remoteName || !branch) return false;
  try {
    execGit(repoPath, ["ls-remote", "--exit-code", "--heads", remoteName, branch]);
    return true;
  } catch {
    return false;
  }
}

function deleteRemoteBranch(repoPath, branch) {
  const remoteName = resolveRemoteName(repoPath, branch);
  if (!remoteName || !hasRemote(repoPath, remoteName)) {
    return {
      remoteName,
      attempted: false,
      deleted: false,
      warning: null,
    };
  }
  if (!remoteBranchExists(repoPath, remoteName, branch)) {
    return {
      remoteName,
      attempted: false,
      deleted: true,
      warning: null,
    };
  }
  try {
    execGit(repoPath, ["push", remoteName, "--delete", branch]);
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
      warning: summarizeFailure(error),
    };
  }
}

function runFinalizeCleanup({
  repoRoot,
  data,
  dryRun,
  deleteMergedBranch,
}) {
  const worktreePath = data?.paths?.worktree || null;
  const worktreeAlreadyMissing = Boolean(worktreePath) && !fs.existsSync(worktreePath);
  if (!worktreeAlreadyMissing) {
    return runCleanup({
      repoRoot,
      data,
      dryRun,
      deleteMergedBranch,
    });
  }

  const cleanupInput = {
    ...data,
    paths: {
      ...(data.paths || {}),
      worktree: null,
    },
  };
  if (!dryRun) {
    try {
      execGit(repoRoot, ["worktree", "prune"]);
    } catch {
      // runCleanup records the cleanup failure if stale registration cleanup
      // still prevents branch deletion or final pruning.
    }
  }
  const cleanupResult = runCleanup({
    repoRoot,
    data: cleanupInput,
    dryRun,
    deleteMergedBranch,
  });

  return {
    updatedData: {
      ...cleanupResult.updatedData,
      paths: {
        ...(cleanupResult.updatedData.paths || {}),
        worktree: worktreePath,
      },
    },
    summary: {
      ...cleanupResult.summary,
      worktreePath,
      worktreeExistsBefore: false,
      worktreeRemoved: true,
    },
  };
}

function hasExplicitBranchPrSelector({ manifestPath, runId, branch, prNumber }) {
  return !manifestPath && !runId && branch && prNumber !== undefined && prNumber !== null;
}

function matchesBranchPr(record, branch, prNumber) {
  return record?.data?.git?.working_branch === branch
    && Number(record?.data?.git?.pr_number || 0) === Number(prNumber);
}

// A merged run is a crash-resume target only while its finalize cleanup or
// post-merge bookkeeping is still pending. A run that completed (next_action=done
// or cleanup already succeeded) must not be re-selected — re-running it would
// duplicate post-merge side effects (remote branch delete, issue close, durable
// learnings commit).
function mergedRetryStillPending(record) {
  const data = record?.data || {};
  if (data.next_action === "done") {
    return false;
  }
  return data.cleanup?.status !== "succeeded";
}

function resolveMergedBranchPrRetryRecord({ repoRoot, branch, prNumber }) {
  const exactMatches = listManifestRecords(repoRoot)
    .filter((record) => matchesBranchPr(record, branch, prNumber));
  const mergedMatches = exactMatches
    .filter((record) => record?.data?.state === STATES.MERGED);
  const pendingMerged = mergedMatches.filter(mergedRetryStillPending);

  if (exactMatches.length === 1 && pendingMerged.length === 1) {
    return resolveManifestRecord({
      repoRoot,
      runId: pendingMerged[0].data.run_id,
    });
  }

  if (exactMatches.length > 1 && mergedMatches.length === exactMatches.length && pendingMerged.length > 1) {
    const runIds = pendingMerged
      .map((record) => record?.data?.run_id || path.basename(record?.manifestPath || "unknown", ".md"))
      .join(", ");
    throw new Error(
      `Ambiguous merged relay manifest for branch '${branch}' + pr '${prNumber}' ` +
      `(${pendingMerged.length} candidates): ${runIds}. Pass --run-id or --manifest explicitly.`
    );
  }

  return null;
}

function resolveFinalizeManifestRecord({
  repoRoot,
  manifestPath,
  runId,
  branch,
  prNumber,
  includeTerminal,
}) {
  if (hasExplicitBranchPrSelector({ manifestPath, runId, branch, prNumber })) {
    const retryRecord = resolveMergedBranchPrRetryRecord({ repoRoot, branch, prNumber });
    if (retryRecord) {
      return retryRecord;
    }
  }

  try {
    return resolveManifestRecord({
      repoRoot,
      manifestPath,
      runId,
      branch,
      prNumber,
      includeTerminal,
    });
  } catch (error) {
    if (hasExplicitBranchPrSelector({ manifestPath, runId, branch, prNumber })) {
      const retryRecord = resolveMergedBranchPrRetryRecord({ repoRoot, branch, prNumber });
      if (retryRecord) {
        return retryRecord;
      }
    }
    throw error;
  }
}

function resolveCurrentBranch(repoPath) {
  try {
    return execGit(repoPath, ["symbolic-ref", "--short", "HEAD"]);
  } catch (error) {
    return null;
  }
}

function trackedStatus(repoPath) {
  return execGit(repoPath, ["status", "--porcelain", "--untracked-files=no"]);
}

function isTrackedPath(repoPath, relativePath) {
  try {
    execGit(repoPath, ["ls-files", "--error-unmatch", "--", relativePath]);
    return true;
  } catch {
    return false;
  }
}

function learningCommitMessage(runId, prNumber) {
  return `Record relay learning for PR #${prNumber}\n\nRun: ${runId}`;
}

function appendDurableLearnings({
  repoPath,
  runId,
  prNumber,
  synthesis,
  expectedBranch,
}) {
  const dryRunResult = appendLearnings({
    repo: repoPath,
    runId,
    pr: String(prNumber),
    synthesis,
    dryRun: true,
  });
  if (dryRunResult.status !== LEARNING_STATUS.APPENDED) return dryRunResult;

  const currentBranch = resolveCurrentBranch(repoPath);
  if (!currentBranch) {
    return {
      status: LEARNING_STATUS.FAILED,
      reason: "detached_head",
      durability: { status: "not_written" },
      capabilitiesPath: dryRunResult.capabilitiesPath,
      sprintFile: dryRunResult.sprintFile,
    };
  }
  if (expectedBranch && currentBranch !== expectedBranch) {
    return {
      status: LEARNING_STATUS.FAILED,
      reason: "unexpected_branch",
      expectedBranch,
      currentBranch,
      durability: { status: "not_written" },
      capabilitiesPath: dryRunResult.capabilitiesPath,
      sprintFile: dryRunResult.sprintFile,
    };
  }
  if (!isTrackedPath(repoPath, path.join("spec", "capabilities.md"))) {
    return {
      status: LEARNING_STATUS.FAILED,
      reason: "capabilities_untracked",
      durability: { status: "not_written" },
      capabilitiesPath: dryRunResult.capabilitiesPath,
      sprintFile: dryRunResult.sprintFile,
    };
  }

  const beforeStatus = trackedStatus(repoPath);
  if (beforeStatus) {
    return {
      status: LEARNING_STATUS.FAILED,
      reason: "dirty_worktree",
      durability: { status: "not_written" },
      dirtyStatus: beforeStatus,
      capabilitiesPath: dryRunResult.capabilitiesPath,
      sprintFile: dryRunResult.sprintFile,
    };
  }

  const appendResult = appendLearnings({
    repo: repoPath,
    runId,
    pr: String(prNumber),
    synthesis,
  });
  if (appendResult.status !== LEARNING_STATUS.APPENDED) return appendResult;

  try {
    execGit(repoPath, ["add", "--", path.join("spec", "capabilities.md")]);
    execGit(repoPath, ["commit", "-m", learningCommitMessage(runId, prNumber)]);
  } catch (error) {
    return {
      ...appendResult,
      durability: {
        status: "manual_action_required",
        reason: "commit_failed",
        message: summarizeFailure(error),
      },
    };
  }

  const commitSha = execGit(repoPath, ["rev-parse", "HEAD"]);
  const remoteName = resolveRemoteName(repoPath, currentBranch);
  if (!remoteName || !hasRemote(repoPath, remoteName)) {
    return {
      ...appendResult,
      commitSha,
      currentBranch,
      remoteName,
      durability: {
        status: "manual_action_required",
        reason: "remote_missing",
      },
    };
  }

  try {
    execGit(repoPath, ["push", remoteName, currentBranch]);
    return {
      ...appendResult,
      commitSha,
      currentBranch,
      remoteName,
      durability: {
        status: "pushed",
      },
    };
  } catch (error) {
    return {
      ...appendResult,
      commitSha,
      currentBranch,
      remoteName,
      durability: {
        status: "manual_action_required",
        reason: "push_failed",
        message: summarizeFailure(error),
      },
    };
  }
}

function main() {
  const unknownFlags = findUnknownFlags(args, "finalize-run");
  if (unknownFlags.length) {
    throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  }

  const repoArg = cliArgs.getArg("--repo");
  let repoPath = path.resolve(repoArg || ".");
  const manifestArg = cliArgs.getArg("--manifest");
  const runId = cliArgs.getArg("--run-id");
  let prNumber = parsePositiveInt(cliArgs.getArg("--pr"), "--pr");
  const mergeMethod = cliArgs.getArg("--merge-method") || "squash";
  const skipReviewReason = cliArgs.getArg("--skip-review");
  const forceFinalizeNonready = cliArgs.hasFlag("--force-finalize-nonready");
  const allowStackedBaseHazard = cliArgs.hasFlag("--allow-stacked-base-hazard");
  const stackedBaseOverrideReason = allowStackedBaseHazard
    ? cliArgs.getArg("--allow-stacked-base-hazard")
    : null;
  let forceFinalizeReason;
  try {
    forceFinalizeReason = cliArgs.getArg("--reason");
  } catch (error) {
    if (forceFinalizeNonready && error.name === "CliSchemaError" && error.details?.flag === "--reason") {
      forceFinalizeReason = "";
    } else {
      throw error;
    }
  }
  const dryRun = cliArgs.hasFlag("--dry-run");
  const skipMerge = cliArgs.hasFlag("--skip-merge");
  const skipIssueClose = cliArgs.hasFlag("--no-issue-close");
  const jsonOut = cliArgs.hasFlag("--json");
  if (forceFinalizeNonready && !String(forceFinalizeReason || "").trim()) {
    throw new Error("--force-finalize-nonready requires --reason <non-empty-text>");
  }
  if (allowStackedBaseHazard && !String(stackedBaseOverrideReason || "").trim()) {
    throw new Error("--allow-stacked-base-hazard requires a non-empty reason");
  }

  let branch = cliArgs.getArg("--branch");
  let manifestRecord = resolveFinalizeManifestRecord({
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
    allowMissingWorktree: true,
    caller: "finalize-run",
  });
  repoPath = validatedPaths.repoRoot;
  if ((manifestArg || runId) && !repoArg) {
    manifestRecord = resolveFinalizeManifestRecord({
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
      allowMissingWorktree: true,
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
  branch = resolveBranch(repoPath, prNumber, branch, safeData);
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
  let stackedBaseGuard = { status: "not_checked", reason: null };
  let currentHeadSha = safeData.git?.head_sha || null;
  const skipReviewRubricAudit = summarizeRubricAuditForSkip(safeData, {
    runDir: getRunDir(validatedPaths.repoRoot, safeData.run_id),
  });
  const skipReviewRubricStatus = skipReviewRubricAudit.rubricStatus;

  if (mergeAllowed) {
    if (!dryRun) {
      prMergeState = fetchPrMergeState(repoPath, prNumber);
      if (isMergedPrState(prMergeState)) {
        mergeRecovered = true;
      }
    }
    const alreadyMerged = !dryRun && isMergedPrState(prMergeState);
    if (alreadyMerged) {
      currentHeadSha = manifestHeadShaFallback(safeData);
    } else {
      if (validatedPaths.worktreeMissing) {
        validateManifestPaths(safeData.paths, {
          expectedRepoRoot: validatedPaths.repoRoot,
          manifestPath,
          runId: safeData.run_id,
          caller: "finalize-run",
        });
      }
      currentHeadSha = resolveCurrentHeadSha(validatedPaths.worktree, safeData);
    }
    if (alreadyMerged) {
      // The PR is already in GitHub's terminal MERGED state. Retry finalization
      // must skip gates whose inputs disappear or are moot after merge (CI
      // checks, mergeability, stacked base, retained worktree HEAD). It STILL
      // runs the fresh review gate for a normal ready_to_merge finalize so a
      // stale or advanced review marker cannot be finalized silently against an
      // externally merged PR. Explicit operator overrides
      // (--force-finalize-nonready, --skip-review) keep their bypass semantics.
      if (skipReviewReason) {
        // Preserve the operator skip-review audit trail (rubric gate +
        // SKIP_REVIEW event + relay-review-skip comment) on the already-merged
        // retry, while skipping the moot CI/mergeability/stacked-base checks.
        assertSkipReviewGate(repoPath, safeData, { prNumber, currentHeadSha, dryRun, skipReviewRubricAudit });
        reviewGate = recordSkipReviewAudit(repoPath, safeData, {
          prNumber, currentHeadSha, dryRun, skipReviewReason, skipReviewRubricStatus, skipReviewRubricAudit,
        });
      } else if (!forceFinalizeNonready && safeData.state === STATES.READY_TO_MERGE) {
        const reviewContext = fetchReviewContext(repoPath, prNumber);
        reviewGate = evaluateReviewGate({
          prNumber,
          comments: reviewContext.comments,
          commits: reviewContext.commits,
          manifestData: safeData,
          expectedReviewerLogin: safeData.review?.reviewer_login || null,
          runDir: getRunDir(validatedPaths.repoRoot, safeData.run_id),
          headRefOid: reviewContext.headRefOid,
        });
        if (!reviewGate.readyToMerge) {
          if (!dryRun) {
            appendRunEvent(repoPath, safeData.run_id, {
              event: EVENTS.MERGE_BLOCKED,
              state_from: safeData.state,
              state_to: safeData.state,
              head_sha: reviewGate.latestCommit || currentHeadSha,
              round: safeData.review?.rounds || null,
              reason: reviewGate.status,
            });
          }
          throw new Error(`Fresh review gate failed: ${reviewGate.status}`);
        }
      }
    } else if (skipReviewReason) {
      assertSkipReviewGate(repoPath, safeData, { prNumber, currentHeadSha, dryRun, skipReviewRubricAudit });
      const preMerge = fetchPreMergeContext(repoPath, prNumber);
      stackedBaseGuard = buildStackedBaseGuard(
        repoPath,
        prNumber,
        preMerge.baseRefName,
        stackedBaseOverrideReason
      );
      if (stackedBaseGuard.status === "blocked" && !dryRun) {
        appendRunEvent(repoPath, safeData.run_id, {
          event: EVENTS.MERGE_BLOCKED,
          state_from: safeData.state,
          state_to: safeData.state,
          head_sha: currentHeadSha,
          round: safeData.review?.rounds || null,
          reason: `stacked_base_hazard:${stackedBaseGuard.reason}`,
        });
      }
      assertStackedBaseGuard(stackedBaseGuard, prNumber);
      reviewGate = recordSkipReviewAudit(repoPath, safeData, {
        prNumber, currentHeadSha, dryRun, skipReviewReason, skipReviewRubricStatus, skipReviewRubricAudit,
      });
    } else if (safeData.state === STATES.READY_TO_MERGE) {
      const preMerge = fetchPreMergeContext(repoPath, prNumber);
      reviewGate = evaluateReviewGate({
        prNumber,
        comments: preMerge.comments,
        commits: preMerge.commits,
        manifestData: safeData,
        expectedReviewerLogin: safeData.review?.reviewer_login || null,
        runDir: getRunDir(validatedPaths.repoRoot, safeData.run_id),
        headRefOid: preMerge.headRefOid,
      });
      if (!reviewGate.readyToMerge) {
        if (!dryRun) {
          appendRunEvent(repoPath, safeData.run_id, {
            event: EVENTS.MERGE_BLOCKED,
            state_from: safeData.state,
            state_to: safeData.state,
            head_sha: reviewGate.latestCommit || currentHeadSha,
            round: safeData.review?.rounds || null,
            reason: reviewGate.status,
          });
        }
        throw new Error(`Fresh review gate failed: ${reviewGate.status}`);
      }
      stackedBaseGuard = buildStackedBaseGuard(
        repoPath,
        prNumber,
        preMerge.baseRefName,
        stackedBaseOverrideReason
      );
      if (stackedBaseGuard.status === "blocked" && !dryRun) {
        appendRunEvent(repoPath, safeData.run_id, {
          event: EVENTS.MERGE_BLOCKED,
          state_from: safeData.state,
          state_to: safeData.state,
          head_sha: reviewGate.latestCommit || currentHeadSha,
          round: safeData.review?.rounds || null,
          reason: `stacked_base_hazard:${stackedBaseGuard.reason}`,
        });
      }
      assertStackedBaseGuard(stackedBaseGuard, prNumber);
      assertPreMergeSafety(preMerge, prNumber);
    } else if (forceFinalizeNonready) {
      const preMerge = fetchPreMergeContext(repoPath, prNumber);
      stackedBaseGuard = buildStackedBaseGuard(
        repoPath,
        prNumber,
        preMerge.baseRefName,
        stackedBaseOverrideReason
      );
      if (stackedBaseGuard.status === "blocked" && !dryRun) {
        appendRunEvent(repoPath, safeData.run_id, {
          event: EVENTS.MERGE_BLOCKED,
          state_from: safeData.state,
          state_to: safeData.state,
          head_sha: currentHeadSha,
          round: safeData.review?.rounds || null,
          reason: `stacked_base_hazard:${stackedBaseGuard.reason}`,
        });
      }
      assertStackedBaseGuard(stackedBaseGuard, prNumber);
      assertPreMergeSafety(preMerge, prNumber);
    }
  }

  if (mergeAllowed) {
    if (forceFinalizeNonready && !dryRun) {
      appendRunEvent(repoPath, safeData.run_id, {
        event: EVENTS.FORCE_FINALIZE,
        state_from: safeData.state,
        state_to: STATES.MERGED,
        head_sha: currentHeadSha,
        round: safeData.review?.rounds || null,
        reason: forceFinalizeReason,
        override_class: "force_finalize_nonready",
        affected_head_sha: currentHeadSha,
        prior_state: safeData.state,
        required_reason: forceFinalizeReason,
        operator_initiated: true,
        pr_number: prNumber,
        last_reviewed_sha: safeData.review?.last_reviewed_sha,
      });
    }

    if (!dryRun && !prMergeState) {
      prMergeState = fetchPrMergeState(repoPath, prNumber);
    }
    if (!dryRun && !isMergedPrState(prMergeState)) {
      try {
        execGh(repoPath, ["pr", "merge", String(prNumber), mergeFlag(mergeMethod)]);
        mergePerformed = true;
        prMergeState = fetchPrMergeState(repoPath, prNumber);
      } catch (error) {
        prMergeState = fetchPrMergeState(repoPath, prNumber);
        if (!isMergedPrState(prMergeState)) {
          throw error;
        }
        mergeRecovered = true;
      }
    } else if (!dryRun && isMergedPrState(prMergeState)) {
      mergeRecovered = true;
    } else if (dryRun) {
      mergePerformed = true;
    }
    // Merge queue support: if PR isn't immediately MERGED, poll for completion.
    // Repos with merge queues transition through an intermediate state before merging.
    if (!dryRun && !isMergedPrState(prMergeState)) {
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
        prMergeState = fetchPrMergeState(repoPath, prNumber);
        if (isMergedPrState(prMergeState)) break;
        if (prMergeState.state === "OPEN") {
          appendRunEvent(repoPath, safeData.run_id, {
            event: EVENTS.MERGE_BLOCKED,
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
      if (!isMergedPrState(prMergeState)) {
        appendRunEvent(repoPath, safeData.run_id, {
          event: EVENTS.MERGE_BLOCKED,
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
        event: EVENTS.MERGE_FINALIZE,
        state_from: safeData.state,
        state_to: STATES.MERGED,
        head_sha: updated.git?.head_sha || null,
        round: updated.review?.rounds || null,
        reason: buildMergeFinalizeReason({
          mergeMethod,
          mergeRecovered,
          skipReviewReason,
          stackedBaseGuard,
        }),
        ...buildStackedBaseOverrideAuditFields(
          stackedBaseGuard,
          prNumber,
          updated.git?.head_sha || currentHeadSha,
          safeData.state
        ),
      });
      writeManifest(manifestPath, updated, body);
      if (process.env.RELAY_FINALIZE_ABORT_AFTER_MERGE_WRITE) {
        throw new Error("simulated post-merge failure after merged manifest write");
      }
    }
  }

  if (!skipMerge && updated.state === STATES.MERGED) {
    if (!dryRun) {
      const remoteDelete = deleteRemoteBranch(repoPath, branch);
      remoteName = remoteDelete.remoteName;
      remoteBranchDeleteAttempted = remoteDelete.attempted;
      remoteBranchDeleted = remoteDelete.deleted;
      remoteBranchDeleteWarning = remoteDelete.warning;
    } else {
      remoteBranchDeleted = true;
    }
  }

  const issueNumber = updated.issue?.number || null;
  if (!skipIssueClose && issueNumber) {
    if (!dryRun) {
      try {
        execGh(repoPath, ["issue", "close", String(issueNumber), "--comment", `Resolved in PR #${prNumber}`]);
        issueClosed = true;
      } catch (error) {
        issueCloseWarning = summarizeFailure(error);
      }
    }
  }

  let learningsResult = null;
  if (updated.state === STATES.MERGED && !dryRun) {
    try {
      learningsResult = appendDurableLearnings({
        repoPath,
        runId: updated.run_id,
        prNumber: String(prNumber),
        synthesis: updated.issue?.title || null,
        expectedBranch: updated.git?.base_branch || null,
      });
    } catch (error) {
      learningsResult = { status: "failed", reason: "exception", message: summarizeFailure(error) };
    }
  }

  const cleanupResult = runFinalizeCleanup({
    repoRoot: repoPath,
    data: updated,
    dryRun,
    deleteMergedBranch: updated.state === STATES.MERGED,
  });
  updated = cleanupResult.updatedData;
  if (!dryRun) {
    appendRunEvent(repoPath, updated.run_id, {
      event: EVENTS.CLEANUP_RESULT,
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
    stackedBaseGuard,
    issueClosed,
    issueCloseWarning,
    cleanup: cleanupResult.summary,
    learnings: learningsResult,
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
