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
