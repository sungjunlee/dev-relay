"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DISPATCH_JS = path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "dispatch.js");
const { getRepoSlug } = require(path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "manifest", "paths.js"));
const { readManifest } = require(path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "manifest", "store.js"));

function setupRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-marker-recovery-dispatch-"));
  const repoRoot = path.join(base, "repo");
  const relayHome = path.join(base, "relay");
  const remoteRoot = path.join(base, "origin.git");
  const binDir = path.join(base, "bin");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const git = (args, cwd = repoRoot) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["init", "--bare", remoteRoot], base);
  git(["config", "user.name", "dispatch-marker-test"]);
  git(["config", "user.email", "dispatch-marker-test@example.com"]);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "marker recovery\n", "utf-8");
  git(["add", "README.md"]);
  git(["commit", "-m", "initial"]);
  git(["remote", "add", "origin", remoteRoot]);
  git(["push", "-u", "origin", "main"]);

  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!${process.execPath}
const fs = require("fs");
const cp = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("codex-fixture\\n"); process.exit(0); }
if (args[0] !== "exec") process.exit(2);
const cwd = args[args.indexOf("-C") + 1];
const output = args[args.indexOf("-o") + 1];
fs.writeFileSync(process.env.RELAY_TEST_EXECUTOR_MARKER, "spawned\\n", "utf-8");
fs.writeFileSync(cwd + "/executor.txt", "done\\n", "utf-8");
cp.execFileSync("git", ["-C", cwd, "add", "executor.txt"]);
cp.execFileSync("git", ["-C", cwd, "commit", "-m", "fixture executor"]);
fs.writeFileSync(output, "done\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);

  const rubricPath = path.join(base, "rubric.yaml");
  fs.writeFileSync(rubricPath, "rubric:\n  factors:\n    - name: marker recovery\n      target: exit 0\n", "utf-8");
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin`,
    RELAY_HOME: relayHome,
    RELAY_TEST_EXECUTOR_MARKER: path.join(base, "executor-spawned"),
  };
  return { base, repoRoot, relayHome, rubricPath, env };
}

function runDispatch(fixture, extraArgs, envOverrides = {}) {
  const result = spawnSync(process.execPath, [DISPATCH_JS, fixture.repoRoot, ...extraArgs], {
    cwd: fixture.repoRoot,
    env: { ...fixture.env, ...envOverrides },
    encoding: "utf-8",
  });
  let body = null;
  if (result.stdout.trim()) body = JSON.parse(result.stdout);
  return { ...result, body };
}

function dispatchArgs(fixture, runId) {
  return [
    "--run-id", runId,
    "--branch", "issue-1016-marker-recovery",
    "--prompt", "marker recovery fixture",
    "--executor", "codex",
    "--rubric-file", fixture.rubricPath,
    "--publish-policy", "after-internal-review",
    "--coordination-marker", "relay-orca: marker-test/outcome-a",
    "--json",
  ];
}

function assertNoOwningRun(fixture, runId) {
  const runRoot = path.join(fixture.relayHome, "runs", getRepoSlug(fixture.repoRoot));
  const manifestPath = path.join(runRoot, `${runId}.md`);
  assert.equal(fs.existsSync(manifestPath), false, "provisional failure must leave no owning manifest");
  const runDir = path.join(runRoot, runId);
  assert.equal(fs.existsSync(runDir), false, "provisional failure must remove the run directory");
  const worktrees = path.join(fixture.relayHome, "worktrees");
  assert.equal(fs.existsSync(worktrees) ? fs.readdirSync(worktrees).length : 0, 0, "provisional failure must remove relay worktrees");
}

function readFixtureEvents(fixture, runId) {
  const eventsPath = path.join(fixture.relayHome, "runs", getRepoSlug(fixture.repoRoot), runId, "events.jsonl");
  return fs.readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

for (const [label, failureEnv] of [
  ["worktree creation", { RELAY_TEST_FAIL_CREATE_WORKTREE: "1" }],
  ["base-branch merge", { RELAY_TEST_FAIL_BASE_MERGE: "1" }],
]) {
  test(`marker ${label} failure rolls back provisional ownership and permits same-run retry`, () => {
    const fixture = setupRepo();
    const runId = `issue-1016-marker-${label === "worktree creation" ? "create" : "merge"}-20260720120000000-aabbccdd`;
    try {
      const failed = runDispatch(fixture, dispatchArgs(fixture, runId), failureEnv);
      assert.notEqual(failed.status, 0, failed.stderr);
      assert.equal(failed.body.recoverable, true, JSON.stringify(failed.body));
      assertNoOwningRun(fixture, runId);

      const retried = runDispatch(fixture, dispatchArgs(fixture, runId));
      assert.equal(retried.status, 0, `${retried.stderr}\n${retried.stdout}`);
      assert.equal(retried.body.runId, runId);
      assert.equal(retried.body.runState, "internal_review_pending");
      assert.equal(fs.existsSync(fixture.env.RELAY_TEST_EXECUTOR_MARKER), true, "retry may execute exactly once after setup recovery");
    } finally {
      fs.rmSync(fixture.base, { recursive: true, force: true });
    }
  });
}

test("final marker durability failure records an interrupted recovery event before executor spawn", () => {
  const fixture = setupRepo();
  const runId = "issue-1016-marker-final-20260720120000000-aabbccdd";
  try {
    const failed = runDispatch(fixture, dispatchArgs(fixture, runId), {
      RELAY_TEST_FAIL_FINAL_COORDINATION_MARKER_VERIFY: "1",
    });
    assert.notEqual(failed.status, 0, failed.stderr);
    assert.equal(failed.body.error_code, "coordination_marker_not_persisted");
    assert.equal(failed.body.interruption_audit, "dispatch_interrupted");
    assert.equal(fs.existsSync(fixture.env.RELAY_TEST_EXECUTOR_MARKER), false, "durability failure must precede executor spawn");

    const manifestPath = path.join(fixture.relayHome, "runs", getRepoSlug(fixture.repoRoot), `${runId}.md`);
    const manifest = readManifest(manifestPath).data;
    assert.equal(manifest.state, "dispatched");
    assert.equal(fs.existsSync(manifest.paths.worktree), true, "interrupted recovery retains the clean worktree");
    const interrupted = readFixtureEvents(fixture, runId).at(-1);
    assert.equal(interrupted.event, "dispatch_interrupted");
    assert.equal(interrupted.reason, "coordination_marker_not_persisted_before_executor_spawn");
    assert.equal(interrupted.state_from, "dispatched");
    assert.equal(interrupted.state_to, "dispatched");
    assert.equal(interrupted.coordination_marker, "relay-orca: marker-test/outcome-a");

    const resumed = runDispatch(fixture, [
      "--manifest", manifestPath,
      "--prompt", "resume after marker durability recovery",
      "--json",
    ]);
    assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
    assert.equal(resumed.body.runState, "internal_review_pending");
    assert.equal(fs.existsSync(fixture.env.RELAY_TEST_EXECUTOR_MARKER), true);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});
