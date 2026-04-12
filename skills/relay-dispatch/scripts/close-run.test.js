const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  getEventsPath,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");

const SCRIPT = path.join(__dirname, "close-run.js");

function setupRepo({ dirtyWorktree = false, state = STATES.REVIEW_PENDING } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-close-run-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  process.env.RELAY_HOME = relayHome;
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Close Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-close@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const branch = "issue-42";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  if (dirtyWorktree) {
    fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "leftover\n", "utf-8");
  }

  const runId = createRunId({
    branch,
    timestamp: new Date("2026-04-03T07:00:00.000Z"),
  });
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
  manifest.anchor.rubric_grandfathered = true;
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  if (state === STATES.ESCALATED) {
    manifest = updateManifestState(manifest, STATES.ESCALATED, "inspect_review_failure");
  }
  writeManifest(manifestPath, manifest);

  return { repoRoot, manifestPath, runId, worktreePath };
}

test("close-run closes an active run and cleans a clean worktree", () => {
  const { repoRoot, manifestPath, runId, worktreePath } = setupRepo();

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--reason", "stale_non_terminal_run",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.CLOSED);
  assert.equal(result.nextAction, "done");
  assert.equal(result.cleanup.cleanupStatus, "succeeded");
  assert.equal(fs.existsSync(worktreePath), false);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.CLOSED);
  assert.equal(manifest.cleanup.status, "succeeded");

  const events = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8");
  assert.match(events, /"event":"close"/);
  assert.match(events, /"event":"cleanup_result"/);
});

test("close-run fails when --run-id does not resolve", () => {
  const { repoRoot } = setupRepo();
  const missingRunId = createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T08:30:00.000Z"),
  });

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", missingRunId,
    "--reason", "stale_non_terminal_run",
    "--json",
  ], {
    encoding: "utf-8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`No relay manifest found for run_id '${missingRunId}'`));
});

test("close-run keeps dirty worktrees and records manual cleanup follow-up", () => {
  const { repoRoot, manifestPath, runId, worktreePath } = setupRepo({ dirtyWorktree: true });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--reason", "stale_non_terminal_run",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.CLOSED);
  assert.equal(result.nextAction, "manual_cleanup_required");
  assert.equal(result.cleanup.cleanupStatus, "failed");
  assert.equal(fs.existsSync(worktreePath), true);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.CLOSED);
  assert.equal(manifest.cleanup.status, "failed");
});

test("close-run accepts escalated runs as close targets for manual recovery", () => {
  const { repoRoot, manifestPath, runId, worktreePath } = setupRepo({ state: STATES.ESCALATED });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--reason", "stale_escalated_run",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.previousState, STATES.ESCALATED);
  assert.equal(result.state, STATES.CLOSED);
  assert.equal(result.cleanup.cleanupStatus, "succeeded");
  assert.equal(fs.existsSync(worktreePath), false);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.CLOSED);
  assert.equal(manifest.cleanup.status, "succeeded");
});
