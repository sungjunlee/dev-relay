const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const RELAY_VERSION = 2;
const RUNS_DIR = path.join(".relay", "runs");
const NOTES_TEMPLATE = "# Notes\n\n## Context\n\n## Review History\n";

const STATES = Object.freeze({
  DRAFT: "draft",
  DISPATCHED: "dispatched",
  REVIEW_PENDING: "review_pending",
  CHANGES_REQUESTED: "changes_requested",
  READY_TO_MERGE: "ready_to_merge",
  MERGED: "merged",
  ESCALATED: "escalated",
  CLOSED: "closed",
});

const CLEANUP_STATUSES = Object.freeze({
  PENDING: "pending",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  SKIPPED: "skipped",
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.DRAFT]: new Set([STATES.DISPATCHED, STATES.CLOSED]),
  [STATES.DISPATCHED]: new Set([STATES.REVIEW_PENDING, STATES.ESCALATED, STATES.CLOSED]),
  [STATES.REVIEW_PENDING]: new Set([STATES.CHANGES_REQUESTED, STATES.READY_TO_MERGE, STATES.ESCALATED, STATES.CLOSED]),
  [STATES.CHANGES_REQUESTED]: new Set([STATES.DISPATCHED, STATES.CLOSED]),
  [STATES.READY_TO_MERGE]: new Set([STATES.MERGED, STATES.CLOSED]),
  [STATES.ESCALATED]: new Set([STATES.CLOSED]),
  [STATES.MERGED]: new Set(),
  [STATES.CLOSED]: new Set(),
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

function slugify(value) {
  return String(value || "run")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "run";
}

function inferIssueNumber(branch) {
  const match = String(branch || "").match(/(?:^|\/)issue-(\d+)(?:$|[-/])/);
  return match ? Number(match[1]) : null;
}

function createRunId({ issueNumber, branch, timestamp = new Date() } = {}) {
  const prefix = issueNumber ? `issue-${issueNumber}` : slugify(branch || "run");
  const iso = timestamp.toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  return `${prefix}-${iso}`;
}

function getRunsDir(repoRoot) {
  return path.join(repoRoot, RUNS_DIR);
}

function getRunDir(repoRoot, runId) {
  return path.join(getRunsDir(repoRoot), runId);
}

function getManifestPath(repoRoot, runId) {
  return path.join(getRunsDir(repoRoot), `${runId}.md`);
}

function getEventsPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), "events.jsonl");
}

function listManifestPaths(repoRoot) {
  const runsDir = getRunsDir(repoRoot);
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(runsDir, name));
}

function ensureRunLayout(repoRoot, runId) {
  const runsDir = getRunsDir(repoRoot);
  const runDir = getRunDir(repoRoot, runId);
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  return { runsDir, runDir, manifestPath: getManifestPath(repoRoot, runId) };
}

function parseScalar(value) {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  return value;
}

function parseFrontmatter(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") {
    return { data: {}, body: text };
  }

  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) {
    throw new Error("Invalid manifest: missing closing frontmatter marker");
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const body = lines.slice(closingIndex + 1).join("\n");

  function parseBlock(startIndex, indent) {
    const data = {};
    let index = startIndex;

    while (index < frontmatterLines.length) {
      const raw = frontmatterLines[index];
      if (!raw.trim()) {
        index += 1;
        continue;
      }

      const currentIndent = raw.match(/^ */)[0].length;
      if (currentIndent < indent) break;
      if (currentIndent > indent) {
        throw new Error(`Invalid manifest indentation on line ${index + 2}`);
      }

      const trimmed = raw.trim();
      if (trimmed.startsWith("- ")) {
        throw new Error("Array syntax is not supported in relay manifest frontmatter");
      }

      const separator = trimmed.indexOf(":");
      if (separator === -1) {
        throw new Error(`Invalid manifest entry on line ${index + 2}`);
      }

      const key = trimmed.slice(0, separator).trim();
      const rest = trimmed.slice(separator + 1).trim();

      if (!rest) {
        const nested = parseBlock(index + 1, indent + 2);
        data[key] = nested.data;
        index = nested.index;
        continue;
      }

      data[key] = parseScalar(rest);
      index += 1;
    }

    return { data, index };
  }

  return { data: parseBlock(0, 0).data, body };
}

function formatScalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string" && value.includes("\n")) {
    return JSON.stringify(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function toFrontmatter(data, indent = 0) {
  return Object.entries(data)
    .map(([key, value]) => {
      const prefix = " ".repeat(indent);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return `${prefix}${key}:\n${toFrontmatter(value, indent + 2)}`;
      }
      return `${prefix}${key}: ${formatScalar(value)}`;
    })
    .join("\n");
}

function writeManifest(manifestPath, data, body = NOTES_TEMPLATE) {
  const dir = path.dirname(manifestPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${manifestPath}.tmp.${process.pid}`;
  const content = `---\n${toFrontmatter(data)}\n---\n${body.endsWith("\n") ? body : `${body}\n`}`;
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, manifestPath);
}

function readManifest(manifestPath) {
  const text = fs.readFileSync(manifestPath, "utf-8");
  const result = parseFrontmatter(text);
  // v1 → v2 migration: roles.worker → roles.executor
  if (result.data?.roles && "worker" in result.data.roles && !("executor" in result.data.roles)) {
    result.data.roles.executor = result.data.roles.worker;
    delete result.data.roles.worker;
  }
  return result;
}

function sortKeyForManifest({ data, manifestPath }) {
  return data?.timestamps?.updated_at || data?.timestamps?.created_at || path.basename(manifestPath);
}

function listManifestRecords(repoRoot) {
  return listManifestPaths(repoRoot)
    .map((manifestPath) => ({ manifestPath, ...readManifest(manifestPath) }))
    .sort((left, right) => sortKeyForManifest(right).localeCompare(sortKeyForManifest(left)));
}

function validateTransition(fromState, toState) {
  if (!Object.values(STATES).includes(fromState)) {
    throw new Error(`Unknown relay state: ${fromState}`);
  }
  if (!Object.values(STATES).includes(toState)) {
    throw new Error(`Unknown relay state: ${toState}`);
  }
  if (!ALLOWED_TRANSITIONS[fromState].has(toState)) {
    throw new Error(`Invalid relay state transition: ${fromState} -> ${toState}`);
  }
}

function updateManifestState(data, toState, nextAction) {
  validateTransition(data.state, toState);
  return {
    ...data,
    state: toState,
    next_action: nextAction,
    timestamps: {
      ...(data.timestamps || {}),
      updated_at: nowIso(),
    },
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

function createManifestSkeleton({
  repoRoot,
  runId,
  branch,
  baseBranch,
  issueNumber,
  worktreePath,
  orchestrator = "unknown",
  executor = "unknown",
  reviewer = "unknown",
  mergePolicy = "manual_after_lgtm",
  cleanupPolicy = "on_close",
  reviewerWritePolicy = "forbid",
}) {
  const createdAt = nowIso();

  return {
    relay_version: RELAY_VERSION,
    run_id: runId,
    state: STATES.DRAFT,
    next_action: "start_dispatch",
    issue: {
      number: issueNumber,
      source: issueNumber ? "github" : "unknown",
    },
    git: {
      base_branch: baseBranch,
      working_branch: branch,
      pr_number: null,
      head_sha: null,
    },
    roles: {
      orchestrator,
      executor,
      reviewer,
    },
    paths: {
      repo_root: repoRoot,
      worktree: worktreePath,
    },
    policy: {
      merge: mergePolicy,
      cleanup: cleanupPolicy,
      reviewer_write: reviewerWritePolicy,
    },
    anchor: {
      done_criteria_source: issueNumber ? "issue" : "unknown",
      rubric_source: "manifest",
    },
    review: {
      rounds: 0,
      max_rounds: 20,
      latest_verdict: "pending",
      repeated_issue_count: 0,
      last_reviewed_sha: null,
    },
    cleanup: createCleanupSkeleton(),
    timestamps: {
      created_at: createdAt,
      updated_at: createdAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Cleanup operations (consolidated from relay-cleanup.js)
// ---------------------------------------------------------------------------

function summarizeError(error) {
  const stderr = String(error.stderr || "").trim();
  const stdout = String(error.stdout || "").trim();
  return stderr || stdout || error.message;
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

function isTerminalState(state) {
  return state === STATES.MERGED || state === STATES.CLOSED;
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

module.exports = {
  ALLOWED_TRANSITIONS,
  CLEANUP_STATUSES,
  NOTES_TEMPLATE,
  RELAY_VERSION,
  RUNS_DIR,
  STATES,
  createCleanupSkeleton,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  getEventsPath,
  getManifestPath,
  getRunDir,
  getRunsDir,
  inferIssueNumber,
  isTerminalState,
  listManifestRecords,
  listManifestPaths,
  parseFrontmatter,
  readManifest,
  runCleanup,
  summarizeError,
  updateManifestCleanup,
  updateManifestState,
  validateTransition,
  writeManifest,
};
