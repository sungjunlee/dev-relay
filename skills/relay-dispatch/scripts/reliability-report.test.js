const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  ensureRunLayout,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");
const { appendRunEvent } = require("./relay-events");

const SCRIPT = path.join(__dirname, "reliability-report.js");

function writeRun(repoRoot, { runId, state, rounds, updatedAt }) {
  const manifestPath = ensureRunLayout(repoRoot, runId).manifestPath;
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: `issue-${runId}`,
    baseBranch: "main",
    issueNumber: 42,
    worktreePath: path.join(repoRoot, "wt", runId),
    orchestrator: "codex",
    worker: "codex",
    reviewer: "codex",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  if (state !== STATES.DISPATCHED) {
    manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  }
  if (state === STATES.READY_TO_MERGE || state === STATES.MERGED) {
    manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  }
  if (state === STATES.MERGED) {
    manifest = updateManifestState(manifest, STATES.MERGED, "done");
  }
  manifest.review.rounds = rounds;
  manifest.timestamps.created_at = updatedAt;
  manifest.timestamps.updated_at = updatedAt;
  writeManifest(manifestPath, manifest);
}

test("reliability-report derives the core scorecard from manifests and events", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-"));
  writeRun(repoRoot, {
    runId: "run-ready",
    state: STATES.READY_TO_MERGE,
    rounds: 2,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  writeRun(repoRoot, {
    runId: "run-merged",
    state: STATES.MERGED,
    rounds: 4,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  writeRun(repoRoot, {
    runId: "run-stale-open",
    state: STATES.REVIEW_PENDING,
    rounds: 1,
    updatedAt: "2026-03-25T00:00:00.000Z",
  });

  appendRunEvent(repoRoot, "run-ready", {
    event: "dispatch_start",
    state_from: STATES.CHANGES_REQUESTED,
    state_to: STATES.DISPATCHED,
    head_sha: "abc123",
    round: 2,
    reason: "same_run_resume",
  });
  appendRunEvent(repoRoot, "run-ready", {
    event: "dispatch_result",
    state_from: STATES.DISPATCHED,
    state_to: STATES.REVIEW_PENDING,
    head_sha: "def456",
    round: 2,
    reason: "same_run_resume:completed",
  });
  appendRunEvent(repoRoot, "run-ready", {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.READY_TO_MERGE,
    head_sha: "def456",
    round: 2,
    reason: "pass",
  });
  appendRunEvent(repoRoot, "run-merged", {
    event: "merge_blocked",
    state_from: STATES.READY_TO_MERGE,
    state_to: STATES.READY_TO_MERGE,
    head_sha: "aaa111",
    round: 4,
    reason: "stale",
  });
  appendRunEvent(repoRoot, "run-merged", {
    event: "merge_finalize",
    state_from: STATES.READY_TO_MERGE,
    state_to: STATES.MERGED,
    head_sha: "bbb222",
    round: 4,
    reason: "squash",
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.equal(report.metrics.same_run_resume_success_rate, 1);
  assert.equal(report.metrics.fresh_review_merge_block_rate, 0.5);
  assert.equal(report.metrics.max_rounds_enforcement_rate, 1);
  assert.equal(report.metrics.median_rounds_to_ready, 3);
  assert.equal(report.metrics.stale_open_runs_72h, 1);
});
