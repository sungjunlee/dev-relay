const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  RUBRIC_MIGRATION_MANIFEST_BASENAME,
  getRubricAnchorStatus,
  validateRubricPathContainment,
} = require("./rubric");
const { ensureRunLayout } = require("./paths");

function initGitRepo(repoRoot, actor = "Relay Rubric Test") {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", actor], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-rubric@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
}

function createRunLayout(runId) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-rubric-repo-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  process.env.RELAY_HOME = relayHome;
  initGitRepo(repoRoot);
  const layout = ensureRunLayout(repoRoot, runId);
  return { repoRoot, relayHome, runDir: layout.runDir };
}

function writeMigrationManifest(relayHome, runId, appliedAt = "2026-04-17T08:00:05.000Z") {
  const migrationManifestPath = path.join(relayHome, "migrations", RUBRIC_MIGRATION_MANIFEST_BASENAME);
  fs.mkdirSync(path.dirname(migrationManifestPath), { recursive: true });
  fs.writeFileSync(migrationManifestPath, `version: 1
runs:
  - run_id: "${runId}"
    registered_by: "test-registration"
    registered_at: "2026-04-17T08:00:00Z"
    reason: "direct rubric coverage"
    applied_at: "${appliedAt}"
`, "utf-8");
  return { migrationManifestPath, appliedAt };
}

test("manifest/rubric reports missing rubric paths directly", () => {
  const result = getRubricAnchorStatus({
    run_id: "issue-188-20260418091011123-a1b2c3d4",
    anchor: {},
    paths: { repo_root: "/tmp/repo" },
  }, {
    runDir: "/tmp/relay-run",
  });

  assert.equal(result.status, "missing_path");
  assert.equal(result.satisfied, false);
});

test("manifest/rubric accepts registered migration-manifest provenance", () => {
  const runId = "issue-188-20260418091011124-a1b2c3d4";
  const { repoRoot, relayHome } = createRunLayout(runId);
  const { appliedAt } = writeMigrationManifest(relayHome, runId);

  const result = getRubricAnchorStatus({
    run_id: runId,
    anchor: {
      rubric_grandfathered: {
        from_migration: RUBRIC_MIGRATION_MANIFEST_BASENAME,
        applied_at: appliedAt,
        actor: "test-reviewer",
        reason: "direct rubric coverage",
      },
    },
    paths: { repo_root: repoRoot },
  });

  assert.equal(result.status, "grandfathered");
  assert.equal(result.satisfied, true);
  assert.equal(result.legacyGrandfather, false);
  assert.equal(result.grandfatherProvenance.from_migration, RUBRIC_MIGRATION_MANIFEST_BASENAME);
});

test("manifest/rubric rejects unregistered migration-manifest provenance", () => {
  const runId = "issue-188-20260418091011125-a1b2c3d4";
  const { repoRoot, relayHome } = createRunLayout(runId);
  writeMigrationManifest(relayHome, "issue-188-20260418091011126-a1b2c3d4");

  const result = getRubricAnchorStatus({
    run_id: runId,
    anchor: {
      rubric_grandfathered: {
        from_migration: RUBRIC_MIGRATION_MANIFEST_BASENAME,
        applied_at: "2026-04-17T08:00:05.000Z",
        actor: "test-reviewer",
      },
    },
    paths: { repo_root: repoRoot },
  });

  assert.equal(result.status, "missing_path");
  assert.equal(result.satisfied, false);
  assert.match(result.error, /is not listed in the migration manifest/);
});

test("manifest/rubric rejects parent traversal through getRubricAnchorStatus", () => {
  const runId = "issue-188-20260418091011127-a1b2c3d4";
  const { repoRoot } = createRunLayout(runId);

  const result = getRubricAnchorStatus({
    run_id: runId,
    anchor: { rubric_path: "../escape.yaml" },
    paths: { repo_root: repoRoot },
  });

  assert.equal(result.status, "outside_run_dir");
  assert.equal(result.satisfied, false);
  assert.match(result.error, /\.\./);
});

test("manifest/rubric containment rejects absolute paths", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-rubric-run-"));
  const result = validateRubricPathContainment("/etc/passwd", runDir);
  assert.equal(result.valid, false);
  assert.equal(result.status, "outside_run_dir");
});

test("manifest/rubric rejects symlinked rubric paths even when the target is readable", () => {
  const runId = "issue-188-20260418091011128-a1b2c3d4";
  const { repoRoot, runDir } = createRunLayout(runId);
  const siblingTarget = path.join(runDir, "rubric-copy.yaml");
  fs.writeFileSync(siblingTarget, "rubric:\n  factors:\n    - name: sibling\n", "utf-8");
  fs.symlinkSync(siblingTarget, path.join(runDir, "rubric.yaml"));

  const result = getRubricAnchorStatus({
    run_id: runId,
    anchor: { rubric_path: "rubric.yaml" },
    paths: { repo_root: repoRoot },
  });

  assert.equal(result.status, "symlink_escape");
  assert.equal(result.satisfied, false);
});
