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

module.exports = {
  DISPATCH_RESULT_FILE,
  DISPATCH_STDERR_LOG,
  DISPATCH_STDOUT_LOG,
  LEASE_FILENAME,
  assertNoLiveRunLease,
  corruptRunLeaseEventFields,
  corruptRunLeaseReportFields,
  confirmRunLeaseSupervisorDeath,
  dispatchManifestPathFields,
  formatLeaseForMessage,
  getDispatchResultCandidates,
  getLeasePath,
  getRunArtifactPaths,
  getRunLeaseStatus,
  isDestructiveCleanupBlockedByLease,
  isProcessGroupAlive,
  latestRunEvent,
  readRunLease,
  removeRunLease,
  terminateProcessGroup,
  waitForProcessGroupExit,
  writeRunLease,
};
