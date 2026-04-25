const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createRunId,
  getManifestPath,
  validateManifestPaths,
  validateRunId,
} = require("./paths");

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Paths Test"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay@example.com"], { cwd: repoRoot, stdio: "pipe" });
}

test("manifest/paths validateRunId accepts createRunId output", () => {
  const runId = createRunId({
    branch: "Issue 188 Paths",
    timestamp: new Date("2026-04-18T09:10:11.123Z"),
  });
  const result = validateRunId(runId);
  assert.equal(result.valid, true);
  assert.equal(result.runId, runId);
});

test("manifest/paths validateManifestPaths rejects manifest-path mismatches", () => {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-paths-repo-"));
  initGitRepo(repoRoot);
  const runId = "issue-188-20260418091011123-a1b2c3d4";

  assert.throws(
    () => validateManifestPaths(
      { repo_root: repoRoot, worktree: null },
      {
        manifestPath: path.join(repoRoot, "wrong.md"),
        runId,
        caller: "manifest/paths.test",
      }
    ),
    /does not match the manifest storage path/
  );
  assert.match(getManifestPath(repoRoot, runId), /issue-188-20260418091011123-a1b2c3d4\.md$/);
});

test("manifest/paths cleanup mode accepts pruned and missing relay-owned worktrees", () => {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-paths-cleanup-repo-"));
  initGitRepo(repoRoot);
  const runId = "issue-295-20260425010101000-a1b2c3d4";
  const manifestPath = getManifestPath(repoRoot, runId);
  const relayWorktreeBase = path.join(process.env.RELAY_HOME, "worktrees");
  const repoBasename = path.basename(repoRoot);

  const prunedWorktree = path.join(relayWorktreeBase, "pruned-binding", repoBasename);
  fs.mkdirSync(prunedWorktree, { recursive: true });
  fs.writeFileSync(
    path.join(prunedWorktree, ".git"),
    `gitdir: ${path.join(relayWorktreeBase, "pruned-binding-admin")}\n`,
    "utf-8"
  );
  const prunedResult = validateManifestPaths({
    repo_root: repoRoot,
    worktree: prunedWorktree,
  }, {
    expectedRepoRoot: repoRoot,
    manifestPath,
    runId,
    acceptPrunedRelayOwned: true,
    caller: "manifest/paths.test cleanup pruned",
  });
  assert.equal(prunedResult.worktree, prunedWorktree);
  assert.equal(prunedResult.worktreeLocation, "relay_worktree");
  assert.equal(prunedResult.prunedRelayOwnedForCleanup, true);

  const missingWorktree = path.join(relayWorktreeBase, "missing-directory", repoBasename);
  fs.mkdirSync(path.dirname(missingWorktree), { recursive: true });
  const missingResult = validateManifestPaths({
    repo_root: repoRoot,
    worktree: missingWorktree,
  }, {
    expectedRepoRoot: repoRoot,
    manifestPath,
    runId,
    acceptPrunedRelayOwned: true,
    caller: "manifest/paths.test cleanup missing",
  });
  assert.equal(missingResult.worktree, missingWorktree);
  assert.equal(missingResult.worktreeLocation, "relay_worktree");
  assert.equal(fs.existsSync(missingWorktree), false, "fixture must exercise the no-realpath missing-directory branch");
});

test("manifest/paths cleanup mode rejects relay-owned symlink escapes", () => {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-paths-symlink-repo-"));
  initGitRepo(repoRoot);
  const runId = "issue-295-20260425010102000-a1b2c3d4";
  const manifestPath = getManifestPath(repoRoot, runId);
  const relayWorktreeBase = path.join(process.env.RELAY_HOME, "worktrees");
  const repoBasename = path.basename(repoRoot);
  const symlinkParent = path.join(relayWorktreeBase, "symlink-escape");
  const symlinkWorktree = path.join(symlinkParent, repoBasename);
  const escapedTarget = fs.mkdtempSync(path.join(os.tmpdir(), "relay-paths-escaped-target-"));

  fs.mkdirSync(symlinkParent, { recursive: true });
  fs.symlinkSync(escapedTarget, symlinkWorktree, "dir");

  assert.throws(
    () => validateManifestPaths({
      repo_root: repoRoot,
      worktree: symlinkWorktree,
    }, {
      expectedRepoRoot: repoRoot,
      manifestPath,
      runId,
      acceptPrunedRelayOwned: true,
      caller: "manifest/paths.test cleanup symlink escape",
    }),
    /is not contained under the expected repo root/
  );
});

test("manifest/paths default mode still rejects pruned relay-owned worktrees", () => {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-paths-strict-repo-"));
  initGitRepo(repoRoot);
  const runId = "issue-295-20260425010103000-a1b2c3d4";
  const manifestPath = getManifestPath(repoRoot, runId);
  const relayWorktreeBase = path.join(process.env.RELAY_HOME, "worktrees");
  const repoBasename = path.basename(repoRoot);
  const prunedWorktree = path.join(relayWorktreeBase, "pruned-binding", repoBasename);
  const missingWorktree = path.join(relayWorktreeBase, "missing-directory", repoBasename);

  fs.mkdirSync(prunedWorktree, { recursive: true });
  fs.mkdirSync(path.dirname(missingWorktree), { recursive: true });

  for (const worktree of [prunedWorktree, missingWorktree]) {
    assert.throws(
      () => validateManifestPaths({
        repo_root: repoRoot,
        worktree,
      }, {
        expectedRepoRoot: repoRoot,
        manifestPath,
        runId,
        caller: "manifest/paths.test strict pruned",
      }),
      /is not contained under the expected repo root/
    );
  }
});
