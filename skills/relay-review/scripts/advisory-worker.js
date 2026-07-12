#!/usr/bin/env node

const fs = require("fs");
const { executeAdvisoryRequest } = require("./review-runner/advisory");
const { removeAdvisoryLaneLease } = require("../../relay-dispatch/scripts/run-runtime-state");

function clearOwnLaneLease(request) {
  if (!request || typeof request !== "object") return;
  const runDir = typeof request.runDir === "string" ? request.runDir : null;
  const round = Number(request.round);
  const reviewer = request.artifactReviewerName || request.reviewerName;
  if (!runDir || !Number.isInteger(round) || round <= 0 || !reviewer) return;
  try {
    removeAdvisoryLaneLease(runDir, round, reviewer);
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
  try {
    executeAdvisoryRequest(request);
  } finally {
    clearOwnLaneLease(request);
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
