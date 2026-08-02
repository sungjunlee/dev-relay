"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const facts = require("../../../skills/relay-dispatch/scripts/facts");
const host = require("../../../skills/relay-dispatch/scripts/host");
const generation = require("../../../skills/relay-dispatch/scripts/runtime-generation");
const runStore = require("../../../skills/relay-dispatch/scripts/run-store");
const finalize = require("../../../skills/relay-merge/scripts/finalize-run");
const runtime = { recordMerge: facts.recordMerge, withRunLock(runDir, callback) { const canonical = fs.realpathSync(runDir);
  return host.withRunLock({ runDir: canonical, attemptId: `test-${crypto.randomUUID()}`, operation: "merge",
    hostKind: "local_supervisor", hostHandle: `test:${process.pid}`, worktreeDir: canonical }, callback); } };

const SCRIPT = path.resolve(__dirname, "../../../skills/relay-merge/scripts/finalize-run.js");
const OBSERVER = path.resolve(__dirname, "../fixtures/vnext-merge-observer.js");

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function switchVnext(repo, remote, label) {
  const store = generation.initializeStore({ checkoutRoot: repo, remote });
  const observedAt = "2026-08-01T00:00:00.000Z";
  generation.decideMigration({
    store,
    observation: {
      observed_at: observedAt,
      active_legacy_run_count: 0,
      oldest_active_legacy_age_hours: null,
    },
  });
  const drain = generation.recordDrainCompleted({
    store,
    inventory: {
      observed_at: "2026-08-01T00:00:01.000Z",
      active_legacy_run_count: 0,
      oldest_active_legacy_age_hours: null,
    },
    actor: "test",
    operationId: `drain-${label}`,
  }).inventory;
  generation.switchGeneration({
    store,
    generation: "vnext",
    actor: "test",
    operationId: `switch-${label}`,
    switchedAt: "2026-08-01T00:00:02.000Z",
    drainInventoryDigest: drain.inventory_digest,
  });
}

function writeFakeGh(root, initial) {
  const statePath = path.join(root, "gh-state.json");
  const logPath = path.join(root, "gh.log");
  const scriptPath = path.join(root, "fake-gh.js");
  fs.writeFileSync(statePath, `${JSON.stringify(initial)}\n`);
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(logPath, args.join(" ") + "\\n");
function row() {
  return {
    number: state.number,
    state: state.state,
    url: "https://example.test/pr/42",
    headRefName: state.headRefName,
    headRefOid: state.headRefOid,
    baseRefName: state.baseRefName,
    headRepository: { nameWithOwner: state.repo, name: state.repo.split("/").at(-1) },
    headRepositoryOwner: { login: state.repo.split("/")[0] },
    isCrossRepository: false,
    mergedAt: state.state === "MERGED" ? "2026-08-01T00:10:00.000Z" : null,
    mergeCommit: state.mergeCommit,
    autoMergeRequest: state.autoMergeRequest || null,
    mergeStateStatus: state.mergeStateStatus || null,
    body: "<!-- relay-run:test -->"
  };
}
if (args[0] === "auth" && args[1] === "token") process.stdout.write("test-token\\n");
else if (args[0] === "api" && args[1] === "user") process.stdout.write(state.authLogin + "\\n");
else if (args[0] === "pr" && args[1] === "list") process.stdout.write(JSON.stringify([row()]));
else if (args[0] === "pr" && args[1] === "view") {
  if (state.retargetBaseOnView) {
    state.baseRefName = state.retargetBaseOnView;
    delete state.retargetBaseOnView;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  process.stdout.write(JSON.stringify(row()));
}
else if (args[0] === "pr" && args[1] === "merge") {
  if (state.advanceHeadOnMerge) {
    state.headRefOid = state.advanceHeadOnMerge;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  const matchIndex = args.indexOf("--match-head-commit");
  if (matchIndex < 0 || args[matchIndex + 1] !== state.headRefOid) {
    process.stderr.write("head commit changed before merge");
    process.exit(1);
  }
  if (state.mergeExitCode) {
    if (state.mergeErrorButExternalMerged) {
      state.state = "MERGED";
      state.mergeCommit = { oid: state.resultTargetSha };
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
    if (state.mergeErrorButExternalQueued) {
      state.autoMergeRequest = { mergeMethod: state.mergeErrorButExternalQueued, enabledBy: { login: state.authLogin } };
      state.mergeStateStatus = "QUEUED";
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
    process.stderr.write("merge rejected");
    process.exit(state.mergeExitCode);
  }
  if (state.queueOnMerge) {
    state.autoMergeRequest = { mergeMethod: state.queueOnMerge, enabledBy: { login: state.authLogin } };
    state.mergeStateStatus = "QUEUED";
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.exit(0);
  }
  state.state = "MERGED";
  state.mergeCommit = { oid: state.resultTargetSha };
  fs.writeFileSync(statePath, JSON.stringify(state));
} else {
  process.stderr.write("unsupported fake gh: " + args.join(" "));
  process.exit(2);
}
`, { mode: 0o755 });
  return { statePath, logPath, scriptPath };
}

async function appendReadyFacts(value) {
  const eventsPath = path.join(value.runDir, "events.jsonl");
  await runtime.withRunLock(value.runDir, (lockContext) => {
    const common = { run_id: value.record.run_id, actor: "codex" };
    facts.appendFact({ eventsPath, lockContext, fact: {
      ...common,
      event_id: `pr-${value.label}`,
      type: "pull_request_recorded",
      at: "2026-08-01T00:01:00.000Z",
      payload: {
        pr_number: 42,
        repo: value.record.repo.remote,
        head_ref: value.record.git.branch,
        base_ref: value.record.git.base_branch,
        head_sha: value.head,
        created_by_relay: true,
      },
    } });
    facts.appendFact({ eventsPath, lockContext, fact: {
      ...common,
      event_id: `verify-${value.label}`,
      type: "verification_recorded",
      at: "2026-08-01T00:02:00.000Z",
      payload: {
        head_sha: value.head,
        tree_sha: value.tree,
        done_criteria_sha256: value.criteriaHash,
        command: "node --test",
        verification_request_sha256: "a".repeat(64),
        declared_command_count: 1,
        completed_command_count: 1,
        result_path: path.join(value.runDir, "verification.txt"),
        result_sha256: "b".repeat(64),
        exit_code: 0,
        status: "passed",
        operator: "codex",
      },
    } });
    facts.appendFact({ eventsPath, lockContext, fact: {
      ...common,
      event_id: `review-${value.label}`,
      type: "review_recorded",
      at: "2026-08-01T00:03:00.000Z",
      payload: {
        round: 1,
        verdict: "lgtm",
        reviewed_sha: value.head,
        done_criteria_sha256: value.criteriaHash,
        reviewer: "codex",
        review_artifact: path.join(value.runDir, "review.json"),
        // Every verdict this runtime appends carries the runtime that produced it.
        executed_runtime: {
          digest: "c".repeat(64),
          executable: { path: "/usr/local/bin/codex", dev: 1, ino: 2, size: 3, sha256: "d".repeat(64) },
        },
        override: null,
      },
    } });
  });
}

async function fixture(label, { activateVnext = true, github = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-merge-vnext-${label}-`)));
  const repo = path.join(root, "repo");
  const origin = path.join(root, "origin.git");
  const worktree = path.join(root, "worktree");
  const runId = `merge-${label}`;
  const runDir = path.join(root, runId);
  fs.mkdirSync(repo);
  fs.mkdirSync(runDir);
  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, ["config", "user.email", "merge@example.test"]);
  git(repo, ["config", "user.name", "Merge Operator"]);
  git(repo, ["remote", "add", "origin", origin]);
  fs.writeFileSync(path.join(repo, "file.txt"), "before\n");
  git(repo, ["add", "file.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["push", "-u", "origin", "main"]);
  const start = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["worktree", "add", "-b", `issue-${label}`, worktree]);
  fs.writeFileSync(path.join(worktree, "file.txt"), "after\n");
  git(worktree, ["commit", "-am", "change"]);
  git(worktree, ["push", "-u", "origin", `issue-${label}`]);
  const head = git(worktree, ["rev-parse", "HEAD"]);
  const tree = git(worktree, ["rev-parse", "HEAD^{tree}"]);
  const criteriaPath = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteriaPath, "- file.txt says after\n");
  const criteriaHash = crypto.createHash("sha256").update(fs.readFileSync(criteriaPath)).digest("hex");
  const record = {
    version: 3,
    run_id: runId,
    repo: { root: fs.realpathSync(repo), remote: fs.realpathSync(origin) },
    git: {
      branch: `issue-${label}`,
      base_branch: "main",
      worktree: fs.realpathSync(worktree),
      start_sha: start,
    },
    contract: { done_criteria_path: criteriaPath, done_criteria_sha256: criteriaHash },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "codex" },
    parent: null,
    ownership_digest: null,
    created_at: "2026-08-01T00:00:00.000Z",
  };
  runStore.createRunRecord({ runDir, record });
  if (activateVnext) switchVnext(repo, record.repo.remote, label);
  const value = { root, repo, origin, worktree, runDir, record, label, head, tree, criteriaHash };
  await appendReadyFacts(value);
  const gh = writeFakeGh(root, {
    number: 42,
    state: "OPEN",
    headRefName: record.git.branch,
    headRefOid: head,
    baseRefName: "main",
    repo: record.repo.remote,
    mergeCommit: null,
    resultTargetSha: "c".repeat(40),
    authLogin: "relay-bot",
    mergeExitCode: 0,
    advanceHeadOnMerge: null,
    ...github,
  });
  value.gh = gh;
  value.cli = finalize.parseCli(["--repo", repo, "--run-dir", runDir, "--json"]);
  return value;
}

function withGh(value, callback) {
  const prior = { bin: process.env.RELAY_GH_BIN, token: process.env.GH_TOKEN };
  process.env.RELAY_GH_BIN = value.gh.scriptPath;
  process.env.GH_TOKEN = "test-token";
  const restore = () => {
    if (prior.bin === undefined) delete process.env.RELAY_GH_BIN;
    else process.env.RELAY_GH_BIN = prior.bin;
    if (prior.token === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prior.token;
  };
  return Promise.resolve().then(callback).finally(restore);
}

function mergeFacts(value) {
  return facts.readFacts({ eventsPath: path.join(value.runDir, "events.jsonl") }).facts
    .filter((fact) => fact.type === "merge_recorded");
}

function services(overrides = {}) {
  return {
    mergeObserver() {
      return {
        command: process.execPath,
        args: [{ kind: "staged_file", value: OBSERVER }],
      };
    },
    ...overrides,
  };
}

function hardCrashFinalize(value, mode) {
  const override = mode === "after-intent"
    ? "afterRequestIntent(){process.exit(91);}"
    : `mergePullRequest(record,binding,method){
        execFileSync(process.env.RELAY_GH_BIN,[\"pr\",\"merge\",String(binding.prNumber),\"--repo\",record.repo.remote,\"--\"+method,\"--match-head-commit\",binding.head]);
        process.exit(92);
      }`;
  const source = `
    const {execFileSync}=require("node:child_process");
    const finalize=require(${JSON.stringify(SCRIPT)});
    const cli=finalize.parseCli(["--repo",${JSON.stringify(value.repo)},"--run-dir",${JSON.stringify(value.runDir)}]);
    finalize.finalizeRun(cli,{
      mergeObserver(){return {command:process.execPath,args:[{kind:"staged_file",value:${JSON.stringify(OBSERVER)}}]};},
      ${override}
    }).then(()=>process.exit(0)).catch((error)=>{console.error(error);process.exit(90);});
  `;
  return spawnSync(process.execPath, ["-e", source], {
    encoding: "utf8",
    env: { ...process.env, RELAY_GH_BIN: value.gh.scriptPath, GH_TOKEN: "test-token" },
    timeout: 30_000,
  });
}

test("vNext finalize performs one explicit merge, records exact provenance, and cleans idempotently", async () => {
  const value = await fixture("success");
  const first = await withGh(value, () => finalize.finalizeRun(value.cli, services()));
  assert.equal(first.status, "merged");
  assert.equal(first.merge_performed, true);
  assert.equal(first.result_target_sha, "c".repeat(40));
  assert.equal(first.cleanup.status, "removed");
  assert.equal(fs.existsSync(value.worktree), false);
  const recorded = mergeFacts(value);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].payload.reviewed_source_sha, value.head);
  assert.equal(recorded[0].payload.done_criteria_sha256, value.criteriaHash);
  assert.equal(recorded[0].payload.override_reason, null);

  const second = await withGh(value, () => finalize.finalizeRun(value.cli, services()));
  assert.equal(second.merge_performed, false);
  assert.equal(second.cleanup.status, "already_absent");
  assert.equal(mergeFacts(value).length, 1);
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 1);
  assert.match(log, new RegExp(`pr merge 42 .*--match-head-commit ${value.head}`));
});

test("crash after GitHub merge resumes the durable authorization without a duplicate merge fact", async () => {
  const value = await fixture("crash");
  await assert.rejects(withGh(value, () => finalize.finalizeRun(value.cli, services({
    afterMerge() { throw new Error("simulated crash after merge"); },
  }))), /simulated crash/);
  assert.equal(mergeFacts(value).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(value.gh.statePath, "utf8")).state, "MERGED");

  const resumed = await withGh(value, () => finalize.finalizeRun(value.cli, services()));
  assert.equal(resumed.status, "merged");
  assert.equal(resumed.merge_performed, false);
  assert.equal(mergeFacts(value).length, 1);
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 1);
});

test("live PR head drift and closed GitHub state fail closed before merge", async () => {
  for (const [label, github, expected] of [
    ["head-drift", { headRefOid: "d".repeat(40) }, /blocked|identity|action/i],
    ["closed", { state: "CLOSED" }, /blocked|not 'merge'|action/i],
  ]) {
    const value = await fixture(label, { github });
    await assert.rejects(withGh(value, () => finalize.finalizeRun(value.cli, services())), expected);
    assert.equal(mergeFacts(value).length, 0);
    const log = fs.readFileSync(value.gh.logPath, "utf8");
    assert.equal((log.match(/^pr merge /gm) || []).length, 0);
  }
});

test("GitHub merge failure cannot be classified or recorded as success", async () => {
  const value = await fixture("gh-failure", { github: { mergeExitCode: 1 } });
  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    (error) => error.code === "MERGE_REQUEST_OUTCOME_AMBIGUOUS",
  );
  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    (error) => error.code === "MERGE_REQUEST_OUTCOME_AMBIGUOUS",
  );
  assert.equal(mergeFacts(value).length, 0);
  assert.equal(fs.existsSync(value.worktree), true);
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 1);
});

test("merge side effect is conditional on the exact reviewed head across the final TOCTOU window", async () => {
  const advanced = "d".repeat(40);
  const value = await fixture("head-race", { github: { advanceHeadOnMerge: advanced } });
  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    /head commit changed before merge/,
  );
  const state = JSON.parse(fs.readFileSync(value.gh.statePath, "utf8"));
  assert.equal(state.state, "OPEN");
  assert.equal(state.headRefOid, advanced);
  assert.equal(mergeFacts(value).length, 0);
  assert.equal(fs.existsSync(value.worktree), true);
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.match(log, new RegExp(`--match-head-commit ${value.head}`));
});

test("inactive writer generation and removed legacy flags are rejected", async () => {
  const value = await fixture("generation", { activateVnext: false });
  await assert.rejects(withGh(value, () => finalize.finalizeRun(value.cli, services())), /active writer generation/);
  assert.throws(
    () => finalize.parseCli(["--repo", value.repo, "--run-dir", value.runDir, "--skip-review", "hotfix"]),
    /unknown flag/,
  );
  assert.throws(
    () => finalize.parseCli(["--repo", value.repo, "--run-dir", value.runDir, "--force-finalize-nonready"]),
    /unknown flag/,
  );
});

test("CLI help is explicit about mandatory review and the dry-run writes no authorization", async () => {
  const help = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /no review\/state bypass/i);
  const value = await fixture("dry-run");
  const dryCli = finalize.parseCli(["--repo", value.repo, "--run-dir", value.runDir, "--dry-run"]);
  const result = await withGh(value, () => finalize.finalizeRun(dryCli, services()));
  assert.equal(result.status, "ready_to_merge");
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-authorization-")), false);
  assert.equal(mergeFacts(value).length, 0);
});

test("durable authorization actor and method drift fail before another merge request", async () => {
  for (const [label, changedArgs] of [
    ["actor-drift", ["--actor", "Different Operator"]],
    ["method-drift", ["--merge-method", "rebase"]],
  ]) {
    const value = await fixture(label);
    await assert.rejects(withGh(value, () => finalize.finalizeRun(value.cli, services({
      beforeMerge() { throw new Error("stop after durable authorization"); },
    }))), /stop after durable authorization/);
    const changed = finalize.parseCli(["--repo", value.repo, "--run-dir", value.runDir, ...changedArgs]);
    await assert.rejects(
      withGh(value, () => finalize.finalizeRun(changed, services())),
      /differs from the verified durable authorization/,
    );
    const log = fs.readFileSync(value.gh.logPath, "utf8");
    assert.equal((log.match(/^pr merge /gm) || []).length, 0);
  }
});

test("authorization alone cannot claim an externally merged PR as Relay-requested", async () => {
  const value = await fixture("authorization-only-merged");
  await assert.rejects(withGh(value, () => finalize.finalizeRun(value.cli, services({
    beforeMerge() { throw new Error("stop after durable authorization"); },
  }))), /stop after durable authorization/);
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-authorization-")), true);
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-request-intent-")), false);
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-pending-")), false);

  const state = JSON.parse(fs.readFileSync(value.gh.statePath, "utf8"));
  state.state = "MERGED";
  state.mergeCommit = { oid: state.resultTargetSha };
  fs.writeFileSync(value.gh.statePath, JSON.stringify(state));

  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    (error) => error.code === "MERGE_RECOVER_REQUIRED",
  );
  assert.equal(mergeFacts(value).length, 0);
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 0);
});

test("authorization alone cannot adopt an external auto-merge queue as Relay-requested", async () => {
  const value = await fixture("authorization-only-queue");
  await assert.rejects(withGh(value, () => finalize.finalizeRun(value.cli, services({
    beforeMerge() { throw new Error("stop after durable authorization"); },
  }))), /stop after durable authorization/);

  const state = JSON.parse(fs.readFileSync(value.gh.statePath, "utf8"));
  state.autoMergeRequest = { mergeMethod: "SQUASH" };
  state.mergeStateStatus = "QUEUED";
  fs.writeFileSync(value.gh.statePath, JSON.stringify(state));

  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    (error) => error.code === "MERGE_RECOVER_REQUIRED",
  );
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-pending-")), false);
  assert.equal(mergeFacts(value).length, 0);
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 0);
});

test("pre-call intent cannot claim a later external merge as Relay-requested", async () => {
  const value = await fixture("intent-only-external-merged");
  await assert.rejects(withGh(value, () => finalize.finalizeRun(value.cli, services({
    afterRequestIntent() { throw new Error("fault after request intent"); },
  }))), /fault after request intent/);
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-request-intent-")), true);
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-pending-")), false);

  const state = JSON.parse(fs.readFileSync(value.gh.statePath, "utf8"));
  state.state = "MERGED";
  state.mergeCommit = { oid: state.resultTargetSha };
  fs.writeFileSync(value.gh.statePath, JSON.stringify(state));

  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    (error) => error.code === "MERGE_REQUEST_OUTCOME_AMBIGUOUS",
  );
  assert.equal(mergeFacts(value).length, 0);
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 0);
});

test("intent-only recovery rejects an external queue requested by a different GitHub login", async () => {
  const value = await fixture("intent-external-queue");
  await assert.rejects(withGh(value, () => finalize.finalizeRun(value.cli, services({
    afterRequestIntent() { throw new Error("fault after request intent"); },
  }))), /fault after request intent/);

  const state = JSON.parse(fs.readFileSync(value.gh.statePath, "utf8"));
  state.autoMergeRequest = {
    mergeMethod: "SQUASH",
    enabledBy: { login: "external-operator" },
  };
  state.mergeStateStatus = "QUEUED";
  fs.writeFileSync(value.gh.statePath, JSON.stringify(state));

  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    (error) => error.code === "MERGE_QUEUE_REQUESTOR_MISMATCH",
  );
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-pending-")), false);
  assert.equal(mergeFacts(value).length, 0);
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 0);
});

test("accepted queue by the authenticated login converges after a pre-pending crash without a second call", async () => {
  const value = await fixture("authenticated-queue-recovery", {
    github: { queueOnMerge: "SQUASH" },
  });
  await assert.rejects(withGh(value, () => finalize.finalizeRun(value.cli, services({
    afterMergeRequest() { throw new Error("crash after accepted request"); },
  }))), /crash after accepted request/);
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-request-intent-")), true);
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-pending-")), false);

  const resumed = await withGh(value, () => finalize.finalizeRun(value.cli, services()));
  assert.equal(resumed.status, "merge_pending");
  assert.equal(resumed.merge_performed, false);
  const pendingFile = fs.readdirSync(value.runDir).find((name) => name.startsWith("merge-pending-"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(value.runDir, pendingFile), "utf8")).github_login, "relay-bot");

  const state = JSON.parse(fs.readFileSync(value.gh.statePath, "utf8"));
  state.state = "MERGED";
  state.mergeCommit = { oid: state.resultTargetSha };
  fs.writeFileSync(value.gh.statePath, JSON.stringify(state));
  const completed = await withGh(value, () => finalize.finalizeRun(value.cli, services()));
  assert.equal(completed.status, "merged");
  const [recorded] = mergeFacts(value);
  assert.equal(recorded.payload.method, "squash");
  assert.equal(recorded.payload.operator, "Merge Operator");
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 1);
});

test("authenticated GitHub login drift fails before the merge side effect", async () => {
  const value = await fixture("auth-login-drift");
  let observations = 0;
  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services({
      authenticatedGithubLogin() {
        observations += 1;
        return observations === 1 ? "relay-bot" : "different-login";
      },
    }))),
    (error) => error.code === "MERGE_AUTH_IDENTITY_DRIFT",
  );
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-request-intent-")), false);
  assert.equal(mergeFacts(value).length, 0);
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 0);
});

test("tampering the authenticated GitHub principal invalidates durable authorization", async () => {
  const value = await fixture("auth-login-tamper");
  await assert.rejects(withGh(value, () => finalize.finalizeRun(value.cli, services({
    beforeMerge() { throw new Error("stop after durable authorization"); },
  }))), /stop after durable authorization/);
  const authorizationFile = fs.readdirSync(value.runDir)
    .find((name) => name.startsWith("merge-authorization-"));
  const authorization = JSON.parse(fs.readFileSync(path.join(value.runDir, authorizationFile), "utf8"));
  authorization.github_login = "attacker";
  fs.writeFileSync(path.join(value.runDir, authorizationFile), `${JSON.stringify(authorization)}\n`);

  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    /authorization HMAC|authenticated GitHub identity/i,
  );
  assert.equal(mergeFacts(value).length, 0);
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 0);
});

test("terminal retry verifies authorization and repairs a receipt after fact append crash", async () => {
  const value = await fixture("receipt-repair");
  await assert.rejects(withGh(value, () => finalize.finalizeRun(value.cli, services({
    recordMerge(args) {
      return runtime.recordMerge({
        ...args,
        fault(stage) { if (stage === "after_fact_append") throw new Error("crash after fact append"); },
      });
    },
  }))), /crash after fact append/);
  const [recorded] = mergeFacts(value);
  assert.ok(recorded);
  const receipt = path.join(value.runDir, `merge-receipt-${recorded.payload.operation_id}.json`);
  assert.equal(fs.existsSync(receipt), false);

  const resumed = await withGh(value, () => finalize.finalizeRun(value.cli, services()));
  assert.equal(resumed.status, "merged");
  assert.equal(resumed.merge_performed, false);
  assert.equal(fs.existsSync(receipt), true);
  assert.equal(mergeFacts(value).length, 1);
});

test("terminal retry rejects tampered authorization and receipt artifacts", async () => {
  for (const artifact of ["authorization", "receipt"]) {
    const value = await fixture(`tampered-${artifact}`);
    const noCleanup = finalize.parseCli(["--repo", value.repo, "--run-dir", value.runDir, "--no-cleanup"]);
    await withGh(value, () => finalize.finalizeRun(noCleanup, services()));
    const [recorded] = mergeFacts(value);
    const file = path.join(value.runDir, `merge-${artifact}-${recorded.payload.operation_id}.json`);
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    if (artifact === "authorization") json.operator = "forged";
    else json.event_id = "forged";
    fs.writeFileSync(file, `${JSON.stringify(json)}\n`);
    await assert.rejects(
      withGh(value, () => finalize.finalizeRun(noCleanup, services())),
      /authorization|receipt|immutable|HMAC|conflict/i,
    );
    assert.equal(mergeFacts(value).length, 1);
  }
});

test("terminal retry refuses symlink and FIFO authorization or receipt artifacts", async () => {
  const value = await fixture("special-artifacts");
  const noCleanup = finalize.parseCli(["--repo", value.repo, "--run-dir", value.runDir, "--no-cleanup"]);
  await withGh(value, () => finalize.finalizeRun(noCleanup, services()));
  const [recorded] = mergeFacts(value);
  for (const artifact of ["authorization", "receipt"]) {
    const file = path.join(value.runDir, `merge-${artifact}-${recorded.payload.operation_id}.json`);
    const original = fs.readFileSync(file);
    const target = path.join(value.root, `${artifact}-target.json`);
    fs.writeFileSync(target, original);
    fs.unlinkSync(file);
    fs.symlinkSync(target, file);
    await assert.rejects(
      withGh(value, () => finalize.finalizeRun(noCleanup, services())),
      /symlink|regular|authorization|receipt|ELOOP/i,
    );
    fs.unlinkSync(file);
    execFileSync("mkfifo", [file]);
    await assert.rejects(
      withGh(value, () => finalize.finalizeRun(noCleanup, services())),
      /regular|authorization|receipt|artifact/i,
    );
    fs.unlinkSync(file);
    fs.writeFileSync(file, original, { mode: 0o600 });
  }
  assert.equal(mergeFacts(value).length, 1);
});

test("base retarget is detected by the final fresh preflight before merge side effect", async () => {
  const value = await fixture("base-retarget", { github: { retargetBaseOnView: "release" } });
  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    /identity|base|observation/i,
  );
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 0);
  assert.equal(mergeFacts(value).length, 0);
});

test("merge queue request is durable and exactly once until GitHub reports MERGED", async () => {
  const value = await fixture("queue", { github: { queueOnMerge: "SQUASH" } });
  const first = await withGh(value, () => finalize.finalizeRun(value.cli, services()));
  assert.equal(first.status, "merge_pending");
  assert.equal(first.merge_performed, true);
  assert.equal(mergeFacts(value).length, 0);

  const second = await withGh(value, () => finalize.finalizeRun(value.cli, services()));
  assert.equal(second.status, "merge_pending");
  assert.equal(second.merge_performed, false);
  let log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 1);

  const state = JSON.parse(fs.readFileSync(value.gh.statePath, "utf8"));
  state.state = "MERGED";
  state.mergeCommit = { oid: state.resultTargetSha };
  fs.writeFileSync(value.gh.statePath, JSON.stringify(state));
  const third = await withGh(value, () => finalize.finalizeRun(value.cli, services()));
  assert.equal(third.status, "merged");
  assert.equal(third.merge_performed, false);
  assert.equal(mergeFacts(value).length, 1);
  log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 1);
});

test("hard crash after fsynced request intent never automatically reissues an unconfirmed request", async () => {
  const value = await fixture("intent-crash");
  const crashed = hardCrashFinalize(value, "after-intent");
  assert.equal(crashed.status, 91, crashed.stderr);
  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    (error) => error.code === "LOCK_HELD",
  );
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-request-intent-")), true);
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 0);
  assert.equal(mergeFacts(value).length, 0);
});

test("server-accepted queued request survives command failure without a second call", async () => {
  const value = await fixture("accepted-before-return", {
    github: { queueOnMerge: "SQUASH" },
  });
  const crashed = hardCrashFinalize(value, "after-accept");
  assert.equal(crashed.status, 92, crashed.stderr);
  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    (error) => error.code === "LOCK_HELD",
  );
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-request-intent-")), true);
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith("merge-pending-")), false);
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 1);
  assert.equal(mergeFacts(value).length, 0);
});

test("released pre-call fault resumes as typed ambiguity without an automatic call", async () => {
  const value = await fixture("intent-fault");
  await assert.rejects(withGh(value, () => finalize.finalizeRun(value.cli, services({
    afterRequestIntent() { throw new Error("fault after request intent"); },
  }))), /fault after request intent/);
  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    (error) => error.code === "MERGE_REQUEST_OUTCOME_AMBIGUOUS",
  );
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 0);
});

test("confirmed queue after command-return failure resumes without a second call", async () => {
  const value = await fixture("accepted-error", {
    github: { mergeExitCode: 1, mergeErrorButExternalQueued: "SQUASH" },
  });
  const first = await withGh(value, () => finalize.finalizeRun(value.cli, services()));
  assert.equal(first.status, "merge_pending");
  const second = await withGh(value, () => finalize.finalizeRun(value.cli, services()));
  assert.equal(second.status, "merge_pending");
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 1);
});

test("merge command error followed by external MERGED never records requested provenance", async () => {
  const value = await fixture("ambiguous", {
    github: { mergeExitCode: 1, mergeErrorButExternalMerged: true },
  });
  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    /canonical external recover/,
  );
  assert.equal(mergeFacts(value).length, 0);
  await assert.rejects(
    withGh(value, () => finalize.finalizeRun(value.cli, services())),
    /canonical external recover/,
  );
  assert.equal(mergeFacts(value).length, 0);
  const log = fs.readFileSync(value.gh.logPath, "utf8");
  assert.equal((log.match(/^pr merge /gm) || []).length, 1);
});
