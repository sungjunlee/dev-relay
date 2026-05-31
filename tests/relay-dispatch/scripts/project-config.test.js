const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createProjectConfig,
  loadProjectConfig,
  writeProjectConfig,
} = require("../../../skills/relay-dispatch/scripts/project-config");
const {
  getProjectConfigPath,
  getRepoSlug,
} = require("../../../skills/relay-dispatch/scripts/manifest/paths");

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Project Config"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-project@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
}

function setup() {
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-project-config-repo-"));
  initGitRepo(repoRoot);
  return { relayHome, repoRoot };
}

test("project-config reports missing project.json as absent", () => {
  const { relayHome, repoRoot } = setup();

  const result = loadProjectConfig({ repoRoot, relayHome });

  assert.equal(result.ok, true);
  assert.equal(result.status, "absent");
  assert.equal(result.config, null);
  assert.equal(result.path, getProjectConfigPath(repoRoot, { relayHome }));
});

test("project-config creates and round-trips deterministic project metadata", () => {
  const { relayHome, repoRoot } = setup();
  const now = "2026-05-31T00:00:00.000Z";

  const config = createProjectConfig({ repoRoot, now });
  const written = writeProjectConfig({ repoRoot, relayHome, config });
  const loaded = loadProjectConfig({ repoRoot, relayHome });

  assert.equal(written.repo_slug, getRepoSlug(repoRoot));
  assert.equal(written.display_name, path.basename(repoRoot));
  assert.equal(written.canonical_repo_root, fs.realpathSync(repoRoot));
  assert.equal(written.created_at, now);
  assert.equal(written.updated_at, now);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.status, "ok");
  assert.deepEqual(loaded.config, written);
});

test("project-config validates malformed JSON with source path", () => {
  const { relayHome, repoRoot } = setup();
  const projectPath = getProjectConfigPath(repoRoot, { relayHome });
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  fs.writeFileSync(projectPath, "{not-json\n", "utf-8");

  const result = loadProjectConfig({ repoRoot, relayHome });

  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.equal(result.path, projectPath);
  assert.match(result.error, /failed to parse project config/);
  assert.match(result.error, new RegExp(projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
