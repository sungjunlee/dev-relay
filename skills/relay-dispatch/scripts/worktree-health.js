"use strict";

const fs = require("fs");

const { execGit, execGh } = require("./exec");
const { isTerminalState } = require("./manifest/lifecycle");

const DEFAULT_STALE_DAYS = 14;

const RELAY_OWNED_STRAY_WORKTREE_STATUS_LINES = Object.freeze([
  "?? rubric.yaml",
]);

const FINISH_PATHS = Object.freeze({
  CLEANUP_TERMINAL: "cleanup_terminal",
  RECONCILE_MERGED: "reconcile_merged",
  RETAIN_PR_HANDOFF: "retain_pr_handoff",
  RETAIN_ACTIVE: "retain_active",
  STALE_OPEN: "stale_open",
  MANUAL_REQUIRED: "manual_required",
});

function readWorktreeDirty(worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { exists: false, dirty: false, dirtyFileCount: 0, text: "", relayOwnedStrayOnly: false };
  }
  try {
    const text = execGit(worktreePath, ["status", "--short", "--untracked-files=all"]);
    const lines = String(text || "").split(/\r?\n/).filter(Boolean);
    const relayOwnedStrayOnly = lines.length === 1
      && RELAY_OWNED_STRAY_WORKTREE_STATUS_LINES.includes(lines[0]);
    return {
      exists: true,
      dirty: text !== "",
      dirtyFileCount: lines.length,
      text,
      relayOwnedStrayOnly,
    };
  } catch (error) {
    return {
      exists: true,
      dirty: true,
      dirtyFileCount: -1,
      text: String(error.message || error),
      relayOwnedStrayOnly: false,
    };
  }
}

function branchExists(repoRoot, branch) {
  if (!branch) return false;
  try {
    execGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function isBranchMergedIntoBase(repoRoot, branch, baseBranch) {
  if (!branch || !baseBranch || branch === baseBranch) {
    return branch === baseBranch;
  }
  if (!branchExists(repoRoot, branch)) {
    return false;
  }
  try {
    const mergedRaw = execGit(repoRoot, ["branch", "--merged", baseBranch]);
    const mergedBranches = mergedRaw
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\* /, ""))
      .filter(Boolean);
    if (mergedBranches.includes(branch)) {
      return true;
    }
  } catch {
    // fall through to ancestry check
  }
  try {
    execGit(repoRoot, ["merge-base", "--is-ancestor", branch, baseBranch]);
    return true;
  } catch {
    return false;
  }
}

function readLastCommitAgeDays(repoRoot, branch) {
  if (!branch || !branchExists(repoRoot, branch)) {
    return -1;
  }
  try {
    const epochRaw = execGit(repoRoot, ["log", "-1", "--format=%ct", branch]);
    const epoch = Number(epochRaw);
    if (!Number.isFinite(epoch) || epoch <= 0) {
      return -1;
    }
    return (Date.now() / 1000 - epoch) / 86400;
  } catch {
    return -1;
  }
}

function readUnpushedCommits(repoRoot, branch) {
  if (!branch || !branchExists(repoRoot, branch)) {
    return 0;
  }
  try {
    const raw = execGit(repoRoot, ["rev-list", "--count", `${branch}@{upstream}..${branch}`]);
    const count = Number(raw);
    return Number.isFinite(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

function readPrMergedAt(repoRoot, prNumber) {
  if (!prNumber) {
    return { prMerged: false, prState: null, prMergedAt: null };
  }
  try {
    const raw = execGh(repoRoot, [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "mergedAt,state",
    ]);
    const parsed = JSON.parse(raw);
    return {
      prMerged: Boolean(parsed.mergedAt),
      prState: parsed.state || null,
      prMergedAt: parsed.mergedAt || null,
    };
  } catch {
    return { prMerged: false, prState: null, prMergedAt: null };
  }
}

function inferFinishPath({ state, prNumber, health }) {
  const terminal = isTerminalState(state);

  if (terminal) {
    return health.safeToRemove ? FINISH_PATHS.CLEANUP_TERMINAL : FINISH_PATHS.MANUAL_REQUIRED;
  }

  if (health.reconcileEligible) {
    return FINISH_PATHS.RECONCILE_MERGED;
  }

  if (state === "ready_to_merge" && prNumber) {
    return FINISH_PATHS.RETAIN_PR_HANDOFF;
  }

  if (health.stale) {
    return FINISH_PATHS.STALE_OPEN;
  }

  if (health.dirty && !health.relayOwnedStrayOnly) {
    return FINISH_PATHS.MANUAL_REQUIRED;
  }

  return FINISH_PATHS.RETAIN_ACTIVE;
}

function buildRecommendedAction({ finishPath, runId, repoRoot }) {
  const repoArg = JSON.stringify(repoRoot);
  const runArg = JSON.stringify(runId);

  switch (finishPath) {
    case FINISH_PATHS.CLEANUP_TERMINAL:
      return "cleanup-worktrees (terminal run)";
    case FINISH_PATHS.RECONCILE_MERGED:
      return `finalize-run --repo ${repoArg} --run-id ${runArg} (preferred); or cleanup-worktrees --reconcile-merged --repo ${repoArg} --dry-run first (disk recovery only)`;
    case FINISH_PATHS.RETAIN_PR_HANDOFF:
      return `retain worktree until merge/finalize; then finalize-run --run-id ${runArg}`;
    case FINISH_PATHS.STALE_OPEN:
      return `close-run.js --repo ${repoArg} --run-id ${runArg} --reason "stale_non_terminal_run"`;
    case FINISH_PATHS.MANUAL_REQUIRED:
      return "inspect dirty worktree or manifest paths before cleanup";
    default:
      return "no cleanup action";
  }
}

function assessRunWorktreeHealth({
  repoRoot,
  data,
  worktreePath = data?.paths?.worktree || null,
  staleDays = DEFAULT_STALE_DAYS,
}) {
  const branch = data?.git?.working_branch || null;
  const baseBranch = data?.git?.base_branch || "main";
  const prNumber = data?.git?.pr_number || null;
  const dirtyStatus = readWorktreeDirty(worktreePath);
  const mergedIntoBase = isBranchMergedIntoBase(repoRoot, branch, baseBranch);
  const prStatus = readPrMergedAt(repoRoot, prNumber);
  const mergedIntoBaseOrPr = mergedIntoBase || prStatus.prMerged;
  const lastCommitAgeDays = readLastCommitAgeDays(repoRoot, branch);
  const unpushedCommits = readUnpushedCommits(repoRoot, branch);
  const stale = !mergedIntoBaseOrPr
    && lastCommitAgeDays >= staleDays;
  const effectivelyClean = !dirtyStatus.dirty || dirtyStatus.relayOwnedStrayOnly;
  const safeToRemove = mergedIntoBaseOrPr && effectivelyClean;
  const reconcileEligible = data?.state === "ready_to_merge"
    && mergedIntoBaseOrPr
    && effectivelyClean;

  const health = {
    mergedIntoBase,
    prMerged: prStatus.prMerged,
    prState: prStatus.prState,
    prMergedAt: prStatus.prMergedAt,
    mergedIntoBaseOrPr,
    dirty: dirtyStatus.dirty,
    dirtyFileCount: dirtyStatus.dirtyFileCount,
    relayOwnedStrayOnly: dirtyStatus.relayOwnedStrayOnly,
    unpushedCommits,
    lastCommitAgeDays,
    stale,
    safeToRemove,
    reconcileEligible,
    worktreeExists: dirtyStatus.exists,
  };

  const finishPath = inferFinishPath({ state: data?.state, prNumber, health });
  return {
    ...health,
    finishPath,
    recommendedAction: buildRecommendedAction({
      finishPath,
      runId: data?.run_id,
      repoRoot,
    }),
  };
}

module.exports = {
  DEFAULT_STALE_DAYS,
  FINISH_PATHS,
  assessRunWorktreeHealth,
  buildRecommendedAction,
  inferFinishPath,
  isBranchMergedIntoBase,
  readWorktreeDirty,
};
