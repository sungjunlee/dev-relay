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
 *   --copy <file,...>        Additional files to copy (comma-separated)
 *   --pin                    Pin thread to prevent auto-cleanup (4 days)
 *   --register               Pre-register in SQLite + global state
 *   --dry-run                Show plan without executing
 *   --json                   Output as JSON
 *
 * Examples:
 *   ./create-worktree.js . --branch feature-auth
 *   ./create-worktree.js . -b feature-auth -t "Implement OAuth2" --register --pin
 *   ./create-worktree.js . --topic auth
 *   ./create-worktree.js . --worktree-path /path/to/wt -b feature -t "Task title"
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const {
  createWorktree,
  formatPlan,
  registerWorktree,
} = require("./worktree-runtime");
const { getArg, getPositionals, hasFlag, modeLabel } = require("./cli-args");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const KNOWN_FLAGS = [
  "--branch", "-b", "--title", "-t", "--topic", "--worktree-path", "--copy",
  "--pin", "--register", "--dry-run", "--json", "--help", "-h",
];
const CLI_ARG_OPTIONS = { commandName: "create-worktree", reservedFlags: KNOWN_FLAGS };
const hasCliFlag = (flag) => hasFlag(args, flag, CLI_ARG_OPTIONS);

if (!args.length || hasCliFlag(["--help", "-h"])) {
  console.log(
    "Usage: create-worktree.js <repo-path> [--branch <name>] [--title <text>]"
  );
  console.log(
    "       [--topic <name>] [--worktree-path <path>] [--copy <files>]"
  );
  console.log("       [--pin] [--register] [--dry-run] [--json]");
  console.log("\nOptions:");
  console.log(`  --branch, -b       ${modeLabel("--branch")} Branch name (default: auto from topic)`);
  console.log(`  --title, -t        ${modeLabel("--title")} Thread title in Codex App`);
  console.log(`  --topic            ${modeLabel("--topic")} Topic slug -> branch becomes codex/<topic>`);
  console.log(`  --worktree-path    ${modeLabel("--worktree-path")} Register an existing worktree`);
  console.log(`  --copy             ${modeLabel("--copy")} Additional files to copy`);
  console.log(`  --pin              ${modeLabel("--pin")} Pin thread to prevent auto-cleanup`);
  console.log(`  --register         ${modeLabel("--register")} Pre-register in SQLite + global state`);
  console.log(`  --dry-run          ${modeLabel("--dry-run")} Show plan without executing`);
  console.log(`  --json             ${modeLabel("--json")} Output as JSON`);
  process.exit(hasCliFlag(["--help", "-h"]) ? 0 : 1);
}

const repoPathRaw = getPositionals(args, "create-worktree")[0];
const REPO_PATH = path.resolve(repoPathRaw || ".");
const PROJECT_NAME = path.basename(REPO_PATH);
const TOPIC = getArg(args, "--topic", undefined, CLI_ARG_OPTIONS);
const BRANCH = getArg(args, ["--branch", "-b"], TOPIC ? `codex/${TOPIC}` : undefined, CLI_ARG_OPTIONS);
const TITLE = getArg(
  args,
  ["--title", "-t"],
  BRANCH ? `Worktree: ${BRANCH}` : `Worktree: ${PROJECT_NAME}`,
  CLI_ARG_OPTIONS
);
const WORKTREE_PATH = getArg(args, "--worktree-path", undefined, CLI_ARG_OPTIONS);
const COPY_FILES = getArg(args, "--copy", "", CLI_ARG_OPTIONS)
  .split(",")
  .filter(Boolean);
const PIN = hasCliFlag("--pin");
// --worktree-path implies --register (the only reason to use it)
const REGISTER = hasCliFlag("--register") || !!WORKTREE_PATH;
const DRY_RUN = hasCliFlag("--dry-run");
const JSON_OUT = hasCliFlag("--json");

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
  let createResult = null;

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
      const plan = createWorktree({
        repoRoot: REPO_PATH,
        worktreePath: wtPath,
        branch,
        title: TITLE,
        register: REGISTER,
        pin: PIN,
        dryRun: true,
      });
      if (JSON_OUT) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.log(formatPlan({
          worktreePath: wtPath,
          branch,
          title: TITLE,
          register: REGISTER,
          pin: PIN,
          includeFiles: plan.worktreeinclude,
        }));
      }
      return;
    }

    try {
      createResult = createWorktree({
        repoRoot: REPO_PATH,
        worktreePath: wtPath,
        branch,
        title: TITLE,
        copyFiles: COPY_FILES,
        register: REGISTER,
        pin: PIN,
        assertWithin,
      });
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  }

  // --- Step 3 (optional): Register in Codex state ---
  let threadId = null;
  if (REGISTER && WORKTREE_PATH) {
    const reg = registerWorktree({ repoRoot: REPO_PATH, worktreePath: wtPath, branch, title: TITLE, pin: PIN });
    threadId = reg.threadId;
  } else if (REGISTER) {
    threadId = createResult?.threadId || null;
  }

  // --- Output ---
  const result = {
    worktree: wtPath,
    branch,
    threadId,
    title: TITLE,
    registered: REGISTER,
    exec: WORKTREE_PATH ? null : `<executor> exec -C ${shellQuote(wtPath)} "your task here"`,
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
      console.log(`\n  Run:    dispatch.js ${shellQuote(REPO_PATH)} -b ${branch} --prompt "your task"`);
      console.log(`  Or manually: codex exec -C ${shellQuote(wtPath)} --full-auto "your task"`);
    }
    if (PIN) console.log("  Pinned: yes (won't be auto-cleaned).");
  }
}

main();
