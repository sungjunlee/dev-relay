const { execFileSync } = require("child_process");
const fs = require("fs");
const {
  CLEANUP_STATUSES,
  STATES,
  updateManifestCleanup,
} = require("./relay-manifest");

function nowIso() {
  return new Date().toISOString();
}

function summarizeError(error) {
  const stderr = String(error.stderr || "").trim();
  const stdout = String(error.stdout || "").trim();
  return stderr || stdout || error.message;
}

function git(gitBin, repoPath, ...gitArgs) {
  return execFileSync(gitBin, ["-C", repoPath, ...gitArgs], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function localBranchExists(gitBin, repoRoot, branch) {
  if (!branch) return false;
  try {
    git(gitBin, repoRoot, "rev-parse", "--verify", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

function readWorktreeStatus(gitBin, worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return {
      exists: false,
      clean: true,
      text: "",
    };
  }

  try {
    const status = execFileSync(gitBin, ["-C", worktreePath, "status", "--short", "--untracked-files=all"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    return {
      exists: true,
      clean: status === "",
      text: status,
    };
  } catch (error) {
    return {
      exists: true,
      clean: false,
      text: `unable to inspect worktree: ${summarizeError(error)}`,
    };
  }
}

function runCleanup({ repoRoot, data, gitBin = "git", dryRun = false, deleteMergedBranch = false }) {
  const attemptedAt = nowIso();
  const worktreePath = data.paths?.worktree || null;
  const branch = data.git?.working_branch || null;
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
        git(gitBin, repoRoot, "worktree", "remove", "--force", worktreePath);
        worktreeRemoved = true;
      } catch (error) {
        errors.push(`worktree remove failed: ${summarizeError(error)}`);
      }
    }
  }

  if (errors.length === 0 && deleteMergedBranch && branch && branchExistsBefore) {
    if (!dryRun) {
      try {
        git(gitBin, repoRoot, "branch", "-D", branch);
        branchDeleted = true;
      } catch (error) {
        errors.push(`branch delete failed: ${summarizeError(error)}`);
      }
    }
  }

  if (errors.length === 0) {
    if (!dryRun) {
      try {
        git(gitBin, repoRoot, "worktree", "prune");
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

  const updatedData = updateManifestCleanup(data, {
    status: cleanupStatus,
    last_attempted_at: attemptedAt,
    cleaned_at: cleanupStatus === CLEANUP_STATUSES.SUCCEEDED
      ? attemptedAt
      : (data.cleanup?.cleaned_at || null),
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

function isTerminalState(state) {
  return state === STATES.MERGED || state === STATES.CLOSED;
}

module.exports = {
  isTerminalState,
  localBranchExists,
  readWorktreeStatus,
  runCleanup,
  summarizeError,
};
