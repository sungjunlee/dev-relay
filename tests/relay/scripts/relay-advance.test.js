"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const facts = require("../../../skills/relay-dispatch/scripts/facts");

const ROOT = path.resolve(__dirname, "../../..");
const ADVANCE = path.join(ROOT, "skills/relay/scripts/relay-advance.js");
const { commandFor } = require(ADVANCE);
const REVIEW = path.join(ROOT, "tests/relay/fixtures/local-review-worker.js");
const HOST_BYPASS = path.join(ROOT, "tests/relay/fixtures/relay1244-host-bypass.js");
const { createRunRecord } = require("../../../skills/relay-dispatch/scripts/run-store");
const COMMIT_DATE = "2026-08-15T00:02:00Z";

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function run(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: "utf8", env, timeout: 60_000 });
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-advance-")));
  const repo = path.join(root, "repo"), relayHome = path.join(root, "relay-home"), runDir = path.join(root, "advance-test");
  fs.mkdirSync(repo); git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "advance-test"]); git(repo, ["config", "user.email", "advance@test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n"); git(repo, ["add", "."]); git(repo, ["commit", "-m", "base"]);
  const start = git(repo, ["rev-parse", "HEAD"]); const worktree = path.join(root, "relay-home", "worktrees", "advance-worktree");
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(repo, ["branch", "work"]); execFileSync("git", ["-C", repo, "worktree", "add", worktree, "work"], { stdio: "ignore" });
  fs.writeFileSync(path.join(worktree, "advance.txt"), "reviewable\n");
  fs.mkdirSync(runDir); const criteria = path.join(runDir, "done-criteria.md"); fs.writeFileSync(criteria, "- reviewable\n");
  createRunRecord({ runDir, record: {
    version: 3, run_id: "advance-test", repo: { root: fs.realpathSync(repo), remote: "local/repo" },
    git: { branch: "work", base_branch: "main", worktree: fs.realpathSync(worktree), start_sha: start },
    contract: { done_criteria_path: criteria, done_criteria_sha256: crypto.createHash("sha256").update(fs.readFileSync(criteria)).digest("hex") },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "codex" }, parent: null, ownership_digest: null,
    created_at: "2026-08-15T00:00:00Z",
  } });
  const tree = git(worktree, ["rev-parse", "HEAD^{tree}"]);
  fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({ event_id: "attempt-finished", run_id: "advance-test", attempt_id: "attempt-1", type: "attempt_finished", at: "2026-08-15T00:01:00Z", actor: "codex", payload: { status: "completed", start_sha: start, final_sha: start, tree_sha: tree, result_path: path.join(runDir, "result.json"), exit_code: 0, verification_status: "passed" } })}\n`);
  const prompt = path.join(root, "prompt.md"), rubric = path.join(root, "rubric.yaml");
  fs.writeFileSync(prompt, "make one reviewable change\n"); fs.writeFileSync(rubric, "done_criteria:\n  - change is reviewable\n");
  const gh = path.join(root, "gh-trap.js"); fs.writeFileSync(gh, "#!/usr/bin/env node\nprocess.exit(91);\n"); fs.chmodSync(gh, 0o755);
  const value = { root, repo, relayHome, runDir, worktree, prompt, rubric, gh };
  fs.mkdirSync(path.join(relayHome, "worktrees"), { recursive: true });
  value.env = {
    ...process.env, RELAY_HOME: relayHome, RELAY_WORKTREE_BASE: path.join(relayHome, "worktrees"),
    RELAY_GH_BIN: gh,
    GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${HOST_BYPASS}`].filter(Boolean).join(" "),
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return value;
}
function launch(value) { return { run_dir: value.runDir, worktree: value.worktree }; }
function advance(value, launch, extra = []) {
  return run(ADVANCE, ["--run-dir", launch.run_dir, ...extra, "--json"], value.env);
}
function inspection(value, launch) {
  const result = run(path.join(ROOT, "skills/relay/scripts/relay-recover.js"), ["inspect", "--run-dir", launch.run_dir, "--json"], value.env);
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
function writeVerification(value, launch, operator = "advance-test", valid = true, expected = {}) {
  const head = expected.head || git(launch.worktree, ["rev-parse", "HEAD"]);
  const tree = expected.tree || git(launch.worktree, ["rev-parse", "HEAD^{tree}"]);
  const resultPath = path.join(value.root, "verification.log"); fs.writeFileSync(resultPath, "advance verification\n");
  const record = JSON.parse(fs.readFileSync(path.join(launch.run_dir, "run.json"), "utf8"));
  const file = path.join(value.root, "verification.json");
  fs.writeFileSync(file, JSON.stringify(valid ? {
    schema_version: 1, head_sha: head, tree_sha: tree, done_criteria_sha256: record.contract.done_criteria_sha256,
    operator, commands: ["node --test"], completed_commands: [{ command: "node --test", exit_code: 0 }],
    result_path: resultPath, result_sha256: crypto.createHash("sha256").update(fs.readFileSync(resultPath)).digest("hex"),
  } : { invalid: true }));
  return file;
}
function factsFor(launch) { return facts.readFacts({ eventsPath: path.join(launch.run_dir, "events.jsonl") }).facts; }
function verificationForDirtyRecovery(value, launch) {
  const before = inspection(value, launch);
  assert.deepEqual(before.recommended_action.steps, ["commit_work"]);
  git(launch.worktree, ["add", "-A"]);
  const tree = git(launch.worktree, ["write-tree"]);
  git(launch.worktree, ["reset"]);
  const parent = git(launch.worktree, ["rev-parse", "HEAD"]);
  const message = `Recover relay run advance-test\n\nReason: relay-advance: ${before.recommended_action.reason}\n`;
  const head = execFileSync("git", ["-C", launch.worktree, "commit-tree", tree, "-p", parent], {
    encoding: "utf8", input: message, env: value.env, stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  return writeVerification(value, launch, "advance-test", true, { head, tree });
}
function reachReview(value, launch) {
  const verification = verificationForDirtyRecovery(value, launch);
  const result = advance(value, launch, ["--verification-file", verification, "--actor", "advance-test"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.applied_actions, 2);
  assert.equal(output.stop_reason, "review");
  return verification;
}
function makeWaiting(value, launch) {
  const record = JSON.parse(fs.readFileSync(path.join(launch.run_dir, "run.json"), "utf8"));
  const started = {
    event_id: "attempt-started", run_id: record.run_id, attempt_id: "attempt-live", type: "attempt_started",
    at: "2026-08-15T00:01:00Z", actor: "codex",
    payload: {
      executor: "codex", model: "gpt-5", start_sha: record.git.start_sha,
      host_kind: "local_supervisor", host_handle: "fixture-live",
      stdout_path: path.join(launch.run_dir, "stdout.log"), stderr_path: path.join(launch.run_dir, "stderr.log"),
      result_path: path.join(launch.run_dir, "result.txt"), timeout_ms: 60000,
    },
  };
  fs.writeFileSync(path.join(launch.run_dir, "events.jsonl"), `${JSON.stringify(started)}\n`);
  fs.mkdirSync(path.join(launch.run_dir, "ownership"), { mode: 0o700 });
  const preload = path.join(value.root, "live-host.js");
  const hostPath = path.join(ROOT, "skills/relay-dispatch/scripts/host.js");
  fs.writeFileSync(preload, `const host=require(${JSON.stringify(hostPath)});host.inspectOwnership=()=>({status:"live",reason:"fixture_live"});\n`);
  value.env = { ...value.env, NODE_OPTIONS: `${value.env.NODE_OPTIONS} --require=${preload}` };
}

test("commandFor emits exact review, merge, and redispatch commands", () => {
  const runDir = "/tmp/relay advance/run";
  const record = { run_id: "advance-test", repo: { root: "/tmp/relay advance/repo" } };
  assert.equal(
    commandFor(runDir, record, "review"),
    `node '${path.join(ROOT, "skills/relay-review/scripts/review-runner.js")}' --repo '/tmp/relay advance/repo' --run-dir '/tmp/relay advance/run' --json`,
  );
  assert.equal(
    commandFor(runDir, record, "merge", null, "review actor"),
    `node '${path.join(ROOT, "skills/relay-merge/scripts/finalize-run.js")}' --repo '/tmp/relay advance/repo' --run-dir '/tmp/relay advance/run' --actor 'review actor' --json`,
  );
  assert.equal(
    commandFor(runDir, record, "redispatch"),
    `node '${path.join(ROOT, "skills/relay-dispatch/scripts/dispatch.js")}' '/tmp/relay advance/repo' --run-id 'advance-test' --prompt '<operator correction prompt>' --json`,
  );
});

test("relay SKILL.md stays below the 150-line budget", () => {
  const lines = fs.readFileSync(path.join(ROOT, "skills/relay/SKILL.md"), "utf8").trimEnd().split(/\r?\n/);
  assert.ok(lines.length < 150, `skills/relay/SKILL.md has ${lines.length} lines`);
});

test("CLI rejects unknown flags, mixed run selectors, and invalid step budgets", (t) => {
  const unknown = run(ADVANCE, ["--unknown", "--json"], process.env);
  assert.notEqual(unknown.status, 0); assert.match(unknown.stderr, /unknown flags: --unknown/);
  const adjacentUnknown = run(ADVANCE, ["--repo", "--unknown", "--run-id", "run", "--json"], process.env);
  assert.notEqual(adjacentUnknown.status, 0); assert.match(adjacentUnknown.stderr, /unknown flags: --unknown/);

  const value = fixture(t); const eventPath = path.join(value.runDir, "events.jsonl"); const eventsBefore = fs.readFileSync(eventPath);
  const adjacentKnown = run(ADVANCE, ["--run-dir", value.runDir, "--actor", "--json"], value.env);
  assert.notEqual(adjacentKnown.status, 0); const flagError = JSON.parse(adjacentKnown.stderr);
  assert.equal(flagError.ok, false); assert.equal(flagError.code, "ADVANCE_FAILED"); assert.match(flagError.error, /--actor.*requires/);
  assert.deepEqual(fs.readFileSync(eventPath), eventsBefore);

  const mixed = run(ADVANCE, ["--run-dir", "/tmp/run", "--repo", "/tmp/repo", "--run-id", "run", "--json"], process.env);
  assert.notEqual(mixed.status, 0); assert.match(mixed.stderr, /mutually exclusive/);
  for (const value of ["0", "1.5", "invalid"]) {
    const invalid = run(ADVANCE, ["--run-dir", "/tmp/run", "--max-steps", value, "--json"], process.env);
    assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /positive integer/);
  }
});

test("7a convergence and idempotence apply consecutive production recoveries", (t) => {
  const value = fixture(t), launchValue = launch(value, t); const verification = reachReview(value, launchValue);
  const before = fs.readFileSync(path.join(launchValue.run_dir, "events.jsonl"));
  const repeated = advance(value, launchValue, ["--verification-file", verification, "--actor", "advance-test"]);
  assert.equal(repeated.status, 0, repeated.stderr); const output = JSON.parse(repeated.stdout);
  assert.equal(output.applied_actions, 0); assert.equal(output.stop_reason, "review");
  assert.equal("applied_action_count" in output, false);
  assert.deepEqual(fs.readFileSync(path.join(launchValue.run_dir, "events.jsonl")), before);
});

test("7b local reviewed result closes through canonical recovery", (t) => {
  const value = fixture(t), launchValue = launch(value, t); const verification = reachReview(value, launchValue);
  const reviewed = run(REVIEW, [], { ...value.env, RELAY_TEST_REPO: value.repo, RELAY_TEST_RUN_DIR: launchValue.run_dir });
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const closed = advance(value, launchValue, ["--verification-file", verification, "--actor", "advance-test"]);
  assert.equal(closed.status, 0, closed.stderr); const output = JSON.parse(closed.stdout);
  assert.equal(output.applied_actions, 1); assert.equal(output.stop_reason, "none");
  assert.equal(output.final_inspection.derived.terminal, true);
});

test("7c wait and operator_attention are byte-preserving stops", (t) => {
  const value = fixture(t), launchValue = launch(value, t); const verification = reachReview(value, launchValue);
  const reviewed = run(REVIEW, [], { ...value.env, RELAY_TEST_REPO: value.repo, RELAY_TEST_RUN_DIR: launchValue.run_dir });
  assert.equal(reviewed.status, 0, reviewed.stderr);
  git(launchValue.worktree, ["remote", "add", "origin", "https://gitlab.example.test/owner/repo.git"]);
  const eventPath = path.join(launchValue.run_dir, "events.jsonl"), before = fs.readFileSync(eventPath);
  const attention = advance(value, launchValue, ["--verification-file", verification]);
  assert.equal(attention.status, 0, attention.stderr || attention.stdout); assert.equal(JSON.parse(attention.stdout).stop_reason, "operator_attention");
  assert.deepEqual(fs.readFileSync(eventPath), before);

  const live = fixture(t), detached = launch(live); makeWaiting(live, detached);
  const liveEvents = path.join(detached.run_dir, "events.jsonl"), liveBefore = fs.readFileSync(liveEvents);
  const waiting = advance(live, detached); assert.equal(waiting.status, 0, waiting.stderr || waiting.stdout);
  assert.equal(JSON.parse(waiting.stdout).stop_reason, "wait"); assert.deepEqual(fs.readFileSync(liveEvents), liveBefore);
});

test("7d missing verification input stops before recovery", (t) => {
  const value = fixture(t), launchValue = launch(value, t); const first = advance(value, launchValue);
  assert.equal(first.status, 0, first.stderr); const eventPath = path.join(launchValue.run_dir, "events.jsonl");
  const before = fs.readFileSync(eventPath); const stopped = advance(value, launchValue);
  assert.equal(stopped.status, 0, stopped.stderr); const output = JSON.parse(stopped.stdout);
  assert.equal(output.stop_reason, "missing_required_input:verification_file"); assert.match(output.next_command, /verification-file/);
  assert.deepEqual(fs.readFileSync(eventPath), before);
});

test("7e recovery failure is reported once without continuation", (t) => {
  const value = fixture(t), launchValue = launch(value, t); advance(value, launchValue);
  const invalid = writeVerification(value, launchValue, "advance-test", false);
  const eventPath = path.join(launchValue.run_dir, "events.jsonl"), before = fs.readFileSync(eventPath);
  const intentsBefore = fs.readdirSync(launchValue.run_dir).filter((name) => name.startsWith("recovery-intent-")).length;
  const failed = advance(value, launchValue, ["--verification-file", invalid, "--actor", "advance-test"]);
  assert.notEqual(failed.status, 0); const output = JSON.parse(failed.stdout);
  assert.equal(output.stop_reason, "recover_failed"); assert.match(output.failure.code, /VERIFICATION|RECOVERY/);
  const intentsAfter = fs.readdirSync(launchValue.run_dir).filter((name) => name.startsWith("recovery-intent-")).length;
  assert.equal(intentsAfter - intentsBefore, 1);
  assert.deepEqual(fs.readFileSync(eventPath), before); assert.equal(factsFor(launchValue).filter((fact) => fact.type === "recovery_applied").length, 1);
});

test("7f max-steps applies one recovery and stops with the budget reason", (t) => {
  const value = fixture(t), launchValue = launch(value, t); const verification = verificationForDirtyRecovery(value, launchValue);
  const limited = advance(value, launchValue, ["--max-steps", "1", "--verification-file", verification, "--actor", "advance-test"]);
  assert.equal(limited.status, 0, limited.stderr); const output = JSON.parse(limited.stdout);
  assert.equal(output.applied_actions, 1); assert.equal(output.stop_reason, "step_budget_exhausted");
  assert.equal(factsFor(launchValue).filter((fact) => fact.type === "recovery_applied").length, 1);
});
