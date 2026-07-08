const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function summarizeFailure(error) {
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

function getFleetsBase() {
  return path.join(getRelayHome(), "fleets");
}

function getProjectsBase({ relayHome } = {}) {
  const home = relayHome || getRelayHome();
  if (!path.isAbsolute(home)) {
    throw new Error(
      `RELAY_HOME must be an absolute path, got: ${JSON.stringify(home)}. ` +
      `Either set RELAY_HOME explicitly or ensure RELAY_HOME resolves to an absolute path.`
    );
  }
  return path.join(home, "projects");
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
      `getCanonicalRepoRoot: unable to resolve main repo root from ${repoInput}: ${summarizeFailure(error)}`
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

function parsePositiveInt(value, label, { allowZero = false } = {}) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  const minRejected = allowZero ? parsed < 0 : parsed <= 0;
  if (!Number.isInteger(parsed) || minRejected) {
    const requirement = allowZero ? "non-negative integer" : "positive integer";
    throw new Error(`${label} must be a ${requirement}`);
  }
  return parsed;
}

function nowIso({ zeroMilliseconds = false } = {}) {
  const iso = new Date().toISOString();
  return zeroMilliseconds ? iso.replace(/\.\d{3}Z$/, ".000Z") : iso;
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

const FLEET_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function requireValidFleetId(fleetId) {
  const normalizedFleetId = typeof fleetId === "string" ? fleetId.trim() : "";
  if (!normalizedFleetId) {
    throw new Error(`fleet_id must be a non-empty path segment, got: ${JSON.stringify(fleetId)}`);
  }
  if (normalizedFleetId === "." || normalizedFleetId === "..") {
    throw new Error(`fleet_id may not be "." or ".." (got ${JSON.stringify(normalizedFleetId)}).`);
  }
  if (normalizedFleetId.includes("/") || normalizedFleetId.includes("\\")) {
    throw new Error(`fleet_id must be a single path segment (got ${JSON.stringify(normalizedFleetId)}).`);
  }
  if (
    path.basename(normalizedFleetId) !== normalizedFleetId
    || path.win32.basename(normalizedFleetId) !== normalizedFleetId
  ) {
    throw new Error(`fleet_id must resolve to a single path segment (got ${JSON.stringify(normalizedFleetId)}).`);
  }
  if (!FLEET_ID_PATTERN.test(normalizedFleetId)) {
    throw new Error(
      `fleet_id must contain lowercase letters, numbers, dots, underscores, or dashes ` +
      `without leading/trailing separators (got ${JSON.stringify(normalizedFleetId)}).`
    );
  }
  return normalizedFleetId;
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

function getFleetsDir(repoRoot) {
  return path.join(getFleetsBase(), getRepoSlug(repoRoot));
}

function getProjectDir(repoRoot, options = {}) {
  return path.join(getProjectsBase(options), getRepoSlug(repoRoot));
}

function getProjectConfigPath(repoRoot, options = {}) {
  return path.join(getProjectDir(repoRoot, options), "project.json");
}

function getProjectPolicyPath(repoRoot, options = {}) {
  return path.join(getProjectDir(repoRoot, options), "policy.json");
}

function getProjectRoutesPath(repoRoot, options = {}) {
  return path.join(getProjectDir(repoRoot, options), "routes.json");
}

function getFleetManifestPath(repoRoot, fleetId) {
  return path.join(getFleetsDir(repoRoot), `${requireValidFleetId(fleetId)}.md`);
}

function getFleetLocksDir(repoRoot) {
  return path.join(getFleetsDir(repoRoot), "locks");
}

function getFleetIssueLockPath(repoRoot, issueNumber) {
  const parsedIssue = Number(issueNumber);
  if (!Number.isInteger(parsedIssue) || parsedIssue <= 0) {
    throw new Error(`issueNumber must be a positive integer, got: ${JSON.stringify(issueNumber)}`);
  }
  return path.join(getFleetLocksDir(repoRoot), `issue-${parsedIssue}.lock`);
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

function getRoutePlanPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), "route-plan.json");
}

function listManifestPaths(repoRoot) {
  const runsDir = getRunsDir(repoRoot);
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(runsDir, name));
}

function listFleetManifestPaths(repoRoot) {
  const fleetsDir = getFleetsDir(repoRoot);
  if (!fs.existsSync(fleetsDir)) return [];
  return fs.readdirSync(fleetsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(fleetsDir, name));
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

function isRelayOwnedWorktreeShapeForCleanup({ relayWorktreeBase, worktree, repoRootBasenames }) {
  const repoBasenames = new Set((repoRootBasenames || []).filter(Boolean));
  const structurallyRelayOwned = isPathContainedWithin(relayWorktreeBase, worktree)
    && repoBasenames.has(path.basename(worktree));
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

function sameGitCommonDir(leftPath, rightPath) {
  const leftCommonDir = getWorktreeGitCommonDir(leftPath);
  const rightCommonDir = getWorktreeGitCommonDir(rightPath);
  if (!leftCommonDir || !rightCommonDir) return false;
  return leftCommonDir === rightCommonDir || sameFilesystemLocation(leftCommonDir, rightCommonDir);
}

function validateManifestPaths(paths, {
  expectedRepoRoot,
  manifestPath,
  runId,
  requireWorktree = false,
  allowMissingWorktree = false,
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
  const repoRootEquivalentToExpected = normalizedExpectedRepoRoot
    && repoRoot !== normalizedExpectedRepoRoot
    && !sameFilesystemLocation(repoRoot, normalizedExpectedRepoRoot)
    && sameGitCommonDir(repoRoot, normalizedExpectedRepoRoot);
  const effectiveRepoRoot = repoRootEquivalentToExpected ? normalizedExpectedRepoRoot : repoRoot;
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
    && !repoRootEquivalentToExpected
  ) {
    throw new Error(
      `${caller}: manifest paths.repo_root ${JSON.stringify(repoRoot)} does not match the expected repo root ` +
      `${JSON.stringify(normalizedExpectedRepoRoot)}. Refusing to trust manifest-owned repo paths.`
    );
  }

  if (normalizedManifestPath) {
    const expectedManifestPath = getManifestPath(effectiveRepoRoot, normalizedRunId);
    if (normalizedManifestPath !== expectedManifestPath) {
      throw new Error(
        `${caller}: manifest paths.repo_root ${JSON.stringify(effectiveRepoRoot)} does not match the manifest storage path ` +
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
      repoRoot: effectiveRepoRoot,
      worktree: null,
      worktreeLocation: "missing",
      relayWorktreeBase: getRelayWorktreeBase(),
    };
  }

  const worktree = path.resolve(worktreeRaw);
  const relayWorktreeBase = getRelayWorktreeBase();
  const repoContainedWorktree = isPathContainedWithin(effectiveRepoRoot, worktree);
  const relayOwnedRepoRootBasenames = [
    path.basename(effectiveRepoRoot),
    path.basename(repoRoot),
  ];
  const relayOwnedWorktreeCandidate = isPathContainedWithin(relayWorktreeBase, worktree)
    && relayOwnedRepoRootBasenames.includes(path.basename(worktree));
  const expectedGitCommonDir = getWorktreeGitCommonDir(effectiveRepoRoot) || path.join(effectiveRepoRoot, ".git");
  const worktreeExists = fs.existsSync(worktree);
  if (!worktreeExists) {
    if (!allowMissingWorktree || (!repoContainedWorktree && !relayOwnedWorktreeCandidate)) {
      throw new Error(
        `${caller}: manifest paths.worktree ${JSON.stringify(worktree)} is not contained under the expected repo root ` +
        `${JSON.stringify(effectiveRepoRoot)} and is not a relay-owned worktree under ${JSON.stringify(relayWorktreeBase)} ` +
        `that is bound to ${JSON.stringify(expectedGitCommonDir)} for repo ${JSON.stringify(path.basename(effectiveRepoRoot))}.`
      );
    }
    return {
      repoRoot: effectiveRepoRoot,
      worktree,
      worktreeLocation: repoContainedWorktree
        ? "repo_root"
        : (relayOwnedWorktreeCandidate ? "relay_worktree" : "missing"),
      worktreeExists: false,
      worktreeMissing: true,
      prunedRelayOwnedForCleanup: false,
      relayWorktreeBase,
    };
  }
  const worktreeGitCommonDir = getWorktreeGitCommonDir(worktree);
  // The git common dir is the ownership trust root: a worktree under the relay
  // base whose common dir binds to the expected repo is relay-owned even when
  // its directory basename was inherited from a differently-named dispatch
  // checkout (#851). Basename matching stays required on the missing-worktree
  // path above, where no common dir is available to verify.
  const relayOwnedWorktree = isPathContainedWithin(relayWorktreeBase, worktree)
    && Boolean(
      worktreeGitCommonDir
      && (
        worktreeGitCommonDir === expectedGitCommonDir
        || sameFilesystemLocation(worktreeGitCommonDir, expectedGitCommonDir)
      )
    );
  const prunedRelayOwnedWorktreeForCleanup = acceptPrunedRelayOwned
    && !relayOwnedWorktree
    && (!worktreeGitCommonDir || !fs.existsSync(worktreeGitCommonDir))
    && isRelayOwnedWorktreeShapeForCleanup({
      relayWorktreeBase,
      worktree,
      repoRootBasenames: relayOwnedRepoRootBasenames,
    });

  if (!repoContainedWorktree && !relayOwnedWorktree && !prunedRelayOwnedWorktreeForCleanup) {
    throw new Error(
      `${caller}: manifest paths.worktree ${JSON.stringify(worktree)} is not contained under the expected repo root ` +
      `${JSON.stringify(effectiveRepoRoot)} and is not a relay-owned worktree under ${JSON.stringify(relayWorktreeBase)} ` +
      `that is bound to ${JSON.stringify(expectedGitCommonDir)} for repo ${JSON.stringify(path.basename(effectiveRepoRoot))}.`
    );
  }

  return {
    repoRoot: effectiveRepoRoot,
    worktree,
    worktreeLocation: repoContainedWorktree ? "repo_root" : "relay_worktree",
    worktreeExists: true,
    worktreeMissing: false,
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
  getFleetIssueLockPath,
  getFleetLocksDir,
  getFleetManifestPath,
  getFleetsBase,
  getFleetsDir,
  getManifestPath,
  getProjectConfigPath,
  getProjectDir,
  getProjectPolicyPath,
  getProjectRoutesPath,
  getProjectsBase,
  getRelayHome,
  getRelayWorktreeBase,
  getRepoSlug,
  getRoutePlanPath,
  getRunDir,
  getRunsBase,
  getRunsDir,
  getWorktreeGitCommonDir,
  inferIssueNumber,
  isPathContainedWithin,
  listFleetManifestPaths,
  listManifestPaths,
  looksLikeGitRepo,
  nowIso,
  parsePositiveInt,
  requireValidFleetId,
  requireValidRunId,
  sameFilesystemLocation,
  summarizeFailure,
  validateManifestPaths,
  validateRunId,
};
