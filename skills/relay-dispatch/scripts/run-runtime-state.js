"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { ensureRunLayout, getRunDir } = require("./manifest/paths");
const { readRunEvents } = require("./relay-events");

const LEASE_FILENAME = "lease.json";
const DISPATCH_STDOUT_LOG = "dispatch-stdout.log";
const DISPATCH_STDERR_LOG = "dispatch-stderr.log";
const DISPATCH_RESULT_FILE = "dispatch-result.txt";
const LEASE_DEATH_CONFIRM_DELAY_MS = 50;
const ADVISORY_LANE_LEASE_RE = /^review-round-(\d+)-advisory-(.+)-lane-lease\.json$/;
const DEFAULT_ADVISORY_LANE_REAP_GRACE_MS = 3000;

let posixProcessStateInspectionUnavailable = false;

function probeProcessGroup(pgid) {
  const normalizedPgid = Number(pgid);
  if (process.env.RELAY_TEST_PROCESS_GROUP_ALIVE_EPERM === String(normalizedPgid)) {
    const error = new Error("operation not permitted");
    error.code = "EPERM";
    throw error;
  }
  process.kill(process.platform === "win32" ? normalizedPgid : -normalizedPgid, 0);
}

function readTestProcessGroupStates(pgid) {
  const raw = process.env.RELAY_TEST_PROCESS_GROUP_STATES;
  if (!raw) return null;
  try {
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return null;
    return rows
      .filter((row) => Number(row?.pgid) === Number(pgid))
      .map((row) => String(row?.stat ?? row?.state ?? "").trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function readPosixProcessGroupStates(pgid) {
  const testStates = readTestProcessGroupStates(pgid);
  if (testStates) return testStates;
  if (process.platform === "win32") return null;
  if (posixProcessStateInspectionUnavailable) return null;
  try {
    const output = execFileSync("ps", ["-axo", "pgid=,stat="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
      maxBuffer: 1024 * 1024,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim().match(/^(-?\d+)\s+(\S+)/))
      .filter((match) => match && Number(match[1]) === Number(pgid))
      .map((match) => match[2]);
  } catch {
    posixProcessStateInspectionUnavailable = true;
    return null;
  }
}

function isZombieProcessState(stat) {
  return String(stat || "").trim().toUpperCase().startsWith("Z");
}

function isZombieOnlyProcessGroup(pgid) {
  const states = readPosixProcessGroupStates(pgid);
  return Array.isArray(states) && states.length > 0 && states.every(isZombieProcessState);
}

function isProcessGroupAlive(pgid) {
  if (!pgid || !Number.isFinite(Number(pgid))) return false;
  const normalizedPgid = Number(pgid);
  try {
    probeProcessGroup(normalizedPgid);
    return !isZombieOnlyProcessGroup(normalizedPgid);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return !isZombieOnlyProcessGroup(normalizedPgid);
    return false;
  }
}

function probeProcess(pid) {
  const normalizedPid = Number(pid);
  const probeLog = process.env.RELAY_TEST_PROCESS_PROBE_LOG;
  if (probeLog) {
    fs.appendFileSync(probeLog, `${normalizedPid}\n`, "utf-8");
  }
  process.kill(normalizedPid, 0);
}

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    probeProcess(Number(pid));
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    return false;
  }
}

function terminateProcessGroup(pgid) {
  if (!pgid || !Number.isFinite(Number(pgid))) return;
  try {
    if (process.platform === "win32") {
      require("child_process").execFileSync("taskkill", ["/PID", String(pgid), "/T", "/F"], { stdio: "pipe" });
    } else {
      process.kill(-Number(pgid), "SIGTERM");
    }
  } catch {}
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessGroupExit(pgid, { timeoutMs = 1500, intervalMs = 50 } = {}) {
  if (!pgid || !Number.isFinite(Number(pgid))) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pgid)) return true;
    await sleepAsync(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  return !isProcessGroupAlive(pgid);
}

function getLeasePath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), LEASE_FILENAME);
}

function getRunArtifactPaths(repoRoot, runId) {
  const runDir = getRunDir(repoRoot, runId);
  return {
    runDir,
    resultFile: path.join(runDir, DISPATCH_RESULT_FILE),
    stdoutLog: path.join(runDir, DISPATCH_STDOUT_LOG),
    stderrLog: path.join(runDir, DISPATCH_STDERR_LOG),
    leasePath: path.join(runDir, LEASE_FILENAME),
  };
}

function dispatchManifestPathFields(paths) {
  return {
    dispatch_result: paths.resultFile,
    dispatch_stdout: paths.stdoutLog,
    dispatch_stderr: paths.stderrLog,
    lease: paths.leasePath,
  };
}

function uniqueExistingOrder(values) {
  const seen = new Set();
  return values
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .map((value) => path.resolve(value))
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function getDispatchResultCandidates(repoRoot, runId, manifest = {}) {
  const runPaths = getRunArtifactPaths(repoRoot, runId);
  const paths = manifest.paths || {};
  const hasPhase2DispatchPath = ["dispatch_result", "dispatch_stdout", "dispatch_stderr", "lease"]
    .some((field) => typeof paths[field] === "string" && paths[field].trim() !== "");
  return uniqueExistingOrder([
    paths.dispatch_result,
    hasPhase2DispatchPath ? null : paths.result_file,
    runPaths.resultFile,
  ]);
}

function latestRunEvent(repoRoot, runId) {
  const events = readRunEvents(repoRoot, runId);
  return events.length ? events[events.length - 1] : null;
}

function normalizeLease(raw) {
  const pid = Number(raw?.pid);
  const pgid = Number(raw?.pgid);
  const host = typeof raw?.host === "string" ? raw.host.trim() : "";
  const startedAt = typeof raw?.started_at === "string" ? raw.started_at.trim() : "";
  const timeoutS = Number(raw?.timeout_s);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("lease.json pid must be a positive integer");
  }
  if (!Number.isInteger(pgid) || pgid <= 0) {
    throw new Error("lease.json pgid must be a positive integer");
  }
  if (!host) {
    throw new Error("lease.json host must be set");
  }
  if (!startedAt || Number.isNaN(Date.parse(startedAt))) {
    throw new Error("lease.json started_at must be an ISO timestamp");
  }
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    throw new Error("lease.json timeout_s must be a positive number");
  }
  return { pid, pgid, host, started_at: startedAt, timeout_s: timeoutS };
}

function readRunLease(repoRoot, runId) {
  const leasePath = getLeasePath(repoRoot, runId);
  try {
    return normalizeLease(JSON.parse(fs.readFileSync(leasePath, "utf-8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`invalid run lease at ${leasePath}: ${error.message}`);
  }
}

function buildCorruptRunLeaseStatus(leasePath, error) {
  return {
    exists: true,
    lease: null,
    leasePath,
    live: false,
    canSignal: false,
    reason: "corrupt",
    status: "corrupt",
    elapsed_s: null,
    remaining_s: null,
    error: error.message,
  };
}

function corruptRunLeaseReportFields(status) {
  if (status?.reason !== "corrupt") return {};
  return {
    leaseStatus: "corrupt",
    leasePath: status.leasePath,
    leaseError: status.error || "invalid run lease",
  };
}

function corruptRunLeaseEventFields(status) {
  if (status?.reason !== "corrupt") return {};
  return {
    status: "corrupt",
    failure_class: "corrupt_run_lease",
    failure_reason: status.error || "invalid run lease",
    artifact_path: status.leasePath,
  };
}

function writeRunLease(repoRoot, runId, { pid = process.pid, pgid, host = os.hostname(), startedAt = new Date().toISOString(), timeoutS }) {
  ensureRunLayout(repoRoot, runId);
  const lease = normalizeLease({
    pid,
    pgid,
    host,
    started_at: startedAt,
    timeout_s: timeoutS,
  });
  const leasePath = getLeasePath(repoRoot, runId);
  fs.writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`, "utf-8");
  return { lease, leasePath };
}

function removeRunLease(repoRoot, runId) {
  const leasePath = getLeasePath(repoRoot, runId);
  fs.rmSync(leasePath, { force: true });
  return leasePath;
}

function getRunLeaseStatus(repoRoot, runId) {
  const leasePath = getLeasePath(repoRoot, runId);
  let lease = null;
  try {
    lease = readRunLease(repoRoot, runId);
  } catch (error) {
    return buildCorruptRunLeaseStatus(leasePath, error);
  }
  if (!lease) {
    return {
      exists: false,
      lease: null,
      leasePath,
      live: false,
      canSignal: false,
      reason: "absent",
      elapsed_s: null,
      remaining_s: null,
    };
  }

  const elapsedS = Math.max(0, Math.floor((Date.now() - Date.parse(lease.started_at)) / 1000));
  const remainingS = Math.max(0, Math.ceil(Number(lease.timeout_s) - elapsedS));
  if (lease.host !== os.hostname()) {
    return {
      exists: true,
      lease,
      leasePath,
      live: false,
      canSignal: false,
      reason: "host_mismatch",
      elapsed_s: elapsedS,
      remaining_s: remainingS,
    };
  }

  // The lease pid is the dispatch supervisor and is the authoritative liveness
  // signal. The executor pgid may outlive it because unrelated inheritors (for
  // example Codex desktop's SkyComputerUseClient notifier) can linger there.
  const live = isProcessAlive(lease.pid);
  const canSignal = isProcessGroupAlive(lease.pgid);
  return {
    exists: true,
    lease,
    leasePath,
    live,
    canSignal,
    // Keep these legacy reason values stable for existing observer/advisory
    // consumers; liveness_source names the corrected probe explicitly.
    reason: live ? "process_group_alive" : "process_group_dead",
    liveness_source: "lease_supervisor_pid",
    process_group_live: canSignal,
    elapsed_s: elapsedS,
    remaining_s: remainingS,
  };
}

async function confirmRunLeaseSupervisorDeath(status, { intervalMs = LEASE_DEATH_CONFIRM_DELAY_MS } = {}) {
  if (!status?.exists || !status.lease || status.live) {
    return false;
  }
  await sleepAsync(intervalMs);
  return !isProcessAlive(status.lease.pid);
}

function formatLeaseForMessage(status) {
  const lease = status?.lease || status || {};
  return `pid=${lease.pid ?? "unknown"} pgid=${lease.pgid ?? "unknown"} host=${lease.host ?? "unknown"}`;
}

function isDestructiveCleanupBlockedByLease(status) {
  return status.exists && (status.live || status.reason === "host_mismatch");
}

function assertNoLiveRunLease({ repoRoot, runId, force = false, caller = "relay-dispatch" }) {
  const status = getRunLeaseStatus(repoRoot, runId);
  if (isDestructiveCleanupBlockedByLease(status) && !force) {
    const leaseKind = status.reason === "host_mismatch"
      ? "unverifiable host_mismatch lease"
      : "live lease";
    throw new Error(
      `${caller}: refusing to remove worktree for run ${runId}; ${leaseKind} ${formatLeaseForMessage(status)}. ` +
      "Wait for the executor to finish, run reconcile-run.js, or pass --force to override."
    );
  }
  return status;
}

function advisoryLaneLeaseFilename(round, reviewer) {
  return `review-round-${round}-advisory-${reviewer}-lane-lease.json`;
}

function getAdvisoryLaneLeasePath(runDir, round, reviewer) {
  return path.join(runDir, advisoryLaneLeaseFilename(round, reviewer));
}

function normalizeAdvisoryLaneLease(raw) {
  const pid = Number(raw?.pid);
  const pgid = Number(raw?.pgid);
  const host = typeof raw?.host === "string" ? raw.host.trim() : "";
  const startedAt = typeof raw?.started_at === "string" ? raw.started_at.trim() : "";
  const round = Number(raw?.round);
  const reviewer = typeof raw?.reviewer === "string" ? raw.reviewer.trim() : "";
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("advisory lane lease pid must be a positive integer");
  }
  if (!Number.isInteger(pgid) || pgid <= 0) {
    throw new Error("advisory lane lease pgid must be a positive integer");
  }
  if (!host) {
    throw new Error("advisory lane lease host must be set");
  }
  if (!startedAt || Number.isNaN(Date.parse(startedAt))) {
    throw new Error("advisory lane lease started_at must be an ISO timestamp");
  }
  if (!Number.isInteger(round) || round <= 0) {
    throw new Error("advisory lane lease round must be a positive integer");
  }
  if (!reviewer) {
    throw new Error("advisory lane lease reviewer must be set");
  }
  return { pid, pgid, host, started_at: startedAt, round, reviewer };
}

function writeAdvisoryLaneLease(runDir, {
  pid,
  pgid,
  host = os.hostname(),
  startedAt = new Date().toISOString(),
  round,
  reviewer,
}) {
  if (typeof runDir !== "string" || !runDir.trim()) {
    throw new Error("writeAdvisoryLaneLease requires runDir");
  }
  fs.mkdirSync(runDir, { recursive: true });
  const lease = normalizeAdvisoryLaneLease({
    pid,
    pgid,
    host,
    started_at: startedAt,
    round,
    reviewer,
  });
  const leasePath = getAdvisoryLaneLeasePath(runDir, lease.round, lease.reviewer);
  fs.writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`, "utf-8");
  return { lease, leasePath };
}

function removeAdvisoryLaneLease(runDir, round, reviewer) {
  const leasePath = getAdvisoryLaneLeasePath(runDir, round, reviewer);
  fs.rmSync(leasePath, { force: true });
  return leasePath;
}

function readAdvisoryLaneLeases(runDir) {
  if (typeof runDir !== "string" || !runDir.trim()) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(runDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const leases = [];
  for (const name of entries) {
    const match = name.match(ADVISORY_LANE_LEASE_RE);
    if (!match) continue;
    const leasePath = path.join(runDir, name);
    try {
      const lease = normalizeAdvisoryLaneLease(JSON.parse(fs.readFileSync(leasePath, "utf-8")));
      leases.push({ lease, leasePath });
    } catch (error) {
      leases.push({
        lease: null,
        leasePath,
        corrupt: true,
        error: error.message,
        round: Number(match[1]) || null,
        reviewer: match[2] || null,
      });
    }
  }
  return leases.sort((a, b) => {
    const roundA = a.lease?.round ?? a.round ?? 0;
    const roundB = b.lease?.round ?? b.round ?? 0;
    if (roundA !== roundB) return roundA - roundB;
    const reviewerA = a.lease?.reviewer ?? a.reviewer ?? "";
    const reviewerB = b.lease?.reviewer ?? b.reviewer ?? "";
    return reviewerA.localeCompare(reviewerB);
  });
}

function signalProcessGroup(pgid, signal) {
  if (!pgid || !Number.isFinite(Number(pgid))) return;
  try {
    if (process.platform === "win32") {
      require("child_process").execFileSync("taskkill", ["/PID", String(pgid), "/T", "/F"], { stdio: "pipe" });
    } else {
      process.kill(-Number(pgid), signal);
    }
  } catch (error) {
    if (error.code === "ESRCH") return;
    // Best-effort: finalize continues even if an unexpected signal error occurs.
  }
}

function sleepSync(ms) {
  const waitMs = Math.max(0, Number(ms) || 0);
  if (waitMs <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
}

function waitForProcessGroupExitSync(pgid, { timeoutMs = 1500, intervalMs = 50 } = {}) {
  if (!pgid || !Number.isFinite(Number(pgid))) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pgid)) return true;
    sleepSync(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  return !isProcessGroupAlive(pgid);
}

function resolveAdvisoryLaneReapGraceMs(explicitMs) {
  if (Number.isFinite(Number(explicitMs)) && Number(explicitMs) >= 0) {
    return Number(explicitMs);
  }
  const fromEnv = Number(process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return DEFAULT_ADVISORY_LANE_REAP_GRACE_MS;
}

function reapAdvisoryLaneLeases({
  runDir,
  dryRun = false,
  graceMs,
  host = os.hostname(),
} = {}) {
  const grace = resolveAdvisoryLaneReapGraceMs(graceMs);
  const entries = readAdvisoryLaneLeases(runDir);
  const outcomes = [];

  for (const entry of entries) {
    if (entry.corrupt || !entry.lease) {
      outcomes.push({
        pgid: null,
        reviewer: entry.reviewer || null,
        round: entry.round || null,
        outcome: dryRun ? "would_remove_corrupt" : "corrupt",
        leasePath: entry.leasePath,
        error: entry.error || "invalid advisory lane lease",
      });
      if (!dryRun) {
        fs.rmSync(entry.leasePath, { force: true });
      }
      continue;
    }

    const { lease, leasePath } = entry;
    const base = {
      pgid: lease.pgid,
      pid: lease.pid,
      reviewer: lease.reviewer,
      round: lease.round,
      host: lease.host,
      leasePath,
    };

    if (lease.host !== host) {
      outcomes.push({
        ...base,
        outcome: "skipped_host_mismatch",
      });
      continue;
    }

    if (!isProcessGroupAlive(lease.pgid)) {
      outcomes.push({
        ...base,
        outcome: dryRun ? "would_remove_stale" : "stale",
      });
      if (!dryRun) {
        removeAdvisoryLaneLease(runDir, lease.round, lease.reviewer);
      }
      continue;
    }

    if (dryRun) {
      outcomes.push({
        ...base,
        outcome: "would_reap",
      });
      continue;
    }

    signalProcessGroup(lease.pgid, "SIGTERM");
    waitForProcessGroupExitSync(lease.pgid, { timeoutMs: grace });
    let signaledKill = false;
    if (isProcessGroupAlive(lease.pgid)) {
      signaledKill = true;
      signalProcessGroup(lease.pgid, "SIGKILL");
      waitForProcessGroupExitSync(lease.pgid, { timeoutMs: grace });
    }

    const gone = !isProcessGroupAlive(lease.pgid);
    if (gone) {
      removeAdvisoryLaneLease(runDir, lease.round, lease.reviewer);
      outcomes.push({
        ...base,
        outcome: "reaped",
        signaled_kill: signaledKill,
      });
    } else {
      outcomes.push({
        ...base,
        outcome: "reap_failed",
        signaled_kill: signaledKill,
      });
    }
  }

  return outcomes;
}

module.exports = {
  ADVISORY_LANE_LEASE_RE,
  DEFAULT_ADVISORY_LANE_REAP_GRACE_MS,
  DISPATCH_RESULT_FILE,
  DISPATCH_STDERR_LOG,
  DISPATCH_STDOUT_LOG,
  LEASE_FILENAME,
  advisoryLaneLeaseFilename,
  assertNoLiveRunLease,
  corruptRunLeaseEventFields,
  corruptRunLeaseReportFields,
  confirmRunLeaseSupervisorDeath,
  dispatchManifestPathFields,
  formatLeaseForMessage,
  getAdvisoryLaneLeasePath,
  getDispatchResultCandidates,
  getLeasePath,
  getRunArtifactPaths,
  getRunLeaseStatus,
  isDestructiveCleanupBlockedByLease,
  isProcessGroupAlive,
  latestRunEvent,
  readAdvisoryLaneLeases,
  readRunLease,
  reapAdvisoryLaneLeases,
  removeAdvisoryLaneLease,
  removeRunLease,
  signalProcessGroup,
  terminateProcessGroup,
  waitForProcessGroupExit,
  waitForProcessGroupExitSync,
  writeAdvisoryLaneLease,
  writeRunLease,
};
