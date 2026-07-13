#!/usr/bin/env node

const fs = require("fs");
const { executeAdvisoryRequest } = require("./review-runner/advisory");
const {
  readAdvisoryLaneLeases,
} = require("../../relay-dispatch/scripts/run-runtime-state");

function clearOwnLaneLease(request) {
  if (!request || typeof request !== "object") return;
  const runDir = typeof request.runDir === "string" ? request.runDir : null;
  const round = Number(request.round);
  const reviewer = request.artifactReviewerName || request.reviewerName;
  if (!runDir || !Number.isInteger(round) || round <= 0 || !reviewer) return;
  try {
    if (typeof request.laneLeasePath === "string" && request.laneLeasePath.trim()) {
      fs.rmSync(request.laneLeasePath, { force: true });
      return;
    }
    for (const entry of readAdvisoryLaneLeases(runDir)) {
      if (!entry.lease) continue;
      if (entry.lease.round !== round) continue;
      if (entry.lease.reviewer !== reviewer) continue;
      if (entry.lease.pid !== process.pid) continue;
      fs.rmSync(entry.leasePath, { force: true });
    }
  } catch {
    // Best-effort: missing or unreadable lease must not fail the worker exit.
  }
}

function main() {
  const requestPath = process.argv[2];
  if (!requestPath) {
    throw new Error("advisory-worker requires a request JSON path");
  }
  const request = JSON.parse(fs.readFileSync(requestPath, "utf-8"));
  let result = null;
  try {
    result = executeAdvisoryRequest(request);
  } finally {
    // Timeout leaves the lease in place so the runner / janitor can still
    // discover and reap the (often TERM-ignoring) lane process group.
    if (result?.status !== "timeout") {
      clearOwnLaneLease(request);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
