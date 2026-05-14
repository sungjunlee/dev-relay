"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  getFleetIssueLockPath,
  getFleetManifestPath,
  getFleetsDir,
  getManifestPath,
  listFleetManifestPaths,
  nowIso,
  requireValidFleetId,
  requireValidRunId,
} = require("./paths");
const { readManifest, writeManifest } = require("./store");

const STATES = Object.freeze({
  DRAFT: "draft",
  DISPATCHING: "dispatching",
  DISPATCHED: "dispatched",
  CLOSED: "closed",
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.DRAFT]: new Set([STATES.DISPATCHING]),
  [STATES.DISPATCHING]: new Set([STATES.DISPATCHED]),
  [STATES.DISPATCHED]: new Set([STATES.CLOSED]),
  [STATES.CLOSED]: new Set(),
});

const DISPATCH_STATUS = Object.freeze({
  PENDING: "pending",
  DISPATCHING: "dispatching",
  DISPATCHED: "dispatched",
  DISPATCH_FAILED_PRE_MANIFEST: "dispatch_failed_pre_manifest",
});

const DEFAULT_ISSUE_LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const FLEET_TOP_LEVEL_KEYS = Object.freeze(["fleet_id", "fleet_state", "children", "timestamps"]);
const CHILD_KEYS = Object.freeze(["leaf_ref", "run_id", "dispatch_status"]);

class FleetIssueLockError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "FleetIssueLockError";
    this.details = details;
  }
}

function validateTransition(fromState, toState) {
  if (!Object.values(STATES).includes(fromState)) {
    throw new Error(`Unknown relay fleet state: ${fromState}`);
  }
  if (!Object.values(STATES).includes(toState)) {
    throw new Error(`Unknown relay fleet state: ${toState}`);
  }
  if (!ALLOWED_TRANSITIONS[fromState].has(toState)) {
    throw new Error(`Invalid relay fleet state transition: ${fromState} -> ${toState}`);
  }
}

function validateDispatchStatus(status) {
  if (!Object.values(DISPATCH_STATUS).includes(status)) {
    throw new Error(`Unknown relay fleet dispatch_status: ${status}`);
  }
}

function assertExactKeys(object, allowedKeys, label) {
  for (const key of Object.keys(object || {})) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${label} may only contain ${allowedKeys.join(", ")}; unexpected key: ${key}`);
    }
  }
}

function normalizeFleetChild(child) {
  if (!child || typeof child !== "object" || Array.isArray(child)) {
    throw new Error("fleet child must be an object");
  }
  assertExactKeys(child, CHILD_KEYS, "fleet child");

  const leafRef = typeof child.leaf_ref === "string" ? child.leaf_ref.trim() : "";
  if (!leafRef) {
    throw new Error(`fleet child leaf_ref must be a non-empty string, got: ${JSON.stringify(child.leaf_ref)}`);
  }

  const runId = child.run_id === null || child.run_id === undefined || child.run_id === ""
    ? null
    : requireValidRunId(child.run_id);
  const dispatchStatus = child.dispatch_status || DISPATCH_STATUS.PENDING;
  validateDispatchStatus(dispatchStatus);

  if (runId === null && dispatchStatus === DISPATCH_STATUS.DISPATCHED) {
    throw new Error("fleet child with dispatch_status='dispatched' must carry run_id");
  }
  if (runId !== null && dispatchStatus === DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST) {
    throw new Error("fleet child dispatch_failed_pre_manifest must have run_id: null");
  }

  return {
    leaf_ref: leafRef,
    run_id: runId,
    dispatch_status: dispatchStatus,
  };
}

function normalizeTimestamps(timestamps) {
  const now = nowIso();
  if (!timestamps || typeof timestamps !== "object" || Array.isArray(timestamps)) {
    return { created_at: now, updated_at: now };
  }
  return {
    created_at: timestamps.created_at || now,
    updated_at: timestamps.updated_at || timestamps.created_at || now,
  };
}

function normalizeFleetManifest(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("fleet manifest must be an object");
  }
  assertExactKeys(data, FLEET_TOP_LEVEL_KEYS, "fleet manifest");

  const fleetId = requireValidFleetId(data.fleet_id);
  const fleetState = data.fleet_state || STATES.DRAFT;
  if (!Object.values(STATES).includes(fleetState)) {
    throw new Error(`Unknown relay fleet state: ${fleetState}`);
  }
  const children = Array.isArray(data.children)
    ? data.children.map(normalizeFleetChild)
    : [];

  return {
    fleet_id: fleetId,
    fleet_state: fleetState,
    children,
    timestamps: normalizeTimestamps(data.timestamps),
  };
}

function createFleetManifestSkeleton({ fleetId, children = [] }) {
  const createdAt = nowIso();
  return normalizeFleetManifest({
    fleet_id: fleetId,
    fleet_state: STATES.DRAFT,
    children,
    timestamps: {
      created_at: createdAt,
      updated_at: createdAt,
    },
  });
}

function writeFleetManifest(repoRoot, manifest, body = "") {
  const normalized = normalizeFleetManifest(manifest);
  const manifestPath = getFleetManifestPath(repoRoot, normalized.fleet_id);
  writeManifest(manifestPath, normalized, body);
  return { manifestPath, data: normalized };
}

function createFleetManifest(repoRoot, { fleetId, children = [] } = {}) {
  const manifest = createFleetManifestSkeleton({ fleetId, children });
  return writeFleetManifest(repoRoot, manifest);
}

function readFleetManifest(repoRoot, fleetId) {
  const manifestPath = getFleetManifestPath(repoRoot, fleetId);
  const record = readManifest(manifestPath);
  return {
    manifestPath,
    data: normalizeFleetManifest(record.data),
    body: record.body,
  };
}

function updateFleetManifest(repoRoot, fleetId, updater) {
  if (typeof updater !== "function") {
    throw new Error("updateFleetManifest requires an updater function");
  }
  const record = readFleetManifest(repoRoot, fleetId);
  const updated = normalizeFleetManifest(updater(record.data));
  if (updated.fleet_id !== record.data.fleet_id) {
    throw new Error("updateFleetManifest cannot change fleet_id");
  }
  return writeFleetManifest(repoRoot, updated, record.body);
}

function deleteFleetManifest(repoRoot, fleetId) {
  const manifestPath = getFleetManifestPath(repoRoot, fleetId);
  if (!fs.existsSync(manifestPath)) return false;
  fs.unlinkSync(manifestPath);
  return true;
}

function listFleetManifests(repoRoot) {
  return listFleetManifestPaths(repoRoot)
    .map((manifestPath) => {
      const record = readManifest(manifestPath);
      return {
        manifestPath,
        data: normalizeFleetManifest(record.data),
        body: record.body,
      };
    })
    .sort((left, right) => {
      const leftKey = left.data.timestamps.updated_at || left.data.timestamps.created_at || path.basename(left.manifestPath);
      const rightKey = right.data.timestamps.updated_at || right.data.timestamps.created_at || path.basename(right.manifestPath);
      return rightKey.localeCompare(leftKey);
    });
}

function updateFleetState(fleet, toState) {
  const normalized = normalizeFleetManifest(fleet);
  validateTransition(normalized.fleet_state, toState);
  return {
    ...normalized,
    fleet_state: toState,
    timestamps: {
      ...normalized.timestamps,
      updated_at: nowIso(),
    },
  };
}

function upsertFleetChild(fleet, child) {
  const normalized = normalizeFleetManifest(fleet);
  const normalizedChild = normalizeFleetChild(child);
  const existingIndex = normalized.children.findIndex((entry) => entry.leaf_ref === normalizedChild.leaf_ref);
  const children = normalized.children.slice();
  if (existingIndex === -1) {
    children.push(normalizedChild);
  } else {
    children[existingIndex] = normalizedChild;
  }
  return {
    ...normalized,
    children,
    timestamps: {
      ...normalized.timestamps,
      updated_at: nowIso(),
    },
  };
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

// Derived-summary rules:
// - Fleet manifests store dispatch intent only: leaf_ref, run_id, and dispatch_status.
// - A child with run_id:null is counted from dispatch_status alone; pre-manifest
//   failures remain visible as dispatch_failed_pre_manifest without inventing
//   child runtime state.
// - A child with run_id reads ~/.relay/runs/<repo-slug>/<run-id>.md on demand
//   and counts that child manifest's state. Missing/unreadable manifests are
//   reported as missing_manifest in the read-time summary.
// - Review and merge facts are never copied into the fleet manifest. Any mixed
//   picture, such as dispatched + escalated + pre-manifest-failed children, is
//   normal and must be derived on read.
function deriveFleetSummary(repoRoot, fleet) {
  const normalized = normalizeFleetManifest(fleet);
  const byDispatchStatus = {};
  const byRunState = {};
  const children = [];

  for (const child of normalized.children) {
    increment(byDispatchStatus, child.dispatch_status);
    const summaryChild = {
      leaf_ref: child.leaf_ref,
      run_id: child.run_id,
      dispatch_status: child.dispatch_status,
      run_state: null,
      manifest_path: null,
      error: null,
    };

    if (!child.run_id) {
      summaryChild.run_state = "no_run_manifest";
      increment(byRunState, summaryChild.run_state);
      children.push(summaryChild);
      continue;
    }

    const childManifestPath = getManifestPath(repoRoot, child.run_id);
    summaryChild.manifest_path = childManifestPath;
    try {
      const childRecord = readManifest(childManifestPath);
      summaryChild.run_state = childRecord.data?.state || "unknown";
    } catch (error) {
      summaryChild.run_state = "missing_manifest";
      summaryChild.error = String(error.message || error);
    }
    increment(byRunState, summaryChild.run_state);
    children.push(summaryChild);
  }

  return {
    fleet_id: normalized.fleet_id,
    fleet_state: normalized.fleet_state,
    total_children: normalized.children.length,
    by_dispatch_status: byDispatchStatus,
    by_run_state: byRunState,
    children,
  };
}

function lockRecordIsForHolder(record, lock) {
  return record
    && lock
    && record.token === lock.token
    && record.fleet_id === lock.fleetId
    && Number(record.issue_number) === Number(lock.issueNumber);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function readIssueLockRecord(lockPath) {
  const text = fs.readFileSync(lockPath, "utf-8");
  return JSON.parse(text);
}

function isIssueLockStale(record, stat, { staleMs, nowMs }) {
  const acquiredMs = Date.parse(record?.acquired_at || "");
  const ageFromRecord = Number.isFinite(acquiredMs) ? nowMs - acquiredMs : null;
  const ageFromMtime = stat?.mtimeMs ? nowMs - stat.mtimeMs : null;
  if (ageFromRecord !== null && ageFromRecord > staleMs) return true;
  if (ageFromRecord === null && ageFromMtime !== null && ageFromMtime > staleMs) return true;
  if (record?.hostname && record.hostname !== os.hostname()) return false;
  if (Number.isInteger(record?.pid) && record.pid > 0 && !processIsAlive(record.pid)) return true;
  return false;
}

function formatIssueLockCollision(lockPath, existing) {
  const holder = existing && typeof existing === "object"
    ? [
        `fleet_id=${existing.fleet_id || "(unknown)"}`,
        `run_id=${existing.run_id || "(none)"}`,
        `pid=${existing.pid || "(unknown)"}`,
        `acquired_at=${existing.acquired_at || "(unknown)"}`,
      ].join(", ")
    : "unreadable lock holder";
  return `Refusing to dispatch: fleet issue lock is already held at ${lockPath} (${holder}).`;
}

function acquireIssueLock({
  repoRoot,
  issueNumber,
  fleetId,
  runId = null,
  staleMs = DEFAULT_ISSUE_LOCK_STALE_MS,
  now = () => new Date(),
} = {}) {
  const parsedIssue = Number(issueNumber);
  if (!Number.isInteger(parsedIssue) || parsedIssue <= 0) {
    throw new Error(`issueNumber must be a positive integer, got: ${JSON.stringify(issueNumber)}`);
  }
  const normalizedFleetId = requireValidFleetId(fleetId);
  const normalizedRunId = runId === null || runId === undefined ? null : requireValidRunId(runId);
  const lockPath = getFleetIssueLockPath(repoRoot, parsedIssue);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const token = crypto.randomBytes(16).toString("hex");
  const acquiredAt = now().toISOString();
  const record = {
    issue_number: parsedIssue,
    fleet_id: normalizedFleetId,
    run_id: normalizedRunId,
    pid: process.pid,
    hostname: os.hostname(),
    acquired_at: acquiredAt,
    stale_after_ms: staleMs,
    token,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
      fs.closeSync(fd);
      fd = null;
      return {
        lockPath,
        issueNumber: parsedIssue,
        fleetId: normalizedFleetId,
        runId: normalizedRunId,
        token,
      };
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (error.code !== "EEXIST") {
        throw error;
      }

      let existing = null;
      let stat = null;
      try {
        stat = fs.statSync(lockPath);
        existing = readIssueLockRecord(lockPath);
      } catch {
        const nowMs = now().getTime();
        if (stat?.mtimeMs && nowMs - stat.mtimeMs > staleMs) {
          try {
            fs.unlinkSync(lockPath);
            continue;
          } catch {}
        }
        throw new FleetIssueLockError(formatIssueLockCollision(lockPath, null), { lockPath });
      }

      if (isIssueLockStale(existing, stat, { staleMs, nowMs: now().getTime() })) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {
          throw new FleetIssueLockError(formatIssueLockCollision(lockPath, existing), { lockPath, existing });
        }
      }

      throw new FleetIssueLockError(formatIssueLockCollision(lockPath, existing), { lockPath, existing });
    }
  }

  throw new FleetIssueLockError(`Unable to acquire fleet issue lock after stale cleanup: ${lockPath}`, { lockPath });
}

function releaseIssueLock(lock) {
  if (!lock?.lockPath) return false;
  try {
    const record = readIssueLockRecord(lock.lockPath);
    if (!lockRecordIsForHolder(record, lock)) {
      return false;
    }
    fs.unlinkSync(lock.lockPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    return false;
  }
}

module.exports = {
  ALLOWED_TRANSITIONS,
  DEFAULT_ISSUE_LOCK_STALE_MS,
  DISPATCH_STATUS,
  FleetIssueLockError,
  STATES,
  acquireIssueLock,
  createFleetManifest,
  createFleetManifestSkeleton,
  deleteFleetManifest,
  deriveFleetSummary,
  getFleetsDir,
  listFleetManifests,
  normalizeFleetChild,
  normalizeFleetManifest,
  releaseIssueLock,
  updateFleetManifest,
  updateFleetState,
  upsertFleetChild,
  validateDispatchStatus,
  validateTransition,
  writeFleetManifest,
  readFleetManifest,
};
