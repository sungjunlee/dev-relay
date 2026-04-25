const { execFileSync } = require("child_process");
const fs = require("fs");

const { validateManifestPaths } = require("./paths");
const { summarizeError } = require("./store");

const CLEANUP_STATUSES = Object.freeze({
  PENDING: "pending",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  SKIPPED: "skipped",
});

function nowIso() {
  return new Date().toISOString();
}

function createCleanupSkeleton() {
  return {
    status: CLEANUP_STATUSES.PENDING,
    last_attempted_at: null,
    cleaned_at: null,
    worktree_removed: false,
    branch_deleted: false,
    prune_ran: false,
    error: null,
  };
}

function validateCleanupStatus(status) {
  if (!Object.values(CLEANUP_STATUSES).includes(status)) {
    throw new Error(`Unknown relay cleanup status: ${status}`);
  }
}

function updateManifestCleanup(data, cleanupPatch = {}, nextAction = data.next_action) {
  const nextCleanup = {
    ...createCleanupSkeleton(),
    ...(data.cleanup || {}),
    ...cleanupPatch,
  };
  validateCleanupStatus(nextCleanup.status);

  return {
    ...data,
    next_action: nextAction,
    cleanup: nextCleanup,
    timestamps: {
      ...(data.timestamps || {}),
      updated_at: nowIso(),
    },
  };
}

function gitExec(gitBin, repoPath, ...gitArgs) {
  return execFileSync(gitBin, ["-C", repoPath, ...gitArgs], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function localBranchExists(gitBin, repoRoot, branch) {
  if (!branch) return false;
  try {
    gitExec(gitBin, repoRoot, "rev-parse", "--verify", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

function readWorktreeStatus(gitBin, worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { exists: false, clean: true, text: "" };
  }
  try {
    const status = execFileSync(gitBin, ["-C", worktreePath, "status", "--short", "--untracked-files=all"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    return { exists: true, clean: status === "", text: status };
  } catch (error) {
    return { exists: true, clean: false, text: `unable to inspect worktree: ${summarizeError(error)}` };
  }
}

function runCleanup({
  repoRoot,
  data,
  gitBin = "git",
  dryRun = false,
  deleteMergedBranch = false,
  acceptPrunedRelayOwned = false,
}) {
  const validatedPaths = validateManifestPaths(data?.paths, {
    expectedRepoRoot: repoRoot,
    runId: data?.run_id,
    acceptPrunedRelayOwned,
    caller: "runCleanup",
  });
  const normalizedData = {
    ...data,
    paths: {
      ...(data?.paths || {}),
      repo_root: validatedPaths.repoRoot,
      worktree: validatedPaths.worktree,
    },
  };
  const attemptedAt = nowIso();
  const worktreePath = normalizedData.paths?.worktree || null;
  const branch = normalizedData.git?.working_branch || null;
  const worktreeStatus = readWorktreeStatus(gitBin, worktreePath);
  const branchExistsBefore = localBranchExists(gitBin, repoRoot, branch);
  const errors = [];

  let worktreeRemoved = !worktreeStatus.exists;
  let branchDeleted = !deleteMergedBranch || !branch || !branchExistsBefore;
  let pruneRan = false;

  if (worktreeStatus.exists && !worktreeStatus.clean) {
    errors.push(`dirty worktree: ${worktreeStatus.text}`);
  }

  if (errors.length === 0 && worktreeStatus.exists) {
    if (!dryRun) {
      try {
        gitExec(gitBin, repoRoot, "worktree", "remove", "--force", worktreePath);
        worktreeRemoved = true;
      } catch (error) {
        errors.push(`worktree remove failed: ${summarizeError(error)}`);
      }
    }
  }

  if (errors.length === 0 && deleteMergedBranch && branch && branchExistsBefore) {
    if (!dryRun) {
      try {
        gitExec(gitBin, repoRoot, "branch", "-D", branch);
        branchDeleted = true;
      } catch (error) {
        errors.push(`branch delete failed: ${summarizeError(error)}`);
      }
    }
  }

  if (errors.length === 0) {
    if (!dryRun) {
      try {
        gitExec(gitBin, repoRoot, "worktree", "prune");
        pruneRan = true;
      } catch (error) {
        errors.push(`worktree prune failed: ${summarizeError(error)}`);
      }
    }
  }

  const cleanupStatus = errors.length === 0
    ? CLEANUP_STATUSES.SUCCEEDED
    : CLEANUP_STATUSES.FAILED;
  const cleanupError = errors.length ? errors.join("; ") : null;
  const nextAction = cleanupStatus === CLEANUP_STATUSES.SUCCEEDED
    ? "done"
    : "manual_cleanup_required";

  const updatedData = updateManifestCleanup(normalizedData, {
    status: cleanupStatus,
    last_attempted_at: attemptedAt,
    cleaned_at: cleanupStatus === CLEANUP_STATUSES.SUCCEEDED
      ? attemptedAt
      : (normalizedData.cleanup?.cleaned_at || null),
    worktree_removed: worktreeRemoved,
    branch_deleted: branchDeleted,
    prune_ran: pruneRan,
    error: cleanupError,
  }, nextAction);

  return {
    updatedData,
    summary: {
      state: data.state,
      cleanupStatus,
      nextAction,
      attemptedAt,
      dryRun,
      worktreePath,
      worktreeExistsBefore: worktreeStatus.exists,
      worktreeRemoved,
      worktreeDirty: worktreeStatus.exists && !worktreeStatus.clean,
      worktreeStatus: worktreeStatus.text || null,
      branch,
      branchExistedBefore: branchExistsBefore,
      branchDeleted,
      pruneRan,
      deleteMergedBranch,
      error: cleanupError,
    },
  };
}

module.exports = {
  CLEANUP_STATUSES,
  createCleanupSkeleton,
  runCleanup,
  updateManifestCleanup,
};
