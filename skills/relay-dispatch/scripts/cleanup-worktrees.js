#!/usr/bin/env node
/**
 * Prune stale dispatch worktrees from ~/.codex/worktrees/.
 *
 * Usage: ./cleanup-worktrees.js [options]
 *
 * Options:
 *   --older-than <hours>  Only remove worktrees older than N hours (default: 24)
 *   --dry-run             Show what would be removed without removing
 *   --all                 Remove all dispatch worktrees regardless of age
 *   --json                Output as JSON
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const OLDER_THAN = hasFlag("--all") ? 0 : parseInt(getArg("--older-than", "24"), 10);
const DRY_RUN = hasFlag("--dry-run");
const JSON_OUT = hasFlag("--json");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const WORKTREES_DIR = path.join(CODEX_HOME, "worktrees");

if (!fs.existsSync(WORKTREES_DIR)) {
  if (JSON_OUT) console.log(JSON.stringify({ removed: 0, skipped: 0, errors: 0 }));
  else console.log("No worktrees directory found.");
  process.exit(0);
}

const now = Date.now();
const cutoff = now - OLDER_THAN * 60 * 60 * 1000;
const results = { removed: [], skipped: [], errors: [] };

for (const entry of fs.readdirSync(WORKTREES_DIR)) {
  const wtDir = path.join(WORKTREES_DIR, entry);
  const stat = fs.statSync(wtDir);
  if (!stat.isDirectory()) continue;

  const age = Math.round((now - stat.mtimeMs) / (60 * 60 * 1000));

  if (stat.mtimeMs > cutoff) {
    results.skipped.push({ dir: entry, age: `${age}h` });
    continue;
  }

  // Find the actual worktree path (wtDir/<project-name>/)
  const subDirs = fs.readdirSync(wtDir).filter(
    (d) => fs.statSync(path.join(wtDir, d)).isDirectory()
  );
  const projectDir = subDirs.length === 1 ? path.join(wtDir, subDirs[0]) : wtDir;

  if (DRY_RUN) {
    results.removed.push({ dir: entry, age: `${age}h`, action: "would remove" });
    continue;
  }

  try {
    // Try git worktree remove first (proper cleanup)
    execFileSync("git", ["worktree", "remove", "--force", projectDir], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    results.removed.push({ dir: entry, age: `${age}h` });
  } catch {
    // Fallback: remove directory directly
    try {
      fs.rmSync(wtDir, { recursive: true, force: true });
      results.removed.push({ dir: entry, age: `${age}h`, method: "rm" });
    } catch (e) {
      results.errors.push({ dir: entry, error: e.message.split("\n")[0] });
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    removed: results.removed.length,
    skipped: results.skipped.length,
    errors: results.errors.length,
    details: results,
  }, null, 2));
} else {
  const action = DRY_RUN ? "Would remove" : "Removed";
  if (results.removed.length) {
    console.log(`${action} ${results.removed.length} worktree(s):`);
    results.removed.forEach((r) => console.log(`  ${r.dir} (${r.age} old)`));
  }
  if (results.skipped.length) {
    console.log(`Skipped ${results.skipped.length} worktree(s) (< ${OLDER_THAN}h old)`);
  }
  if (results.errors.length) {
    console.log(`Errors: ${results.errors.length}`);
    results.errors.forEach((e) => console.log(`  ${e.dir}: ${e.error}`));
  }
  if (!results.removed.length && !results.errors.length) {
    console.log("No stale worktrees found.");
  }
}
