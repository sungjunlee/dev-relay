"use strict";

// #1206 is a closure proof, not a second lifecycle implementation. It uses the
// public route/dispatch/recover surfaces against a real no-origin Git checkout.
// The reviewer provider is fake only at its network boundary; runReview still
// owns immutable inputs, locks, binding, artifact, fact append, and reinspection.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const facts = require("../../../skills/relay-dispatch/scripts/facts");

const ROOT = path.resolve(__dirname, "../../..");
const PREFLIGHT = path.join(ROOT, "skills/relay/scripts/run-preflight.js");
const DISPATCH = path.join(ROOT, "skills/relay-dispatch/scripts/dispatch.js");
const RECOVER = path.join(ROOT, "skills/relay/scripts/relay-recover.js");
const FAKE_CURSOR = path.join(ROOT, "tests/relay-dispatch/fixtures/fake-cursor.js");
const CRASH_AT_FACT = path.join(ROOT, "tests/relay/fixtures/crash-at-fact.js");
const LOCAL_REVIEW_WORKER = path.join(ROOT, "tests/relay/fixtures/local-review-worker.js");

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function run(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: "utf8", env, timeout: 60_000 });
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-git-native-closure-")));
  const repo = path.join(root, "repo"), relayHome = path.join(root, "relay-home"), bin = path.join(root, "bin");
  fs.mkdirSync(repo); fs.mkdirSync(bin);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, ["config", "user.name", "Closure Test"]); git(repo, ["config", "user.email", "closure@example.test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n"); git(repo, ["add", "README.md"]); git(repo, ["commit", "-m", "base"]);
  const prompt = path.join(root, "prompt.md"), rubric = path.join(root, "rubric.yaml"), cursor = path.join(bin, "agent");
  fs.writeFileSync(prompt, "Make one reviewable local change.\n"); fs.writeFileSync(rubric, "done_criteria:\n  - local change is reviewable\n");
  fs.copyFileSync(FAKE_CURSOR, cursor); fs.chmodSync(cursor, 0o755);
  const gh = path.join(root, "gh-trap.js"), ghMarker = path.join(root, "gh-called");
  fs.writeFileSync(gh, `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(ghMarker)}, "called");process.exit(91);\n`); fs.chmodSync(gh, 0o755);
  const gitBin = path.join(root, "git-trap.js"), gitLog = path.join(root, "git.log"), realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(gitBin, `#!/usr/bin/env node
const fs=require("fs"),{spawnSync}=require("child_process"),a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(gitLog)},JSON.stringify(a)+"\\n");
if(a.some((x)=>["fetch","ls-remote","push"].includes(x)))process.exit(92);
const r=spawnSync(${JSON.stringify(realGit)},a,{encoding:null});if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);
if(r.status===0&&process.env.RELAY_CRASH_AFTER_UPDATE_REF==="1"&&a.includes("update-ref")&&a.includes("HEAD")){
  fs.writeFileSync(process.env.RELAY_CRASH_MARKER,"updated");process.kill(process.ppid,"SIGKILL");
}
process.exit(r.status??1);
`); fs.chmodSync(gitBin, 0o755);
  return { root, repo: fs.realpathSync(repo), relayHome, prompt, rubric, cursor, gh, ghMarker, gitBin, gitLog };
}

function assertNoRemoteEffects(value) {
  const calls = fs.existsSync(value.gitLog) ? fs.readFileSync(value.gitLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  assert.deepEqual(calls.filter((argv) => argv.some((part) => ["fetch", "ls-remote", "push"].includes(part))), []);
  assert.deepEqual(calls.filter((argv) => argv.includes("-D") || (argv.includes("worktree") && argv.includes("remove"))), []);
  assert.equal(fs.existsSync(value.ghMarker), false, "the no-origin route must never execute gh");
}

function assertSupportedDispatchOrPlatformRefusal(dispatched, value) {
  if (process.platform === "darwin") return true;
  assert.equal(dispatched.status, 1, dispatched.stderr);
  assert.equal(JSON.parse(dispatched.stderr).code, "EXECUTOR_WRITE_ISOLATION_UNAVAILABLE");
  assertNoRemoteEffects(value);
  return false;
}

test("#1206 real no-origin journey reaches one terminal reviewed result without forge or transport", (t) => {
  const value = fixture(); t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const env = { ...process.env, RELAY_HOME: value.relayHome, RELAY_WORKTREE_BASE: path.join(value.relayHome, "worktrees"),
    RELAY_GIT_BIN: value.gitBin, RELAY_GH_BIN: value.gh, RELAY_CURSOR_AGENT_BIN: value.cursor };
  const route = run(PREFLIGHT, ["--stage", "route", "--repo", value.repo, "--issue-number", "1206", "--json"], env);
  assert.equal(route.status, 0, route.stderr); assert.equal(JSON.parse(route.stdout).source.route, "local-reviewed-result");
  const dispatched = run(DISPATCH, [value.repo, "--branch", "issue-1206-closure", "--issue-number", "1206", "--prompt-file", value.prompt,
    "--rubric-file", value.rubric, "--executor", "cursor", "--network-access", "enabled", "--json"], env);
  if (!assertSupportedDispatchOrPlatformRefusal(dispatched, value)) return;
  assert.equal(dispatched.status, 0, dispatched.stderr);
  const launch = JSON.parse(dispatched.stdout);
  const inspect = () => { const result = run(RECOVER, ["inspect", "--run-dir", launch.run_dir, "--json"], env); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  const recover = (inspection, reason, verificationFile = null) => {
    const args = ["recover", "--run-dir", launch.run_dir, "--actor", "closure", "--reason", reason, "--expected-action-key", inspection.recommended_action.key];
    if (verificationFile) args.push("--verification-file", verificationFile); args.push("--json");
    const result = run(RECOVER, args, env); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const dirty = inspect(); assert.deepEqual(dirty.recommended_action.steps, ["commit_work"]); recover(dirty, "commit exact local executor result");
  const committed = inspect(); assert.deepEqual(committed.recommended_action.steps, ["record_verification"]);
  const head = git(launch.worktree, ["rev-parse", "HEAD"]), tree = git(launch.worktree, ["rev-parse", "HEAD^{tree}"]);
  const record = JSON.parse(fs.readFileSync(path.join(launch.run_dir, "run.json"), "utf8"));
  const resultPath = path.join(value.root, "verification.log"); fs.writeFileSync(resultPath, "closure verification passed\n");
  const verification = path.join(value.root, "verification.json");
  fs.writeFileSync(verification, `${JSON.stringify({ schema_version: 1, head_sha: head, tree_sha: tree, done_criteria_sha256: record.contract.done_criteria_sha256,
    operator: "closure", commands: ["node --test"], completed_commands: [{ command: "node --test", exit_code: 0 }], result_path: resultPath,
    result_sha256: crypto.createHash("sha256").update(fs.readFileSync(resultPath)).digest("hex") })}\n`);
  recover(committed, "record exact local verification", verification);
  const review = invokeReview(value, launch, env);
  assert.equal(review.status, 0, review.stderr);
  const reviewed = JSON.parse(review.stdout);
  assert.equal(reviewed.recommended_action.kind, "recover");
  const ready = inspect(); assert.equal(ready.recommended_action.reason, "reviewed_result_ready");
  const closed = recover(ready, "close independently reviewed local result"); assert.equal(closed.after.derived.reason, "reviewed_result_ready");
  assert.equal(recover(ready, "close independently reviewed local result").status, "noop");
  const journal = facts.readFacts({ eventsPath: path.join(launch.run_dir, "events.jsonl") }).facts;
  for (const type of ["attempt_finished", "verification_recorded", "review_recorded", "run_closed"]) assert.equal(journal.filter((fact) => fact.type === type).length, 1, type);
  assert.equal(fs.readdirSync(launch.run_dir).filter((name) => name.startsWith("recovery-receipt-")).length, 3);
  assertNoRemoteEffects(value);
});

function factsFor(launch) {
  return facts.readFacts({ eventsPath: path.join(launch.run_dir, "events.jsonl") }).facts;
}

function onlyRun(value) {
  const runsRoot = path.join(value.relayHome, "runs");
  const repoDirs = fs.readdirSync(runsRoot).map((name) => path.join(runsRoot, name));
  const runDirs = repoDirs.flatMap((repoDir) => fs.readdirSync(repoDir).map((name) => path.join(repoDir, name)));
  assert.equal(runDirs.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(runDirs[0], "run.json"), "utf8"));
  return { run_dir: runDirs[0], worktree: record.git.worktree };
}

function crashAfterFactEnv(env, type, exitCode) {
  return {
    ...env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${CRASH_AT_FACT}`].filter(Boolean).join(" "),
    RELAY_CRASH_AFTER_FACT: type,
    RELAY_CRASH_EXIT: String(exitCode),
  };
}

function crashBeforeFactEnv(env, type, exitCode) {
  return {
    ...env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${CRASH_AT_FACT}`].filter(Boolean).join(" "),
    RELAY_CRASH_BEFORE_FACT: type,
    RELAY_CRASH_EXIT: String(exitCode),
  };
}

function inspectRun(launch, env) {
  const result = run(RECOVER, ["inspect", "--run-dir", launch.run_dir, "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function recoveryInvocation(launch, inspection, reason, verificationFile = null) {
  const args = [
    "recover", "--run-dir", launch.run_dir,
    "--actor", "closure", "--reason", reason,
    "--expected-action-key", inspection.recommended_action.key,
    "--break-lock", "--json",
  ];
  if (verificationFile) args.splice(args.length - 2, 0, "--verification-file", verificationFile);
  return args;
}

function invokeRecovery(args, env) {
  return run(RECOVER, args, env);
}

function verificationFile(value, launch) {
  const head = git(launch.worktree, ["rev-parse", "HEAD"]);
  const tree = git(launch.worktree, ["rev-parse", "HEAD^{tree}"]);
  const record = JSON.parse(fs.readFileSync(path.join(launch.run_dir, "run.json"), "utf8"));
  const resultPath = path.join(value.root, "verification.log");
  fs.writeFileSync(resultPath, "crash matrix verification passed\n");
  const verification = path.join(value.root, "verification.json");
  fs.writeFileSync(verification, `${JSON.stringify({
    schema_version: 1,
    head_sha: head,
    tree_sha: tree,
    done_criteria_sha256: record.contract.done_criteria_sha256,
    operator: "closure",
    commands: ["node --test"],
    completed_commands: [{ command: "node --test", exit_code: 0 }],
    result_path: resultPath,
    result_sha256: crypto.createHash("sha256").update(fs.readFileSync(resultPath)).digest("hex"),
  })}\n`);
  return verification;
}

function invokeReview(value, launch, env) {
  return run(LOCAL_REVIEW_WORKER, [], {
    ...env,
    RELAY_TEST_REPO: value.repo,
    RELAY_TEST_RUN_DIR: launch.run_dir,
  });
}

function assertFactCount(launch, type, count = 1) {
  assert.equal(factsFor(launch).filter((fact) => fact.type === type).length, count, type);
}

async function crashMatrixJourney(cut, t) {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    RELAY_HOME: value.relayHome,
    RELAY_WORKTREE_BASE: path.join(value.relayHome, "worktrees"),
    RELAY_GIT_BIN: value.gitBin,
    RELAY_GH_BIN: value.gh,
    RELAY_CURSOR_AGENT_BIN: value.cursor,
    RELAY_DISPATCH_INTERNAL_RUN_ID: `issue-1206-${cut}`,
  };
  const route = run(PREFLIGHT, ["--stage", "route", "--repo", value.repo, "--issue-number", "1206", "--json"], env);
  assert.equal(route.status, 0, route.stderr);
  assert.equal(JSON.parse(route.stdout).source.route, "local-reviewed-result");
  const dispatchArgs = [
    value.repo, "--branch", `issue-1206-${cut}`, "--issue-number", "1206",
    "--prompt-file", value.prompt, "--rubric-file", value.rubric,
    "--executor", "cursor", "--network-access", "enabled", "--json",
  ];
  const dispatched = run(DISPATCH, dispatchArgs,
    cut === "post-attempt" ? crashAfterFactEnv(env, "attempt_finished", 81) : env);
  if (!assertSupportedDispatchOrPlatformRefusal(dispatched, value)) return;
  let launch;
  if (cut === "post-attempt") {
    assert.equal(dispatched.status, 81, dispatched.stderr);
    launch = onlyRun(value);
    assertFactCount(launch, "attempt_finished");
  } else {
    assert.equal(dispatched.status, 0, dispatched.stderr);
    launch = JSON.parse(dispatched.stdout);
  }

  const commitInspection = inspectRun(launch, env);
  const commitReason = "commit exact crash-matrix result";
  const commitArgs = recoveryInvocation(launch, commitInspection, commitReason);
  let committed;
  if (cut === "post-commit") {
    const marker = path.join(value.root, "update-ref-completed");
    const before = git(launch.worktree, ["rev-parse", "HEAD"]);
    const crashed = invokeRecovery(commitArgs, {
      ...env,
      RELAY_CRASH_AFTER_UPDATE_REF: "1",
      RELAY_CRASH_MARKER: marker,
    });
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
    assert.equal(fs.readFileSync(marker, "utf8"), "updated");
    assert.notEqual(git(launch.worktree, ["rev-parse", "HEAD"]), before, "the ref update must precede the crash");
    assert.equal(fs.readdirSync(launch.run_dir).some((name) => name.startsWith("recovery-receipt-")), false);
    committed = invokeRecovery(commitArgs, env);
  } else {
    committed = invokeRecovery(commitArgs, env);
  }
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(JSON.parse(committed.stdout).status, /^(converged|noop)$/);
  assert.equal(git(launch.worktree, ["rev-list", "--count", `${JSON.parse(fs.readFileSync(path.join(launch.run_dir, "run.json"))).git.start_sha}..HEAD`]), "1");

  const verificationInspection = inspectRun(launch, env);
  assert.deepEqual(verificationInspection.recommended_action.steps, ["record_verification"]);
  const verification = verificationFile(value, launch);
  const verificationArgs = recoveryInvocation(launch, verificationInspection, "record exact crash-matrix verification", verification);
  if (cut === "post-verification") {
    const crashed = invokeRecovery(verificationArgs, crashAfterFactEnv(env, "verification_recorded", 82));
    assert.equal(crashed.status, 82, crashed.stderr);
    assertFactCount(launch, "verification_recorded");
    assert.equal(fs.existsSync(path.join(launch.run_dir, `recovery-receipt-${verificationInspection.recommended_action.key}.json`)), false);
  }
  const verified = invokeRecovery(verificationArgs, env);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(JSON.parse(verified.stdout).status, /^(converged|noop)$/);
  assertFactCount(launch, "verification_recorded");

  let reviewed;
  if (cut === "post-review") {
    const crashed = invokeReview(value, launch, crashAfterFactEnv(env, "review_recorded", 83));
    assert.equal(crashed.status, 83, crashed.stderr);
    assertFactCount(launch, "review_recorded");
    const retry = invokeReview(value, launch, env);
    assert.notEqual(retry.status, 0, "a retry must not append a second review after the durable review fact");
    assert.match(retry.stderr, /not currently eligible|review action|REVIEW/i);
    assertFactCount(launch, "review_recorded");
    reviewed = inspectRun(launch, env);
  } else {
    const result = invokeReview(value, launch, env);
    assert.equal(result.status, 0, result.stderr);
    reviewed = inspectRun(launch, env);
  }
  assertFactCount(launch, "review_recorded");
  assert.equal(reviewed.recommended_action.reason, "reviewed_result_ready");

  const closeReason = "close crash-matrix reviewed local result";
  const closeArgs = recoveryInvocation(launch, reviewed, closeReason);
  if (cut === "pre-close") {
    const crashed = invokeRecovery(closeArgs, crashBeforeFactEnv(env, "run_closed", 84));
    assert.equal(crashed.status, 84, crashed.stderr);
    assertFactCount(launch, "run_closed", 0);
    assert.equal(fs.existsSync(path.join(launch.run_dir, `recovery-intent-${reviewed.recommended_action.key}.json`)), true);
    assert.equal(fs.existsSync(path.join(launch.run_dir, `recovery-receipt-${reviewed.recommended_action.key}.json`)), false);
  }
  const closed = invokeRecovery(closeArgs, env);
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(JSON.parse(closed.stdout).status, /^(converged|noop)$/);
  const terminal = inspectRun(launch, env);
  assert.equal(terminal.derived.terminal, true);
  assert.equal(terminal.derived.reason, "reviewed_result_ready");
  for (const type of ["attempt_finished", "verification_recorded", "review_recorded", "run_closed"]) {
    assertFactCount(launch, type);
  }

  const closeReceipt = path.join(launch.run_dir, `recovery-receipt-${reviewed.recommended_action.key}.json`);
  const receiptBytes = fs.readFileSync(closeReceipt);
  const noop = invokeRecovery(closeArgs, env);
  assert.equal(noop.status, 0, noop.stderr);
  assert.equal(JSON.parse(noop.stdout).status, "noop");
  assert.deepEqual(fs.readFileSync(closeReceipt), receiptBytes);
  assert.equal(fs.readdirSync(launch.run_dir).filter((name) => name.startsWith("recovery-receipt-")).length, 3, "commit, verification, and close must each publish exactly one stable receipt");
  assertNoRemoteEffects(value);
}
for (const cut of ["post-attempt", "post-commit", "post-verification", "post-review", "pre-close"]) {
  test(`#1206 no-origin hard-exit retry converges at ${cut}`, async (t) => crashMatrixJourney(cut, t));
}
