/**
 * .worktreeinclude support — reads patterns from .worktreeinclude and copies
 * matching gitignored files to worktrees.
 *
 * Follows the same convention as Claude Code Desktop, Cline, and Roo Code:
 * only files matching BOTH .worktreeinclude AND .gitignore are copied.
 *
 * Used by dispatch.js and create-worktree.js.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Pattern parsing
// ---------------------------------------------------------------------------

/** Read .worktreeinclude and return non-empty, non-comment lines. */
function readPatterns(repoPath) {
  const file = path.join(repoPath, ".worktreeinclude");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// ---------------------------------------------------------------------------
// Glob expansion (no external deps — Node 18+ compatible)
// ---------------------------------------------------------------------------

/** Expand a single pattern to matching file paths (relative to repoPath). */
function expandPattern(repoPath, pattern) {
  const hasGlob = /[*?[]/.test(pattern);

  if (!hasGlob) {
    const full = path.join(repoPath, pattern);
    if (!fs.existsSync(full)) return [];
    if (fs.statSync(full).isDirectory()) return readdirRec(repoPath, pattern);
    return [pattern];
  }

  // Split on / and expand segment-by-segment
  return expandParts(repoPath, "", pattern.split("/"));
}

function expandParts(repoPath, prefix, parts) {
  if (!parts.length) return prefix ? [prefix] : [];
  const [seg, ...rest] = parts;
  const dir = path.join(repoPath, prefix);
  if (!fs.existsSync(dir)) return [];

  if (!/[*?[]/.test(seg)) {
    const next = prefix ? `${prefix}/${seg}` : seg;
    return rest.length ? expandParts(repoPath, next, rest) : (fs.existsSync(path.join(repoPath, next)) ? [next] : []);
  }

  const re = segToRegex(seg);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }

  const out = [];
  for (const e of entries) {
    if (!re.test(e)) continue;
    const next = prefix ? `${prefix}/${e}` : e;
    if (!rest.length) {
      out.push(next);
    } else {
      out.push(...expandParts(repoPath, next, rest));
    }
  }
  return out;
}

/** Convert a single glob segment (no /) to a RegExp. */
function segToRegex(seg) {
  let r = "^";
  for (const ch of seg) {
    if (ch === "*") r += "[^/]*";
    else if (ch === "?") r += "[^/]";
    else if (".+^${}()|[]\\".includes(ch)) r += "\\" + ch;
    else r += ch;
  }
  return new RegExp(r + "$");
}

/** Recursively list all files under a directory (relative paths). */
function readdirRec(repoPath, dirPrefix) {
  const out = [];
  const abs = path.join(repoPath, dirPrefix);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dirPrefix}/${e.name}`;
    if (e.isDirectory()) out.push(...readdirRec(repoPath, rel));
    else out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git-ignore filter
// ---------------------------------------------------------------------------

/** Return subset of relPaths that git considers ignored. */
function filterGitIgnored(repoPath, relPaths) {
  if (!relPaths.length) return [];
  try {
    const out = execFileSync(
      "git", ["-C", repoPath, "check-ignore", "--stdin"],
      { input: relPaths.join("\n"), encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return out.trim().split("\n").filter(Boolean);
  } catch (e) {
    // exit 1 = none ignored; stdout may still have partial matches
    const s = (e.stdout || "").trim();
    return s ? s.split("\n") : [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get files listed in .worktreeinclude that are also gitignored.
 * Returns array of relative paths.
 */
function getWorktreeIncludeFiles(repoPath) {
  const patterns = readPatterns(repoPath);
  if (!patterns.length) return [];

  // Expand all patterns to concrete file paths
  const candidates = [];
  for (const p of patterns) candidates.push(...expandPattern(repoPath, p));
  if (!candidates.length) return [];

  // Safety: only copy gitignored files
  const ignored = new Set(filterGitIgnored(repoPath, candidates));
  return candidates.filter((f) => ignored.has(f));
}

/**
 * Copy .worktreeinclude files + explicit flags to worktree.
 *
 * @param {string} repoPath - Source repo root
 * @param {string} wtPath - Worktree destination
 * @param {Object} opts
 * @param {string[]} opts.copyFiles - --copy flag entries
 * @param {Function} opts.assertWithin - Path traversal guard (repoPath, resolved, label)
 * @returns {{ copied: string[], skipped: string[] }}
 */
function copyWorktreeFiles(repoPath, wtPath, { copyFiles = [], assertWithin } = {}) {
  // .worktreeinclude — only gitignored files (safety rule)
  const includeFiles = getWorktreeIncludeFiles(repoPath);

  // Explicit flags — no gitignore check (user explicitly requested)
  const explicit = new Set();
  for (const f of copyFiles) explicit.add(f);

  // Merge and deduplicate
  const all = new Set([...includeFiles, ...explicit]);

  const copied = [];
  const skipped = [];

  for (const rel of all) {
    const src = path.resolve(repoPath, rel);
    const dst = path.resolve(wtPath, rel);

    if (assertWithin) {
      assertWithin(repoPath, src, "copy source");
      assertWithin(wtPath, dst, "copy destination");
    }

    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied.push(rel);
    } else {
      skipped.push(rel);
    }
  }

  return { copied, skipped };
}

module.exports = { getWorktreeIncludeFiles, copyWorktreeFiles };
