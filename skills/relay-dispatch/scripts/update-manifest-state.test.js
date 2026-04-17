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

function ensureGitRepo(repoRoot, actor = "Relay Update Test") {
  if (fs.existsSync(path.join(repoRoot, ".git"))) {
    return;
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", actor], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-update@example.com"], { cwd: repoRoot, stdio: "pipe" });
}

function writeReviewPendingManifest(repoRoot, runId, branch, updatedAt) {
  ensureGitRepo(repoRoot);
  const manifestPath = ensureRunLayout(repoRoot, runId).manifestPath;
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 42,
    worktreePath: path.join(repoRoot, "wt", runId),
    orchestrator: "codex",
    executor: "codex",
    reviewer: "claude",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor.rubric_grandfathered = true;
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  manifest.timestamps.updated_at = updatedAt;
  manifest.timestamps.created_at = updatedAt;
  writeManifest(manifestPath, manifest);
  return manifestPath;
}

test("resolveManifestRecord resolves a manifest by run_id", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-find-run-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
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
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
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

test("update-manifest-state surfaces ambiguous branch resolution with explicit recovery guidance", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-update-ambiguous-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  writeReviewPendingManifest(repoRoot, createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  }), "issue-42", "2026-04-03T00:00:00.000Z");
  writeReviewPendingManifest(repoRoot, createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:10:00.000Z"),
  }), "issue-42", "2026-04-03T00:10:00.000Z");

  assert.throws(
    () => execFileSync("node", [
      SCRIPT,
      "--repo", repoRoot,
      "--branch", "issue-42",
      "--state", STATES.READY_TO_MERGE,
      "--json",
    ], { encoding: "utf-8", stdio: "pipe" }),
    (error) => {
      assert.match(String(error.stderr), /Ambiguous relay manifest/);
      assert.match(String(error.stderr), /Pass --manifest <path> or --run-id <id> explicitly/);
      return true;
    }
  );
});

test("resolveManifestRecord rejects conflicting branch and PR selectors", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-find-conflict-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const branchOnlyPath = writeReviewPendingManifest(repoRoot, createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  }), "issue-42", "2026-04-03T00:00:00.000Z");
  const prOnlyPath = writeReviewPendingManifest(repoRoot, createRunId({
    branch: "issue-84",
    timestamp: new Date("2026-04-03T00:10:00.000Z"),
  }), "issue-84", "2026-04-03T00:10:00.000Z");

  let branchOnlyManifest = readManifest(branchOnlyPath).data;
  branchOnlyManifest.git.pr_number = 123;
  writeManifest(branchOnlyPath, branchOnlyManifest);

  let prOnlyManifest = readManifest(prOnlyPath).data;
  prOnlyManifest.git.pr_number = 456;
  writeManifest(prOnlyPath, prOnlyManifest);

  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "issue-42", prNumber: 456 }),
    /No relay manifest found/
  );
});

test("update-manifest-state updates a manifest by run_id", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-update-run-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
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
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
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
