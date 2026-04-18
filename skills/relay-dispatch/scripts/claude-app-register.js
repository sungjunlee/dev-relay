/**
 * Claude relay-side registration receipt.
 *
 * Writes a small metadata record under RELAY_HOME documenting that a worktree
 * was registered for Claude usage. Claude Code owns real session creation
 * under ~/.claude/projects/ on first invocation; this helper never writes
 * there.
 */

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function getClaudeVersion() {
  try {
    return execFileSync("claude", ["--version"], { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function resolveReceiptDir(wtPath, worktreesDir) {
  const resolvedWorktreePath = path.resolve(wtPath);
  const relative = path.relative(worktreesDir, resolvedWorktreePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    const wtHash = relative.split(path.sep)[0];
    if (wtHash) return path.join(worktreesDir, wtHash);
  }
  const wtHash = crypto.createHash("sha256").update(resolvedWorktreePath).digest("hex").slice(0, 8);
  return path.join(worktreesDir, wtHash);
}

function registerClaudeApp({ wtPath, repoPath, branch, title, pin = false }) {
  const relayHome = process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  const worktreesDir = process.env.RELAY_WORKTREE_BASE || path.join(relayHome, "worktrees");
  const receiptDir = resolveReceiptDir(wtPath, worktreesDir);
  const metadataPath = path.join(receiptDir, "claude-registration.json");
  const sessionId = generateUUIDv7();

  let commitHash = "";
  let repositoryUrl = "";
  try { commitHash = git(wtPath, "rev-parse", "HEAD"); } catch {}
  try { repositoryUrl = git(repoPath, "remote", "get-url", "origin"); } catch {}

  const metadata = {
    version: "1",
    created_at: nowISO(),
    session_id: sessionId,
    branch,
    title,
    pin,
    cli_version: getClaudeVersion(),
    git: {
      commit_hash: commitHash,
      repository_url: repositoryUrl,
    },
    note: "Claude Code creates real session JSONL on first invocation under ~/.claude/projects/<slug>/; this file is a relay-side registration receipt.",
  };

  fs.mkdirSync(receiptDir, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify(metadata) + "\n", "utf-8");

  return { sessionId, metadataPath };
}

module.exports = { registerClaudeApp };
