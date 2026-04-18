const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  collectEnvironmentSnapshot,
  compareEnvironmentSnapshot,
} = require("./environment");

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Env Test"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
}

test("manifest/environment compareEnvironmentSnapshot reports drift by field", () => {
  const drift = compareEnvironmentSnapshot(
    { node_version: "v1", main_sha: "a", lockfile_hash: null },
    { node_version: "v2", main_sha: "a", lockfile_hash: "sha256:1" }
  );
  assert.deepEqual(drift, [
    { field: "node_version", from: "v1", to: "v2" },
    { field: "lockfile_hash", from: null, to: "sha256:1" },
  ]);
});

test("manifest/environment collectEnvironmentSnapshot returns the expected shape", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-env-repo-"));
  initGitRepo(repoRoot);
  const snapshot = collectEnvironmentSnapshot(repoRoot, "main");
  assert.equal(snapshot.node_version, process.version);
  assert.equal(typeof snapshot.dispatch_ts, "string");
  assert.equal(snapshot.lockfile_hash, null);
});
