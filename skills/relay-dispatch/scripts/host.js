"use strict";

/**
 * Shadow-only vNext host and exclusion contract.
 *
 * It intentionally imports no legacy manifest, lease, or event module. Facts
 * integrate through an audit callback that receives an unforgeable lock
 * capability while ownership is still exclusive.
 */

const { execFileSync, spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LOCK_FILENAME = "ownership";
const OWNER_FILE_RE = /^(\d{12})\.owner\.json$/;
const MIN_BREAK_PROBE_INTERVAL_MS = 10_000;
const HOST_KINDS = new Set(["local_supervisor", "ci", "codex_app"]);
const TERMINAL_HOST_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out", "spawn_error"]);
const ATTEMPT_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/;
const GIT_IDENTITY_TIMEOUT_MS = 10_000;
const GIT_CONTENT_TIMEOUT_MS = 30_000;
const PROCESS_IDENTITY_PROBE_TIMEOUT_MS = 5_000;

const issuedLocks = new WeakSet();
const lockStates = new WeakMap();
const issuedInspections = new WeakSet();
const inspectionStates = new WeakMap();
const issuedWorktreeFacts = new WeakSet();
const worktreeFactStates = new WeakMap();
const issuedBreakProofs = new WeakSet();
const breakProofStates = new WeakMap();
const issuedReceipts = new WeakSet();
const receiptStates = new WeakMap();
const issuedMeasurements = new WeakSet();
const issuedSurvivalOutcomes = new WeakSet();

class HostError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "HostError";
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(message, code, details) {
  throw new HostError(message, code, details);
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function resultAuthKey(owner) {
  return crypto.createHmac("sha256", owner.token)
    .update(`relay-host-result\0${owner.lock_id}\0${owner.attempt_id}`)
    .digest("hex");
}

function signResult(result, key) {
  return crypto.createHmac("sha256", key).update(JSON.stringify(result)).digest("hex");
}

function readSecureJsonArtifact(filePath, label) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    const pathStat = fs.lstatSync(filePath);
    if (
      !stat.isFile()
      || pathStat.isSymbolicLink()
      || stat.dev !== pathStat.dev
      || stat.ino !== pathStat.ino
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o077) !== 0
    ) {
      fail(`${label} is not a trusted owner-only regular file`, "UNTRUSTED_HOST_ARTIFACT", {
        artifactPath: filePath,
      });
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function verifySignedArtifact(record, signatureField, key) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const { [signatureField]: signature, ...unsigned } = record;
  const expected = signResult(unsigned, key);
  return typeof signature === "string"
    && signature.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}


function isContained(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function requireDirectory(directory, label) {
  if (typeof directory !== "string" || !directory.trim()) fail(`${label} is required`, "INVALID_PATH");
  const resolved = path.resolve(directory);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    fail(`${label} does not exist: ${resolved}`, "INVALID_PATH", { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory: ${resolved}`, "UNTRUSTED_PATH");
  const real = fs.realpathSync(resolved);
  if (real !== resolved) fail(`${label} must use its canonical real path: ${resolved}`, "UNTRUSTED_PATH");
  return real;
}

function nearestExistingParent(candidate) {
  let current = candidate;
  while (true) {
    try {
      return fs.realpathSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function containedPath(root, candidate, label, { mustExist = false, file = true, directChild = false } = {}) {
  if (typeof candidate !== "string" || !candidate.trim()) fail(`${label} is required`, "INVALID_PATH");
  const canonicalRoot = requireDirectory(root, `${label} root`);
  const resolved = path.resolve(candidate);
  if (!isContained(canonicalRoot, resolved)) fail(`${label} escapes trusted root`, "UNTRUSTED_PATH", { path: resolved });
  if (directChild && path.dirname(resolved) !== canonicalRoot) {
    fail(`${label} must be a direct child of its trusted root`, "UNTRUSTED_PATH", { path: resolved });
  }
  const relative = path.relative(canonicalRoot, resolved);
  let cursor = canonicalRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        fail(`${label} contains a symlink component`, "UNTRUSTED_PATH", { path: cursor });
      }
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) fail(`${label} must not be a symlink`, "UNTRUSTED_PATH", { path: resolved });
    if (file && !stat.isFile()) fail(`${label} must be a regular file`, "UNTRUSTED_PATH", { path: resolved });
    if (!file && !stat.isDirectory()) fail(`${label} must be a directory`, "UNTRUSTED_PATH", { path: resolved });
    const real = fs.realpathSync(resolved);
    if (!isContained(canonicalRoot, real)) fail(`${label} real path escapes trusted root`, "UNTRUSTED_PATH", { path: resolved });
    return real;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (mustExist) fail(`${label} does not exist`, "INVALID_PATH", { path: resolved });
    const realParent = nearestExistingParent(path.dirname(resolved));
    if (!isContained(canonicalRoot, realParent)) fail(`${label} parent escapes trusted root`, "UNTRUSTED_PATH", { path: resolved });
    return path.join(realParent, path.basename(resolved));
  }
}

function safeAttemptId(attemptId) {
  if (typeof attemptId !== "string" || !ATTEMPT_ID_RE.test(attemptId)) {
    fail("attemptId must contain only bounded alphanumeric, underscore, or hyphen characters", "INVALID_ATTEMPT_ID");
  }
  return attemptId;
}

function syncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes(error?.code)) throw error;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function atomicWriteFile(target, content, { mode = 0o600, fault } = {}) {
  const directory = path.dirname(target);
  const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fault?.("after_file_fsync");
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
    syncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function processFingerprint(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") return null;
  try {
    const value = execFileSync("/bin/ps", [
      "-p", String(pid),
      "-o", "ppid=",
      "-o", "pgid=",
      "-o", "state=",
      "-o", "lstart=",
      "-o", "comm=",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: PROCESS_IDENTITY_PROBE_TIMEOUT_MS,
    }).trim();
    const match = value.match(
      /^(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/,
    );
    if (!match) return null;
    const parsed = Date.parse(match[4].replace(/\s+/g, " "));
    if (!Number.isFinite(parsed)) return null;
    const command = match[5].trim();
    return Object.freeze({
      pid,
      ppid: Number(match[1]),
      pgid: Number(match[2]),
      state: match[3],
      started_at: new Date(parsed).toISOString(),
      command_sha256: sha256(command),
      command_terminalized: /^\(.+\)$/.test(command),
    });
  } catch {
    return null;
  }
}

function processStartAt(pid) {
  return processFingerprint(pid)?.started_at || null;
}

function bootIdentity() {
  try {
    if (process.platform === "linux") {
      return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    }
    if (process.platform === "darwin") {
      return sha256(execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim());
    }
  } catch {}
  return null;
}

function captureLocalProcessIdentity(pid = process.pid) {
  const processFingerprintValue = processFingerprint(pid);
  return {
    host: os.hostname(),
    pid,
    process_started_at: processFingerprintValue?.started_at || null,
    process_fingerprint: processFingerprintValue,
    boot_id: bootIdentity(),
  };
}

function fingerprintsEqual(left, right) {
  return Boolean(
    left
    && right
    && left.pid === right.pid
    && left.pgid === right.pgid
    && left.started_at === right.started_at
  );
}

function waitForFingerprint(pid, timeoutMs = PROCESS_IDENTITY_PROBE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    const fingerprint = processFingerprint(pid);
    if (fingerprint) return fingerprint;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return null;
    }
    Atomics.wait(waiter, 0, 0, 25);
  }
  return null;
}

function probeLocalProcess(owner) {
  if (owner.host !== os.hostname()) return { status: "unknown", reason: "foreign_host" };
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return { status: "unknown", reason: "missing_pid" };
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return { status: "dead", reason: "pid_missing", identity_matches: false };
    if (error.code !== "EPERM") return { status: "unknown", reason: "pid_probe_failed" };
  }
  const fingerprint = processFingerprint(owner.pid);
  if (owner.process_fingerprint) {
    if (!fingerprint) return { status: "unknown", reason: "process_fingerprint_unavailable" };
    if (!fingerprintsEqual(fingerprint, owner.process_fingerprint)) {
      return { status: "dead", reason: "pid_reused", identity_matches: false, process_fingerprint: fingerprint };
    }
    return { status: "live", identity_matches: true, process_fingerprint: fingerprint };
  }
  const startedAt = fingerprint?.started_at || null;
  if (!startedAt || !owner.process_started_at) return { status: "unknown", reason: "process_start_unavailable" };
  if (startedAt !== owner.process_started_at) {
    return { status: "dead", reason: "pid_reused", identity_matches: false, process_started_at: startedAt };
  }
  return { status: "live", identity_matches: true, process_started_at: startedAt };
}

function probeProcessIdentity({
  pid,
  processStartedAt: expectedStart,
  processFingerprint: expectedFingerprint,
}) {
  if (!Number.isInteger(pid) || pid <= 0) return { status: "unknown", reason: "missing_pid" };
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return { status: "dead", reason: "pid_missing", identity_matches: false };
    if (error.code !== "EPERM") return { status: "unknown", reason: "pid_probe_failed" };
  }
  const observedFingerprint = processFingerprint(pid);
  if (expectedFingerprint) {
    if (!observedFingerprint) return { status: "unknown", reason: "process_fingerprint_unavailable" };
    if (!fingerprintsEqual(observedFingerprint, expectedFingerprint)) {
      return {
        status: "dead",
        reason: "pid_reused",
        identity_matches: false,
        process_fingerprint: observedFingerprint,
      };
    }
    return { status: "live", identity_matches: true, process_fingerprint: observedFingerprint };
  }
  const observedStart = observedFingerprint?.started_at || null;
  if (!observedStart || !expectedStart) return { status: "unknown", reason: "process_start_unavailable" };
  if (observedStart !== expectedStart) {
    return { status: "dead", reason: "pid_reused", identity_matches: false, process_started_at: observedStart };
  }
  return { status: "live", identity_matches: true, process_started_at: observedStart };
}

function probeExecutorArtifact(owner, runDir) {
  const executorPath = path.join(runDir, `host-attempt-${owner.attempt_id}.executor.json`);
  let executor;
  try {
    executor = readSecureJsonArtifact(executorPath, "executor identity artifact");
  } catch (error) {
    return {
      status: "unknown",
      reason: error.code === "ENOENT" ? "executor_identity_missing" : "executor_identity_unreadable",
    };
  }
  if (
    executor.attempt_id !== owner.attempt_id
    || executor.host_kind !== owner.host_kind
    || executor.host_handle !== owner.host_handle
    || executor.executor_pgid !== executor.executor_pid
    || typeof executor.executor_nonce !== "string"
    || executor.executor_nonce.length < 32
    || !executor.executor_fingerprint
    || executor.executor_fingerprint.pid !== executor.executor_pid
    || executor.executor_fingerprint.pgid !== executor.executor_pgid
    || !verifySignedArtifact(executor, "executor_auth_sha256", resultAuthKey(owner))
  ) {
    return { status: "unknown", reason: "executor_identity_unauthenticated" };
  }
  const probe = probeProcessIdentity({
    pid: executor.executor_pid,
    processStartedAt: executor.executor_started_at,
    processFingerprint: executor.executor_fingerprint,
  });
  if (probe.status === "live") return { ...probe, reason: "detached_executor_identity" };
  return probe;
}

function probeDurableHost(owner, runDir) {
  if (owner.host_kind !== "local_supervisor") return { status: "unknown", reason: "unsupported_host_kind" };
  if (owner.host !== os.hostname()) return { status: "unknown", reason: "foreign_host" };
  if (runDir) {
    const readyPath = path.join(runDir, `host-attempt-${owner.attempt_id}.ready.json`);
    try {
      const ready = readSecureJsonArtifact(readyPath, "supervisor ready artifact");
      if (
        ready.attempt_id !== owner.attempt_id
        || ready.host_kind !== owner.host_kind
        || ready.host_handle !== owner.host_handle
      ) {
        return { status: "unknown", reason: "supervisor_identity_mismatch" };
      }
      if (!verifySignedArtifact(ready, "ready_auth_sha256", resultAuthKey(owner))) {
        return { status: "unknown", reason: "supervisor_identity_unauthenticated" };
      }
      const supervisor = probeProcessIdentity({
        pid: ready.supervisor_pid,
        processStartedAt: ready.supervisor_started_at,
        processFingerprint: ready.supervisor_fingerprint,
      });
      if (supervisor.status === "live" || supervisor.status === "unknown") {
        return { ...supervisor, reason: "detached_supervisor_identity" };
      }
      const executorProbe = probeExecutorArtifact(owner, runDir);
      if (executorProbe.status === "live") {
        return executorProbe;
      }
      if (executorProbe.status === "unknown") return executorProbe;
      return {
        status: "dead",
        identity_matches: false,
        reason: "detached_supervisor_and_executor_dead",
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        return { status: "unknown", reason: "supervisor_identity_unreadable" };
      }
      const launchClaimPath = path.join(runDir, `host-attempt-${owner.attempt_id}.launch-claim`);
      if (fs.existsSync(launchClaimPath)) {
        const executorProbe = probeExecutorArtifact(owner, runDir);
        if (executorProbe.status !== "unknown" || executorProbe.reason !== "executor_identity_missing") {
          return executorProbe;
        }
        return { status: "unknown", reason: "ready_artifact_missing_after_launch" };
      }
    }
  }
  return probeLocalProcess(owner);
}

function lockPathFor(runDir) {
  const observed = readOwner(runDir);
  return observed.exists
    ? observed.lockPath
    : path.join(ownershipDirectory(runDir), "none.owner.json");
}

function normalizeOwner(owner) {
  const stringFields = ["lock_id", "token", "attempt_id", "operation", "host", "host_kind", "host_handle", "acquired_at", "worktree_dir"];
  for (const field of stringFields) {
    if (typeof owner?.[field] !== "string" || !owner[field]) fail(`lock owner ${field} is required`, "INVALID_LOCK_OWNER");
  }
  safeAttemptId(owner.attempt_id);
  if (!HOST_KINDS.has(owner.host_kind)) fail("lock owner host_kind is invalid", "INVALID_LOCK_OWNER");
  if (owner.pid !== null && (!Number.isInteger(owner.pid) || owner.pid <= 0)) fail("lock owner pid is invalid", "INVALID_LOCK_OWNER");
  if (owner.process_started_at !== null && Number.isNaN(Date.parse(owner.process_started_at))) {
    fail("lock owner process_started_at is invalid", "INVALID_LOCK_OWNER");
  }
  if (Number.isNaN(Date.parse(owner.acquired_at))) fail("lock owner acquired_at is invalid", "INVALID_LOCK_OWNER");
  if (!Number.isInteger(owner.worktree_dev) || !Number.isInteger(owner.worktree_ino)) {
    fail("lock owner worktree identity is invalid", "INVALID_LOCK_OWNER");
  }
  if (!Number.isInteger(owner.generation) || owner.generation <= 0) {
    fail("lock owner generation is invalid", "INVALID_LOCK_OWNER");
  }
  if (owner.process_fingerprint) {
    const fingerprint = owner.process_fingerprint;
    if (
      fingerprint.pid !== owner.pid
      || !Number.isInteger(fingerprint.ppid)
      || !Number.isInteger(fingerprint.pgid)
      || fingerprint.started_at !== owner.process_started_at
      || typeof fingerprint.command_sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(fingerprint.command_sha256)
    ) fail("lock owner process fingerprint is invalid", "INVALID_LOCK_OWNER");
  }
  return owner;
}

function ownershipDirectory(runDir) {
  const canonicalRunDir = requireDirectory(runDir, "runDir");
  const directory = path.join(canonicalRunDir, LOCK_FILENAME);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    syncDirectory(canonicalRunDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    fail("ownership ledger must be an owner-only real directory", "LOCK_LEDGER_INVALID", { directory });
  }
  return directory;
}

function generationBase(generation) {
  return String(generation).padStart(12, "0");
}

function immutablePublish(target, record) {
  const directory = path.dirname(target);
  const tmp = path.join(
    directory,
    `.${path.basename(target)}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`,
  );
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(tmp, target);
    syncDirectory(directory);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    fail("immutable ownership artifact publication failed", "LOCK_STORAGE_FAILED", {
      target,
      cause: error,
    });
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function hasValidTerminalMarker(markerPath, owner, outcome) {
  if (!fs.existsSync(markerPath)) return false;
  let marker;
  try {
    marker = readSecureJsonArtifact(markerPath, `${outcome} ownership marker`);
  } catch (error) {
    fail("ownership terminal marker is unreadable", "LOCK_LEDGER_INVALID", {
      markerPath,
      cause: error,
    });
  }
  if (
    marker.generation !== owner.generation
    || marker.lock_id !== owner.lock_id
    || marker.outcome !== outcome
    || !verifySignedArtifact(marker, "marker_auth_sha256", resultAuthKey(owner))
  ) {
    fail("ownership terminal marker is unauthenticated", "LOCK_LEDGER_INVALID", { markerPath });
  }
  return true;
}

function terminalMarkerRecord(markerPath, owner) {
  if (!fs.existsSync(markerPath)) return null;
  const marker = readSecureJsonArtifact(markerPath, "ownership terminal marker");
  if (!["released", "broken"].includes(marker.outcome)) {
    fail("ownership terminal marker outcome is invalid", "LOCK_LEDGER_INVALID", { markerPath });
  }
  hasValidTerminalMarker(markerPath, owner, marker.outcome);
  return marker;
}

function hasValidTerminalAudit(markerPath, owner, terminal) {
  if (!fs.existsSync(markerPath)) return false;
  const marker = readSecureJsonArtifact(markerPath, "ownership terminal audit marker");
  if (
    marker.generation !== owner.generation
    || marker.lock_id !== owner.lock_id
    || marker.outcome !== terminal.outcome
    || marker.terminal_sha256 !== sha256(JSON.stringify(terminal))
    || marker.audit_key !== terminalAuditKey(owner, terminal)
    || !verifySignedArtifact(marker, "marker_auth_sha256", resultAuthKey(owner))
  ) {
    fail("ownership terminal audit marker is unauthenticated", "LOCK_LEDGER_INVALID", {
      markerPath,
    });
  }
  return true;
}

function terminalAuditKey(owner, terminal) {
  if (terminal.reason === "acquisition_audit_failed") {
    return sha256(`acquisition_failure_recorded\0${owner.lock_id}`);
  }
  const auditOutcome = terminal.outcome === "broken"
    ? "broken"
    : terminal.release_outcome || "released";
  return auditFragment("lock_released", owner, auditOutcome).audit_key;
}

function signedTerminalRecord(owner, unsigned) {
  return {
    ...unsigned,
    marker_auth_sha256: signResult(unsigned, resultAuthKey(owner)),
  };
}

function terminalDecisionMatches(existing, requested) {
  if (
    existing.generation !== requested.generation
    || existing.lock_id !== requested.lock_id
    || existing.outcome !== requested.outcome
  ) return false;
  if (requested.outcome === "released") {
    return (
      existing.release_outcome === requested.release_outcome
      && existing.audit_required === requested.audit_required
    );
  }
  return (
    existing.attempt_id === requested.attempt_id
    && existing.reason === requested.reason
    && existing.evidence_digest === requested.evidence_digest
    && existing.worktree_digest === requested.worktree_digest
    && existing.audit_required === requested.audit_required
  );
}

function publishTerminalDecision(markerPath, owner, unsigned) {
  const requested = signedTerminalRecord(owner, unsigned);
  if (immutablePublish(markerPath, requested)) {
    return { record: requested, published: true };
  }
  const existing = terminalMarkerRecord(markerPath, owner);
  if (!terminalDecisionMatches(existing, requested)) {
    fail("conflicting terminal decision already exists", "LOCK_CHANGED", { markerPath });
  }
  return { record: existing, published: false };
}

function publishTerminalAudit(markerPath, owner, terminal, metadata = {}) {
  const unsigned = {
    generation: owner.generation,
    lock_id: owner.lock_id,
    outcome: terminal.outcome,
    terminal_sha256: sha256(JSON.stringify(terminal)),
    audit_key: terminalAuditKey(owner, terminal),
    ...metadata,
    audit_completed_at: new Date().toISOString(),
  };
  const requested = signedTerminalRecord(owner, unsigned);
  if (immutablePublish(markerPath, requested)) return { record: requested, published: true };
  if (!hasValidTerminalAudit(markerPath, owner, terminal)) {
    fail("terminal audit marker conflicts with the elected decision", "LOCK_CHANGED", {
      markerPath,
    });
  }
  return {
    record: readSecureJsonArtifact(markerPath, "ownership terminal audit marker"),
    published: false,
  };
}

function ledgerSnapshot(runDir) {
  const directory = ownershipDirectory(runDir);
  const ownerNames = fs.readdirSync(directory)
    .filter((name) => OWNER_FILE_RE.test(name))
    .sort();
  const entries = ownerNames.map((name) => {
    const generation = Number(name.match(OWNER_FILE_RE)[1]);
    const ownerPath = path.join(directory, name);
    const base = generationBase(generation);
    const ownerFd = fs.openSync(ownerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let raw;
    try {
      const ownerStat = fs.fstatSync(ownerFd);
      const pathStat = fs.lstatSync(ownerPath);
      if (
        !ownerStat.isFile()
        || pathStat.isSymbolicLink()
        || ownerStat.dev !== pathStat.dev
        || ownerStat.ino !== pathStat.ino
        || (typeof process.getuid === "function" && ownerStat.uid !== process.getuid())
        || (ownerStat.mode & 0o077) !== 0
      ) {
        fail("ownership candidate is not a trusted owner-only regular file", "LOCK_LEDGER_INVALID", {
          ownerPath,
        });
      }
      raw = fs.readFileSync(ownerFd);
    } finally {
      fs.closeSync(ownerFd);
    }
    const owner = normalizeOwner(JSON.parse(raw.toString("utf8")));
    if (owner.generation !== generation) {
      fail("owner generation does not match its immutable path", "LOCK_LEDGER_INVALID");
    }
    const entry = {
      generation,
      ownerPath,
      owner,
      raw,
      terminalPath: path.join(directory, `${base}.terminal.json`),
      terminalAuditPath: path.join(directory, `${base}.terminal-audit.json`),
      releasedPath: path.join(directory, `${base}.released.json`),
      brokenPath: path.join(directory, `${base}.broken.json`),
    };
    entry.released = hasValidTerminalMarker(entry.releasedPath, owner, "released");
    entry.broken = hasValidTerminalMarker(entry.brokenPath, owner, "broken");
    entry.terminal = terminalMarkerRecord(entry.terminalPath, owner);
    entry.terminalAudit = entry.terminal
      ? hasValidTerminalAudit(entry.terminalAuditPath, owner, entry.terminal)
      : false;
    if (!entry.terminal && fs.existsSync(entry.terminalAuditPath)) {
      fail("terminal audit marker exists without a terminal decision", "LOCK_LEDGER_INVALID");
    }
    const terminalCount = Number(entry.released) + Number(entry.broken) + Number(Boolean(entry.terminal));
    if (terminalCount > 1) {
      fail("ownership generation has conflicting terminal markers", "LEDGER_TERMINAL_CONFLICT", {
        generation,
      });
    }
    return entry;
  });
  const unresolved = entries.filter(
    (entry) => !entry.released && !entry.broken && !(entry.terminal && entry.terminalAudit),
  );
  if (unresolved.length > 1) {
    fail("ownership ledger has multiple unresolved generations", "LOCK_LEDGER_INVALID", {
      generations: unresolved.map((entry) => entry.generation),
    });
  }
  return {
    directory,
    entries,
    active: unresolved[0] || null,
    nextGeneration: (entries.at(-1)?.generation || 0) + 1,
  };
}

function readOwner(runDir) {
  let snapshot;
  try {
    snapshot = ledgerSnapshot(runDir);
    if (!snapshot.active) {
      return {
        exists: false,
        lockPath: path.join(snapshot.directory, "none.owner.json"),
        owner: null,
        raw: null,
      };
    }
    return {
      exists: true,
      lockPath: snapshot.active.ownerPath,
      raw: snapshot.active.raw,
      owner: snapshot.active.owner,
      generation: snapshot.active.generation,
      releasedPath: snapshot.active.releasedPath,
      brokenPath: snapshot.active.brokenPath,
      terminalPath: snapshot.active.terminalPath,
      terminalAuditPath: snapshot.active.terminalAuditPath,
    };
  } catch (error) {
    return {
      exists: true,
      lockPath: snapshot?.active?.ownerPath || path.join(ownershipDirectory(runDir), "invalid.owner.json"),
      owner: null,
      raw: null,
      error,
    };
  }
}

function readOwnerPublic(runDir) {
  const observed = readOwner(runDir);
  return Object.freeze({
    exists: observed.exists,
    lockPath: observed.lockPath,
    owner: observed.owner ? Object.freeze({
      ...observed.owner,
      token: undefined,
      break_transaction: undefined,
    }) : null,
    error: observed.error,
  });
}

function auditFragment(type, owner, outcome) {
  return Object.freeze({
    audit_key: sha256(`${type}\0${owner.lock_id}\0${outcome || ""}`),
    type,
    attempt_id: owner.attempt_id,
    payload: Object.freeze(type === "lock_acquired" ? {
      lock_id: owner.lock_id,
      operation: owner.operation,
      host: owner.host,
      pid: owner.pid,
      process_started_at: owner.process_started_at,
    } : {
      lock_id: owner.lock_id,
      operation: owner.operation,
      outcome,
    }),
  });
}

function emitAudit(audit, type, state, outcome) {
  const fragment = auditFragment(type, state.owner, outcome);
  if (typeof audit === "function") return audit(fragment, state.capability);
  return undefined;
}

function ensureCanonicalBreakAudit(state, outcome) {
  const factsApi = require("./facts");
  const eventsPath = containedPath(
    state.runDir,
    path.join(state.runDir, "events.jsonl"),
    "break audit journal",
    { mustExist: true, directChild: true },
  );
  const journal = factsApi.readFacts({ eventsPath }).facts;
  const runIds = new Set(journal.map((fact) => fact.run_id).filter(Boolean));
  if (runIds.size !== 1) fail("break audit journal has no unique run identity", "LOCK_AUDIT_REQUIRED");
  const audit = auditFragment("lock_released", state.owner, outcome);
  const eventId = `host-${audit.audit_key}`;
  const existing = journal.find((fact) => fact.event_id === eventId);
  if (existing) {
    if (
      existing.type !== "lock_released"
      || existing.attempt_id !== state.owner.attempt_id
      || existing.payload?.lock_id !== state.owner.lock_id
      || existing.payload?.outcome !== outcome
    ) fail("deterministic break audit event conflicts with canonical journal", "LOCK_AUDIT_REQUIRED");
    return { durable: true, audit_key: audit.audit_key };
  }
  factsApi.appendFact({
    eventsPath,
    lockContext: state.capability,
    fact: factsApi.factFromHostAudit({
      runId: [...runIds][0],
      eventId,
      at: state.terminalDecision?.broken_at || state.owner.acquired_at,
      actor: "relay-host",
      audit,
    }),
  });
  return { durable: true, audit_key: audit.audit_key };
}

function acquireRunLock({
  runDir,
  attemptId,
  operation,
  host = os.hostname(),
  hostKind = "local_supervisor",
  hostHandle,
  pid = process.pid,
  processStartedAt,
  worktreeDir = process.cwd(),
  audit,
  fault,
} = {}) {
  const canonicalRunDir = requireDirectory(runDir, "runDir");
  const canonicalWorktree = requireDirectory(worktreeDir, "worktreeDir");
  const worktreeStat = fs.statSync(canonicalWorktree);
  safeAttemptId(attemptId);
  if (typeof operation !== "string" || !operation.trim()) fail("operation is required", "INVALID_OPERATION");
  if (!HOST_KINDS.has(hostKind)) fail("hostKind is invalid", "INVALID_HOST_KIND");
  const observedFingerprint = processStartedAt === undefined && pid
    ? processFingerprint(pid)
    : null;
  const effectiveProcessStartedAt = processStartedAt === undefined
    ? observedFingerprint?.started_at || null
    : processStartedAt;
  if (hostKind === "local_supervisor" && pid && !effectiveProcessStartedAt) {
    fail("kernel-stable owner identity is unavailable", "HOST_IDENTITY_UNAVAILABLE", {
      pid,
      recommended_action: "inspect",
    });
  }
  const effectiveHandle = hostHandle || (
    hostKind === "local_supervisor" && process.platform === "darwin"
      ? `dev.relay.host.${process.pid}.${crypto.randomBytes(8).toString("hex")}`
      : `${host}:${crypto.randomUUID()}`
  );
  let owner;
  let lockPath;
  while (true) {
    const snapshot = ledgerSnapshot(canonicalRunDir);
    if (snapshot.active) {
      fail(`run lock is already held: ${snapshot.active.ownerPath}`, "LOCK_HELD", {
        lockPath: snapshot.active.ownerPath,
      });
    }
    const generation = snapshot.nextGeneration;
    lockPath = path.join(snapshot.directory, `${generationBase(generation)}.owner.json`);
    owner = normalizeOwner({
      generation,
      lock_id: crypto.randomUUID(),
      token: crypto.randomBytes(32).toString("hex"),
      attempt_id: attemptId,
      operation,
      host,
      host_kind: hostKind,
      host_handle: effectiveHandle,
      pid: pid ?? null,
      process_started_at: effectiveProcessStartedAt,
      process_fingerprint: observedFingerprint,
      acquired_at: new Date().toISOString(),
      worktree_dir: canonicalWorktree,
      worktree_dev: worktreeStat.dev,
      worktree_ino: worktreeStat.ino,
    });
    if (immutablePublish(lockPath, owner)) break;
  }
  const fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const inode = fs.fstatSync(fd);
  const capability = Object.freeze({
    lock_id: owner.lock_id,
    attempt_id: owner.attempt_id,
    operation: owner.operation,
    run_dir: canonicalRunDir,
    host_kind: owner.host_kind,
    host_handle: owner.host_handle,
  });
  const state = {
    capability,
    runDir: canonicalRunDir,
    lockPath,
    fd,
    inode: { dev: inode.dev, ino: inode.ino },
    owner,
    released: false,
  };
  issuedLocks.add(capability);
  lockStates.set(capability, state);
  fault?.("after_lock_fsync");
  try {
    emitAudit(audit, "lock_acquired", state);
  } catch (error) {
    const markerPath = path.join(path.dirname(lockPath), `${generationBase(owner.generation)}.terminal.json`);
    const auditMarkerPath = path.join(path.dirname(lockPath), `${generationBase(owner.generation)}.terminal-audit.json`);
    const unsignedMarker = {
      generation: owner.generation,
      lock_id: owner.lock_id,
      outcome: "broken",
      reason: "acquisition_audit_failed",
      audit_required: false,
      at: new Date().toISOString(),
    };
    const terminal = publishTerminalDecision(markerPath, owner, unsignedMarker).record;
    publishTerminalAudit(auditMarkerPath, owner, terminal, {
      audit_kind: "acquisition_failure_recorded",
    });
    try { fs.closeSync(fd); } catch {}
    state.released = true;
    fail(`lock acquisition audit failed: ${error.message}`, "LOCK_AUDIT_FAILED", { cause: error });
  }
  return capability;
}

function stateForLock(capability) {
  if (!issuedLocks.has(capability)) fail("an issued run-lock capability is required", "LOCK_CAPABILITY_INVALID");
  const state = lockStates.get(capability);
  if (!state) fail("run-lock capability state is unavailable", "LOCK_CAPABILITY_INVALID");
  return state;
}

function targetRunDir(target) {
  const requested = typeof target === "string" ? target : target?.runDir || target?.eventsPath;
  if (typeof requested !== "string" || !requested) fail("runDir or eventsPath is required", "INVALID_LOCK_TARGET");
  const resolved = path.resolve(requested);
  if (typeof target === "object" && target?.eventsPath && !target?.runDir) return path.dirname(resolved);
  try {
    if (fs.lstatSync(resolved).isFile()) return path.dirname(resolved);
  } catch {
    if (path.basename(resolved) === "events.jsonl") return path.dirname(resolved);
  }
  return resolved;
}

function assertRunLockHeld(capability, target) {
  const state = stateForLock(capability);
  if (state.released) fail("run lock is not held", "LOCK_NOT_HELD");
  const expectedRunDir = targetRunDir(target);
  if (expectedRunDir !== state.runDir) fail("run-lock capability belongs to a different run", "LOCK_RUN_MISMATCH");
  let fdStat;
  let pathStat;
  try {
    fdStat = fs.fstatSync(state.fd);
    pathStat = fs.statSync(state.lockPath);
  } catch (error) {
    fail("run-lock inode is unavailable", "LOCK_NOT_HELD", { cause: error });
  }
  if (fdStat.dev !== state.inode.dev || fdStat.ino !== state.inode.ino || pathStat.dev !== state.inode.dev || pathStat.ino !== state.inode.ino) {
    fail("run-lock inode no longer matches the issued capability", "LOCK_INODE_MISMATCH");
  }
  const base = generationBase(state.owner.generation);
  const terminalPath = path.join(path.dirname(state.lockPath), `${base}.terminal.json`);
  const terminalAuditPath = path.join(path.dirname(state.lockPath), `${base}.terminal-audit.json`);
  const legacyTerminal = (
    fs.existsSync(path.join(path.dirname(state.lockPath), `${base}.released.json`))
    || fs.existsSync(path.join(path.dirname(state.lockPath), `${base}.broken.json`))
  );
  if (legacyTerminal || fs.existsSync(terminalAuditPath)) {
    fail("run-lock generation is already terminal", "LOCK_NOT_HELD");
  }
  if (fs.existsSync(terminalPath)) {
    const observedDecision = terminalMarkerRecord(terminalPath, state.owner);
    if (
      !state.terminalDecision
      || JSON.stringify(observedDecision) !== JSON.stringify(state.terminalDecision)
    ) {
      fail("run-lock generation has an unissued terminal decision", "LOCK_NOT_HELD");
    }
  } else if (state.terminalDecision) {
    fail("issued terminal decision is no longer present", "LOCK_NOT_HELD");
  }
  const raw = fs.readFileSync(state.lockPath);
  const owner = normalizeOwner(JSON.parse(raw.toString("utf8")));
  if (owner.lock_id !== state.owner.lock_id || owner.token !== state.owner.token) {
    fail("run-lock owner no longer matches the issued capability", "LOCK_TOKEN_MISMATCH");
  }
  return true;
}

function releaseRunLock(capability, { outcome = "released", audit, fault } = {}) {
  const state = stateForLock(capability);
  if (state.released) return { released: false, reason: "already_released" };
  const effectiveOutcome = state.terminalDecision?.release_outcome ?? outcome;
  if (!state.terminalDecision) assertRunLockHeld(capability, state.runDir);
  const markerPath = path.join(
    path.dirname(state.lockPath),
    `${generationBase(state.owner.generation)}.terminal.json`,
  );
  const auditMarkerPath = path.join(
    path.dirname(state.lockPath),
    `${generationBase(state.owner.generation)}.terminal-audit.json`,
  );
  const unsignedMarker = {
    generation: state.owner.generation,
    lock_id: state.owner.lock_id,
    outcome: "released",
    release_outcome: effectiveOutcome,
    audit_required: state.terminalDecision?.audit_required ?? typeof audit === "function",
    released_at: new Date().toISOString(),
  };
  state.terminalDecision = publishTerminalDecision(
    markerPath,
    state.owner,
    unsignedMarker,
  ).record;
  assertRunLockHeld(capability, state.runDir);
  if (state.terminalDecision.audit_required && typeof audit !== "function" && !state.auditAttempted) {
    fail("the elected release requires its audit callback", "LOCK_AUDIT_REQUIRED");
  }
  if (typeof audit === "function") {
    emitAudit(audit, "lock_released", state, effectiveOutcome);
    state.auditAttempted = true;
  }
  fault?.("after_release_audit");
  fault?.("before_release_cleanup");
  publishTerminalAudit(auditMarkerPath, state.owner, state.terminalDecision, {
    audit_kind: "lock_released",
  });
  state.released = true;
  try { fs.closeSync(state.fd); } catch {}
  state.fd = undefined;
  return {
    released: true,
    outcome: effectiveOutcome,
    archivePath: null,
    markerPath,
    auditMarkerPath,
  };
}

function resumePendingTerminal({ runDir, audit, fault } = {}) {
  const canonicalRunDir = requireDirectory(runDir, "runDir");
  const snapshot = ledgerSnapshot(canonicalRunDir);
  const pending = snapshot.active;
  if (!pending?.terminal || pending.terminalAudit || pending.released || pending.broken) {
    fail("no pending terminal decision exists", "TERMINAL_RESUME_NOT_FOUND");
  }
  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(pending.ownerPath, openFlags);
  const inode = fs.fstatSync(fd);
  const pathInode = fs.lstatSync(pending.ownerPath);
  const openedBytes = fs.readFileSync(fd);
  if (
    !inode.isFile()
    || pathInode.isSymbolicLink()
    || inode.dev !== pathInode.dev
    || inode.ino !== pathInode.ino
    || !openedBytes.equals(pending.raw)
  ) {
    fs.closeSync(fd);
    fail("owner changed while resuming terminal decision", "LOCK_CHANGED");
  }
  const capability = Object.freeze({
    lock_id: pending.owner.lock_id,
    attempt_id: pending.owner.attempt_id,
    operation: pending.owner.operation,
    run_dir: canonicalRunDir,
    host_kind: pending.owner.host_kind,
    host_handle: pending.owner.host_handle,
  });
  const state = {
    capability,
    runDir: canonicalRunDir,
    lockPath: pending.ownerPath,
    fd,
    inode: { dev: inode.dev, ino: inode.ino },
    owner: pending.owner,
    terminalDecision: pending.terminal,
    released: false,
  };
  issuedLocks.add(capability);
  lockStates.set(capability, state);
  try {
    assertRunLockHeld(capability, canonicalRunDir);
    if (
      pending.terminal.outcome === "broken"
      && pending.terminal.reason !== "acquisition_audit_failed"
    ) {
      ensureCanonicalBreakAudit(state, "broken");
      emitAudit(audit, "lock_released", state, "broken");
    } else if (pending.terminal.outcome === "released") {
      if (pending.terminal.audit_required && typeof audit !== "function") {
        fail("pending release requires an idempotent audit sink", "LOCK_AUDIT_REQUIRED");
      }
      const acknowledgment = emitAudit(
        audit,
        "lock_released",
        state,
        pending.terminal.release_outcome || "released",
      );
      if (
        pending.terminal.audit_required
        && (
          acknowledgment?.audit_key !== terminalAuditKey(pending.owner, pending.terminal)
          || acknowledgment?.durable !== true
          || acknowledgment?.idempotent !== true
        )
      ) {
        fail(
          "recovery audit sink did not acknowledge durable idempotent publication",
          "LOCK_AUDIT_REQUIRED",
        );
      }
    }
    fault?.("after_resume_audit");
    const auditPublication = publishTerminalAudit(
      pending.terminalAuditPath,
      pending.owner,
      pending.terminal,
      {
        audit_kind: pending.terminal.reason === "acquisition_audit_failed"
          ? "acquisition_failure_recorded"
          : `lock_${pending.terminal.outcome}`,
        resumed: true,
      },
    );
    state.released = true;
    fs.closeSync(fd);
    state.fd = undefined;
    return {
      resumed: true,
      outcome: pending.terminal.outcome,
      markerPath: pending.terminalPath,
      auditMarkerPath: pending.terminalAuditPath,
      already_completed: !auditPublication.published,
    };
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    state.fd = undefined;
    error.terminal_retryable = true;
    throw error;
  }
}

async function withRunLock(options, callback) {
  const capability = acquireRunLock(options);
  let outcome = "released";
  try {
    return await callback(capability);
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    releaseRunLock(capability, { outcome, audit: options?.audit });
  }
}

function validateWorktreeFacts(worktreeFacts, runDir) {
  if (!issuedWorktreeFacts.has(worktreeFacts)) return null;
  const state = worktreeFactStates.get(worktreeFacts);
  if (!state || state.runDir !== runDir || Date.now() - state.observedAt > 5_000) return null;
  const required = ["head_sha", "tree_sha", "reviewable_work", "observed_at"];
  if (Object.keys(worktreeFacts).sort().join(",") !== required.sort().join(",")) return null;
  if (typeof worktreeFacts.reviewable_work !== "boolean" || Number.isNaN(Date.parse(worktreeFacts.observed_at))) return null;
  for (const field of ["head_sha", "tree_sha"]) {
    if (worktreeFacts[field] !== null && typeof worktreeFacts[field] !== "string") return null;
  }
  return Object.freeze({ ...worktreeFacts });
}

function digestWorktree(worktreeFacts) {
  return sha256(JSON.stringify({
    head_sha: worktreeFacts.head_sha,
    tree_sha: worktreeFacts.tree_sha,
    reviewable_work: worktreeFacts.reviewable_work,
  }));
}

function observeWorktree({ runDir, worktreeDir } = {}) {
  const canonicalRunDir = requireDirectory(runDir, "runDir");
  const canonicalWorktree = requireDirectory(worktreeDir, "worktreeDir");
  let headSha;
  let treeSha;
  let reviewableWork;
  try {
    headSha = execFileSync("git", ["-C", canonicalWorktree, "rev-parse", "HEAD"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GIT_IDENTITY_TIMEOUT_MS,
    }).trim();
    const headTree = execFileSync("git", ["-C", canonicalWorktree, "rev-parse", "HEAD^{tree}"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GIT_IDENTITY_TIMEOUT_MS,
    }).trim();
    const diff = execFileSync("git", ["-C", canonicalWorktree, "diff", "--binary", "HEAD", "--"], {
      encoding: null, stdio: ["ignore", "pipe", "ignore"], timeout: GIT_CONTENT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    });
    const untrackedOutput = execFileSync("git", ["-C", canonicalWorktree, "ls-files", "--others", "--exclude-standard", "-z"], {
      encoding: null, stdio: ["ignore", "pipe", "ignore"], timeout: GIT_CONTENT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    });
    const untracked = untrackedOutput.toString("utf8").split("\0").filter(Boolean).sort();
    const treeHash = crypto.createHash("sha1").update(`HEAD-tree\0${headTree}\0`).update(diff);
    for (const relative of untracked) {
      const filePath = containedPath(canonicalWorktree, path.join(canonicalWorktree, relative), "untracked worktree file", { mustExist: true });
      treeHash.update(`\0untracked\0${relative}\0`).update(fs.readFileSync(filePath));
    }
    treeSha = treeHash.digest("hex");
    reviewableWork = diff.length > 0 || untracked.length > 0;
  } catch (error) {
    fail("trusted worktree observation failed", "WORKTREE_OBSERVATION_FAILED", { cause: error });
  }
  for (const [label, value] of [["head_sha", headSha], ["tree_sha", treeSha]]) {
    if (!/^[0-9a-f]{40}$/i.test(value)) fail(`${label} is not a SHA-1 digest`, "WORKTREE_OBSERVATION_FAILED");
  }
  const observedAt = Date.now();
  const observation = Object.freeze({
    head_sha: headSha,
    tree_sha: treeSha,
    reviewable_work: reviewableWork,
    observed_at: new Date(observedAt).toISOString(),
  });
  issuedWorktreeFacts.add(observation);
  worktreeFactStates.set(observation, { runDir: canonicalRunDir, worktreeDir: canonicalWorktree, observedAt });
  return observation;
}

function attemptState(facts, attemptId) {
  if (!Array.isArray(facts)) return { status: "missing" };
  const starts = facts.filter((fact) => fact?.type === "attempt_started" && typeof fact.attempt_id === "string");
  const evidence = facts.filter((fact) => ["lock_acquired", "attempt_started"].includes(fact?.type) && typeof fact.attempt_id === "string");
  const match = evidence.some((fact) => fact.attempt_id === attemptId);
  if (!match) return { status: "missing" };
  if (evidence[evidence.length - 1]?.attempt_id !== attemptId) return { status: "superseded" };
  const terminal = facts.some((fact) => fact?.attempt_id === attemptId && ["attempt_finished", "attempt_interrupted"].includes(fact.type));
  return { status: terminal ? "terminal" : "open" };
}

function inspectOwnership({ runDir, eventsPath, worktreeFacts } = {}) {
  const canonicalRunDir = requireDirectory(runDir, "runDir");
  const safeEventsPath = containedPath(
    canonicalRunDir,
    eventsPath || path.join(canonicalRunDir, "events.jsonl"),
    "attempt facts",
    { mustExist: true, directChild: true },
  );
  const attemptFacts = require("./facts").readFacts({ eventsPath: safeEventsPath }).facts;
  const observed = readOwner(runDir);
  if (!observed.exists) return Object.freeze({ status: "absent", lockPath: observed.lockPath });
  if (!observed.owner) return Object.freeze({ status: "unknown", reason: "invalid_lock_owner", lockPath: observed.lockPath });
  const worktreeState = worktreeFactStates.get(worktreeFacts);
  const worktree = validateWorktreeFacts(worktreeFacts, canonicalRunDir);
  const observedWorktreeStat = worktreeState ? fs.statSync(worktreeState.worktreeDir) : null;
  const worktreeBound = worktree
    && worktreeState.worktreeDir === observed.owner.worktree_dir
    && observedWorktreeStat.dev === observed.owner.worktree_dev
    && observedWorktreeStat.ino === observed.owner.worktree_ino;
  const attempt = attemptState(attemptFacts, observed.owner.attempt_id);
  let liveness;
  try {
    liveness = probeDurableHost(observed.owner, canonicalRunDir);
  } catch (error) {
    liveness = { status: "unknown", reason: `probe_error:${error.message}` };
  }
  let status = "unknown";
  let reason = null;
  if (liveness?.status === "live") status = "live";
  else if (!worktreeBound) reason = "worktree_facts_not_revalidated";
  else if (!["open", "terminal"].includes(attempt.status)) reason = "attempt_not_revalidated";
  else if (liveness?.status === "dead") status = "stale";
  else reason = liveness?.reason || "liveness_unknown";
  const publicInspection = Object.freeze({
    status,
    reason,
    lockPath: observed.lockPath,
    owner: Object.freeze({ ...observed.owner, token: undefined }),
    attempt: Object.freeze(attempt),
    worktree: worktreeBound ? worktree : null,
    worktree_digest: worktreeBound ? digestWorktree(worktree) : null,
    liveness: Object.freeze({ ...liveness }),
  });
  if (
    status === "stale"
    || (status === "unknown" && worktreeBound && ["open", "terminal"].includes(attempt.status))
  ) {
    issuedInspections.add(publicInspection);
    inspectionStates.set(publicInspection, {
      runDir: requireDirectory(runDir, "runDir"),
      owner: observed.owner,
      ownerDigest: sha256(observed.raw),
      worktreeDigest: publicInspection.worktree_digest,
      worktreeDir: worktreeState.worktreeDir,
    });
  }
  return publicInspection;
}

function proofBinding(state, fields) {
  return sha256(JSON.stringify({
    lock_id: state.owner.lock_id,
    attempt_id: state.owner.attempt_id,
    host_kind: state.owner.host_kind,
    host_handle: state.owner.host_handle,
    host: state.owner.host,
    worktree_digest: state.worktreeDigest,
    ...fields,
  }));
}

function captureLivenessProbe(inspection) {
  if (!issuedInspections.has(inspection)) fail("an issued stale inspection is required", "INSPECTION_CAPABILITY_INVALID");
  const state = inspectionStates.get(inspection);
  const result = probeDurableHost(state.owner, state.runDir);
  if (result?.status !== "dead" || result.identity_matches !== false) {
    fail("liveness break proof must show a dead nonmatching identity", "BREAK_EVIDENCE_INSUFFICIENT");
  }
  const at = new Date().toISOString();
  const proof = Object.freeze({
    kind: "liveness_probe",
    at,
    status: "dead",
    identity_matches: false,
    binding_sha256: proofBinding(state, { kind: "liveness_probe", at }),
  });
  issuedBreakProofs.add(proof);
  breakProofStates.set(proof, { inspection, kind: "liveness_probe", at: Date.parse(at) });
  return proof;
}

function terminalResultProof(inspection, { resultPath } = {}) {
  if (!issuedInspections.has(inspection)) fail("an issued stale inspection is required", "INSPECTION_CAPABILITY_INVALID");
  const state = inspectionStates.get(inspection);
  const safePath = containedPath(state.runDir, resultPath, "terminal result", { mustExist: true, directChild: true });
  const bytes = fs.readFileSync(safePath);
  let result;
  try { result = JSON.parse(bytes.toString("utf8")); } catch { fail("terminal result is not valid JSON", "BREAK_EVIDENCE_INSUFFICIENT"); }
  const exact = result
    && result.lock_id === state.owner.lock_id
    && result.attempt_id === state.owner.attempt_id
    && result.host_kind === state.owner.host_kind
    && result.host_handle === state.owner.host_handle
    && TERMINAL_HOST_STATUSES.has(result.status);
  if (!exact) fail("terminal result does not exactly match lock ownership", "BREAK_EVIDENCE_INSUFFICIENT");
  const { result_auth_sha256: signature, ...unsigned } = result;
  const expectedSignature = signResult(unsigned, resultAuthKey(state.owner));
  if (
    typeof signature !== "string"
    || signature.length !== expectedSignature.length
    || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  ) fail("terminal result is not authenticated by its lock owner", "BREAK_EVIDENCE_INSUFFICIENT");
  const proof = Object.freeze({
    kind: "terminal_result",
    result_path: safePath,
    result_sha256: sha256(bytes),
    binding_sha256: proofBinding(state, { kind: "terminal_result", result_sha256: sha256(bytes) }),
  });
  issuedBreakProofs.add(proof);
  breakProofStates.set(proof, { inspection, kind: "terminal_result", resultPath: safePath, resultSha256: sha256(bytes) });
  return proof;
}

function validateBreakProof(inspection, evidence) {
  const proofs = Array.isArray(evidence) ? evidence : [evidence];
  if (!proofs.length || proofs.some((proof) => !issuedBreakProofs.has(proof))) return false;
  const states = proofs.map((proof) => breakProofStates.get(proof));
  if (states.some((state) => state.inspection !== inspection)) return false;
  if (states.length === 1 && states[0].kind === "terminal_result") {
    const bytes = fs.readFileSync(states[0].resultPath);
    return sha256(bytes) === states[0].resultSha256;
  }
  if (states.length !== 2 || states.some((state) => state.kind !== "liveness_probe")) return false;
  return states[1].at - states[0].at >= MIN_BREAK_PROBE_INTERVAL_MS;
}

function revalidateBreakWorktree(inspectionState) {
  const fresh = observeWorktree({
    runDir: inspectionState.runDir,
    worktreeDir: inspectionState.worktreeDir,
  });
  if (digestWorktree(fresh) !== inspectionState.worktreeDigest) {
    fail("worktree changed after stale inspection", "WORKTREE_CHANGED");
  }
}

function breakStaleRunLock({ inspection, reason, evidence, audit, fault } = {}) {
  const evidenceList = Array.isArray(evidence) ? evidence : [evidence];
  const terminalOnly = evidenceList.length === 1
    && breakProofStates.get(evidenceList[0])?.kind === "terminal_result";
  if (
    !issuedInspections.has(inspection)
    || (inspection.status !== "stale" && !(inspection.status === "unknown" && terminalOnly))
  ) {
    fail("an issued stale inspection is required", "INSPECTION_CAPABILITY_INVALID");
  }
  if (typeof reason !== "string" || !reason.trim()) fail("break reason is required", "BREAK_REASON_REQUIRED");
  if (!validateBreakProof(inspection, evidence)) fail("break proof is unissued, unbound, or insufficient", "BREAK_EVIDENCE_INSUFFICIENT");
  const inspectionState = inspectionStates.get(inspection);
  revalidateBreakWorktree(inspectionState);
  const observed = readOwner(inspectionState.runDir);
  if (!observed.owner || sha256(observed.raw) !== inspectionState.ownerDigest) fail("lock changed after inspection", "LOCK_CHANGED");
  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(observed.lockPath, openFlags);
  const inode = fs.fstatSync(fd);
  const pathInode = fs.lstatSync(observed.lockPath);
  const openedBytes = fs.readFileSync(fd);
  if (
    !inode.isFile()
    || pathInode.isSymbolicLink()
    || inode.dev !== pathInode.dev
    || inode.ino !== pathInode.ino
    || sha256(openedBytes) !== inspectionState.ownerDigest
  ) {
    fs.closeSync(fd);
    fail("lock changed while opening stale owner", "LOCK_CHANGED");
  }
  const capability = Object.freeze({
    lock_id: observed.owner.lock_id,
    attempt_id: observed.owner.attempt_id,
    operation: observed.owner.operation,
    run_dir: inspectionState.runDir,
    host_kind: observed.owner.host_kind,
    host_handle: observed.owner.host_handle,
  });
  const state = {
    capability,
    runDir: inspectionState.runDir,
    lockPath: observed.lockPath,
    fd,
    inode: { dev: inode.dev, ino: inode.ino },
    owner: observed.owner,
    released: false,
  };
  issuedLocks.add(capability);
  lockStates.set(capability, state);
  const proofs = Array.isArray(evidence) ? evidence : [evidence];
  const markerUnsigned = {
    generation: state.owner.generation,
    lock_id: state.owner.lock_id,
    attempt_id: state.owner.attempt_id,
    outcome: "broken",
    reason,
    evidence_digest: sha256(JSON.stringify(proofs.map((proof) => proof.binding_sha256))),
    worktree_digest: inspectionState.worktreeDigest,
    audit_required: true,
    broken_at: new Date().toISOString(),
  };
  try {
    const markerPath = observed.terminalPath;
    const auditMarkerPath = observed.terminalAuditPath;
    if (!fs.existsSync(markerPath)) assertRunLockHeld(capability, state.runDir);
    state.terminalDecision = publishTerminalDecision(
      markerPath,
      state.owner,
      markerUnsigned,
    ).record;
    assertRunLockHeld(capability, state.runDir);
    ensureCanonicalBreakAudit(state, "broken");
    emitAudit(audit, "lock_released", state, "broken");
    fault?.("after_release_audit");
    fault?.("before_release_archive");
    const auditPublication = publishTerminalAudit(
      auditMarkerPath,
      state.owner,
      state.terminalDecision,
      { audit_kind: "lock_broken" },
    );
    state.released = true;
    fs.closeSync(fd);
    state.fd = undefined;
    return {
      released: true,
      outcome: "broken",
      archivePath: markerPath,
      markerPath,
      auditMarkerPath,
      already_broken: !auditPublication.published,
    };
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    state.fd = undefined;
    error.break_retryable = true;
    throw error;
  }
}

function resumePendingBreak() {
  fail("immutable ownership markers cannot have a partial transition", "BREAK_TRANSITION_NOT_FOUND");
}

function probeHostEnvironment({ runDir, requestedHostKind = "local_supervisor" } = {}) {
  if (!HOST_KINDS.has(requestedHostKind)) {
    return { supported: false, requestedHostKind, blocker: "unknown_host_kind", recommended_action: "inspect" };
  }
  if (requestedHostKind !== "local_supervisor") {
    return { supported: false, requestedHostKind, blocker: "host_integration_unavailable", recommended_action: "inspect" };
  }
  try {
    const canonicalRunDir = requireDirectory(runDir, "runDir");
    const probePath = path.join(canonicalRunDir, `.host-probe-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    const fd = fs.openSync(probePath, "wx", 0o600);
    fs.writeFileSync(fd, "probe\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.unlinkSync(probePath);
    syncDirectory(canonicalRunDir);
    const launchPrimitive = process.platform === "win32" ? "unsupported" : "detached_session";
    if (launchPrimitive === "unsupported") fail("detached sessions are unavailable", "HOST_UNSUPPORTED");
    const fingerprint = processFingerprint(process.pid);
    if (!fingerprint) fail("kernel-stable host identity is unavailable", "HOST_IDENTITY_UNAVAILABLE");
    return {
      supported: true,
      host_kind: "local_supervisor",
      launch_primitive: launchPrimitive,
      process_started_at: fingerprint.started_at,
      process_fingerprint: fingerprint,
    };
  } catch (error) {
    return {
      supported: false,
      requestedHostKind,
      blocker: "durable_host_probe_failed",
      detail: error.message,
      recommended_action: "inspect",
    };
  }
}

function selectHost({ survivalMeasurement, ...options } = {}) {
  const probe = probeHostEnvironment(options);
  if (!probe.supported) return probe;
  if (!issuedMeasurements.has(survivalMeasurement)) {
    return {
      supported: false,
      requestedHostKind: options.requestedHostKind || "local_supervisor",
      blocker: "survival_gate_not_verified",
      recommended_action: "inspect",
      probe,
    };
  }
  return probe;
}

function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    Atomics.wait(waiter, 0, 0, 10);
  }
  return fs.existsSync(filePath);
}

function validateReadyForLaunch({
  readyPath,
  supervisorClaimPath,
  attemptId,
  hostHandle,
  supervisorPid,
  supervisorStartedAt,
  supervisorFingerprint,
  supervisorNonce,
  configSha256,
  resultAuthKey: authKey,
}) {
  const ready = readSecureJsonArtifact(readyPath, "supervisor ready artifact");
  const claim = readSecureJsonArtifact(supervisorClaimPath, "supervisor claim artifact");
  if (
    ready.attempt_id !== attemptId
    || ready.host_handle !== hostHandle
    || ready.host_kind !== "local_supervisor"
    || ready.supervisor_pid !== supervisorPid
    || typeof ready.supervisor_started_at !== "string"
    || Number.isNaN(Date.parse(ready.supervisor_started_at))
    || !ready.supervisor_fingerprint
    || (supervisorStartedAt && ready.supervisor_started_at !== supervisorStartedAt)
    || (supervisorFingerprint && !fingerprintsEqual(ready.supervisor_fingerprint, supervisorFingerprint))
    || ready.supervisor_nonce !== supervisorNonce
    || ready.config_sha256 !== configSha256
    || !verifySignedArtifact(ready, "ready_auth_sha256", authKey)
    || claim.attempt_id !== attemptId
    || claim.host_handle !== hostHandle
    || claim.supervisor_pid !== supervisorPid
    || claim.supervisor_started_at !== ready.supervisor_started_at
    || !fingerprintsEqual(claim.supervisor_fingerprint, ready.supervisor_fingerprint)
    || claim.supervisor_nonce !== supervisorNonce
    || claim.config_sha256 !== configSha256
    || !verifySignedArtifact(claim, "claim_auth_sha256", authKey)
  ) {
    fail("supervisor ready or claim identity is invalid", "HOST_READY_INVALID", {
      attemptId,
      hostHandle,
      readyPath,
      supervisorClaimPath,
    });
  }
  const observedFingerprint = processFingerprint(supervisorPid);
  if (
    observedFingerprint?.state === "Z"
    || observedFingerprint?.command_terminalized === true
  ) {
    fail("supervisor is terminalizing before ready acceptance", "HOST_READY_TERMINALIZING", {
      attemptId,
      observedFingerprint,
    });
  }
  if (!fingerprintsEqual(observedFingerprint, ready.supervisor_fingerprint)) {
    fail("supervisor pid start identity changed before ready acceptance", "HOST_READY_INVALID", {
      attemptId,
      hostHandle,
      readyPath,
      supervisorClaimPath,
      observedFingerprint,
      readyStart: ready.supervisor_started_at,
    });
  }
  return ready;
}

function terminateIdentityBoundGroup(pid, expectedFingerprint, signal) {
  if (!pid || !expectedFingerprint) return { delivered: false, absent: false, code: "PROCESS_IDENTITY_INCOMPLETE" };
  const observedFingerprint = processFingerprint(pid);
  if (!fingerprintsEqual(observedFingerprint, expectedFingerprint)) {
    return {
      delivered: false,
      absent: !observedFingerprint,
      code: observedFingerprint ? "PROCESS_IDENTITY_CHANGED" : "PROCESS_IDENTITY_UNAVAILABLE",
    };
  }
  return signalProcessGroup(pid, signal);
}

function abortSupervisorStartup({
  child,
  supervisorFingerprint,
  supervisorClaimPath,
  cancelPath,
  executorPath,
  attemptId,
  hostHandle,
  resultAuthKey: authKey,
}) {
  try {
    atomicWriteFile(cancelPath, `${JSON.stringify({
      attempt_id: attemptId,
      host_handle: hostHandle,
      reason: "startup_failed",
      requested_at: new Date().toISOString(),
    })}\n`);
  } catch {}
  if (!supervisorFingerprint) {
    try {
      const claim = readSecureJsonArtifact(supervisorClaimPath, "supervisor claim artifact");
      if (
        claim.attempt_id === attemptId
        && claim.host_handle === hostHandle
        && verifySignedArtifact(claim, "claim_auth_sha256", authKey)
      ) supervisorFingerprint = claim.supervisor_fingerprint;
    } catch {}
  }
  let executor = null;
  function readExecutor() {
    try {
      const candidate = readSecureJsonArtifact(executorPath, "executor identity artifact");
      if (
        candidate.attempt_id === attemptId
        && candidate.host_handle === hostHandle
        && candidate.executor_pgid === candidate.executor_pid
        && candidate.executor_fingerprint?.pid === candidate.executor_pid
        && candidate.executor_fingerprint?.pgid === candidate.executor_pgid
        && typeof candidate.executor_nonce === "string"
        && candidate.executor_nonce.length >= 32
        && verifySignedArtifact(candidate, "executor_auth_sha256", authKey)
      ) return candidate;
    } catch {}
    return null;
  }
  executor = readExecutor();
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  const executorDeadline = Date.now() + 5_000;
  while (!executor && Date.now() < executorDeadline) {
    Atomics.wait(waiter, 0, 0, 25);
    executor = readExecutor();
  }
  const supervisorTerm = terminateIdentityBoundGroup(child.pid, supervisorFingerprint, "SIGTERM");
  if (!supervisorTerm.delivered && child?.pid) {
    try { child.kill("SIGTERM"); } catch {}
  }
  Atomics.wait(waiter, 0, 0, 250);
  const supervisorKill = terminateIdentityBoundGroup(child.pid, supervisorFingerprint, "SIGKILL");
  if (!supervisorKill.delivered && child?.pid) {
    try { child.kill("SIGKILL"); } catch {}
  }
}

function waitForSupervisorReady({
  child,
  readyPath,
  resultPath,
  supervisorClaimPath,
  startupStderrPath,
  attemptId,
  hostHandle,
  supervisorStartedAt,
  supervisorFingerprint,
  supervisorNonce,
  configSha256,
  resultAuthKey: authKey,
  timeoutMs = 30_000,
}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  let lastLiveness = { status: "unknown", reason: "not_probed" };
  let nextLivenessProbeAt = 0;
  while (Date.now() < deadline) {
    if (resultPath && fs.existsSync(resultPath)) {
      const result = readSecureJsonArtifact(resultPath, "startup terminal result");
      let terminalFingerprint = supervisorFingerprint;
      if (!terminalFingerprint) {
        try {
          const terminalClaim = readSecureJsonArtifact(supervisorClaimPath, "supervisor claim artifact");
          if (verifySignedArtifact(terminalClaim, "claim_auth_sha256", authKey)) {
            terminalFingerprint = terminalClaim.supervisor_fingerprint;
          }
        } catch {}
      }
      if (
        result.attempt_id === attemptId
        && result.host_handle === hostHandle
        && TERMINAL_HOST_STATUSES.has(result.status)
        && terminalFingerprint
        && verifySignedArtifact(result, "result_auth_sha256", authKey)
      ) {
        return {
          ready_at: result.completed_at,
          supervisor_started_at: terminalFingerprint.started_at,
          supervisor_fingerprint: terminalFingerprint,
          terminal_during_startup: true,
        };
      }
      fail("startup terminal result is unauthenticated", "HOST_START_FAILED");
    }
    if (fs.existsSync(readyPath)) {
      try {
        return validateReadyForLaunch({
          readyPath,
          supervisorClaimPath,
          attemptId,
          hostHandle,
          supervisorPid: child.pid,
          supervisorStartedAt,
          supervisorFingerprint,
          supervisorNonce,
          configSha256,
          resultAuthKey: authKey,
        });
      } catch (error) {
        let supervisorGone = false;
        try { process.kill(child.pid, 0); } catch (probeError) {
          supervisorGone = probeError.code === "ESRCH";
        }
        if (error.code === "HOST_READY_TERMINALIZING") supervisorGone = true;
        if (
          !["HOST_READY_INVALID", "HOST_READY_TERMINALIZING"].includes(error.code)
          || !supervisorGone
        ) throw error;
        // A short-lived executor may complete and reap the supervisor between
        // ready publication and launcher validation. Only the authenticated
        // terminal result can close that race; keep waiting for it.
      }
    }
    const startupStderr = fs.existsSync(startupStderrPath)
      ? fs.readFileSync(startupStderrPath, "utf8")
      : "";
    if (startupStderr.includes("HOST_DIAGNOSTIC ")) {
      fail("supervisor reported a structured startup failure", "HOST_START_FAILED", {
        attemptId,
        hostHandle,
        supervisorPid: child.pid ?? null,
        supervisorProcessStartedAt: child.pid ? processStartAt(child.pid) : null,
        readyPath,
        startupStderrPath,
        startupStderr: startupStderr.slice(-4096),
        elapsedMs: Date.now() - startedAt,
        recommended_action: "inspect",
      });
    }
    if (!child.pid) {
      fail("supervisor process did not receive a pid", "HOST_START_FAILED", {
        attemptId,
        hostHandle,
        supervisorPid: null,
        readyPath,
        startupStderrPath,
        elapsedMs: Date.now() - startedAt,
        recommended_action: "inspect",
      });
    }
    if (Date.now() >= nextLivenessProbeAt) {
      nextLivenessProbeAt = Date.now() + 250;
      const observedStart = processStartAt(child.pid);
      try {
        process.kill(child.pid, 0);
        lastLiveness = {
          status: observedStart ? "live" : "unknown",
          reason: observedStart ? "pid_present" : "process_start_unavailable",
          process_started_at: observedStart,
        };
      } catch (error) {
        lastLiveness = error.code === "ESRCH"
          ? { status: "dead", reason: "pid_missing", process_started_at: observedStart }
          : { status: "unknown", reason: `pid_probe_failed:${error.code || "unknown"}` };
        if (lastLiveness.status === "dead") {
          fail("supervisor exited before publishing ready", "HOST_START_FAILED", {
            attemptId,
            hostHandle,
            supervisorPid: child.pid,
            supervisorProcessStartedAt: observedStart,
            readyPath,
            startupStderrPath,
            startupStderr: startupStderr.slice(-4096),
            liveness: lastLiveness,
            elapsedMs: Date.now() - startedAt,
            recommended_action: "inspect",
          });
        }
      }
    }
    Atomics.wait(waiter, 0, 0, 10);
  }
  const startupStderr = fs.existsSync(startupStderrPath)
    ? fs.readFileSync(startupStderrPath, "utf8")
    : "";
  fail("live supervisor did not publish ready before the startup deadline", "HOST_START_FAILED", {
    attemptId,
    hostHandle,
    supervisorPid: child.pid ?? null,
    supervisorProcessStartedAt: child.pid ? processStartAt(child.pid) : null,
    readyPath,
    startupStderrPath,
    startupStderr: startupStderr.slice(-4096),
    liveness: lastLiveness,
    elapsedMs: Date.now() - startedAt,
    recommended_action: "inspect",
  });
}

function launchLocalSupervisor({
  runDir,
  attemptId,
  command,
  args = [],
  trustedWorktreeRoot,
  cwd,
  stdoutPath,
  stderrPath,
  resultPath,
  timeoutMs = 30_000,
  cancelGraceMs = 1_000,
  supervisorStartupTimeoutMs = 30_000,
  lockId = null,
  lockContext,
  hostHandle: requestedHostHandle,
} = {}) {
  const canonicalRunDir = requireDirectory(runDir, "runDir");
  if (process.platform === "win32") {
    fail("detached local supervisor is unavailable on Windows", "HOST_UNSUPPORTED", {
      requestedHostKind: "local_supervisor",
      recommended_action: "inspect",
    });
  }
  let boundLock = null;
  if (lockContext !== undefined) {
    assertRunLockHeld(lockContext, canonicalRunDir);
    boundLock = stateForLock(lockContext);
    if (attemptId !== boundLock.owner.attempt_id) {
      fail("host attemptId must match its lock owner", "HOST_LOCK_IDENTITY_MISMATCH");
    }
    if (boundLock.owner.host_kind !== "local_supervisor") {
      fail("lock owner is not bound to local_supervisor", "HOST_LOCK_IDENTITY_MISMATCH");
    }
    if (requestedHostHandle && requestedHostHandle !== boundLock.owner.host_handle) {
      fail("hostHandle must match its lock owner", "HOST_LOCK_IDENTITY_MISMATCH");
    }
  }
  safeAttemptId(attemptId);
  if (typeof command !== "string" || !command || (!path.isAbsolute(command) && command.includes(path.sep))) {
    fail("command must be a bare executable name or absolute path", "INVALID_INVOCATION");
  }
  if (path.isAbsolute(command)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
    } catch (error) {
      fail("absolute command is not executable", "INVALID_INVOCATION", {
        command,
        cause: error,
      });
    }
  }
  if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) fail("args must be a string array", "INVALID_INVOCATION");
  if (!Number.isFinite(supervisorStartupTimeoutMs) || supervisorStartupTimeoutMs <= 0) {
    fail("supervisorStartupTimeoutMs must be positive", "INVALID_INVOCATION");
  }
  const worktreeRoot = requireDirectory(trustedWorktreeRoot || boundLock?.owner.worktree_dir || canonicalRunDir, "trustedWorktreeRoot");
  if (boundLock) {
    const worktreeStat = fs.statSync(worktreeRoot);
    if (
      worktreeRoot !== boundLock.owner.worktree_dir
      || worktreeStat.dev !== boundLock.owner.worktree_dev
      || worktreeStat.ino !== boundLock.owner.worktree_ino
    ) fail("trustedWorktreeRoot must match its lock owner", "HOST_LOCK_IDENTITY_MISMATCH");
  }
  const safeCwd = containedPath(worktreeRoot, cwd || worktreeRoot, "cwd", { mustExist: true, file: false });
  if (safeCwd !== worktreeRoot) fail("cwd must be the canonical trusted worktree root", "UNTRUSTED_PATH");
  const directOutput = { directChild: true };
  const safeStdout = containedPath(canonicalRunDir, stdoutPath || path.join(canonicalRunDir, `attempt-${attemptId}.stdout.log`), "stdout", directOutput);
  const safeStderr = containedPath(canonicalRunDir, stderrPath || path.join(canonicalRunDir, `attempt-${attemptId}.stderr.log`), "stderr", directOutput);
  const safeResult = containedPath(canonicalRunDir, resultPath || path.join(canonicalRunDir, `attempt-${attemptId}.result.json`), "result", directOutput);
  const configPath = containedPath(canonicalRunDir, path.join(canonicalRunDir, `host-attempt-${attemptId}.json`), "config", directOutput);
  const readyPath = containedPath(canonicalRunDir, path.join(canonicalRunDir, `host-attempt-${attemptId}.ready.json`), "ready", directOutput);
  const startupStderrPath = containedPath(
    canonicalRunDir,
    path.join(canonicalRunDir, `host-attempt-${attemptId}.startup.stderr.log`),
    "startup stderr",
    directOutput,
  );
  const cancelPath = containedPath(canonicalRunDir, path.join(canonicalRunDir, `host-attempt-${attemptId}.cancel`), "cancel", directOutput);
  const executorPath = containedPath(canonicalRunDir, path.join(canonicalRunDir, `host-attempt-${attemptId}.executor.json`), "executor identity", directOutput);
  const launchClaimPath = containedPath(canonicalRunDir, path.join(canonicalRunDir, `host-attempt-${attemptId}.launch-claim`), "launch claim", directOutput);
  const supervisorClaimPath = containedPath(canonicalRunDir, path.join(canonicalRunDir, `host-attempt-${attemptId}.supervisor-claim`), "supervisor claim", directOutput);
  const hostHandle = boundLock?.owner.host_handle || requestedHostHandle || `${os.hostname()}:${crypto.randomUUID()}`;
  if (typeof hostHandle !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(hostHandle)) {
    fail("hostHandle contains unsafe characters", "INVALID_HOST_HANDLE");
  }
  const config = {
    attempt_id: attemptId,
    lock_id: boundLock?.owner.lock_id || lockId,
    result_auth_key: boundLock ? resultAuthKey(boundLock.owner) : crypto.randomBytes(32).toString("hex"),
    supervisor_nonce: crypto.randomBytes(32).toString("hex"),
    host_kind: "local_supervisor",
    host_handle: hostHandle,
    command,
    args,
    trusted_worktree_root: worktreeRoot,
    cwd: safeCwd,
    stdout_path: safeStdout,
    stderr_path: safeStderr,
    result_path: safeResult,
    ready_path: readyPath,
    cancel_path: cancelPath,
    executor_path: executorPath,
    launch_claim_path: launchClaimPath,
    supervisor_claim_path: supervisorClaimPath,
    timeout_ms: timeoutMs,
    cancel_grace_ms: cancelGraceMs,
  };
  const configBytes = `${JSON.stringify(config)}\n`;
  const configSha256 = sha256(configBytes);
  let launchClaimFd;
  try {
    launchClaimFd = fs.openSync(launchClaimPath, "wx", 0o600);
    fs.writeFileSync(launchClaimFd, `${JSON.stringify({
      attempt_id: attemptId,
      host_handle: hostHandle,
      config_sha256: configSha256,
      claimed_at: new Date().toISOString(),
    })}\n`);
    fs.fsyncSync(launchClaimFd);
  } catch (error) {
    if (launchClaimFd !== undefined) try { fs.closeSync(launchClaimFd); } catch {}
    if (error.code === "EEXIST") {
      fail("attempt id has already been launched", "HOST_ATTEMPT_ALREADY_LAUNCHED", {
        attemptId,
        hostHandle,
        launchClaimPath,
        recommended_action: "inspect",
      });
    }
    throw error;
  }
  fs.closeSync(launchClaimFd);
  for (const artifactPath of [
    configPath, readyPath, startupStderrPath, cancelPath, executorPath, supervisorClaimPath,
    safeStdout, safeStderr, safeResult,
  ]) {
    if (fs.existsSync(artifactPath)) {
      fail("attempt artifact already exists", "HOST_ATTEMPT_ARTIFACT_EXISTS", {
        attemptId,
        hostHandle,
        artifactPath,
        recommended_action: "inspect",
      });
    }
  }
  atomicWriteFile(configPath, configBytes);
  const startupStderrFd = fs.openSync(startupStderrPath, "wx", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [__filename, "--supervise", configPath, configSha256], {
      cwd: canonicalRunDir,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", startupStderrFd],
    });
  } finally {
    fs.closeSync(startupStderrFd);
  }
  child.unref();
  let supervisorFingerprint = null;
  let supervisorStartedAt = null;
  let ready;
  try {
    ready = waitForSupervisorReady({
      child,
      readyPath,
      resultPath: safeResult,
      supervisorClaimPath,
      startupStderrPath,
      attemptId,
      hostHandle,
      supervisorStartedAt,
      supervisorFingerprint,
      supervisorNonce: config.supervisor_nonce,
      configSha256,
      resultAuthKey: config.result_auth_key,
      timeoutMs: supervisorStartupTimeoutMs,
    });
    supervisorStartedAt = ready.supervisor_started_at;
    supervisorFingerprint = ready.supervisor_fingerprint;
  } catch (error) {
    abortSupervisorStartup({
      child,
      supervisorFingerprint,
      supervisorClaimPath,
      cancelPath,
      executorPath,
      attemptId,
      hostHandle,
      resultAuthKey: config.result_auth_key,
    });
    throw error;
  }
  const receipt = Object.freeze({
    attempt_id: attemptId,
    lock_id: config.lock_id,
    host_kind: "local_supervisor",
    host_handle: hostHandle,
    started_at: ready.ready_at,
    timeout_ms: timeoutMs,
    stdout_path: safeStdout,
    stderr_path: safeStderr,
    result_path: safeResult,
    config_path: configPath,
    ready_path: readyPath,
    startup_stderr_path: startupStderrPath,
    executor_path: executorPath,
    cancel_path: cancelPath,
    run_dir: canonicalRunDir,
  });
  issuedReceipts.add(receipt);
  receiptStates.set(receipt, { config });
  return receipt;
}

function signalProcessGroup(pid, signal) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", signal === "SIGKILL" ? "/F" : ""].filter(Boolean), { stdio: "ignore" });
    } else {
      process.kill(-Number(pid), signal);
    }
    return { delivered: true };
  } catch (error) {
    return {
      delivered: false,
      absent: error.code === "ESRCH",
      code: error.code || "SIGNAL_FAILED",
      message: error.message,
    };
  }
}

function processGroupExists(pgid) {
  if (process.platform === "win32") return false;
  try {
    process.kill(-Number(pgid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function signalExecutorGroup(identity, signal, { anchorLive = false } = {}) {
  if (
    !identity
    || !Number.isInteger(identity.executor_pid)
    || identity.executor_pid <= 0
    || identity.executor_pgid !== identity.executor_pid
    || !identity.executor_fingerprint
    || identity.executor_fingerprint.pid !== identity.executor_pid
    || identity.executor_fingerprint.pgid !== identity.executor_pgid
    || typeof identity.executor_nonce !== "string"
    || identity.executor_nonce.length < 32
  ) {
    return { delivered: false, absent: false, code: "EXECUTOR_IDENTITY_INVALID" };
  }
  if (!anchorLive) {
    return { delivered: false, absent: false, code: "EXECUTOR_ANCHOR_CLOSED" };
  }
  if (!processGroupExists(identity.executor_pgid)) {
    return { delivered: false, absent: true, code: "PROCESS_GROUP_ABSENT" };
  }
  const observed = processFingerprint(identity.executor_pid);
  if (!observed) {
    return { delivered: false, absent: false, code: "EXECUTOR_IDENTITY_UNAVAILABLE" };
  }
  if (!fingerprintsEqual(observed, identity.executor_fingerprint)) {
    return { delivered: false, absent: false, code: "EXECUTOR_IDENTITY_CHANGED" };
  }
  return signalProcessGroup(identity.executor_pgid, signal);
}

function cancelHost(receipt, { reason = "operator_cancelled" } = {}) {
  if (!issuedReceipts.has(receipt)) fail("an issued host receipt is required", "HOST_RECEIPT_INVALID");
  const state = receiptStates.get(receipt);
  atomicWriteFile(state.config.cancel_path, `${JSON.stringify({
    host_kind: receipt.host_kind,
    host_handle: receipt.host_handle,
    attempt_id: receipt.attempt_id,
    lock_id: receipt.lock_id,
    reason,
    requested_at: new Date().toISOString(),
  })}\n`);
  return { requested: true, cancel_path: state.config.cancel_path };
}

function terminalResult(config, fields) {
  const unsigned = {
    attempt_id: config.attempt_id,
    lock_id: config.lock_id,
    host_kind: config.host_kind,
    host_handle: config.host_handle,
    ...fields,
    completed_at: new Date().toISOString(),
  };
  return { ...unsigned, result_auth_sha256: signResult(unsigned, config.result_auth_key) };
}

function runSupervisor(configPath, expectedSha256) {
  const configBytes = fs.readFileSync(configPath);
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 || "") || sha256(configBytes) !== expectedSha256) {
    fail("supervisor config integrity check failed", "HOST_CONFIG_MISMATCH");
  }
  const config = JSON.parse(configBytes.toString("utf8"));
  const runDir = requireDirectory(path.dirname(configPath), "supervisor runDir");
  safeAttemptId(config.attempt_id);
  config.trusted_worktree_root = requireDirectory(config.trusted_worktree_root, "trustedWorktreeRoot");
  config.cwd = containedPath(config.trusted_worktree_root, config.cwd, "cwd", { mustExist: true, file: false });
  if (config.cwd !== config.trusted_worktree_root) fail("cwd must be the canonical trusted worktree root", "UNTRUSTED_PATH");
  for (const [field, label] of [
    ["stdout_path", "stdout"],
    ["stderr_path", "stderr"],
    ["result_path", "result"],
    ["ready_path", "ready"],
    ["cancel_path", "cancel"],
    ["executor_path", "executor identity"],
    ["launch_claim_path", "launch claim"],
    ["supervisor_claim_path", "supervisor claim"],
  ]) {
    config[field] = containedPath(runDir, config[field], label, { directChild: true });
  }
  const launchClaim = readSecureJsonArtifact(config.launch_claim_path, "launch claim artifact");
  if (
    launchClaim.attempt_id !== config.attempt_id
    || launchClaim.host_handle !== config.host_handle
    || launchClaim.config_sha256 !== expectedSha256
  ) {
    fail("launch claim does not match supervisor config", "HOST_LAUNCH_CLAIM_MISMATCH");
  }
  const supervisorFingerprint = waitForFingerprint(process.pid);
  if (!supervisorFingerprint) {
    fail("kernel-stable supervisor identity is unavailable", "HOST_IDENTITY_UNAVAILABLE");
  }
  const supervisorStartedAt = supervisorFingerprint.started_at;
  const unsignedClaim = {
    attempt_id: config.attempt_id,
    host_kind: config.host_kind,
    host_handle: config.host_handle,
    supervisor_pid: process.pid,
    supervisor_started_at: supervisorStartedAt,
    supervisor_fingerprint: supervisorFingerprint,
    supervisor_nonce: config.supervisor_nonce,
    config_sha256: expectedSha256,
    claimed_at: new Date().toISOString(),
  };
  let claimFd;
  try {
    claimFd = fs.openSync(config.supervisor_claim_path, "wx", 0o600);
    fs.writeFileSync(claimFd, `${JSON.stringify({
      ...unsignedClaim,
      claim_auth_sha256: signResult(unsignedClaim, config.result_auth_key),
    })}\n`, "utf8");
    fs.fsyncSync(claimFd);
    fs.closeSync(claimFd);
  } catch (error) {
    if (claimFd !== undefined) {
      try { fs.closeSync(claimFd); } catch {}
    }
    if (error.code === "EEXIST") {
      fail("supervisor claim already exists", "HOST_SUPERVISOR_CLAIMED", {
        supervisorClaimPath: config.supervisor_claim_path,
      });
    }
    throw error;
  }
  const unsignedReady = {
    attempt_id: config.attempt_id,
    host_kind: config.host_kind,
    host_handle: config.host_handle,
    supervisor_pid: process.pid,
    supervisor_started_at: supervisorStartedAt,
    supervisor_fingerprint: supervisorFingerprint,
    supervisor_nonce: config.supervisor_nonce,
    config_sha256: expectedSha256,
  };
  let stdoutFd;
  let stderrFd;
  let child;
  let finished = false;
  let requestedStatus = null;
  let escalationTimer = null;
  let deadlineTimer = null;
  let cancelPoll = null;
  let requestedClose = null;
  let executorIdentity = null;
  let childClosed = false;

  function finish(fields) {
    if (finished) return;
    finished = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (escalationTimer) clearTimeout(escalationTimer);
    if (cancelPoll) clearInterval(cancelPoll);
    try { fs.closeSync(stdoutFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}
    atomicWriteFile(config.result_path, `${JSON.stringify(terminalResult(config, fields))}\n`);
  }

  function terminate(status) {
    if (finished || !child || requestedStatus) return;
    requestedStatus = status;
    const term = signalExecutorGroup(executorIdentity, "SIGTERM", { anchorLive: !childClosed });
    if (!term.delivered && !term.absent) {
      process.stderr.write(`HOST_DIAGNOSTIC ${JSON.stringify({
        code: "HOST_SIGNAL_FAILED",
        signal: "SIGTERM",
        attempt_id: config.attempt_id,
        detail: term,
      })}\n`);
    }
    escalationTimer = setTimeout(() => {
      if (finished) return;
      if (requestedClose && !processGroupExists(child.pid)) {
        finish(requestedClose);
        return;
      }
      const killed = signalExecutorGroup(executorIdentity, "SIGKILL", { anchorLive: !childClosed });
      if (!killed.delivered && !killed.absent) {
        process.stderr.write(`HOST_DIAGNOSTIC ${JSON.stringify({
          code: "HOST_SIGNAL_FAILED",
          signal: "SIGKILL",
          attempt_id: config.attempt_id,
          detail: killed,
        })}\n`);
        return;
      }
      const reapDeadline = Date.now() + Math.max(1_000, config.cancel_grace_ms);
      const reapPoll = setInterval(() => {
        if (finished) {
          clearInterval(reapPoll);
          return;
        }
        if (!processGroupExists(executorIdentity.executor_pgid)) {
          clearInterval(reapPoll);
          finish(requestedClose || {
            status: requestedStatus,
            exit_code: null,
            signal: "SIGKILL",
            error: null,
          });
          return;
        }
        if (Date.now() >= reapDeadline) {
          clearInterval(reapPoll);
          process.stderr.write(`HOST_DIAGNOSTIC ${JSON.stringify({
            code: "HOST_PROCESS_GROUP_SURVIVED_SIGKILL",
            attempt_id: config.attempt_id,
            executor_pgid: executorIdentity.executor_pgid,
          })}\n`);
        }
      }, 25);
    }, config.cancel_grace_ms);
  }

  try {
    stdoutFd = fs.openSync(config.stdout_path, "wx", 0o600);
    stderrFd = fs.openSync(config.stderr_path, "wx", 0o600);
    child = spawn(config.command, config.args, {
      cwd: config.cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    child.once("error", (error) => finish({
      status: "spawn_error",
      exit_code: null,
      signal: null,
      error: error.message,
    }));
    if (!child.pid) return;
    const executorFingerprint = waitForFingerprint(child.pid);
    if (!executorFingerprint) {
      try { child.kill("SIGKILL"); } catch {}
      fail("kernel-stable executor identity is unavailable", "HOST_IDENTITY_UNAVAILABLE", {
        executorPid: child.pid,
      });
    }
    const unsignedExecutor = {
      attempt_id: config.attempt_id,
      host_kind: config.host_kind,
      host_handle: config.host_handle,
      executor_pid: child.pid,
      executor_pgid: child.pid,
      executor_started_at: executorFingerprint.started_at,
      executor_fingerprint: executorFingerprint,
      executor_nonce: crypto.randomBytes(32).toString("hex"),
      config_sha256: expectedSha256,
      started_at: new Date().toISOString(),
    };
    executorIdentity = Object.freeze({ ...unsignedExecutor });
    atomicWriteFile(config.executor_path, `${JSON.stringify({
      ...unsignedExecutor,
      executor_auth_sha256: signResult(unsignedExecutor, config.result_auth_key),
    })}\n`);
    if (fs.existsSync(config.cancel_path)) terminate("cancelled");
    const publishedReady = { ...unsignedReady, ready_at: new Date().toISOString() };
    atomicWriteFile(config.ready_path, `${JSON.stringify({
      ...publishedReady,
      ready_auth_sha256: signResult(publishedReady, config.result_auth_key),
    })}\n`);
    child.once("close", (code, signal) => {
      childClosed = true;
      const fields = {
      status: requestedStatus || (code === 0 ? "completed" : "failed"),
      exit_code: code,
      signal: signal || null,
      error: null,
      };
      if (processGroupExists(child.pid)) {
        requestedClose = fields;
        if (!requestedStatus) terminate(fields.status);
      } else {
        finish(fields);
      }
    });
    deadlineTimer = setTimeout(() => terminate("timed_out"), config.timeout_ms);
    cancelPoll = setInterval(() => {
      if (fs.existsSync(config.cancel_path)) terminate("cancelled");
    }, 25);
    process.once("SIGTERM", () => terminate("cancelled"));
    process.once("SIGINT", () => terminate("cancelled"));
  } catch (error) {
    finish({ status: "spawn_error", exit_code: null, signal: null, error: error.message });
  }
}

async function waitForTerminalResult(receipt, { timeoutMs = receipt.timeout_ms + 10_000 } = {}) {
  if (!issuedReceipts.has(receipt)) fail("an issued host receipt is required", "HOST_RECEIPT_INVALID");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(receipt.result_path)) {
      const result = JSON.parse(fs.readFileSync(receipt.result_path, "utf8"));
      const state = receiptStates.get(receipt);
      const { result_auth_sha256: signature, ...unsigned } = result;
      const expectedSignature = signResult(unsigned, state.config.result_auth_key);
      if (
        result.attempt_id === receipt.attempt_id
        && result.host_kind === receipt.host_kind
        && result.host_handle === receipt.host_handle
        && result.lock_id === receipt.lock_id
        && TERMINAL_HOST_STATUSES.has(result.status)
        && typeof signature === "string"
        && signature.length === expectedSignature.length
        && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
      ) {
        return result;
      }
      fail("terminal result does not match its issued host receipt", "HOST_RESULT_MISMATCH");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fail("timed out waiting for terminal host result", "HOST_RESULT_TIMEOUT");
}

function verifySurvivalOutcome({ receiptPath, markerPath, launcherExitCode, startedAt } = {}) {
  if (launcherExitCode !== 0 || !Number.isFinite(startedAt)) {
    fail("launcher must have exited successfully with a recorded start time", "SURVIVAL_GATE_FAILED");
  }
  const receiptRoot = requireDirectory(path.dirname(path.resolve(receiptPath)), "survival receipt root");
  const safeReceipt = containedPath(receiptRoot, receiptPath, "survival receipt", { mustExist: true, directChild: true });
  const receipt = JSON.parse(fs.readFileSync(safeReceipt, "utf8"));
  const runDir = requireDirectory(receipt.run_dir, "survival runDir");
  const resultPath = containedPath(runDir, receipt.result_path, "survival result", { mustExist: true, directChild: true });
  containedPath(receiptRoot, markerPath, "survival marker", { mustExist: true, directChild: true });
  const resultBytes = fs.readFileSync(resultPath);
  const result = JSON.parse(resultBytes.toString("utf8"));
  if (
    result.status !== "completed"
    || result.attempt_id !== receipt.attempt_id
    || result.host_kind !== receipt.host_kind
    || result.host_handle !== receipt.host_handle
    || result.lock_id !== receipt.lock_id
  ) fail("survival result does not match the launcher receipt", "SURVIVAL_GATE_FAILED");
  const outcome = Object.freeze({
    trial_id: receipt.attempt_id,
    launcher_exit: true,
    status: "completed",
    duration_ms: Date.parse(result.completed_at) - startedAt,
    host_kind: result.host_kind,
    host_handle: result.host_handle,
    result_sha256: sha256(resultBytes),
  });
  issuedSurvivalOutcomes.add(outcome);
  return outcome;
}

function runSurvivalTrial({ runDir, trialId, timeoutMs = 20_000 } = {}) {
  const canonicalRunDir = requireDirectory(runDir, "runDir");
  safeAttemptId(trialId);
  const receiptPath = containedPath(canonicalRunDir, path.join(canonicalRunDir, `survival-${trialId}.receipt.json`), "survival receipt");
  const markerPath = containedPath(canonicalRunDir, path.join(canonicalRunDir, `survival-${trialId}.marker`), "survival marker");
  const startedAt = Date.now();
  const launcherTimeoutMs = timeoutMs + 30_000;
  const launcher = spawnSync(process.execPath, [
    __filename, "--survival-launcher", canonicalRunDir, trialId, receiptPath, markerPath, String(timeoutMs),
  ], { encoding: "utf8", timeout: launcherTimeoutMs });
  if (launcher.status !== 0) {
    fail(`survival launcher failed: ${launcher.stderr || launcher.error?.message || "unknown"}`, "SURVIVAL_GATE_FAILED");
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (!waitForFile(receipt.result_path, timeoutMs)) fail("survival result timed out", "SURVIVAL_GATE_FAILED");
  const outcome = verifySurvivalOutcome({
    receiptPath,
    markerPath,
    launcherExitCode: launcher.status,
    startedAt,
  });
  return outcome;
}

function issueSurvivalMeasurement(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length < 20) fail("at least 20 survival outcomes are required", "SURVIVAL_GATE_FAILED");
  if (outcomes.some((row) => !issuedSurvivalOutcomes.has(row))) {
    fail("survival outcomes must be internally verified launcher results", "SURVIVAL_GATE_FAILED");
  }
  for (const field of ["trial_id", "host_handle", "result_sha256"]) {
    if (new Set(outcomes.map((row) => row[field])).size !== outcomes.length) {
      fail(`survival outcomes must have distinct ${field} values`, "SURVIVAL_GATE_FAILED");
    }
  }
  const measurement = Object.freeze({
    trials: outcomes.length,
    losses: 0,
    launcher_exit: true,
    measured_at: new Date().toISOString(),
    outcomes_sha256: sha256(JSON.stringify(outcomes)),
  });
  issuedMeasurements.add(measurement);
  return measurement;
}

function cliErrorText(error) {
  const diagnostic = {
    name: error?.name || "Error",
    code: error?.code || null,
    message: error?.message || String(error),
  };
  for (const field of [
    "status", "signal", "killed", "hostHandle", "primitive", "recommended_action",
    "attemptId", "supervisorPid", "supervisorProcessStartedAt", "readyPath",
    "startupStderrPath", "startupStderr", "elapsedMs", "liveness",
    "failures", "bootout", "remove", "state", "after",
  ]) {
    if (error?.[field] !== undefined) diagnostic[field] = error[field];
  }
  return `${error?.stack || error?.message || String(error)}\nHOST_DIAGNOSTIC ${JSON.stringify(diagnostic)}\n`;
}

if (require.main === module) {
  if (process.argv[2] === "--supervise" && process.argv[3]) {
    try {
      runSupervisor(process.argv[3], process.argv[4]);
    } catch (error) {
      process.stderr.write(cliErrorText(error));
      process.exitCode = 1;
    }
  } else if (process.argv[2] === "--survival-launcher") {
    try {
      const [, , , rawRunDir, trialId, receiptPath, markerPath, rawTimeout] = process.argv;
      const canonicalRunDir = requireDirectory(rawRunDir, "runDir");
      const receipt = launchLocalSupervisor({
        runDir: canonicalRunDir,
        attemptId: trialId,
        command: process.execPath,
        args: [__filename, "--survival-worker", markerPath],
        cwd: canonicalRunDir,
        timeoutMs: Number(rawTimeout),
      });
      fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
    } catch (error) {
      process.stderr.write(cliErrorText(error));
      process.exitCode = 1;
    }
  } else if (process.argv[2] === "--survival-worker") {
    fs.writeFileSync(process.argv[3], `completed:${process.pid}\n`, "utf8");
  } else {
    process.stderr.write("Usage: host.js --supervise <config-path>\n");
    process.exitCode = 2;
  }
}

module.exports = {
  ATTEMPT_ID_RE,
  HOST_KINDS,
  HostError,
  LOCK_FILENAME,
  MIN_BREAK_PROBE_INTERVAL_MS,
  TERMINAL_HOST_STATUSES,
  acquireRunLock,
  assertRunLockHeld,
  breakStaleRunLock,
  captureLocalProcessIdentity,
  cancelHost,
  captureLivenessProbe,
  inspectOwnership,
  issueSurvivalMeasurement,
  launchLocalSupervisor,
  lockPathFor,
  probeHostEnvironment,
  probeLocalProcess,
  readOwner: readOwnerPublic,
  releaseRunLock,
  resumePendingTerminal,
  resumePendingBreak,
  observeWorktree,
  runSurvivalTrial,
  selectHost,
  terminalResultProof,
  waitForTerminalResult,
  withRunLock,
  __testing: Object.freeze({
    cliErrorText,
  }),
};
