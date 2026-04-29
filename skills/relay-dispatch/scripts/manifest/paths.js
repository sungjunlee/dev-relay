const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function summarizeError(error) {
  const stderr = String(error.stderr || "").trim();
  const stdout = String(error.stdout || "").trim();
  return stderr || stdout || error.message;
}

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
      `Either set RELAY_HOME explicitly or ensure RELAY_HOME resolves to an absolute path.`
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

function looksLikeGitRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, ".git"));
}

function getExpectedManifestRepoRoot(repoPath, repoArg) {
  if (!repoArg && !looksLikeGitRepo(repoPath)) {
    return undefined;
  }
  return getCanonicalRepoRoot(repoPath);
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
  const entropy = crypto.randomBytes(4).toString("hex");
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

function isRealpathContainedWithin(basePath, candidatePath, { allowEqual = false } = {}) {
  if (!basePath || !candidatePath) return false;
  try {
    const realBase = fs.realpathSync.native(basePath);
    const realCandidate = fs.realpathSync.native(candidatePath);
    return isPathContainedWithin(realBase, realCandidate, { allowEqual });
  } catch {
    return false;
  }
}

function isRelayOwnedWorktreeShapeForCleanup({ relayWorktreeBase, worktree, repoRoot }) {
  const structurallyRelayOwned = isPathContainedWithin(relayWorktreeBase, worktree)
    && path.basename(worktree) === path.basename(repoRoot);
  if (!structurallyRelayOwned) {
    return false;
  }

  if (fs.existsSync(worktree)) {
    return isRealpathContainedWithin(relayWorktreeBase, worktree);
  }

  // A missing stale worktree cannot be realpath-resolved. In cleanup mode this
  // structural recorded-path check is sufficient because cleanup consumes only
  // the recorded path (git worktree remove --force when present; absent paths
  // have no target to dereference). Malicious manifest write paths are a
  // separate manifest-authoring trust boundary.
  return true;
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
  acceptPrunedRelayOwned = false,
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
  const worktreeGitCommonDir = fs.existsSync(worktree)
    ? getWorktreeGitCommonDir(worktree)
    : null;
  const relayOwnedWorktree = relayOwnedWorktreeCandidate
    && (
      fs.existsSync(worktree)
      && worktreeGitCommonDir
      && (
        worktreeGitCommonDir === expectedGitCommonDir
        || sameFilesystemLocation(worktreeGitCommonDir, expectedGitCommonDir)
      )
    );
  const prunedRelayOwnedWorktreeForCleanup = acceptPrunedRelayOwned
    && !relayOwnedWorktree
    && (!worktreeGitCommonDir || !fs.existsSync(worktreeGitCommonDir))
    && isRelayOwnedWorktreeShapeForCleanup({ relayWorktreeBase, worktree, repoRoot });

  if (!repoContainedWorktree && !relayOwnedWorktree && !prunedRelayOwnedWorktreeForCleanup) {
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
    prunedRelayOwnedForCleanup: prunedRelayOwnedWorktreeForCleanup,
    relayWorktreeBase,
  };
}

module.exports = {
  createRunId,
  ensureRunLayout,
  getCanonicalRepoRoot,
  getEventsPath,
  getExpectedManifestRepoRoot,
  getManifestPath,
  getRelayHome,
  getRelayWorktreeBase,
  getRepoSlug,
  getRunDir,
  getRunsBase,
  getRunsDir,
  getWorktreeGitCommonDir,
  inferIssueNumber,
  isPathContainedWithin,
  listManifestPaths,
  looksLikeGitRepo,
  requireValidRunId,
  sameFilesystemLocation,
  validateManifestPaths,
  validateRunId,
};
