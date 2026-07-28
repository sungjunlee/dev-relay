const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ensureRunLayout,
  listManifestPaths,
  nowIso,
  requireValidFleetId,
  requireValidRunId,
} = require("./paths");
const {
  normalizeReviewAssurance,
  normalizeReviewAssuranceSource,
  reviewRoundLimitForAssurance,
} = require("./review-assurance");
const { normalizeOwnership } = require("../ownership");

const RELAY_VERSION = 2;
const NOTES_TEMPLATE = "# Notes\n\n## Context\n\n## Review History\n";
const MANIFEST_LOCK_NAME = ".coordination_marker.lock";
const DEFAULT_MANIFEST_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_MANIFEST_LOCK_POLL_MS = 50;
const DEFAULT_MANIFEST_LOCK_STALE_MS = 1000;
const LOCK_WAIT_STATE = new Int32Array(new SharedArrayBuffer(4));

function positiveEnv(name, fallback, aliases = []) {
  const names = [name, ...aliases];
  for (const candidate of names) {
    const parsed = Number.parseInt(process.env[candidate] || "", 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function getManifestLockPath(manifestPath) {
  if (typeof manifestPath !== "string" || !manifestPath.trim()) {
    throw new Error("manifestPath is required for the manifest lock");
  }
  const manifestName = path.basename(manifestPath);
  const runId = manifestName.endsWith(".md") ? manifestName.slice(0, -3) : manifestName;
  return path.join(path.dirname(manifestPath), runId, MANIFEST_LOCK_NAME);
}

function readLockOwner(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    } catch {}
    return { stat, owner };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function lockIsAbandoned(lockPath) {
  const observed = readLockOwner(lockPath);
  if (!observed) return false;
  const staleMs = positiveEnv(
    "RELAY_MANIFEST_LOCK_STALE_MS",
    DEFAULT_MANIFEST_LOCK_STALE_MS,
    ["RELAY_COORDINATION_MARKER_LOCK_STALE_MS"],
  );
  if (Date.now() - observed.stat.mtimeMs < staleMs) return false;

  const owner = observed.owner;
  if (owner && owner.host === os.hostname() && Number.isInteger(owner.pid)) {
    return !isProcessAlive(owner.pid);
  }
  // A malformed or foreign-host lock has no live-owner proof. The lease age is
  // the bounded recovery contract for those crash leftovers.
  return true;
}

function reclaimAbandonedLock(lockPath) {
  const quarantinePath = `${lockPath}.stale.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
  try {
    fs.unlinkSync(quarantinePath);
  } catch (error) {
    if (error.code !== "ENOENT") return false;
  }
  return true;
}

function acquireManifestLock(manifestPath) {
  const lockPath = getManifestLockPath(manifestPath);
  const timeoutMs = positiveEnv(
    "RELAY_MANIFEST_LOCK_TIMEOUT_MS",
    DEFAULT_MANIFEST_LOCK_TIMEOUT_MS,
    ["RELAY_COORDINATION_MARKER_LOCK_TIMEOUT_MS"],
  );
  const pollMs = positiveEnv(
    "RELAY_MANIFEST_LOCK_POLL_MS",
    DEFAULT_MANIFEST_LOCK_POLL_MS,
    ["RELAY_COORDINATION_MARKER_LOCK_POLL_MS"],
  );
  const deadline = Date.now() + timeoutMs;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (Date.now() <= deadline) {
    let fd;
    const token = crypto.randomBytes(16).toString("hex");
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      const owner = {
        pid: process.pid,
        host: os.hostname(),
        token,
        acquired_at: new Date().toISOString(),
      };
      fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf-8");
      fs.fsyncSync(fd);
      return { fd, lockPath, token };
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      if (error.code !== "EEXIST") throw error;
      if (lockIsAbandoned(lockPath) && reclaimAbandonedLock(lockPath)) continue;
      if (Date.now() >= deadline) break;
      Atomics.wait(LOCK_WAIT_STATE, 0, 0, pollMs);
    }
  }

  const error = new Error(`timed out acquiring manifest lock ${lockPath}`);
  error.code = "MANIFEST_LOCK_TIMEOUT";
  error.lockPath = lockPath;
  throw error;
}

function releaseManifestLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch {}
  try {
    const owner = JSON.parse(fs.readFileSync(lock.lockPath, "utf-8"));
    if (owner.token !== lock.token) return;
  } catch (error) {
    if (error.code === "ENOENT") return;
    return;
  }
  try { fs.unlinkSync(lock.lockPath); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function withManifestTransaction(manifestPath, callback) {
  const lock = acquireManifestLock(manifestPath);
  try {
    return callback();
  } finally {
    releaseManifestLock(lock);
  }
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

function parseScalar(value) {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) return JSON.parse(value);
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
  if (Array.isArray(value)) return JSON.stringify(value);
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
        const nested = toFrontmatter(value, indent + 2);
        return nested ? `${prefix}${key}:\n${nested}` : `${prefix}${key}:`;
      }
      return `${prefix}${key}: ${formatScalar(value)}`;
    })
    .join("\n");
}

function writeManifestUnlocked(manifestPath, data, body = NOTES_TEMPLATE) {
  const dir = path.dirname(manifestPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${manifestPath}.tmp.${process.pid}`;
  const nextData = data;
  const content = `---\n${toFrontmatter(nextData)}\n---\n${body.endsWith("\n") ? body : `${body}\n`}`;
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, manifestPath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw error;
  }
  return manifestPath;
}

function writeManifest(manifestPath, data, body = NOTES_TEMPLATE) {
  return withManifestTransaction(manifestPath, () => writeManifestUnlocked(manifestPath, data, body));
}

function readManifest(manifestPath) {
  const text = fs.readFileSync(manifestPath, "utf-8");
  const result = parseFrontmatter(text);
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
  reviewAssurance = "standard",
  reviewAssuranceSource = "flag",
  reviewAssuranceOverridden = null,
  environment = null,
  requestId = null,
  leafId = null,
  doneCriteriaPath = null,
  doneCriteriaSource = null,
  modelHints = undefined,
  fleetId = undefined,
  ownership = undefined,
}) {
  const { STATES } = require("./lifecycle");
  const { createCleanupSkeleton } = require("./cleanup");

  const createdAt = nowIso();
  const normalizedRunId = requireValidRunId(runId);
  const normalizedReviewAssurance = normalizeReviewAssurance(reviewAssurance);
  const normalizedReviewAssuranceSource = normalizeReviewAssuranceSource(reviewAssuranceSource);
  const normalizedReviewAssuranceOverridden = reviewAssuranceOverridden
    ? normalizeReviewAssurance(reviewAssuranceOverridden)
    : null;

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
      review_assurance: normalizedReviewAssurance,
      review_assurance_source: normalizedReviewAssuranceSource,
      ...(normalizedReviewAssuranceOverridden
        ? { review_assurance_overridden: normalizedReviewAssuranceOverridden }
        : {}),
    },
    anchor: {
      done_criteria_source: doneCriteriaSource || (issueNumber ? "issue" : "unknown"),
      rubric_source: "manifest",
      ...(doneCriteriaPath ? { done_criteria_path: doneCriteriaPath } : {}),
    },
    review: {
      rounds: 0,
      max_rounds: reviewRoundLimitForAssurance(normalizedReviewAssurance),
      latest_verdict: "pending",
      repeated_issue_count: 0,
      last_reviewed_sha: null,
      reviewer_swap_count: 0,
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

  if (modelHints !== undefined) {
    manifest.model_hints = modelHints;
  }

  if (fleetId !== undefined) {
    manifest.fleet_id = fleetId ? requireValidFleetId(fleetId) : null;
  }

  if (ownership !== undefined) {
    manifest.ownership = normalizeOwnership(ownership, { label: "manifest.ownership" });
  }

  return manifest;
}

module.exports = {
  NOTES_TEMPLATE,
  RELAY_VERSION,
  createManifestSkeleton,
  acquireManifestLock,
  ensureRunLayout,
  getActorName,
  getManifestLockPath,
  listManifestRecords,
  nowIso,
  parseFrontmatter,
  readManifest,
  releaseManifestLock,
  withManifestTransaction,
  writeManifest,
  writeManifestUnlocked,
};
