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

function getRelayWorktreeBase() {
  const base = process.env.RELAY_WORKTREE_BASE || path.join(getRelayHome(), "worktrees");
  if (!path.isAbsolute(base)) {
    throw new Error(
      `RELAY_WORKTREE_BASE must be an absolute path, got: ${JSON.stringify(base)}. ` +
      `Either set RELAY_WORKTREE_BASE explicitly or ensure RELAY_HOME resolves to an absolute path.`
    );
  }
  return path.resolve(base);
}

function getCanonicalRepoRoot(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`getCanonicalRepoRoot requires a non-empty input path, got: ${JSON.stringify(input)}`);
  }

  const repoInput = input.trim();
  try {
    const commonDirText = execFileSync("git", ["-C", repoInput, "rev-parse", "--git-common-dir"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    const commonDir = path.isAbsolute(commonDirText)
      ? commonDirText
      : path.resolve(repoInput, commonDirText);
    return fs.realpathSync(path.dirname(commonDir));
  } catch (error) {
    const resolutionError = new Error(
      `getCanonicalRepoRoot: unable to resolve main repo root from ${repoInput}: ${summarizeError(error)}`
    );
    resolutionError.name = "CanonicalRepoRootResolutionError";
    throw resolutionError;
  }
}

function getRepoSlug(repoRoot) {
  if (!repoRoot || typeof repoRoot !== "string") {
    throw new Error(`getRepoSlug requires a non-empty repoRoot path, got: ${JSON.stringify(repoRoot)}`);
  }
  const canonicalRepoRoot = getCanonicalRepoRoot(repoRoot);
  const base = path.basename(canonicalRepoRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const hash = crypto.createHash("sha256").update(canonicalRepoRoot).digest("hex").slice(0, 8);
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

// Optional hex suffix keeps legacy run_ids valid while new runs get same-ms collision entropy.
const RUN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{17}(?:-[a-f0-9]{8})?$/;
const RUN_ID_PATTERN_DESCRIPTION = "/^[a-z0-9]+(?:-[a-z0-9]+)*-\\d{17}(?:-[a-f0-9]{8})?$/";

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
  const entropy = crypto.randomBytes(4).toString("hex"); // 32 bits of entropy makes same-ms branch collisions negligible.
  return requireValidRunId(`${prefix}-${iso}-${entropy}`);
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

function isPathContainedWithin(basePath, candidatePath, { allowEqual = false } = {}) {
  if (!basePath || !candidatePath) return false;
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  if (relative === "") {
    return allowEqual;
  }
  return relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function sameFilesystemLocation(leftPath, rightPath) {
  if (!leftPath || !rightPath) return false;
  try {
    return fs.realpathSync.native(leftPath) === fs.realpathSync.native(rightPath);
  } catch {
    return false;
  }
}

function getWorktreeGitCommonDir(worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return null;
  }
  try {
    const gitEntry = path.join(worktreePath, ".git");
    if (!fs.existsSync(gitEntry)) {
      return null;
    }
    const gitEntryStat = fs.statSync(gitEntry);
    if (gitEntryStat.isDirectory()) {
      return path.resolve(gitEntry);
    }

    const gitEntryText = fs.readFileSync(gitEntry, "utf-8").trim();
    const gitDirPrefix = "gitdir:";
    if (!gitEntryText.startsWith(gitDirPrefix)) {
      return null;
    }
    const gitDir = path.resolve(worktreePath, gitEntryText.slice(gitDirPrefix.length).trim());
    const commonDirPath = path.join(gitDir, "commondir");
    if (!fs.existsSync(commonDirPath)) {
      return gitDir;
    }
    const commonDirText = fs.readFileSync(commonDirPath, "utf-8").trim();
    return commonDirText ? path.resolve(gitDir, commonDirText) : gitDir;
  } catch {
    return null;
  }
}

function validateManifestPaths(paths, {
  expectedRepoRoot,
  manifestPath,
  runId,
  requireWorktree = false,
  caller = "relay manifest consumer",
} = {}) {
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    throw new Error(`${caller}: manifest paths must be an object`);
  }

  const repoRootRaw = typeof paths.repo_root === "string" ? paths.repo_root.trim() : "";
  if (!repoRootRaw) {
    throw new Error(`${caller}: manifest paths.repo_root must be a non-empty path`);
  }

  const repoRoot = path.resolve(repoRootRaw);
  const normalizedExpectedRepoRoot = typeof expectedRepoRoot === "string" && expectedRepoRoot.trim() !== ""
    ? path.resolve(expectedRepoRoot)
    : null;
  const normalizedManifestPath = typeof manifestPath === "string" && manifestPath.trim() !== ""
    ? path.resolve(manifestPath)
    : null;
  const normalizedRunId = requireValidRunId(
    runId ?? paths.run_id ?? (() => {
      throw new Error(`${caller}: run_id is required to validate manifest paths`);
    })()
  );

  if (
    normalizedExpectedRepoRoot
    && repoRoot !== normalizedExpectedRepoRoot
    && !sameFilesystemLocation(repoRoot, normalizedExpectedRepoRoot)
  ) {
    throw new Error(
      `${caller}: manifest paths.repo_root ${JSON.stringify(repoRoot)} does not match the expected repo root ` +
      `${JSON.stringify(normalizedExpectedRepoRoot)}. Refusing to trust manifest-owned repo paths.`
    );
  }

  if (normalizedManifestPath) {
    const expectedManifestPath = getManifestPath(repoRoot, normalizedRunId);
    if (normalizedManifestPath !== expectedManifestPath) {
      throw new Error(
        `${caller}: manifest paths.repo_root ${JSON.stringify(repoRoot)} does not match the manifest storage path ` +
        `${JSON.stringify(normalizedManifestPath)} for run ${JSON.stringify(normalizedRunId)}. ` +
        `Expected ${JSON.stringify(expectedManifestPath)}.`
      );
    }
  } else if (!normalizedExpectedRepoRoot) {
    throw new Error(
      `${caller}: validateManifestPaths requires either expectedRepoRoot or manifestPath when validating ` +
      `repo_root for run ${JSON.stringify(normalizedRunId)}.`
    );
  }

  const worktreeRaw = typeof paths.worktree === "string" ? paths.worktree.trim() : "";
  if (!worktreeRaw) {
    if (requireWorktree) {
      throw new Error(`${caller}: manifest paths.worktree must be set`);
    }
    return {
      repoRoot,
      worktree: null,
      worktreeLocation: "missing",
      relayWorktreeBase: getRelayWorktreeBase(),
    };
  }

  const worktree = path.resolve(worktreeRaw);
  const relayWorktreeBase = getRelayWorktreeBase();
  const repoContainedWorktree = isPathContainedWithin(repoRoot, worktree);
  const relayOwnedWorktreeCandidate = isPathContainedWithin(relayWorktreeBase, worktree)
    && path.basename(worktree) === path.basename(repoRoot);
  const expectedGitCommonDir = getWorktreeGitCommonDir(repoRoot) || path.join(repoRoot, ".git");
  const relayOwnedWorktree = relayOwnedWorktreeCandidate
    && (
      fs.existsSync(worktree)
      && (() => {
        const worktreeGitCommonDir = getWorktreeGitCommonDir(worktree);
        return worktreeGitCommonDir
          && (
            worktreeGitCommonDir === expectedGitCommonDir
            || sameFilesystemLocation(worktreeGitCommonDir, expectedGitCommonDir)
          );
      })()
    );

  if (!repoContainedWorktree && !relayOwnedWorktree) {
    throw new Error(
      `${caller}: manifest paths.worktree ${JSON.stringify(worktree)} is not contained under the expected repo root ` +
      `${JSON.stringify(repoRoot)} and is not a relay-owned worktree under ${JSON.stringify(relayWorktreeBase)} ` +
      `that is bound to ${JSON.stringify(expectedGitCommonDir)} for repo ${JSON.stringify(path.basename(repoRoot))}.`
    );
  }

  return {
    repoRoot,
    worktree,
    worktreeLocation: repoContainedWorktree ? "repo_root" : "relay_worktree",
    relayWorktreeBase,
  };
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

const LEGACY_RUBRIC_GRANDFATHER_WARNED_RUN_IDS = new Set();
const RUBRIC_GRANDFATHER_REQUIRED_FIELDS = Object.freeze(["from_migration", "applied_at", "actor"]);
const RUBRIC_MIGRATION_MANIFEST_BASENAME = "rubric-mandatory.yaml";
const STRICT_ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function warnLegacyRubricGrandfather(runId) {
  const normalizedRunId = typeof runId === "string" && runId.trim() !== ""
    ? runId.trim()
    : "unknown-run";
  if (LEGACY_RUBRIC_GRANDFATHER_WARNED_RUN_IDS.has(normalizedRunId)) {
    return;
  }
  LEGACY_RUBRIC_GRANDFATHER_WARNED_RUN_IDS.add(normalizedRunId);
  console.error(
    `Warning: run ${normalizedRunId} uses legacy boolean anchor.rubric_grandfathered=true; ` +
    "migrate it with relay-migrate-rubric.js."
  );
}

function isStrictIsoTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }

  const match = STRICT_ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    millisecondText,
    timezone,
    offsetSign,
    offsetHourText,
    offsetMinuteText,
  ] = match;

  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  const second = Number.parseInt(secondText, 10);
  const millisecond = millisecondText === undefined ? 0 : Number.parseInt(millisecondText, 10);
  const offsetHours = offsetHourText === undefined ? 0 : Number.parseInt(offsetHourText, 10);
  const offsetMinutes = offsetMinuteText === undefined ? 0 : Number.parseInt(offsetMinuteText, 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  if (offsetHours > 23 || offsetMinutes > 59) {
    return false;
  }

  const offsetTotalMinutes = timezone === "Z"
    ? 0
    : ((offsetSign === "-" ? -1 : 1) * ((offsetHours * 60) + offsetMinutes));
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - (offsetTotalMinutes * 60 * 1000);
  if (Number.isNaN(utcMillis)) {
    return false;
  }

  const localTimestamp = new Date(utcMillis + (offsetTotalMinutes * 60 * 1000));
  return (
    localTimestamp.getUTCFullYear() === year
    && localTimestamp.getUTCMonth() === month - 1
    && localTimestamp.getUTCDate() === day
    && localTimestamp.getUTCHours() === hour
    && localTimestamp.getUTCMinutes() === minute
    && localTimestamp.getUTCSeconds() === second
    && localTimestamp.getUTCMilliseconds() === millisecond
  );
}

function buildRubricGrandfatherDiagnostic(rawValue) {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return "anchor.rubric_grandfathered must be true or an object with from_migration, applied_at, and actor.";
  }

  const missingFields = RUBRIC_GRANDFATHER_REQUIRED_FIELDS.filter((field) => {
    return typeof rawValue[field] !== "string" || rawValue[field].trim() === "";
  });
  if (missingFields.length > 0) {
    return `anchor.rubric_grandfathered object is invalid: missing ${missingFields.join(", ")}.`;
  }

  if (!isStrictIsoTimestamp(rawValue.applied_at)) {
    return `anchor.rubric_grandfathered.applied_at must be an ISO timestamp, got ${JSON.stringify(rawValue.applied_at)}.`;
  }

  if (rawValue.reason !== undefined && rawValue.reason !== null && typeof rawValue.reason !== "string") {
    return "anchor.rubric_grandfathered.reason must be a string when set.";
  }

  return null;
}

function verifyRubricGrandfatherProvenance(data, provenance) {
  const runId = typeof data?.run_id === "string" ? data.run_id.trim() : "";
  if (!runId) {
    return "anchor.rubric_grandfathered provenance requires a valid run_id for migration-manifest verification.";
  }
  if (provenance.from_migration !== RUBRIC_MIGRATION_MANIFEST_BASENAME) {
    return (
      `anchor.rubric_grandfathered.from_migration must be ${JSON.stringify(RUBRIC_MIGRATION_MANIFEST_BASENAME)} ` +
      `for authoritative verification, got ${JSON.stringify(provenance.from_migration)}.`
    );
  }

  const manifestPath = path.join(getRelayHome(), "migrations", RUBRIC_MIGRATION_MANIFEST_BASENAME);

  try {
    const { readMigrationManifest } = require("./relay-migrate-rubric");
    const document = readMigrationManifest(manifestPath);
    const entry = (document.runs || []).find((candidate) => candidate.run_id === runId);
    if (!entry) {
      return (
        `anchor.rubric_grandfathered provenance is not backed by ${manifestPath}: ` +
        `run ${runId} is not listed in the migration manifest.`
      );
    }
    if (!isStrictIsoTimestamp(entry.applied_at)) {
      return (
        `anchor.rubric_grandfathered provenance is not backed by ${manifestPath}: ` +
        `runs[].applied_at for run ${runId} must be a strict ISO timestamp.`
      );
    }
    const normalizedAppliedAt = new Date(Date.parse(entry.applied_at)).toISOString();
    if (normalizedAppliedAt !== provenance.applied_at) {
      return (
        `anchor.rubric_grandfathered provenance is not backed by ${manifestPath}: ` +
        `run ${runId} applied_at ${JSON.stringify(provenance.applied_at)} does not match migration manifest value ` +
        `${JSON.stringify(normalizedAppliedAt)}.`
      );
    }
  } catch (error) {
    return (
      `anchor.rubric_grandfathered provenance could not be verified against ${manifestPath}: ` +
      summarizeError(error)
    );
  }

  return null;
}

function getRubricGrandfatherMetadata(data) {
  const rawValue = data?.anchor?.rubric_grandfathered;
  if (rawValue === true) {
    warnLegacyRubricGrandfather(data?.run_id);
    return {
      grandfathered: true,
      legacyGrandfather: true,
      provenance: null,
      diagnostic: null,
    };
  }

  if (rawValue === undefined || rawValue === null || rawValue === false) {
    return {
      grandfathered: false,
      legacyGrandfather: false,
      provenance: null,
      diagnostic: null,
    };
  }

  const diagnostic = buildRubricGrandfatherDiagnostic(rawValue);
  if (diagnostic) {
    return {
      grandfathered: false,
      legacyGrandfather: false,
      provenance: null,
      diagnostic,
    };
  }

  const normalizedProvenance = {
    from_migration: rawValue.from_migration.trim(),
    applied_at: new Date(Date.parse(rawValue.applied_at)).toISOString(),
    actor: rawValue.actor.trim(),
    reason: typeof rawValue.reason === "string" && rawValue.reason.trim() !== ""
      ? rawValue.reason.trim()
      : null,
  };
  const verificationDiagnostic = verifyRubricGrandfatherProvenance(data, normalizedProvenance);
  if (verificationDiagnostic) {
    return {
      grandfathered: false,
      legacyGrandfather: false,
      provenance: null,
      diagnostic: verificationDiagnostic,
    };
  }

  return {
    grandfathered: true,
    legacyGrandfather: false,
    provenance: normalizedProvenance,
    diagnostic: null,
  };
}

// TODO(2026-Q3): remove legacy boolean compat once the migration issue closes.
function isRubricGrandfathered(data) {
  return getRubricGrandfatherMetadata(data).grandfathered;
}

function formatRubricGrandfatherNote(metadata) {
  if (metadata.legacyGrandfather) {
    return "Grandfathered pre-rubric run via legacy boolean anchor.rubric_grandfathered=true. " +
      "This deprecated form should be migrated with relay-migrate-rubric.js.";
  }

  if (!metadata.provenance) {
    return "Grandfathered pre-rubric run.";
  }

  const details = [
    `migration=${metadata.provenance.from_migration}`,
    `applied_at=${metadata.provenance.applied_at}`,
    `actor=${metadata.provenance.actor}`,
  ];
  if (metadata.provenance.reason) {
    details.push(`reason=${metadata.provenance.reason}`);
  }
  return `Grandfathered pre-rubric run via migration provenance (${details.join(", ")}).`;
}

function prependGrandfatherDiagnostic(message, metadata) {
  if (!metadata?.diagnostic) {
    return message;
  }
  return `${metadata.diagnostic} ${message}`;
}

function resolveRubricRunDir(data, options = {}) {
  if (options.runDir) {
    return path.resolve(options.runDir);
  }

  const repoRoot = options.repoRoot || data?.paths?.repo_root || null;
  const runId = Object.prototype.hasOwnProperty.call(options, "runId")
    ? options.runId
    : data?.run_id;
  const validation = validateRunId(runId);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }
  if (!repoRoot) {
    return null;
  }
  return path.resolve(getRunDir(repoRoot, validation.runId));
}

function realpathSyncCompat(targetPath) {
  return typeof fs.realpathSync.native === "function"
    ? fs.realpathSync.native(targetPath)
    : fs.realpathSync(targetPath);
}

function isRubricLookupError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function resolveRealPathCandidate(targetPath) {
  const pendingSegments = [];
  let currentPath = targetPath;

  for (;;) {
    try {
      const resolvedExistingPath = realpathSyncCompat(currentPath);
      return pendingSegments.length === 0
        ? resolvedExistingPath
        : path.join(resolvedExistingPath, ...pendingSegments);
    } catch (error) {
      if (!isRubricLookupError(error)) {
        throw error;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        throw error;
      }
      pendingSegments.unshift(path.basename(currentPath));
      currentPath = parentPath;
    }
  }
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
    isPathContainedWithin(resolvedRunDir, resolvedPath)
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

  try {
    // Refuse symlinks outright: rubric.yaml is persisted by dispatch into the run dir, so a symlink indicates tampering rather than a legitimate operator workflow. This also avoids a check/read race on the anchored path itself.
    const rubricEntry = fs.lstatSync(resolvedPath);
    if (rubricEntry.isSymbolicLink()) {
      return {
        valid: false,
        status: "symlink_escape",
        rubricPath: normalizedPath,
        runDir: resolvedRunDir,
        resolvedPath,
        realPath: null,
        reason: `anchor.rubric_path must not be a symlink (got ${JSON.stringify(normalizedPath)} -> ${JSON.stringify(resolvedPath)}).`,
      };
    }
  } catch (error) {
    if (!isRubricLookupError(error)) {
      throw error;
    }
  }

  try {
    const realRunDir = resolveRealPathCandidate(resolvedRunDir);
    const realRubricPath = resolveRealPathCandidate(resolvedPath);
    if (!isPathContainedWithin(realRunDir, realRubricPath)) {
      return {
        valid: false,
        status: "follows_outside_run_dir",
        rubricPath: normalizedPath,
        runDir: resolvedRunDir,
        resolvedPath,
        realPath: realRubricPath,
        reason: `anchor.rubric_path must stay inside the real run directory ${JSON.stringify(realRunDir)} after symlink resolution (got ${JSON.stringify(normalizedPath)} -> ${JSON.stringify(realRubricPath)}).`,
      };
    }

    return {
      valid: true,
      status: "contained",
      rubricPath: normalizedPath,
      runDir: resolvedRunDir,
      resolvedPath,
      realPath: realRubricPath,
      reason: null,
    };
  } catch (error) {
    return {
      valid: false,
      status: "run_dir_unavailable",
      rubricPath: normalizedPath,
      runDir: resolvedRunDir,
      resolvedPath,
      realPath: null,
      reason: `Unable to resolve the real run directory for anchor.rubric_path=${JSON.stringify(normalizedPath)}: ${summarizeError(error)}`,
    };
  }
}

function readTextFileWithoutFollowingSymlinks(targetPath, realPath) {
  let fd = null;
  const noFollowFlag = fs.constants.O_NOFOLLOW;
  const openPath = realPath || targetPath;

  try {
    if (typeof noFollowFlag === "number") {
      fd = fs.openSync(openPath, fs.constants.O_RDONLY | noFollowFlag);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) {
          const error = new Error(`Not a file: ${openPath}`);
          error.code = "EINVAL";
          throw error;
        }
        // Pre-fix: this `return fs.readFileSync(fd, ...)` did NOT close the
        // fd on success because the outer catch only runs on throw. Wrap in
        // try/finally so the fd is closed on both the success and throw
        // paths. Matters more now that readRunEvents / readPreviousAttempts
        // route through this helper on every call.
        return fs.readFileSync(fd, "utf-8");
      } finally {
        fs.closeSync(fd);
        fd = null;
      }
    }
  } catch (error) {
    if (fd !== null) {
      fs.closeSync(fd);
      fd = null;
    }
    if (!["ELOOP", "ENOTSUP", "EINVAL"].includes(error.code)) {
      throw error;
    }
  }

  const targetEntry = fs.lstatSync(targetPath);
  if (targetEntry.isSymbolicLink()) {
    const error = new Error(`Refusing to read symlinked path: ${targetPath}`);
    error.code = "ELOOP";
    throw error;
  }

  fd = fs.openSync(openPath, fs.constants.O_RDONLY);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      const error = new Error(`Not a file: ${openPath}`);
      error.code = "EINVAL";
      throw error;
    }
    return fs.readFileSync(fd, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

// Opens targetPath for writing without following symlinks. On platforms that
// expose O_NOFOLLOW the kernel refuses the open atomically; on platforms
// without it, we lstat first and refuse if the existing entry is a symlink
// (best-effort fallback — a small TOCTOU window is unavoidable there).
//
// `mode` is "w" (truncate/create) or "a" (append/create). All writes use
// 0o600 as the file mode on creation.
// After opening an fd, verify it refers to a regular file — not a FIFO,
// socket, device, or directory. Mirrors the check in the read helper. Opens
// on a FIFO can block the writer; opens on a socket/device can have
// side-effects we don't want. Closes the fd and throws EINVAL otherwise.
function gateWritableFd(fd, targetPath) {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    const error = new Error(`Not a regular file: ${targetPath}`);
    error.code = "EINVAL";
    throw error;
  }
  return fd;
}

function openForWriteWithoutFollowingSymlinks(targetPath, mode) {
  const modeFlags = {
    w: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    a: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
  };
  const flags = modeFlags[mode];
  if (flags === undefined) {
    throw new Error(`openForWriteWithoutFollowingSymlinks: invalid mode ${mode}`);
  }
  const noFollowFlag = fs.constants.O_NOFOLLOW;
  // O_NONBLOCK prevents `open(O_WRONLY)` from blocking on a FIFO with no
  // reader. Regular-file writes are unaffected. Not every platform defines
  // it (Windows), so fall back to 0 (no-op) when unavailable.
  const nonBlockFlag = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;

  if (typeof noFollowFlag === "number") {
    try {
      const fd = fs.openSync(targetPath, flags | noFollowFlag | nonBlockFlag, 0o600);
      return gateWritableFd(fd, targetPath);
    } catch (error) {
      if (error.code === "ELOOP") {
        const wrapped = new Error(`Refusing to open symlinked path: ${targetPath}`);
        wrapped.code = "ELOOP";
        throw wrapped;
      }
      if (!["ENOTSUP", "EINVAL"].includes(error.code)) {
        throw error;
      }
      // fall through to the lstat-guarded fallback below
    }
  }

  // Non-O_NOFOLLOW fallback (primarily Windows). Do NOT use fs.existsSync
  // here — existsSync follows symlinks, so a dangling symlink would report
  // "missing" and the subsequent open(O_CREAT, ...) would create through it.
  // Use lstatSync unconditionally and treat ENOENT as the true "missing"
  // signal.
  let existingStat = null;
  try {
    existingStat = fs.lstatSync(targetPath);
  } catch (statError) {
    if (statError.code !== "ENOENT") throw statError;
  }
  if (existingStat) {
    if (existingStat.isSymbolicLink()) {
      const error = new Error(`Refusing to open symlinked path: ${targetPath}`);
      error.code = "ELOOP";
      throw error;
    }
    // Existing regular file — open normally. A small TOCTOU window between
    // lstat and open is unavoidable on platforms without O_NOFOLLOW.
    return gateWritableFd(fs.openSync(targetPath, flags | nonBlockFlag, 0o600), targetPath);
  }
  // No entry at the path — create atomically with O_EXCL so an attacker
  // dropping a symlink between our lstat and open loses the race (EEXIST
  // instead of creating through the link).
  try {
    return gateWritableFd(fs.openSync(targetPath, flags | fs.constants.O_EXCL | nonBlockFlag, 0o600), targetPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      const raced = fs.lstatSync(targetPath);
      if (raced.isSymbolicLink()) {
        const wrapped = new Error(`Refusing to open symlinked path: ${targetPath}`);
        wrapped.code = "ELOOP";
        throw wrapped;
      }
      return gateWritableFd(fs.openSync(targetPath, flags | nonBlockFlag, 0o600), targetPath);
    }
    throw error;
  }
}

// fs.writeSync may write fewer bytes than requested (short write) and the
// caller is responsible for looping on the returned count. Short writes
// are very unlikely on the small run-dir files we target, but a truncated
// events.jsonl record or half-written previous-attempts.json would be
// silently corrupt if we didn't handle it — drain the buffer ourselves.
function writeAllSync(fd, text, targetPath) {
  const buffer = Buffer.from(text, "utf-8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) {
      const error = new Error(
        `writeSync made no progress writing to ${targetPath} at offset ${offset}/${buffer.length}`
      );
      error.code = "EIO";
      throw error;
    }
    offset += written;
  }
}

function appendTextFileWithoutFollowingSymlinks(targetPath, text) {
  const fd = openForWriteWithoutFollowingSymlinks(targetPath, "a");
  try {
    writeAllSync(fd, text, targetPath);
  } finally {
    fs.closeSync(fd);
  }
}

function writeTextFileWithoutFollowingSymlinks(targetPath, text) {
  const fd = openForWriteWithoutFollowingSymlinks(targetPath, "w");
  try {
    writeAllSync(fd, text, targetPath);
  } finally {
    fs.closeSync(fd);
  }
}

function getRubricAnchorStatus(data, options = {}) {
  const rubricPath = hasRubricPath(data) ? data.anchor.rubric_path.trim() : null;
  const runDir = resolveRubricRunDir(data, options);
  const grandfatherMetadata = getRubricGrandfatherMetadata(data);
  const grandfathered = grandfatherMetadata.grandfathered;
  const baseStatus = {
    status: "missing_path",
    rubricPath,
    runDir,
    resolvedPath: null,
    grandfathered,
    grandfatherProvenance: grandfatherMetadata.provenance,
    legacyGrandfather: grandfatherMetadata.legacyGrandfather,
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
      note: formatRubricGrandfatherNote(grandfatherMetadata),
    };
  }

  if (!rubricPath) {
    return {
      ...baseStatus,
      error: prependGrandfatherDiagnostic(
        "anchor.rubric_path is required before review/merge unless anchor.rubric_grandfathered is a valid legacy boolean or provenance object.",
        grandfatherMetadata
      ),
    };
  }

  const containment = validateRubricPathContainment(rubricPath, runDir);
  if (!containment.valid) {
    return {
      ...baseStatus,
      ...containment,
      status: containment.status,
      error: prependGrandfatherDiagnostic(containment.reason, grandfatherMetadata),
    };
  }

  try {
    // Refuse symlinks outright: rubric.yaml is persisted by dispatch into the run dir — a symlink indicates tampering, not a legitimate operator workflow. Avoids TOCTOU between lstat and readFileSync.
    const content = readTextFileWithoutFollowingSymlinks(
      containment.resolvedPath,
      containment.realPath || containment.resolvedPath
    );
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      return {
        ...baseStatus,
        ...containment,
        status: "empty",
        exists: true,
        empty: true,
        error: prependGrandfatherDiagnostic(`rubric file is empty: ${containment.resolvedPath}`, grandfatherMetadata),
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
        error: prependGrandfatherDiagnostic(
          `rubric file is missing from the run directory: ${containment.resolvedPath}`,
          grandfatherMetadata
        ),
      };
    }

    if (error.code === "ELOOP") {
      return {
        ...baseStatus,
        ...containment,
        status: "symlink_escape",
        error: prependGrandfatherDiagnostic(
          `anchor.rubric_path must not be a symlink (got ${JSON.stringify(containment.rubricPath)} -> ${JSON.stringify(containment.resolvedPath)}).`,
          grandfatherMetadata
        ),
      };
    }

    if (error.code === "EINVAL") {
      return {
        ...baseStatus,
        ...containment,
        status: "not_file",
        error: prependGrandfatherDiagnostic(
          `anchor.rubric_path must point to a file inside the run directory (got ${JSON.stringify(containment.resolvedPath)}).`,
          grandfatherMetadata
        ),
      };
    }

    return {
      ...baseStatus,
      ...containment,
      status: "unreadable",
      error: prependGrandfatherDiagnostic(
        `Unable to read rubric file ${containment.resolvedPath}: ${summarizeError(error)}`,
        grandfatherMetadata
      ),
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
        "or migrate an approved pre-change run with relay-migrate-rubric.js."
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
  const validatedPaths = validateManifestPaths(data?.paths, {
    expectedRepoRoot: repoRoot,
    runId: data?.run_id,
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

// ---------------------------------------------------------------------------
// Previous attempts (stored as JSON in the run directory)
// ---------------------------------------------------------------------------

function getAttemptsPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), "previous-attempts.json");
}

function readPreviousAttempts(repoRoot, runId) {
  const attemptsPath = getAttemptsPath(repoRoot, runId);
  // Do NOT short-circuit on fs.existsSync — existsSync follows symlinks, so a
  // dangling symlink at attemptsPath would return false and we'd silently
  // return []. That repeats the #157 fail-open class that #197 closes. Let
  // the safe reader handle the symlink check; distinguish ENOENT (truly
  // missing) from ELOOP (symlink refused).
  let rawText;
  try {
    rawText = readTextFileWithoutFollowingSymlinks(attemptsPath);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    if (error.code === "ELOOP") {
      throw new Error(
        `Refusing to read symlinked previous-attempts.json at ${attemptsPath}: ${error.message}`
      );
    }
    throw error;
  }
  try {
    return JSON.parse(rawText);
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
  try {
    writeTextFileWithoutFollowingSymlinks(
      getAttemptsPath(repoRoot, runId),
      JSON.stringify(attempts, null, 2)
    );
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new Error(
        `Refusing to write symlinked previous-attempts.json at ${getAttemptsPath(repoRoot, runId)}: ${error.message}`
      );
    }
    throw error;
  }
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
  appendTextFileWithoutFollowingSymlinks,
  captureAttempt,
  collectEnvironmentSnapshot,
  compareEnvironmentSnapshot,
  createCleanupSkeleton,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  formatAttemptsForPrompt,
  getRubricAnchorStatus,
  getRubricGrandfatherMetadata,
  getActorName,
  getAttemptsPath,
  getCanonicalRepoRoot,
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
  readTextFileWithoutFollowingSymlinks,
  runCleanup,
  summarizeError,
  updateManifestCleanup,
  updateManifestState,
  validateManifestPaths,
  validateRubricPathContainment,
  validateRunId,
  validateTransition,
  validateTransitionInvariants,
  writeManifest,
  writeTextFileWithoutFollowingSymlinks,
};
