const fs = require("fs");
const path = require("path");

const RELAY_VERSION = 1;
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

const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.DRAFT]: new Set([STATES.DISPATCHED]),
  [STATES.DISPATCHED]: new Set([STATES.REVIEW_PENDING, STATES.ESCALATED]),
  [STATES.REVIEW_PENDING]: new Set([STATES.CHANGES_REQUESTED, STATES.READY_TO_MERGE, STATES.ESCALATED]),
  [STATES.CHANGES_REQUESTED]: new Set([STATES.DISPATCHED]),
  [STATES.READY_TO_MERGE]: new Set([STATES.MERGED, STATES.CLOSED]),
  [STATES.ESCALATED]: new Set([STATES.CLOSED]),
  [STATES.MERGED]: new Set(),
  [STATES.CLOSED]: new Set(),
});

function nowIso() {
  return new Date().toISOString();
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
  return parseFrontmatter(text);
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

function createManifestSkeleton({
  repoRoot,
  runId,
  branch,
  baseBranch,
  issueNumber,
  worktreePath,
  orchestrator = "unknown",
  worker = "unknown",
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
    },
    roles: {
      orchestrator,
      worker,
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
    },
    timestamps: {
      created_at: createdAt,
      updated_at: createdAt,
    },
  };
}

module.exports = {
  ALLOWED_TRANSITIONS,
  NOTES_TEMPLATE,
  RELAY_VERSION,
  RUNS_DIR,
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  getManifestPath,
  getRunDir,
  getRunsDir,
  inferIssueNumber,
  parseFrontmatter,
  readManifest,
  updateManifestState,
  validateTransition,
  writeManifest,
};
