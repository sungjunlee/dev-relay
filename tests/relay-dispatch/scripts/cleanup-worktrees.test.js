const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  getRelayWorktreeBase,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "cleanup-worktrees.js");
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

function writeStaleMissingRelayRun(repoRoot, { branch, updatedAt }) {
  const runId = createRunId({
    branch,
    timestamp: new Date(updatedAt),
  });
  const worktreePath = path.join(getRelayWorktreeBase(), `stale-${branch}`, path.basename(repoRoot));
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.rmSync(worktreePath, { recursive: true, force: true });

  const layout = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 295,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor.rubric_path = "rubric.yaml";
  fs.writeFileSync(path.join(layout.runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: stale-cleanup\n", "utf-8");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  manifest = updateManifestState(manifest, STATES.MERGED, "manual_cleanup_required");
  manifest.timestamps.created_at = updatedAt;
  manifest.timestamps.updated_at = updatedAt;
  writeManifest(layout.manifestPath, manifest);
  assert.equal(fs.existsSync(worktreePath), false, "fixture must model a manually deleted worktree");
  assert.match(
    execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf-8" }),
    new RegExp(`branch refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    "fixture must retain the stale git worktree registration"
  );
  return { manifestPath: layout.manifestPath, runId, worktreePath };
}

function writeStalePrunedRelayRun(repoRoot, { branch, updatedAt }) {
  const runId = createRunId({
    branch,
    timestamp: new Date(updatedAt),
  });
  const worktreePath = path.join(getRelayWorktreeBase(), `pruned-${branch}`, path.basename(repoRoot));
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, ".git"), `gitdir: ${path.join(path.dirname(worktreePath), "missing-admin")}\n`, "utf-8");
  fs.writeFileSync(path.join(worktreePath, "sentinel.txt"), "stale\n", "utf-8");

  const layout = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 295,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor.rubric_path = "rubric.yaml";
  fs.writeFileSync(path.join(layout.runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: stale-cleanup\n", "utf-8");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  manifest = updateManifestState(manifest, STATES.MERGED, "manual_cleanup_required");
  manifest.timestamps.created_at = updatedAt;
  manifest.timestamps.updated_at = updatedAt;
  writeManifest(layout.manifestPath, manifest);
  return { manifestPath: layout.manifestPath, runId, worktreePath };
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
  manifest.anchor.rubric_path = "rubric.yaml";
  fs.writeFileSync(path.join(ensureRunLayout(repoRoot, runId).runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: cleanup-worktrees\n", "utf-8");
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

function isPgidAlive(pgid) {
  try {
    process.kill(-Number(pgid), 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    return false;
  }
}

function killPgid(pgid) {
  try {
    process.kill(-Number(pgid), "SIGTERM");
  } catch {}
}

async function waitFor(condition, { timeoutMs = 5000, intervalMs = 50, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${message}`);
}

async function spawnSleeper(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  t.after(() => killPgid(child.pid));
  await waitFor(() => isPgidAlive(child.pid), { message: `pgid ${child.pid} alive` });
  return child;
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

test("cleanup-worktrees refuses to remove a worktree with a live run lease without --force", async (t) => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifestPath, worktreePath } = writeRun(repoRoot, {
    branch: "issue-live-lease",
    state: STATES.MERGED,
    updatedAt,
  });
  const runId = readManifest(manifestPath).data.run_id;
  const child = await spawnSleeper(t);
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "lease.json"), JSON.stringify({
    pid: process.pid,
    pgid: child.pid,
    host: os.hostname(),
    started_at: new Date().toISOString(),
    timeout_s: 60,
  }, null, 2), "utf-8");

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--all",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.cleaned.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /live lease/);
  assert.match(result.failed[0].error, new RegExp(`pid=${process.pid}`));
  assert.match(result.failed[0].error, new RegExp(`host=${os.hostname().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(readManifest(manifestPath).data.cleanup.status, "pending");
});

test("cleanup-worktrees refuses host-mismatched run leases without --force", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifestPath, worktreePath } = writeRun(repoRoot, {
    branch: "issue-host-mismatch-lease",
    state: STATES.MERGED,
    updatedAt,
  });
  const runId = readManifest(manifestPath).data.run_id;
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "lease.json"), JSON.stringify({
    pid: 999999,
    pgid: 999999,
    host: "other-host.example.test",
    started_at: new Date().toISOString(),
    timeout_s: 60,
  }, null, 2), "utf-8");

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--all",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.cleaned.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /host_mismatch|host mismatch|unverifiable lease/);
  assert.match(result.failed[0].error, /other-host\.example\.test/);
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(readManifest(manifestPath).data.cleanup.status, "pending");
});

test("cleanup-worktrees --force removes a worktree with a live run lease", async (t) => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifestPath, worktreePath } = writeRun(repoRoot, {
    branch: "issue-live-lease-force",
    state: STATES.MERGED,
    updatedAt,
  });
  const runId = readManifest(manifestPath).data.run_id;
  const child = await spawnSleeper(t);
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "lease.json"), JSON.stringify({
    pid: process.pid,
    pgid: child.pid,
    host: os.hostname(),
    started_at: new Date().toISOString(),
    timeout_s: 60,
  }, null, 2), "utf-8");

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--all",
    "--force",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.cleaned.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.cleaned[0].branch, "issue-live-lease-force");
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(readManifest(manifestPath).data.cleanup.status, "succeeded");
  assert.equal(isPgidAlive(child.pid), true);
});

test("cleanup-worktrees --force removes a worktree with a host-mismatched run lease", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifestPath, worktreePath } = writeRun(repoRoot, {
    branch: "issue-host-mismatch-lease-force",
    state: STATES.MERGED,
    updatedAt,
  });
  const runId = readManifest(manifestPath).data.run_id;
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "lease.json"), JSON.stringify({
    pid: 999999,
    pgid: 999999,
    host: "other-host.example.test",
    started_at: new Date().toISOString(),
    timeout_s: 60,
  }, null, 2), "utf-8");

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--all",
    "--force",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.cleaned.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.cleaned[0].branch, "issue-host-mismatch-lease-force");
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(readManifest(manifestPath).data.cleanup.status, "succeeded");
});

test("cleanup-worktrees dry-run surfaces corrupt run leases as stale evidence", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifestPath, worktreePath } = writeRun(repoRoot, {
    branch: "issue-corrupt-lease-dry-run",
    state: STATES.MERGED,
    updatedAt,
  });
  const runId = readManifest(manifestPath).data.run_id;
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "lease.json"), "{\"pid\":", "utf-8");

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--all",
    "--dry-run",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.cleaned.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.cleaned[0].branch, "issue-corrupt-lease-dry-run");
  assert.equal(result.cleaned[0].leaseStatus, "corrupt");
  assert.match(result.cleaned[0].leaseError, /invalid run lease/);
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(readManifest(manifestPath).data.cleanup.status, "pending");
});

test("cleanup-worktrees --force removes a worktree with a corrupt run lease", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifestPath, worktreePath } = writeRun(repoRoot, {
    branch: "issue-corrupt-lease-force",
    state: STATES.MERGED,
    updatedAt,
  });
  const runId = readManifest(manifestPath).data.run_id;
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "lease.json"), "{\"pid\":", "utf-8");

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--all",
    "--force",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.cleaned.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.cleaned[0].branch, "issue-corrupt-lease-force");
  assert.equal(result.cleaned[0].leaseStatus, "corrupt");
  assert.match(result.cleaned[0].leaseError, /invalid run lease/);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(readManifest(manifestPath).data.cleanup.status, "succeeded");
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
  assert.ok(result.staleOpen[0].health);
  assert.equal(result.staleOpen[0].health.finishPath, "retain_active");
  assert.equal(result.staleOpen[0].reason, "non-terminal");
  assert.equal(fs.existsSync(worktreePath), true);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.cleanup.status, "pending");
  assert.equal(manifest.next_action, "run_review");
});

test("cleanup-worktrees inspect mode returns inventory without side effects", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  writeRun(repoRoot, {
    branch: "issue-inspect",
    state: STATES.MERGED,
    updatedAt,
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--inspect",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.inspectOnly, true);
  assert.equal(result.inventory.length, 1);
  assert.equal(result.cleaned.length, 0);
  assert.equal(result.reconciled.length, 0);
  assert.equal(result.reapedShells.length, 0);
  assert.ok(result.inventory[0].health);
});

test("cleanup-worktrees reconciles merged drift for ready_to_merge runs", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const branch = "issue-reconcile-janitor";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(worktreePath, `${branch}.txt`), `${branch}\n`, "utf-8");
  execFileSync("git", ["-C", worktreePath, "add", `${branch}.txt`], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "commit", "-m", `Add ${branch}`], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["merge", branch, "-m", "merge reconcile janitor"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

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
  fs.writeFileSync(path.join(layout.runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: reconcile\n", "utf-8");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  manifest.timestamps.created_at = updatedAt;
  manifest.timestamps.updated_at = updatedAt;
  writeManifest(manifestPath, manifest);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--reconcile-merged",
    "--all",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.reconciled.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(branchExists(repoRoot, branch), false);

  const updated = readManifest(manifestPath).data;
  assert.equal(updated.state, "merged");
  assert.equal(updated.cleanup.status, "succeeded");
  assert.equal(updated.next_action, "done");
  assert.equal(updated.last_force.reason, "janitor_reconcile_merged");
});

test("cleanup-worktrees reconciles merged drift without --all when manifest is recent", () => {
  const repoRoot = setupRepo();
  const updatedAt = new Date().toISOString();
  const branch = "issue-reconcile-recent";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(worktreePath, `${branch}.txt`), `${branch}\n`, "utf-8");
  execFileSync("git", ["-C", worktreePath, "add", `${branch}.txt`], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "commit", "-m", `Add ${branch}`], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["merge", branch, "-m", "merge reconcile recent"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

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
  fs.writeFileSync(path.join(layout.runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: reconcile-recent\n", "utf-8");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  manifest.timestamps.created_at = updatedAt;
  manifest.timestamps.updated_at = updatedAt;
  writeManifest(manifestPath, manifest);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--reconcile-merged",
    "--older-than", "24",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.reconciled.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(fs.existsSync(worktreePath), false);
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

test("cleanup-worktrees processes terminal manifests whose worktrees are already missing", () => {
  for (const invocationContext of ["canonical", "linked"]) {
    const repoRoot = setupRepo();
    const updatedAt = "2026-04-01T00:00:00.000Z";
    const stale = writeStaleMissingRelayRun(repoRoot, {
      branch: `issue-295-${invocationContext}`,
      updatedAt,
    });
    let repoArg = repoRoot;
    if (invocationContext === "linked") {
      repoArg = path.join(os.tmpdir(), `relay-janitor-linked-${stale.runId}`);
      execFileSync("git", ["worktree", "add", repoArg, "-b", `linked-${stale.runId}`], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
    }
    assert.equal(branchExists(repoRoot, `issue-295-${invocationContext}`), true);

    const stdout = execFileSync("node", [
      SCRIPT,
      "--repo", repoArg,
      "--all",
      "--json",
    ], { encoding: "utf-8" });

    const result = JSON.parse(stdout);
    const cleaned = result.cleaned.find((entry) => entry.runId === stale.runId);
    assert.ok(cleaned, `${invocationContext} invocation must process the terminal run`);
    assert.equal(result.failed.length, 0);
    assert.equal(cleaned.worktreeRemoved, true);
    assert.equal(cleaned.branchDeleted, true);
    assert.equal(cleaned.pruneRan, true);
    assert.equal(branchExists(repoRoot, `issue-295-${invocationContext}`), false);
    const updated = readManifest(stale.manifestPath).data;
    assert.equal(updated.cleanup.status, "succeeded");
    const events = fs.readFileSync(path.join(path.dirname(stale.manifestPath), stale.runId, "events.jsonl"), "utf-8");
    assert.match(events, /"event":"cleanup_result"/);
  }
});

test("cleanup-worktrees requires --force-terminal for terminal unverifiable relay-base paths", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifestPath, worktreePath } = writeRun(repoRoot, {
    branch: "issue-885-terminal",
    state: STATES.MERGED,
    updatedAt,
  });
  const unverifiablePath = path.join(getRelayWorktreeBase(), "issue-885-shell", "unverifiable-name");
  fs.mkdirSync(unverifiablePath, { recursive: true });
  fs.writeFileSync(path.join(unverifiablePath, "sentinel.txt"), "keep until forced\n", "utf-8");
  execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    paths: { ...record.data.paths, worktree: unverifiablePath },
  }, record.body);

  const dryRunResult = JSON.parse(execFileSync("node", [
    SCRIPT, "--repo", repoRoot, "--all", "--dry-run", "--json",
  ], { encoding: "utf-8" }));
  assert.equal(dryRunResult.cleaned.length, 0);
  assert.equal(dryRunResult.failed.length, 1);
  assert.equal(dryRunResult.failed[0].reason, "terminal_unverifiable_requires_force");
  assert.equal(dryRunResult.failed[0].classification, "cleanable_terminal_unverifiable_path");
  assert.equal(fs.existsSync(unverifiablePath), true);
  assert.equal(readManifest(manifestPath).data.cleanup.status, "pending");

  const result = JSON.parse(execFileSync("node", [
    SCRIPT, "--repo", repoRoot, "--all", "--force-terminal", "--json",
  ], { encoding: "utf-8" }));
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed, null, 2));
  assert.equal(result.cleaned.length, 1);
  assert.equal(result.cleaned[0].reason, "forced_terminal_unverifiable_path");
  assert.equal(result.cleaned[0].worktreeRemoved, true);
  assert.equal(fs.existsSync(unverifiablePath), false);
  assert.equal(readManifest(manifestPath).data.cleanup.status, "succeeded");
});

test("cleanup-worktrees refuses non-terminal unverifiable paths with or without --force-terminal", () => {
  for (const forceTerminal of [false, true]) {
    const repoRoot = setupRepo();
    const updatedAt = "2026-04-01T00:00:00.000Z";
    const { manifestPath } = writeRun(repoRoot, {
      branch: `issue-885-open-${forceTerminal}`,
      state: STATES.READY_TO_MERGE,
      updatedAt,
    });
    const unverifiablePath = path.join(getRelayWorktreeBase(), `open-${forceTerminal}`, "unverifiable-name");
    fs.mkdirSync(unverifiablePath, { recursive: true });
    fs.writeFileSync(path.join(unverifiablePath, "sentinel.txt"), "must remain\n", "utf-8");
    const record = readManifest(manifestPath);
    writeManifest(manifestPath, {
      ...record.data,
      paths: { ...record.data.paths, worktree: unverifiablePath },
    }, record.body);
    const cliArgs = [SCRIPT, "--repo", repoRoot, "--all", "--dry-run", "--json"];
    if (forceTerminal) cliArgs.splice(-1, 0, "--force-terminal");

    const result = JSON.parse(execFileSync("node", cliArgs, { encoding: "utf-8" }));
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].reason, "refused_non_terminal_manifest_paths");
    assert.equal(result.failed[0].classification, "refused_manifest_paths");
    assert.equal(fs.existsSync(unverifiablePath), true);
    assert.equal(readManifest(manifestPath).data.cleanup.status, "pending");
  }
});

test("cleanup-worktrees never force-removes a terminal path outside the relay worktree base", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const { manifestPath } = writeRun(repoRoot, {
    branch: "issue-885-outside",
    state: STATES.MERGED,
    updatedAt,
  });
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "relay-janitor-outside-"));
  fs.writeFileSync(path.join(outsidePath, "sentinel.txt"), "never remove\n", "utf-8");
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    paths: { ...record.data.paths, worktree: outsidePath },
  }, record.body);

  const result = JSON.parse(execFileSync("node", [
    SCRIPT, "--repo", repoRoot, "--all", "--force-terminal", "--force", "--json",
  ], { encoding: "utf-8" }));
  assert.equal(result.cleaned.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, "refused_terminal_manifest_paths");
  assert.equal(fs.existsSync(outsidePath), true);
  assert.equal(fs.existsSync(path.join(outsidePath, "sentinel.txt")), true);
  assert.equal(readManifest(manifestPath).data.cleanup.status, "pending");
});

test("cleanup-worktrees removes existing relay-owned directories with pruned git bindings", () => {
  const repoRoot = setupRepo();
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const stale = writeStalePrunedRelayRun(repoRoot, {
    branch: "issue-295-pruned",
    updatedAt,
  });

  const dryRunStdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--all",
    "--dry-run",
    "--json",
  ], { encoding: "utf-8" });

  const dryRunResult = JSON.parse(dryRunStdout);
  assert.equal(dryRunResult.failed.length, 0);
  assert.equal(dryRunResult.cleaned.some((entry) => entry.runId === stale.runId), true);
  assert.equal(fs.existsSync(stale.worktreePath), true, "dry-run must not remove the pruned directory");
  assert.equal(readManifest(stale.manifestPath).data.cleanup.status, "pending", "dry-run must not persist cleanup state");

  const cleanupStdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--all",
    "--json",
  ], { encoding: "utf-8" });

  const cleanupResult = JSON.parse(cleanupStdout);
  const cleaned = cleanupResult.cleaned.find((entry) => entry.runId === stale.runId);
  assert.ok(cleaned);
  assert.equal(cleanupResult.failed.length, 0);
  assert.equal(cleaned.worktreeRemoved, true);
  assert.equal(cleaned.error, null);
  assert.equal(fs.existsSync(stale.worktreePath), false);
  assert.equal(readManifest(stale.manifestPath).data.cleanup.status, "succeeded");
});

test("cleanup-worktrees reaps empty relay worktree parent shells", () => {
  const repoRoot = setupRepo();
  const shellPath = path.join(getRelayWorktreeBase(), "empty-shell");
  fs.mkdirSync(shellPath, { recursive: true });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--all",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(fs.existsSync(shellPath), false);
  assert.equal(result.reapedShells.some((entry) => entry.path === shellPath), true);
});

test("cleanup-worktrees reaps relay worktree parent shells containing only .DS_Store", () => {
  const repoRoot = setupRepo();
  const shellPath = path.join(getRelayWorktreeBase(), "detritus-shell");
  fs.mkdirSync(shellPath, { recursive: true });
  fs.writeFileSync(path.join(shellPath, ".DS_Store"), "detritus\n", "utf-8");

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--all",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(fs.existsSync(shellPath), false);
  assert.equal(result.reapedShells.some((entry) => entry.path === shellPath), true);
});

test("cleanup-worktrees preserves relay worktree parent shells with stray content and warns", () => {
  const repoRoot = setupRepo();
  const shellPath = path.join(getRelayWorktreeBase(), "stray-shell");
  const strayPath = path.join(shellPath, "notes.txt");
  fs.mkdirSync(shellPath, { recursive: true });
  fs.writeFileSync(strayPath, "manual artifact\n", "utf-8");

  const run = spawnSync(process.execPath, [
    SCRIPT,
    "--repo", repoRoot,
    "--all",
    "--json",
  ], { cwd: PROJECT_ROOT, encoding: "utf-8" });

  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(fs.existsSync(shellPath), true);
  assert.equal(fs.existsSync(strayPath), true);
  assert.match(run.stderr, /preserving .*stray-shell.*notes\.txt/);
  assert.equal(result.skippedShells.some((entry) => entry.path === shellPath), true);
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

function setupNamedMainRepo(repoName = "dev-relay") {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-janitor-969-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-969-"));
  const repoRoot = path.join(fixtureRoot, repoName);
  fs.mkdirSync(repoRoot, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Janitor 969"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-janitor-969@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return { fixtureRoot, repoRoot };
}

function writeMultiCheckoutMissingWorktreeRun(repoRoot, {
  branch,
  updatedAt,
  recordedRepoRoot,
  worktreeBasename,
}) {
  const runId = createRunId({
    branch,
    timestamp: new Date(updatedAt),
  });
  const worktreePath = path.join(getRelayWorktreeBase(), `969-${branch}`, worktreeBasename);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.rmSync(worktreePath, { recursive: true, force: true });

  const layout = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot: recordedRepoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 969,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor.rubric_path = "rubric.yaml";
  fs.writeFileSync(path.join(layout.runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: multi-checkout\n", "utf-8");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  manifest = updateManifestState(manifest, STATES.MERGED, "manual_cleanup_required");
  manifest.timestamps.created_at = updatedAt;
  manifest.timestamps.updated_at = updatedAt;
  // Skeleton may canonicalize repo_root; force the recorded dispatch-time path.
  manifest.paths.repo_root = recordedRepoRoot;
  writeManifest(layout.manifestPath, manifest);
  return { manifestPath: layout.manifestPath, runId, worktreePath, runDir: layout.runDir };
}

test("cleanup-worktrees #969 cleans missing trust-root-named worktree from differently-named checkout", () => {
  const { repoRoot } = setupNamedMainRepo("dev-relay");
  const krillCheckout = path.join(path.dirname(repoRoot), "krill");
  execFileSync("git", ["worktree", "add", krillCheckout, "-b", "checkout-krill"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const stale = writeMultiCheckoutMissingWorktreeRun(repoRoot, {
    branch: "issue-969-a",
    updatedAt,
    recordedRepoRoot: krillCheckout,
    worktreeBasename: "dev-relay",
  });
  assert.notEqual(path.basename(krillCheckout), "dev-relay");
  assert.equal(path.basename(stale.worktreePath), "dev-relay");

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", krillCheckout,
    "--all",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  const cleaned = result.cleaned.find((entry) => entry.runId === stale.runId);
  assert.ok(cleaned, `expected cleanable run, got: ${JSON.stringify(result.failed, null, 2)}`);
  assert.equal(result.failed.length, 0);
  assert.equal(cleaned.classification, "owned");
  assert.equal(cleaned.worktreeRemoved, true);
  assert.equal(branchExists(repoRoot, "issue-969-a"), false);
  assert.equal(readManifest(stale.manifestPath).data.cleanup.status, "succeeded");
});

test("cleanup-worktrees #969 accepts vanished repo_root and still refuses foreign existing repo_root", () => {
  const { repoRoot } = setupNamedMainRepo("dev-relay");
  const krillCheckout = path.join(path.dirname(repoRoot), "krill-vanish");
  execFileSync("git", ["worktree", "add", krillCheckout, "-b", "checkout-krill-vanish"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  const vanishedCheckout = path.join(path.dirname(repoRoot), "codex-ephemeral-checkout");
  execFileSync("git", ["worktree", "add", vanishedCheckout, "-b", "checkout-vanished"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const stale = writeMultiCheckoutMissingWorktreeRun(repoRoot, {
    branch: "issue-969-b",
    updatedAt,
    recordedRepoRoot: vanishedCheckout,
    worktreeBasename: "dev-relay",
  });
  // Delete the dispatch-time checkout after recording it.
  execFileSync("git", ["worktree", "remove", "--force", vanishedCheckout], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  assert.equal(fs.existsSync(vanishedCheckout), false);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", krillCheckout,
    "--all",
    "--json",
  ], { encoding: "utf-8" });
  const result = JSON.parse(stdout);
  const cleaned = result.cleaned.find((entry) => entry.runId === stale.runId);
  assert.ok(cleaned, `vanished repo_root must fall through: ${JSON.stringify(result.failed, null, 2)}`);
  assert.equal(cleaned.classification, "owned");
  assert.equal(readManifest(stale.manifestPath).data.cleanup.status, "succeeded");

  // Existing foreign repo_root still refused.
  const foreign = createUnrelatedRelayOwnedWorktree(repoRoot, "issue-969-foreign-root");
  const foreignRun = writeRun(repoRoot, {
    branch: "issue-969-foreign-root-run",
    state: STATES.MERGED,
    updatedAt,
  });
  const record = readManifest(foreignRun.manifestPath);
  writeManifest(foreignRun.manifestPath, {
    ...record.data,
    paths: {
      ...record.data.paths,
      repo_root: foreign.attackerRoot,
    },
  }, record.body);
  const refused = JSON.parse(execFileSync("node", [
    SCRIPT, "--repo", krillCheckout, "--all", "--json",
  ], { encoding: "utf-8" }));
  const foreignFailure = refused.failed.find((entry) => entry.runId === readManifest(foreignRun.manifestPath).data.run_id
    || entry.manifestPath === foreignRun.manifestPath);
  assert.ok(foreignFailure, "foreign existing repo_root must be refused");
  assert.match(foreignFailure.error, /Refusing to trust manifest-owned repo paths|manifest paths\.repo_root/);
  assert.equal(fs.existsSync(foreignRun.worktreePath), true);
});

test("cleanup-worktrees #969 prunes advisory worktrees of merged runs and leaves non-terminal untouched", () => {
  const { repoRoot } = setupNamedMainRepo("dev-relay");
  const updatedAt = "2026-04-01T00:00:00.000Z";

  const merged = writeRun(repoRoot, {
    branch: "issue-969-adv-merged",
    state: STATES.MERGED,
    updatedAt,
  });
  const mergedRunId = readManifest(merged.manifestPath).data.run_id;
  const mergedRunDir = ensureRunLayout(repoRoot, mergedRunId).runDir;
  const mergedAdvisory = path.join(mergedRunDir, "advisory-worktrees", `codex-${process.pid}-merged`);
  fs.mkdirSync(path.dirname(mergedAdvisory), { recursive: true });
  execFileSync("git", ["worktree", "add", "--detach", mergedAdvisory, "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  assert.match(
    execFileSync("git", ["worktree", "list"], { cwd: repoRoot, encoding: "utf-8" }),
    new RegExp(mergedAdvisory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );

  const open = writeRun(repoRoot, {
    branch: "issue-969-adv-open",
    state: STATES.REVIEW_PENDING,
    updatedAt,
  });
  const openRunId = readManifest(open.manifestPath).data.run_id;
  const openRunDir = ensureRunLayout(repoRoot, openRunId).runDir;
  const openAdvisory = path.join(openRunDir, "advisory-worktrees", `codex-${process.pid}-open`);
  fs.mkdirSync(path.dirname(openAdvisory), { recursive: true });
  execFileSync("git", ["worktree", "add", "--detach", openAdvisory, "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });

  const dryRun = JSON.parse(execFileSync("node", [
    SCRIPT, "--repo", repoRoot, "--all", "--dry-run", "--json",
  ], { encoding: "utf-8" }));
  const planned = dryRun.advisoryPruned.find((entry) => entry.path === mergedAdvisory);
  assert.ok(planned, `dry-run must plan advisory prune: ${JSON.stringify(dryRun.advisoryPruned, null, 2)}`);
  assert.equal(planned.classification, "pruned-planned");
  assert.equal(fs.existsSync(mergedAdvisory), true, "dry-run must not delete advisory worktree");
  assert.equal(fs.existsSync(openAdvisory), true);
  assert.equal(
    dryRun.advisoryPruned.some((entry) => entry.path === openAdvisory),
    false,
    "non-terminal advisory must not be planned"
  );
  assert.match(
    execFileSync("git", ["worktree", "list"], { cwd: repoRoot, encoding: "utf-8" }),
    new RegExp(mergedAdvisory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "dry-run must not deregister advisory worktree"
  );

  const result = JSON.parse(execFileSync("node", [
    SCRIPT, "--repo", repoRoot, "--all", "--json",
  ], { encoding: "utf-8" }));
  const pruned = result.advisoryPruned.find((entry) => entry.path === mergedAdvisory);
  assert.ok(pruned, `must prune merged advisory: ${JSON.stringify(result.advisoryPruned, null, 2)}`);
  assert.equal(pruned.classification, "owned");
  assert.equal(fs.existsSync(mergedAdvisory), false);
  assert.doesNotMatch(
    execFileSync("git", ["worktree", "list"], { cwd: repoRoot, encoding: "utf-8" }),
    new RegExp(mergedAdvisory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
  assert.equal(fs.existsSync(openAdvisory), true, "non-terminal advisory must remain on disk");
  assert.match(
    execFileSync("git", ["worktree", "list"], { cwd: repoRoot, encoding: "utf-8" }),
    new RegExp(openAdvisory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("cleanup-worktrees #988 reaps terminal lane leases, leaves non-terminal untouched, dry-run inert", () => {
  const { isProcessGroupAlive, writeAdvisoryLaneLease } = require("../../../skills/relay-dispatch/scripts/run-runtime-state");
  const TERM_IGNORING_LANE = path.join(__dirname, "..", "..", "relay-merge", "fixtures", "term-ignoring-lane.js");

  function spawnTermIgnoringLane() {
    const child = spawn(process.execPath, [TERM_IGNORING_LANE], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    assert.ok(Number.isInteger(child.pid) && child.pid > 0);
    assert.equal(isProcessGroupAlive(child.pid), true);
    return child.pid;
  }

  function forceKillPgid(pgid) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }

  const { repoRoot } = setupNamedMainRepo("dev-relay");
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const priorGrace = process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS;
  process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS = "200";

  const merged = writeRun(repoRoot, {
    branch: "issue-988-lane-merged",
    state: STATES.MERGED,
    updatedAt,
  });
  const mergedRunId = readManifest(merged.manifestPath).data.run_id;
  const mergedRunDir = ensureRunLayout(repoRoot, mergedRunId).runDir;

  const open = writeRun(repoRoot, {
    branch: "issue-988-lane-open",
    state: STATES.REVIEW_PENDING,
    updatedAt,
  });
  const openRunId = readManifest(open.manifestPath).data.run_id;
  const openRunDir = ensureRunLayout(repoRoot, openRunId).runDir;

  const mergedPgid = spawnTermIgnoringLane();
  const openPgid = spawnTermIgnoringLane();
  let mergedLeasePath = null;
  let openLeasePath = null;
  try {
    mergedLeasePath = writeAdvisoryLaneLease(mergedRunDir, {
      pid: mergedPgid,
      pgid: mergedPgid,
      round: 1,
      reviewer: "codex",
    }).leasePath;
    openLeasePath = writeAdvisoryLaneLease(openRunDir, {
      pid: openPgid,
      pgid: openPgid,
      round: 1,
      reviewer: "opencode",
    }).leasePath;

    const dryRun = JSON.parse(execFileSync("node", [
      SCRIPT, "--repo", repoRoot, "--all", "--dry-run", "--json",
    ], {
      encoding: "utf-8",
      env: { ...process.env, RELAY_ADVISORY_LANE_REAP_GRACE_MS: "200" },
    }));
    assert.ok(Array.isArray(dryRun.advisoryLaneReaps));
    const dryMerged = dryRun.advisoryLaneReaps.find((entry) => entry.pgid === mergedPgid);
    assert.ok(dryMerged, `dry-run must list terminal lane: ${JSON.stringify(dryRun.advisoryLaneReaps)}`);
    assert.equal(dryMerged.outcome, "would_reap");
    assert.equal(
      dryRun.advisoryLaneReaps.some((entry) => entry.pgid === openPgid),
      false,
      "non-terminal lane must not appear in dry-run reaps"
    );
    assert.equal(isProcessGroupAlive(mergedPgid), true);
    assert.equal(fs.existsSync(mergedLeasePath), true);
    assert.equal(isProcessGroupAlive(openPgid), true);
    assert.equal(fs.existsSync(openLeasePath), true);

    const result = JSON.parse(execFileSync("node", [
      SCRIPT, "--repo", repoRoot, "--all", "--json",
    ], {
      encoding: "utf-8",
      env: { ...process.env, RELAY_ADVISORY_LANE_REAP_GRACE_MS: "200" },
    }));
    assert.ok(Array.isArray(result.advisoryLaneReaps));
    const reaped = result.advisoryLaneReaps.find((entry) => entry.pgid === mergedPgid);
    assert.ok(reaped, `must reap terminal lane: ${JSON.stringify(result.advisoryLaneReaps)}`);
    assert.equal(reaped.outcome, "reaped");
    assert.equal(reaped.signaled_kill, true);
    assert.equal(isProcessGroupAlive(mergedPgid), false);
    assert.equal(fs.existsSync(mergedLeasePath), false);
    assert.equal(
      result.advisoryLaneReaps.some((entry) => entry.pgid === openPgid),
      false,
      "non-terminal lane must remain untouched"
    );
    assert.equal(isProcessGroupAlive(openPgid), true);
    assert.equal(fs.existsSync(openLeasePath), true);
  } finally {
    forceKillPgid(mergedPgid);
    forceKillPgid(openPgid);
    if (priorGrace === undefined) delete process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS;
    else process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS = priorGrace;
  }
});

test("cleanup-worktrees #988 omits advisoryLaneReaps when idle (byte-identical shape)", () => {
  const { repoRoot } = setupNamedMainRepo("dev-relay");
  const updatedAt = "2026-04-01T00:00:00.000Z";
  writeRun(repoRoot, {
    branch: "issue-988-idle",
    state: STATES.MERGED,
    updatedAt,
  });
  const result = JSON.parse(execFileSync("node", [
    SCRIPT, "--repo", repoRoot, "--all", "--json",
  ], { encoding: "utf-8" }));
  assert.equal("advisoryLaneReaps" in result, false);
});

test("cleanup-worktrees #996 isolates sweep_error when one runDir is a file (ENOTDIR)", () => {
  const { isProcessGroupAlive, writeAdvisoryLaneLease } = require("../../../skills/relay-dispatch/scripts/run-runtime-state");
  const { getRunDir } = require("../../../skills/relay-dispatch/scripts/manifest/paths");
  const TERM_IGNORING_LANE = path.join(__dirname, "..", "..", "relay-merge", "fixtures", "term-ignoring-lane.js");

  function spawnTermIgnoringLane() {
    const child = spawn(process.execPath, [TERM_IGNORING_LANE], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    assert.ok(Number.isInteger(child.pid) && child.pid > 0);
    assert.equal(isProcessGroupAlive(child.pid), true);
    return child.pid;
  }

  function forceKillPgid(pgid) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }

  const { repoRoot } = setupNamedMainRepo("dev-relay");
  const updatedAt = "2026-04-01T00:00:00.000Z";
  const priorGrace = process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS;
  process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS = "200";

  // Broken runDir: regular FILE at the runDir path → readdirSync throws ENOTDIR.
  // Mark cleanup already succeeded so the janitor records sweep_error then skips
  // the rest of the per-run cleanup (appendRunEvent/ensureRunLayout would otherwise
  // hard-fail on the file-shaped runDir — out of scope for the reap isolation fix).
  const broken = writeRun(repoRoot, {
    branch: "issue-996-broken",
    state: STATES.MERGED,
    updatedAt,
  });
  const brokenRunId = readManifest(broken.manifestPath).data.run_id;
  const brokenRunDir = getRunDir(repoRoot, brokenRunId);
  {
    const { data, body } = readManifest(broken.manifestPath);
    writeManifest(broken.manifestPath, {
      ...data,
      cleanup: { ...(data.cleanup || {}), status: "succeeded" },
    }, body);
  }
  fs.rmSync(brokenRunDir, { recursive: true, force: true });
  fs.writeFileSync(brokenRunDir, "not-a-directory\n", "utf-8");
  assert.equal(fs.statSync(brokenRunDir).isFile(), true);

  // Healthy terminal run with a live lane lease — must still be swept.
  const healthy = writeRun(repoRoot, {
    branch: "issue-996-healthy",
    state: STATES.MERGED,
    updatedAt,
  });
  const healthyRunId = readManifest(healthy.manifestPath).data.run_id;
  const healthyRunDir = getRunDir(repoRoot, healthyRunId);
  const healthyPgid = spawnTermIgnoringLane();
  let healthyLeasePath = null;
  try {
    healthyLeasePath = writeAdvisoryLaneLease(healthyRunDir, {
      pid: healthyPgid,
      pgid: healthyPgid,
      round: 1,
      reviewer: "codex",
    }).leasePath;

    const result = JSON.parse(execFileSync("node", [
      SCRIPT, "--repo", repoRoot, "--all", "--json",
    ], {
      encoding: "utf-8",
      env: { ...process.env, RELAY_ADVISORY_LANE_REAP_GRACE_MS: "200" },
    }));

    assert.ok(Array.isArray(result.advisoryLaneReaps));
    const sweepError = result.advisoryLaneReaps.find(
      (entry) => entry.runId === brokenRunId && entry.outcome === "sweep_error"
    );
    assert.ok(sweepError, `must record sweep_error for broken run: ${JSON.stringify(result.advisoryLaneReaps)}`);
    assert.equal(typeof sweepError.error, "string");
    assert.ok(sweepError.error.length > 0);
    assert.equal("pgid" in sweepError, false);

    const reaped = result.advisoryLaneReaps.find((entry) => entry.pgid === healthyPgid);
    assert.ok(reaped, `healthy run must still be swept: ${JSON.stringify(result.advisoryLaneReaps)}`);
    assert.equal(reaped.outcome, "reaped");
    assert.equal(reaped.runId, healthyRunId);
    assert.equal(isProcessGroupAlive(healthyPgid), false);
    assert.equal(fs.existsSync(healthyLeasePath), false);

    // Human-summary path must tolerate pgid-less sweep_error entries (no throw).
    const textOut = execFileSync("node", [
      SCRIPT, "--repo", repoRoot, "--all", "--dry-run",
    ], {
      encoding: "utf-8",
      env: { ...process.env, RELAY_ADVISORY_LANE_REAP_GRACE_MS: "200" },
    });
    assert.match(textOut, /sweep_error/);
  } finally {
    forceKillPgid(healthyPgid);
    if (priorGrace === undefined) delete process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS;
    else process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS = priorGrace;
  }
});
