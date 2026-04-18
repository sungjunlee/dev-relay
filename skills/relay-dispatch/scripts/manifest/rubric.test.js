const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  getRubricAnchorStatus,
  rejectLegacyGrandfatherField,
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
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot);
  const layout = ensureRunLayout(repoRoot, runId);
  return { repoRoot, runDir: layout.runDir };
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

test("manifest/rubric rejectLegacyGrandfatherField rejects every retained legacy shape", async (t) => {
  const cases = [
    ["undefined", {}, true],
    ["false", { rubric_grandfathered: false }, false],
    ["true", { rubric_grandfathered: true }, false],
    ["object", {
      rubric_grandfathered: {
        from_migration: "rubric-mandatory.yaml",
        applied_at: "2026-04-17T08:00:05.000Z",
        actor: "test-reviewer",
      },
    }, false],
  ];

  for (const [label, anchor, ok] of cases) {
    await t.test(label, () => {
      const result = rejectLegacyGrandfatherField({
        run_id: "issue-188-20260418091011124-a1b2c3d4",
        anchor,
      });
      assert.equal(result.ok, ok);
      if (!ok) {
        assert.match(result.error, /issue-188-20260418091011124-a1b2c3d4/);
        assert.match(result.error, /anchor\.rubric_grandfathered is no longer supported/);
        assert.match(result.error, /close-run\.js/);
      }
    });
  }
});

test("manifest/rubric rejects legacy grandfather field during anchor resolution", () => {
  const runId = "issue-188-20260418091011125-a1b2c3d4";
  const { repoRoot } = createRunLayout(runId);

  const result = getRubricAnchorStatus({
    run_id: runId,
    anchor: {
      rubric_path: "rubric.yaml",
      rubric_grandfathered: {
        from_migration: "rubric-mandatory.yaml",
        applied_at: "2026-04-17T08:00:05.000Z",
        actor: "test-reviewer",
      },
    },
    paths: { repo_root: repoRoot },
  });

  assert.equal(result.status, "legacy_grandfather_field");
  assert.equal(result.satisfied, false);
  assert.match(result.error, /anchor\.rubric_grandfathered is no longer supported/);
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
