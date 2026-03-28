#!/usr/bin/env node
/**
 * Create a git worktree for Codex and optionally register it in Codex App state.
 *
 * Creates a worktree in ~/.codex/worktrees/ (Codex's managed location).
 * When codex exec runs there, the session auto-registers on next App restart.
 * Use --register to pre-register in SQLite for title/pin support.
 * Use --worktree-path to register an existing worktree (e.g., from dispatch.js).
 *
 * Usage:
 *   ./register-codex.js <repo-path> [options]
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
 *   ./register-codex.js . --branch feature-auth
 *   ./register-codex.js . -b feature-auth -t "Implement OAuth2" --register --pin
 *   ./register-codex.js . --topic auth --copy-env
 *   ./register-codex.js . --worktree-path /path/to/wt -b feature -t "Task title"
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: register-codex.js <repo-path> [--branch <name>] [--title <text>]"
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

const SOURCE = "vscode";
const MODEL_PROVIDER = "openai";
const SANDBOX_POLICY = "workspaceWrite";
const APPROVAL_MODE = "onFailure";
const MEMORY_MODE = "enabled";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const WORKTREES_DIR = path.join(CODEX_HOME, "worktrees");
const STATE_DB = path.join(CODEX_HOME, "state_5.sqlite");
const GLOBAL_STATE = path.join(CODEX_HOME, ".codex-global-state.json");
const SESSION_INDEX = path.join(CODEX_HOME, "session_index.jsonl");

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

// Codex CLI check (not needed in --worktree-path mode)
if (!WORKTREE_PATH) {
  try {
    execFileSync("codex", ["--version"], { encoding: "utf-8", stdio: "pipe" });
  } catch {
    console.error("Error: codex CLI not found. Install Codex first: https://github.com/openai/codex");
    process.exit(1);
  }
}

if (REGISTER && !fs.existsSync(STATE_DB)) {
  console.error(`Error: Codex state DB not found: ${STATE_DB}`);
  console.error("Is Codex Desktop App installed? Use without --register.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateUUIDv7() {
  const now = BigInt(Date.now());
  const buf = Buffer.alloc(16);
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64BE(now, 0);
  tsBuf.copy(buf, 0, 2, 8);
  const rand = crypto.randomBytes(10);
  rand.copy(buf, 6);
  buf[6] = (buf[6] & 0x0f) | 0x70;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = buf.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

function git(repoDir, ...gitArgs) {
  return execFileSync("git", ["-C", repoDir, ...gitArgs], { encoding: "utf-8" }).trim();
}

function sql(db, query) {
  execFileSync("sqlite3", [db], { input: query, encoding: "utf-8" });
}

function getCodexVersion() {
  try {
    return execFileSync("codex", ["--version"], { encoding: "utf-8" }).trim().replace(/^.*?v?(\d[\d.a-z-]*).*$/i, "$1");
  } catch {
    return "0.116.0";
  }
}

function assertWithin(base, resolved, label) {
  const norm = path.resolve(resolved);
  if (!norm.startsWith(base + path.sep) && norm !== base) {
    console.error(`Error: ${label} escapes base directory: ${norm}`);
    process.exit(1);
  }
}

function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function ensureInArray(obj, key, value) {
  const arr = obj[key] || [];
  if (!arr.includes(value)) arr.push(value);
  obj[key] = arr;
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
      const plan = { worktree: wtPath, branch, title: TITLE, register: REGISTER, pin: PIN, copyEnv: COPY_ENV };
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
  }

  // --- Step 3 (optional): Register in Codex state ---
  let threadId = null;
  if (REGISTER) {
    threadId = generateUUIDv7();
    const now = nowISO();
    const epoch = Math.floor(Date.now() / 1000);

    let gitSha = "", gitOrigin = "";
    try { gitSha = git(wtPath, "rev-parse", "HEAD"); } catch {}
    try { gitOrigin = git(REPO_PATH, "remote", "get-url", "origin"); } catch {}

    // Rollout file
    const cliVersion = getCodexVersion();
    const dateDir = now.slice(0, 10).replace(/-/g, "/");
    const sessDir = path.join(CODEX_HOME, "sessions", dateDir);
    fs.mkdirSync(sessDir, { recursive: true });
    const tsSlug = now.replace(/[:.]/g, "-").replace("Z", "");
    const rolloutPath = path.join(sessDir, `rollout-${tsSlug}-${threadId}.jsonl`);
    const meta = {
      timestamp: now,
      type: "session_meta",
      payload: {
        id: threadId, timestamp: now, cwd: wtPath,
        originator: "Claude Code (codex-bridge)",
        cli_version: cliVersion, source: SOURCE,
        model_provider: MODEL_PROVIDER,
        git: { commit_hash: gitSha, repository_url: gitOrigin },
      },
    };
    fs.writeFileSync(rolloutPath, JSON.stringify(meta) + "\n");

    // SQLite via stdin (no shell). esc() sanitizes string values; numeric values must not come from user input.
    const esc = (s) => s.replace(/'/g, "''");
    sql(STATE_DB, `INSERT OR REPLACE INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd,
      title, sandbox_policy, approval_mode, tokens_used, has_user_event,
      archived, cli_version, first_user_message, memory_mode,
      git_sha, git_branch, git_origin_url
    ) VALUES (
      '${esc(threadId)}', '${esc(rolloutPath)}', ${epoch}, ${epoch},
      '${SOURCE}', '${MODEL_PROVIDER}', '${esc(wtPath)}', '${esc(TITLE)}',
      '${SANDBOX_POLICY}', '${APPROVAL_MODE}', 0, 0, 0, '${esc(cliVersion)}',
      '${esc(TITLE)}', '${MEMORY_MODE}', '${esc(gitSha)}', '${esc(branch)}', '${esc(gitOrigin)}'
    );`);

    // Global state — atomic write via rename
    const gs = JSON.parse(fs.readFileSync(GLOBAL_STATE, "utf-8"));
    if (!gs["thread-workspace-root-hints"]) gs["thread-workspace-root-hints"] = {};
    gs["thread-workspace-root-hints"][threadId] = REPO_PATH;
    ensureInArray(gs, "electron-saved-workspace-roots", REPO_PATH);
    if (PIN) ensureInArray(gs, "pinned-thread-ids", threadId);
    const tmpPath = GLOBAL_STATE + ".tmp." + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(gs, null, 2) + "\n");
    fs.renameSync(tmpPath, GLOBAL_STATE);

    // Session index
    fs.appendFileSync(SESSION_INDEX, JSON.stringify({ id: threadId, thread_name: TITLE, updated_at: now }) + "\n");
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
