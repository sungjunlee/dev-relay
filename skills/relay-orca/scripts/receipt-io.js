"use strict";

// Top-level (NON-lib) filesystem + subprocess helpers shared by run.js and status.js
// (#945). Per the architectural constraint, ALL subprocess and filesystem mutation
// lives in top-level scripts; the pure lib/ modules receive injected I/O. This file
// sits directly under scripts/ (not scripts/lib/), so plan.js's frozen lib
// source-scan never touches it.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { computeRepoSlug } = require("./lib/repo-slug");

const GIT_TIMEOUT_MS = 10000;

// Canonicalize the repo root the SAME way relay's manifest/paths.js does: resolve the
// git common dir and realpath its parent (collapsing a linked worktree to the main
// checkout). A --repo-root override skips git and realpaths the given path directly —
// the hermetic path tests use. The slug is then computed by the replicated algorithm.
function resolveCanonicalRepoRoot({ repoRootOverride, cwd } = {}) {
  if (repoRootOverride) return fs.realpathSync(repoRootOverride);
  const dir = cwd || process.cwd();
  const commonDirText = execFileSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  }).trim();
  const commonDir = path.isAbsolute(commonDirText) ? commonDirText : path.resolve(dir, commonDirText);
  return fs.realpathSync(path.dirname(commonDir));
}

function resolveRepoContext(options = {}) {
  const root = resolveCanonicalRepoRoot(options);
  return { root, slug: computeRepoSlug(root) };
}

function absoluteEnvDir(envValue) {
  return typeof envValue === "string" && envValue.trim() !== "" && path.isAbsolute(envValue.trim())
    ? envValue.trim()
    : null;
}

// Programs root is overridable for tests via RELAY_ORCA_PROGRAMS_ROOT (must be an
// absolute path; invalid values are ignored and the default is used) — D1.
function programsRoot() {
  return absoluteEnvDir(process.env.RELAY_ORCA_PROGRAMS_ROOT) || path.join(os.homedir(), ".relay", "programs");
}

// Runs root is overridable for tests via RELAY_ORCA_RUNS_ROOT (same rule) — D4.
function runsRoot() {
  return absoluteEnvDir(process.env.RELAY_ORCA_RUNS_ROOT) || path.join(os.homedir(), ".relay", "runs");
}

// Program id → a single safe path segment (never traverses). run.js and status.js
// apply this identically so a `run`-written receipt resolves back for `status`.
function programSegment(programId) {
  const safe = String(programId == null ? "" : programId).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "program";
}

function receiptPathFor(slug, programId) {
  return path.join(programsRoot(), slug, programSegment(programId), "receipt.json");
}

// Atomic write: a temp file in the SAME directory, then rename. A partial/torn
// receipt is impossible by construction — the rename is the only publish step (D1).
// The low-level fs primitives are injectable so the atomicity is unit-testable.
function writeReceiptAtomic(finalPath, text, io = fs) {
  const dir = path.dirname(finalPath);
  io.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.receipt.${process.pid}.${Date.now()}.tmp`);
  io.writeFileSync(tmp, text, "utf-8");
  io.renameSync(tmp, finalPath);
  return finalPath;
}

function readReceiptFile(finalPath) {
  return fs.readFileSync(finalPath, "utf-8");
}

function receiptExists(finalPath) {
  return fs.existsSync(finalPath);
}

// List relay manifests for a repo slug as { run_id, file, text }. run_id is the
// manifest filename stem; text is the raw bytes (parsing happens in the pure lib).
function listManifestFiles(slug) {
  const dir = path.join(runsRoot(), slug);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({
      run_id: name.replace(/\.md$/, ""),
      file: path.join(dir, name),
      text: fs.readFileSync(path.join(dir, name), "utf-8"),
    }));
}

// Best-effort GitHub URL construction from the repo's origin remote — read-only and
// never a `gh` call (the fake gh poisons non-read subcommands). Returns null when the
// remote/owner cannot be resolved (tests run in a bare temp repo-root → null).
function makeUrlResolver(repoRoot) {
  let ownerRepo = null;
  try {
    const remote = execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    if (match) ownerRepo = `${match[1]}/${match[2]}`;
  } catch {
    ownerRepo = null;
  }
  return (kind, number) => (ownerRepo && number != null ? `https://github.com/${ownerRepo}/${kind}/${number}` : null);
}

module.exports = {
  resolveCanonicalRepoRoot,
  resolveRepoContext,
  programsRoot,
  runsRoot,
  programSegment,
  receiptPathFor,
  writeReceiptAtomic,
  readReceiptFile,
  receiptExists,
  listManifestFiles,
  makeUrlResolver,
};
