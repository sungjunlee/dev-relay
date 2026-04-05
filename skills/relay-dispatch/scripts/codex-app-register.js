/**
 * Codex App registration — require()-able module.
 *
 * Registers a worktree as a Codex App thread by writing rollout metadata,
 * inserting into SQLite, and updating global state JSON.
 *
 * Used by dispatch.js (direct call) and create-worktree.js (CLI wrapper).
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const SOURCE = "vscode";
const MODEL_PROVIDER = "openai";
const SANDBOX_POLICY = "workspaceWrite";
const APPROVAL_MODE = "onFailure";
const MEMORY_MODE = "enabled";

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

function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function ensureInArray(obj, key, value) {
  const arr = obj[key] || [];
  if (!arr.includes(value)) arr.push(value);
  obj[key] = arr;
}

/**
 * Register a worktree as a Codex App thread.
 *
 * @param {object} options
 * @param {string} options.wtPath    - Worktree directory
 * @param {string} options.repoPath  - Repository root (for git origin)
 * @param {string} options.branch    - Git branch name
 * @param {string} options.title     - Thread title for Codex App
 * @param {boolean} [options.pin]    - Pin thread to prevent auto-cleanup
 * @returns {{ threadId: string }}
 */
function registerCodexApp({ wtPath, repoPath, branch, title, pin = false }) {
  const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const STATE_DB = path.join(CODEX_HOME, "state_5.sqlite");
  const GLOBAL_STATE = path.join(CODEX_HOME, ".codex-global-state.json");
  const SESSION_INDEX = path.join(CODEX_HOME, "session_index.jsonl");

  const threadId = generateUUIDv7();
  const now = nowISO();
  const epoch = Math.floor(Date.now() / 1000);

  let gitSha = "", gitOrigin = "";
  try { gitSha = git(wtPath, "rev-parse", "HEAD"); } catch {}
  try { gitOrigin = git(repoPath, "remote", "get-url", "origin"); } catch {}

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

  // SQLite via stdin (no shell). esc() sanitizes string values for single-quoted SQL literals.
  const esc = (s) => String(s).replace(/'/g, "''").replace(/[\x00\n\r\\]/g, "");
  sql(STATE_DB, `INSERT OR REPLACE INTO threads (
    id, rollout_path, created_at, updated_at, source, model_provider, cwd,
    title, sandbox_policy, approval_mode, tokens_used, has_user_event,
    archived, cli_version, first_user_message, memory_mode,
    git_sha, git_branch, git_origin_url
  ) VALUES (
    '${esc(threadId)}', '${esc(rolloutPath)}', ${epoch}, ${epoch},
    '${SOURCE}', '${MODEL_PROVIDER}', '${esc(wtPath)}', '${esc(title)}',
    '${SANDBOX_POLICY}', '${APPROVAL_MODE}', 0, 0, 0, '${esc(cliVersion)}',
    '${esc(title)}', '${MEMORY_MODE}', '${esc(gitSha)}', '${esc(branch)}', '${esc(gitOrigin)}'
  );`);

  // Global state — atomic write via rename
  const gs = JSON.parse(fs.readFileSync(GLOBAL_STATE, "utf-8"));
  if (!gs["thread-workspace-root-hints"]) gs["thread-workspace-root-hints"] = {};
  gs["thread-workspace-root-hints"][threadId] = repoPath;
  ensureInArray(gs, "electron-saved-workspace-roots", repoPath);
  if (pin) ensureInArray(gs, "pinned-thread-ids", threadId);
  const tmpPath = GLOBAL_STATE + ".tmp." + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(gs, null, 2) + "\n");
  fs.renameSync(tmpPath, GLOBAL_STATE);

  // Session index
  fs.appendFileSync(SESSION_INDEX, JSON.stringify({ id: threadId, thread_name: title, updated_at: now }) + "\n");

  return { threadId };
}

module.exports = { registerCodexApp };
