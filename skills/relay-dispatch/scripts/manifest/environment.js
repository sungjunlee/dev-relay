const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function nowIso() {
  return new Date().toISOString();
}

function collectEnvironmentSnapshot(repoRoot, baseBranch) {
  let mainSha = null;
  try {
    mainSha = execFileSync(
      "git", ["-C", repoRoot, "rev-parse", `origin/${baseBranch}`],
      { encoding: "utf-8", stdio: "pipe" }
    ).trim();
  } catch {}

  let lockfileHash = null;
  const lockfilePath = path.join(repoRoot, "package-lock.json");
  try {
    const content = fs.readFileSync(lockfilePath);
    lockfileHash = "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
  } catch {}

  return {
    node_version: process.version,
    main_sha: mainSha,
    lockfile_hash: lockfileHash,
    dispatch_ts: nowIso(),
  };
}

const ENVIRONMENT_COMPARE_FIELDS = ["node_version", "main_sha", "lockfile_hash"];

function compareEnvironmentSnapshot(baseline, current) {
  if (!baseline || !current) return [];
  const drift = [];
  for (const field of ENVIRONMENT_COMPARE_FIELDS) {
    const from = baseline[field] ?? null;
    const to = current[field] ?? null;
    if (from === null && to === null) continue;
    if (from !== to) drift.push({ field, from, to });
  }
  return drift;
}

module.exports = {
  collectEnvironmentSnapshot,
  compareEnvironmentSnapshot,
};
