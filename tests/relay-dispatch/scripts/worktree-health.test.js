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
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const {
  assessRunWorktreeHealth,
  FINISH_PATHS,
  isBranchMergedIntoBase,
} = require("../../../skills/relay-dispatch/scripts/worktree-health");

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-health-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-health-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Health Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-health@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return repoRoot;
}

function writeReadyRun(repoRoot, { branch, updatedAt }) {
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(worktreePath, `${branch}.txt`), `${branch}\n`, "utf-8");
  execFileSync("git", ["-C", worktreePath, "add", `${branch}.txt`], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "commit", "-m", `Add ${branch}`], { encoding: "utf-8", stdio: "pipe" });

  const runId = createRunId({ branch, timestamp: new Date(updatedAt) });
  const manifestPath = ensureRunLayout(repoRoot, runId).manifestPath;
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 42,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor.rubric_path = "rubric.yaml";
  fs.writeFileSync(path.join(ensureRunLayout(repoRoot, runId).runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: health\n", "utf-8");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  manifest.git.pr_number = 99;
  manifest.timestamps.created_at = updatedAt;
  manifest.timestamps.updated_at = updatedAt;
  writeManifest(manifestPath, manifest);
  return { manifestPath, worktreePath, manifest };
}

test("isBranchMergedIntoBase detects merged branches", () => {
  const repoRoot = setupRepo();
  const branch = "issue-merge-detect";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "feature\n", "utf-8");
  execFileSync("git", ["-C", worktreePath, "add", "feature.txt"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "commit", "-m", "feature"], { encoding: "utf-8", stdio: "pipe" });

  assert.equal(isBranchMergedIntoBase(repoRoot, branch, "main"), false);
  execFileSync("git", ["merge", branch, "-m", "merge feature"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  assert.equal(isBranchMergedIntoBase(repoRoot, branch, "main"), true);
});

test("assessRunWorktreeHealth marks ready_to_merge PR handoff as retain_pr_handoff", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifest } = writeReadyRun(repoRoot, { branch: "issue-handoff", updatedAt });

  const health = assessRunWorktreeHealth({ repoRoot, data: manifest, staleDays: 14 });
  assert.equal(health.finishPath, FINISH_PATHS.RETAIN_PR_HANDOFF);
  assert.equal(health.reconcileEligible, false);
  assert.equal(health.safeToRemove, false);
});

test("assessRunWorktreeHealth marks merged drift as reconcile_eligible", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const branch = "issue-reconcile";
  const { manifest } = writeReadyRun(repoRoot, { branch, updatedAt });

  execFileSync("git", ["merge", branch, "-m", "merge issue-reconcile"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const health = assessRunWorktreeHealth({ repoRoot, data: manifest, staleDays: 14 });
  assert.equal(health.mergedIntoBase, true);
  assert.equal(health.reconcileEligible, true);
  assert.equal(health.safeToRemove, true);
  assert.equal(health.finishPath, FINISH_PATHS.RECONCILE_MERGED);
});

test("assessRunWorktreeHealth treats relay-owned rubric.yaml stray as effectively clean", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const branch = "issue-stray";
  const { manifest, worktreePath } = writeReadyRun(repoRoot, { branch, updatedAt });
  fs.writeFileSync(path.join(worktreePath, "rubric.yaml"), "rubric:\n  factors: []\n", "utf-8");

  execFileSync("git", ["merge", branch, "-m", "merge issue-stray"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const health = assessRunWorktreeHealth({ repoRoot, data: manifest, staleDays: 14 });
  assert.equal(health.relayOwnedStrayOnly, true);
  assert.equal(health.reconcileEligible, true);
  assert.equal(health.safeToRemove, true);
});

test("assessRunWorktreeHealth does not reconcile review_pending even when branch merged", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const branch = "issue-review-pending-merged";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(worktreePath, `${branch}.txt`), `${branch}\n`, "utf-8");
  execFileSync("git", ["-C", worktreePath, "add", `${branch}.txt`], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "commit", "-m", `Add ${branch}`], { encoding: "utf-8", stdio: "pipe" });

  const runId = createRunId({ branch, timestamp: new Date(updatedAt) });
  const layout = ensureRunLayout(repoRoot, runId);
  const manifestPath = layout.manifestPath;
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 42,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor.rubric_path = "rubric.yaml";
  fs.writeFileSync(path.join(layout.runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: review-pending\n", "utf-8");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  manifest.timestamps.created_at = updatedAt;
  manifest.timestamps.updated_at = updatedAt;
  writeManifest(manifestPath, manifest);

  execFileSync("git", ["merge", branch, "-m", "merge review pending"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const health = assessRunWorktreeHealth({ repoRoot, data: manifest, staleDays: 14 });
  assert.equal(health.mergedIntoBase, true);
  assert.equal(health.reconcileEligible, false);
  assert.notEqual(health.finishPath, FINISH_PATHS.RECONCILE_MERGED);
});
