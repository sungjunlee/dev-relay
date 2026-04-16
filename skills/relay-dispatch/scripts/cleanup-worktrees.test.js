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
  readManifest,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");

const SCRIPT = path.join(__dirname, "cleanup-worktrees.js");
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-janitor-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Janitor Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-janitor@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return repoRoot;
}

function createUnrelatedRelayOwnedWorktree(repoRoot, branch = "issue-42") {
  const attackerParent = fs.mkdtempSync(path.join(os.tmpdir(), "relay-janitor-foreign-"));
  const attackerRoot = path.join(attackerParent, path.basename(repoRoot));
  fs.mkdirSync(attackerRoot, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Janitor Foreign"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-janitor-foreign@example.com"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
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

function writeRun(repoRoot, { branch, state, updatedAt }) {
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(worktreePath, `${branch}.txt`), `${branch}\n`, "utf-8");
  execFileSync("git", ["-C", worktreePath, "add", `${branch}.txt`], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "commit", "-m", `Add ${branch}`], { encoding: "utf-8", stdio: "pipe" });

  const runId = createRunId({
    branch,
    timestamp: new Date(updatedAt),
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
  if (state === STATES.READY_TO_MERGE || state === STATES.MERGED) {
    manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  }
  if (state === STATES.MERGED) {
    manifest = updateManifestState(manifest, STATES.MERGED, "manual_cleanup_required");
  }
  manifest.timestamps.created_at = updatedAt;
  manifest.timestamps.updated_at = updatedAt;
  writeManifest(manifestPath, manifest);
  return { manifestPath, worktreePath };
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

test("cleanup-worktrees removes stale merged runs based on manifests", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifestPath, worktreePath } = writeRun(repoRoot, {
    branch: "issue-42",
    state: STATES.MERGED,
    updatedAt,
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--older-than", "1",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.cleaned.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.cleaned[0].branch, "issue-42");
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(branchExists(repoRoot, "issue-42"), false);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.cleanup.status, "succeeded");
  assert.equal(manifest.next_action, "done");
});

test("cleanup-worktrees reports stale open runs without deleting them", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifestPath, worktreePath } = writeRun(repoRoot, {
    branch: "issue-77",
    state: STATES.REVIEW_PENDING,
    updatedAt,
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--older-than", "1",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.cleaned.length, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(result.staleOpen.length, 1);
  assert.equal(result.staleOpen[0].branch, "issue-77");
  assert.equal(fs.existsSync(worktreePath), true);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.cleanup.status, "pending");
  assert.equal(manifest.next_action, "run_review");
});

test("cleanup-worktrees does not echo tampered run_id into operator output (#176)", () => {
  // Anti-theater: without the #176 safeFormatRunId reuse at cleanup-worktrees.js:88/:94,
  // the tampered run_id leaks into result.staleOpen[*].runId and the closeCommand --run-id.
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifestPath } = writeRun(repoRoot, {
    branch: "issue-999",
    state: STATES.REVIEW_PENDING,
    updatedAt,
  });
  const fallbackRunId = path.basename(manifestPath, ".md");
  const { data: tamperedManifest, body } = readManifest(manifestPath);
  tamperedManifest.run_id = "../victim-run";
  writeManifest(manifestPath, tamperedManifest, body);

  const jsonRun = spawnSync(
    process.execPath,
    [SCRIPT, "--repo", repoRoot, "--all", "--json"],
    { cwd: PROJECT_ROOT, encoding: "utf-8" }
  );
  assert.equal(jsonRun.status, 0, jsonRun.stderr);

  const result = JSON.parse(jsonRun.stdout);
  const allEntries = [
    ...result.cleaned,
    ...result.failed,
    ...result.staleOpen,
    ...result.skipped,
  ];
  assert.ok(allEntries.length > 0, "fixture should produce at least one entry");
  for (const entry of allEntries) {
    assert.doesNotMatch(entry.runId, /\.\.\/victim-run/, "runId field must not contain tampered substring");
    assert.equal(entry.runId, fallbackRunId, "runId field should fall back to the manifest basename");
    if (entry.closeCommand) {
      assert.doesNotMatch(entry.closeCommand, /\.\.\/victim-run/, "closeCommand must not contain tampered substring");
      assert.match(entry.closeCommand, new RegExp(fallbackRunId), "closeCommand uses basename fallback");
    }
  }

  const textRun = spawnSync(
    process.execPath,
    [SCRIPT, "--repo", repoRoot, "--all"],
    { cwd: PROJECT_ROOT, encoding: "utf-8" }
  );
  assert.equal(textRun.status, 0, textRun.stderr);
  assert.doesNotMatch(textRun.stdout, /\.\.\/victim-run/, "text output must not contain tampered substring");
  assert.match(textRun.stdout, new RegExp(fallbackRunId), "text output should use the manifest basename");
});

test("cleanup-worktrees rejects relay-base same-name worktrees before deleting unrelated checkouts", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifestPath } = writeRun(repoRoot, {
    branch: "issue-160",
    state: STATES.MERGED,
    updatedAt,
  });
  const { attackerWorktree } = createUnrelatedRelayOwnedWorktree(repoRoot, "issue-160");

  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    paths: {
      ...(record.data.paths || {}),
      worktree: attackerWorktree,
    },
  }, record.body);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--all",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.cleaned.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /manifest paths\.worktree/);
  assert.equal(fs.existsSync(attackerWorktree), true, "cleanup-worktrees must fail closed before removing the foreign relay worktree");
  assert.equal(fs.existsSync(path.join(attackerWorktree, "sentinel.txt")), true);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.cleanup.status, "pending");
});

test("cleanup-worktrees rejects tampered paths.repo_root before cleanup side effects", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifestPath, worktreePath } = writeRun(repoRoot, {
    branch: "issue-161",
    state: STATES.MERGED,
    updatedAt,
  });
  const { attackerRoot } = createUnrelatedRelayOwnedWorktree(repoRoot, "issue-161");

  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    paths: {
      ...(record.data.paths || {}),
      repo_root: attackerRoot,
    },
  }, record.body);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--all",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.cleaned.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /manifest paths\.repo_root/);
  assert.equal(result.failed[0].worktreeRemoved, false);
  assert.equal(result.failed[0].branchDeleted, false);
  assert.equal(result.failed[0].pruneRan, false);
  assert.equal(fs.existsSync(worktreePath), true, "cleanup-worktrees must reject before removing the retained worktree");
  assert.equal(branchExists(repoRoot, "issue-161"), true, "cleanup-worktrees must reject before deleting the branch");

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.cleanup.status, "pending");
});
