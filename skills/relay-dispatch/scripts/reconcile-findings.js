"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

const { STATES } = require("./manifest/lifecycle");
const { listManifestPaths } = require("./manifest/paths");
const { readManifest } = require("./manifest/store");
const { getRunLeaseStatus } = require("./run-runtime-state");

const DEAD_DISPATCH_LEASE_REASONS = new Set([
  "absent",
  "host_mismatch",
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

function buildRunReconcileFinding({ repoRoot, manifestPath, data, mutate = false }) {
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

function listDeadDispatchedRunFindings(repoRoot, { mutate = false } = {}) {
  const findings = [];
  for (const manifestPath of listManifestPaths(repoRoot)) {
    let record;
    try {
      record = readManifest(manifestPath);
    } catch {
      continue;
    }
    const finding = buildRunReconcileFinding({
      repoRoot,
      manifestPath,
      data: record.data,
      mutate,
    });
    if (!finding.required) continue;
    findings.push({
      kind: "dead_dispatched_run",
      severity: "warning",
      runId: finding.runId,
      manifestPath,
      leaseStatus: finding.lease_status?.reason || null,
      mutated: finding.mutated,
      reconcile: finding.verdict,
    });
  }
  return findings;
}

module.exports = {
  buildRunReconcileFinding,
  isDeadDispatchedLeaseStatus,
  listDeadDispatchedRunFindings,
  runReconcile,
};
