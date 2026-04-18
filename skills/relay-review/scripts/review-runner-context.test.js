const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ensureRunLayout } = require("../../relay-dispatch/scripts/relay-manifest");
const {
  createEnforcementFixture,
  DEFAULT_ENFORCEMENT_RUBRIC,
} = require("../../relay-dispatch/scripts/test-support");
const {
  loadRubricFromRunDir,
  parseRemoteHost,
} = require("./review-runner/context");

function createRunFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-context-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
  const runId = "issue-189-20260418010101010";
  const { runDir } = ensureRunLayout(repoRoot, runId);
  return { repoRoot, runDir, runId };
}

test("context/loadRubricFromRunDir preserves the rubric state matrix", async (t) => {
  const cases = [
    { label: "loaded", fixture: { state: "loaded" }, expectedState: "loaded", expectedStatus: "satisfied", warning: null },
    { label: "grandfathered", fixture: { grandfather: true }, expectedState: "grandfathered", expectedStatus: "grandfathered", warning: /migration provenance/i },
    { label: "not_set", fixture: { state: "not_set" }, expectedState: "not_set", expectedStatus: "missing_path", warning: /\[rubric path not set\]/i },
    { label: "missing", fixture: { state: "missing" }, expectedState: "missing", expectedStatus: "missing", warning: /\[rubric missing\]/i },
    { label: "outside_run_dir", fixture: { state: "outside_run_dir" }, expectedState: "outside_run_dir", expectedStatus: "outside_run_dir", warning: /\[rubric path outside run dir\]/i },
    { label: "empty", fixture: { state: "empty" }, expectedState: "empty", expectedStatus: "empty", warning: /\[rubric empty\]/i },
    { label: "invalid", fixture: { state: "invalid" }, expectedState: "invalid", expectedStatus: "not_file", warning: /\[rubric invalid\]/i },
  ];

  for (const entry of cases) {
    await t.test(entry.label, () => {
      const { repoRoot, runDir, runId } = createRunFixture();
      const fixture = createEnforcementFixture({
        repoRoot,
        runId,
        ...entry.fixture,
      });
      const result = loadRubricFromRunDir(runDir, {
        run_id: runId,
        anchor: fixture.anchor,
      });

      assert.equal(result.state, entry.expectedState);
      assert.equal(result.status, entry.expectedStatus);
      if (entry.expectedState === "loaded") {
        assert.equal(result.content, DEFAULT_ENFORCEMENT_RUBRIC);
        assert.equal(result.warning, null);
      } else {
        assert.match(result.warning, entry.warning);
      }
    });
  }
});

test("context/loadRubricFromRunDir classifies a symlinked rubric as invalid", () => {
  const { runDir, runId } = createRunFixture();
  const siblingTarget = path.join(runDir, "rubric-copy.yaml");
  fs.writeFileSync(siblingTarget, "rubric:\n  factors:\n    - name: sibling\n", "utf-8");
  fs.symlinkSync(siblingTarget, path.join(runDir, "rubric.yaml"));

  const result = loadRubricFromRunDir(runDir, {
    run_id: runId,
    anchor: { rubric_path: "rubric.yaml" },
  });

  assert.equal(result.state, "invalid");
  assert.equal(result.status, "symlink_escape");
  assert.match(result.warning, /\[rubric invalid\]/i);
  assert.match(result.warning, /must not be a symlink/i);
});

test("context/loadRubricFromRunDir classifies a malformed rubric path as invalid", () => {
  const { runDir, runId } = createRunFixture();
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: malformed\n", "utf-8");

  const result = loadRubricFromRunDir(runDir, {
    run_id: runId,
    anchor: { rubric_path: "rubric.yaml/child" },
  });

  assert.equal(result.state, "invalid");
  assert.equal(result.status, "unreadable");
  assert.match(result.warning, /\[rubric invalid\]/i);
});

test("context/parseRemoteHost preserves the origin parsing matrix", async (t) => {
  const cases = [
    ["https origin", "https://github.example.com/acme/repo.git", "github.example.com"],
    ["ssh scp origin", "git@github.example.com:acme/repo.git", "github.example.com"],
    ["ssh without user", "github.example.com:acme/repo.git", "github.example.com"],
    ["ssh URL origin", "ssh://git@github.example.com/acme/repo.git", "github.example.com"],
    ["windows local path", "C:/Users/sjlee/repo", null],
    ["malformed hostname", "https://bad host/acme/repo.git", null],
  ];

  for (const [label, input, expected] of cases) {
    await t.test(label, () => {
      assert.equal(parseRemoteHost(input), expected);
    });
  }
});
