const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getManifestPath } = require("./paths");
const {
  createManifestSkeleton,
  readManifest,
  writeManifest,
} = require("./store");

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Store Test"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay@example.com"], { cwd: repoRoot, stdio: "pipe" });
}

test("manifest/store createManifestSkeleton keeps draft lifecycle defaults", () => {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-store-repo-"));
  initGitRepo(repoRoot);
  const manifest = createManifestSkeleton({
    repoRoot,
    runId: "issue-188-20260418091011123-a1b2c3d4",
    branch: "issue-188",
    baseBranch: "main",
    issueNumber: 188,
    worktreePath: path.join(repoRoot, "wt"),
  });

  assert.equal(manifest.state, "draft");
  assert.equal(manifest.cleanup.status, "pending");
  assert.equal(manifest.roles.executor, "unknown");
});

test("manifest/store writeManifest and readManifest round-trip direct imports", () => {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-store-roundtrip-"));
  initGitRepo(repoRoot);
  const runId = "issue-188-20260418091011123-a1b2c3d4";
  const manifestPath = getManifestPath(repoRoot, runId);
  const manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-188",
    baseBranch: "main",
    issueNumber: 188,
    worktreePath: path.join(repoRoot, "wt"),
  });

  writeManifest(manifestPath, manifest, "# Notes\n");
  const parsed = readManifest(manifestPath);
  assert.equal(parsed.data.run_id, runId);
  assert.equal(parsed.data.git.base_branch, "main");
});
