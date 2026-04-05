#!/usr/bin/env node
/**
 * Create a git worktree and optionally register it in an executor's app.
 *
 * Creates a worktree in ~/.relay/worktrees/ (relay-owned location).
 * Use --register to pre-register in Codex App SQLite for title/pin support.
 * Use --worktree-path to register an existing worktree (e.g., from dispatch.js).
 *
 * Usage:
 *   ./create-worktree.js <repo-path> [options]
 *
 * Options:
 *   --branch, -b <name>      Branch name (default: auto from topic)
 *   --title, -t <text>       Thread title in Codex App
 *   --topic <name>           Topic slug -> branch becomes codex/<topic>
 *   --worktree-path <path>   Register an existing worktree (implies --register)
 *   --copy-env               Copy .env from main repo to worktree
 *   --copy <file,...>        Additional files to copy (comma-separated)
 *   --pin                    Pin thread to prevent auto-cleanup (4 days)
 *   --register               Pre-register in SQLite + global state
 *   --dry-run                Show plan without executing
 *   --json                   Output as JSON
 *
 * Examples:
 *   ./create-worktree.js . --branch feature-auth
 *   ./create-worktree.js . -b feature-auth -t "Implement OAuth2" --register --pin
 *   ./create-worktree.js . --topic auth --copy-env
 *   ./create-worktree.js . --worktree-path /path/to/wt -b feature -t "Task title"
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { copyWorktreeFiles, getWorktreeIncludeFiles } = require("./worktreeinclude");
const { registerCodexApp } = require("./codex-app-register");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: create-worktree.js <repo-path> [--branch <name>] [--title <text>]"
  );
  console.log(
    "       [--topic <name>] [--worktree-path <path>] [--copy-env] [--copy <files>]"
  );
  console.log("       [--pin] [--register] [--dry-run] [--json]");
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

const KNOWN_FLAGS = ["--branch", "-b", "--title", "-t", "--topic", "--worktree-path", "--copy", "--copy-env", "--pin", "--register", "--dry-run", "--json", "--help", "-h"];
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

const repoPathRaw = args.find((a) => !a.startsWith("-"));
const REPO_PATH = path.resolve(repoPathRaw || ".");
const PROJECT_NAME = path.basename(REPO_PATH);
const TOPIC = getArg("--topic", undefined);
const BRANCH = getArg(["--branch", "-b"], TOPIC ? `codex/${TOPIC}` : undefined);
const TITLE = getArg(
  ["--title", "-t"],
  BRANCH ? `Worktree: ${BRANCH}` : `Worktree: ${PROJECT_NAME}`
);
const WORKTREE_PATH = getArg("--worktree-path", undefined);
const COPY_ENV = hasFlag("--copy-env");
const COPY_FILES = getArg("--copy", "")
  .split(",")
  .filter(Boolean);
const PIN = hasFlag("--pin");
// --worktree-path implies --register (the only reason to use it)
const REGISTER = hasFlag("--register") || !!WORKTREE_PATH;
const DRY_RUN = hasFlag("--dry-run");
const JSON_OUT = hasFlag("--json");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const RELAY_HOME = process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
const WORKTREES_DIR = process.env.RELAY_WORKTREE_BASE || path.join(RELAY_HOME, "worktrees");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (!fs.existsSync(path.join(REPO_PATH, ".git"))) {
  const msg = !fs.existsSync(REPO_PATH)
    ? `repo path does not exist: ${REPO_PATH}`
    : `not a git repository: ${REPO_PATH}`;
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// Codex CLI check (only needed for --register)
if (REGISTER && !WORKTREE_PATH) {
  try {
    execFileSync("codex", ["--version"], { encoding: "utf-8", stdio: "pipe" });
  } catch {
    console.error("Error: codex CLI not found. Needed for --register. Install: https://github.com/openai/codex");
    process.exit(1);
  }
}

if (REGISTER) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const stateDb = path.join(codexHome, "state_5.sqlite");
  if (!fs.existsSync(stateDb)) {
    console.error(`Error: Codex state DB not found: ${stateDb}`);
    console.error("Is Codex Desktop App installed? Use without --register.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(repoDir, ...gitArgs) {
  return execFileSync("git", ["-C", repoDir, ...gitArgs], { encoding: "utf-8" }).trim();
}

function assertWithin(base, resolved, label) {
  const norm = path.resolve(resolved);
  if (!norm.startsWith(base + path.sep) && norm !== base) {
    console.error(`Error: ${label} escapes base directory: ${norm}`);
    process.exit(1);
  }
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let wtPath, branch;

  if (WORKTREE_PATH) {
    // ---- External worktree mode ----
    // Register an existing worktree created by dispatch.js or manually.
    wtPath = path.resolve(WORKTREE_PATH);
    if (!fs.existsSync(wtPath)) {
      console.error(`Error: worktree path does not exist: ${wtPath}`);
      process.exit(1);
    }
    branch = BRANCH;
    if (!branch) {
      try {
        branch = git(wtPath, "rev-parse", "--abbrev-ref", "HEAD");
      } catch {
        console.error("Error: --branch required (could not detect from worktree)");
        process.exit(1);
      }
    }
  } else {
    // ---- Standard mode: create new worktree ----
    const wtId = crypto.randomBytes(4).toString("hex");
    wtPath = path.join(WORKTREES_DIR, wtId, PROJECT_NAME);
    branch = BRANCH || `codex/wt-${wtId}-${PROJECT_NAME}`;

    if (fs.existsSync(wtPath)) {
      console.error(`Error: worktree path already exists: ${wtPath}`);
      process.exit(1);
    }

    // --- Dry run ---
    if (DRY_RUN) {
      const includeFiles = getWorktreeIncludeFiles(REPO_PATH);
      const plan = { worktree: wtPath, branch, title: TITLE, register: REGISTER, pin: PIN, copyEnv: COPY_ENV, worktreeinclude: includeFiles };
      if (JSON_OUT) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.log("Dry run:");
        console.log(`  Worktree: ${wtPath}`);
        console.log(`  Branch:   ${branch}`);
        console.log(`  Title:    ${TITLE}`);
        console.log(`  Register: ${REGISTER}`);
        if (PIN) console.log("  Pinned:   yes");
        if (COPY_ENV) console.log("  Copy:     .env");
        if (includeFiles.length) console.log(`  .worktreeinclude: ${includeFiles.join(", ")}`);
      }
      return;
    }

    // --- Step 1: Create git worktree ---
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    try {
      git(REPO_PATH, "worktree", "add", wtPath, "-b", branch);
    } catch {
      try {
        git(REPO_PATH, "worktree", "add", wtPath, branch);
      } catch (e) {
        console.error(`Error: failed to create worktree for branch '${branch}': ${e.message}`);
        process.exit(1);
      }
    }

    // --- Step 2: Copy files (.worktreeinclude + explicit flags) ---
    copyWorktreeFiles(REPO_PATH, wtPath, {
      copyEnv: COPY_ENV,
      copyFiles: COPY_FILES,
      assertWithin,
    });
  }

  // --- Step 3 (optional): Register in Codex state ---
  let threadId = null;
  if (REGISTER) {
    const reg = registerCodexApp({ wtPath, repoPath: REPO_PATH, branch, title: TITLE, pin: PIN });
    threadId = reg.threadId;
  }

  // --- Output ---
  const result = {
    worktree: wtPath,
    branch,
    threadId,
    title: TITLE,
    registered: REGISTER,
    exec: WORKTREE_PATH ? null : `codex exec -C ${shellQuote(wtPath)} --full-auto "your task here"`,
    resume: REGISTER ? `codex resume ${threadId}` : null,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nWorktree ${WORKTREE_PATH ? "registered" : "created"}:\n`);
    console.log(`  Path:   ${wtPath}`);
    console.log(`  Branch: ${branch}`);
    if (REGISTER) {
      console.log(`  Thread: ${threadId}`);
      console.log(`\n  Restart Codex App to see the thread.`);
      console.log(`  Resume: codex resume ${threadId}`);
    } else {
      console.log(`\n  Run:    codex exec -C ${shellQuote(wtPath)} --full-auto "your task"`);
      console.log(`  Thread will appear in App after exec + App restart.`);
    }
    if (PIN) console.log("  Pinned: yes (won't be auto-cleaned).");
  }
}

main();
