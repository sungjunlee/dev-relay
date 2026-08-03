"use strict";

/** Repository-scoped migration decision, generation admission, and rollback store. */

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCHEMA_VERSION = 1;
const LEGACY_OVERLAY_READER_VERSION = "relay-legacy-overlay-v1";
const GENERATIONS = new Set(["legacy", "vnext"]);
const STRATEGIES = new Set(["drain_and_cutover", "dual_read_vnext_write"]);
const EVENT_TYPES = new Set([
  "migration_decided",
  "legacy_drain_completed",
  "generation_switched",
  "legacy_read_observed",
  "rollback_overlay_written",
]);
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOCK_WAIT_MS = 5;
const LOCK_TIMEOUT_MS = 10_000;
const INCOMPLETE_LOCK_GRACE_MS = 2_000;
const STATE_DIRECTORY_NAME = "relay-runtime-vnext";
const ROLLOUT_TYPES = new Set([
  "legacy_inventory_observed", "legacy_artifact_read", "legacy_surface_invoked",
  "vnext_terminal_observed", "daily_checkpoint",
]);
// The ordered unsigned field list the current runtime signs. `digest` serializes in key
// order, so both membership and order are part of the signature.
const MARKER_UNSIGNED_KEYS = Object.freeze([
  "schema_version", "repository_digest", "epoch", "writer_generation", "legacy_read_allowed",
  "switched_at", "decision_digest", "transition_operation_id", "transition_actor",
  "transition_receipt_digest", "transition_event_digest", "rollback_overlay_digest",
  "quiescence_attestation_digest",
]);
const MARKER_KEYS = Object.freeze([...MARKER_UNSIGNED_KEYS, "marker_digest"]);
// Marker shapes earlier runtimes signed, oldest first. A stored marker in one of these shapes is
// admitted only after its digest verifies over its own ordered field list, then re-signed in the
// current shape. Adding a mandatory marker field without an entry here strands every marker an
// earlier runtime wrote, with no backfill: the digest spans the whole unsigned field set, so a
// default alone cannot repair it. Each `absentFieldValues` entry must be the ONLY value that field
// can legally hold for an untransitioned marker -- never a guess. A field whose value would come
// from a transition receipt has no legal entry here; see upgradeMarkerShape.
const MARKER_SHAPE_HISTORY = Object.freeze([
  Object.freeze({
    unsignedKeys: Object.freeze([
      "schema_version", "repository_digest", "epoch", "writer_generation", "legacy_read_allowed",
      "switched_at", "decision_digest", "transition_operation_id", "transition_actor",
      "transition_receipt_digest", "transition_event_digest", "rollback_overlay_digest",
    ]),
    absentFieldValues: Object.freeze({ quiescence_attestation_digest: null }),
  }),
]);

const issuedAdmissions = new WeakSet();
const admissionStates = new WeakMap();

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label, code = "INVALID_GENERATION_ARTIFACT") {
  if (!plainObject(value)) fail(code, `${label} must be an object`);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(code, `${label}.${key} is not allowed`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(code, `${label}.${key} is required`);
  }
}

function string(value, label, pattern = null) {
  if (typeof value !== "string" || !value.trim() || (pattern && !pattern.test(value))) {
    fail("INVALID_GENERATION_ARTIFACT", `${label} is invalid`);
  }
}

function integer(value, label, { nullable = false, minimum = 0 } = {}) {
  if (nullable && value === null) return;
  if (!Number.isInteger(value) || value < minimum) {
    fail("INVALID_GENERATION_ARTIFACT", `${label} must be an integer >= ${minimum}${nullable ? " or null" : ""}`);
  }
}

function timestamp(value, label) {
  if (typeof value !== "string" || !UTC_ISO_RE.test(value) || new Date(value).toISOString() !== value) {
    fail("INVALID_GENERATION_ARTIFACT", `${label} must be canonical UTC ISO-8601 with milliseconds`);
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function canonicalRepository(repository) {
  exactKeys(repository, ["git_common_dir", "remote"], "repository", "INVALID_REPOSITORY_IDENTITY");
  string(repository.git_common_dir, "repository.git_common_dir");
  string(repository.remote, "repository.remote");
  if (!path.isAbsolute(repository.git_common_dir)) fail("INVALID_REPOSITORY_IDENTITY", "repository.git_common_dir must be absolute");
  const resolved = path.resolve(repository.git_common_dir);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail("INVALID_REPOSITORY_IDENTITY", `repository.git_common_dir does not exist: ${resolved}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_REPOSITORY_IDENTITY", "repository.git_common_dir must be a real directory");
  const gitCommonDir = fs.realpathSync(resolved);
  if (gitCommonDir !== resolved) fail("INVALID_REPOSITORY_IDENTITY", "repository.git_common_dir must be canonical");
  return Object.freeze({ git_common_dir: gitCommonDir, remote: repository.remote });
}

function resolveRepositoryState({ checkoutRoot, remote }) {
  string(checkoutRoot, "checkoutRoot");
  string(remote, "remote");
  if (!path.isAbsolute(checkoutRoot)) fail("INVALID_REPOSITORY_IDENTITY", "checkoutRoot must be absolute");
  const resolvedCheckout = path.resolve(checkoutRoot);
  let checkoutStat;
  try {
    checkoutStat = fs.lstatSync(resolvedCheckout);
  } catch {
    fail("INVALID_REPOSITORY_IDENTITY", `checkoutRoot does not exist: ${resolvedCheckout}`);
  }
  if (!checkoutStat.isDirectory() || checkoutStat.isSymbolicLink() || fs.realpathSync(resolvedCheckout) !== resolvedCheckout) {
    fail("INVALID_REPOSITORY_IDENTITY", "checkoutRoot must be a canonical real directory");
  }
  let rawCommonDir;
  try {
    rawCommonDir = execFileSync("git", ["-C", resolvedCheckout, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail("INVALID_REPOSITORY_IDENTITY", `checkoutRoot is not a Git worktree: ${error.message}`);
  }
  const commonCandidate = path.resolve(resolvedCheckout, rawCommonDir);
  const repository = canonicalRepository({ git_common_dir: fs.realpathSync(commonCandidate), remote });
  return Object.freeze({
    checkoutRoot: resolvedCheckout,
    repository,
    stateDir: path.join(repository.git_common_dir, STATE_DIRECTORY_NAME),
  });
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function secureRead(filePath, label, expectedIdentity = null) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") fail("UNTRUSTED_GENERATION_ARTIFACT", `${label} must not be a symlink`);
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) fail("UNTRUSTED_GENERATION_ARTIFACT", `${label} must be a regular file`);
    if (expectedIdentity && (before.dev !== expectedIdentity.dev || before.ino !== expectedIdentity.ino)) fail("UNTRUSTED_GENERATION_ARTIFACT", `${label} path identity changed before read`);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      fail("UNTRUSTED_GENERATION_ARTIFACT", `${label} changed while being read`);
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function parseJson(bytes, label) {
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("INVALID_GENERATION_ARTIFACT", `${label} is not valid JSON: ${error.message}`);
  }
}

function writeImmutable(filePath, bytes, { conflictCode, fault = null } = {}) {
  const directory = path.dirname(filePath);
  const temporary = path.join(path.dirname(directory), `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fault?.("open", filePath);
    const written = fs.writeSync(fd, bytes, 0, bytes.length);
    if (written !== bytes.length) fail("GENERATION_SHORT_WRITE", `short write to ${path.basename(filePath)}`);
    fault?.("write", filePath);
    fs.fsyncSync(fd);
    fault?.("fsync", filePath);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(temporary, filePath);
      fsyncDirectory(directory);
      fault?.("dir_fsync", filePath);
      return { created: true };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = secureRead(filePath, path.basename(filePath));
      if (!existing || !existing.equals(bytes)) fail(conflictCode, `${path.basename(filePath)} already has conflicting bytes`);
      return { created: false };
    }
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function replaceAtomic(filePath, bytes, { fault = null } = {}) {
  const existing = secureRead(filePath, path.basename(filePath));
  if (existing && existing.equals(bytes)) return { changed: false };
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fault?.("open", filePath);
    const written = fs.writeSync(fd, bytes, 0, bytes.length);
    if (written !== bytes.length) fail("GENERATION_SHORT_WRITE", `short write to ${path.basename(filePath)}`);
    fault?.("write", filePath);
    fs.fsyncSync(fd);
    fault?.("fsync", filePath);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    fault?.("rename", filePath);
    fsyncDirectory(directory);
    fault?.("dir_fsync", filePath);
    return { changed: true };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function pathsFor(stateDir) {
  return Object.freeze({
    repository: path.join(stateDir, "repository.json"),
    decision: path.join(stateDir, "migration-decision.json"),
    drain: path.join(stateDir, "legacy-drain-completed.json"),
    generation: path.join(stateDir, "runtime-generation.json"),
    events: path.join(stateDir, "generation-events"),
    overlays: path.join(stateDir, "legacy-recovery-overlays"),
    transitions: path.join(stateDir, "generation-transitions"),
    transitionAborts: path.join(stateDir, "generation-transition-aborts"),
    quiescence: path.join(stateDir, "legacy-quiescence-attestations"),
    rollout: path.join(stateDir, "rollout-observations"),
    rolloutSeals: path.join(stateDir, "rollout-observation-seals"),
    rolloutHead: path.join(stateDir, "rollout-observation-head.json"),
    terminalReceipts: path.join(stateDir, "vnext-terminal-receipts"),
    lock: path.join(stateDir, "generation-transaction.lock"),
  });
}

function assertStateDirectory(stateDir, repository, { create = false } = {}) {
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) fail("INVALID_GENERATION_PATH", "stateDir must be absolute");
  const resolved = path.resolve(stateDir);
  const expected = path.join(repository.git_common_dir, STATE_DIRECTORY_NAME);
  if (resolved !== expected) fail("INVALID_GENERATION_PATH", "stateDir must be the canonical Git common-dir generation store");
  if (create) fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNTRUSTED_GENERATION_PATH", "stateDir must be a real directory");
  const canonical = fs.realpathSync(resolved);
  if (canonical !== resolved || !isInside(repository.git_common_dir, canonical)) fail("UNTRUSTED_GENERATION_PATH", "stateDir must be canonical and repository-scoped");
  return canonical;
}

function validateRepositoryRecord(record, expected) {
  if (plainObject(record) && record.schema_version !== SCHEMA_VERSION) fail("UNSUPPORTED_GENERATION_SCHEMA", "repository record schema is unsupported");
  exactKeys(record, ["schema_version", "repository", "repository_digest"], "repository record");
  const repository = canonicalRepository(record.repository);
  if (record.repository_digest !== digest(repository)) fail("INVALID_GENERATION_ARTIFACT", "repository digest is invalid");
  if (expected && (repository.git_common_dir !== expected.git_common_dir || repository.remote !== expected.remote)) fail("REPOSITORY_IDENTITY_MISMATCH", "generation store belongs to another repository");
  return { repository, repositoryDigest: record.repository_digest };
}

function initializeResolvedStore({ stateDir, repository, fault = null }) {
  const canonical = canonicalRepository(repository);
  const directory = assertStateDirectory(stateDir, canonical, { create: true });
  const paths = pathsFor(directory);
  for (const [label, directoryPath] of Object.entries({ "generation-events": paths.events, "legacy-recovery-overlays": paths.overlays, "generation-transitions": paths.transitions, "generation-transition-aborts": paths.transitionAborts, "legacy-quiescence-attestations": paths.quiescence, "rollout-observations": paths.rollout, "rollout-observation-seals": paths.rolloutSeals, "vnext-terminal-receipts": paths.terminalReceipts })) {
    if (!fs.existsSync(directoryPath)) {
      try {
        fs.mkdirSync(directoryPath, { mode: 0o700 });
        fsyncDirectory(directory);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    const stat = fs.lstatSync(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directoryPath) !== directoryPath) {
      fail("UNTRUSTED_GENERATION_PATH", `${label} must be a canonical real directory`);
    }
  }
  const record = { schema_version: SCHEMA_VERSION, repository: canonical, repository_digest: digest(canonical) };
  writeImmutable(paths.repository, Buffer.from(canonicalJson(record)), { conflictCode: "REPOSITORY_IDENTITY_CONFLICT", fault });
  const loaded = validateRepositoryRecord(parseJson(secureRead(paths.repository, "repository.json"), "repository.json"), canonical);
  return Object.freeze({ stateDir: directory, repository: loaded.repository, repositoryDigest: loaded.repositoryDigest, paths });
}

function initializeStore({ checkoutRoot, remote, fault = null }) {
  const resolved = resolveRepositoryState({ checkoutRoot, remote });
  return initializeResolvedStore({ stateDir: resolved.stateDir, repository: resolved.repository, fault });
}

/**
 * Read-only admission preflight.  Unlike initializeStore/openStore this never
 * creates the state directory, repository record, or support directories.
 * A missing store is a normal inactive result; a partially installed or
 * untrusted store is an error so callers cannot silently repair it on entry.
 */
function peekStore({ checkoutRoot, remote }) {
  const resolved = resolveRepositoryState({ checkoutRoot, remote });
  let stateStat;
  try {
    stateStat = fs.lstatSync(resolved.stateDir);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    fail("UNTRUSTED_GENERATION_PATH", "stateDir must be a real directory");
  }
  const canonicalStateDir = fs.realpathSync(resolved.stateDir);
  if (canonicalStateDir !== resolved.stateDir || !isInside(resolved.repository.git_common_dir, canonicalStateDir)) {
    fail("UNTRUSTED_GENERATION_PATH", "stateDir must be canonical and repository-scoped");
  }
  const storePaths = pathsFor(canonicalStateDir);
  const repositoryBytes = secureRead(storePaths.repository, "repository.json");
  if (!repositoryBytes) fail("INVALID_GENERATION_STORE", "existing generation store is missing repository.json");
  const loaded = validateRepositoryRecord(parseJson(repositoryBytes, "repository.json"), resolved.repository);
  // Directories a store has always had. Their absence means the store is genuinely partial.
  const requiredDirectories = {
    "generation-events": storePaths.events,
    "legacy-recovery-overlays": storePaths.overlays,
    "generation-transitions": storePaths.transitions,
  };
  // Support directories introduced after stores were already in use. A store written by an earlier
  // runtime simply does not have them, which is an upgrade state rather than corruption. Every write
  // path opens the store through initializeResolvedStore, which creates them idempotently, so this
  // read-only preflight must not reject them -- and still creates nothing itself.
  const upgradeCreatedDirectories = {
    "generation-transition-aborts": storePaths.transitionAborts,
    "legacy-quiescence-attestations": storePaths.quiescence,
    "rollout-observations": storePaths.rollout,
    "rollout-observation-seals": storePaths.rolloutSeals,
    "vnext-terminal-receipts": storePaths.terminalReceipts,
  };
  for (const [label, directoryPath] of Object.entries({ ...requiredDirectories, ...upgradeCreatedDirectories })) {
    let stat;
    try { stat = fs.lstatSync(directoryPath); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (Object.hasOwn(requiredDirectories, label)) fail("INVALID_GENERATION_STORE", `existing generation store is missing ${label}`);
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directoryPath) !== directoryPath) {
      fail("UNTRUSTED_GENERATION_PATH", `${label} must be a canonical real directory`);
    }
  }
  return Object.freeze({
    stateDir: canonicalStateDir,
    repository: loaded.repository,
    repositoryDigest: loaded.repositoryDigest,
    paths: storePaths,
  });
}

function openStore(store) {
  if (!store || typeof store !== "object") fail("INVALID_GENERATION_STORE", "store is required");
  return initializeResolvedStore({ stateDir: store.stateDir, repository: store.repository });
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function lockSnapshot(lockPath) {
  let stat;
  try {
    stat = fs.lstatSync(lockPath, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNTRUSTED_GENERATION_LOCK", "generation lock must be a real directory");
  const ownerBytes = secureRead(path.join(lockPath, "owner.json"), "generation lock owner");
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    owner_digest: ownerBytes ? crypto.createHash("sha256").update(ownerBytes).digest("hex") : null,
  });
}

function sameLockSnapshot(left, right) {
  return Boolean(left && right && left.device === right.device && left.inode === right.inode && left.owner_digest === right.owner_digest);
}

function readLockOwner(lockPath) {
  const owner = parseJson(secureRead(path.join(lockPath, "owner.json"), "generation lock owner"), "generation lock owner");
  if (!owner) return null;
  if (!plainObject(owner) || Object.keys(owner).length !== 3 || owner.schema_version !== 1
    || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string" || !/^[a-f0-9]{48}$/.test(owner.token)) {
    fail("UNTRUSTED_GENERATION_LOCK", "generation lock owner is malformed");
  }
  return owner;
}

function removeStaleLock(lockPath, observed) {
  // A path can be replaced between observing a dead owner and renaming its lock.
  // Re-read the directory identity immediately before quarantine, and restore the
  // replacement if the filesystem still races after that read.
  if (!sameLockSnapshot(observed, lockSnapshot(lockPath))) return false;
  const quarantine = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.renameSync(lockPath, quarantine);
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY"].includes(error.code)) return false;
    throw error;
  }
  const quarantined = lockSnapshot(quarantine);
  if (!sameLockSnapshot(observed, quarantined)) {
    try {
      if (!fs.existsSync(lockPath)) fs.renameSync(quarantine, lockPath);
    } catch (error) {
      fail("GENERATION_LOCK_REPLACED", `generation lock changed during stale-lock quarantine and could not be restored: ${error.message}`);
    }
    fail("GENERATION_LOCK_REPLACED", "generation lock changed during stale-lock quarantine");
  }
  try { fs.unlinkSync(path.join(quarantine, "owner.json")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.rmdirSync(quarantine);
  fsyncDirectory(path.dirname(lockPath));
  return true;
}

function acquireRepositoryLock(store, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const started = Date.now();
  while (true) {
    const token = crypto.randomBytes(24).toString("hex");
    try {
      fs.mkdirSync(store.paths.lock, { mode: 0o700 });
      const owner = Buffer.from(canonicalJson({ schema_version: 1, pid: process.pid, token }));
      writeImmutable(path.join(store.paths.lock, "owner.json"), owner, { conflictCode: "GENERATION_LOCK_OWNER_CONFLICT" });
      fsyncDirectory(store.stateDir);
      return { token };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const lockSnapshotBeforeOwner = lockSnapshot(store.paths.lock);
    if (!lockSnapshotBeforeOwner) continue;
    let owner;
    let lockStat;
    try {
      owner = readLockOwner(store.paths.lock);
      lockStat = fs.lstatSync(store.paths.lock);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const incomplete = !owner;
    if ((!incomplete && !processLive(owner.pid)) || (incomplete && Date.now() - lockStat.mtimeMs >= INCOMPLETE_LOCK_GRACE_MS)) {
      removeStaleLock(store.paths.lock, lockSnapshotBeforeOwner);
      continue;
    }
    if (Date.now() - started >= timeoutMs) fail("GENERATION_ADMISSION_TIMEOUT", "timed out waiting for repository generation transaction");
    sleep(LOCK_WAIT_MS);
  }
}

function releaseRepositoryLock(store, lease) {
  const owner = readLockOwner(store.paths.lock);
  if (!owner || owner.token !== lease.token || owner.pid !== process.pid) fail("GENERATION_LOCK_LOST", "generation transaction ownership changed");
  fs.unlinkSync(path.join(store.paths.lock, "owner.json"));
  fs.rmdirSync(store.paths.lock);
  fsyncDirectory(store.stateDir);
}

function withRepositoryLockSync(store, callback) {
  const lease = acquireRepositoryLock(store);
  try {
    return callback();
  } finally {
    releaseRepositoryLock(store, lease);
  }
}

function assertDecision(value, store) {
  if (plainObject(value) && value.schema_version !== SCHEMA_VERSION) fail("UNSUPPORTED_GENERATION_SCHEMA", "migration decision schema is unsupported");
  exactKeys(value, ["schema_version", "repository_digest", "observed_at", "active_legacy_run_count", "oldest_active_legacy_age_hours", "strategy", "decision_digest"], "migration decision");
  if (value.repository_digest !== store.repositoryDigest) fail("REPOSITORY_IDENTITY_MISMATCH", "migration decision belongs to another repository");
  timestamp(value.observed_at, "migration decision.observed_at");
  integer(value.active_legacy_run_count, "migration decision.active_legacy_run_count");
  integer(value.oldest_active_legacy_age_hours, "migration decision.oldest_active_legacy_age_hours", { nullable: true });
  if ((value.active_legacy_run_count === 0) !== (value.oldest_active_legacy_age_hours === null)) fail("INVALID_GENERATION_ARTIFACT", "zero active legacy runs requires a null oldest age and vice versa");
  const expected = value.active_legacy_run_count <= 5 && (value.oldest_active_legacy_age_hours === null || value.oldest_active_legacy_age_hours < 72)
    ? "drain_and_cutover" : "dual_read_vnext_write";
  if (!STRATEGIES.has(value.strategy) || value.strategy !== expected) fail("INVALID_GENERATION_ARTIFACT", "migration strategy does not match observations");
  const { decision_digest: decisionDigest, ...unsigned } = value;
  if (!SHA256_RE.test(decisionDigest || "") || decisionDigest !== digest(unsigned)) fail("INVALID_GENERATION_ARTIFACT", "migration decision digest is invalid");
  return value;
}

function inventoryDigest(observation) {
  return digest({
    observed_at: observation.observed_at,
    active_legacy_run_count: observation.active_legacy_run_count,
    oldest_active_legacy_age_hours: observation.oldest_active_legacy_age_hours,
  });
}

function assertDrainInventory(value, store, decision) {
  if (plainObject(value) && value.schema_version !== SCHEMA_VERSION) fail("UNSUPPORTED_GENERATION_SCHEMA", "drain inventory schema is unsupported");
  exactKeys(value, ["schema_version", "repository_digest", "decision_digest", "observed_at", "active_legacy_run_count", "oldest_active_legacy_age_hours", "inventory_digest", "actor", "operation_id"], "legacy drain inventory");
  if (value.repository_digest !== store.repositoryDigest) fail("REPOSITORY_IDENTITY_MISMATCH", "drain inventory belongs to another repository");
  if (!decision || value.decision_digest !== decision.decision_digest) fail("GENERATION_DECISION_MISSING", "drain inventory has no matching decision");
  timestamp(value.observed_at, "legacy drain inventory.observed_at");
  integer(value.active_legacy_run_count, "legacy drain inventory.active_legacy_run_count");
  integer(value.oldest_active_legacy_age_hours, "legacy drain inventory.oldest_active_legacy_age_hours", { nullable: true });
  if (value.active_legacy_run_count !== 0 || value.oldest_active_legacy_age_hours !== null) fail("LEGACY_DRAIN_INCOMPLETE", "drain inventory must prove zero active legacy runs");
  if (value.observed_at <= decision.observed_at) fail("LEGACY_DRAIN_STALE", "drain inventory must be observed after the initial decision");
  const observation = { observed_at: value.observed_at, active_legacy_run_count: value.active_legacy_run_count, oldest_active_legacy_age_hours: value.oldest_active_legacy_age_hours };
  if (value.inventory_digest !== inventoryDigest(observation)) fail("INVALID_GENERATION_ARTIFACT", "drain inventory digest is invalid");
  string(value.actor, "legacy drain inventory.actor", TOKEN_RE);
  string(value.operation_id, "legacy drain inventory.operation_id", TOKEN_RE);
  return value;
}

function readDrainCompleted(store) {
  const opened = openStore(store);
  const decision = readDecision(opened);
  const value = parseJson(secureRead(opened.paths.drain, "legacy-drain-completed.json"), "legacy-drain-completed.json");
  return value ? assertDrainInventory(value, opened, decision) : null;
}

function readDecision(store) {
  const opened = openStore(store);
  const value = parseJson(secureRead(opened.paths.decision, "migration-decision.json"), "migration-decision.json");
  return value ? assertDecision(value, opened) : null;
}

function orderedKeysMatch(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

/**
 * Admit a marker an earlier runtime signed in a narrower field shape and re-sign it in the
 * current one.  The historical digest is verified over the historical field order first, so
 * the upgrade can never launder a forged, truncated, or reordered marker into admission.
 *
 * Only the genesis marker is upgradable -- the exact untransitioned marker
 * ensureDecisionArtifactsLocked writes.  Its absent fields are null in every shape, so the
 * projection below is forced rather than guessed, and no terminal receipt, checkpoint, or rollout
 * anchor can bind it yet because all three require a vNext-only marker.  Every other marker is
 * reached through a transition and carries values that live in its durable transition receipt and
 * switch event -- above all `quiescence_attestation_digest`, which an earlier runtime also wrote
 * into those two artifacts in their own narrower shapes.  Re-signing such a marker alone would
 * publish one that contradicts `buildMarker`'s reconstruction of its own receipt, so it fails
 * closed: the whole artifact set has to migrate together.  An unrecognized shape is returned
 * untouched for exactKeys to reject.
 */
function upgradeMarkerShape(value) {
  if (!plainObject(value) || orderedKeysMatch(value, MARKER_KEYS)) return value;
  const shape = MARKER_SHAPE_HISTORY.find((candidate) => orderedKeysMatch(value, [...candidate.unsignedKeys, "marker_digest"]));
  if (!shape) return value;
  const { marker_digest: signed, ...unsigned } = value;
  if (!SHA256_RE.test(signed || "") || signed !== digest(unsigned)) fail("INVALID_GENERATION_ARTIFACT", "runtime generation marker digest is invalid");
  const genesis = unsigned.transition_operation_id === null && unsigned.epoch === 1
    && unsigned.writer_generation === "legacy" && unsigned.legacy_read_allowed === true
    && unsigned.rollback_overlay_digest === null;
  if (!genesis) fail("UNSUPPORTED_GENERATION_SCHEMA", "only a genesis generation marker upgrades by field shape; any other marker must migrate with its transition receipt and switch event");
  const upgraded = {};
  for (const key of MARKER_UNSIGNED_KEYS) {
    if (!Object.hasOwn(unsigned, key) && !Object.hasOwn(shape.absentFieldValues, key)) fail("INVALID_GENERATION_ARTIFACT", `runtime generation marker upgrade has no forced value for ${key}`);
    upgraded[key] = Object.hasOwn(unsigned, key) ? unsigned[key] : shape.absentFieldValues[key];
  }
  return { ...upgraded, marker_digest: digest(upgraded) };
}

/** Rewrite a marker admitted through a shape upgrade so the stored bytes carry the signature
 *  every artifact bound to it now uses.  Callers must already hold the repository lock, and pass
 *  `fault` so this durable write sits on the same crash boundary as every other marker write. */
function persistMarkerUpgradeLocked(store, marker, fault = null) {
  const bytes = Buffer.from(canonicalJson(marker));
  if (secureRead(store.paths.generation, "runtime-generation.json")?.equals(bytes)) return false;
  replaceAtomic(store.paths.generation, bytes, { fault });
  return true;
}

function validateMarker(input, store) {
  if (plainObject(input) && input.schema_version !== SCHEMA_VERSION) fail("UNSUPPORTED_GENERATION_SCHEMA", "generation marker schema is unsupported");
  const value = upgradeMarkerShape(input);
  exactKeys(value, MARKER_KEYS, "runtime generation marker");
  if (value.repository_digest !== store.repositoryDigest) fail("REPOSITORY_IDENTITY_MISMATCH", "generation marker belongs to another repository");
  integer(value.epoch, "runtime generation marker.epoch", { minimum: 1 });
  if (!GENERATIONS.has(value.writer_generation) || typeof value.legacy_read_allowed !== "boolean") fail("INVALID_GENERATION_ARTIFACT", "generation marker admission fields are invalid");
  if (value.writer_generation === "legacy" && !value.legacy_read_allowed) fail("INVALID_GENERATION_ARTIFACT", "legacy writer requires legacy reads");
  timestamp(value.switched_at, "runtime generation marker.switched_at");
  string(value.decision_digest, "runtime generation marker.decision_digest", SHA256_RE);
  for (const key of ["transition_operation_id", "transition_actor", "transition_receipt_digest", "transition_event_digest", "rollback_overlay_digest", "quiescence_attestation_digest"]) {
    if (value[key] !== null && typeof value[key] !== "string") fail("INVALID_GENERATION_ARTIFACT", `runtime generation marker.${key} is invalid`);
  }
  if ((value.transition_operation_id === null) !== (value.transition_actor === null)
    || (value.transition_operation_id === null) !== (value.transition_receipt_digest === null)
    || (value.transition_operation_id === null) !== (value.transition_event_digest === null)) {
    fail("INVALID_GENERATION_ARTIFACT", "runtime generation marker transition fields must be present together");
  }
  if (value.transition_operation_id !== null) {
    string(value.transition_operation_id, "runtime generation marker.transition_operation_id", TOKEN_RE);
    string(value.transition_actor, "runtime generation marker.transition_actor", TOKEN_RE);
    string(value.transition_receipt_digest, "runtime generation marker.transition_receipt_digest", SHA256_RE);
    string(value.transition_event_digest, "runtime generation marker.transition_event_digest", SHA256_RE);
  }
  if (value.rollback_overlay_digest !== null) string(value.rollback_overlay_digest, "runtime generation marker.rollback_overlay_digest", SHA256_RE);
  if (value.quiescence_attestation_digest !== null) string(value.quiescence_attestation_digest, "runtime generation marker.quiescence_attestation_digest", SHA256_RE);
  const { marker_digest: markerDigest, ...unsigned } = value;
  if (!SHA256_RE.test(markerDigest || "") || markerDigest !== digest(unsigned)) fail("INVALID_GENERATION_ARTIFACT", "runtime generation marker digest is invalid");
  return value;
}

function readGeneration(store) {
  const opened = openStore(store);
  const stored = parseJson(secureRead(opened.paths.generation, "runtime-generation.json"), "runtime-generation.json");
  if (!stored) return null;
  const marker = validateMarker(stored, opened);
  const decision = readDecision(opened);
  if (!decision || decision.decision_digest !== marker.decision_digest) fail("GENERATION_DECISION_MISSING", "generation marker has no matching decision");
  return marker;
}

function peekGeneration(store) {
  if (!store || typeof store !== "object") fail("INVALID_GENERATION_STORE", "store is required");
  const stored = parseJson(secureRead(store.paths.generation, "runtime-generation.json"), "runtime-generation.json");
  if (!stored) return null;
  const marker = validateMarker(stored, store);
  const decision = parseJson(secureRead(store.paths.decision, "migration-decision.json"), "migration-decision.json");
  if (!decision) fail("GENERATION_DECISION_MISSING", "generation marker has no matching decision");
  assertDecision(decision, store);
  if (decision.decision_digest !== marker.decision_digest) {
    fail("GENERATION_DECISION_MISSING", "generation marker has no matching decision");
  }
  return marker;
}

function eventId(type, repositoryDigest, payload) {
  return digest({ type, repository_digest: repositoryDigest, payload });
}

function validateEvent(event, store) {
  if (plainObject(event) && event.schema_version !== SCHEMA_VERSION) fail("UNSUPPORTED_GENERATION_SCHEMA", "generation event schema is unsupported");
  exactKeys(event, ["schema_version", "event_id", "type", "repository_digest", "occurred_at", "payload"], "generation event");
  string(event.event_id, "generation event.event_id", SHA256_RE);
  if (!EVENT_TYPES.has(event.type)) fail("INVALID_GENERATION_ARTIFACT", "generation event type is invalid");
  if (event.repository_digest !== store.repositoryDigest) fail("REPOSITORY_IDENTITY_MISMATCH", "generation event belongs to another repository");
  timestamp(event.occurred_at, "generation event.occurred_at");
  if (!plainObject(event.payload)) fail("INVALID_GENERATION_ARTIFACT", "generation event.payload must be an object");
  if (event.event_id !== eventId(event.type, event.repository_digest, event.payload)) fail("INVALID_GENERATION_ARTIFACT", "generation event id is invalid");
  if (event.type === "migration_decided") {
    exactKeys(event.payload, ["decision_digest"], "migration_decided payload");
    string(event.payload.decision_digest, "migration_decided.decision_digest", SHA256_RE);
  } else if (event.type === "legacy_drain_completed") {
    exactKeys(event.payload, ["inventory_digest", "actor", "operation_id", "decision_digest"], "legacy_drain_completed payload");
    string(event.payload.inventory_digest, "legacy_drain_completed.inventory_digest", SHA256_RE);
    string(event.payload.actor, "legacy_drain_completed.actor", TOKEN_RE);
    string(event.payload.operation_id, "legacy_drain_completed.operation_id", TOKEN_RE);
    string(event.payload.decision_digest, "legacy_drain_completed.decision_digest", SHA256_RE);
  } else if (event.type === "generation_switched") {
    exactKeys(event.payload, ["from_generation", "to_generation", "epoch", "actor", "operation_id", "decision_digest", "legacy_read_allowed", "transition_receipt_digest", "rollback_overlay_digest", "quiescence_attestation_digest"], "generation_switched payload");
    if (!GENERATIONS.has(event.payload.from_generation) || !GENERATIONS.has(event.payload.to_generation)
      || (event.payload.from_generation === event.payload.to_generation
        && !(event.payload.to_generation === "vnext" && event.payload.legacy_read_allowed === false))) fail("INVALID_GENERATION_ARTIFACT", "generation switch is invalid");
    integer(event.payload.epoch, "generation_switched.epoch", { minimum: 2 });
    string(event.payload.actor, "generation_switched.actor", TOKEN_RE);
    string(event.payload.operation_id, "generation_switched.operation_id", TOKEN_RE);
    string(event.payload.decision_digest, "generation_switched.decision_digest", SHA256_RE);
    if (typeof event.payload.legacy_read_allowed !== "boolean") fail("INVALID_GENERATION_ARTIFACT", "generation_switched.legacy_read_allowed must be boolean");
    string(event.payload.transition_receipt_digest, "generation_switched.transition_receipt_digest", SHA256_RE);
    if (event.payload.rollback_overlay_digest !== null) string(event.payload.rollback_overlay_digest, "generation_switched.rollback_overlay_digest", SHA256_RE);
    if (event.payload.quiescence_attestation_digest !== null) string(event.payload.quiescence_attestation_digest, "generation_switched.quiescence_attestation_digest", SHA256_RE);
  } else if (event.type === "legacy_read_observed") {
    exactKeys(event.payload, ["observation_id", "reader_version", "surface", "epoch"], "legacy_read_observed payload");
    string(event.payload.observation_id, "legacy_read_observed.observation_id", TOKEN_RE);
    string(event.payload.reader_version, "legacy_read_observed.reader_version", TOKEN_RE);
    string(event.payload.surface, "legacy_read_observed.surface", TOKEN_RE);
    integer(event.payload.epoch, "legacy_read_observed.epoch", { minimum: 1 });
  } else {
    exactKeys(event.payload, ["overlay_digest", "legacy_reader_version", "vnext_runs_digest", "epoch", "actor", "operation_id"], "rollback_overlay_written payload");
    string(event.payload.overlay_digest, "rollback_overlay_written.overlay_digest", SHA256_RE);
    string(event.payload.legacy_reader_version, "rollback_overlay_written.legacy_reader_version", TOKEN_RE);
    string(event.payload.vnext_runs_digest, "rollback_overlay_written.vnext_runs_digest", SHA256_RE);
    integer(event.payload.epoch, "rollback_overlay_written.epoch", { minimum: 1 });
    string(event.payload.actor, "rollback_overlay_written.actor", TOKEN_RE);
    string(event.payload.operation_id, "rollback_overlay_written.operation_id", TOKEN_RE);
  }
  return event;
}

function appendEvent(store, { type, payload, occurredAt, fault = null }) {
  const opened = openStore(store);
  const event = { schema_version: SCHEMA_VERSION, event_id: eventId(type, opened.repositoryDigest, payload), type, repository_digest: opened.repositoryDigest, occurred_at: occurredAt, payload };
  validateEvent(event, opened);
  const filePath = path.join(opened.paths.events, `${event.event_id}.json`);
  writeImmutable(filePath, Buffer.from(canonicalJson(event)), { conflictCode: "GENERATION_EVENT_CONFLICT", fault });
  return event;
}

function readEvents(store) {
  const opened = openStore(store);
  return fs.readdirSync(opened.paths.events).map((name) => {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) fail("UNTRUSTED_GENERATION_ARTIFACT", `unexpected generation event file ${name}`);
    const event = validateEvent(parseJson(secureRead(path.join(opened.paths.events, name), name), name), opened);
    if (`${event.event_id}.json` !== name) fail("INVALID_GENERATION_ARTIFACT", `generation event filename does not match ${event.event_id}`);
    return event;
  }).sort((left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.event_id.localeCompare(right.event_id));
}

function decideMigrationLocked(opened, observation, fault = null) {
  exactKeys(observation, ["observed_at", "active_legacy_run_count", "oldest_active_legacy_age_hours"], "migration observation");
  const unsigned = {
    schema_version: SCHEMA_VERSION,
    repository_digest: opened.repositoryDigest,
    observed_at: observation.observed_at,
    active_legacy_run_count: observation.active_legacy_run_count,
    oldest_active_legacy_age_hours: observation.oldest_active_legacy_age_hours,
    strategy: observation.active_legacy_run_count <= 5 && (observation.oldest_active_legacy_age_hours === null || observation.oldest_active_legacy_age_hours < 72) ? "drain_and_cutover" : "dual_read_vnext_write",
  };
  const decision = assertDecision({ ...unsigned, decision_digest: digest(unsigned) }, opened);
  const written = writeImmutable(opened.paths.decision, Buffer.from(canonicalJson(decision)), { conflictCode: "MIGRATION_DECISION_CONFLICT", fault });
  const persisted = readDecision(opened);
  const repaired = ensureDecisionArtifactsLocked(opened, persisted, fault);
  return { decision: persisted, event: repaired.event, created: written.created };
}

function ensureDecisionArtifactsLocked(opened, decision, fault = null) {
  const existing = readGeneration(opened);
  if (existing) persistMarkerUpgradeLocked(opened, existing, fault);
  if (!existing) {
    const initial = { schema_version: 1, repository_digest: opened.repositoryDigest, epoch: 1, writer_generation: "legacy", legacy_read_allowed: true, switched_at: decision.observed_at, decision_digest: decision.decision_digest, transition_operation_id: null, transition_actor: null, transition_receipt_digest: null, transition_event_digest: null, rollback_overlay_digest: null, quiescence_attestation_digest: null };
    const marker = validateMarker({ ...initial, marker_digest: digest(initial) }, opened);
    replaceAtomic(opened.paths.generation, Buffer.from(canonicalJson(marker)), { fault });
  }
  const event = appendEvent(opened, { type: "migration_decided", payload: { decision_digest: decision.decision_digest }, occurredAt: decision.observed_at, fault });
  return { marker: readGeneration(opened), event };
}

function decideMigration({ store, observation, fault = null }) {
  const opened = openStore(store);
  return withRepositoryLockSync(opened, () => decideMigrationLocked(opened, observation, fault));
}

function recordDrainCompletedLocked(opened, inventory, actor, operationId, fault = null) {
  string(actor, "drain completion actor", TOKEN_RE);
  string(operationId, "drain completion operation id", TOKEN_RE);
  exactKeys(inventory, ["observed_at", "active_legacy_run_count", "oldest_active_legacy_age_hours"], "drain completion inventory");
  const decision = readDecision(opened);
  if (!decision || decision.strategy !== "drain_and_cutover") fail("LEGACY_DRAIN_NOT_REQUIRED", "the migration decision does not require a drain completion fact");
  const unsigned = { schema_version: 1, repository_digest: opened.repositoryDigest, decision_digest: decision.decision_digest, ...inventory, inventory_digest: inventoryDigest(inventory), actor, operation_id: operationId };
  const completed = assertDrainInventory(unsigned, opened, decision);
  const written = writeImmutable(opened.paths.drain, Buffer.from(canonicalJson(completed)), { conflictCode: "LEGACY_DRAIN_COMPLETION_CONFLICT", fault });
  const event = ensureDrainEventLocked(opened, completed, fault);
  return { inventory: readDrainCompleted(opened), event, created: written.created };
}

function ensureDrainEventLocked(opened, completed, fault = null) {
  return appendEvent(opened, { type: "legacy_drain_completed", payload: { inventory_digest: completed.inventory_digest, actor: completed.actor, operation_id: completed.operation_id, decision_digest: completed.decision_digest }, occurredAt: completed.observed_at, fault });
}

function recordDrainCompleted({ store, inventory, actor, operationId, fault = null }) {
  const opened = openStore(store);
  return withRepositoryLockSync(opened, () => recordDrainCompletedLocked(opened, inventory, actor, operationId, fault));
}

function assertAdmission(capability, store, allowedModes) {
  if (!issuedAdmissions.has(capability)) fail("INVALID_GENERATION_ADMISSION", "generation admission capability is not authentic");
  const state = admissionStates.get(capability);
  if (!state?.active || state.repositoryDigest !== store.repositoryDigest || !allowedModes.includes(state.mode)) fail("GENERATION_ADMISSION_EXPIRED", "generation admission is inactive or incompatible");
  return state;
}

/**
 * Entry points call this immediately before a state-changing write.  The
 * capability cannot be serialized or recreated outside withGenerationAdmission.
 */
function assertGenerationWrite({ store, admission, generation }) {
  const opened = openStore(store);
  if (!GENERATIONS.has(generation)) fail("INVALID_GENERATION_ADMISSION", "writer generation is invalid");
  const state = assertAdmission(admission, opened, ["write"]);
  if (state.generation !== generation) fail("GENERATION_NOT_ACTIVE", "admission is for another writer generation");
  const marker = readGeneration(opened);
  if (!marker || marker.epoch !== state.epoch || marker.writer_generation !== generation) fail("GENERATION_ADMISSION_EXPIRED", "writer generation changed during admission");
  return Object.freeze({ epoch: state.epoch, generation });
}

async function withGenerationAdmission({ store, generation, mode = "write", timeoutMs = LOCK_TIMEOUT_MS }, callback) {
  const opened = openStore(store);
  if (!GENERATIONS.has(generation) || !new Set(["write", "legacy_read"]).has(mode)) fail("INVALID_GENERATION_ADMISSION", "generation admission request is invalid");
  if (typeof callback !== "function") fail("INVALID_GENERATION_ADMISSION", "generation admission callback is required");
  const lease = acquireRepositoryLock(opened, { timeoutMs });
  try {
    const marker = readGeneration(opened);
    const allowed = mode === "write" ? marker?.writer_generation === generation : generation === "legacy" && marker?.legacy_read_allowed;
    if (!allowed) fail("GENERATION_NOT_ACTIVE", `${mode} admission for ${generation} is not active`);
    const capability = Object.freeze({ epoch: marker.epoch, generation, mode });
    issuedAdmissions.add(capability);
    admissionStates.set(capability, { active: true, repositoryDigest: opened.repositoryDigest, epoch: marker.epoch, generation, mode });
    try {
      return await callback(capability);
    } finally {
      admissionStates.get(capability).active = false;
    }
  } finally {
    releaseRepositoryLock(opened, lease);
  }
}

function recordLegacyRead({ store, admission, observationId, readerVersion, surface, observedAt, fault = null }) {
  const opened = openStore(store);
  const state = assertAdmission(admission, opened, ["write", "legacy_read"]);
  if (state.generation !== "legacy") fail("GENERATION_NOT_ACTIVE", "legacy read requires a legacy admission");
  const event = appendEvent(opened, { type: "legacy_read_observed", payload: { observation_id: observationId, reader_version: readerVersion, surface, epoch: state.epoch }, occurredAt: observedAt, fault });
  const existing = readRolloutObservations(opened, { now: observedAt }).observations.some((item) => item.type === "legacy_artifact_read" && item.payload.artifact_sha256 === event.event_id);
  if (!existing) appendRolloutLocked(opened, { type: "legacy_artifact_read", occurredAt: observedAt, payload: { surface, artifact_name: `generation-event:${event.event_id}`, artifact_sha256: event.event_id, marker_digest: readGeneration(opened).marker_digest } });
  return event;
}

function observeLegacyRead({ store, observationId, readerVersion, surface, observedAt, fault = null }) {
  const opened = openStore(store);
  return withRepositoryLockSync(opened, () => {
    const marker = readGeneration(opened);
    if (!marker?.legacy_read_allowed) fail("GENERATION_NOT_ACTIVE", "legacy reads are not active");
    const capability = Object.freeze({ epoch: marker.epoch, generation: "legacy", mode: "legacy_read" });
    issuedAdmissions.add(capability);
    admissionStates.set(capability, { active: true, repositoryDigest: opened.repositoryDigest, epoch: marker.epoch, generation: "legacy", mode: "legacy_read" });
    try {
      return recordLegacyRead({ store: opened, admission: capability, observationId, readerVersion, surface, observedAt, fault });
    } finally {
      admissionStates.get(capability).active = false;
    }
  });
}

function transitionReceiptPath(store, operationId) {
  return path.join(store.paths.transitions, `${operationId}.json`);
}

function validateTransitionReceipt(value, store) {
  exactKeys(value, ["schema_version", "repository_digest", "operation_id", "actor", "from_generation", "to_generation", "epoch", "switched_at", "decision_digest", "legacy_read_allowed", "rollback_overlay_digest", "quiescence_attestation_digest", "receipt_digest"], "generation transition receipt");
  if (value.schema_version !== SCHEMA_VERSION || value.repository_digest !== store.repositoryDigest) fail("REPOSITORY_IDENTITY_MISMATCH", "transition receipt belongs to another repository");
  for (const key of ["operation_id", "actor"]) string(value[key], `transition receipt.${key}`, TOKEN_RE);
  if (!GENERATIONS.has(value.from_generation) || !GENERATIONS.has(value.to_generation)
    || (value.from_generation === value.to_generation
      && !(value.to_generation === "vnext" && value.legacy_read_allowed === false))) fail("INVALID_GENERATION_ARTIFACT", "transition receipt generation is invalid");
  integer(value.epoch, "transition receipt.epoch", { minimum: 2 });
  timestamp(value.switched_at, "transition receipt.switched_at");
  string(value.decision_digest, "transition receipt.decision_digest", SHA256_RE);
  if (typeof value.legacy_read_allowed !== "boolean") fail("INVALID_GENERATION_ARTIFACT", "transition receipt legacy_read_allowed is invalid");
  if (value.rollback_overlay_digest !== null) string(value.rollback_overlay_digest, "transition receipt.rollback_overlay_digest", SHA256_RE);
  if (value.quiescence_attestation_digest !== null) string(value.quiescence_attestation_digest, "transition receipt.quiescence_attestation_digest", SHA256_RE);
  const { receipt_digest: receiptDigest, ...unsigned } = value;
  if (!SHA256_RE.test(receiptDigest || "") || receiptDigest !== digest(unsigned)) fail("INVALID_GENERATION_ARTIFACT", "transition receipt digest is invalid");
  return value;
}

function readTransitionReceipts(store) {
  return fs.readdirSync(store.paths.transitions).map((name) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.json$/.test(name)) fail("UNTRUSTED_GENERATION_ARTIFACT", `unexpected transition receipt ${name}`);
    const receipt = validateTransitionReceipt(parseJson(secureRead(path.join(store.paths.transitions, name), name), name), store);
    if (`${receipt.operation_id}.json` !== name) fail("INVALID_GENERATION_ARTIFACT", "transition receipt filename does not match operation id");
    return receipt;
  });
}

function transitionAbortPath(store, operationId) {
  return path.join(store.paths.transitionAborts, `${operationId}.json`);
}

function validateTransitionAbort(value, store) {
  exactKeys(value, ["schema_version", "repository_digest", "operation_id", "receipt_digest", "aborted_at", "reason", "superseded_by_operation_id", "superseding_quiescence_attestation_digest", "abort_digest"], "generation transition abort");
  const { abort_digest: abortDigest, ...unsigned } = value;
  if (value.schema_version !== SCHEMA_VERSION || value.repository_digest !== store.repositoryDigest) fail("REPOSITORY_IDENTITY_MISMATCH", "transition abort belongs to another repository");
  string(value.operation_id, "transition abort.operation_id", TOKEN_RE);
  string(value.receipt_digest, "transition abort.receipt_digest", SHA256_RE);
  timestamp(value.aborted_at, "transition abort.aborted_at");
  if (!new Set(["post_marker_validation_failed", "superseded_by_fresh_attestation"]).has(value.reason)) fail("INVALID_GENERATION_ARTIFACT", "transition abort reason is invalid");
  if (value.superseded_by_operation_id !== null) string(value.superseded_by_operation_id, "transition abort.superseded_by_operation_id", TOKEN_RE);
  if (value.superseding_quiescence_attestation_digest !== null) string(value.superseding_quiescence_attestation_digest, "transition abort.superseding_quiescence_attestation_digest", SHA256_RE);
  if (abortDigest !== digest(unsigned)) fail("INVALID_GENERATION_ARTIFACT", "transition abort digest is invalid");
  return value;
}

function readTransitionAbort(store, receipt) {
  const bytes = secureRead(transitionAbortPath(store, receipt.operation_id), `transition abort ${receipt.operation_id}`);
  if (!bytes) return null;
  const abort = validateTransitionAbort(parseJson(bytes, `transition abort ${receipt.operation_id}`), store);
  if (abort.operation_id !== receipt.operation_id || abort.receipt_digest !== receipt.receipt_digest) fail("GENERATION_TRANSITION_CONFLICT", "transition abort does not bind its immutable receipt");
  return abort;
}

function abortTransition(store, receipt, { abortedAt, reason, supersededByOperationId = null, supersedingQuiescenceAttestationDigest = null }) {
  const base = { schema_version: SCHEMA_VERSION, repository_digest: store.repositoryDigest, operation_id: receipt.operation_id, receipt_digest: receipt.receipt_digest, aborted_at: abortedAt, reason, superseded_by_operation_id: supersededByOperationId, superseding_quiescence_attestation_digest: supersedingQuiescenceAttestationDigest };
  const abort = validateTransitionAbort({ ...base, abort_digest: digest(base) }, store);
  writeImmutable(transitionAbortPath(store, receipt.operation_id), Buffer.from(canonicalJson(abort)), { conflictCode: "GENERATION_TRANSITION_CONFLICT" });
  return abort;
}

function switchEventFor(receipt) {
  return {
    from_generation: receipt.from_generation,
    to_generation: receipt.to_generation,
    epoch: receipt.epoch,
    actor: receipt.actor,
    operation_id: receipt.operation_id,
    decision_digest: receipt.decision_digest,
    legacy_read_allowed: receipt.legacy_read_allowed,
    transition_receipt_digest: receipt.receipt_digest,
    rollback_overlay_digest: receipt.rollback_overlay_digest,
    quiescence_attestation_digest: receipt.quiescence_attestation_digest,
  };
}

function receiptEventId(store, receipt) {
  return eventId("generation_switched", store.repositoryDigest, switchEventFor(receipt));
}

function pendingTransition(store, marker) {
  for (const receipt of readTransitionReceipts(store)) {
    if (readTransitionAbort(store, receipt)) continue;
    const expectedEvent = receiptEventId(store, receipt);
    const eventExists = Boolean(secureRead(path.join(store.paths.events, `${expectedEvent}.json`), `${expectedEvent}.json`));
    const recordedByMarker = marker?.transition_receipt_digest === receipt.receipt_digest;
    if (!eventExists && !recordedByMarker) return receipt;
  }
  return null;
}

function buildMarker(store, receipt) {
  const eventDigest = receiptEventId(store, receipt);
  const unsigned = {
    schema_version: 1,
    repository_digest: store.repositoryDigest,
    epoch: receipt.epoch,
    writer_generation: receipt.to_generation,
    legacy_read_allowed: receipt.legacy_read_allowed,
    switched_at: receipt.switched_at,
    decision_digest: receipt.decision_digest,
    transition_operation_id: receipt.operation_id,
    transition_actor: receipt.actor,
    transition_receipt_digest: receipt.receipt_digest,
    transition_event_digest: eventDigest,
    rollback_overlay_digest: receipt.rollback_overlay_digest,
    quiescence_attestation_digest: receipt.quiescence_attestation_digest,
  };
  return validateMarker({ ...unsigned, marker_digest: digest(unsigned) }, store);
}

function ensureMarkerEventLocked(store, marker, fault = null) {
  if (!marker?.transition_operation_id) return null;
  const receipt = validateTransitionReceipt(parseJson(secureRead(transitionReceiptPath(store, marker.transition_operation_id), `transition receipt ${marker.transition_operation_id}`), `transition receipt ${marker.transition_operation_id}`), store);
  const rebuilt = buildMarker(store, receipt);
  if (rebuilt.marker_digest !== marker.marker_digest || marker.transition_receipt_digest !== receipt.receipt_digest) fail("GENERATION_TRANSITION_CONFLICT", "active marker does not match its durable transition receipt");
  return appendEvent(store, { type: "generation_switched", payload: switchEventFor(receipt), occurredAt: receipt.switched_at, fault });
}

function commitTransition({ store, current, actor, operationId, switchedAt, toGeneration, legacyReadAllowed, rollbackOverlayDigest = null, quiescenceAttestationDigest = null, beforeMarker = null, afterMarker = null, fault = null }) {
  string(actor, "generation transition actor", TOKEN_RE);
  string(operationId, "generation transition operation id", TOKEN_RE);
  timestamp(switchedAt, "generation transition timestamp");
  if (current.writer_generation === toGeneration && current.transition_operation_id === operationId && current.transition_actor === actor
    && current.legacy_read_allowed === legacyReadAllowed && current.rollback_overlay_digest === rollbackOverlayDigest
    && current.quiescence_attestation_digest === quiescenceAttestationDigest) {
    const receipt = validateTransitionReceipt(parseJson(secureRead(transitionReceiptPath(store, operationId), `transition receipt ${operationId}`), `transition receipt ${operationId}`), store);
    const marker = buildMarker(store, receipt);
    if (current.transition_receipt_digest !== receipt.receipt_digest || current.marker_digest !== marker.marker_digest) fail("GENERATION_TRANSITION_CONFLICT", "active marker does not match its transition receipt");
    const event = appendEvent(store, { type: "generation_switched", payload: switchEventFor(receipt), occurredAt: receipt.switched_at, fault });
    return { marker: readGeneration(store), event, receipt, prepared: null, changed: false };
  }
  const tighteningLegacyReads = current.writer_generation === "vnext" && toGeneration === "vnext"
    && current.legacy_read_allowed === true && legacyReadAllowed === false;
  if (current.writer_generation === toGeneration && !tighteningLegacyReads) {
    fail("GENERATION_TRANSITION_CONFLICT", "generation is active under another transition contract");
  }
  let pending = pendingTransition(store, current);
  if (pending && (pending.operation_id !== operationId || pending.actor !== actor)) {
    const freshSignedCutover = current.writer_generation === "legacy" && pending.to_generation === "vnext"
      && pending.legacy_read_allowed === false && pending.quiescence_attestation_digest
      && toGeneration === "vnext" && legacyReadAllowed === false && quiescenceAttestationDigest
      && pending.quiescence_attestation_digest !== quiescenceAttestationDigest;
    if (!freshSignedCutover) fail("GENERATION_TRANSITION_PENDING", "another transition has a durable pending receipt");
    abortTransition(store, pending, { abortedAt: switchedAt, reason: "superseded_by_fresh_attestation", supersededByOperationId: operationId, supersedingQuiescenceAttestationDigest: quiescenceAttestationDigest });
    pending = null;
  }
  // Only signed vNext-only cutover uses beforeMarker as a volatile validator.
  // Rollback uses the callback to durably publish its overlay and therefore
  // keeps the receipt-first ordering that binds retry identity.
  const validateBeforeReceipt = Boolean(beforeMarker && quiescenceAttestationDigest && toGeneration === "vnext" && legacyReadAllowed === false);
  let prepared = validateBeforeReceipt ? beforeMarker(pending) : null;
  let receipt;
  if (pending) {
    if (pending.from_generation !== current.writer_generation || pending.to_generation !== toGeneration
      || pending.decision_digest !== current.decision_digest || pending.legacy_read_allowed !== legacyReadAllowed
      || pending.rollback_overlay_digest !== rollbackOverlayDigest || pending.quiescence_attestation_digest !== quiescenceAttestationDigest) {
      fail("GENERATION_TRANSITION_CONFLICT", "pending generation receipt does not match the requested transition contract");
    }
    receipt = pending;
  } else {
    const targetEpoch = current.epoch + 1;
    const base = { schema_version: 1, repository_digest: store.repositoryDigest, operation_id: operationId, actor, from_generation: current.writer_generation, to_generation: toGeneration, epoch: targetEpoch, switched_at: switchedAt, decision_digest: current.decision_digest, legacy_read_allowed: legacyReadAllowed, rollback_overlay_digest: rollbackOverlayDigest, quiescence_attestation_digest: quiescenceAttestationDigest };
    receipt = validateTransitionReceipt({ ...base, receipt_digest: digest(base) }, store);
    writeImmutable(transitionReceiptPath(store, operationId), Buffer.from(canonicalJson(receipt)), { conflictCode: "GENERATION_TRANSITION_CONFLICT", fault });
  }
  if (beforeMarker && !validateBeforeReceipt) prepared = beforeMarker(receipt);
  const marker = buildMarker(store, receipt);
  const markerChanged = current.marker_digest !== marker.marker_digest;
  replaceAtomic(store.paths.generation, Buffer.from(canonicalJson(marker)), { fault });
  if (afterMarker) {
    try {
      afterMarker(receipt, marker);
    } catch (error) {
      // No generation admission can proceed while this repository lock is held.
      // Restore the prior marker before releasing it; the durable receipt is a
      // retry intent and will be revalidated on the next operation.
      replaceAtomic(store.paths.generation, Buffer.from(canonicalJson(current)));
      abortTransition(store, receipt, { abortedAt: switchedAt, reason: "post_marker_validation_failed" });
      throw error;
    }
  }
  const event = appendEvent(store, { type: "generation_switched", payload: switchEventFor(receipt), occurredAt: receipt.switched_at, fault });
  return { marker: readGeneration(store), event, receipt, prepared, changed: markerChanged };
}

function switchGenerationLocked(opened, { generation, actor, operationId, switchedAt, drainInventoryDigest = null, legacyReadAllowed = null, quiescenceAttestationDigest = null, beforeMarker = null, afterMarker = null, fault = null }) {
  if (generation !== "vnext") fail("ROLLBACK_REQUIRES_OVERLAY", "use rollbackToLegacy to activate legacy writes");
  const decision = readDecision(opened);
  const current = readGeneration(opened);
  if (!decision || !current) fail("GENERATION_DECISION_MISSING", "migration decision and initial marker are required");
  const targetLegacyReadAllowed = legacyReadAllowed === null ? decision.strategy === "dual_read_vnext_write" : legacyReadAllowed;
  if (decision.strategy === "drain_and_cutover") {
    string(drainInventoryDigest, "drain inventory digest", SHA256_RE);
    const drain = readDrainCompleted(opened);
    if (!drain || drain.inventory_digest !== drainInventoryDigest || drain.active_legacy_run_count !== 0 || drain.observed_at <= decision.observed_at) fail("LEGACY_DRAIN_INCOMPLETE", "vNext switch requires the exact fresh zero drain inventory digest");
  } else if (drainInventoryDigest !== null) {
    fail("INVALID_GENERATION_ARTIFACT", "dual-read transition must not supply a drain inventory digest");
  }
  return commitTransition({ store: opened, current, actor, operationId, switchedAt, toGeneration: "vnext", legacyReadAllowed: targetLegacyReadAllowed, quiescenceAttestationDigest, beforeMarker, afterMarker, fault });
}

function switchGeneration({ store, generation, actor, operationId, switchedAt, drainInventoryDigest = null, fault = null }) {
  const opened = openStore(store);
  return withRepositoryLockSync(opened, () => switchGenerationLocked(opened, { generation, actor, operationId, switchedAt, drainInventoryDigest, fault }));
}

function projectLegacyRecovery(facts) {
  if (!Array.isArray(facts)) fail("INVALID_GENERATION_ARTIFACT", "vnextFacts must be an array");
  let pullRequest = null;
  let merge = null;
  let attempt = null;
  for (const fact of facts) {
    if (!plainObject(fact) || !SHA256_RE.test(fact.event_id || "") || typeof fact.type !== "string" || !plainObject(fact.payload)) fail("INVALID_GENERATION_ARTIFACT", "vnextFacts must contain event-id, type, and payload");
    if (fact.type === "pull_request_recorded") {
      const payload = fact.payload;
      pullRequest = { pr_number: payload.pr_number, repo: payload.repo, head_ref: payload.head_ref, base_ref: payload.base_ref, head_sha: payload.head_sha, created_by_relay: payload.created_by_relay };
    } else if (fact.type === "merge_recorded") {
      const payload = fact.payload;
      merge = { pr_number: payload.pr_number, reviewed_source_sha: payload.reviewed_source_sha, pr_head_sha: payload.pr_head_sha, result_target_sha: payload.result_target_sha, method: payload.method, operation_id: payload.operation_id };
    } else if (fact.type === "attempt_started") {
      string(fact.attempt_id, "attempt_started.attempt_id", TOKEN_RE);
      attempt = { attempt_id: fact.attempt_id, state: "active", status: "running", start_sha: fact.payload.start_sha, final_sha: null };
    } else if (fact.type === "attempt_finished") {
      string(fact.attempt_id, "attempt_finished.attempt_id", TOKEN_RE);
      attempt = { attempt_id: fact.attempt_id, state: "terminal", status: fact.payload.status, start_sha: fact.payload.start_sha, final_sha: fact.payload.final_sha };
    } else if (fact.type === "attempt_interrupted") {
      string(fact.attempt_id, "attempt_interrupted.attempt_id", TOKEN_RE);
      attempt = { attempt_id: fact.attempt_id, state: "terminal", status: "interrupted", start_sha: attempt?.attempt_id === fact.attempt_id ? attempt.start_sha : null, final_sha: fact.payload.last_known_sha };
    }
  }
  return { pull_request: pullRequest, merge, attempt };
}

function validateProjection(projection) {
  exactKeys(projection, ["pull_request", "merge", "attempt"], "legacy projection");
  if (projection.pull_request !== null) {
    exactKeys(projection.pull_request, ["pr_number", "repo", "head_ref", "base_ref", "head_sha", "created_by_relay"], "legacy projection.pull_request");
    integer(projection.pull_request.pr_number, "legacy projection.pull_request.pr_number", { minimum: 1 });
    for (const key of ["repo", "head_ref", "base_ref"]) string(projection.pull_request[key], `legacy projection.pull_request.${key}`);
    string(projection.pull_request.head_sha, "legacy projection.pull_request.head_sha", SHA1_RE);
    if (typeof projection.pull_request.created_by_relay !== "boolean") fail("INVALID_GENERATION_ARTIFACT", "legacy projection.pull_request.created_by_relay must be boolean");
  }
  if (projection.merge !== null) {
    exactKeys(projection.merge, ["pr_number", "reviewed_source_sha", "pr_head_sha", "result_target_sha", "method", "operation_id"], "legacy projection.merge");
    integer(projection.merge.pr_number, "legacy projection.merge.pr_number", { minimum: 1 });
    for (const key of ["reviewed_source_sha", "pr_head_sha", "result_target_sha"]) string(projection.merge[key], `legacy projection.merge.${key}`, SHA1_RE);
    string(projection.merge.method, "legacy projection.merge.method", TOKEN_RE);
    string(projection.merge.operation_id, "legacy projection.merge.operation_id", TOKEN_RE);
  }
  if (projection.attempt !== null) {
    exactKeys(projection.attempt, ["attempt_id", "state", "status", "start_sha", "final_sha"], "legacy projection.attempt");
    string(projection.attempt.attempt_id, "legacy projection.attempt.attempt_id", TOKEN_RE);
    if (!new Set(["active", "terminal"]).has(projection.attempt.state)) fail("INVALID_GENERATION_ARTIFACT", "legacy projection.attempt.state is invalid");
    string(projection.attempt.status, "legacy projection.attempt.status", TOKEN_RE);
    if (projection.attempt.start_sha !== null) string(projection.attempt.start_sha, "legacy projection.attempt.start_sha", SHA1_RE);
    if (projection.attempt.final_sha !== null) string(projection.attempt.final_sha, "legacy projection.attempt.final_sha", SHA1_RE);
  }
  return projection;
}

function validateRunFacts(run) {
  exactKeys(run, ["run_id", "closed", "facts"], "canonical vNext run facts");
  string(run.run_id, "canonical vNext run facts.run_id", TOKEN_RE);
  if (typeof run.closed !== "boolean" || !Array.isArray(run.facts)) fail("INVALID_GENERATION_ARTIFACT", "canonical vNext run facts must include closed and facts");
  const eventIds = new Set();
  for (const fact of run.facts) {
    if (!plainObject(fact) || !SHA256_RE.test(fact.event_id || "") || typeof fact.type !== "string" || !plainObject(fact.payload)) fail("INVALID_GENERATION_ARTIFACT", "canonical vNext facts must contain event-id, type, and payload");
    if (eventIds.has(fact.event_id)) fail("INVALID_GENERATION_ARTIFACT", "canonical vNext fact ids must be unique per run");
    eventIds.add(fact.event_id);
  }
  const projection = validateProjection(projectLegacyRecovery(run.facts));
  return Object.freeze({ run_id: run.run_id, closed: run.closed, facts: run.facts, facts_digest: digest(run.facts), fact_event_ids: [...eventIds].sort(), terminal: projection.attempt, action: { pull_request: projection.pull_request, merge: projection.merge } });
}

function canonicalRunSet(runIds, loaded) {
  if (!Array.isArray(runIds) || runIds.length === 0) fail("INVALID_GENERATION_ARTIFACT", "rollback requires one or more canonical run ids");
  const expected = [...runIds];
  for (const runId of expected) string(runId, "rollback run id", TOKEN_RE);
  if (new Set(expected).size !== expected.length) fail("INVALID_GENERATION_ARTIFACT", "rollback run ids must be unique");
  if (!Array.isArray(loaded)) fail("INVALID_GENERATION_ARTIFACT", "canonical run fact loader must return an array");
  const runs = loaded.map(validateRunFacts).sort((left, right) => left.run_id.localeCompare(right.run_id));
  if (runs.length !== expected.length || runs.some((run, index) => run.run_id !== [...expected].sort()[index])) fail("CANONICAL_RUN_FACTS_MISMATCH", "canonical run fact loader did not return exactly the requested runs");
  return runs.map((run) => Object.freeze({ run_id: run.run_id, closed: run.closed, facts_digest: run.facts_digest, fact_event_ids: run.fact_event_ids, terminal: run.terminal, action: run.action }));
}

function validateOverlay(overlay, store) {
  if (plainObject(overlay) && overlay.schema_version !== SCHEMA_VERSION) fail("UNSUPPORTED_GENERATION_SCHEMA", "rollback overlay schema is unsupported");
  exactKeys(overlay, ["schema_version", "repository_digest", "epoch", "legacy_reader_version", "transition_operation_id", "transition_actor", "vnext_runs_digest", "runs", "overlay_digest"], "legacy recovery overlay");
  if (overlay.repository_digest !== store.repositoryDigest) fail("REPOSITORY_IDENTITY_MISMATCH", "rollback overlay belongs to another repository");
  integer(overlay.epoch, "legacy recovery overlay.epoch", { minimum: 2 });
  if (overlay.legacy_reader_version !== LEGACY_OVERLAY_READER_VERSION) fail("LEGACY_OVERLAY_UNSUPPORTED", "installed legacy overlay reader is incompatible");
  string(overlay.transition_operation_id, "legacy recovery overlay.transition_operation_id", TOKEN_RE);
  string(overlay.transition_actor, "legacy recovery overlay.transition_actor", TOKEN_RE);
  string(overlay.vnext_runs_digest, "legacy recovery overlay.vnext_runs_digest", SHA256_RE);
  if (!Array.isArray(overlay.runs) || overlay.runs.length === 0) fail("INVALID_GENERATION_ARTIFACT", "rollback overlay runs are required");
  const seen = new Set();
  for (const run of overlay.runs) {
    exactKeys(run, ["run_id", "closed", "facts_digest", "fact_event_ids", "terminal", "action"], "rollback overlay run");
    string(run.run_id, "rollback overlay run.run_id", TOKEN_RE);
    if (seen.has(run.run_id)) fail("INVALID_GENERATION_ARTIFACT", "rollback overlay run ids must be unique");
    seen.add(run.run_id);
    if (typeof run.closed !== "boolean") fail("INVALID_GENERATION_ARTIFACT", "rollback overlay run.closed must be boolean");
    string(run.facts_digest, "rollback overlay run.facts_digest", SHA256_RE);
    if (!Array.isArray(run.fact_event_ids) || run.fact_event_ids.some((id) => !SHA256_RE.test(id)) || new Set(run.fact_event_ids).size !== run.fact_event_ids.length) fail("INVALID_GENERATION_ARTIFACT", "rollback overlay run fact ids must be unique SHA-256 values");
    if (run.terminal !== null) validateProjection({ pull_request: null, merge: null, attempt: run.terminal });
    exactKeys(run.action, ["pull_request", "merge"], "rollback overlay run.action");
    validateProjection({ pull_request: run.action.pull_request, merge: run.action.merge, attempt: null });
  }
  if (overlay.vnext_runs_digest !== digest(overlay.runs)) fail("INVALID_GENERATION_ARTIFACT", "rollback overlay runs digest is invalid");
  const { overlay_digest: overlayDigest, ...unsigned } = overlay;
  if (!SHA256_RE.test(overlayDigest || "") || overlayDigest !== digest(unsigned)) fail("INVALID_GENERATION_ARTIFACT", "rollback overlay digest is invalid");
  return overlay;
}

function readLegacyRecoveryOverlay({ store, readerVersion = LEGACY_OVERLAY_READER_VERSION }) {
  const opened = openStore(store);
  if (readerVersion !== LEGACY_OVERLAY_READER_VERSION) fail("LEGACY_OVERLAY_UNSUPPORTED", "this runtime cannot consume the requested legacy overlay version");
  const marker = readGeneration(opened);
  if (!marker?.rollback_overlay_digest) fail("ROLLBACK_OVERLAY_MISSING", "active generation marker has no rollback overlay pointer");
  const overlayPath = path.join(opened.paths.overlays, `${marker.rollback_overlay_digest}.json`);
  const overlay = parseJson(secureRead(overlayPath, "legacy recovery overlay"), "legacy recovery overlay");
  if (!overlay) fail("ROLLBACK_OVERLAY_MISSING", "legacy recovery overlay is missing");
  const validated = validateOverlay(overlay, opened);
  if (validated.overlay_digest !== marker.rollback_overlay_digest || validated.epoch !== marker.epoch) fail("ROLLBACK_OVERLAY_MISMATCH", "active marker does not match the immutable rollback overlay");
  return Object.freeze({ epoch: validated.epoch, runs: validated.runs });
}

function rollbackToLegacy({ store, legacyReaderVersion = LEGACY_OVERLAY_READER_VERSION, runIds, loadRunFacts, switchedAt, actor, operationId, fault = null }) {
  const opened = openStore(store);
  if (legacyReaderVersion !== LEGACY_OVERLAY_READER_VERSION) fail("LEGACY_OVERLAY_UNSUPPORTED", "installed legacy reader cannot consume the rollback overlay");
  if (typeof loadRunFacts !== "function") fail("CANONICAL_RUN_FACT_LOADER_REQUIRED", "rollback requires a canonical multi-run fact loader callback");
  if (!Array.isArray(runIds) || runIds.length === 0) fail("INVALID_GENERATION_ARTIFACT", "rollback requires one or more canonical run ids");
  return withRepositoryLockSync(opened, () => {
    const current = readGeneration(opened);
    if (!current || (current.writer_generation !== "vnext" && current.writer_generation !== "legacy")) fail("GENERATION_NOT_ACTIVE", "an initialized generation marker is required before rollback");
    const targetEpoch = current.writer_generation === "legacy" ? current.epoch : current.epoch + 1;
    const request = Object.freeze({ repository_digest: opened.repositoryDigest, epoch: current.epoch, run_ids: Object.freeze([...runIds]), generation: current.writer_generation });
    const runs = canonicalRunSet(runIds, loadRunFacts(request));
    const base = { schema_version: 1, repository_digest: opened.repositoryDigest, epoch: targetEpoch, legacy_reader_version: legacyReaderVersion, transition_operation_id: operationId, transition_actor: actor, vnext_runs_digest: digest(runs), runs };
    const overlay = validateOverlay({ ...base, overlay_digest: digest(base) }, opened);
    const transition = commitTransition({
      store: opened,
      current,
      actor,
      operationId,
      switchedAt,
      toGeneration: "legacy",
      legacyReadAllowed: true,
      rollbackOverlayDigest: overlay.overlay_digest,
      beforeMarker() {
        writeImmutable(path.join(opened.paths.overlays, `${overlay.overlay_digest}.json`), Buffer.from(canonicalJson(overlay)), { conflictCode: "ROLLBACK_OVERLAY_CONFLICT", fault });
        return appendEvent(opened, { type: "rollback_overlay_written", payload: { overlay_digest: overlay.overlay_digest, legacy_reader_version: legacyReaderVersion, vnext_runs_digest: overlay.vnext_runs_digest, epoch: targetEpoch, actor, operation_id: operationId }, occurredAt: switchedAt, fault });
      },
      fault,
    });
    readLegacyRecoveryOverlay({ store: opened, readerVersion: legacyReaderVersion });
    return { overlay, overlayEvent: transition.prepared, marker: transition.marker, switchEvent: transition.event, receipt: transition.receipt, changed: transition.changed };
  });
}

function rolloutUnsigned(value) {
  const { observation_digest: ignored, ...unsigned } = value;
  return unsigned;
}

function validateRolloutObservation(value, store, { now = new Date().toISOString() } = {}) {
  exactKeys(value, ["schema_version", "sequence", "repository_digest", "previous_digest", "type", "occurred_at", "payload", "observation_digest"], "rollout observation");
  if (value.schema_version !== SCHEMA_VERSION || value.repository_digest !== store.repositoryDigest) fail("REPOSITORY_IDENTITY_MISMATCH", "rollout observation belongs to another repository");
  integer(value.sequence, "rollout observation.sequence", { minimum: 1 });
  if (value.previous_digest !== null) string(value.previous_digest, "rollout observation.previous_digest", SHA256_RE);
  if (!ROLLOUT_TYPES.has(value.type) || !plainObject(value.payload)) fail("INVALID_ROLLOUT_LEDGER", "rollout observation type or payload is invalid");
  const payloadKeys = {
    legacy_inventory_observed: ["inventory_digest", "identity_digest", "active_legacy_run_count", "oldest_active_legacy_age_hours", "items"],
    legacy_artifact_read: ["surface", "artifact_name", "artifact_sha256", "marker_digest"],
    legacy_surface_invoked: ["invocation_id", "command", "mode", "marker_digest"],
    vnext_terminal_observed: ["receipt_digest", "run_id", "terminal_event_id"],
    daily_checkpoint: ["date", "marker_digest", "inventory_identity_digest", "inventory_content_digest", "active_legacy_run_count", "terminal_receipts_digest", "terminal_run_count", "legacy_activity_count", "observation_prefix_digest"],
  };
  exactKeys(value.payload, payloadKeys[value.type], `${value.type} payload`, "INVALID_ROLLOUT_LEDGER");
  timestamp(value.occurred_at, "rollout observation.occurred_at");
  timestamp(now, "rollout verifier now");
  if (value.occurred_at > now) fail("ROLLOUT_FUTURE_TIMESTAMP", "rollout observation is in the future");
  if (value.observation_digest !== digest(rolloutUnsigned(value))) fail("INVALID_ROLLOUT_LEDGER", "rollout observation digest is invalid");
  return value;
}

function rolloutSealUnsigned(value) {
  const { seal_digest: ignored, ...unsigned } = value;
  return unsigned;
}

function validateRolloutSeal(value, store) {
  exactKeys(value, ["schema_version", "repository_digest", "sequence", "previous_seal_digest", "observation_digest", "seal_digest"], "rollout observation seal", "INVALID_ROLLOUT_ROOT");
  if (value.schema_version !== 1 || value.repository_digest !== store.repositoryDigest) fail("REPOSITORY_IDENTITY_MISMATCH", "rollout observation seal belongs to another repository");
  integer(value.sequence, "rollout observation seal.sequence", { minimum: 1 });
  if (value.previous_seal_digest !== null) string(value.previous_seal_digest, "rollout observation seal.previous_seal_digest", SHA256_RE);
  string(value.observation_digest, "rollout observation seal.observation_digest", SHA256_RE);
  if (value.seal_digest !== digest(rolloutSealUnsigned(value))) fail("INVALID_ROLLOUT_ROOT", "rollout observation seal digest is invalid");
  return value;
}

function readRolloutState(store, { now = new Date().toISOString(), allowUnsealedTail = false } = {}) {
  const opened = peekStore({ checkoutRoot: path.dirname(store.repository.git_common_dir), remote: store.repository.remote });
  if (!opened) fail("ROLLOUT_UNAVAILABLE", "generation store is absent");
  for (const [label, target] of [["rollout observations", opened.paths.rollout], ["rollout observation seals", opened.paths.rolloutSeals], ["terminal receipts", opened.paths.terminalReceipts]]) {
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") fail("ROLLOUT_UNAVAILABLE", `${label} are not initialized`); throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) fail("UNTRUSTED_GENERATION_PATH", `${label} must be a canonical real directory`);
  }
  const names = fs.readdirSync(opened.paths.rollout).sort();
  let previous = null, lastOccurredAt = null;
  const observations = names.map((name, index) => {
    const expected = `${String(index + 1).padStart(12, "0")}.json`;
    if (name !== expected) fail("ROLLOUT_SEQUENCE_GAP", `expected ${expected}, found ${name}`);
    const value = validateRolloutObservation(parseJson(secureRead(path.join(opened.paths.rollout, name), name), name), opened, { now });
    if (value.sequence !== index + 1 || value.previous_digest !== previous) fail("ROLLOUT_SEQUENCE_BROKEN", `rollout observation ${name} breaks the digest chain`);
    if (lastOccurredAt && value.occurred_at < lastOccurredAt) fail("ROLLOUT_EVENT_REORDERED", "rollout observation timestamps are not monotonic");
    previous = value.observation_digest; lastOccurredAt = value.occurred_at;
    return value;
  });
  const sealNames = fs.readdirSync(opened.paths.rolloutSeals).sort();
  let previousSeal = null;
  const seals = sealNames.map((name, index) => {
    const expected = `${String(index + 1).padStart(12, "0")}.json`;
    if (name !== expected) fail("ROLLOUT_ROOT_GAP", `expected seal ${expected}, found ${name}`);
    const seal = validateRolloutSeal(parseJson(secureRead(path.join(opened.paths.rolloutSeals, name), `seal ${name}`), `seal ${name}`), opened);
    const observation = observations[index];
    if (!observation || seal.sequence !== index + 1 || seal.previous_seal_digest !== previousSeal || seal.observation_digest !== observation.observation_digest) fail("ROLLOUT_ROOT_MISMATCH", `rollout seal ${name} does not bind its observation prefix`);
    previousSeal = seal.seal_digest;
    return seal;
  });
  if (observations.length !== seals.length) {
    const recoverableTail = allowUnsealedTail && observations.length === seals.length + 1;
    if (!recoverableTail) fail("ROLLOUT_ROOT_MISMATCH", "rollout observation set is not exactly bound by immutable monotonic seals");
  }
  const head = parseJson(secureRead(opened.paths.rolloutHead, "rollout-observation-head.json"), "rollout-observation-head.json");
  if (seals.length === 0) {
    if (head) fail("ROLLOUT_HEAD_MISMATCH", "empty rollout ledger has a head");
  } else if (head) {
    exactKeys(head, ["schema_version", "repository_digest", "sequence", "observation_digest", "seal_digest"], "rollout head");
    integer(head.sequence, "rollout head.sequence", { minimum: 1 });
    const sealed = seals[head.sequence - 1], observation = observations[head.sequence - 1];
    if (head.schema_version !== 1 || head.repository_digest !== opened.repositoryDigest || !sealed || !observation
      || head.observation_digest !== observation.observation_digest || head.seal_digest !== sealed.seal_digest) fail("ROLLOUT_HEAD_MISMATCH", "rollout head does not reference a valid immutable seal");
  }
  return { store: opened, observations, seals, unsealed: observations.length === seals.length + 1 ? observations.at(-1) : null };
}

function readRolloutObservations(store, { now = new Date().toISOString() } = {}) {
  const state = readRolloutState(store, { now });
  return { store: state.store, observations: state.observations };
}

function sealRolloutObservation(store, observation, priorSeal, fault = null) {
  const base = { schema_version: 1, repository_digest: store.repositoryDigest, sequence: observation.sequence, previous_seal_digest: priorSeal?.seal_digest || null, observation_digest: observation.observation_digest };
  const seal = validateRolloutSeal({ ...base, seal_digest: digest(base) }, store);
  writeImmutable(path.join(store.paths.rolloutSeals, `${String(seal.sequence).padStart(12, "0")}.json`), Buffer.from(canonicalJson(seal)), { conflictCode: "ROLLOUT_ROOT_CONFLICT", fault });
  replaceAtomic(store.paths.rolloutHead, Buffer.from(canonicalJson({ schema_version: 1, repository_digest: store.repositoryDigest, sequence: observation.sequence, observation_digest: observation.observation_digest, seal_digest: seal.seal_digest })), { fault });
  return seal;
}

function appendRolloutLocked(store, { type, occurredAt, payload, fault = null }) {
  const state = readRolloutState(store, { now: occurredAt, allowUnsealedTail: true }), { observations, seals } = state;
  const prior = observations.at(-1) || null;
  if (state.unsealed) {
    const retryBase = { schema_version: 1, sequence: state.unsealed.sequence, repository_digest: store.repositoryDigest, previous_digest: observations.at(-2)?.observation_digest || null, type, occurred_at: occurredAt, payload };
    const retry = validateRolloutObservation({ ...retryBase, observation_digest: digest(retryBase) }, store, { now: occurredAt });
    sealRolloutObservation(store, state.unsealed, seals.at(-1) || null, fault);
    if (retry.observation_digest === state.unsealed.observation_digest) return state.unsealed;
    return appendRolloutLocked(store, { type, occurredAt, payload, fault });
  }
  if (prior && occurredAt < prior.occurred_at) fail("ROLLOUT_EVENT_REORDERED", "new rollout observation predates the durable head");
  const base = { schema_version: 1, sequence: observations.length + 1, repository_digest: store.repositoryDigest, previous_digest: prior?.observation_digest || null, type, occurred_at: occurredAt, payload };
  const observation = validateRolloutObservation({ ...base, observation_digest: digest(base) }, store, { now: occurredAt });
  writeImmutable(path.join(store.paths.rollout, `${String(observation.sequence).padStart(12, "0")}.json`), Buffer.from(canonicalJson(observation)), { conflictCode: "ROLLOUT_OBSERVATION_CONFLICT", fault });
  sealRolloutObservation(store, observation, seals.at(-1) || null, fault);
  return observation;
}

function repositoryRunsDirectory(store, runsRoot = process.env.RELAY_RUNS_BASE || path.join(process.env.RELAY_HOME || path.join(os.homedir(), ".relay"), "runs")) {
  if (!path.isAbsolute(runsRoot)) fail("INVALID_RELAY_PATH", "canonical runs root must be absolute");
  const root = fs.realpathSync(path.resolve(runsRoot));
  if (!fs.lstatSync(root).isDirectory()) fail("INVALID_RELAY_PATH", "canonical runs root must be a real directory");
  const repoRoot = fs.realpathSync(path.dirname(store.repository.git_common_dir));
  const base = path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const directory = path.join(root, `${base}-${crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 8)}`);
  let stat;
  try { stat = fs.lstatSync(directory); } catch (error) { if (error.code === "ENOENT") fail("ACTIVE_LEGACY_AMBIGUITY", "canonical repository run directory is absent"); throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail("ACTIVE_LEGACY_AMBIGUITY", "canonical repository run directory is untrusted");
  return directory;
}

function manifestTimestamp(runId, bytes) {
  const field = /^\s{2}created_at:\s*['"]?([^'"\n]+)['"]?\s*$/m.exec(bytes.toString("utf8"))?.[1];
  if (field && !Number.isNaN(Date.parse(field))) return new Date(field).toISOString();
  const compact = /-(\d{17})(?:-|$)/.exec(runId)?.[1];
  if (!compact) return null;
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(8, 10)}:${compact.slice(10, 12)}:${compact.slice(12, 14)}.${compact.slice(14)}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function observeLegacyInventoryLocked(store, { runsRoot, observedAt, record = true }) {
  const runs = repositoryRunsDirectory(store, runsRoot), entries = fs.readdirSync(runs, { withFileTypes: true });
  const manifests = new Map(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => [entry.name.slice(0, -3), entry.name]));
  if (manifests.size === 0) fail("ACTIVE_LEGACY_AMBIGUITY", "canonical legacy inventory is empty");
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail("ACTIVE_LEGACY_AMBIGUITY", `symlinked run entry ${entry.name}`);
    if (entry.isFile() && !entry.name.endsWith(".md")) fail("ACTIVE_LEGACY_AMBIGUITY", `unknown run file ${entry.name}`);
    if (entry.isDirectory() && !manifests.has(entry.name) && !fs.existsSync(path.join(runs, entry.name, "run.json"))) fail("ACTIVE_LEGACY_AMBIGUITY", `orphan legacy run directory ${entry.name}`);
  }
  const items = [];
  for (const [runId, name] of [...manifests].sort()) {
    const filePath = path.join(runs, name), bytes = secureRead(filePath, `legacy manifest ${name}`);
    if (!bytes || bytes.length > 2 * 1024 * 1024) fail("ACTIVE_LEGACY_AMBIGUITY", `legacy manifest ${name} is missing or oversized`);
    const text = bytes.toString("utf8"), seenId = /^run_id:\s*['"]?([^'"\n]+)['"]?\s*$/m.exec(text)?.[1], state = /^state:\s*['"]?([^'"\n]+)['"]?\s*$/m.exec(text)?.[1];
    if (seenId !== runId || !state) fail("ACTIVE_LEGACY_AMBIGUITY", `legacy manifest ${name} cannot be identified`);
    const createdAt = manifestTimestamp(runId, bytes), stat = fs.lstatSync(filePath, { bigint: true });
    if (createdAt && createdAt > observedAt) fail("ACTIVE_LEGACY_AMBIGUITY", `legacy manifest ${name} has a future creation time`);
    if (!new Set(["merged", "closed"]).has(state) && !createdAt) fail("ACTIVE_LEGACY_AMBIGUITY", `active legacy manifest ${name} has no trustworthy creation time`);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    items.push({ name, run_id: runId, state, created_at: createdAt, size: Number(stat.size), mtime_ns: String(stat.mtimeNs), sha256 });
    if (record) appendRolloutLocked(store, { type: "legacy_artifact_read", occurredAt: observedAt, payload: { surface: "canonical_inventory", artifact_name: name, artifact_sha256: sha256, marker_digest: peekGeneration(store)?.marker_digest || null } });
  }
  const active = items.filter((item) => !new Set(["merged", "closed"]).has(item.state));
  const oldest = active.length ? Math.max(...active.map((item) => Math.floor((Date.parse(observedAt) - Date.parse(item.created_at)) / 3_600_000))) : null;
  const identity = items.map(({ name, size, mtime_ns }) => ({ name, size, mtime_ns }));
  const payload = { inventory_digest: digest(items), identity_digest: digest(identity), active_legacy_run_count: active.length, oldest_active_legacy_age_hours: oldest, items };
  if (record) appendRolloutLocked(store, { type: "legacy_inventory_observed", occurredAt: observedAt, payload });
  return payload;
}

function previewMigrationFromCanonicalInventory({ checkoutRoot, remote, runsRoot, actor = null, operationId = null, quiescenceReason = null, observedAt = new Date().toISOString() }) {
  const resolved = resolveRepositoryState({ checkoutRoot, remote });
  const store = Object.freeze({ stateDir: resolved.stateDir, repository: resolved.repository, repositoryDigest: digest(resolved.repository), paths: pathsFor(resolved.stateDir) });
  const inventory = observeLegacyInventoryLocked(store, { runsRoot, observedAt, record: false });
  const selectedStrategy = inventory.active_legacy_run_count <= 5 && (inventory.oldest_active_legacy_age_hours === null || inventory.oldest_active_legacy_age_hours < 72) ? "drain_and_cutover" : "dual_read_vnext_write";
  const existingStore = peekStore({ checkoutRoot, remote }), marker = existingStore ? peekGeneration(existingStore) : null;
  let quiescenceRequest = null;
  if (inventory.active_legacy_run_count === 0 && actor && operationId && quiescenceReason) {
    string(actor, "migration preview actor", TOKEN_RE); string(operationId, "migration preview operation id", TOKEN_RE);
    if (typeof quiescenceReason !== "string" || !quiescenceReason.trim() || quiescenceReason.length > 1024) fail("INVALID_QUIESCENCE_ATTESTATION", "migration preview quiescence reason is invalid");
    quiescenceRequest = { schema_version: 1, repository_digest: store.repositoryDigest, operation_id: `${operationId}-${marker?.writer_generation === "vnext" && marker.legacy_read_allowed ? "vnext-only" : "switch"}`, actor, reason: quiescenceReason.trim(), target_generation: "vnext", legacy_read_allowed: false, inventory_digest: inventory.inventory_digest, identity_digest: inventory.identity_digest, active_legacy_run_count: 0, oldest_active_legacy_age_hours: null, previous_anchor_digest: null };
  }
  return { schema_version: 1, operation: "start", dry_run: true, repository_digest: store.repositoryDigest, inventory, selected_strategy: selectedStrategy, can_start: true, can_cutover_vnext_only: inventory.active_legacy_run_count === 0, quiescence_request: quiescenceRequest, blockers: selectedStrategy === "drain_and_cutover" && inventory.active_legacy_run_count > 0 ? ["legacy_drain_pending"] : [] };
}

function currentLegacyIdentity(store, runsRoot) {
  const runs = repositoryRunsDirectory(store, runsRoot), observations = readRolloutObservations(store).observations;
  const baseline = observations.filter((item) => item.type === "legacy_inventory_observed").at(-1)?.payload;
  if (!baseline || baseline.active_legacy_run_count !== 0) fail("ACTIVE_LEGACY_AMBIGUITY", "no canonical zero-active legacy inventory is sealed");
  const entries = fs.readdirSync(runs, { withFileTypes: true }), names = new Set(baseline.items.map((item) => item.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (entry.isFile() && !entry.name.endsWith(".md")) || (entry.isFile() && entry.name.endsWith(".md") && !names.has(entry.name))) fail("ACTIVE_LEGACY_AMBIGUITY", `legacy inventory drift at ${entry.name}`);
    if (entry.isDirectory() && !names.has(`${entry.name}.md`) && !fs.existsSync(path.join(runs, entry.name, "run.json"))) fail("ACTIVE_LEGACY_AMBIGUITY", `orphan legacy run directory ${entry.name}`);
  }
  const content = [], identity = baseline.items.map((item) => {
    const target = path.join(runs, item.name); let stat;
    try { stat = fs.lstatSync(target, { bigint: true }); } catch { fail("ACTIVE_LEGACY_AMBIGUITY", `legacy manifest ${item.name} disappeared`); }
    if (!stat.isFile() || stat.isSymbolicLink()) fail("ACTIVE_LEGACY_AMBIGUITY", `legacy manifest ${item.name} is untrusted`);
    const bytes = secureRead(target, `legacy inventory audit ${item.name}`), sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== item.sha256) fail("ACTIVE_LEGACY_AMBIGUITY", `sealed legacy manifest ${item.name} content drifted`);
    content.push({ name: item.name, sha256 });
    return { name: item.name, size: Number(stat.size), mtime_ns: String(stat.mtimeNs) };
  });
  const identityDigest = digest(identity);
  if (identityDigest !== baseline.identity_digest) fail("ACTIVE_LEGACY_AMBIGUITY", "sealed legacy inventory metadata drifted");
  return { baseline, identityDigest, contentDigest: digest(content) };
}

function quiescenceAttestationPath(store, operationId) {
  return path.join(store.paths.quiescence, `${operationId}.json`);
}

function validateQuiescenceAttestation(value, store) {
  exactKeys(value, ["schema_version", "repository_digest", "operation_id", "actor", "reason", "target_generation", "legacy_read_allowed", "inventory_digest", "identity_digest", "active_legacy_run_count", "oldest_active_legacy_age_hours", "issued_at", "expires_at", "previous_anchor_digest", "key_id", "signature", "attestation_digest"], "legacy quiescence attestation", "INVALID_QUIESCENCE_ATTESTATION");
  const { attestation_digest: attestationDigest, signature, ...unsigned } = value;
  if (value.schema_version !== 1 || value.repository_digest !== store.repositoryDigest || attestationDigest !== digest({ ...unsigned, signature })) fail("INVALID_QUIESCENCE_ATTESTATION", "legacy quiescence attestation digest is invalid");
  for (const key of ["operation_id", "actor"]) string(value[key], `legacy quiescence attestation.${key}`, TOKEN_RE);
  if (typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 1024) fail("INVALID_QUIESCENCE_ATTESTATION", "legacy quiescence attestation reason is invalid");
  if (value.target_generation !== "vnext" || value.legacy_read_allowed !== false || value.active_legacy_run_count !== 0 || value.oldest_active_legacy_age_hours !== null || value.previous_anchor_digest !== null) fail("INVALID_QUIESCENCE_ATTESTATION", "legacy quiescence attestation does not authorize a zero-active vNext-only genesis");
  timestamp(value.issued_at, "legacy quiescence attestation.issued_at"); timestamp(value.expires_at, "legacy quiescence attestation.expires_at");
  for (const key of ["inventory_digest", "identity_digest", "key_id", "attestation_digest"]) string(value[key], `legacy quiescence attestation.${key}`, SHA256_RE);
  if (typeof signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) fail("INVALID_QUIESCENCE_ATTESTATION", "legacy quiescence attestation signature is invalid");
  return value;
}

function verifyQuiescenceAttestation(attestation, publicKeyBytes, store, { operationId, actor, reason, observedAt, inventory }) {
  const validated = validateQuiescenceAttestation(attestation, store), { publicKey, keyId } = rolloutPublicKey(publicKeyBytes);
  const { attestation_digest: ignoredDigest, signature: ignoredSignature, ...unsigned } = validated;
  if (validated.key_id !== keyId || !crypto.verify(null, Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(validated.signature, "base64"))) fail("INVALID_QUIESCENCE_ATTESTATION", "legacy quiescence authority signature does not verify");
  if (validated.operation_id !== operationId || validated.actor !== actor || validated.reason !== reason.trim()
    || validated.inventory_digest !== inventory.inventory_digest || validated.identity_digest !== inventory.identity_digest
    || validated.issued_at > observedAt || validated.expires_at < observedAt) fail("QUIESCENCE_ATTESTATION_STALE", "legacy quiescence attestation does not bind the exact current operator intent and inventory");
  return validated;
}

function writeQuiescenceAttestationLocked(store, attestation) {
  const proposed = validateQuiescenceAttestation(attestation, store), operationId = proposed.operation_id;
  const target = quiescenceAttestationPath(store, operationId);
  const existing = parseJson(secureRead(target, `legacy quiescence attestation ${operationId}`), `legacy quiescence attestation ${operationId}`);
  if (existing) {
    const validated = validateQuiescenceAttestation(existing, store);
    if (canonicalJson(validated) !== canonicalJson(proposed)) {
      fail("QUIESCENCE_ATTESTATION_CONFLICT", "durable legacy quiescence attestation conflicts with the current operator assertion or inventory");
    }
    return validated;
  }
  writeImmutable(target, Buffer.from(canonicalJson(proposed)), { conflictCode: "QUIESCENCE_ATTESTATION_CONFLICT" });
  return validateQuiescenceAttestation(parseJson(secureRead(target, `legacy quiescence attestation ${operationId}`), `legacy quiescence attestation ${operationId}`), store);
}

function configuredQuiescenceAttestation(store) {
  const attestationPath = process.env.RELAY_QUIESCENCE_ATTESTATION_FILE, keyPath = process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE;
  if (!attestationPath || !keyPath) fail("QUIESCENCE_ATTESTATION_REQUIRED", "RELAY_QUIESCENCE_ATTESTATION_FILE and RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE are required for vNext-only cutover");
  return {
    attestation: parseJson(externallyControlledBytes(attestationPath, store, "external legacy quiescence attestation"), "external legacy quiescence attestation"),
    publicKeyBytes: externallyControlledBytes(keyPath, store, "external rollout public key"),
  };
}

function startMigrationFromCanonicalInventory({ store, runsRoot, actor, operationId, quiescenceReason, now = () => new Date().toISOString(), fault = null }) {
  const opened = openStore(store); string(actor, "migration actor", TOKEN_RE); string(operationId, "migration operation id", TOKEN_RE);
  if (typeof quiescenceReason !== "string" || !quiescenceReason.trim() || quiescenceReason.length > 1024) fail("QUIESCENCE_ATTESTATION_REQUIRED", "migration start requires a non-empty legacy-writer quiescence reason");
  const observationForDecision = (inventory, observedAt) => ({ observed_at: observedAt, active_legacy_run_count: inventory.active_legacy_run_count, oldest_active_legacy_age_hours: inventory.oldest_active_legacy_age_hours });
  const nextAfter = (minimum) => {
    let value = now();
    for (let attempt = 0; value <= minimum && attempt < 1000; attempt += 1) { sleep(1); value = now(); }
    if (value <= minimum) fail("ROLLOUT_CLOCK_STALLED", "clock did not advance for a fresh canonical observation");
    return value;
  };
  const sameInventory = (left, right) => left.inventory_digest === right.inventory_digest && left.identity_digest === right.identity_digest;
  return withRepositoryLockSync(opened, () => {
    let marker = readGeneration(opened), decision = readDecision(opened);
    if (marker?.writer_generation === "vnext") ensureMarkerEventLocked(opened, marker, fault);
    if (marker?.writer_generation === "vnext" && marker.legacy_read_allowed === false) {
      const observedAt = now(), inventory = observeLegacyInventoryLocked(opened, { runsRoot, observedAt, record: false });
      return { inventory, decision, marker, changed: false, phase: "vnext_only" };
    }
    const firstAt = now();
    let inventory = observeLegacyInventoryLocked(opened, { runsRoot, observedAt: firstAt });
    if (!decision) decision = decideMigrationLocked(opened, observationForDecision(inventory, firstAt), fault).decision;
    else ensureDecisionArtifactsLocked(opened, decision, fault);
    marker = readGeneration(opened);
    if (decision.strategy === "drain_and_cutover" && inventory.active_legacy_run_count > 0) {
      return { inventory, decision, marker, changed: false, phase: "draining" };
    }
    if (decision.strategy === "dual_read_vnext_write" && marker.writer_generation === "vnext" && inventory.active_legacy_run_count > 0) {
      return { inventory, decision, marker, changed: false, phase: "dual_read_vnext_write" };
    }
    const transitionAt = nextAfter(firstAt > decision.observed_at ? firstAt : decision.observed_at);
    inventory = observeLegacyInventoryLocked(opened, { runsRoot, observedAt: transitionAt });
    if ((decision.strategy === "drain_and_cutover" || marker.writer_generation === "vnext") && inventory.active_legacy_run_count !== 0) {
      fail("ACTIVE_LEGACY_RUNS_PRESENT", "vNext-only cutover requires a final zero-active legacy inventory");
    }
    fault?.("after_final_inventory", opened.paths.rollout);
    const validated = observeLegacyInventoryLocked(opened, { runsRoot, observedAt: transitionAt, record: false });
    if (!sameInventory(inventory, validated)) fail("ACTIVE_LEGACY_AMBIGUITY", "canonical legacy inventory changed during the cutover transaction");
    let completed = null;
    if (decision.strategy === "drain_and_cutover") {
      completed = readDrainCompleted(opened);
      if (completed) ensureDrainEventLocked(opened, completed, fault);
      else completed = recordDrainCompletedLocked(opened, observationForDecision(inventory, transitionAt), actor, `${operationId}-drain`, fault).inventory;
    }
    const tightening = marker.writer_generation === "vnext" && marker.legacy_read_allowed === true;
    const targetLegacyReadAllowed = tightening ? false : decision.strategy === "dual_read_vnext_write";
    const requireVnextOnlySnapshot = targetLegacyReadAllowed === false;
    const transitionOperationId = `${operationId}-${tightening ? "vnext-only" : "switch"}`;
    let attestation = null;
    if (requireVnextOnlySnapshot) {
      const authority = configuredQuiescenceAttestation(opened);
      attestation = verifyQuiescenceAttestation(authority.attestation, authority.publicKeyBytes, opened, {
        operationId: transitionOperationId,
        actor,
        reason: quiescenceReason,
        observedAt: transitionAt,
        inventory,
      });
      writeQuiescenceAttestationLocked(opened, attestation);
    }
    const assertAttestedInventory = () => {
      const finalInventory = observeLegacyInventoryLocked(opened, { runsRoot, observedAt: transitionAt, record: false });
      if (finalInventory.active_legacy_run_count !== 0 || !sameInventory(inventory, finalInventory)
        || (attestation && (attestation.inventory_digest !== finalInventory.inventory_digest || attestation.identity_digest !== finalInventory.identity_digest))) {
        fail("ACTIVE_LEGACY_AMBIGUITY", "canonical legacy inventory changed across attested cutover marker publication");
      }
    };
    const switched = switchGenerationLocked(opened, {
      generation: "vnext",
      actor,
      operationId: transitionOperationId,
      switchedAt: transitionAt,
      drainInventoryDigest: completed?.inventory_digest || null,
      legacyReadAllowed: targetLegacyReadAllowed,
      quiescenceAttestationDigest: attestation?.attestation_digest || null,
      beforeMarker: requireVnextOnlySnapshot ? () => {
        // The receipt is deliberately durable before the marker.  A retry may
        // reuse it, but it can never publish a vNext-only marker without a
        // snapshot equal to the final zero-active canonical inventory.
        fault?.("before_cutover_marker", opened.paths.generation);
        assertAttestedInventory();
      } : null,
      afterMarker: requireVnextOnlySnapshot ? () => {
        fault?.("after_cutover_marker", opened.paths.generation);
        assertAttestedInventory();
      } : null,
      fault,
    });
    return { inventory, decision, marker: switched.marker, changed: switched.changed, phase: switched.marker.legacy_read_allowed ? "dual_read_vnext_write" : "vnext_only" };
  });
}

function recordLegacySurfaceInvocation({ store, command, mode, invocationId = crypto.randomUUID(), observedAt = new Date().toISOString() }) {
  const opened = openStore(store);
  return withRepositoryLockSync(opened, () => appendRolloutLocked(opened, { type: "legacy_surface_invoked", occurredAt: observedAt, payload: { invocation_id: invocationId, command, mode, marker_digest: peekGeneration(opened)?.marker_digest || null } }));
}

function recordLegacyArtifactRead({ store, surface, artifactName, artifactSha256, observedAt = new Date().toISOString() }) {
  const opened = openStore(store);
  return withRepositoryLockSync(opened, () => appendRolloutLocked(opened, { type: "legacy_artifact_read", occurredAt: observedAt, payload: { surface, artifact_name: artifactName, artifact_sha256: artifactSha256, marker_digest: peekGeneration(opened)?.marker_digest || null } }));
}

function terminalDescriptor(runDir, store) {
  const runStore = require("./run-store"), facts = require("./facts"), inspect = require("./inspect");
  const record = runStore.readRunRecord({ runDir }), journal = facts.readFacts({ eventsPath: path.join(runDir, "events.jsonl") });
  if (record.repo.root !== fs.realpathSync(path.dirname(store.repository.git_common_dir)) || record.repo.remote !== store.repository.remote || journal.tailIncomplete) fail("VNEXT_TERMINAL_AMBIGUITY", `run ${record.run_id} is not a canonical complete vNext run`);
  const derived = inspect.foldRunFacts({ runRecord: record, facts: journal.facts, gitFacts: {}, githubFacts: {}, hostFacts: {} });
  if (!derived.terminal) return null;
  if (derived.diagnostics?.length) fail("VNEXT_TERMINAL_AMBIGUITY", `run ${record.run_id} has conflicting terminal history`);
  const terminals = journal.facts.filter((fact) => new Set(["merge_recorded", "run_closed"]).has(fact.type));
  if (terminals.length !== 1) fail("VNEXT_TERMINAL_AMBIGUITY", `run ${record.run_id} must have exactly one terminal fact`);
  return { record, terminal: terminals[0], run_digest: digest(record), terminal_fact_digest: digest(terminals[0]) };
}

function validateTerminalReceipt(receipt, store, marker) {
  exactKeys(receipt, ["schema_version", "repository_digest", "marker_digest", "epoch", "run_id", "run_digest", "terminal_event_id", "terminal_type", "terminal_at", "terminal_fact_digest", "observed_at", "receipt_digest"], "vNext terminal receipt", "INVALID_TERMINAL_RECEIPT");
  const { receipt_digest: receiptDigest, ...unsigned } = receipt;
  if (receipt.schema_version !== 1 || receipt.repository_digest !== store.repositoryDigest || receipt.marker_digest !== marker.marker_digest || receipt.epoch !== marker.epoch || receiptDigest !== digest(unsigned)) fail("INVALID_TERMINAL_RECEIPT", "terminal receipt is not bound to the active generation");
  if (typeof receipt.run_id !== "string" || !TOKEN_RE.test(receipt.run_id)
    || typeof receipt.terminal_event_id !== "string" || !receipt.terminal_event_id.trim()
    || !new Set(["merge_recorded", "run_closed"]).has(receipt.terminal_type)) fail("INVALID_TERMINAL_RECEIPT", "terminal receipt identity fields are invalid");
  for (const key of ["run_digest", "terminal_fact_digest", "receipt_digest"]) string(receipt[key], `terminal receipt.${key}`, SHA256_RE);
  timestamp(receipt.terminal_at, "terminal receipt.terminal_at"); timestamp(receipt.observed_at, "terminal receipt.observed_at");
  return receipt;
}

function canonicalTerminalReceiptDigest(values) {
  const canonical = values.map((item) => ({ run_id: item.run_id, receipt_digest: item.receipt_digest }))
    .sort((left, right) => left.run_id.localeCompare(right.run_id));
  if (new Set(canonical.map((item) => item.run_id)).size !== canonical.length) fail("TERMINAL_RECEIPT_CONFLICT", "terminal receipt run ids must be unique");
  return digest(canonical);
}

function rolloutAnchorUnsigned(value) {
  const { anchor_digest: ignoredDigest, signature: ignoredSignature, ...unsigned } = value;
  return unsigned;
}

function rolloutAnchorDigest(value) {
  const { anchor_digest: ignored, ...content } = value;
  return digest(content);
}

function rolloutLineageUnsigned(value) {
  const { lineage_digest: ignored, ...unsigned } = value;
  return unsigned;
}

function rolloutAnchorRequest(store, latest, marker, previousAnchorDigest = null) {
  if (!latest) return null;
  return {
    schema_version: 1,
    repository_digest: store.repositoryDigest,
    marker_digest: marker.marker_digest,
    sequence: latest.observation.sequence,
    observation_digest: latest.observation.observation_digest,
    seal_digest: latest.seal.seal_digest,
    checkpoint_date: latest.observation.payload.date,
    previous_anchor_digest: previousAnchorDigest,
  };
}

function rolloutPublicKey(publicKeyBytes) {
  let publicKey;
  try { publicKey = crypto.createPublicKey(publicKeyBytes); } catch (error) { fail("INVALID_ROLLOUT_ANCHOR", `external rollout public key is invalid: ${error.message}`); }
  if (publicKey.asymmetricKeyType !== "ed25519") fail("INVALID_ROLLOUT_ANCHOR", "external rollout public key must be Ed25519");
  const keyId = crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  return { publicKey, keyId };
}

function verifyRolloutAnchor(lineage, publicKeyBytes, store, context, now) {
  exactKeys(lineage, ["schema_version", "repository_digest", "marker_digest", "anchors", "lineage_digest"], "external rollout anchor lineage", "INVALID_ROLLOUT_ANCHOR");
  if (lineage.schema_version !== 1 || lineage.repository_digest !== store.repositoryDigest) fail("REPOSITORY_IDENTITY_MISMATCH", "external rollout anchor lineage belongs to another repository");
  if (!context?.marker || lineage.marker_digest !== context.marker.marker_digest || !Array.isArray(lineage.anchors) || lineage.anchors.length === 0
    || lineage.lineage_digest !== digest(rolloutLineageUnsigned(lineage))) fail("INVALID_ROLLOUT_ANCHOR", "external rollout anchor lineage is invalid");
  const { publicKey, keyId } = rolloutPublicKey(publicKeyBytes);
  const eligible = context.checkpoints.filter((checkpoint) => checkpoint.occurred_at > context.zeroLegacySince);
  if (lineage.anchors.length > eligible.length) fail("ROLLOUT_ANCHOR_GAP", "external rollout anchor lineage extends beyond the canonical clean checkpoints");
  if (eligible.length - lineage.anchors.length > 1) fail("ROLLOUT_ANCHOR_GAP", "external rollout anchor lineage has more than one unsigned checkpoint tail");
  if (!context.marker.quiescence_attestation_digest) fail("INVALID_ROLLOUT_ANCHOR", "active marker has no external quiescence genesis");
  const genesis = validateQuiescenceAttestation(parseJson(secureRead(quiescenceAttestationPath(store, context.marker.transition_operation_id), "rollout quiescence genesis"), "rollout quiescence genesis"), store);
  if (genesis.attestation_digest !== context.marker.quiescence_attestation_digest || genesis.key_id !== keyId) fail("INVALID_ROLLOUT_ANCHOR", "rollout lineage authority does not match its signed quiescence genesis");
  let prior = null;
  for (let index = 0; index < lineage.anchors.length; index += 1) {
    const anchor = lineage.anchors[index], checkpoint = eligible[index];
    exactKeys(anchor, ["schema_version", "repository_digest", "marker_digest", "sequence", "observation_digest", "seal_digest", "checkpoint_date", "issued_at", "previous_anchor_digest", "key_id", "signature", "anchor_digest"], "external rollout anchor", "INVALID_ROLLOUT_ANCHOR");
    if (anchor.schema_version !== 1 || anchor.repository_digest !== store.repositoryDigest || anchor.marker_digest !== context.marker.marker_digest || anchor.key_id !== keyId) fail("REPOSITORY_IDENTITY_MISMATCH", "external rollout anchor identity is invalid");
    integer(anchor.sequence, "external rollout anchor.sequence", { minimum: 1 });
    for (const key of ["observation_digest", "seal_digest", "key_id", "anchor_digest"]) string(anchor[key], `external rollout anchor.${key}`, SHA256_RE);
    if (anchor.previous_anchor_digest !== null) string(anchor.previous_anchor_digest, "external rollout anchor.previous_anchor_digest", SHA256_RE);
    timestamp(anchor.issued_at, "external rollout anchor.issued_at");
    if (typeof anchor.checkpoint_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(anchor.checkpoint_date)
      || typeof anchor.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(anchor.signature)
      || anchor.anchor_digest !== rolloutAnchorDigest(anchor)
      || !crypto.verify(null, Buffer.from(canonicalJson(rolloutAnchorUnsigned(anchor))), publicKey, Buffer.from(anchor.signature, "base64"))) fail("INVALID_ROLLOUT_ANCHOR", "external rollout anchor signature or digest is invalid");
    const observation = context.observations[anchor.sequence - 1], seal = context.seals[anchor.sequence - 1];
    if (!checkpoint || observation !== checkpoint || observation?.type !== "daily_checkpoint" || anchor.sequence !== checkpoint.sequence
      || anchor.observation_digest !== checkpoint.observation_digest || anchor.seal_digest !== seal?.seal_digest
      || anchor.checkpoint_date !== checkpoint.payload.date
      || anchor.previous_anchor_digest !== (prior?.anchor_digest || context.marker.quiescence_attestation_digest)) fail("ROLLOUT_ANCHOR_GAP", "external rollout anchor lineage is missing, reordered, or does not bind canonical checkpoint roots");
    if (anchor.issued_at < checkpoint.occurred_at || anchor.issued_at > now || (prior && anchor.issued_at <= prior.issued_at)) fail("ROLLOUT_ANCHOR_TIME_INVALID", "external rollout anchor issuance is not monotonic after its checkpoint");
    prior = anchor;
  }
  const latest = context.observations.at(-1), latestSeal = context.seals.at(-1), first = lineage.anchors[0], last = lineage.anchors.at(-1);
  const complete = lineage.anchors.length === eligible.length && last.sequence === latest?.sequence
    && last.observation_digest === latest?.observation_digest && last.seal_digest === latestSeal?.seal_digest;
  const issuanceSpanSatisfied = Date.parse(last.issued_at) - Date.parse(first.issued_at) >= 30 * 24 * 60 * 60 * 1000;
  if (!complete || !issuanceSpanSatisfied) {
    const next = eligible[lineage.anchors.length];
    return {
      status: "pending", required: true, key_id: keyId, sequence: last.sequence, issued_at: last.issued_at,
      witnessed_checkpoints: lineage.anchors.length, first_issued_at: first.issued_at,
      anchor_request: next ? rolloutAnchorRequest(store, { observation: next, seal: context.seals[next.sequence - 1] }, context.marker, last.anchor_digest) : null,
      pending_reason: !complete ? "unsigned_checkpoint_tail" : "signed_lineage_below_30_days",
    };
  }
  return { status: "verified", required: true, key_id: keyId, sequence: last.sequence, issued_at: last.issued_at, witnessed_checkpoints: lineage.anchors.length, first_issued_at: first.issued_at };
}

function externallyControlledBytes(filePath, store, label) {
  if (typeof process.geteuid !== "function") fail("ROLLOUT_ANCHOR_UNAVAILABLE", `${label} cannot establish the relay OS identity`);
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) fail("ROLLOUT_ANCHOR_UNAVAILABLE", `${label} path must be absolute`);
  const resolved = path.resolve(filePath), canonical = fs.realpathSync(resolved), stat = fs.lstatSync(resolved), parent = fs.realpathSync(path.dirname(resolved));
  if (canonical !== resolved || !stat.isFile() || stat.isSymbolicLink() || isInside(store.stateDir, canonical) || isInside(path.dirname(store.repository.git_common_dir), canonical)) fail("ROLLOUT_ANCHOR_UNAVAILABLE", `${label} must be a canonical external regular file`);
  const authorityPath = [canonical];
  for (let current = parent; ; current = path.dirname(current)) {
    authorityPath.push(current);
    if (current === path.dirname(current)) break;
  }
  for (const target of authorityPath) {
    const targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink() || fs.realpathSync(target) !== target || targetStat.uid === process.geteuid()) {
      fail("ROLLOUT_ANCHOR_UNAVAILABLE", `${label} authority path must be owned by a different OS identity and contain no symlink components`);
    }
    try { fs.accessSync(target, fs.constants.W_OK); fail("ROLLOUT_ANCHOR_UNAVAILABLE", `${label} authority must not be writable by the relay process`); }
    catch (error) { if (!new Set(["EACCES", "EPERM"]).has(error.code)) throw error; }
  }
  const bytes = secureRead(canonical, label, { dev: stat.dev, ino: stat.ino });
  const after = fs.lstatSync(canonical);
  if (after.dev !== stat.dev || after.ino !== stat.ino) fail("ROLLOUT_ANCHOR_UNAVAILABLE", `${label} path identity changed during authority read`);
  return bytes;
}

function configuredRolloutAnchor(store) {
  const anchorPath = process.env.RELAY_ROLLOUT_ANCHOR_FILE, keyPath = process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE;
  if (!anchorPath && !keyPath) return null;
  if (!anchorPath || !keyPath) fail("ROLLOUT_ANCHOR_UNAVAILABLE", "both RELAY_ROLLOUT_ANCHOR_FILE and RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE are required");
  return {
    lineage: parseJson(externallyControlledBytes(anchorPath, store, "external rollout anchor lineage"), "external rollout anchor lineage"),
    publicKeyBytes: externallyControlledBytes(keyPath, store, "external rollout public key"),
  };
}

function committedVnextMarkers(store, activeMarker) {
  const markers = new Map(), committedEventIds = new Set(readEvents(store).filter((event) => event.type === "generation_switched").map((event) => event.event_id));
  for (const receipt of readTransitionReceipts(store)) {
    if (receipt.to_generation !== "vnext" || receipt.legacy_read_allowed || readTransitionAbort(store, receipt)) continue;
    if (!committedEventIds.has(receiptEventId(store, receipt)) && activeMarker?.transition_receipt_digest !== receipt.receipt_digest) continue;
    const marker = buildMarker(store, receipt);
    markers.set(marker.marker_digest, marker);
  }
  if (activeMarker?.writer_generation === "vnext" && activeMarker.legacy_read_allowed === false) markers.set(activeMarker.marker_digest, activeMarker);
  return markers;
}

function terminalReceiptSet(store, runsRoot, { write = false, observedAt = new Date().toISOString(), knownRunIds = new Set() } = {}) {
  const marker = write ? readGeneration(store) : peekGeneration(store);
  if (!marker || marker.writer_generation !== "vnext" || marker.legacy_read_allowed) fail("ROLLOUT_UNAVAILABLE", "retirement observation requires vNext-only generation");
  const runs = repositoryRunsDirectory(store, runsRoot), markerHistory = committedVnextMarkers(store, marker), receiptByDigest = new Map(), persistedCurrentRunIds = new Set();
  for (const name of fs.readdirSync(store.paths.terminalReceipts)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.json$/.test(name)) fail("TERMINAL_RECEIPT_SET_MISMATCH", `unexpected terminal receipt ${name}`);
    const bytes = secureRead(path.join(store.paths.terminalReceipts, name), `terminal receipt ${name}`), persisted = parseJson(bytes, `terminal receipt ${name}`);
    const receiptMarker = markerHistory.get(persisted?.marker_digest);
    if (!receiptMarker) fail("INVALID_TERMINAL_RECEIPT", `terminal receipt ${name} does not bind a committed vNext-only epoch`);
    validateTerminalReceipt(persisted, store, receiptMarker);
    if (!bytes.equals(Buffer.from(canonicalJson(persisted))) || `${persisted.run_id}.json` !== name) fail("INVALID_TERMINAL_RECEIPT", `terminal receipt ${name} is not canonical JSON or filename-bound`);
    let historical;
    try { historical = terminalDescriptor(path.join(runs, persisted.run_id), store); }
    catch (error) { if (error.code === "ENOENT") fail("INVALID_TERMINAL_RECEIPT", `terminal receipt ${name} lost its historical run bytes`); throw error; }
    if (!historical || historical.run_digest !== persisted.run_digest || historical.terminal.event_id !== persisted.terminal_event_id
      || historical.terminal.type !== persisted.terminal_type || new Date(historical.terminal.at).toISOString() !== persisted.terminal_at
      || historical.terminal_fact_digest !== persisted.terminal_fact_digest) fail("INVALID_TERMINAL_RECEIPT", `terminal receipt ${name} no longer binds its canonical historical run and fact bytes`);
    if (receiptByDigest.has(persisted.receipt_digest)) fail("TERMINAL_RECEIPT_CONFLICT", `terminal receipt ${name} is duplicated`);
    receiptByDigest.set(persisted.receipt_digest, persisted);
    if (persisted.marker_digest === marker.marker_digest) persistedCurrentRunIds.add(persisted.run_id);
  }
  const observations = readRolloutObservations(store, { now: observedAt }).observations.filter((item) => item.type === "vnext_terminal_observed");
  const observedByRun = new Map();
  for (const observation of observations) {
    const boundReceipt = receiptByDigest.get(observation.payload.receipt_digest);
    if (!boundReceipt) fail("TERMINAL_RECEIPT_MISSING", `terminal observation for ${observation.payload.run_id} has no persisted receipt`);
    if (boundReceipt.run_id !== observation.payload.run_id || boundReceipt.terminal_event_id !== observation.payload.terminal_event_id) fail("TERMINAL_RECEIPT_CONFLICT", `terminal observation for ${observation.payload.run_id} does not match its persisted receipt`);
    if (boundReceipt.marker_digest !== marker.marker_digest) continue;
    const prior = observedByRun.get(observation.payload.run_id);
    if (prior && prior.payload.receipt_digest !== observation.payload.receipt_digest) fail("TERMINAL_RECEIPT_CONFLICT", `terminal observation for ${observation.payload.run_id} conflicts`);
    if (prior) fail("TERMINAL_RECEIPT_CONFLICT", `terminal observation for ${observation.payload.run_id} is duplicated`);
    observedByRun.set(observation.payload.run_id, observation);
  }
  const receipts = [], pending = [];
  for (const entry of fs.readdirSync(runs, { withFileTypes: true }).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const runDir = path.join(runs, entry.name);
    if (!fs.existsSync(path.join(runDir, "run.json"))) continue;
    const descriptor = terminalDescriptor(runDir, store);
    if (!descriptor) continue;
    const createdAt = new Date(descriptor.record.created_at).toISOString();
    if (createdAt < marker.switched_at) continue;
    if (createdAt > observedAt || new Date(descriptor.terminal.at).toISOString() > observedAt) fail("ROLLOUT_FUTURE_TIMESTAMP", `terminal run ${descriptor.record.run_id} is in the future`);
    const target = path.join(store.paths.terminalReceipts, `${descriptor.record.run_id}.json`), persistedBytes = secureRead(target, `terminal receipt ${descriptor.record.run_id}`);
    const persisted = parseJson(persistedBytes, `terminal receipt ${descriptor.record.run_id}`);
    if (!persisted && observedByRun.has(descriptor.record.run_id)) fail("TERMINAL_RECEIPT_MISSING", `previously observed terminal receipt for ${descriptor.record.run_id} was deleted`);
    if (persisted) {
      validateTerminalReceipt(persisted, store, marker);
      if (!persistedBytes.equals(Buffer.from(canonicalJson(persisted)))) fail("INVALID_TERMINAL_RECEIPT", `terminal receipt for ${descriptor.record.run_id} is not canonical JSON`);
    }
    const base = { schema_version: 1, repository_digest: store.repositoryDigest, marker_digest: marker.marker_digest, epoch: marker.epoch, run_id: descriptor.record.run_id, run_digest: descriptor.run_digest, terminal_event_id: descriptor.terminal.event_id, terminal_type: descriptor.terminal.type, terminal_at: new Date(descriptor.terminal.at).toISOString(), terminal_fact_digest: descriptor.terminal_fact_digest, observed_at: persisted?.observed_at || observedAt };
    const receipt = validateTerminalReceipt({ ...base, receipt_digest: digest(base) }, store, marker);
    if (receipt.observed_at > observedAt) fail("ROLLOUT_FUTURE_TIMESTAMP", `terminal receipt for ${receipt.run_id} is in the future`);
    if (persisted && canonicalJson(persisted) !== canonicalJson(receipt)) fail("TERMINAL_RECEIPT_CONFLICT", `terminal receipt for ${receipt.run_id} conflicts with canonical facts`);
    const observed = observedByRun.get(receipt.run_id);
    if (observed && (observed.payload.receipt_digest !== receipt.receipt_digest || observed.payload.terminal_event_id !== receipt.terminal_event_id)) fail("TERMINAL_RECEIPT_CONFLICT", `terminal observation for ${receipt.run_id} conflicts with its receipt`);
    if (write) {
      writeImmutable(target, Buffer.from(canonicalJson(receipt)), { conflictCode: "TERMINAL_RECEIPT_CONFLICT" });
      persistedCurrentRunIds.add(receipt.run_id);
      if (!observed) appendRolloutLocked(store, { type: "vnext_terminal_observed", occurredAt: observedAt, payload: { receipt_digest: receipt.receipt_digest, run_id: receipt.run_id, terminal_event_id: receipt.terminal_event_id } });
    } else {
      if (!persisted) {
        if (knownRunIds.has(receipt.run_id)) fail("TERMINAL_RECEIPT_MISSING", `previously observed terminal receipt for ${receipt.run_id} was deleted`);
        pending.push(receipt.run_id); continue;
      }
      if (!observed) { pending.push(receipt.run_id); continue; }
    }
    receipts.push(receipt);
  }
  if ([...persistedCurrentRunIds].some((runId) => !receipts.some((receipt) => receipt.run_id === runId))) fail("TERMINAL_RECEIPT_SET_MISMATCH", "current-epoch terminal receipt set contains an unknown or deleted run binding");
  return { receipts: receipts.sort((a, b) => a.run_id.localeCompare(b.run_id)), pending };
}

const LEGACY_ACTIVITY_TYPES = new Set(["legacy_artifact_read", "legacy_surface_invoked"]);

/**
 * Legacy activity the cutover cannot disown: at or after switched_at, not strictly after.
 * Millisecond timestamps cannot order events inside the switch millisecond, and callers already
 * exclude everything before the zero-inventory boundary by sequence.  Counting the ambiguous
 * millisecond can only overstate legacy activity; excluding it lets post-boundary legacy reads
 * vanish from the retirement evidence permanently.  recordRolloutCheckpoint and retirementStatus
 * must apply the identical boundary or a checkpoint fails its own canonical recount.
 *
 * The `zero_legacy_since` caller shares this predicate for one rule rather than for a behaviour
 * change: ROLLOUT_EVENT_REORDERED keeps `occurred_at` non-decreasing in sequence, so `.at(-1)`
 * selects the same observation under either boundary and no test can distinguish that use.  It is
 * shared so the boundary cannot drift; relaxing that ordering guard would make it live again.
 */
function postCutoverLegacyActivity(item, marker) {
  return LEGACY_ACTIVITY_TYPES.has(item.type) && item.occurred_at >= marker.switched_at;
}

function recordRolloutCheckpoint({ store, runsRoot, observedAt = new Date().toISOString() }) {
  const opened = openStore(store); timestamp(observedAt, "checkpoint observedAt");
  return withRepositoryLockSync(opened, () => {
    const recoverable = readRolloutState(opened, { now: observedAt, allowUnsealedTail: true });
    if (recoverable.unsealed) sealRolloutObservation(opened, recoverable.unsealed, recoverable.seals.at(-1) || null);
    const marker = readGeneration(opened), initial = readRolloutObservations(opened, { now: observedAt }).observations;
    const prior = initial.filter((item) => item.type === "daily_checkpoint" && item.payload.marker_digest === marker.marker_digest).at(-1);
    const date = observedAt.slice(0, 10);
    if (prior) {
      const next = new Date(`${prior.payload.date}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate() + 1);
      if (date !== prior.payload.date && date !== next.toISOString().slice(0, 10)) fail("ROLLOUT_CHECKPOINT_GAP", "daily checkpoints must be consecutive");
      if (date === prior.payload.date) fail("ROLLOUT_CHECKPOINT_CONFLICT", "today already has a checkpoint");
    }
    const identity = currentLegacyIdentity(opened, runsRoot), { receipts } = terminalReceiptSet(opened, runsRoot, { write: true, observedAt });
    const observations = readRolloutObservations(opened, { now: observedAt }).observations;
    const boundary = observations.filter((item) => item.type === "legacy_inventory_observed" && item.payload.active_legacy_run_count === 0 && item.occurred_at <= marker.switched_at).at(-1);
    if (!boundary) fail("ACTIVE_LEGACY_AMBIGUITY", "active marker has no zero-inventory cutover boundary");
    const after = prior?.sequence || boundary.sequence, activity = observations.filter((item) => item.sequence > after && postCutoverLegacyActivity(item, marker));
    const payload = { date, marker_digest: marker.marker_digest, inventory_identity_digest: identity.identityDigest, inventory_content_digest: identity.contentDigest, active_legacy_run_count: 0, terminal_receipts_digest: canonicalTerminalReceiptDigest(receipts), terminal_run_count: receipts.length, legacy_activity_count: activity.length, observation_prefix_digest: observations.at(-1)?.observation_digest || null };
    return appendRolloutLocked(opened, { type: "daily_checkpoint", occurredAt: observedAt, payload });
  });
}

function retirementStatus(request) {
  if (!plainObject(request)) fail("INVALID_ROLLOUT_REQUEST", "retirement status request is required");
  if (Object.hasOwn(request, "externalAnchor") || Object.hasOwn(request, "anchorPublicKey")) {
    fail("ROLLOUT_ANCHOR_UNAVAILABLE", "direct rollout anchor injection is not a production API; use the configured external authority files");
  }
  const { store, runsRoot, now = new Date().toISOString() } = request;
  timestamp(now, "retirement status now");
  const rollout = readRolloutState(store, { now }), { store: opened, observations, seals } = rollout, marker = peekGeneration(opened);
  if (!marker || marker.writer_generation !== "vnext" || marker.legacy_read_allowed) fail("ROLLOUT_UNAVAILABLE", "vNext-only marker is required");
  const identity = currentLegacyIdentity(opened, runsRoot), markerHistory = committedVnextMarkers(opened, marker);
  for (const checkpoint of observations.filter((item) => item.type === "daily_checkpoint")) {
    if (!markerHistory.has(checkpoint.payload.marker_digest) || checkpoint.payload.observation_prefix_digest !== checkpoint.previous_digest || checkpoint.payload.active_legacy_run_count !== 0) fail("ROLLOUT_MARKER_DRIFT", "historical checkpoint does not bind a committed vNext-only marker and immutable prefix");
  }
  const currentReceiptDigests = new Set(fs.readdirSync(opened.paths.terminalReceipts).map((name) => parseJson(secureRead(path.join(opened.paths.terminalReceipts, name), name), name)).filter((receipt) => receipt.marker_digest === marker.marker_digest).map((receipt) => receipt.receipt_digest));
  const knownRunIds = new Set(observations.filter((item) => item.type === "vnext_terminal_observed" && currentReceiptDigests.has(item.payload.receipt_digest)).map((item) => item.payload.run_id));
  const { receipts, pending } = terminalReceiptSet(opened, runsRoot, { observedAt: now, knownRunIds }), checkpoints = observations.filter((item) => item.type === "daily_checkpoint" && item.payload.marker_digest === marker.marker_digest);
  const boundary = observations.filter((item) => item.type === "legacy_inventory_observed" && item.payload.active_legacy_run_count === 0 && item.occurred_at <= marker.switched_at).at(-1);
  if (!boundary) fail("ACTIVE_LEGACY_AMBIGUITY", "active marker has no zero-inventory cutover boundary");
  let priorSequence = boundary.sequence, priorDate = null, consecutive = 0;
  for (const checkpoint of checkpoints) {
    if (checkpoint.payload.marker_digest !== marker.marker_digest || checkpoint.payload.inventory_identity_digest !== identity.identityDigest || checkpoint.payload.inventory_content_digest !== identity.contentDigest || checkpoint.payload.active_legacy_run_count !== 0) fail("ROLLOUT_MARKER_DRIFT", "checkpoint is not bound to the active marker and zero legacy inventory");
    if (priorDate) { const next = new Date(`${priorDate}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate() + 1); if (checkpoint.payload.date !== next.toISOString().slice(0, 10)) fail("ROLLOUT_CHECKPOINT_GAP", "checkpoint dates are discontinuous"); }
    const prefix = observations.filter((item) => item.sequence < checkpoint.sequence), activity = prefix.filter((item) => item.sequence > priorSequence && postCutoverLegacyActivity(item, marker));
    const terminals = prefix.filter((item) => item.type === "vnext_terminal_observed" && currentReceiptDigests.has(item.payload.receipt_digest)).map((item) => item.payload);
    if (checkpoint.payload.observation_prefix_digest !== checkpoint.previous_digest || checkpoint.payload.legacy_activity_count !== activity.length || checkpoint.payload.terminal_run_count !== terminals.length || checkpoint.payload.terminal_receipts_digest !== canonicalTerminalReceiptDigest(terminals)) fail("INVALID_ROLLOUT_CHECKPOINT", "checkpoint does not match its canonical observation prefix");
    consecutive = activity.length === 0 ? consecutive + 1 : 0; priorSequence = checkpoint.sequence; priorDate = checkpoint.payload.date;
  }
  const latest = checkpoints.at(-1), current = pending.length === 0 && latest && latest.sequence === observations.at(-1).sequence && latest.payload.date === now.slice(0, 10) && latest.payload.terminal_run_count === receipts.length && latest.payload.terminal_receipts_digest === canonicalTerminalReceiptDigest(receipts);
  const lastLegacyActivity = observations.filter((item) => postCutoverLegacyActivity(item, marker)).at(-1);
  const zeroLegacySince = lastLegacyActivity?.occurred_at || marker.switched_at;
  const zeroLegacyElapsedMs = latest ? Date.parse(latest.occurred_at) - Date.parse(zeroLegacySince) : 0;
  const elapsedGateSatisfied = zeroLegacyElapsedMs >= 30 * 24 * 60 * 60 * 1000;
  const localGateSatisfied = Boolean(current && consecutive >= 30 && elapsedGateSatisfied && receipts.length >= 30);
  const configured = configuredRolloutAnchor(opened);
  if (configured && (!configured.lineage || !configured.publicKeyBytes)) fail("ROLLOUT_ANCHOR_UNAVAILABLE", "external rollout anchor lineage and public key must be supplied together");
  const latestRoot = latest ? { observation: observations[latest.sequence - 1], seal: seals[latest.sequence - 1] } : null;
  const previousAnchorDigest = configured?.lineage?.anchors?.at(-1)?.anchor_digest || marker.quiescence_attestation_digest;
  const anchorRequest = rolloutAnchorRequest(opened, latestRoot, marker, previousAnchorDigest);
  const cleanCheckpoints = consecutive > 0 ? checkpoints.slice(-consecutive) : [];
  const externalAttestation = configured
    ? verifyRolloutAnchor(configured.lineage, configured.publicKeyBytes, opened, { observations, seals, checkpoints: cleanCheckpoints, marker, zeroLegacySince }, now)
    : cleanCheckpoints.length <= 1
      ? { status: "missing", required: true, anchor_request: anchorRequest }
      : { status: "missing", required: true, anchor_request: null, pending_reason: "daily_signature_prefix_missing" };
  const retireReady = localGateSatisfied && externalAttestation.status === "verified";
  return { schema_version: 1, repository_digest: opened.repositoryDigest, marker_digest: marker.marker_digest, consecutive_zero_legacy_days: consecutive, zero_legacy_since: zeroLegacySince, zero_legacy_elapsed_hours: Math.floor(Math.max(0, zeroLegacyElapsedMs) / 3_600_000), vnext_terminal_run_count: receipts.length, pending_terminal_runs: pending, checkpoint_current: Boolean(current), local_gate_satisfied: localGateSatisfied, external_attestation: externalAttestation, retire_ready: retireReady, blockers: [...(pending.length ? ["terminal_receipt_pending"] : !current ? ["checkpoint_not_current"] : []), ...(consecutive < 30 ? ["zero_legacy_days_below_30"] : []), ...(!elapsedGateSatisfied ? ["zero_legacy_elapsed_below_30_days"] : []), ...(receipts.length < 30 ? ["vnext_terminal_runs_below_30"] : []), ...(externalAttestation.status !== "verified" ? ["external_anchor_missing"] : [])] };
}

function operatorIdentity(repoArg) {
  const checkout = fs.realpathSync(path.resolve(repoArg || "."));
  const root = fs.realpathSync(execFileSync("git", ["-C", checkout, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  let remote;
  try { remote = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { remote = `local/${path.basename(root)}`; }
  const github = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  return { checkoutRoot: root, remote: github ? `${github[1]}/${github[2]}` : remote };
}

function runtimeGenerationUsage() {
  return [
    "Usage:",
    "  runtime-generation.js start [--repo <path>] --dry-run --actor <token> --operation-id <token> --quiescence-reason <text> --json",
    "  runtime-generation.js start [--repo <path>] --actor <token> --operation-id <token> --quiescence-reason <text> [--json]",
    "  runtime-generation.js checkpoint [--repo <path>] [--json]",
    "  runtime-generation.js status [--repo <path>] --json",
    "",
    "Inventory and counts are derived only from the canonical RELAY_RUNS_BASE repository directory.",
    "vNext-only cutover requires RELAY_QUIESCENCE_ATTESTATION_FILE: an externally signed exact quiescence envelope from a different-UID, non-writable authority path.",
    "Retirement requires a daily signed lineage in RELAY_ROLLOUT_ANCHOR_FILE plus RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE from that external authority.",
  ].join("\n");
}

function runtimeGenerationMain(argv = process.argv.slice(2)) {
  const command = argv.shift(), values = new Map(), booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (new Set(["--json", "--dry-run", "--help", "-h"]).has(flag)) { booleans.add(flag); continue; }
    if (!new Set(["--repo", "--actor", "--operation-id", "--quiescence-reason"]).has(flag) || argv[index + 1] === undefined) fail("INVALID_GENERATION_CLI", `unknown or incomplete flag ${flag}`);
    if (values.has(flag)) fail("INVALID_GENERATION_CLI", `duplicate flag ${flag}`);
    values.set(flag, argv[++index]);
  }
  if (!command || command === "--help" || booleans.has("--help") || booleans.has("-h")) { console.log(runtimeGenerationUsage()); return command ? 0 : 1; }
  if (!new Set(["start", "checkpoint", "status"]).has(command)) fail("INVALID_GENERATION_CLI", `unknown command ${command}`);
  if (command !== "start" && (values.has("--actor") || values.has("--operation-id") || values.has("--quiescence-reason"))) fail("INVALID_GENERATION_CLI", "actor, operation-id, and quiescence-reason are valid only for start");
  if (command !== "start" && booleans.has("--dry-run")) fail("INVALID_GENERATION_CLI", "dry-run is valid only for start");
  const startIdentityFlags = ["--actor", "--operation-id", "--quiescence-reason"];
  const suppliedIdentityFlags = startIdentityFlags.filter((flag) => values.has(flag));
  if (command === "start" && suppliedIdentityFlags.length > 0 && suppliedIdentityFlags.length !== startIdentityFlags.length) fail("INVALID_GENERATION_CLI", "start identity flags must include --actor, --operation-id, and --quiescence-reason together");
  const identity = operatorIdentity(values.get("--repo") || ".");
  if (command === "start" && booleans.has("--dry-run")) {
    const result = previewMigrationFromCanonicalInventory({
      ...identity,
      actor: values.get("--actor") || null,
      operationId: values.get("--operation-id") || null,
      quiescenceReason: values.get("--quiescence-reason") || null,
    });
    console.log(booleans.has("--json") ? JSON.stringify(result, null, 2) : `start dry-run: ${result.can_start ? "ready" : "blocked"}`);
    return result.can_start ? 0 : 2;
  }
  if (command === "start" && (!values.has("--actor") || !values.has("--operation-id") || !values.has("--quiescence-reason"))) fail("INVALID_GENERATION_CLI", "start requires explicit --actor, --operation-id, and --quiescence-reason after dry-run");
  const store = command === "start" ? initializeStore(identity) : peekStore(identity);
  if (!store) fail("ROLLOUT_UNAVAILABLE", "generation store is absent; run start after resolving legacy ambiguity");
  const result = command === "start"
    ? startMigrationFromCanonicalInventory({ store, actor: values.get("--actor"), operationId: values.get("--operation-id"), quiescenceReason: values.get("--quiescence-reason") })
    : command === "checkpoint" ? recordRolloutCheckpoint({ store }) : retirementStatus({ store });
  console.log(booleans.has("--json") ? JSON.stringify(result, null, 2) : `${command}: ${result.retire_ready === undefined ? "recorded" : result.retire_ready ? "ready" : "not ready"}`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = runtimeGenerationMain(); }
  catch (error) { console.error(`runtime-generation: ${error.code ? `${error.code}: ` : ""}${error.message}`); process.exitCode = 1; }
}

module.exports = {
  EVENT_TYPES,
  GENERATIONS,
  LEGACY_OVERLAY_READER_VERSION,
  SCHEMA_VERSION,
  STRATEGIES,
  ROLLOUT_TYPES,
  decideMigration,
  assertGenerationWrite,
  initializeStore,
  peekGeneration,
  peekStore,
  observeLegacyRead,
  readDecision,
  readDrainCompleted,
  readEvents,
  readGeneration,
  readLegacyRecoveryOverlay,
  recordLegacyRead,
  recordDrainCompleted,
  previewMigrationFromCanonicalInventory,
  readRolloutObservations,
  recordLegacyArtifactRead,
  recordLegacySurfaceInvocation,
  recordRolloutCheckpoint,
  repositoryRunsDirectory,
  retirementStatus,
  verifyRolloutAnchor,
  runtimeGenerationMain,
  startMigrationFromCanonicalInventory,
  resolveRepositoryState,
  rollbackToLegacy,
  switchGeneration,
  withGenerationAdmission,
};
