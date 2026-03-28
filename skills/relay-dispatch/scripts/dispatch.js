#!/usr/bin/env node
/**
 * Create a worktree and dispatch a task to Codex in one command.
 *
 * Combines register-worktree.js + codex exec into a single step.
 * Designed for Claude Code's Bash(run_in_background=true) pattern.
 *
 * Usage:
 *   ./dispatch.js <repo-path> --branch <name> --prompt <task>  [options]
 *   ./dispatch.js <repo-path> --branch <name> --prompt-file <path> [options]
 *
 * Options:
 *   --branch, -b <name>    Branch name (required)
 *   --prompt, -p <text>    Task prompt for Codex
 *   --prompt-file <path>   Read prompt from file (for large prompts)
 *   --model, -m <name>     Codex model (default: from config)
 *   --sandbox <mode>       workspace-write | read-only (default: workspace-write)
 *   --copy-env             Copy .env to worktree
 *   --copy <file,...>      Additional files to copy
 *   --timeout <seconds>    Codex exec timeout (default: 1800)
 *   --dry-run              Show plan without executing
 *   --json                 Output as JSON
 *
 * Examples:
 *   # Basic dispatch
 *   ./dispatch.js . -b feature-auth -p "Implement OAuth2 flow"
 *
 *   # With prompt file and env
 *   ./dispatch.js . -b fix-login --prompt-file TASK.md --copy-env
 *
 *   # Read-only research task
 *   ./dispatch.js . -b research-api -p "Analyze API patterns" --sandbox read-only
 *
 *   # Dry run
 *   ./dispatch.js . -b test --prompt "test" --dry-run --json
 */

const { execFileSync, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const KNOWN_FLAGS = [
  "--branch", "-b", "--prompt", "-p", "--prompt-file", "--model", "-m",
  "--sandbox", "--copy", "--copy-env", "--timeout", "--no-cleanup",
  "--dry-run", "--json", "--help", "-h",
];

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: dispatch.js <repo-path> --branch <name> --prompt <task> [options]");
  console.log("       dispatch.js <repo-path> --branch <name> --prompt-file <path> [options]");
  console.log("\nOptions:");
  console.log("  --branch, -b     Branch name (required)");
  console.log("  --prompt, -p     Task prompt");
  console.log("  --prompt-file    Read prompt from file");
  console.log("  --model, -m      Codex model");
  console.log("  --sandbox        workspace-write | read-only (default: workspace-write)");
  console.log("  --copy-env       Copy .env to worktree");
  console.log("  --copy <files>   Additional files to copy (comma-separated)");
  console.log("  --timeout        Codex exec timeout in seconds (default: 1800)");
  console.log("  --no-cleanup     Keep worktree after successful dispatch");
  console.log("  --dry-run        Show plan without executing");
  console.log("  --json           Output as JSON");
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
  if (KNOWN_FLAGS.includes(args[i]) && !["--copy-env", "--dry-run", "--json", "--help", "-h"].includes(args[i])) {
    consumedIndices.add(i);
    consumedIndices.add(i + 1);
    i++; // skip the value
  } else if (["--copy-env", "--no-cleanup", "--dry-run", "--json", "--help", "-h"].includes(args[i])) {
    consumedIndices.add(i);
  }
}
const repoPathRaw = args.find((a, i) => !consumedIndices.has(i) && !a.startsWith("-"));
const REPO_PATH = path.resolve(repoPathRaw || ".");
const PROJECT_NAME = path.basename(REPO_PATH);
const BRANCH = getArg(["--branch", "-b"], undefined);
const PROMPT = getArg(["--prompt", "-p"], undefined);
const PROMPT_FILE = getArg("--prompt-file", undefined);
const MODEL = getArg(["--model", "-m"], undefined);
const SANDBOX = getArg("--sandbox", "workspace-write");
const COPY_ENV = hasFlag("--copy-env");
const COPY_FILES = getArg("--copy", "").split(",").filter(Boolean);
const TIMEOUT = parseInt(getArg("--timeout", "1800"), 10);
const NO_CLEANUP = hasFlag("--no-cleanup");
const DRY_RUN = hasFlag("--dry-run");
const JSON_OUT = hasFlag("--json");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (!BRANCH) {
  console.error("Error: --branch is required");
  process.exit(1);
}

if (!PROMPT && !PROMPT_FILE) {
  console.error("Error: --prompt or --prompt-file is required");
  process.exit(1);
}

if (!fs.existsSync(path.join(REPO_PATH, ".git"))) {
  const msg = !fs.existsSync(REPO_PATH)
    ? `repo path does not exist: ${REPO_PATH}`
    : `not a git repository: ${REPO_PATH}`;
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// Check codex CLI is available
try {
  execFileSync("codex", ["--version"], { encoding: "utf-8", stdio: "pipe" });
} catch {
  console.error("Error: codex CLI not found. Install Codex first: https://github.com/openai/codex");
  process.exit(1);
}

let taskPrompt = PROMPT;
if (PROMPT_FILE) {
  const promptPath = path.resolve(PROMPT_FILE);
  if (!fs.existsSync(promptPath)) {
    console.error(`Error: prompt file not found: ${promptPath}`);
    process.exit(1);
  }
  taskPrompt = fs.readFileSync(promptPath, "utf-8").trim();
}

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const wtId = crypto.randomBytes(4).toString("hex");
  const wtPath = path.join(CODEX_HOME, "worktrees", wtId, PROJECT_NAME);
  const resultFile = path.join(os.tmpdir(), `codex-dispatch-${wtId}.txt`);
  const stdoutLog = path.join(os.tmpdir(), `codex-stdout-${wtId}.log`);

  if (fs.existsSync(wtPath)) {
    console.error(`Error: worktree path already exists: ${wtPath}`);
    process.exit(1);
  }

  // --- Dry run ---
  if (DRY_RUN) {
    const plan = {
      worktree: wtPath, branch: BRANCH, prompt: taskPrompt.slice(0, 200),
      model: MODEL, sandbox: SANDBOX, resultFile, stdoutLog, timeout: TIMEOUT,
      copyEnv: COPY_ENV,
    };
    if (JSON_OUT) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log("Dry run:");
      console.log(`  Repo:     ${REPO_PATH}`);
      console.log(`  Worktree: ${wtPath}`);
      console.log(`  Branch:   ${BRANCH}`);
      console.log(`  Prompt:   ${taskPrompt.slice(0, 80)}...`);
      console.log(`  Model:    ${MODEL || "(default)"}`);
      console.log(`  Sandbox:  ${SANDBOX}`);
      console.log(`  Result:   ${resultFile}`);
      console.log(`  Timeout:  ${TIMEOUT}s`);
    }
    return;
  }

  // --- Cleanup on unexpected exit ---
  function cleanup() {
    try { git(REPO_PATH, "worktree", "remove", "--force", wtPath); } catch {}
    process.exit(1);
  }
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // --- Step 1: Create worktree ---
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  try {
    git(REPO_PATH, "worktree", "add", wtPath, "-b", BRANCH);
  } catch {
    try {
      git(REPO_PATH, "worktree", "add", wtPath, BRANCH);
    } catch (e) {
      console.error(`Error: failed to create worktree for branch '${BRANCH}': ${e.message}`);
      process.exit(1);
    }
  }

  // --- Step 2: Copy files ---
  if (COPY_ENV) {
    const src = path.join(REPO_PATH, ".env");
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(wtPath, ".env"));
  }
  for (const file of COPY_FILES) {
    const src = path.resolve(REPO_PATH, file);
    const dst = path.resolve(wtPath, file);
    assertWithin(REPO_PATH, src, "--copy source");
    assertWithin(wtPath, dst, "--copy destination");
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }

  // --- Step 3: Run codex exec ---
  const codexArgs = ["exec", "-C", wtPath, "--full-auto", "--color", "never", "-o", resultFile];
  if (MODEL) codexArgs.push("-m", MODEL);
  codexArgs.push("--sandbox", SANDBOX);
  codexArgs.push(taskPrompt);

  if (!JSON_OUT) {
    console.log(`Dispatching to Codex...`);
    console.log(`  Worktree: ${wtPath}`);
    console.log(`  Branch:   ${BRANCH}`);
    console.log(`  Result:   ${resultFile}`);
  }

  let exitCode = 0;
  let error = null;
  const startTime = Date.now();

  // Redirect stdout to file (not buffer) to avoid ENOBUFS on verbose Codex output.
  // Result data comes from -o resultFile; stdout log is for debugging.
  const stdoutFd = fs.openSync(stdoutLog, "w");
  try {
    execFileSync("codex", codexArgs, {
      timeout: TIMEOUT * 1000,
      maxBuffer: 10 * 1024 * 1024, // 10MB for stderr (piped for error capture)
      stdio: ["pipe", stdoutFd, "pipe"], // stdout → log file (no buffer limit)
    });
  } catch (e) {
    exitCode = e.status || 1;
    const msg = e.message.split("\n")[0];
    // ENOBUFS: Codex output exceeded buffer. Work may be done — check worktree.
    if (e.code === "ENOBUFS" || msg.includes("ENOBUFS")) {
      error = "ENOBUFS (stdout buffer overflow — work may be complete, check worktree)";
      exitCode = 0; // treat as potential success, let result collection decide
    } else {
      error = msg;
    }
  }

  fs.closeSync(stdoutFd);
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  // --- Step 4: Collect results ---
  let resultText = "";
  if (fs.existsSync(resultFile)) {
    resultText = fs.readFileSync(resultFile, "utf-8").trim();
  }

  let gitLog = "";
  try {
    gitLog = git(wtPath, "log", "--oneline", "-10");
  } catch {}

  let diffStat = "";
  try {
    diffStat = git(wtPath, "diff", "--stat", "HEAD~1");
  } catch {}

  // Check for uncommitted work (ENOBUFS recovery: Codex may have worked but not committed)
  let uncommitted = "";
  try {
    uncommitted = git(wtPath, "status", "--porcelain");
  } catch {}

  // Determine actual status: if there are commits or uncommitted changes, work happened
  const hasWork = gitLog || uncommitted;
  let status;
  if (exitCode === 0) {
    status = "completed";
  } else if (hasWork && error && error.includes("ENOBUFS")) {
    status = "completed-with-warning";
  } else {
    status = "failed";
  }

  const result = {
    status,
    worktree: wtPath,
    branch: BRANCH,
    resultFile,
    stdoutLog,
    elapsed: `${elapsed}s`,
    exitCode,
    error,
    commits: gitLog,
    uncommitted: uncommitted || null,
    diffStat,
    resultPreview: resultText.slice(0, 500),
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n--- Dispatch ${result.status} (${elapsed}s) ---`);
    if (error) console.log(`  Error: ${error}`);
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
    console.log(`\n  Full result: cat ${resultFile}`);
    console.log(`  Codex log:   cat ${stdoutLog}`);
    console.log(`  Review:      git -C ${shellQuote(wtPath)} log --oneline`);
    console.log(`  Diff:        git -C ${shellQuote(wtPath)} diff HEAD~1`);
    console.log(`  Merge:       git merge ${BRANCH}`);
  }

  // --- Step 5: Cleanup worktree on success ---
  if (status !== "failed" && !NO_CLEANUP) {
    try {
      git(REPO_PATH, "worktree", "remove", "--force", wtPath);
      if (!JSON_OUT) console.log(`\n  Worktree cleaned up.`);
    } catch (e) {
      if (!JSON_OUT) console.log(`\n  Warning: worktree cleanup failed: ${e.message.split("\n")[0]}`);
    }
  }

  if (status === "failed") process.exit(exitCode || 1);
}

main();
