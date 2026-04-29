const fs = require("fs");
const path = require("path");

const { execGit } = require("../exec");
const { summarizeFailure, validateManifestPaths } = require("./paths");

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

function localBranchExists(repoRoot, branch) {
  if (!branch) return false;
  try {
    execGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function readWorktreeStatus(worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { exists: false, clean: true, text: "" };
  }
  try {
    const status = execGit(worktreePath, ["status", "--short", "--untracked-files=all"]);
    return { exists: true, clean: status === "", text: status };
  } catch (error) {
    return { exists: true, clean: false, text: `unable to inspect worktree: ${summarizeFailure(error)}` };
  }
}

function isRealpathContainedWithin(basePath, candidatePath) {
  try {
    const realBase = fs.realpathSync.native(basePath);
    const realCandidate = fs.realpathSync.native(candidatePath);
    const relative = path.relative(realBase, realCandidate);
    return relative !== ""
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function removePrunedRelayWorktreeDirectory(worktreePath, relayWorktreeBase) {
  if (!fs.existsSync(worktreePath)) {
    return true;
  }
  if (!isRealpathContainedWithin(relayWorktreeBase, worktreePath)) {
    throw new Error(`refusing rm fallback outside relay worktree base: ${worktreePath}`);
  }
  fs.rmSync(worktreePath, { recursive: true, force: true });
  return !fs.existsSync(worktreePath);
}

function runCleanup({
  repoRoot,
  data,
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
  const worktreeStatus = readWorktreeStatus(worktreePath);
  const allowPrunedRelayWorktreeRemoval = acceptPrunedRelayOwned
    && validatedPaths.prunedRelayOwnedForCleanup
    && validatedPaths.worktreeLocation === "relay_worktree";
  const branchExistsBefore = localBranchExists(repoRoot, branch);
  const errors = [];

  let worktreeRemoved = !worktreeStatus.exists;
  let branchDeleted = !deleteMergedBranch || !branch || !branchExistsBefore;
  let pruneRan = false;

  if (worktreeStatus.exists && !worktreeStatus.clean && !allowPrunedRelayWorktreeRemoval) {
    errors.push(`dirty worktree: ${worktreeStatus.text}`);
  }

  if (errors.length === 0 && worktreeStatus.exists) {
    if (!dryRun) {
      try {
        execGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
        worktreeRemoved = true;
      } catch (error) {
        if (allowPrunedRelayWorktreeRemoval) {
          try {
            worktreeRemoved = removePrunedRelayWorktreeDirectory(worktreePath, validatedPaths.relayWorktreeBase);
            if (!worktreeRemoved) {
              errors.push(`worktree remove fallback failed: ${worktreePath} still exists`);
            }
          } catch (fallbackError) {
            errors.push(
              `worktree remove failed: ${summarizeFailure(error)}; ` +
              `rm fallback failed: ${summarizeFailure(fallbackError)}`
            );
          }
        } else {
          errors.push(`worktree remove failed: ${summarizeFailure(error)}`);
        }
      }
    }
  }

  if (errors.length === 0 && deleteMergedBranch && branch && branchExistsBefore) {
    if (!dryRun) {
      try {
        execGit(repoRoot, ["branch", "-D", branch]);
        branchDeleted = true;
      } catch (error) {
        errors.push(`branch delete failed: ${summarizeFailure(error)}`);
      }
    }
  }

  if (errors.length === 0) {
    if (!dryRun) {
      try {
        execGit(repoRoot, ["worktree", "prune"]);
        pruneRan = true;
      } catch (error) {
        errors.push(`worktree prune failed: ${summarizeFailure(error)}`);
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
      worktreeDirty: worktreeStatus.exists && !worktreeStatus.clean && !allowPrunedRelayWorktreeRemoval,
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
