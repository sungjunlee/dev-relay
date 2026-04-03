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
  readManifest,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");
const { resolveManifestRecord } = require("./relay-resolver");

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

test("resolveManifestRecord resolves a manifest by run_id", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-find-run-"));
  const firstRunId = createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  writeReviewPendingManifest(repoRoot, firstRunId, "issue-42", "2026-04-03T00:00:00.000Z");
  const latestRunId = createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:05:00.000Z"),
  });
  const latestPath = writeReviewPendingManifest(repoRoot, latestRunId, "issue-42", "2026-04-03T00:05:00.000Z");

  const match = resolveManifestRecord({ repoRoot, runId: latestRunId });
  assert.equal(match.manifestPath, latestPath);
  assert.equal(match.data.state, STATES.REVIEW_PENDING);
});

test("resolveManifestRecord rejects ambiguous branch lookup", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-find-ambiguous-"));
  writeReviewPendingManifest(repoRoot, createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  }), "issue-42", "2026-04-03T00:00:00.000Z");
  writeReviewPendingManifest(repoRoot, createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:10:00.000Z"),
  }), "issue-42", "2026-04-03T00:10:00.000Z");

  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "issue-42" }),
    /Ambiguous relay manifest/
  );
});

test("update-manifest-state updates a manifest by run_id", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-update-run-"));
  writeReviewPendingManifest(repoRoot, createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  }), "issue-42", "2026-04-03T00:00:00.000Z");
  const latestRunId = createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:10:00.000Z"),
  });
  const latestPath = writeReviewPendingManifest(repoRoot, latestRunId, "issue-42", "2026-04-03T00:10:00.000Z");

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", latestRunId,
    "--state", STATES.READY_TO_MERGE,
    "--pr-number", "123",
    "--head-sha", "abc123",
    "--rounds", "2",
    "--verdict", "lgtm",
    "--last-reviewed-sha", "abc123",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.manifestPath, latestPath);
  assert.equal(result.previousState, STATES.REVIEW_PENDING);
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.nextAction, "await_explicit_merge");
  assert.equal(result.prNumber, 123);
  assert.equal(result.headSha, "abc123");
  assert.equal(result.rounds, 2);
  assert.equal(result.verdict, "lgtm");
  assert.equal(result.lastReviewedSha, "abc123");

  const updated = readManifest(latestPath).data;
  assert.equal(updated.state, STATES.READY_TO_MERGE);
  assert.equal(updated.next_action, "await_explicit_merge");
  assert.equal(updated.git.pr_number, 123);
  assert.equal(updated.git.head_sha, "abc123");
  assert.equal(updated.review.rounds, 2);
  assert.equal(updated.review.latest_verdict, "lgtm");
  assert.equal(updated.review.last_reviewed_sha, "abc123");
});

test("update-manifest-state uses manual cleanup follow-up for merged runs", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-update-merged-"));
  const latestPath = writeReviewPendingManifest(repoRoot, createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T01:00:00.000Z"),
  }), "issue-42", "2026-04-03T01:00:00.000Z");

  let manifest = readManifest(latestPath).data;
  manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  writeManifest(latestPath, manifest);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", path.basename(latestPath, ".md"),
    "--state", STATES.MERGED,
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.nextAction, "manual_cleanup_required");

  const updated = readManifest(latestPath).data;
  assert.equal(updated.state, STATES.MERGED);
  assert.equal(updated.next_action, "manual_cleanup_required");
});
