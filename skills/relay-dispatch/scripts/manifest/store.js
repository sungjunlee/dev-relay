const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const {
  ensureRunLayout,
  listManifestPaths,
  requireValidRunId,
} = require("./paths");

const RELAY_VERSION = 2;
const NOTES_TEMPLATE = "# Notes\n\n## Context\n\n## Review History\n";

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
  environment = null,
  requestId = null,
  leafId = null,
  doneCriteriaPath = null,
  doneCriteriaSource = null,
}) {
  const { STATES } = require("./lifecycle");
  const { createCleanupSkeleton } = require("./cleanup");

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

function summarizeError(error) {
  const stderr = String(error.stderr || "").trim();
  const stdout = String(error.stdout || "").trim();
  return stderr || stdout || error.message;
}

module.exports = {
  NOTES_TEMPLATE,
  RELAY_VERSION,
  createManifestSkeleton,
  ensureRunLayout,
  getActorName,
  listManifestRecords,
  nowIso,
  parseFrontmatter,
  readManifest,
  summarizeError,
  writeManifest,
};
