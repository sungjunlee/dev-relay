const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  ensureRunLayout,
  getEventsPath,
  readManifest,
  writeManifest,
} = require("./relay-manifest");
const {
  applyMigrationStamp,
  buildEntriesByRunId,
  parseMigrationManifest,
  writeMigrationManifest,
} = require("./relay-migrate-rubric");

const SCRIPT = path.join(__dirname, "relay-migrate-rubric.js");

function initRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-migrate-rubric-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  process.env.RELAY_HOME = relayHome;
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Migrate Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-migrate@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return { repoRoot, relayHome };
}

function writeLegacyRun(repoRoot, runId) {
  const manifestPath = ensureRunLayout(repoRoot, runId).manifestPath;
  const manifest = {
    ...createManifestSkeleton({
      repoRoot,
      runId,
      branch: "issue-151",
      baseBranch: "main",
      issueNumber: 151,
      worktreePath: path.join(repoRoot, "wt", "issue-151"),
      orchestrator: "codex",
      executor: "codex",
      reviewer: "claude",
    }),
    state: STATES.REVIEW_PENDING,
    next_action: "run_review",
    anchor: {},
  };
  writeManifest(manifestPath, manifest);
  return manifestPath;
}

function writeMigrationDoc(manifestPath, runId, { appliedAt = null } = {}) {
  writeMigrationManifest(manifestPath, {
    version: 1,
    runs: [
      {
        run_id: runId,
        registered_by: "sjlee",
        registered_at: "2026-04-17T08:00:00Z",
        reason: "pre-rubric run needed merge after a hotfix",
        applied_at: appliedAt,
      },
    ],
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("applyMigrationStamp rejects runs that are not listed in the migration manifest", () => {
  // #151
  const { repoRoot, relayHome } = initRepo();
  const runId = "issue-151-20260417080000000";
  writeLegacyRun(repoRoot, runId);
  const migrationManifestPath = path.join(relayHome, "migrations", "rubric-mandatory.yaml");

  assert.throws(
    () => applyMigrationStamp({
      repoRoot,
      runId,
      entriesByRunId: buildEntriesByRunId({ version: 1, runs: [] }),
      manifestPath: migrationManifestPath,
      dryRun: true,
      appliedAt: "2026-04-17T08:00:05Z",
    }),
    (error) => {
      assert.match(error.message, new RegExp(escapeRegExp(runId)));
      assert.match(error.message, new RegExp(escapeRegExp(migrationManifestPath)));
      return true;
    }
  );
});

test("relay-migrate-rubric is idempotent after a manifest entry is applied", () => {
  // #151
  const { repoRoot, relayHome } = initRepo();
  const runId = "issue-151-20260417080000001";
  writeLegacyRun(repoRoot, runId);
  const migrationManifestPath = path.join(relayHome, "migrations", "rubric-mandatory.yaml");
  writeMigrationDoc(migrationManifestPath, runId);

  const first = JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--manifest", migrationManifestPath,
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" }));

  assert.equal(first.appliedCount, 1);
  assert.equal(first.skippedCount, 0);

  const stampedManifest = readManifest(ensureRunLayout(repoRoot, runId).manifestPath).data;
  assert.equal(stampedManifest.anchor.rubric_grandfathered.from_migration, "rubric-mandatory.yaml");
  assert.equal(stampedManifest.anchor.rubric_grandfathered.actor, "Relay Migrate Test");

  const eventsAfterFirstRun = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(eventsAfterFirstRun.length, 1);
  assert.equal(eventsAfterFirstRun[0].event, "rubric_migrated");

  const second = JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--manifest", migrationManifestPath,
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" }));

  assert.equal(second.appliedCount, 0);
  assert.equal(second.skippedCount, 1);
  assert.equal(second.skipped[0].status, "already_applied");

  const eventsAfterSecondRun = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(eventsAfterSecondRun.length, 1);

  const migrationDoc = parseMigrationManifest(fs.readFileSync(migrationManifestPath, "utf-8"), migrationManifestPath);
  assert.ok(migrationDoc.runs[0].applied_at);
});

test("relay-migrate-rubric refuses to reapply when object-form provenance already exists", () => {
  const { repoRoot, relayHome } = initRepo();
  const runId = "issue-151-20260417080000002";
  writeLegacyRun(repoRoot, runId);
  const migrationManifestPath = path.join(relayHome, "migrations", "rubric-mandatory.yaml");
  writeMigrationDoc(migrationManifestPath, runId);

  execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--manifest", migrationManifestPath,
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  writeMigrationDoc(migrationManifestPath, runId, { appliedAt: null });
  const rerun = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--manifest", migrationManifestPath,
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  assert.notEqual(rerun.status, 0);
  assert.match(rerun.stderr, /already has pre-existing object-form anchor\.rubric_grandfathered state/);

  const events = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(events.length, 1);
});

test("relay-migrate-rubric refuses to reapply after object-form provenance is tampered", () => {
  const { repoRoot, relayHome } = initRepo();
  const runId = "issue-151-20260417080000003";
  const manifestPath = writeLegacyRun(repoRoot, runId);
  const migrationManifestPath = path.join(relayHome, "migrations", "rubric-mandatory.yaml");
  writeMigrationDoc(migrationManifestPath, runId);

  execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--manifest", migrationManifestPath,
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const tamperedManifest = readManifest(manifestPath).data;
  tamperedManifest.anchor.rubric_grandfathered = {
    from_migration: "rubric-mandatory.yaml",
    applied_at: "",
    actor: "tampered-operator",
    reason: "tampered object should still block rerun",
  };
  writeManifest(manifestPath, tamperedManifest);
  writeMigrationDoc(migrationManifestPath, runId, { appliedAt: null });

  const rerun = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--manifest", migrationManifestPath,
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  assert.notEqual(rerun.status, 0);
  assert.match(rerun.stderr, /already has pre-existing object-form anchor\.rubric_grandfathered state/);

  const persistedManifest = readManifest(manifestPath).data;
  assert.equal(persistedManifest.anchor.rubric_grandfathered.applied_at, "");

  const events = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(events.length, 1);
});
