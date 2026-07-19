"use strict";

// Top-level (NON-lib) filesystem + subprocess helpers shared by run.js and status.js
// (#945). Per the architectural constraint, ALL subprocess and filesystem mutation
// lives in top-level scripts; the pure lib/ modules receive injected I/O. This file
// sits directly under scripts/ (not scripts/lib/), so plan.js's frozen lib
// source-scan never touches it.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { computeRepoSlug } = require("./lib/repo-slug");
const { boundedExcerpt } = require("./lib/bounded-excerpt");

const GIT_TIMEOUT_MS = 10000;

// A24: a repo root that cannot be git-canonicalized FAILS CLOSED. Both `run` and
// `status` catch this and reject with `RECEIPT_REPO_MISMATCH` (exit 52) — the SAME
// fail-closed reason `status` already uses for a cross-repo receipt — rather than
// deriving a slug from a plain realpath of an arbitrary directory, which could silently
// point run/status at ANOTHER repository's receipts. It carries the reason_code/exitCode
// shape both top-level scripts' rejection paths expect.
class CanonicalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CanonicalizationError";
    this.reasonCode = "RECEIPT_REPO_MISMATCH";
    this.exitCode = 52;
    this.remediation =
      "Invoke relay-orca `run`/`status` from inside the git repository (or pass a --repo-root that is a git checkout); the repo root must be git-canonicalizable — there is no realpath fallback.";
  }
}

// Canonicalize the repo root the SAME way relay's manifest/paths.js `getCanonicalRepoRoot`
// does: run `git rev-parse --git-common-dir` at the provided root (or cwd), take that common
// dir's PARENT, and realpath it. This collapses a LINKED WORKTREE to the PRIMARY checkout
// root, so a receipt written from a worktree resolves back to the same slug relay used for
// the primary checkout — and `run` and `status` derive the same slug from the same input.
// The `--repo-root` override (A22) is canonicalized through git identically — it is NOT
// realpath'd directly — so pointing status/run at a linked worktree still derives the
// primary slug. On ANY git failure (not a repo, git missing, timeout) it FAILS CLOSED
// (A24): there is NO realpath fallback, because deriving a slug from a plain realpath of
// an arbitrary directory could silently read/write ANOTHER repo's receipts. It throws a
// CanonicalizationError (RECEIPT_REPO_MISMATCH, exit 52) carrying a bounded excerpt of
// the git error. The slug is then computed from this canonical root by the replicated
// algorithm.
function resolveCanonicalRepoRoot({ repoRootOverride, cwd } = {}) {
  const startDir = repoRootOverride || cwd || process.cwd();
  try {
    const commonDirText = execFileSync("git", ["-C", startDir, "rev-parse", "--git-common-dir"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    const commonDir = path.isAbsolute(commonDirText) ? commonDirText : path.resolve(startDir, commonDirText);
    return fs.realpathSync(path.dirname(commonDir));
  } catch (error) {
    const detail = boundedExcerpt(error && error.stderr ? String(error.stderr) : (error && error.message) || String(error));
    throw new CanonicalizationError(
      `repo root could not be canonicalized via git rev-parse at ${startDir}: ${detail}`,
    );
  }
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

// Relay manifests root resolution (#945 D4/A5). First hit wins; each candidate must be
// an ABSOLUTE path (invalid → fall through to the next). This mirrors relay's own
// resolution precedence so `status` reconciles against the same runs directory relay
// wrote its manifests to:
//   1. RELAY_ORCA_RUNS_ROOT   (relay-orca-specific override; tests use this)
//   2. RELAY_RUNS_BASE        (relay's runs-base override)
//   3. RELAY_HOME + "/runs"   (relay's home override)
//   4. ~/.relay/runs          (default)
function runsRoot() {
  const orcaRoot = absoluteEnvDir(process.env.RELAY_ORCA_RUNS_ROOT);
  if (orcaRoot) return orcaRoot;
  const runsBase = absoluteEnvDir(process.env.RELAY_RUNS_BASE);
  if (runsBase) return runsBase;
  const relayHome = absoluteEnvDir(process.env.RELAY_HOME);
  if (relayHome) return path.join(relayHome, "runs");
  return path.join(os.homedir(), ".relay", "runs");
}

// Fleet manifests root resolution (#945 A8). relay-fleet manifests live UNDER RELAY'S
// FLEETS ROOT — a directory SEPARATE from the runs root that holds child run manifests
// (confirmed in relay-dispatch's manifest/paths.js: `getFleetsBase()` returns
// `RELAY_HOME + "/fleets"`, defaulting to `~/.relay/fleets`, with NO dedicated
// fleets-base env of its own). This resolver mirrors the runsRoot precedence pattern
// (first hit wins; each candidate must be an ABSOLUTE path or it falls through to the
// next), adapted to that convention so `status` reads fleet manifests from the same
// place relay-fleet wrote them:
//   1. RELAY_ORCA_FLEETS_ROOT (relay-orca-specific override; tests use this)
//   2. RELAY_FLEETS_BASE      (the RELAY_RUNS_BASE parallel; honored if it is ever set)
//   3. RELAY_HOME + "/fleets" (relay-fleet's actual convention)
//   4. ~/.relay/fleets        (default)
function fleetsRoot() {
  const orcaRoot = absoluteEnvDir(process.env.RELAY_ORCA_FLEETS_ROOT);
  if (orcaRoot) return orcaRoot;
  const fleetsBase = absoluteEnvDir(process.env.RELAY_FLEETS_BASE);
  if (fleetsBase) return fleetsBase;
  const relayHome = absoluteEnvDir(process.env.RELAY_HOME);
  if (relayHome) return path.join(relayHome, "fleets");
  return path.join(os.homedir(), ".relay", "fleets");
}

// Program id → a single safe path segment (never traverses) that is ALSO
// collision-resistant (#945 A6). A pure sanitize is lossy — `"a b"` and `"a+b"` both
// collapse to `"a-b"`, which would silently point two distinct programs at ONE receipt.
// So the segment is the sanitized base joined to the first 8 hex of sha256(raw id): the
// hash disambiguates ids that sanitize identically while the sanitized prefix keeps the
// path human-readable. run.js and status.js apply this identically, so a `run`-written
// receipt resolves back for `status`. `.` and `..` (and empty) collapse to `program`
// so a pathological id can never escape <programs-root>/<repo-slug>/<segment>/, and the
// hash still keeps `.` and `..` on distinct paths.
// A15: the readable prefix is bounded to at most 64 chars so a very long program id can
// never overflow the filesystem per-segment name limit (NAME_MAX, typically 255). The
// 8-hex hash is ALWAYS appended and is computed over the FULL raw id, so two long ids
// that share a 64-char prefix still resolve to DISTINCT segments.
const MAX_SEGMENT_PREFIX = 64;

function programSegment(programId) {
  const raw = String(programId == null ? "" : programId);
  const sanitized = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const readable = sanitized === "" || sanitized === "." || sanitized === ".." ? "program" : sanitized;
  // Truncate to the readable-prefix bound, re-trimming any trailing dash the cut exposes
  // (the first char is always non-dash, so the result is never empty).
  const base = readable.slice(0, MAX_SEGMENT_PREFIX).replace(/-+$/, "");
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
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

// #1019 integration lifecycle I/O stays at the top-level script boundary. The pure
// lifecycle state machine receives these adapters so plan.js's lib source-scan remains
// intact while run/resume still get a bounded per-program/outcome lock and deterministic
// evidence reads.
const INTEGRATION_LOCK_TIMEOUT_MS = 5000;
const INTEGRATION_LOCK_POLL_MS = 10;

function integrationLockName({ programId, outcomeId, taskId }) {
  return crypto.createHash("sha256").update(`${programId}\0${outcomeId}\0${taskId}`).digest("hex");
}

function integrationSleep(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function withIntegrationLifecycleLock({ programId, outcomeId, taskId, lockRoot }, callback) {
  const root = path.resolve(lockRoot || path.join(os.tmpdir(), "relay-orca-integration-locks"));
  const lockPath = path.join(root, `${integrationLockName({ programId, outcomeId, taskId })}.lock`);
  const started = Date.now();
  let acquired = false;
  fs.mkdirSync(root, { recursive: true });
  while (!acquired && Date.now() - started <= INTEGRATION_LOCK_TIMEOUT_MS) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, "owner"), `${process.pid}\n`, "utf8");
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      integrationSleep(INTEGRATION_LOCK_POLL_MS);
    }
  }
  if (!acquired) throw new Error(`integration lifecycle lock timed out for ${programId}/${outcomeId}`);
  try {
    return callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function readIntegrationEvidenceFile(filePath) {
  if (!fs.existsSync(filePath)) return { present: false };
  try {
    return { present: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { present: true, invalid: true, error: error.message };
  }
}

function receiptExists(finalPath) {
  return fs.existsSync(finalPath);
}

// List relay manifest `.md` files under a root/<slug> directory as
// { run_id, file, text }. `run_id` is the manifest filename stem (for fleet manifests
// this stem is the fleet id); text is the raw bytes (parsing happens in the pure lib).
function listManifestFilesUnder(root, slug) {
  const dir = path.join(root, slug);
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

// Child run manifests live under the runs root.
function listManifestFiles(slug) {
  return listManifestFilesUnder(runsRoot(), slug);
}

// Fleet manifests live under the SEPARATE fleets root (#945 A8), keyed by fleet id.
function listFleetManifestFiles(slug) {
  return listManifestFilesUnder(fleetsRoot(), slug);
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
  CanonicalizationError,
  resolveCanonicalRepoRoot,
  resolveRepoContext,
  programsRoot,
  runsRoot,
  fleetsRoot,
  programSegment,
  receiptPathFor,
  writeReceiptAtomic,
  readReceiptFile,
  withIntegrationLifecycleLock,
  readIntegrationEvidenceFile,
  receiptExists,
  listManifestFiles,
  listFleetManifestFiles,
  makeUrlResolver,
};
