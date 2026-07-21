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
const { programSegment } = require("./lib/program-segment");

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

// Read the recorded owner pid of a held lock. Returns null for EVERY ambiguous shape — an
// absent owner file (the crash window between `mkdirSync` publishing the lock and the owner
// write landing), an unreadable file, or a non-numeric/out-of-range/trailing-garbage value.
// A null owner is NEVER reclaimed: an ambiguous lock is left to time out fail-closed rather
// than stolen from a possibly-live holder. There is deliberately no mtime lease fallback —
// an old mtime is not evidence that the owner is gone. (#1019 R3)
function readIntegrationLockOwnerPid(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(lockPath, "owner"), "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) ? pid : null;
}

// A process is "provably gone" ONLY when `process.kill(pid, 0)` — the OS liveness check that
// delivers no signal — reports exactly ESRCH. EPERM means the pid is live under another user,
// and any other error is ambiguous; both are treated as alive so contention still fails closed.
// Our own pid is never considered gone.
function integrationLockOwnerIsGone(pid) {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return Boolean(error) && error.code === "ESRCH";
  }
}

// Reclaim a lock whose recorded owner is provably dead. The rename-then-remove makes the
// reclaim atomic: among racing reclaimers exactly one rename succeeds, and every loser sees
// ENOENT and simply keeps polling (it can then contend for the lock normally). Renaming
// rather than removing in place also means a lock freshly acquired by a competitor can never
// be deleted out from under it by a half-completed reclaim.
function reclaimAbandonedIntegrationLock(root, lockPath) {
  const pid = readIntegrationLockOwnerPid(lockPath);
  if (pid === null || !integrationLockOwnerIsGone(pid)) return false;
  const grave = path.join(root, `.reclaimed-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    fs.renameSync(lockPath, grave);
  } catch {
    return false;
  }
  fs.rmSync(grave, { recursive: true, force: true });
  return true;
}

function withIntegrationLifecycleLock({ programId, outcomeId, taskId, lockRoot, timeoutMs, pollMs }, callback) {
  const root = path.resolve(lockRoot || path.join(os.tmpdir(), "relay-orca-integration-locks"));
  const lockPath = path.join(root, `${integrationLockName({ programId, outcomeId, taskId })}.lock`);
  const timeout = Number.isInteger(timeoutMs) && timeoutMs >= 0 ? timeoutMs : INTEGRATION_LOCK_TIMEOUT_MS;
  const poll = Number.isInteger(pollMs) && pollMs > 0 ? pollMs : INTEGRATION_LOCK_POLL_MS;
  const started = Date.now();
  let acquired = false;
  let lastOwner = null;
  fs.mkdirSync(root, { recursive: true });
  while (!acquired) {
    try {
      // `mkdirSync` is the atomic publish; the owner stamp follows immediately so an
      // abandoned lock is reclaimable without manual deletion.
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, "owner"), `${process.pid}\n`, "utf8");
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      lastOwner = readIntegrationLockOwnerPid(lockPath);
      // A crash/kill between mkdirSync and the finally rmSync would otherwise strand this
      // directory forever, failing every later run/resume closed with no reset-free recovery.
      // Reclaim it iff its owner is provably gone; a live or ambiguous owner keeps the lock.
      const reclaimed = reclaimAbandonedIntegrationLock(root, lockPath);
      // The timeout bounds EVERY path, reclaim included, so a pathological stream of
      // dead-owner locks can never spin here forever.
      if (Date.now() - started > timeout) break;
      // Retry immediately after a successful reclaim; otherwise back off and let the live (or
      // ambiguous) owner finish, which fails closed at the timeout.
      if (!reclaimed) integrationSleep(poll);
    }
  }
  if (!acquired) {
    const held = lastOwner === null ? "an unidentifiable owner" : `owner pid ${lastOwner}`;
    throw new Error(`integration lifecycle lock timed out for ${programId}/${outcomeId} (held by ${held})`);
  }
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
  integrationLockName,
  withIntegrationLifecycleLock,
  readIntegrationEvidenceFile,
  receiptExists,
  listManifestFiles,
  listFleetManifestFiles,
  makeUrlResolver,
};
