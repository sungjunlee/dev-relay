const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RELAY_VERSION = 2;
const NOTES_TEMPLATE = "# Notes\n\n## Context\n\n## Review History\n";

function getRelayHome() {
  const home = process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  if (!path.isAbsolute(home)) {
    throw new Error(
      `RELAY_HOME must be an absolute path, got: ${JSON.stringify(home)}. ` +
      `Either set RELAY_HOME explicitly or ensure $HOME is set.`
    );
  }
  return home;
}

function getRunsBase() {
  return process.env.RELAY_RUNS_BASE || path.join(getRelayHome(), "runs");
}

function getRepoSlug(repoRoot) {
  if (!repoRoot || typeof repoRoot !== "string") {
    throw new Error(`getRepoSlug requires a non-empty repoRoot path, got: ${JSON.stringify(repoRoot)}`);
  }
  const resolved = path.resolve(repoRoot);
  const base = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

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

function getActorName(repoRoot) {
  if (!repoRoot || typeof repoRoot !== "string") {
    return "unknown";
  }

  try {
    const actor = execFileSync("git", ["-C", repoRoot, "config", "user.name"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    return actor || "unknown";
  } catch {
    return "unknown";
  }
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

const RUN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{17}$/;
const RUN_ID_PATTERN_DESCRIPTION = "/^[a-z0-9]+(?:-[a-z0-9]+)*-\\d{17}$/";

function validateRunId(runId) {
  const normalizedRunId = typeof runId === "string" ? runId.trim() : "";
  const runIdSegments = normalizedRunId.split(/[\\/]+/).filter(Boolean);
  const buildResult = ({ valid, status, reason }) => ({
    valid,
    status,
    runId: normalizedRunId || null,
    reason,
  });

  if (!normalizedRunId) {
    return buildResult({
      valid: false,
      status: "missing_run_id",
      reason: `run_id must be set to a single path segment matching ${RUN_ID_PATTERN_DESCRIPTION} (got ${JSON.stringify(runId)}).`,
    });
  }

  if (normalizedRunId === "." || normalizedRunId === "..") {
    return buildResult({
      valid: false,
      status: "invalid_run_id",
      reason: `run_id must be a single path segment matching ${RUN_ID_PATTERN_DESCRIPTION} and may not be '.' or '..' (got ${JSON.stringify(normalizedRunId)}).`,
    });
  }

  if (runIdSegments.includes("..")) {
    return buildResult({
      valid: false,
      status: "invalid_run_id",
      reason: `run_id must be a single path segment matching ${RUN_ID_PATTERN_DESCRIPTION} and may not contain '..' segments (got ${JSON.stringify(normalizedRunId)}).`,
    });
  }

  if (normalizedRunId.includes("/")) {
    return buildResult({
      valid: false,
      status: "invalid_run_id",
      reason: `run_id must be a single path segment matching ${RUN_ID_PATTERN_DESCRIPTION} and may not contain '/' (got ${JSON.stringify(normalizedRunId)}).`,
    });
  }

  if (normalizedRunId.includes("\\")) {
    return buildResult({
      valid: false,
      status: "invalid_run_id",
      reason: `run_id must be a single path segment matching ${RUN_ID_PATTERN_DESCRIPTION} and may not contain '\\\\' (got ${JSON.stringify(normalizedRunId)}).`,
    });
  }

  if (
    path.basename(normalizedRunId) !== normalizedRunId
    || path.win32.basename(normalizedRunId) !== normalizedRunId
  ) {
    return buildResult({
      valid: false,
      status: "invalid_run_id",
      reason: `run_id must resolve to a single path segment matching ${RUN_ID_PATTERN_DESCRIPTION} (got ${JSON.stringify(normalizedRunId)}).`,
    });
  }

  if (!RUN_ID_PATTERN.test(normalizedRunId)) {
    return buildResult({
      valid: false,
      status: "invalid_run_id",
      reason: `run_id must match the shape emitted by createRunId (${RUN_ID_PATTERN_DESCRIPTION}) and remain a single path segment (got ${JSON.stringify(normalizedRunId)}).`,
    });
  }

  return buildResult({
    valid: true,
    status: "valid",
    reason: null,
  });
}

function requireValidRunId(runId) {
  const validation = validateRunId(runId);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }
  return validation.runId;
}

function createRunId({ issueNumber, branch, timestamp = new Date() } = {}) {
  const prefix = issueNumber ? `issue-${issueNumber}` : slugify(branch || "run");
  const iso = timestamp.toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  return requireValidRunId(`${prefix}-${iso}`);
}

function getRunsDir(repoRoot) {
  return path.join(getRunsBase(), getRepoSlug(repoRoot));
}

function getRunDir(repoRoot, runId) {
  return path.join(getRunsDir(repoRoot), requireValidRunId(runId));
}

function getManifestPath(repoRoot, runId) {
  return path.join(getRunsDir(repoRoot), `${requireValidRunId(runId)}.md`);
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
  try {
    fs.mkdirSync(runsDir, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
  } catch (err) {
    throw new Error(
      `Failed to create relay run directory at ${runDir}: ${err.message}. ` +
      `Set RELAY_HOME to a writable directory to override the default location (~/.relay).`
    );
  }
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

function hasRubricPath(data) {
  return typeof data?.anchor?.rubric_path === "string" && data.anchor.rubric_path.trim() !== "";
}

// TODO(2026-Q3): remove grandfather path once all pre-2026-04 runs are closed.
function isRubricGrandfathered(data) {
  return data?.anchor?.rubric_grandfathered === true;
}

function resolveRubricRunDir(data, options = {}) {
  if (options.runDir) {
    return path.resolve(options.runDir);
  }

  const repoRoot = options.repoRoot || data?.paths?.repo_root || null;
  const runId = options.runId || data?.run_id || null;
  if (!repoRoot || !runId) {
    return null;
  }
  return path.resolve(getRunDir(repoRoot, runId));
}

function validateRubricPathContainment(rubricPath, runDir) {
  const normalizedPath = typeof rubricPath === "string" ? rubricPath.trim() : "";
  const resolvedRunDir = typeof runDir === "string" && runDir.trim() !== ""
    ? path.resolve(runDir)
    : null;
  const segments = normalizedPath.split(/[\\/]+/).filter(Boolean);
  const containsParentTraversal = segments.includes("..");
  const absolute = normalizedPath ? path.isAbsolute(normalizedPath) : false;
  const resolvedPath = normalizedPath && resolvedRunDir
    ? path.resolve(resolvedRunDir, normalizedPath)
    : null;
  const insideRunDir = Boolean(
    resolvedRunDir &&
    resolvedPath &&
    resolvedPath !== resolvedRunDir &&
    resolvedPath.startsWith(`${resolvedRunDir}${path.sep}`)
  );

  if (!normalizedPath) {
    return {
      valid: false,
      status: "missing_path",
      rubricPath: null,
      runDir: resolvedRunDir,
      resolvedPath: null,
      reason: "anchor.rubric_path is not set.",
    };
  }

  if (!resolvedRunDir) {
    return {
      valid: false,
      status: "run_dir_unavailable",
      rubricPath: normalizedPath,
      runDir: null,
      resolvedPath: null,
      reason: `Unable to resolve the run directory for anchor.rubric_path=${JSON.stringify(normalizedPath)}.`,
    };
  }

  if (absolute) {
    return {
      valid: false,
      status: "outside_run_dir",
      rubricPath: normalizedPath,
      runDir: resolvedRunDir,
      resolvedPath,
      reason: `anchor.rubric_path must resolve inside the run directory; absolute paths are not allowed (got ${JSON.stringify(normalizedPath)}).`,
    };
  }

  if (containsParentTraversal) {
    return {
      valid: false,
      status: "outside_run_dir",
      rubricPath: normalizedPath,
      runDir: resolvedRunDir,
      resolvedPath,
      reason: `anchor.rubric_path must resolve inside the run directory and may not contain '..' segments (got ${JSON.stringify(normalizedPath)}).`,
    };
  }

  if (!insideRunDir) {
    return {
      valid: false,
      status: "outside_run_dir",
      rubricPath: normalizedPath,
      runDir: resolvedRunDir,
      resolvedPath,
      reason: `anchor.rubric_path must resolve inside the run directory ${JSON.stringify(resolvedRunDir)} (got ${JSON.stringify(normalizedPath)} -> ${JSON.stringify(resolvedPath)}).`,
    };
  }

  return {
    valid: true,
    status: "contained",
    rubricPath: normalizedPath,
    runDir: resolvedRunDir,
    resolvedPath,
    reason: null,
  };
}

function getRubricAnchorStatus(data, options = {}) {
  const rubricPath = hasRubricPath(data) ? data.anchor.rubric_path.trim() : null;
  const grandfathered = isRubricGrandfathered(data);
  const runDir = resolveRubricRunDir(data, options);
  const baseStatus = {
    status: "missing_path",
    rubricPath,
    runDir,
    resolvedPath: null,
    grandfathered,
    satisfied: false,
    exists: false,
    empty: false,
    content: null,
    note: null,
    error: null,
  };

  // Grandfathering is an explicit legacy-run override. If both fields are present,
  // keep the run on the grandfathered path rather than reinterpreting it mid-flight.
  if (grandfathered) {
    return {
      ...baseStatus,
      status: "grandfathered",
      satisfied: true,
      note: "Grandfathered pre-rubric run: merge/review gates are allowing missing anchor.rubric_path because anchor.rubric_grandfathered=true.",
    };
  }

  if (!rubricPath) {
    return {
      ...baseStatus,
      error: "anchor.rubric_path is required before review/merge unless anchor.rubric_grandfathered=true.",
    };
  }

  const containment = validateRubricPathContainment(rubricPath, runDir);
  if (!containment.valid) {
    return {
      ...baseStatus,
      ...containment,
      status: containment.status,
      error: containment.reason,
    };
  }

  try {
    const stat = fs.statSync(containment.resolvedPath);
    if (!stat.isFile()) {
      return {
        ...baseStatus,
        ...containment,
        status: "not_file",
        error: `anchor.rubric_path must point to a file inside the run directory (got ${JSON.stringify(containment.resolvedPath)}).`,
      };
    }

    const content = fs.readFileSync(containment.resolvedPath, "utf-8");
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      return {
        ...baseStatus,
        ...containment,
        status: "empty",
        exists: true,
        empty: true,
        error: `rubric file is empty: ${containment.resolvedPath}`,
      };
    }

    return {
      ...baseStatus,
      ...containment,
      status: "satisfied",
      satisfied: true,
      exists: true,
      content: options.includeContent ? trimmedContent : null,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ...baseStatus,
        ...containment,
        status: "missing",
        error: `rubric file is missing from the run directory: ${containment.resolvedPath}`,
      };
    }

    return {
      ...baseStatus,
      ...containment,
      status: "unreadable",
      error: `Unable to read rubric file ${containment.resolvedPath}: ${summarizeError(error)}`,
    };
  }
}

function validateTransitionInvariants(data, fromState, toState) {
  if (fromState === STATES.DISPATCHED && toState === STATES.REVIEW_PENDING) {
    const rubricAnchor = getRubricAnchorStatus(data);
    if (!rubricAnchor.satisfied) {
      throw new Error(
        `Cannot transition dispatched -> review_pending because ${rubricAnchor.error} ` +
        "Generate the rubric with relay-plan and dispatch with --rubric-file, " +
        "or explicitly grandfather a pre-change run with anchor.rubric_grandfathered: true."
      );
    }
  }
}

function updateManifestState(data, toState, nextAction) {
  validateTransition(data.state, toState);
  validateTransitionInvariants(data, data.state, toState);
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
  environment = null,
  requestId = null,
  leafId = null,
  doneCriteriaPath = null,
  doneCriteriaSource = null,
}) {
  const createdAt = nowIso();
  const normalizedRunId = requireValidRunId(runId);

  const manifest = {
    relay_version: RELAY_VERSION,
    run_id: normalizedRunId,
    state: STATES.DRAFT,
    next_action: "start_dispatch",
    actor: {
      name: getActorName(repoRoot),
    },
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
      done_criteria_source: doneCriteriaSource || (issueNumber ? "issue" : "unknown"),
      rubric_source: "manifest",
      ...(doneCriteriaPath ? { done_criteria_path: doneCriteriaPath } : {}),
    },
    review: {
      rounds: 0,
      max_rounds: 20,
      latest_verdict: "pending",
      repeated_issue_count: 0,
      last_reviewed_sha: null,
    },
    cleanup: createCleanupSkeleton(),
    environment: environment || {
      node_version: null,
      main_sha: null,
      lockfile_hash: null,
      dispatch_ts: null,
    },
    timestamps: {
      created_at: createdAt,
      updated_at: createdAt,
    },
  };

  if (requestId || leafId) {
    manifest.source = {
      ...(requestId ? { request_id: requestId } : {}),
      ...(leafId ? { leaf_id: leafId } : {}),
    };
  }

  return manifest;
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

// ---------------------------------------------------------------------------
// Previous attempts (stored as JSON in the run directory)
// ---------------------------------------------------------------------------

function getAttemptsPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), "previous-attempts.json");
}

function readPreviousAttempts(repoRoot, runId) {
  const attemptsPath = getAttemptsPath(repoRoot, runId);
  if (!fs.existsSync(attemptsPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(attemptsPath, "utf-8"));
  } catch {
    console.error(`Warning: corrupted previous-attempts.json at ${attemptsPath}, ignoring`);
    return [];
  }
}

function captureAttempt(repoRoot, runId, attemptData) {
  if (!runId) {
    throw new Error("run_id is required to capture an attempt");
  }
  if (!attemptData || typeof attemptData !== "object") {
    throw new Error("attemptData must be an object");
  }

  ensureRunLayout(repoRoot, runId);
  const attempts = readPreviousAttempts(repoRoot, runId);
  const record = {
    dispatch_number: attempts.length + 1,
    timestamp: attemptData.timestamp || nowIso(),
    score_log: attemptData.score_log || null,
    reviewer_feedback: attemptData.reviewer_feedback || null,
    failed_approaches: attemptData.failed_approaches || [],
  };
  attempts.push(record);
  fs.writeFileSync(getAttemptsPath(repoRoot, runId), JSON.stringify(attempts, null, 2), "utf-8");
  return record;
}

function formatAttemptsForPrompt(attempts) {
  if (!attempts || attempts.length === 0) return "";

  const sections = attempts.map((attempt) => {
    const lines = [`## Previous Attempt (dispatch #${attempt.dispatch_number})`];
    if (attempt.score_log) {
      lines.push("", "### Score Log", attempt.score_log);
    }
    if (attempt.reviewer_feedback) {
      lines.push("", "### Reviewer Feedback", attempt.reviewer_feedback);
    }
    if (attempt.failed_approaches && attempt.failed_approaches.length > 0) {
      lines.push("", "### Do NOT Repeat");
      attempt.failed_approaches.forEach((a) => lines.push(`- ${a}`));
    }
    return lines.join("\n");
  });

  return sections.join("\n\n") + "\n\n";
}

function collectEnvironmentSnapshot(repoRoot, baseBranch) {
  let mainSha = null;
  try {
    mainSha = execFileSync(
      "git", ["-C", repoRoot, "rev-parse", `origin/${baseBranch}`],
      { encoding: "utf-8", stdio: "pipe" }
    ).trim();
  } catch {}

  let lockfileHash = null;
  const lockfilePath = path.join(repoRoot, "package-lock.json");
  try {
    const content = fs.readFileSync(lockfilePath);
    lockfileHash = "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
  } catch {}

  return {
    node_version: process.version,
    main_sha: mainSha,
    lockfile_hash: lockfileHash,
    dispatch_ts: nowIso(),
  };
}

const ENVIRONMENT_COMPARE_FIELDS = ["node_version", "main_sha", "lockfile_hash"];

function compareEnvironmentSnapshot(baseline, current) {
  if (!baseline || !current) return [];
  const drift = [];
  for (const field of ENVIRONMENT_COMPARE_FIELDS) {
    const from = baseline[field] ?? null;
    const to = current[field] ?? null;
    if (from === null && to === null) continue;
    if (from !== to) drift.push({ field, from, to });
  }
  return drift;
}

module.exports = {
  ALLOWED_TRANSITIONS,
  CLEANUP_STATUSES,
  NOTES_TEMPLATE,
  RELAY_VERSION,
  STATES,
  captureAttempt,
  collectEnvironmentSnapshot,
  compareEnvironmentSnapshot,
  createCleanupSkeleton,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  formatAttemptsForPrompt,
  getRubricAnchorStatus,
  getActorName,
  getAttemptsPath,
  getEventsPath,
  getManifestPath,
  getRelayHome,
  getRepoSlug,
  getRunDir,
  getRunsBase,
  getRunsDir,
  hasRubricPath,
  inferIssueNumber,
  isRubricGrandfathered,
  isTerminalState,
  listManifestRecords,
  listManifestPaths,
  parseFrontmatter,
  readManifest,
  readPreviousAttempts,
  runCleanup,
  summarizeError,
  updateManifestCleanup,
  updateManifestState,
  validateRubricPathContainment,
  validateRunId,
  validateTransition,
  validateTransitionInvariants,
  writeManifest,
};
