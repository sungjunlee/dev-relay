const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  findLatestManifestForBranch,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");

const SCRIPT = path.join(__dirname, "update-manifest-state.js");

function writeReviewPendingManifest(repoRoot, runId, branch, updatedAt) {
  const manifestPath = ensureRunLayout(repoRoot, runId).manifestPath;
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 42,
    worktreePath: path.join(repoRoot, "wt", runId),
    orchestrator: "codex",
    worker: "codex",
    reviewer: "claude",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  manifest.timestamps.updated_at = updatedAt;
  manifest.timestamps.created_at = updatedAt;
  writeManifest(manifestPath, manifest);
  return manifestPath;
}

test("findLatestManifestForBranch returns the newest run for a branch", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-find-run-"));
  writeReviewPendingManifest(repoRoot, createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  }), "issue-42", "2026-04-03T00:00:00.000Z");
  const latestPath = writeReviewPendingManifest(repoRoot, createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:05:00.000Z"),
  }), "issue-42", "2026-04-03T00:05:00.000Z");

  const match = findLatestManifestForBranch(repoRoot, "issue-42");
  assert.equal(match.manifestPath, latestPath);
  assert.equal(match.data.state, STATES.REVIEW_PENDING);
});

test("update-manifest-state updates the latest manifest for a branch", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-update-run-"));
  writeReviewPendingManifest(repoRoot, createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  }), "issue-42", "2026-04-03T00:00:00.000Z");
  const latestPath = writeReviewPendingManifest(repoRoot, createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:10:00.000Z"),
  }), "issue-42", "2026-04-03T00:10:00.000Z");

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--state", STATES.READY_TO_MERGE,
    "--pr-number", "123",
    "--rounds", "2",
    "--verdict", "lgtm",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.manifestPath, latestPath);
  assert.equal(result.previousState, STATES.REVIEW_PENDING);
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.nextAction, "await_explicit_merge");
  assert.equal(result.prNumber, 123);
  assert.equal(result.rounds, 2);
  assert.equal(result.verdict, "lgtm");

  const updated = readManifest(latestPath).data;
  assert.equal(updated.state, STATES.READY_TO_MERGE);
  assert.equal(updated.next_action, "await_explicit_merge");
  assert.equal(updated.git.pr_number, 123);
  assert.equal(updated.review.rounds, 2);
  assert.equal(updated.review.latest_verdict, "lgtm");
});
