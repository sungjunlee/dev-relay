"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createRunRecord } = require("../../../skills/relay-dispatch/scripts/run-store");
const facts = require("../../../skills/relay-dispatch/scripts/facts");

const ROOT = path.resolve(__dirname, "../../..");
const CLI = path.join(ROOT, "skills/relay/scripts/relay-recover.js");
const HOST_BYPASS = path.join(ROOT, "tests/relay/fixtures/relay1244-host-bypass.js");
const CRASH_AT_FACT = path.join(ROOT, "tests/relay/fixtures/crash-at-fact.js");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function fixture({ github = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-1244-cli-")));
  const repo = path.join(root, "repo");
  const runDir = path.join(root, "relay-1244");
  fs.mkdirSync(repo); fs.mkdirSync(runDir);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "relay@example.test"]);
  git(repo, ["config", "user.name", "owner"]);
  fs.writeFileSync(path.join(repo, "README.md"), "before\n");
  git(repo, ["add", "README.md"]); git(repo, ["commit", "-m", "initial"]);
  const start = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-b", "work"]);
  fs.writeFileSync(path.join(repo, "README.md"), "reviewable\n");
  git(repo, ["commit", "-am", "reviewable"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
  git(repo, ["checkout", "main"]);
  const worktree = path.join(root, "worktree");
  execFileSync("git", ["-C", repo, "worktree", "add", worktree, "work"], { stdio: "ignore" });
  if (github) {
    const bare = path.join(root, "remote.git");
    execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "push", bare, "work"], { stdio: "ignore" });
    git(repo, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  }
  const criteriaPath = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteriaPath, "- README.md is reviewable\n");
  const criteriaHash = sha(fs.readFileSync(criteriaPath));
  createRunRecord({ runDir, record: {
    version: 3, run_id: "relay-1244", repo: { root: repo, remote: github ? "owner/repo" : "local/repo" },
    git: { branch: "work", base_branch: "main", worktree, start_sha: start },
    contract: { done_criteria_path: criteriaPath, done_criteria_sha256: criteriaHash },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
    parent: null, ownership_digest: null, created_at: "2026-08-01T00:00:00Z",
  } });
  const eventsPath = path.join(runDir, "events.jsonl"); fs.writeFileSync(eventsPath, "");
  const attempt = {
    event_id: "attempt-finished", run_id: "relay-1244", attempt_id: "attempt-1", type: "attempt_finished",
    at: "2026-08-01T00:01:00Z", actor: "codex",
    payload: { status: "completed", start_sha: start, final_sha: head, tree_sha: tree,
      result_path: path.join(runDir, "result.json"), exit_code: 0, verification_status: "passed" },
  };
  const pr = {
    event_id: "pr", run_id: "relay-1244", type: "pull_request_recorded", at: "2026-08-01T00:01:01Z", actor: "codex",
    payload: { pr_number: 42, repo: "owner/repo", head_ref: "work", base_ref: "main", head_sha: head, created_by_relay: true },
  };
  fs.writeFileSync(eventsPath, `${JSON.stringify(attempt)}\n${github ? JSON.stringify(pr) : ""}${github ? "\n" : ""}`);
  const resultPath = path.join(root, "verification.log");
  const resultBytes = Buffer.from("nonzero command output is never copied into a fact\n"); fs.writeFileSync(resultPath, resultBytes);
  const verificationPath = path.join(root, "verification.json");
  const writeVerification = (overrides = {}) => {
    const payload = {
      schema_version: 1, head_sha: head, tree_sha: tree, done_criteria_sha256: criteriaHash,
      operator: "owner", commands: ["node --test", "node --check index.js"],
      completed_commands: [{ command: "node --test", exit_code: 7 }, { command: "node --check index.js", exit_code: 9 }],
      result_path: resultPath, result_sha256: sha(resultBytes), ...overrides,
    };
    fs.writeFileSync(verificationPath, JSON.stringify(payload)); return payload;
  };
  const gh = path.join(root, "fake-gh.js");
  fs.writeFileSync(gh, `#!/usr/bin/env node\nif(process.argv[2]==='pr'&&process.argv[3]==='list') process.stdout.write(${JSON.stringify(JSON.stringify([{
    number: 42, state: "OPEN", headRefName: "work", headRefOid: head, baseRefName: "main",
    headRepository: { nameWithOwner: "owner/repo" }, headRepositoryOwner: { login: "owner" },
    baseRefOid: start, mergeCommit: null, body: "", url: "https://example.test/42",
  }]))}); else process.exit(2);\n`);
  fs.chmodSync(gh, 0o755);
  const gitBin = path.join(root, "fake-git.js");
  fs.writeFileSync(gitBin, `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');const a=process.argv.slice(2);if(a.includes('ls-remote')){process.stdout.write(${JSON.stringify(`${head}\trefs/heads/work\n`)});process.exit(0)}const r=spawnSync('/usr/bin/git',a,{stdio:'inherit'});process.exit(r.status??2);\n`);
  fs.chmodSync(gitBin, 0o755);
  return { root, repo, worktree, runDir, eventsPath, head, tree, start, criteriaHash, verificationPath, writeVerification, gh, gitBin, github };
}

function envFor(f, extra = {}) {
  const { crash = false, ...environment } = extra;
  const preloadOptions = [
    process.env.NODE_OPTIONS,
    `--require=${HOST_BYPASS}`,
    ...(crash ? [`--require=${CRASH_AT_FACT}`] : []),
  ].filter(Boolean).join(" ");
  return {
    ...process.env, RELAY_GIT_BIN: f.github ? f.gitBin : "git", RELAY_GH_BIN: f.gh,
    RELAY_WORKTREE_BASE: f.root, NODE_OPTIONS: preloadOptions, ...environment,
  };
}

function cli(f, command, args, env = envFor(f)) {
  return spawnSync(process.execPath, [CLI, command, "--run-dir", f.runDir, ...args, "--json"], {
    cwd: ROOT, encoding: "utf8", env, timeout: 30_000,
  });
}

function verificationFacts(f) {
  return facts.readFacts({ eventsPath: f.eventsPath }).facts.filter((fact) => fact.type === "verification_recorded");
}

for (const github of [false, true]) {
  test(`#1244 ${github ? "GitHub" : "local"} production CLI records exact ordered nonzero verification`, (t) => {
    const f = fixture({ github }); t.after(() => fs.rmSync(f.root, { recursive: true, force: true })); f.writeVerification();
    const inspected = cli(f, "inspect", []); assert.equal(inspected.status, 0, inspected.stderr);
    const before = JSON.parse(inspected.stdout); assert.deepEqual(before.recommended_action.steps, ["record_verification"]);
    const recovered = cli(f, "recover", ["--reason", "record failed verification", "--actor", "owner",
      "--expected-action-key", before.recommended_action.key, "--verification-file", f.verificationPath]);
    assert.equal(recovered.status, 0, recovered.stderr);
    const output = JSON.parse(recovered.stdout);
    assert.equal(output.after.derived.action, "redispatch");
    assert.equal(output.after.derived.reason, "verification_failed");
    const recorded = verificationFacts(f); assert.equal(recorded.length, 1);
    assert.deepEqual({
      head_sha: recorded[0].payload.head_sha,
      tree_sha: recorded[0].payload.tree_sha,
      done_criteria_sha256: recorded[0].payload.done_criteria_sha256,
      operator: recorded[0].payload.operator,
      result_sha256: recorded[0].payload.result_sha256,
      status: recorded[0].payload.status,
      exit_code: recorded[0].payload.exit_code,
    }, {
      head_sha: f.head,
      tree_sha: f.tree,
      done_criteria_sha256: f.criteriaHash,
      operator: "owner",
      result_sha256: sha(fs.readFileSync(path.join(f.root, "verification.log"))),
      status: "failed",
      exit_code: 7,
    });
    assert.doesNotMatch(JSON.stringify(recorded[0]), /nonzero command output/);
  });
}

test("#1244 production CLI records exact ordered all-zero verification as passed", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.writeVerification({
    completed_commands: [
      { command: "node --test", exit_code: 0 },
      { command: "node --check index.js", exit_code: 0 },
    ],
  });
  const before = JSON.parse(cli(f, "inspect", []).stdout);
  const recovered = cli(f, "recover", ["--reason", "record passed verification", "--actor", "owner",
    "--expected-action-key", before.recommended_action.key, "--verification-file", f.verificationPath]);
  assert.equal(recovered.status, 0, recovered.stderr);
  const recorded = verificationFacts(f);
  assert.equal(recorded.length, 1);
  assert.deepEqual({ status: recorded[0].payload.status, exit_code: recorded[0].payload.exit_code }, {
    status: "passed", exit_code: 0,
  });
});

test("#1244 invalid command correspondence and other invalid evidence append zero verification facts", async (t) => {
  const cases = [
    ["missing file", null, (f) => path.join(f.root, "missing-verification.json")],
    ["missing argument", null, () => null],
    ["incomplete commands", { completed_commands: [{ command: "node --test", exit_code: 0 }] }],
    ["duplicate commands", { completed_commands: [
      { command: "node --test", exit_code: 0 },
      { command: "node --test", exit_code: 0 },
    ] }],
    ["substituted commands", { completed_commands: [
      { command: "node --test", exit_code: 0 },
      { command: "npm test", exit_code: 0 },
    ] }],
    ["reordered commands", { completed_commands: [
      { command: "node --check index.js", exit_code: 0 },
      { command: "node --test", exit_code: 0 },
    ] }],
    ["result hash mismatch", { result_sha256: "e".repeat(64) }],
    ["stale head", { head_sha: "f".repeat(40) }],
    ["stale tree", { tree_sha: "f".repeat(40) }],
    ["stale Done Criteria", { done_criteria_sha256: "e".repeat(64) }],
    ["operator mismatch", { operator: "someone-else" }],
    ["non-closed schema", { unexpected: true }],
    ["dirty worktree", {}, (f) => {
      fs.writeFileSync(path.join(f.worktree, "dirty.txt"), "dirty\n");
      return f.verificationPath;
    }],
  ];
  for (const [label, overrides, prepare] of cases) {
    await t.test(label, () => {
      const f = fixture();
      t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
      if (overrides !== null) f.writeVerification(overrides);
      const inspected = cli(f, "inspect", []);
      assert.equal(inspected.status, 0, inspected.stderr);
      const key = JSON.parse(inspected.stdout).recommended_action.key;
      const verificationPath = prepare ? prepare(f) : f.verificationPath;
      const args = ["--reason", `reject ${label}`, "--actor", "owner", "--expected-action-key", key];
      if (verificationPath) args.push("--verification-file", verificationPath);
      const result = cli(f, "recover", args);
      if (label === "dirty worktree") {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).status, "refused");
      } else {
        assert.notEqual(result.status, 0, `${label}: ${result.stdout}`);
      }
      assert.equal(verificationFacts(f).length, 0, label);
      assert.equal(facts.readFacts({ eventsPath: f.eventsPath }).facts.some((fact) => fact.type === "recovery_applied"), false, label);
    });
  }
});

test("#1244 verification recovery survives intent, fact, and receipt crash windows", async (t) => {
  const cuts = [
    ["before verification fact", { RELAY_CRASH_BEFORE_FACT: "verification_recorded" }, 0, 0],
    ["after verification fact", { RELAY_CRASH_AFTER_FACT: "verification_recorded" }, 1, 0],
    ["after recovery fact", { RELAY_CRASH_AFTER_FACT: "recovery_applied" }, 1, 1],
  ];
  for (const [label, crashEnvironment, verificationCount, recoveryCount] of cuts) {
    await t.test(label, () => {
      const f = fixture();
      t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
      f.writeVerification();
      const inspected = cli(f, "inspect", []);
      const before = JSON.parse(inspected.stdout);
      const reason = `recover ${label}`;
      const args = ["--reason", reason, "--actor", "owner", "--expected-action-key",
        before.recommended_action.key, "--verification-file", f.verificationPath];
      const crashed = cli(f, "recover", args, envFor(f, {
        crash: true, ...crashEnvironment, RELAY_CRASH_EXIT: "86",
      }));
      assert.equal(crashed.status, 86, crashed.stderr);
      assert.equal(verificationFacts(f).length, verificationCount);
      assert.equal(facts.readFacts({ eventsPath: f.eventsPath }).facts.filter((fact) => fact.type === "recovery_applied").length, recoveryCount);
      assert.equal(fs.existsSync(path.join(f.runDir, `recovery-receipt-${before.recommended_action.key}.json`)), false);

      const retry = cli(f, "recover", args);
      assert.equal(retry.status, 0, retry.stderr);
      assert.equal(verificationFacts(f).length, 1);
      assert.equal(facts.readFacts({ eventsPath: f.eventsPath }).facts.filter((fact) => fact.type === "recovery_applied").length, 1);
      const receiptPath = path.join(f.runDir, `recovery-receipt-${before.recommended_action.key}.json`);
      const receiptBytes = fs.readFileSync(receiptPath);
      assert.equal(JSON.parse(receiptBytes).fact_event_ids.length, 2, `${label} receipt binds both deterministic facts`);
      const again = cli(f, "recover", ["--reason", reason, "--actor", "owner",
        "--expected-action-key", before.recommended_action.key]);
      assert.equal(again.status, 0, again.stderr);
      assert.equal(JSON.parse(again.stdout).status, "noop");
      assert.deepEqual(fs.readFileSync(receiptPath), receiptBytes);
    });
  }
});

test("#1244 exact payload dedupe refuses pass/fail alias after a fact crash", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.writeVerification();
  const inspected = cli(f, "inspect", []);
  const before = JSON.parse(inspected.stdout);
  const reason = "preserve exact failed verification";
  const args = ["--reason", reason, "--actor", "owner", "--expected-action-key",
    before.recommended_action.key, "--verification-file", f.verificationPath];
  const crashed = cli(f, "recover", args, envFor(f, {
    crash: true, RELAY_CRASH_AFTER_FACT: "verification_recorded", RELAY_CRASH_EXIT: "86",
  }));
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(verificationFacts(f).length, 1);

  f.writeVerification({
    completed_commands: [
      { command: "node --test", exit_code: 0 },
      { command: "node --check index.js", exit_code: 0 },
    ],
  });
  const aliased = cli(f, "recover", args);
  assert.notEqual(aliased.status, 0);
  assert.match(aliased.stderr, /duplicate event_id/i);
  assert.equal(verificationFacts(f).length, 1);
  assert.equal(verificationFacts(f)[0].payload.status, "failed");

  f.writeVerification();
  const restored = cli(f, "recover", args);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(verificationFacts(f).length, 1);
  assert.ok(fs.existsSync(path.join(f.runDir, `recovery-receipt-${before.recommended_action.key}.json`)));
});

test("R1 validates exact verification payload before receipting an existing recovery fact", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.writeVerification();
  const before = JSON.parse(cli(f, "inspect", []).stdout);
  const reason = "preserve exact verification across the receipt cut";
  const args = ["--reason", reason, "--actor", "owner", "--expected-action-key",
    before.recommended_action.key, "--verification-file", f.verificationPath];
  const crashed = cli(f, "recover", args, envFor(f, {
    crash: true, RELAY_CRASH_AFTER_FACT: "recovery_applied", RELAY_CRASH_EXIT: "86",
  }));
  assert.equal(crashed.status, 86, crashed.stderr);
  const receiptPath = path.join(f.runDir, `recovery-receipt-${before.recommended_action.key}.json`);
  const strandedFacts = fs.readFileSync(f.eventsPath);
  assert.equal(verificationFacts(f).length, 1);
  assert.equal(facts.readFacts({ eventsPath: f.eventsPath }).facts
    .filter((fact) => fact.type === "recovery_applied").length, 1);
  assert.equal(fs.existsSync(receiptPath), false);

  f.writeVerification({
    completed_commands: [
      { command: "node --test", exit_code: 0 },
      { command: "node --check index.js", exit_code: 0 },
    ],
  });
  const aliased = cli(f, "recover", args);
  assert.notEqual(aliased.status, 0);
  assert.match(aliased.stderr, /duplicate event_id/i);
  assert.deepEqual(fs.readFileSync(f.eventsPath), strandedFacts);
  assert.equal(fs.existsSync(receiptPath), false);

  f.writeVerification();
  const restored = cli(f, "recover", args);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).status, "converged");
  assert.deepEqual(fs.readFileSync(f.eventsPath), strandedFacts);
  assert.ok(fs.existsSync(receiptPath));
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptPath)), {
    schema_version: 1,
    operation_id: `recover-${before.recommended_action.key.slice(0, 32)}`,
    action_key: before.recommended_action.key,
    fact_event_ids: facts.readFacts({ eventsPath: f.eventsPath }).facts
      .filter((fact) => ["verification_recorded", "recovery_applied"].includes(fact.type))
      .map((fact) => fact.event_id),
  });
});

test("#1244 a later exact pass returns failed local verification to review", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.writeVerification();
  const initial = JSON.parse(cli(f, "inspect", []).stdout);
  const failed = cli(f, "recover", ["--reason", "record initial failure", "--actor", "owner",
    "--expected-action-key", initial.recommended_action.key, "--verification-file", f.verificationPath]);
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).after.derived.reason, "verification_failed");

  fs.writeFileSync(path.join(f.worktree, "fix.txt"), "executor correction\n");
  const dirty = JSON.parse(cli(f, "inspect", []).stdout);
  assert.deepEqual(dirty.recommended_action.steps, ["commit_work"]);
  const committed = cli(f, "recover", ["--reason", "commit executor correction", "--actor", "owner",
    "--expected-action-key", dirty.recommended_action.key]);
  assert.equal(committed.status, 0, committed.stderr);

  const verification = JSON.parse(cli(f, "inspect", []).stdout);
  assert.equal(verification.derived.reason, "verification_stale");
  assert.deepEqual(verification.recommended_action.steps, ["record_verification"]);
  const head = git(f.worktree, ["rev-parse", "HEAD"]);
  const tree = git(f.worktree, ["rev-parse", "HEAD^{tree}"]);
  f.writeVerification({
    head_sha: head,
    tree_sha: tree,
    completed_commands: [
      { command: "node --test", exit_code: 0 },
      { command: "node --check index.js", exit_code: 0 },
    ],
  });
  const passed = cli(f, "recover", ["--reason", "record corrected pass", "--actor", "owner",
    "--expected-action-key", verification.recommended_action.key, "--verification-file", f.verificationPath]);
  assert.equal(passed.status, 0, passed.stderr);
  const output = JSON.parse(passed.stdout);
  assert.equal(output.after.derived.action, "review");
  assert.equal(output.after.derived.reason, "review_missing");
  assert.deepEqual(verificationFacts(f).map((fact) => fact.payload.status), ["failed", "passed"]);
});
