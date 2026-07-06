"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

const { STATES } = require("./manifest/lifecycle");
const { listManifestPaths } = require("./manifest/paths");
const { readManifest } = require("./manifest/store");
const { getRunLeaseStatus } = require("./run-runtime-state");

const DEAD_DISPATCH_LEASE_REASONS = new Set([
  "absent",
  "process_group_dead",
  "corrupt",
]);

function isDeadDispatchedLeaseStatus(status) {
  return status && status.live !== true && DEAD_DISPATCH_LEASE_REASONS.has(status.reason);
}

function runReconcile({ repoRoot, runId, mutate = false }) {
  const args = [
    path.join(__dirname, "reconcile-run.js"),
    "--repo", repoRoot,
    "--run-id", runId,
    "--json",
  ];
  if (!mutate) args.push("--dry-run");
  const stdout = execFileSync(process.execPath, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout);
}

function buildRunReconcileAdvisory({ repoRoot, manifestPath, data, mutate = false }) {
  const runId = data?.run_id || null;
  if (!runId || data?.state !== STATES.DISPATCHED) {
    return {
      required: false,
      mutated: false,
      reason: data?.state ? `state_${data.state}` : "missing_run_id",
      verdict: null,
    };
  }

  const leaseStatus = getRunLeaseStatus(repoRoot, runId);
  if (!isDeadDispatchedLeaseStatus(leaseStatus)) {
    return {
      required: false,
      mutated: false,
      reason: leaseStatus.live ? "lease_live" : `lease_${leaseStatus.reason}`,
      lease_status: leaseStatus,
      verdict: null,
    };
  }

  return {
    required: true,
    mutated: Boolean(mutate),
    reason: `lease_${leaseStatus.reason}`,
    manifestPath,
    runId,
    lease_status: leaseStatus,
    verdict: runReconcile({ repoRoot, runId, mutate }),
  };
}

function listDeadDispatchedRunAdvisories(repoRoot) {
  const advisories = [];
  for (const manifestPath of listManifestPaths(repoRoot)) {
    let record;
    try {
      record = readManifest(manifestPath);
    } catch {
      continue;
    }
    const advisory = buildRunReconcileAdvisory({
      repoRoot,
      manifestPath,
      data: record.data,
      mutate: false,
    });
    if (!advisory.required) continue;
    advisories.push({
      kind: "dead_dispatched_run",
      severity: "advisory",
      runId: advisory.runId,
      manifestPath,
      leaseStatus: advisory.lease_status?.reason || null,
      reconcile: advisory.verdict,
    });
  }
  return advisories;
}

module.exports = {
  buildRunReconcileAdvisory,
  isDeadDispatchedLeaseStatus,
  listDeadDispatchedRunAdvisories,
  runReconcile,
};
