#!/usr/bin/env node
/**
 * Create a worktree and dispatch a task to an executor.
 *
 * Executor-agnostic orchestrator: worktree -> execute -> collect -> retain.
 * To add a new executor, add a branch in the "Execute task" section.
 *
 * Usage:
 *   ./dispatch.js <repo-path> --branch <name> --prompt <task>  [options]
 *   ./dispatch.js <repo-path> --branch <name> --prompt-file <path> [options]
 *   ./dispatch.js <repo-path> --run-id <id> --prompt <task> [options]
 *   ./dispatch.js --manifest <path> --prompt-file <path> [options]
 *
 * Options:
 *   --branch, -b <name>    Branch name (required)
 *   --run-id <id>          Resume an existing relay run
 *   --manifest <path>      Resume an existing relay run from its manifest
 *   --prompt, -p <text>    Task prompt
 *   --prompt-file <path>   Read prompt from file (for large prompts)
 *   --executor, -e <name>  Executor to use (default: codex)
 *   --model, -m <name>     Model override (default: from executor config)
 *   --sandbox <mode>       workspace-write | read-only (default: workspace-write)
 *   --copy <file,...>      Additional files to copy
 *   --timeout <seconds>    Exec timeout (default: 1800)
 *   --rubric-file <path>   REQUIRED: copy rubric YAML to run dir (persists for review)
 *   --rubric-grandfathered Deprecated alias; dispatch now rejects it and points to relay-migrate-rubric.js
 *   --request-id <id>      Link the run back to a relay-intake request
 *   --leaf-id <id>         Link the run back to a relay-intake leaf handoff
 *   --done-criteria-file   Persist a frozen Done Criteria anchor path
 *   --register             Register session in executor's app (keeps worktree)
 *   --no-cleanup           Compatibility alias; worktree is retained by default
 *   --dry-run              Show plan without executing
 *   --json                 Output as JSON
 *
 * Examples:
 *   # Basic dispatch (default executor: codex)
 *   ./dispatch.js . -b feature-auth -p "Implement OAuth2 flow"
 *
 *   # With prompt file
 *   ./dispatch.js . -b fix-login --prompt-file TASK.md
 *
 *   # Explicit executor
 *   ./dispatch.js . -b feature-auth -e codex -p "Implement OAuth2 flow"
 *
 *   # Register session in executor app (keeps worktree for resumption)
 *   ./dispatch.js . -b feature-auth -p "..." --register
 *
 *   # Dry run
 *   ./dispatch.js . -b test --prompt "test" --dry-run --json
 */

const { execFileSync, spawn: nodeSpawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { copyWorktreeFiles, getWorktreeIncludeFiles } = require("./worktreeinclude");
const { registerCodexApp } = require("./codex-app-register");
const {
  STATES,
  collectEnvironmentSnapshot,
  compareEnvironmentSnapshot,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  formatAttemptsForPrompt,
  getRubricAnchorStatus,
  getManifestPath,
  getRunDir,
  hasRubricPath,
  inferIssueNumber,
  isRubricGrandfathered,
  readPreviousAttempts,
  updateManifestState,
  validateManifestPaths,
  validateRubricPathContainment,
  writeManifest,
} = require("./relay-manifest");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent } = require("./relay-events");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const KNOWN_FLAGS = [
  "--branch", "-b", "--run-id", "--manifest", "--prompt", "-p", "--prompt-file", "--executor", "-e",
  "--model", "-m", "--sandbox", "--copy", "--timeout", "--rubric-file", "--rubric-grandfathered",
  "--request-id", "--leaf-id", "--done-criteria-file",
  "--register", "--no-cleanup", "--dry-run", "--json", "--help", "-h",
];

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: dispatch.js <repo-path> --branch <name> --prompt <task> [options]");
  console.log("       dispatch.js <repo-path> --branch <name> --prompt-file <path> [options]");
  console.log("       dispatch.js <repo-path> --run-id <id> --prompt <task> [options]");
  console.log("       dispatch.js --manifest <path> --prompt-file <path> [options]");
  console.log("\nOptions:");
  console.log("  --branch, -b       Branch name (required)");
  console.log("  --run-id           Resume an existing relay run");
  console.log("  --manifest         Resume an existing relay run from its manifest");
  console.log("  --prompt, -p       Task prompt");
  console.log("  --prompt-file      Read prompt from file");
  console.log("  --executor, -e     Executor: codex (default), claude");
  console.log("  --model, -m        Model override");
  console.log("  --sandbox          workspace-write | read-only (default: workspace-write)");
  console.log("  --copy <files>     Additional files to copy (comma-separated)");
  console.log("  --timeout          Exec timeout in seconds (default: 1800)");
  console.log("  --rubric-file      REQUIRED: copy rubric YAML to run dir (persists for review)");
  console.log("  --rubric-grandfathered  Deprecated alias; use relay-migrate-rubric.js instead");
  console.log("  --request-id       Link the run back to a relay-intake request");
  console.log("  --leaf-id          Link the run back to a relay-intake leaf handoff");
  console.log("  --done-criteria-file  Persist a frozen Done Criteria anchor path");
  console.log("  --register         Register session in executor's app (keeps worktree)");
  console.log("  --no-cleanup       Compatibility alias; worktree is retained by default");
  console.log("  --dry-run          Show plan without executing");
  console.log("  --json             Output as JSON");
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

function getArg(flags, fallback) {
  for (const flag of Array.isArray(flags) ? flags : [flags]) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length && !KNOWN_FLAGS.includes(args[idx + 1])) {
      return args[idx + 1];
    }
  }
  return fallback;
}
const hasFlag = (f) => args.includes(f);

// Positional arg: first arg that isn't a flag and isn't consumed as a flag's value
const consumedIndices = new Set();
for (let i = 0; i < args.length; i++) {
  if (KNOWN_FLAGS.includes(args[i]) && !["--register", "--no-cleanup", "--dry-run", "--json", "--help", "-h", "--rubric-grandfathered"].includes(args[i])) {
    consumedIndices.add(i);
    consumedIndices.add(i + 1);
    i++; // skip the value
  } else if (["--register", "--no-cleanup", "--dry-run", "--json", "--help", "-h", "--rubric-grandfathered"].includes(args[i])) {
    consumedIndices.add(i);
  }
}
const repoPathRaw = args.find((a, i) => !consumedIndices.has(i) && !a.startsWith("-"));
const REPO_PATH = path.resolve(repoPathRaw || ".");
const PROJECT_NAME = path.basename(REPO_PATH);
const BRANCH = getArg(["--branch", "-b"], undefined);
const RUN_ID = getArg("--run-id", undefined);
const MANIFEST_INPUT = getArg("--manifest", undefined);
const PROMPT = getArg(["--prompt", "-p"], undefined);
const PROMPT_FILE = getArg("--prompt-file", undefined);
const EXECUTOR = getArg(["--executor", "-e"], "codex");
const MODEL = getArg(["--model", "-m"], undefined);
const SANDBOX = getArg("--sandbox", "workspace-write");
const COPY_FILES = getArg("--copy", "").split(",").filter(Boolean);
const RUBRIC_FILE = getArg("--rubric-file", undefined);
const RUBRIC_GRANDFATHERED = hasFlag("--rubric-grandfathered");
const REQUEST_ID = getArg("--request-id", undefined);
const LEAF_ID = getArg("--leaf-id", undefined);
const DONE_CRITERIA_FILE = getArg("--done-criteria-file", undefined);
const TIMEOUT = parseInt(getArg("--timeout", "1800"), 10);
if (isNaN(TIMEOUT) || TIMEOUT <= 0) {
  console.error("Error: --timeout must be a positive integer");
  process.exit(1);
}
const REGISTER = hasFlag("--register");
const NO_CLEANUP = hasFlag("--no-cleanup");
const DRY_RUN = hasFlag("--dry-run");
const JSON_OUT = hasFlag("--json");
const RESUME_MODE = !!RUN_ID || !!MANIFEST_INPUT;
// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (RUN_ID && MANIFEST_INPUT) {
  console.error("Error: use either --run-id or --manifest, not both");
  process.exit(1);
}

if (!RESUME_MODE && !BRANCH) {
  console.error("Error: --branch is required for new dispatches");
  process.exit(1);
}

if (RUBRIC_FILE) {
  const rubricPath = path.resolve(RUBRIC_FILE);
  if (!fs.existsSync(rubricPath)) {
    console.error(`Error: rubric file not found: ${rubricPath}`);
    process.exit(1);
  }
}

if (RUBRIC_FILE && RUBRIC_GRANDFATHERED) {
  console.error("Error: use either --rubric-file or --rubric-grandfathered, not both");
  process.exit(1);
}

if (RUBRIC_GRANDFATHERED) {
  console.error("Warning: --rubric-grandfathered is deprecated; use relay-migrate-rubric.js instead.");
  console.error("Error: dispatch.js no longer applies grandfathering; use relay-migrate-rubric.js instead.");
  process.exit(1);
}

if (DONE_CRITERIA_FILE) {
  const doneCriteriaPath = path.resolve(DONE_CRITERIA_FILE);
  if (!fs.existsSync(doneCriteriaPath)) {
    console.error(`Error: done criteria file not found: ${doneCriteriaPath}`);
    process.exit(1);
  }
}

if (!MANIFEST_INPUT && !fs.existsSync(path.join(REPO_PATH, ".git"))) {
  const msg = !fs.existsSync(REPO_PATH)
    ? `repo path does not exist: ${REPO_PATH}`
    : `not a git repository: ${REPO_PATH}`;
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// To add a new executor: add entry here + execution branch in Step 3.
const EXECUTOR_CLI = { codex: "codex", claude: "claude" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertWithin(base, resolved, label) {
  const norm = path.resolve(resolved);
  if (!norm.startsWith(base + path.sep) && norm !== base) {
    console.error(`Error: ${label} escapes base directory: ${norm}`);
    process.exit(1);
  }
}

function git(repoDir, ...gitArgs) {
  return execFileSync("git", ["-C", repoDir, ...gitArgs], { encoding: "utf-8" }).trim();
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function looksLikeGitRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, ".git"));
}

function terminateProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" });
    } else {
      process.kill(-pid, "SIGTERM"); // negative PID = entire process group
    }
  } catch {}
}

function validateResumeRequestLinkage(manifest, { requestId, leafId, doneCriteriaPath }) {
  const checks = [
    {
      field: "source.request_id",
      existing: manifest?.source?.request_id || null,
      incoming: requestId || null,
    },
    {
      field: "source.leaf_id",
      existing: manifest?.source?.leaf_id || null,
      incoming: leafId || null,
    },
    {
      field: "anchor.done_criteria_path",
      existing: manifest?.anchor?.done_criteria_path || null,
      incoming: doneCriteriaPath || null,
      normalize: (value) => path.resolve(value),
    },
  ];

  for (const check of checks) {
    if (!check.incoming) continue;

    if (!check.existing) {
      throw new Error(
        `same-run resume cannot add immutable ${check.field}; intake linkage must be bound when the run is created`
      );
    }

    const normalize = check.normalize || ((value) => value);
    if (normalize(check.existing) !== normalize(check.incoming)) {
      throw new Error(
        `same-run resume cannot change immutable ${check.field} (existing: ${check.existing}, incoming: ${check.incoming})`
      );
    }
  }
}

function clearRubricGrandfathering(anchor = {}) {
  const nextAnchor = { ...anchor };
  delete nextAnchor.rubric_grandfathered;
  return nextAnchor;
}

function failRubricPersistence(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function formatManifestDisplayPath(manifestPath) {
  const resolvedPath = path.resolve(manifestPath);
  const homeDir = os.homedir();
  return resolvedPath.startsWith(`${homeDir}${path.sep}`)
    ? `~${resolvedPath.slice(homeDir.length)}`
    : resolvedPath;
}

function failRunDirCollision(runId, manifestPath) {
  console.error([
    "Refusing to overwrite existing run dir:",
    `  run_id: ${runId}`,
    `  manifest: ${formatManifestDisplayPath(manifestPath)}`,
    "Pass --run-id <id> to resume, or --manifest <path> to resume from an explicit manifest.",
  ].join("\n"));
  process.exit(1);
}

function copyFileAtomically(sourcePath, finalPath) {
  const tmpPath = `${finalPath}.tmp`;
  try {
    fs.copyFileSync(sourcePath, tmpPath);
    fs.renameSync(tmpPath, finalPath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

function getPersistedRubricPath(runDir, rubricPath = "rubric.yaml") {
  const containment = validateRubricPathContainment(rubricPath, runDir);
  if (!containment.valid) {
    failRubricPersistence(containment.reason);
  }
  return containment;
}

function enforceRubricPersistence(manifest, runDir) {
  if (RUBRIC_FILE) {
    getPersistedRubricPath(runDir);
    return;
  }

  if (!hasRubricPath(manifest) && !isRubricGrandfathered(manifest)) {
    failRubricPersistence(
      "--rubric-file is required. Generate the rubric with relay-plan and pass --rubric-file <path> to dispatch.js. " +
      "Legacy pre-rubric runs must be stamped with relay-migrate-rubric.js before dispatch resume."
    );
  }

  if (hasRubricPath(manifest) && !isRubricGrandfathered(manifest)) {
    const rubricAnchor = getRubricAnchorStatus(manifest, { runDir });
    if (!rubricAnchor.satisfied) {
      failRubricPersistence(
        `${rubricAnchor.error} Re-dispatch with --rubric-file to repair the run's rubric anchor, ` +
        "or migrate an approved pre-change run with relay-migrate-rubric.js."
      );
    }
  }
}

function validateExecutorCli() {
  const cli = EXECUTOR_CLI[EXECUTOR];
  if (!cli) {
    console.error(`Error: unknown executor '${EXECUTOR}'. Supported: ${Object.keys(EXECUTOR_CLI).join(", ")}`);
    process.exit(1);
  }
  try {
    execFileSync(cli, ["--version"], { encoding: "utf-8", stdio: "pipe" });
  } catch {
    console.error(`Error: ${cli} CLI not found.`);
    process.exit(1);
  }
}

function readTaskPrompt() {
  if (!PROMPT && !PROMPT_FILE) {
    console.error("Error: --prompt or --prompt-file is required");
    process.exit(1);
  }

  if (!PROMPT_FILE) {
    return PROMPT;
  }

  const promptPath = path.resolve(PROMPT_FILE);
  if (!fs.existsSync(promptPath)) {
    console.error(`Error: prompt file not found: ${promptPath}`);
    process.exit(1);
  }
  return fs.readFileSync(promptPath, "utf-8").trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Worktree location: relay-owned, executor-agnostic.
  // All executors share the same base — manifest tracks the exact path.
  const RELAY_HOME = process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  const wtBase = process.env.RELAY_WORKTREE_BASE || path.join(RELAY_HOME, "worktrees");
  const wtId = crypto.randomBytes(4).toString("hex");
  let repoRoot = REPO_PATH;
  let projectName = PROJECT_NAME;
  let wtPath = path.join(wtBase, wtId, PROJECT_NAME);
  const resultFile = path.join(os.tmpdir(), `dispatch-${EXECUTOR}-${wtId}.txt`);
  const stdoutLog = path.join(os.tmpdir(), `dispatch-${EXECUTOR}-${wtId}.log`);
  const stderrLog = path.join(os.tmpdir(), `dispatch-${EXECUTOR}-${wtId}.err`);
  const resolvedDoneCriteriaPath = DONE_CRITERIA_FILE ? path.resolve(DONE_CRITERIA_FILE) : null;
  let branch = BRANCH;
  let runId = RUN_ID;
  let manifestPath = MANIFEST_INPUT ? path.resolve(MANIFEST_INPUT) : null;
  let cleanupPolicy = "on_close";
  let baseBranch = "main";
  let issueNumber = inferIssueNumber(branch);
  let manifest;
  let copiedFiles = [];
  let createdWorktree = false;

  if (RESUME_MODE) {
    const manifestRecord = resolveManifestRecord({
      repoRoot,
      manifestPath: MANIFEST_INPUT,
      runId: RUN_ID,
    });
    manifestPath = manifestRecord.manifestPath;
    manifest = manifestRecord.data;
    const validatedPaths = validateManifestPaths(manifest.paths, {
      expectedRepoRoot: MANIFEST_INPUT ? undefined : ((repoPathRaw || looksLikeGitRepo(repoRoot)) ? repoRoot : undefined),
      manifestPath,
      runId: manifest.run_id || runId,
      caller: "dispatch resume",
    });
    repoRoot = validatedPaths.repoRoot;
    projectName = path.basename(repoRoot);
    branch = manifest.git?.working_branch || branch;
    runId = manifest.run_id || runId;
    wtPath = validatedPaths.worktree;
    manifest = {
      ...manifest,
      paths: {
        ...(manifest.paths || {}),
        repo_root: validatedPaths.repoRoot,
        worktree: validatedPaths.worktree,
      },
    };
    cleanupPolicy = manifest.policy?.cleanup || cleanupPolicy;
    baseBranch = manifest.git?.base_branch || baseBranch;
    issueNumber = manifest.issue?.number || inferIssueNumber(branch);

    if (!fs.existsSync(path.join(repoRoot, ".git"))) {
      console.error(`Error: manifest repo root is not a git repository: ${repoRoot}`);
      process.exit(1);
    }
    if (manifest.state !== STATES.CHANGES_REQUESTED) {
      console.error(`Error: same-run resume requires state='${STATES.CHANGES_REQUESTED}', got '${manifest.state}'`);
      process.exit(1);
    }
    if (!branch) {
      console.error(`Error: manifest ${manifestPath} is missing git.working_branch`);
      process.exit(1);
    }
    if (!wtPath || !fs.existsSync(wtPath)) {
      console.error(`Error: retained worktree is missing for run '${runId}': ${wtPath || "(unset)"}`);
      process.exit(1);
    }
    try {
      const currentBranch = git(wtPath, "rev-parse", "--abbrev-ref", "HEAD");
      if (currentBranch !== branch) {
        console.error(`Error: retained worktree HEAD is '${currentBranch}', expected '${branch}'`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`Error: retained worktree is unusable: ${error.message}`);
      process.exit(1);
    }

    // --- Environment drift check ---
    const currentEnv = collectEnvironmentSnapshot(repoRoot, baseBranch);
    const drift = compareEnvironmentSnapshot(manifest.environment, currentEnv);
    if (drift.length) {
      const driftMsg = drift.map(d => `${d.field}: ${d.from} → ${d.to}`).join(", ");
      if (!JSON_OUT) {
        console.error(`[WARN] Environment drift detected since initial dispatch: ${driftMsg}`);
      }
      appendRunEvent(repoRoot, runId, {
        event: "environment_drift",
        state_from: manifest.state,
        state_to: manifest.state,
        reason: driftMsg,
      });
    }
  } else {
    runId = createRunId({ issueNumber, branch });
    manifestPath = getManifestPath(repoRoot, runId);
    if (fs.existsSync(getRunDir(repoRoot, runId))) {
      failRunDirCollision(runId, manifestPath);
    }
    try {
      baseBranch = git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD") || "main";
    } catch {}
    if (fs.existsSync(wtPath)) {
      console.error(`Error: worktree path already exists: ${wtPath}`);
      process.exit(1);
    }
  }

  if (RESUME_MODE) {
    try {
      validateResumeRequestLinkage(manifest, {
        requestId: REQUEST_ID,
        leafId: LEAF_ID,
        doneCriteriaPath: resolvedDoneCriteriaPath,
      });
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  }

  const manifestRunDir = getRunDir(repoRoot, runId);
  enforceRubricPersistence(manifest, manifestRunDir);

  validateExecutorCli();
  let taskPrompt = readTaskPrompt();

  // --- Prepend iteration history on re-dispatch ---
  if (RESUME_MODE) {
    const previousAttempts = readPreviousAttempts(repoRoot, runId);
    const historySection = formatAttemptsForPrompt(previousAttempts);
    if (historySection) {
      taskPrompt = historySection + taskPrompt;
    }
  }

  // --- Dry run ---
  if (DRY_RUN) {
    const includeFiles = getWorktreeIncludeFiles(repoRoot);
    const plan = {
      mode: RESUME_MODE ? "resume" : "new",
      runId,
      manifestPath,
      executor: EXECUTOR, worktree: wtPath, branch,
      prompt: taskPrompt.slice(0, 200),
      model: MODEL, sandbox: SANDBOX, register: REGISTER,
      resultFile, stdoutLog, stderrLog, timeout: TIMEOUT,
      cleanupPolicy,
      worktreeinclude: includeFiles,
      rubricFile: RUBRIC_FILE || null,
      rubricGrandfathered: isRubricGrandfathered(manifest),
      requestId: REQUEST_ID || manifest?.source?.request_id || null,
      leafId: LEAF_ID || manifest?.source?.leaf_id || null,
      doneCriteriaFile: resolvedDoneCriteriaPath || manifest?.anchor?.done_criteria_path || null,
      environment: RESUME_MODE ? (manifest?.environment || null) : "collected-at-dispatch",
      runState: manifest?.state || null,
      dispatchSkipped: false,
    };
    if (JSON_OUT) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(`  Run:      ${runId}`);
      console.log("Dry run:");
      console.log(`  Mode:     ${RESUME_MODE ? "resume" : "new"}`);
      console.log(`  Executor: ${EXECUTOR}`);
      console.log(`  Repo:     ${repoRoot}`);
      console.log(`  Worktree: ${wtPath}`);
      console.log(`  Branch:   ${branch}`);
      console.log(`  Manifest: ${manifestPath}`);
      console.log(`  Prompt:   ${taskPrompt.slice(0, 80)}...`);
      console.log(`  Model:    ${MODEL || "(default)"}`);
      console.log(`  Sandbox:  ${SANDBOX}`);
      console.log(`  Register: ${REGISTER}`);
      console.log(`  Result:   ${resultFile}`);
      console.log(`  Cleanup:  ${cleanupPolicy}`);
      console.log(`  Timeout:  ${TIMEOUT}s`);
      if (RUBRIC_FILE) {
        console.log(`  Rubric:   ${RUBRIC_FILE}`);
      }
      if (isRubricGrandfathered(manifest)) {
        console.log("  Rubric:   grandfathered pre-change run");
      }
      if (REQUEST_ID || manifest?.source?.request_id) {
        console.log(`  Request:  ${REQUEST_ID || manifest.source.request_id}`);
      }
      if (LEAF_ID || manifest?.source?.leaf_id) {
        console.log(`  Leaf:     ${LEAF_ID || manifest.source.leaf_id}`);
      }
      if (resolvedDoneCriteriaPath || manifest?.anchor?.done_criteria_path) {
        console.log(`  Done AC:  ${resolvedDoneCriteriaPath || manifest.anchor.done_criteria_path}`);
      }
      if (includeFiles.length) {
        console.log(`  .worktreeinclude: ${includeFiles.join(", ")}`);
      }
    }
    return;
  }

  // --- Cleanup on unexpected exit ---
  let executorPid = null;
  function cleanup() {
    terminateProcessTree(executorPid);
    if (createdWorktree) {
      try { git(repoRoot, "worktree", "remove", "--force", wtPath); } catch {}
    }
    process.exit(1);
  }
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  if (!RESUME_MODE) {
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    try {
      git(repoRoot, "worktree", "add", wtPath, "-b", branch);
    } catch {
      try {
        git(repoRoot, "worktree", "add", wtPath, branch);
      } catch (e) {
        console.error(`Error: failed to create worktree for branch '${branch}': ${e.message}`);
        process.exit(1);
      }
    }
    createdWorktree = true;

    const copied = copyWorktreeFiles(repoRoot, wtPath, {
      copyFiles: COPY_FILES,
      assertWithin,
    });
    copiedFiles = copied.copied;

    // Merge base branch into worktree so the executor works on merged state.
    // Prevents wasted rounds from stale-base conflicts or CI failures.
    // On merge conflict, the worktree is cleaned up and dispatch aborts.
    let fetchSucceeded = false;
    try {
      git(wtPath, "fetch", "origin", baseBranch);
      fetchSucceeded = true;
    } catch (fetchErr) {
      const msg = (fetchErr.stderr || fetchErr.message || String(fetchErr)).split("\n")[0];
      if (!msg.includes("does not appear to be a git repository")) {
        if (!JSON_OUT) console.log(`  Note: skipping base-branch merge (${msg})`);
      }
    }
    if (fetchSucceeded) {
      try {
        git(wtPath, "merge", `origin/${baseBranch}`, "--no-edit");
      } catch (mergeErr) {
        try { git(wtPath, "merge", "--abort"); } catch {}
        try { git(repoRoot, "worktree", "remove", "--force", wtPath); } catch {}
        const reason = (mergeErr.stderr || mergeErr.message || String(mergeErr)).split("\n")[0];
        console.error(`Error: failed to merge origin/${baseBranch} into worktree: ${reason}`);
        process.exit(1);
      }
    }

    const environment = collectEnvironmentSnapshot(repoRoot, baseBranch);
    manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch,
      baseBranch,
      issueNumber,
      worktreePath: wtPath,
      orchestrator: process.env.RELAY_ORCHESTRATOR || "unknown",
      executor: EXECUTOR,
      reviewer: process.env.RELAY_REVIEWER || "unknown",
      cleanupPolicy,
      environment,
      requestId: REQUEST_ID || null,
      leafId: LEAF_ID || null,
      doneCriteriaPath: resolvedDoneCriteriaPath,
      doneCriteriaSource: resolvedDoneCriteriaPath ? "request_snapshot" : null,
    });
    ensureRunLayout(repoRoot, runId);
    writeManifest(manifestPath, manifest);
  }

  // --- Copy rubric file to run dir ---
  if (RUBRIC_FILE) {
    const rubricSrc = path.resolve(RUBRIC_FILE);
    const runDir = getRunDir(repoRoot, runId);
    const persistedRubric = getPersistedRubricPath(runDir, "rubric.yaml");
    const rubricDest = persistedRubric.resolvedPath;
    copyFileAtomically(rubricSrc, rubricDest);
    manifest = {
      ...manifest,
      anchor: {
        ...clearRubricGrandfathering(manifest.anchor || {}),
        rubric_path: persistedRubric.rubricPath,
      },
    };
    const rubricAnchor = getRubricAnchorStatus(manifest, { runDir });
    if (!rubricAnchor.satisfied) {
      failRubricPersistence(rubricAnchor.error);
    }
    writeManifest(manifestPath, manifest);
  }

  // --- Step 3: Execute task ---
  // Executor-specific: build command + args + handle quirks.
  // To add a new executor: add a branch here.
  // execCwd: spawn cwd option — set when the executor has no CLI flag for CWD.

  let cmd, execArgs;
  let execCwd;

  // Prepend non-interactive directive so the model doesn't wait for approval
  // (e.g. brainstorming HARD-GATE or design-confirmation patterns).
  const execPrompt =
    "[NON-INTERACTIVE DISPATCH] This is an automated, non-interactive execution. " +
    "Do not present plans for approval or wait for user confirmation. " +
    "Execute the task fully and autonomously.\n\n" +
    taskPrompt;

  if (EXECUTOR === "codex") {
    cmd = "codex";
    execArgs = ["exec", "-C", wtPath, "--full-auto", "--color", "never", "-o", resultFile];
    if (MODEL) execArgs.push("-m", MODEL);
    execArgs.push("--sandbox", SANDBOX);
    execArgs.push(execPrompt);
  } else if (EXECUTOR === "claude") {
    cmd = "claude";
    execCwd = wtPath; // Claude Code has no --cwd flag; use spawn cwd instead
    execArgs = [
      "-p",                            // print (non-interactive) mode
      "--dangerously-skip-permissions", // full autonomy in isolated worktree
      "--output-format", "text",
    ];
    if (MODEL) execArgs.push("--model", MODEL);
    execArgs.push(execPrompt);
    if (SANDBOX !== "workspace-write") {
      console.error(`Warning: --sandbox '${SANDBOX}' is not supported for Claude executor; using --dangerously-skip-permissions`);
    }
  } else {
    console.error(`Error: executor '${EXECUTOR}' has no execution handler`);
    process.exit(1);
  }

  if (!JSON_OUT) {
    console.log(`Dispatching to ${EXECUTOR}...`);
    console.log(`  Run:      ${runId}`);
    console.log(`  Worktree: ${wtPath}`);
    console.log(`  Branch:   ${branch}`);
    console.log(`  Manifest: ${manifestPath}`);
    if (copiedFiles.length) console.log(`  Copied:   ${copiedFiles.join(", ")}`);
    console.log(`  Result:   ${resultFile}`);
  }

  let exitCode = 0;
  let error = null;
  const startTime = Date.now();
  let stderrText = "";

  // Record HEAD before execution so we can measure only new work.
  let startHead = "";
  try {
    startHead = git(wtPath, "rev-parse", "HEAD");
  } catch {}

  const dispatchFromState = manifest.state;
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest = {
    ...manifest,
    git: {
      ...(manifest.git || {}),
      head_sha: startHead || null,
    },
  };
  writeManifest(manifestPath, manifest);
  appendRunEvent(repoRoot, runId, {
    event: "dispatch_start",
    state_from: dispatchFromState,
    state_to: STATES.DISPATCHED,
    head_sha: startHead || null,
    reason: RESUME_MODE ? "same_run_resume" : "new_dispatch",
  });

  // Redirect stdout/stderr to files. Using spawn with detached: true gives us
  // a killable process group (terminateProcessTree sends SIGTERM to -pid).
  const stdoutFd = fs.openSync(stdoutLog, "w");
  const stderrFd = fs.openSync(stderrLog, "w");

  const spawnOpts = { stdio: ["ignore", stdoutFd, stderrFd], detached: true };
  if (execCwd) spawnOpts.cwd = execCwd;
  const child = nodeSpawn(cmd, execArgs, spawnOpts);
  executorPid = child.pid;

  const execResult = await new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid);
    }, TIMEOUT * 1000);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, timedOut });
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, signal: null, timedOut, spawnError: e });
    });
  });
  executorPid = null;

  if (execResult.timedOut) {
    exitCode = 1;
    error = `executor timed out after ${TIMEOUT}s`;
  } else if (execResult.spawnError) {
    exitCode = 1;
    error = execResult.spawnError.message.split("\n")[0];
  } else if (execResult.code !== 0) {
    exitCode = execResult.code;
  }

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  if (fs.existsSync(stderrLog)) {
    stderrText = fs.readFileSync(stderrLog, "utf-8").trim();
    if (!error && stderrText) {
      error = stderrText.split("\n").slice(0, 10).join("\n");
    }
  }
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  // For Claude executor, stdout IS the result — copy to resultFile so
  // downstream collection logic works the same as Codex's -o flag.
  if (EXECUTOR === "claude" && fs.existsSync(stdoutLog)) {
    try { fs.copyFileSync(stdoutLog, resultFile); } catch {}
  }

  // --- Step 4: Collect results ---
  let resultText = "";
  if (fs.existsSync(resultFile)) {
    resultText = fs.readFileSync(resultFile, "utf-8").trim();
  }

  // Only show commits created by this run (startHead..HEAD).
  let gitLog = "";
  let currentHead = startHead;
  try {
    currentHead = git(wtPath, "rev-parse", "HEAD");
    if (startHead && currentHead !== startHead) {
      gitLog = git(wtPath, "log", "--oneline", `${startHead}..HEAD`);
    }
  } catch {}

  let diffStat = "";
  try {
    if (startHead && gitLog) {
      diffStat = git(wtPath, "diff", "--stat", `${startHead}..HEAD`);
    }
  } catch {}

  // Also capture uncommitted diff for partial runs (timeout, interrupted).
  let uncommittedDiff = "";
  try {
    const wd = git(wtPath, "diff", "--stat");
    const staged = git(wtPath, "diff", "--stat", "--cached");
    uncommittedDiff = [wd, staged].filter(Boolean).join("\n");
  } catch {}

  // Check for uncommitted work (executor may have worked but not committed)
  let uncommitted = "";
  try {
    uncommitted = git(wtPath, "status", "--porcelain");
  } catch {}

  // Warn if executor produced no output (likely silent failure)
  const stdoutSize = fs.statSync(stdoutLog).size;
  const noOutput = stdoutSize === 0 && !resultText;

  // Detect approval-wait: executor stopped to ask for confirmation instead of working.
  const BLOCKED_PATTERNS = [
    /waiting (?:on|for) (?:your )?approval/i,
    /before (?:proceeding|editing|making changes)/i,
    /please confirm/i,
  ];
  const looksBlocked = resultText && BLOCKED_PATTERNS.some((p) => p.test(resultText));

  // Determine actual status — hasWork must be based on NEW commits/changes only.
  const hasWork = gitLog || uncommitted;
  let status;
  if (looksBlocked) {
    status = "failed";
    error = error || `executor blocked on approval: ${resultText.split("\n")[0].slice(0, 120)}`;
  } else if (execResult.timedOut && hasWork) {
    status = "completed-with-warning";
  } else if (exitCode === 0 && (noOutput || !hasWork)) {
    status = "failed";
    error = error || "executor produced no output and no changes (silent failure)";
  } else if (exitCode === 0) {
    status = "completed";
  } else {
    status = "failed";
  }

  // Persist dispatch artifacts in the run directory for post-mortem analysis.
  const runDir = getRunDir(repoRoot, runId);
  try {
    fs.writeFileSync(path.join(runDir, "dispatch-prompt.md"), taskPrompt, "utf-8");
  } catch {}
  try {
    if (resultText) fs.writeFileSync(path.join(runDir, "dispatch-result.txt"), resultText, "utf-8");
  } catch {}

  manifest = updateManifestState(
    manifest,
    status === "failed" ? STATES.ESCALATED : STATES.REVIEW_PENDING,
    status === "failed" ? "inspect_dispatch_failure" : "run_review"
  );
  manifest = {
    ...manifest,
    git: {
      ...(manifest.git || {}),
      head_sha: currentHead || startHead || null,
    },
  };
  writeManifest(manifestPath, manifest);
  appendRunEvent(repoRoot, runId, {
    event: "dispatch_result",
    state_from: STATES.DISPATCHED,
    state_to: manifest.state,
    head_sha: currentHead || startHead || null,
    reason: status === "failed"
      ? `${RESUME_MODE ? "same_run_resume" : "new_dispatch"}:${error || "dispatch_failed"}`
      : `${RESUME_MODE ? "same_run_resume" : "new_dispatch"}:${status}`,
  });

  // --- Step 4.5: Optional app registration (Codex-only) ---
  let threadId = null;
  if (REGISTER && EXECUTOR !== "codex" && !JSON_OUT) {
    console.log(`\n  Warning: --register is only supported for codex executor`);
  }
  if (REGISTER && status !== "failed" && EXECUTOR === "codex") {
    try {
      const reg = registerCodexApp({
        wtPath,
        repoPath: repoRoot,
        branch,
        title: `Dispatch: ${branch}`,
      });
      threadId = reg.threadId;
      if (!JSON_OUT) console.log(`\n  Registered in ${EXECUTOR} app.`);
    } catch (e) {
      if (!JSON_OUT) console.log(`\n  Warning: app registration failed: ${e.message.split("\n")[0]}`);
    }
  }

  const rubricAnchor = getRubricAnchorStatus(manifest, { runDir });
  const result = {
    runId,
    runDir,
    manifestPath,
    rubricPath: rubricAnchor.resolvedPath || null,
    rubricGrandfathered: isRubricGrandfathered(manifest),
    requestId: manifest.source?.request_id || null,
    leafId: manifest.source?.leaf_id || null,
    doneCriteriaPath: manifest.anchor?.done_criteria_path || null,
    runState: manifest.state,
    cleanupPolicy,
    status,
    executor: EXECUTOR,
    worktree: wtPath,
    branch,
    mode: RESUME_MODE ? "resume" : "new",
    headSha: currentHead || startHead || null,
    resultFile,
    stdoutLog,
    stderrLog,
    elapsed: `${elapsed}s`,
    exitCode,
    error,
    registered: !!threadId,
    threadId,
    commits: gitLog,
    uncommitted: uncommitted || null,
    uncommittedDiff: uncommittedDiff || null,
    diffStat,
    resultPreview: resultText.slice(0, 500),
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n--- Dispatch ${result.status} (${elapsed}s) ---`);
    if (error) console.log(`  Error: ${error}`);
    console.log(`  Run state: ${result.runState}`);
    if (gitLog) {
      console.log(`  Commits:`);
      gitLog.split("\n").forEach((l) => console.log(`    ${l}`));
    }
    if (diffStat) {
      console.log(`  Changes:`);
      diffStat.split("\n").forEach((l) => console.log(`    ${l}`));
    }
    if (resultText) {
      console.log(`  Result preview:`);
      console.log(`    ${resultText.slice(0, 300).replace(/\n/g, "\n    ")}`);
    }
    console.log(`  Manifest: ${manifestPath}`);
    console.log(`\n  Full result: cat ${resultFile}`);
    console.log(`  Stdout log:  cat ${stdoutLog}`);
    console.log(`  Stderr log:  cat ${stderrLog}`);
    if (uncommittedDiff) {
      console.log(`  Uncommitted changes:`);
      uncommittedDiff.split("\n").forEach((l) => console.log(`    ${l}`));
    }
    console.log(`\n  Review:      git -C ${shellQuote(wtPath)} log --oneline ${startHead ? startHead + "..HEAD" : ""}`);
    console.log(`  Diff:        git -C ${shellQuote(wtPath)} diff ${startHead ? startHead + "..HEAD" : "HEAD~1"}`);
    console.log(`  Merge:       git merge ${branch}`);
    console.log(`  Cleanup:     deferred (${cleanupPolicy})`);
    if (NO_CLEANUP) {
      console.log("  Note:        --no-cleanup is now a compatibility alias; worktrees are retained by default.");
    }
  }

  if (status === "failed") process.exit(exitCode || 1);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
