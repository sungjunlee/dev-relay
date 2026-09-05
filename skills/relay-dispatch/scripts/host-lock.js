"use strict";

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BREAK_PROBE_MS = 10_000;

let fail;
let PROCESS_SCOPE_KEY;
let PROVIDER_UNAVAILABLE;
let canonicalDir;
let safeAttempt;
let waitFingerprint;
let readLedger;
let validateOwner;
let publishOnce;
let base;
let issuedLocks;
let lockStates;
let emitAudit;
let replayReleaseReceipts;
let sha256;
let signed;
let issuedInspections;
let inspectionStates;
let attemptPaths;
let settleCleanup;
let directChild;
let secureRead;
let validTerminal;
let assertRunLockHeld;
let closeState;
let reclaimQuarantined;
let syncDir;
let exactIdentity;
let readBoundArtifact;
let probeIdentity;
let groupExists;

function attach(host) {
  fail = host.fail;
  PROCESS_SCOPE_KEY = host.PROCESS_SCOPE_KEY;
  PROVIDER_UNAVAILABLE = host.PROVIDER_UNAVAILABLE;
  canonicalDir = host.canonicalDir;
  safeAttempt = host.safeAttempt;
  waitFingerprint = host.waitFingerprint;
  readLedger = host.readLedger;
  validateOwner = host.validateOwner;
  publishOnce = host.publishOnce;
  base = host.base;
  issuedLocks = host.issuedLocks;
  lockStates = host.lockStates;
  emitAudit = host.emitAudit;
  replayReleaseReceipts = host.replayReleaseReceipts;
  sha256 = host.sha256;
  signed = host.signed;
  issuedInspections = host.issuedInspections;
  inspectionStates = host.inspectionStates;
  attemptPaths = host.attemptPaths;
  settleCleanup = host.settleCleanup;
  directChild = host.directChild;
  secureRead = host.secureRead;
  validTerminal = host.validTerminal;
  assertRunLockHeld = host.assertRunLockHeld;
  closeState = host.closeState;
  reclaimQuarantined = host.reclaimQuarantined;
  syncDir = host.syncDir;
  exactIdentity = host.exactIdentity;
  readBoundArtifact = host.readBoundArtifact;
  probeIdentity = host.probeIdentity;
  groupExists = host.groupExists;
}

let linuxClockTicks = null;
let linuxBootSeconds = null;
function linuxProcessRows({ environment = false, pid = null } = {}) {
  if (linuxClockTicks === null) {
    const getconf = fs.existsSync("/usr/bin/getconf") ? "/usr/bin/getconf" : "/bin/getconf";
    const clockTicks = Number(execFileSync(getconf, ["CLK_TCK"], { encoding: "utf8", timeout: 5_000 }).trim());
    const bootLine = fs.readFileSync("/proc/stat", "utf8").split(/\r?\n/).find((line) => line.startsWith("btime "));
    const bootSeconds = Number(bootLine?.slice(6));
    if (!Number.isFinite(clockTicks) || clockTicks <= 0 || !Number.isFinite(bootSeconds)) {
      fail("Linux process clock metadata is unavailable", "HOST_IDENTITY_UNAVAILABLE");
    }
    linuxClockTicks = clockTicks;
    linuxBootSeconds = bootSeconds;
  }
  const pids = pid === null ? fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)) : [String(pid)];
  const rows = [];
  for (const name of pids) {
    try {
      const raw = fs.readFileSync(`/proc/${name}/stat`, "utf8"), close = raw.lastIndexOf(")");
      if (close < 0) continue;
      const fields = raw.slice(close + 2).trim().split(/\s+/), observedPid = Number(raw.slice(0, raw.indexOf(" ")));
      const state = fields[0], ppid = Number(fields[1]), pgid = Number(fields[2]), startedTicks = Number(fields[19]);
      if (![observedPid, ppid, pgid, startedTicks].every(Number.isFinite)) continue;
      const command = "";
      let scope = null;
      if (environment) {
        try {
          const entries = fs.readFileSync(`/proc/${name}/environ`).toString("utf8").split("\0");
          const value = entries.find((entry) => entry.startsWith(`${PROCESS_SCOPE_KEY}=`));
          scope = value?.slice(PROCESS_SCOPE_KEY.length + 1) || null;
        } catch { /* another user's environment is intentionally unreadable */ }
      }
      const startedAt = new Date((linuxBootSeconds + startedTicks / linuxClockTicks) * 1000).toISOString();
      rows.push({ pid: observedPid, ppid, pgid, command, scope,
        identity: Object.freeze({ pid: observedPid, pgid, state, started_at: startedAt }) });
    } catch { /* process exited between /proc enumeration and observation */ }
  }
  return rows;
}
function acquireRunLock({ runDir, attemptId, operation, host = os.hostname(), hostHandle, pid = process.pid, worktreeDir = process.cwd(), audit } = {}) {
  const run = canonicalDir(runDir, "runDir"), worktree = canonicalDir(worktreeDir, "worktreeDir"); safeAttempt(attemptId);
  if (typeof operation !== "string" || !operation) fail("operation is required", "INVALID_OPERATION");
  const processIdentity = waitFingerprint(pid);
  if (!processIdentity) fail("stable owner identity unavailable", "HOST_IDENTITY_UNAVAILABLE", { recommended_action: "inspect" });
  const worktreeStat = fs.statSync(worktree);
  let ownerPath, owner;
  while (true) {
    const ledger = readLedger(run, true);
    if (ledger.active) fail("run lock is already held", "LOCK_HELD", { lockPath: ledger.active.ownerPath });
    owner = validateOwner({ v: 2, generation: ledger.next, lock_id: crypto.randomUUID(), secret: crypto.randomBytes(32).toString("hex"),
      attempt_id: attemptId, operation, host, host_handle: hostHandle || `${operation}:${process.pid}:${crypto.randomBytes(6).toString("hex")}`,
      process: processIdentity, acquired_at: new Date().toISOString(), worktree: { path: worktree, dev: worktreeStat.dev, ino: worktreeStat.ino } });
    ownerPath = path.join(ledger.directory, `${base(owner.generation)}.owner.json`);
    if (publishOnce(ownerPath, owner)) break;
  }
  const fd = fs.openSync(ownerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const stat = fs.fstatSync(fd), capability = Object.freeze({ lock_id: owner.lock_id, attempt_id: owner.attempt_id, operation,
    run_dir: run, host_kind: "local_supervisor", host_handle: owner.host_handle });
  const state = { capability, runDir: run, ownerPath, fd, inode: { dev: stat.dev, ino: stat.ino }, owner, released: false };
  issuedLocks.add(capability); lockStates.set(capability, state);
  try { emitAudit(audit, "lock_acquired", state); replayReleaseReceipts(state, audit); }
  catch (cause) {
    const body = { v: 2, generation: owner.generation, lock_id: owner.lock_id, owner_sha256: sha256(fs.readFileSync(ownerPath)),
      outcome: "broken", release_outcome: null, reason: "acquisition_audit_failed", proof: null, closed_at: new Date().toISOString() };
    publishOnce(path.join(path.dirname(ownerPath), `${base(owner.generation)}.closed.json`), signed(body, owner.secret));
    state.released = true; fs.closeSync(fd); fail("lock acquisition audit failed", "LOCK_AUDIT_FAILED", { cause });
  }
  return capability;
}
function probeOwner(owner, runDir) {
  if (owner.host !== os.hostname()) return { status: "unknown", reason: "foreign_host" };
  const paths = attemptPaths(runDir, owner.attempt_id);
  const resultPath = path.join(runDir, `attempt-${owner.attempt_id}.result.json`);
  if (fs.existsSync(resultPath)) {
    try { if (validTerminal(secureRead(resultPath, "terminal result").value, owner)) return { status: "dead", reason: "terminal_result", identity_matches: false }; }
    catch { return { status: "unknown", reason: "terminal_result_invalid" }; }
  }
  if (fs.existsSync(paths.cleanup)) return { status: "unknown", reason: "cleanup_incomplete" };
  if (fs.existsSync(paths.running)) {
    try {
      const running = readBoundArtifact(paths.running, "running identity", owner);
      const supervisor = probeIdentity(running.supervisor), executor = probeIdentity(running.executor);
      if (supervisor.status === "live" || executor.status === "live") return { status: "live", reason: "durable_process_live" };
      if (supervisor.status === "dead" && executor.status === "dead" && !groupExists(running.executor.pgid)) return { status: "dead", reason: "durable_processes_dead", identity_matches: false };
      return { status: "unknown", reason: "durable_process_unknown" };
    } catch { return { status: "unknown", reason: "running_identity_invalid" }; }
  }
  if (fs.existsSync(paths.supervisor)) {
    try { return probeIdentity(readBoundArtifact(paths.supervisor, "supervisor identity", owner).supervisor); }
    catch { return { status: "unknown", reason: "supervisor_identity_invalid" }; }
  }
  if (fs.existsSync(paths.config)) return { status: "unknown", reason: "launch_identity_missing" };
  return probeIdentity(owner.process);
}
function cleanupObligation(value, runDir, owner) {
  void runDir; void owner;
  const obligation = value?.obligation, staged = obligation?.staged_input_root;
  if (!value || !["executor", "reviewer"].includes(value.kind)
    || !obligation || typeof obligation !== "object" || Array.isArray(obligation)
    || Object.keys(obligation).sort().join(",") !== "processes,scope_seal,staged_input_root") {
    fail("cleanup obligation is invalid", "HOST_ARTIFACT_INVALID");
  }
  const reviewerRoot = value.kind === "reviewer" && staged && typeof staged.path === "string"
    && path.dirname(staged.path) === fs.realpathSync("/tmp") && /^relay-review-[A-Za-z0-9_-]+$/.test(path.basename(staged.path));
  if (!Array.isArray(obligation.processes) || (value.kind === "reviewer" ? !reviewerRoot : staged !== null)
    || (value.kind === "reviewer" && (!Number.isInteger(staged.dev) || !Number.isInteger(staged.ino)))) {
    fail("cleanup obligation is invalid", "HOST_ARTIFACT_INVALID");
  }
  const identities = value.identities, terminal = value.terminal;
  if (!identities || (value.kind !== "reviewer" && !identities.supervisor) || (identities.executor !== null && !identities.executor)) fail("cleanup host identities are invalid", "HOST_ARTIFACT_INVALID");
  if (identities.supervisor) exactIdentity(identities.supervisor, "cleanup supervisor"); if (identities.executor) exactIdentity(identities.executor, "cleanup executor");
  const processes = obligation.processes.map((identity, index) => exactIdentity(identity, `cleanup process ${index}`));
  if (new Set(processes.map((identity) => identity.pid)).size !== processes.length) fail("cleanup process identities are duplicated", "HOST_ARTIFACT_INVALID");
  const seal = obligation.scope_seal ?? null;
  if (seal !== null && !/^[0-9a-f]{64}$/.test(seal)) fail("cleanup process scope seal is invalid", "HOST_ARTIFACT_INVALID");
  if (!terminal || !["completed", "failed", "cancelled", "timed_out", "spawn_error"].includes(terminal.status)
    || (terminal.exit_code !== null && !Number.isInteger(terminal.exit_code)) || (terminal.signal !== null && typeof terminal.signal !== "string")
    || (terminal.termination !== undefined && terminal.termination !== PROVIDER_UNAVAILABLE)) fail("cleanup terminal context is invalid", "HOST_ARTIFACT_INVALID");
  return { kind: value.kind, processes, staged_input_root: staged ? { ...staged } : null, scope_seal: seal, terminal };
}
// Swap-safe removal: rename the bound directory to a unique sibling quarantine first, then re-verify the
// signed dev/ino on the quarantine target. A mismatch means the path was swapped, so the swapped tree is
// preserved as evidence at its quarantine path and never deleted.
function removeBoundDirectory(target, expected, label, { fault, reclaim = true } = {}) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    // An absent pathname is only proof of cleanup when no quarantine still holds the signed identity.
    // A prior attempt may have renamed the bound directory aside and then failed to remove or roll it
    // back, so resume on the quarantine rather than reading ENOENT as success and orphaning it.
    if (error.code === "ENOENT") return reclaim && expected ? reclaimQuarantined(target, expected, label, { fault }) : false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is not a real directory`, "HOST_CLEANUP_INCOMPLETE", { recommended_action: "inspect" });
  const binding = expected || { dev: stat.dev, ino: stat.ino };
  if (stat.dev !== binding.dev || stat.ino !== binding.ino) fail(`${label} identity changed before cleanup`, "HOST_CLEANUP_INCOMPLETE", { recommended_action: "inspect" });
  const quarantine = path.join(path.dirname(target), `.${path.basename(target)}.quarantine.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  fs.renameSync(target, quarantine);
  const moved = fs.lstatSync(quarantine);
  if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== binding.dev || moved.ino !== binding.ino) {
    fail(`${label} was replaced before quarantined removal`, "HOST_CLEANUP_INCOMPLETE", { recommended_action: "inspect", quarantinePath: quarantine });
  }
  try { fault?.("after_quarantine"); fs.rmSync(quarantine, { recursive: true, force: true }); }
  catch (cause) {
    try {
      const retained = fs.lstatSync(quarantine);
      if (!retained.isDirectory() || retained.isSymbolicLink() || retained.dev !== binding.dev || retained.ino !== binding.ino || fs.existsSync(target)) throw new Error("quarantine identity or original pathname changed before rollback");
      fs.renameSync(quarantine, target);
      const restored = fs.lstatSync(target);
      if (!restored.isDirectory() || restored.isSymbolicLink() || restored.dev !== binding.dev || restored.ino !== binding.ino) throw new Error("rolled-back directory identity changed");
      syncDir(path.dirname(target));
    } catch (rollbackCause) { fail(`${label} quarantined removal and rollback failed; evidence retained`, "HOST_CLEANUP_INCOMPLETE",
      { recommended_action: "inspect", quarantinePath: quarantine, cause, rollbackCause }); }
    fail(`${label} quarantined removal failed and was rolled back`, "HOST_CLEANUP_INCOMPLETE", { recommended_action: "inspect", cause });
  }
  syncDir(path.dirname(target)); return true;
}
async function breakStaleRunLock({ inspection, reason, resultPath, audit, fault } = {}) {
  if (!issuedInspections.has(inspection) || typeof reason !== "string" || !reason.trim()) fail("issued inspection and reason required", "INSPECTION_CAPABILITY_INVALID");
  const observedState = inspectionStates.get(inspection); let proof;
  const cleanupPath = attemptPaths(observedState.runDir, observedState.owner.attempt_id).cleanup;
  if (!resultPath && fs.existsSync(cleanupPath)) {
    const ledger = readLedger(observedState.runDir), active = ledger.active;
    if (!active || sha256(active.raw) !== observedState.ownerDigest) fail("owner changed after inspection", "LOCK_CHANGED");
    resultPath = settleCleanup({ state: { runDir: observedState.runDir, owner: active.owner }, cleanupPath, fault });
  }
  if (resultPath && fs.existsSync(resultPath)) {
    const safe = directChild(observedState.runDir, resultPath, "terminal result", { exists: true });
    const read = secureRead(safe, "terminal result");
    if (!validTerminal(read.value, observedState.owner)) fail("terminal result is unauthenticated", "BREAK_EVIDENCE_INSUFFICIENT");
    proof = { kind: "terminal_result", result_sha256: sha256(read.bytes) };
  } else {
    if (inspection.status !== "stale") fail("unknown owner requires terminal proof", "BREAK_EVIDENCE_INSUFFICIENT");
    const first = probeOwner(observedState.owner, observedState.runDir);
    if (first.status !== "dead" || first.identity_matches !== false) fail("first liveness probe is not dead", "BREAK_EVIDENCE_INSUFFICIENT");
    await new Promise((resolve) => setTimeout(resolve, BREAK_PROBE_MS));
    const second = probeOwner(observedState.owner, observedState.runDir);
    if (second.status !== "dead" || second.identity_matches !== false) fail("second liveness probe is not dead", "BREAK_EVIDENCE_INSUFFICIENT");
    proof = { kind: "two_dead_probes", first_at: new Date(Date.now() - BREAK_PROBE_MS).toISOString(), second_at: new Date().toISOString() };
  }
  const ledger = readLedger(observedState.runDir), active = ledger.active;
  if (!active || sha256(active.raw) !== observedState.ownerDigest) fail("owner changed after inspection", "LOCK_CHANGED");
  const fd = fs.openSync(active.ownerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), stat = fs.fstatSync(fd);
  const capability = Object.freeze({ lock_id: active.owner.lock_id, attempt_id: active.owner.attempt_id, operation: active.owner.operation,
    run_dir: observedState.runDir, host_kind: "local_supervisor", host_handle: active.owner.host_handle });
  const state = { capability, runDir: observedState.runDir, ownerPath: active.ownerPath, fd, inode: { dev: stat.dev, ino: stat.ino }, owner: active.owner, released: false };
  issuedLocks.add(capability); lockStates.set(capability, state);
  try { assertRunLockHeld(capability, state.runDir); return closeState(state, "broken", null, reason, proof, audit); }
  catch (error) { try { fs.closeSync(fd); } catch {}; throw error; }
}

module.exports = {
  attach,
  linuxProcessRows,
  acquireRunLock,
  breakStaleRunLock,
  removeBoundDirectory,
  cleanupObligation,
  probeOwner,
};
