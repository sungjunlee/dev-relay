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
const {
  createGrandfatheredRubricAnchor,
  registerGrandfatheredRubricMigration,
} = require("./test-support");

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
  manifest.anchor.rubric_grandfathered = createGrandfatheredRubricAnchor({
    actor: "close-run-test",
  });
  registerGrandfatheredRubricMigration(runId, {
    applied_at: manifest.anchor.rubric_grandfathered.applied_at,
    reason: manifest.anchor.rubric_grandfathered.reason,
  });
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  if (state === STATES.ESCALATED) {
    manifest = updateManifestState(manifest, STATES.ESCALATED, "inspect_review_failure");
  }
  writeManifest(manifestPath, manifest);

  return { repoRoot, manifestPath, runId, worktreePath };
}

function createUnrelatedRelayOwnedWorktree(repoRoot, branch = "issue-42") {
  const attackerParent = fs.mkdtempSync(path.join(os.tmpdir(), "relay-close-foreign-"));
  const attackerRoot = path.join(attackerParent, path.basename(repoRoot));
  fs.mkdirSync(attackerRoot, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Close Foreign"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-close-foreign@example.com"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(attackerRoot, "README.md"), "foreign\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  const relayWorktrees = path.join(process.env.RELAY_HOME, "worktrees");
  fs.mkdirSync(relayWorktrees, { recursive: true });
  const attackerWorktreeParent = fs.mkdtempSync(path.join(relayWorktrees, "foreign-"));
  const attackerWorktree = path.join(attackerWorktreeParent, path.basename(repoRoot));
  execFileSync("git", ["worktree", "add", attackerWorktree, "-b", branch], {
    cwd: attackerRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(attackerWorktree, "sentinel.txt"), "foreign\n", "utf-8");
  return { attackerRoot, attackerWorktree };
}

function createMissingRelayOwnedWorktree(repoRoot) {
  const relayWorktrees = path.join(process.env.RELAY_HOME, "worktrees");
  fs.mkdirSync(relayWorktrees, { recursive: true });
  const worktreeParent = fs.mkdtempSync(path.join(relayWorktrees, "missing-"));
  return path.join(worktreeParent, path.basename(repoRoot));
}

function branchExists(repoRoot, branch) {
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", `refs/heads/${branch}`], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
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

test("close-run rejects relay-base same-name worktrees before cleanup", () => {
  const { repoRoot, manifestPath, runId } = setupRepo();
  const { attackerWorktree } = createUnrelatedRelayOwnedWorktree(repoRoot);
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    paths: {
      ...(record.data.paths || {}),
      worktree: attackerWorktree,
    },
  }, record.body);

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--reason", "stale_non_terminal_run",
    "--json",
  ], {
    encoding: "utf-8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest paths\.worktree/);
  assert.equal(fs.existsSync(attackerWorktree), true, "close-run must reject before touching the foreign relay worktree");
  assert.equal(fs.existsSync(path.join(attackerWorktree, "sentinel.txt")), true);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.cleanup.status, "pending");
});

test("close-run rejects missing relay-base same-name worktrees before cleanup", () => {
  const { repoRoot, manifestPath, runId, worktreePath } = setupRepo();
  const missingWorktree = createMissingRelayOwnedWorktree(repoRoot);
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    paths: {
      ...(record.data.paths || {}),
      worktree: missingWorktree,
    },
  }, record.body);

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--reason", "stale_non_terminal_run",
    "--json",
  ], {
    encoding: "utf-8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest paths\.worktree/);
  assert.equal(fs.existsSync(worktreePath), true, "close-run must fail before touching the real worktree");
  assert.equal(fs.existsSync(missingWorktree), false);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.cleanup.status, "pending");
});

test("close-run rejects tampered paths.repo_root before state changes or cleanup side effects", () => {
  const { repoRoot, manifestPath, runId, worktreePath } = setupRepo();
  const { attackerRoot } = createUnrelatedRelayOwnedWorktree(repoRoot);
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    paths: {
      ...(record.data.paths || {}),
      repo_root: attackerRoot,
    },
  }, record.body);

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--reason", "stale_non_terminal_run",
    "--json",
  ], {
    encoding: "utf-8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest paths\.repo_root/);
  assert.equal(fs.existsSync(worktreePath), true, "close-run must reject before removing the retained worktree");
  assert.equal(branchExists(repoRoot, "issue-42"), true, "close-run must reject before deleting the branch");
  assert.equal(fs.existsSync(getEventsPath(repoRoot, runId)), false, "close-run must reject before appending lifecycle events");

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.cleanup.status, "pending");
});
