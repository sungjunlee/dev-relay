"use strict";

/** Repository-scoped migration decision, generation admission, and rollback store. */

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
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

function secureRead(filePath, label) {
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
  for (const [label, directoryPath] of Object.entries({ "generation-events": paths.events, "legacy-recovery-overlays": paths.overlays, "generation-transitions": paths.transitions })) {
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
  for (const [label, directoryPath] of Object.entries({
    "generation-events": storePaths.events,
    "legacy-recovery-overlays": storePaths.overlays,
    "generation-transitions": storePaths.transitions,
  })) {
    let stat;
    try { stat = fs.lstatSync(directoryPath); }
    catch (error) {
      if (error.code === "ENOENT") fail("INVALID_GENERATION_STORE", `existing generation store is missing ${label}`);
      throw error;
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

function removeStaleLock(lockPath) {
  const quarantine = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.renameSync(lockPath, quarantine);
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY"].includes(error.code)) return false;
    throw error;
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
    let lockStat;
    try {
      lockStat = fs.lstatSync(store.paths.lock);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) fail("UNTRUSTED_GENERATION_LOCK", "generation lock must be a real directory");
    const owner = parseJson(secureRead(path.join(store.paths.lock, "owner.json"), "generation lock owner"), "generation lock owner");
    const incomplete = !owner;
    if ((!incomplete && !processLive(owner.pid)) || (incomplete && Date.now() - lockStat.mtimeMs >= INCOMPLETE_LOCK_GRACE_MS)) {
      removeStaleLock(store.paths.lock);
      continue;
    }
    if (Date.now() - started >= timeoutMs) fail("GENERATION_ADMISSION_TIMEOUT", "timed out waiting for repository generation transaction");
    sleep(LOCK_WAIT_MS);
  }
}

function releaseRepositoryLock(store, lease) {
  const owner = parseJson(secureRead(path.join(store.paths.lock, "owner.json"), "generation lock owner"), "generation lock owner");
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

function validateMarker(value, store) {
  if (plainObject(value) && value.schema_version !== SCHEMA_VERSION) fail("UNSUPPORTED_GENERATION_SCHEMA", "generation marker schema is unsupported");
  exactKeys(value, ["schema_version", "repository_digest", "epoch", "writer_generation", "legacy_read_allowed", "switched_at", "decision_digest", "transition_operation_id", "transition_actor", "transition_receipt_digest", "transition_event_digest", "rollback_overlay_digest", "marker_digest"], "runtime generation marker");
  if (value.repository_digest !== store.repositoryDigest) fail("REPOSITORY_IDENTITY_MISMATCH", "generation marker belongs to another repository");
  integer(value.epoch, "runtime generation marker.epoch", { minimum: 1 });
  if (!GENERATIONS.has(value.writer_generation) || typeof value.legacy_read_allowed !== "boolean") fail("INVALID_GENERATION_ARTIFACT", "generation marker admission fields are invalid");
  if (value.writer_generation === "legacy" && !value.legacy_read_allowed) fail("INVALID_GENERATION_ARTIFACT", "legacy writer requires legacy reads");
  timestamp(value.switched_at, "runtime generation marker.switched_at");
  string(value.decision_digest, "runtime generation marker.decision_digest", SHA256_RE);
  for (const key of ["transition_operation_id", "transition_actor", "transition_receipt_digest", "transition_event_digest", "rollback_overlay_digest"]) {
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
  const { marker_digest: markerDigest, ...unsigned } = value;
  if (!SHA256_RE.test(markerDigest || "") || markerDigest !== digest(unsigned)) fail("INVALID_GENERATION_ARTIFACT", "runtime generation marker digest is invalid");
  return value;
}

function readGeneration(store) {
  const opened = openStore(store);
  const marker = parseJson(secureRead(opened.paths.generation, "runtime-generation.json"), "runtime-generation.json");
  if (!marker) return null;
  validateMarker(marker, opened);
  const decision = readDecision(opened);
  if (!decision || decision.decision_digest !== marker.decision_digest) fail("GENERATION_DECISION_MISSING", "generation marker has no matching decision");
  return marker;
}

function peekGeneration(store) {
  if (!store || typeof store !== "object") fail("INVALID_GENERATION_STORE", "store is required");
  const marker = parseJson(secureRead(store.paths.generation, "runtime-generation.json"), "runtime-generation.json");
  if (!marker) return null;
  validateMarker(marker, store);
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
    exactKeys(event.payload, ["from_generation", "to_generation", "epoch", "actor", "operation_id", "decision_digest", "legacy_read_allowed", "transition_receipt_digest", "rollback_overlay_digest"], "generation_switched payload");
    if (!GENERATIONS.has(event.payload.from_generation) || !GENERATIONS.has(event.payload.to_generation) || event.payload.from_generation === event.payload.to_generation) fail("INVALID_GENERATION_ARTIFACT", "generation switch is invalid");
    integer(event.payload.epoch, "generation_switched.epoch", { minimum: 2 });
    string(event.payload.actor, "generation_switched.actor", TOKEN_RE);
    string(event.payload.operation_id, "generation_switched.operation_id", TOKEN_RE);
    string(event.payload.decision_digest, "generation_switched.decision_digest", SHA256_RE);
    if (typeof event.payload.legacy_read_allowed !== "boolean") fail("INVALID_GENERATION_ARTIFACT", "generation_switched.legacy_read_allowed must be boolean");
    string(event.payload.transition_receipt_digest, "generation_switched.transition_receipt_digest", SHA256_RE);
    if (event.payload.rollback_overlay_digest !== null) string(event.payload.rollback_overlay_digest, "generation_switched.rollback_overlay_digest", SHA256_RE);
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

function decideMigration({ store, observation, fault = null }) {
  const opened = openStore(store);
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
  return withRepositoryLockSync(opened, () => {
    const written = writeImmutable(opened.paths.decision, Buffer.from(canonicalJson(decision)), { conflictCode: "MIGRATION_DECISION_CONFLICT", fault });
    const persisted = readDecision(opened);
    if (!readGeneration(opened)) {
      const initial = { schema_version: 1, repository_digest: opened.repositoryDigest, epoch: 1, writer_generation: "legacy", legacy_read_allowed: true, switched_at: decision.observed_at, decision_digest: decision.decision_digest, transition_operation_id: null, transition_actor: null, transition_receipt_digest: null, transition_event_digest: null, rollback_overlay_digest: null };
      const marker = validateMarker({ ...initial, marker_digest: digest(initial) }, opened);
      replaceAtomic(opened.paths.generation, Buffer.from(canonicalJson(marker)), { fault });
    }
    const event = appendEvent(opened, { type: "migration_decided", payload: { decision_digest: decision.decision_digest }, occurredAt: decision.observed_at, fault });
    return { decision: persisted, event, created: written.created };
  });
}

function recordDrainCompleted({ store, inventory, actor, operationId, fault = null }) {
  const opened = openStore(store);
  string(actor, "drain completion actor", TOKEN_RE);
  string(operationId, "drain completion operation id", TOKEN_RE);
  exactKeys(inventory, ["observed_at", "active_legacy_run_count", "oldest_active_legacy_age_hours"], "drain completion inventory");
  return withRepositoryLockSync(opened, () => {
    const decision = readDecision(opened);
    if (!decision || decision.strategy !== "drain_and_cutover") fail("LEGACY_DRAIN_NOT_REQUIRED", "the migration decision does not require a drain completion fact");
    const unsigned = { schema_version: 1, repository_digest: opened.repositoryDigest, decision_digest: decision.decision_digest, ...inventory, inventory_digest: inventoryDigest(inventory), actor, operation_id: operationId };
    const completed = assertDrainInventory(unsigned, opened, decision);
    const written = writeImmutable(opened.paths.drain, Buffer.from(canonicalJson(completed)), { conflictCode: "LEGACY_DRAIN_COMPLETION_CONFLICT", fault });
    const event = appendEvent(opened, { type: "legacy_drain_completed", payload: { inventory_digest: completed.inventory_digest, actor, operation_id: operationId, decision_digest: decision.decision_digest }, occurredAt: completed.observed_at, fault });
    return { inventory: readDrainCompleted(opened), event, created: written.created };
  });
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
  return appendEvent(opened, { type: "legacy_read_observed", payload: { observation_id: observationId, reader_version: readerVersion, surface, epoch: state.epoch }, occurredAt: observedAt, fault });
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
  exactKeys(value, ["schema_version", "repository_digest", "operation_id", "actor", "from_generation", "to_generation", "epoch", "switched_at", "decision_digest", "legacy_read_allowed", "rollback_overlay_digest", "receipt_digest"], "generation transition receipt");
  if (value.schema_version !== SCHEMA_VERSION || value.repository_digest !== store.repositoryDigest) fail("REPOSITORY_IDENTITY_MISMATCH", "transition receipt belongs to another repository");
  for (const key of ["operation_id", "actor"]) string(value[key], `transition receipt.${key}`, TOKEN_RE);
  if (!GENERATIONS.has(value.from_generation) || !GENERATIONS.has(value.to_generation) || value.from_generation === value.to_generation) fail("INVALID_GENERATION_ARTIFACT", "transition receipt generation is invalid");
  integer(value.epoch, "transition receipt.epoch", { minimum: 2 });
  timestamp(value.switched_at, "transition receipt.switched_at");
  string(value.decision_digest, "transition receipt.decision_digest", SHA256_RE);
  if (typeof value.legacy_read_allowed !== "boolean") fail("INVALID_GENERATION_ARTIFACT", "transition receipt legacy_read_allowed is invalid");
  if (value.rollback_overlay_digest !== null) string(value.rollback_overlay_digest, "transition receipt.rollback_overlay_digest", SHA256_RE);
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
  };
}

function receiptEventId(store, receipt) {
  return eventId("generation_switched", store.repositoryDigest, switchEventFor(receipt));
}

function pendingTransition(store, marker) {
  for (const receipt of readTransitionReceipts(store)) {
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
  };
  return validateMarker({ ...unsigned, marker_digest: digest(unsigned) }, store);
}

function commitTransition({ store, current, actor, operationId, switchedAt, toGeneration, legacyReadAllowed, rollbackOverlayDigest = null, beforeMarker = null, fault = null }) {
  string(actor, "generation transition actor", TOKEN_RE);
  string(operationId, "generation transition operation id", TOKEN_RE);
  timestamp(switchedAt, "generation transition timestamp");
  if (current.writer_generation === toGeneration && current.transition_operation_id !== null
    && (current.transition_operation_id !== operationId || current.transition_actor !== actor)) {
    fail("GENERATION_TRANSITION_CONFLICT", "generation is active under another actor or operation identity");
  }
  const pending = pendingTransition(store, current);
  if (pending && (pending.operation_id !== operationId || pending.actor !== actor)) fail("GENERATION_TRANSITION_PENDING", "another transition has a durable pending receipt");
  const targetEpoch = current.writer_generation === toGeneration ? current.epoch : current.epoch + 1;
  const base = { schema_version: 1, repository_digest: store.repositoryDigest, operation_id: operationId, actor, from_generation: current.writer_generation === toGeneration ? (toGeneration === "vnext" ? "legacy" : "vnext") : current.writer_generation, to_generation: toGeneration, epoch: targetEpoch, switched_at: switchedAt, decision_digest: current.decision_digest, legacy_read_allowed: legacyReadAllowed, rollback_overlay_digest: rollbackOverlayDigest };
  const receipt = validateTransitionReceipt({ ...base, receipt_digest: digest(base) }, store);
  const receiptWrite = writeImmutable(transitionReceiptPath(store, operationId), Buffer.from(canonicalJson(receipt)), { conflictCode: "GENERATION_TRANSITION_CONFLICT", fault });
  const prepared = beforeMarker ? beforeMarker(receipt) : null;
  const marker = buildMarker(store, receipt);
  if (current.writer_generation === toGeneration) {
    if (current.transition_operation_id !== operationId || current.transition_actor !== actor || current.transition_receipt_digest !== receipt.receipt_digest || current.transition_event_digest !== marker.transition_event_digest || current.rollback_overlay_digest !== rollbackOverlayDigest) fail("GENERATION_TRANSITION_CONFLICT", "generation is active under another transition contract");
  } else {
    replaceAtomic(store.paths.generation, Buffer.from(canonicalJson(marker)), { fault });
  }
  const event = appendEvent(store, { type: "generation_switched", payload: switchEventFor(receipt), occurredAt: switchedAt, fault });
  return { marker: readGeneration(store), event, receipt, prepared, changed: receiptWrite.created && current.writer_generation !== toGeneration };
}

function switchGeneration({ store, generation, actor, operationId, switchedAt, drainInventoryDigest = null, fault = null }) {
  const opened = openStore(store);
  if (generation !== "vnext") fail("ROLLBACK_REQUIRES_OVERLAY", "use rollbackToLegacy to activate legacy writes");
  return withRepositoryLockSync(opened, () => {
    const decision = readDecision(opened);
    const current = readGeneration(opened);
    if (!decision || !current) fail("GENERATION_DECISION_MISSING", "migration decision and initial marker are required");
    if (decision.strategy === "drain_and_cutover") {
      string(drainInventoryDigest, "drain inventory digest", SHA256_RE);
      const drain = readDrainCompleted(opened);
      if (!drain || drain.inventory_digest !== drainInventoryDigest || drain.active_legacy_run_count !== 0 || drain.observed_at <= decision.observed_at) fail("LEGACY_DRAIN_INCOMPLETE", "vNext switch requires the exact fresh zero drain inventory digest");
    } else if (drainInventoryDigest !== null) {
      fail("INVALID_GENERATION_ARTIFACT", "dual-read transition must not supply a drain inventory digest");
    }
    return commitTransition({ store: opened, current, actor, operationId, switchedAt, toGeneration: "vnext", legacyReadAllowed: decision.strategy === "dual_read_vnext_write", fault });
  });
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

module.exports = {
  EVENT_TYPES,
  GENERATIONS,
  LEGACY_OVERLAY_READER_VERSION,
  SCHEMA_VERSION,
  STRATEGIES,
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
  resolveRepositoryState,
  rollbackToLegacy,
  switchGeneration,
  withGenerationAdmission,
};
