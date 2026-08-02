"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createRunRecord } = require("../../../skills/relay-dispatch/scripts/run-store");
const factsApi = require("../../../skills/relay-dispatch/scripts/facts");
const { validateFact } = factsApi;
const host = require("../../../skills/relay-dispatch/scripts/host");
const generation = require("../../../skills/relay-dispatch/scripts/runtime-generation");

const ROOT = path.resolve(__dirname, "../../..");
const CLI = path.join(ROOT, "skills/relay/scripts/relay-recover.js");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
}

function fixture({ branch = "main" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-recover-cli-")));
  const repo = path.join(root, "repo");
  const active = path.join(root, "active");
  const remote = path.join(root, "remote.git");
  const runId = "issue-1135-cli";
  const runDir = path.join(root, runId);
  fs.mkdirSync(repo);
  fs.mkdirSync(active);
  fs.mkdirSync(runDir);
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "relay@example.test"]);
  git(repo, ["config", "user.name", "Relay Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  if (branch !== "main") git(repo, ["checkout", "-b", branch]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
  const generationStore = generation.initializeStore({ checkoutRoot: repo, remote });
  generation.decideMigration({ store: generationStore, observation: { observed_at: "2026-07-31T23:59:58.000Z", active_legacy_run_count: 6, oldest_active_legacy_age_hours: 100 } });
  generation.switchGeneration({ store: generationStore, generation: "vnext", actor: "test", operationId: "recover-cli-vnext", switchedAt: "2026-07-31T23:59:59.000Z" });
  const donePath = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(donePath, "done\n");
  const doneHash = crypto.createHash("sha256").update("done\n").digest("hex");
  createRunRecord({
    runDir,
    record: {
      version: 3,
      run_id: runId,
      repo: { root: active, remote },
      git: { branch, base_branch: "main", worktree: repo, start_sha: head },
      contract: { done_criteria_path: donePath, done_criteria_sha256: doneHash },
      roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
      parent: null,
      ownership_digest: null,
      created_at: "2026-08-01T00:00:00Z",
    },
  });
  fs.writeFileSync(path.join(runDir, "events.jsonl"), "");
  const gh = path.join(root, "fake-gh.js");
  fs.writeFileSync(gh, [
    "#!/usr/bin/env node",
    "if (process.argv[2] === 'pr' && process.argv[3] === 'list') process.stdout.write(process.env.FAKE_GH_ROWS || '[]');",
    "else { process.stderr.write('unsupported fake gh argv\\n'); process.exit(2); }",
    "",
  ].join("\n"));
  fs.chmodSync(gh, 0o755);
  return { root, active, repo, remote, runDir, gh, head, tree, doneHash, branch };
}

function writeFacts(runDir, facts) {
  facts.forEach((fact) => validateFact(fact));
  fs.writeFileSync(path.join(runDir, "events.jsonl"), `${facts.map(JSON.stringify).join("\n")}\n`);
}

function durableSnapshot(runDir) {
  return fs.readdirSync(runDir).sort().map((name) => ({
    name,
    bytes: fs.readFileSync(path.join(runDir, name)).toString("base64"),
  }));
}

function activeFactBytes(eventsPath) {
  return fs.readFileSync(eventsPath, "utf8").trim().split("\n")
    .filter(Boolean).map(JSON.parse)
    .filter((fact) => !new Set(["lock_acquired", "lock_released"]).has(fact.type))
    .map(JSON.stringify).join("\n");
}

function abandonAuthenticatedOwner({ fixture: f, attemptId, crash = "leave-active" }) {
  const hostPath = path.join(ROOT, "skills/relay-dispatch/scripts/host.js");
  const factsPath = path.join(ROOT, "skills/relay-dispatch/scripts/facts.js");
  const eventsPath = path.join(f.runDir, "events.jsonl");
  const child = spawnSync(process.execPath, ["-e", `
    "use strict";
    const fs = require("node:fs");
    const [hostPath, factsPath, eventsPath, runDir, worktreeDir, attemptId, crash] = process.argv.slice(1);
    const host = require(hostPath);
    const facts = require(factsPath);
    const audit = (fragment, capability) => {
      if (crash === "after-close-before-receipt" && fragment.type === "lock_released") {
        const error = new Error("controlled crash after the authoritative close, before the release receipt");
        error.code = "EIO";
        throw error;
      }
      const fact = facts.factFromHostAudit({
        runId: "issue-1135-cli",
        eventId: "host-" + fragment.audit_key,
        at: new Date().toISOString(),
        actor: "relay-host",
        audit: fragment,
      });
      facts.appendFact({ eventsPath, lockContext: capability, fact });
      return { durable: true, idempotent: true, audit_key: fragment.audit_key };
    };
    const lock = host.acquireRunLock({
      runDir, attemptId, operation: "dispatch", hostKind: "local_supervisor",
      hostHandle: "abandoned:" + process.pid, worktreeDir, audit,
    });
    if (crash === "before-close") {
      const link = fs.linkSync;
      fs.linkSync = (from, to) => {
        if (String(to).endsWith(".closed.json")) {
          const error = new Error("controlled crash before the authoritative close");
          error.code = "EIO";
          throw error;
        }
        return link(from, to);
      };
    }
    if (crash !== "leave-active") {
      try { host.releaseRunLock(lock, { audit }); }
      catch (error) {
        if (!["EIO", "HOST_STORAGE_FAILED"].includes(error.code)) throw error;
        fs.writeSync(1, JSON.stringify({ lock_id: lock.lock_id, crashed: true }) + "\\n");
        process.exit(0);
      }
      throw new Error("release unexpectedly completed");
    }
    fs.writeSync(1, JSON.stringify({ lock_id: lock.lock_id, crashed: false }) + "\\n");
  `, hostPath, factsPath, eventsPath, f.runDir, f.repo, attemptId, crash], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null, child.stderr);
  return JSON.parse(child.stdout);
}

function ownerCloseArtifacts(runDir) {
  const ownership = path.join(runDir, "ownership");
  return fs.readdirSync(ownership).filter((name) => name.endsWith(".closed.json")).sort();
}

test("canonical inspect CLI reads a vNext run without changing durable bytes", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const before = durableSnapshot(f.runDir);
  const result = spawnSync(process.execPath, [CLI, "inspect", "--run-dir", f.runDir, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, RELAY_GH_BIN: f.gh, RELAY_WORKTREE_BASE: f.root },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.operation, "inspect");
  assert.equal(parsed.run_id, "issue-1135-cli");
  assert.equal(parsed.snapshot.tail_status, "complete");
  assert.deepEqual(durableSnapshot(f.runDir), before);
});

test("GitHub observation excludes an identical branch from a different head repository", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const common = {
    state: "OPEN", url: "https://example.test/pull/x",
    headRefName: f.branch, headRefOid: f.head, baseRefName: "main",
    mergedAt: null, mergeCommit: null, body: "",
  };
  const rows = [
    { ...common, number: 1, headRepository: { nameWithOwner: "fork/repo" }, headRepositoryOwner: { login: "fork" }, isCrossRepository: true },
    { ...common, number: 2, headRepository: { nameWithOwner: f.remote }, headRepositoryOwner: { login: "owner" }, isCrossRepository: false },
  ];
  const result = spawnSync(process.execPath, [CLI, "inspect", "--run-dir", f.runDir, "--json"], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, RELAY_GH_BIN: f.gh, RELAY_WORKTREE_BASE: f.root, FAKE_GH_ROWS: JSON.stringify(rows) },
  });
  assert.equal(result.status, 0, result.stderr);
  const github = JSON.parse(result.stdout).observations.github;
  assert.equal(github.matching_pr_count, 1);
  assert.equal(github.pr_number, 2);
  assert.equal(github.head_repo, f.remote);
});

test("canonical CLI fails closed when run.json is absent", (t) => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recover-missing-"));
  t.after(() => fs.rmSync(missing, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [CLI, "inspect", "--run-dir", missing, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run\.json is missing/);
});

test("recover CLI requires an explicit audit reason", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    CLI, "recover", "--run-dir", f.runDir, "--break-lock", "--json",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, RELAY_GH_BIN: f.gh, RELAY_WORKTREE_BASE: f.root },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --reason/);
  assert.equal(fs.readdirSync(f.runDir).some((name) => name.startsWith("recovery-intent-")), false);
});

test("production recovery excludes its own lock from executor liveness", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  writeFacts(f.runDir, [{
    event_id: "attempt-started", run_id: "issue-1135-cli", attempt_id: "attempt-1",
    type: "attempt_started", at: "2026-08-01T00:01:00Z", actor: "codex",
    payload: {
      executor: "codex", model: "gpt-5", start_sha: f.head,
      host_kind: "local_supervisor", host_handle: "dead-executor-1",
      stdout_path: path.join(f.runDir, "stdout.log"),
      stderr_path: path.join(f.runDir, "stderr.log"),
      result_path: path.join(f.runDir, "result.txt"), timeout_ms: 60000,
    },
  }]);
  const env = { ...process.env, RELAY_GH_BIN: f.gh, RELAY_WORKTREE_BASE: f.root };
  const inspected = spawnSync(process.execPath, [CLI, "inspect", "--run-dir", f.runDir, "--json"], {
    cwd: ROOT, encoding: "utf8", env,
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  const action = JSON.parse(inspected.stdout).recommended_action;
  assert.deepEqual(action.steps, ["close_dead_attempt"]);
  const recovered = spawnSync(process.execPath, [
    CLI, "recover", "--run-dir", f.runDir, "--reason", "close proven absent executor",
    "--actor", "owner", "--expected-action-key", action.key, "--json",
  ], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).status, "converged", recovered.stdout);
  const facts = fs.readFileSync(path.join(f.runDir, "events.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  assert.equal(facts.filter((fact) => fact.type === "attempt_interrupted").length, 1);
});

test("production recovery reclaims a proven stale owner without invalidating the inspected action key", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  writeFacts(f.runDir, [{
    event_id: "attempt-started", run_id: "issue-1135-cli", attempt_id: "attempt-1",
    type: "attempt_started", at: "2026-08-01T00:01:00Z", actor: "codex",
    payload: {
      executor: "codex", model: "gpt-5", start_sha: f.head,
      host_kind: "local_supervisor", host_handle: "dead-executor-1",
      stdout_path: path.join(f.runDir, "stdout.log"),
      stderr_path: path.join(f.runDir, "stderr.log"),
      result_path: path.join(f.runDir, "result.txt"), timeout_ms: 60000,
    },
  }]);
  const abandoned = abandonAuthenticatedOwner({ fixture: f, attemptId: "attempt-1" });
  assert.equal(abandoned.crashed, false);
  const staleBeforeRecovery = host.inspectOwnership({ runDir: f.runDir });
  assert.equal(staleBeforeRecovery.status, "stale");
  const env = { ...process.env, RELAY_GH_BIN: f.gh, RELAY_WORKTREE_BASE: f.root };
  const inspected = spawnSync(process.execPath, [CLI, "inspect", "--run-dir", f.runDir, "--json"], {
    cwd: ROOT, encoding: "utf8", env,
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  const action = JSON.parse(inspected.stdout).recommended_action;
  assert.deepEqual(action.steps, ["close_dead_attempt"]);
  const ordinary = spawnSync(process.execPath, [
    CLI, "recover", "--run-dir", f.runDir, "--reason", "ordinary recover must not break",
    "--actor", "owner", "--expected-action-key", action.key, "--json",
  ], { cwd: ROOT, encoding: "utf8", env });
  assert.notEqual(ordinary.status, 0);
  assert.match(ordinary.stderr, /explicit --break-lock is required/);
  const breakStartedAt = Date.now();
  const recovered = spawnSync(process.execPath, [
    CLI, "recover", "--run-dir", f.runDir, "--reason", "reclaim proven stale executor",
    "--actor", "owner", "--expected-action-key", action.key, "--break-lock", "--json",
  ], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(recovered.status, 0, recovered.stderr);
  const output = JSON.parse(recovered.stdout);
  assert.equal(output.status, "converged");
  assert.equal(output.action_key, action.key);
  assert.equal(Date.now() - breakStartedAt >= 10_000, true, "break-lock must perform both dead-owner probes");
  const facts = fs.readFileSync(path.join(f.runDir, "events.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  assert.equal(facts.filter((fact) => (
    fact.type === "lock_released" && fact.attempt_id === "attempt-1"
  )).length, 1);
  assert.equal(facts.filter((fact) => (
    fact.type === "lock_acquired" && fact.payload.operation === "recover"
  )).length, 1);
  assert.equal(facts.filter((fact) => (
    fact.type === "lock_released" && fact.payload.operation === "recover"
  )).length, 1);
  assert.equal(facts.filter((fact) => fact.type === "attempt_interrupted").length, 1);
  const firstClosed = JSON.parse(fs.readFileSync(path.join(f.runDir, "ownership", "000000000001.closed.json"), "utf8"));
  assert.equal(firstClosed.outcome, "broken");
  assert.equal(firstClosed.proof.kind, "two_dead_probes");
  assert.equal(Date.parse(firstClosed.proof.second_at) - Date.parse(firstClosed.proof.first_at) >= 10_000, true);
});

function seedAbandonedAttempt(f, attemptId) {
  writeFacts(f.runDir, [{
    event_id: `${attemptId}-started`, run_id: "issue-1135-cli", attempt_id: attemptId,
    type: "attempt_started", at: "2026-08-01T00:01:00Z", actor: "codex",
    payload: {
      executor: "codex", model: "gpt-5", start_sha: f.head,
      host_kind: "local_supervisor", host_handle: `dead-${attemptId}`,
      stdout_path: path.join(f.runDir, "stdout.log"),
      stderr_path: path.join(f.runDir, "stderr.log"),
      result_path: path.join(f.runDir, "result.txt"), timeout_ms: 60000,
    },
  }]);
}

test("a release crash before the authoritative close records exactly one canonical outcome", { timeout: 60_000 }, (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const eventsPath = path.join(f.runDir, "events.jsonl");
  seedAbandonedAttempt(f, "release-crash");
  const abandoned = abandonAuthenticatedOwner({ fixture: f, attemptId: "release-crash", crash: "before-close" });
  assert.equal(abandoned.crashed, true);
  assert.deepEqual(factsApi.readFacts({ eventsPath }).facts.filter((fact) => (
    fact.type === "lock_released" && fact.attempt_id === "release-crash"
  )), [], "no durable release outcome may exist without the authoritative signed close");
  assert.deepEqual(ownerCloseArtifacts(f.runDir), [], "the crashed generation must stay active");
  assert.equal(host.inspectOwnership({ runDir: f.runDir }).status, "stale");

  const breakStartedAt = Date.now();
  const recovered = spawnSync(process.execPath, [
    CLI, "recover", "--run-dir", f.runDir,
    "--reason", "resume elected terminal before reclaim",
    "--actor", "owner", "--break-lock", "--json",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, RELAY_GH_BIN: f.gh, RELAY_WORKTREE_BASE: f.root },
  });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).status, "converged", recovered.stdout);
  assert.equal(Date.now() - breakStartedAt >= 10_000, true, "break-lock must perform both dead-owner probes");
  const journal = factsApi.readFacts({ eventsPath }).facts;
  const outcomes = journal.filter((fact) => fact.type === "lock_released" && fact.attempt_id === "release-crash");
  assert.equal(outcomes.length, 1, "the crashed generation must materialize exactly one release outcome");
  assert.equal(outcomes[0].payload.outcome, "broken");
  assert.equal(journal.filter((fact) => fact.type === "attempt_interrupted" && fact.attempt_id === "release-crash").length, 1);
  const closed = ownerCloseArtifacts(f.runDir);
  assert.equal(closed.length, 2, "the abandoned owner and one recovery owner must each close exactly once");
  const abandonedClose = JSON.parse(fs.readFileSync(path.join(f.runDir, "ownership", closed[0]), "utf8"));
  assert.equal(abandonedClose.outcome, "broken");
  assert.equal(abandonedClose.proof.kind, "two_dead_probes");
});

test("a release crash between the authoritative close and its receipt converges to one canonical outcome", { timeout: 60_000 }, (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const eventsPath = path.join(f.runDir, "events.jsonl");
  seedAbandonedAttempt(f, "receipt-crash");
  const abandoned = abandonAuthenticatedOwner({ fixture: f, attemptId: "receipt-crash", crash: "after-close-before-receipt" });
  assert.equal(abandoned.crashed, true);
  assert.deepEqual(factsApi.readFacts({ eventsPath }).facts.filter((fact) => (
    fact.type === "lock_released" && fact.attempt_id === "receipt-crash"
  )), [], "the receipt is lost with the crashed process");
  assert.deepEqual(ownerCloseArtifacts(f.runDir), ["000000000001.closed.json"], "the authoritative close survives the crash");
  assert.equal(host.inspectOwnership({ runDir: f.runDir }).status, "absent");

  const env = { ...process.env, RELAY_GH_BIN: f.gh, RELAY_WORKTREE_BASE: f.root };
  for (const pass of ["first", "second"]) {
    const recovered = spawnSync(process.execPath, [
      CLI, "recover", "--run-dir", f.runDir, "--reason", `materialize the lost release receipt (${pass})`,
      "--actor", "owner", "--json",
    ], { cwd: ROOT, encoding: "utf8", env });
    assert.equal(recovered.status, 0, recovered.stderr);
    const journal = factsApi.readFacts({ eventsPath }).facts;
    const outcomes = journal.filter((fact) => fact.type === "lock_released" && fact.attempt_id === "receipt-crash");
    assert.equal(outcomes.length, 1, `${pass}: the replayed receipt must be exactly one canonical outcome`);
    assert.equal(outcomes[0].payload.outcome, "released");
  }
});

test("recover CLI records exact structured verification under the production lock", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const pr = {
    number: 42, state: "OPEN", url: "https://example.test/pull/42",
    headRefName: "main", headRefOid: f.head, baseRefName: "main",
    headRepository: { nameWithOwner: f.remote },
    headRepositoryOwner: { login: "owner" }, isCrossRepository: false,
    mergedAt: null, mergeCommit: null, body: "",
  };
  writeFacts(f.runDir, [
    {
      event_id: "attempt-finished", run_id: "issue-1135-cli", attempt_id: "attempt-1",
      type: "attempt_finished", at: "2026-08-01T00:01:00Z", actor: "codex",
      payload: {
        status: "completed", start_sha: f.head, final_sha: f.head, tree_sha: f.tree,
        result_path: path.join(f.runDir, "result.txt"), exit_code: 0, verification_status: "passed",
      },
    },
    {
      event_id: "pr", run_id: "issue-1135-cli", type: "pull_request_recorded",
      at: "2026-08-01T00:02:00Z", actor: "codex",
      payload: {
        pr_number: 42, repo: f.remote, head_ref: "main", base_ref: "main",
        head_sha: f.head, created_by_relay: false,
      },
    },
    {
      event_id: "review", run_id: "issue-1135-cli", type: "review_recorded",
      at: "2026-08-01T00:03:00Z", actor: "claude",
      payload: {
        round: 1, verdict: "pass", reviewed_sha: f.head,
        done_criteria_sha256: f.doneHash, reviewer: "claude",
        review_artifact: path.join(f.runDir, "review.json"), override: null,
      },
    },
  ]);
  const resultPath = path.join(f.root, "verification.log");
  fs.writeFileSync(resultPath, "all gates passed\n");
  const resultHash = crypto.createHash("sha256").update("all gates passed\n").digest("hex");
  const verificationPath = path.join(f.root, "verification.json");
  fs.writeFileSync(verificationPath, `${JSON.stringify({
    schema_version: 1,
    head_sha: f.head,
    tree_sha: f.tree,
    done_criteria_sha256: f.doneHash,
    operator: "owner",
    commands: ["node --test", "node --check index.js"],
    completed_commands: [
      { command: "node --test", exit_code: 0 },
      { command: "node --check index.js", exit_code: 0 },
    ],
    result_path: resultPath,
    result_sha256: resultHash,
  })}\n`);
  const inspected = spawnSync(process.execPath, [
    CLI, "inspect", "--run-dir", f.runDir, "--json",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, RELAY_GH_BIN: f.gh, RELAY_WORKTREE_BASE: f.root, FAKE_GH_ROWS: JSON.stringify([pr]) },
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  const inspectedOutput = JSON.parse(inspected.stdout);
  assert.deepEqual(inspectedOutput.recommended_action.steps, ["record_verification"]);
  assert.deepEqual(inspectedOutput.recommended_action.required_inputs, ["verification_file"]);
  const result = spawnSync(process.execPath, [
    CLI, "recover", "--run-dir", f.runDir,
    "--reason", "operator verified exact tree", "--actor", "owner",
    "--expected-action-key", inspectedOutput.recommended_action.key,
    "--verification-file", verificationPath, "--json",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, RELAY_GH_BIN: f.gh, RELAY_WORKTREE_BASE: f.root, FAKE_GH_ROWS: JSON.stringify([pr]) },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "converged");
  assert.equal(output.action_key, inspectedOutput.recommended_action.key);
  const recorded = fs.readFileSync(path.join(f.runDir, "events.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse).filter((fact) => fact.type === "verification_recorded");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].payload.head_sha, f.head);
  assert.equal(recorded[0].payload.tree_sha, f.tree);
  assert.equal(recorded[0].payload.done_criteria_sha256, f.doneHash);
  assert.equal(recorded[0].payload.declared_command_count, 2);
  assert.equal(recorded[0].payload.completed_command_count, 2);
  assert.equal(recorded[0].payload.result_sha256, resultHash);
});

test("production publication converges on an exact concurrently created PR without duplication", (t) => {
  const f = fixture({ branch: "recovery" });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.repo, "README.md"), "reviewable recovery work\n");
  git(f.repo, ["add", "README.md"]);
  git(f.repo, ["commit", "-m", "reviewable recovery"]);
  const finalHead = git(f.repo, ["rev-parse", "HEAD"]);
  const finalTree = git(f.repo, ["rev-parse", "HEAD^{tree}"]);
  writeFacts(f.runDir, [{
    event_id: "attempt-finished", run_id: "issue-1135-cli", attempt_id: "attempt-1",
    type: "attempt_finished", at: "2026-08-01T00:01:00Z", actor: "codex",
    payload: {
      status: "completed", start_sha: f.head, final_sha: finalHead, tree_sha: finalTree,
      result_path: path.join(f.runDir, "result.txt"), exit_code: 0,
      verification_status: "not_declared",
    },
  }]);
  const statePath = path.join(f.root, "fake-gh-state.json");
  const countPath = path.join(f.root, "fake-gh-create-count.txt");
  const row = {
    number: 73, state: "OPEN", url: "https://example.test/pull/73",
    headRefName: f.branch, headRefOid: finalHead, baseRefName: "main",
    headRepository: { nameWithOwner: f.remote },
    headRepositoryOwner: { login: "owner" }, isCrossRepository: false,
    mergedAt: null, mergeCommit: null, body: "",
  };
  fs.writeFileSync(f.gh, [
    "#!/usr/bin/env node",
    "const fs=require('fs');",
    `const state=${JSON.stringify(statePath)},count=${JSON.stringify(countPath)},row=${JSON.stringify(row)};`,
    "const cmd=process.argv[2]+' '+process.argv[3];",
    "if(cmd==='pr list'){process.stdout.write(fs.existsSync(state)?fs.readFileSync(state,'utf8'):'[]');}",
    "else if(cmd==='pr create'){const n=fs.existsSync(count)?Number(fs.readFileSync(count,'utf8')):0;fs.writeFileSync(count,String(n+1));fs.writeFileSync(state,JSON.stringify([row]));process.stderr.write('PR already exists\\n');process.exit(1);}",
    "else{process.stderr.write('unsupported fake gh argv\\n');process.exit(2);}",
    "",
  ].join("\n"));
  fs.chmodSync(f.gh, 0o755);
  const env = { ...process.env, RELAY_GH_BIN: f.gh, RELAY_WORKTREE_BASE: f.root };
  const inspected = spawnSync(process.execPath, [CLI, "inspect", "--run-dir", f.runDir, "--json"], {
    cwd: ROOT, encoding: "utf8", env,
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  const action = JSON.parse(inspected.stdout).recommended_action;
  assert.deepEqual(action.steps, ["push_branch", "record_or_create_pr"]);

  const recovered = spawnSync(process.execPath, [
    CLI, "recover", "--run-dir", f.runDir, "--reason", "publish exact recovery head",
    "--actor", "owner", "--expected-action-key", action.key, "--json",
  ], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(recovered.status, 0, recovered.stderr);
  const output = JSON.parse(recovered.stdout);
  assert.equal(output.status, "converged");
  assert.equal(git(f.remote, ["rev-parse", `refs/heads/${f.branch}`]), finalHead);
  assert.equal(fs.readFileSync(countPath, "utf8"), "1");
  const eventsPath = path.join(f.runDir, "events.jsonl");
  const factsAfter = fs.readFileSync(eventsPath, "utf8");
  const activeFactsAfter = activeFactBytes(eventsPath);
  const prFacts = factsAfter.trim().split("\n").map(JSON.parse)
    .filter((fact) => fact.type === "pull_request_recorded");
  assert.equal(prFacts.length, 1);
  assert.equal(prFacts[0].payload.repo, f.remote);
  assert.equal(prFacts[0].payload.head_ref, f.branch);
  assert.equal(prFacts[0].payload.base_ref, "main");
  assert.equal(prFacts[0].payload.head_sha, finalHead);
  const receiptPath = path.join(f.runDir, `recovery-receipt-${action.key}.json`);
  const receiptAfter = fs.readFileSync(receiptPath, "utf8");

  const retry = spawnSync(process.execPath, [
    CLI, "recover", "--run-dir", f.runDir, "--reason", "publish exact recovery head",
    "--actor", "owner", "--expected-action-key", action.key, "--json",
  ], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).status, "noop");
  assert.equal(activeFactBytes(eventsPath), activeFactsAfter);
  assert.equal(fs.readFileSync(receiptPath, "utf8"), receiptAfter);
  assert.equal(fs.readFileSync(countPath, "utf8"), "1");
});

test("production recovery refuses a tracked remote outside the immutable run repository", (t) => {
  const f = fixture({ branch: "recovery" });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const wrongRemote = path.join(f.root, "wrong.git");
  execFileSync("git", ["init", "--bare", wrongRemote], { stdio: "ignore" });
  git(f.repo, ["remote", "set-url", "origin", wrongRemote]);
  fs.writeFileSync(path.join(f.repo, "README.md"), "must not push elsewhere\n");
  git(f.repo, ["add", "README.md"]);
  git(f.repo, ["commit", "-m", "wrong remote guard"]);
  const finalHead = git(f.repo, ["rev-parse", "HEAD"]);
  const finalTree = git(f.repo, ["rev-parse", "HEAD^{tree}"]);
  writeFacts(f.runDir, [{
    event_id: "attempt-finished", run_id: "issue-1135-cli", attempt_id: "attempt-1",
    type: "attempt_finished", at: "2026-08-01T00:01:00Z", actor: "codex",
    payload: {
      status: "completed", start_sha: f.head, final_sha: finalHead, tree_sha: finalTree,
      result_path: path.join(f.runDir, "result.txt"), exit_code: 0,
      verification_status: "not_declared",
    },
  }]);
  const env = { ...process.env, RELAY_GH_BIN: f.gh, RELAY_WORKTREE_BASE: f.root };
  const inspected = spawnSync(process.execPath, [CLI, "inspect", "--run-dir", f.runDir, "--json"], {
    cwd: ROOT, encoding: "utf8", env,
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  const output = JSON.parse(inspected.stdout);
  assert.equal(output.recommended_action.kind, "operator_attention");
  assert.equal(output.blockers.some((item) => item.code === "remote_identity_mismatch"), true);
  assert.throws(() => git(wrongRemote, ["rev-parse", `refs/heads/${f.branch}`]));
});

test("non-regular recovery receipt artifacts fail closed before effects or fact writes", (t) => {
  const f = fixture({ branch: "recovery" });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.repo, "README.md"), "symlink guard\n");
  git(f.repo, ["add", "README.md"]);
  git(f.repo, ["commit", "-m", "symlink guard"]);
  const finalHead = git(f.repo, ["rev-parse", "HEAD"]);
  const finalTree = git(f.repo, ["rev-parse", "HEAD^{tree}"]);
  writeFacts(f.runDir, [{
    event_id: "attempt-finished", run_id: "issue-1135-cli", attempt_id: "attempt-1",
    type: "attempt_finished", at: "2026-08-01T00:01:00Z", actor: "codex",
    payload: {
      status: "completed", start_sha: f.head, final_sha: finalHead, tree_sha: finalTree,
      result_path: path.join(f.runDir, "result.txt"), exit_code: 0,
      verification_status: "not_declared",
    },
  }]);
  const env = { ...process.env, RELAY_GH_BIN: f.gh, RELAY_WORKTREE_BASE: f.root };
  const inspected = spawnSync(process.execPath, [CLI, "inspect", "--run-dir", f.runDir, "--json"], {
    cwd: ROOT, encoding: "utf8", env,
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  const key = JSON.parse(inspected.stdout).recommended_action.key;
  const outside = path.join(f.root, "forged-receipt.json");
  fs.writeFileSync(outside, `${JSON.stringify({ schema_version: 1, operation_id: "forged" })}\n`);
  const receiptPath = path.join(f.runDir, `recovery-receipt-${key}.json`);
  fs.symlinkSync(outside, receiptPath);
  const eventsPath = path.join(f.runDir, "events.jsonl");
  const factsBefore = activeFactBytes(eventsPath);
  const recover = () => spawnSync(process.execPath, [
    CLI, "recover", "--run-dir", f.runDir, "--reason", "must reject forged receipt",
    "--actor", "owner", "--expected-action-key", key, "--json",
  ], { cwd: ROOT, encoding: "utf8", env });
  for (const createArtifact of [
    () => fs.symlinkSync(outside, receiptPath),
    () => fs.mkdirSync(receiptPath),
    () => execFileSync("mkfifo", [receiptPath]),
  ]) {
    fs.rmSync(receiptPath, { recursive: true, force: true });
    createArtifact();
    const recovered = recover();
    assert.notEqual(recovered.status, 0);
    assert.match(recovered.stderr, /cannot be opened safely|stable regular non-symlink/);
  }
  assert.equal(activeFactBytes(eventsPath), factsBefore);
  assert.equal(fs.readdirSync(f.runDir).some((name) => name.startsWith("recovery-intent-")), false);
});

test("production external MERGED recovery records durable provenance and no post-terminal fact", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const mergeSha = "d".repeat(40);
  const merged = {
    number: 42, state: "MERGED", url: "https://example.test/pull/42",
    headRefName: f.branch, headRefOid: f.head, baseRefName: "main",
    headRepository: { nameWithOwner: f.remote },
    headRepositoryOwner: { login: "owner" }, isCrossRepository: false,
    mergedAt: "2026-08-01T00:04:00Z", mergeCommit: { oid: mergeSha }, body: "",
  };
  fs.writeFileSync(f.gh, [
    "#!/usr/bin/env node",
    `const row=${JSON.stringify(merged)};`,
    "const cmd=process.argv[2]+' '+process.argv[3];",
    "if(cmd==='pr list')process.stdout.write(JSON.stringify([row]));",
    "else if(cmd==='pr view')process.stdout.write(JSON.stringify(row));",
    "else{process.stderr.write('unsupported fake gh argv\\n');process.exit(2);}",
    "",
  ].join("\n"));
  fs.chmodSync(f.gh, 0o755);
  writeFacts(f.runDir, [
    {
      event_id: "attempt-finished", run_id: "issue-1135-cli", attempt_id: "attempt-1",
      type: "attempt_finished", at: "2026-08-01T00:01:00Z", actor: "codex",
      payload: {
        status: "completed", start_sha: f.head, final_sha: f.head, tree_sha: f.tree,
        result_path: path.join(f.runDir, "result.txt"), exit_code: 0,
        verification_status: "not_declared",
      },
    },
    {
      event_id: "pr", run_id: "issue-1135-cli", type: "pull_request_recorded",
      at: "2026-08-01T00:02:00Z", actor: "codex",
      payload: {
        pr_number: 42, repo: f.remote, head_ref: f.branch, base_ref: "main",
        head_sha: f.head, created_by_relay: false,
      },
    },
  ]);
  const env = {
    ...process.env,
    RELAY_GH_BIN: f.gh,
    RELAY_WORKTREE_BASE: f.root,
    GH_TOKEN: "ephemeral-observer-token",
  };
  const inspected = spawnSync(process.execPath, [CLI, "inspect", "--run-dir", f.runDir, "--json"], {
    cwd: ROOT, encoding: "utf8", env,
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  const action = JSON.parse(inspected.stdout).recommended_action;
  assert.deepEqual(action.steps, ["record_external_merge"]);
  const recovered = spawnSync(process.execPath, [
    CLI, "recover", "--run-dir", f.runDir, "--reason", "reconcile externally merged exact PR",
    "--actor", "owner", "--expected-action-key", action.key, "--json",
  ], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(recovered.status, 0, recovered.stderr);
  const output = JSON.parse(recovered.stdout);
  assert.equal(output.status, "converged");
  const eventsPath = path.join(f.runDir, "events.jsonl");
  const factsAfter = fs.readFileSync(eventsPath, "utf8").trim().split("\n").map(JSON.parse);
  const merges = factsAfter.filter((fact) => fact.type === "merge_recorded");
  assert.equal(merges.length, 1);
  assert.equal(merges[0].payload.method, "external");
  assert.equal(merges[0].payload.pr_number, 42);
  assert.equal(merges[0].payload.reviewed_source_sha, f.head);
  assert.equal(merges[0].payload.pr_head_sha, f.head);
  assert.equal(merges[0].payload.result_target_sha, mergeSha);
  assert.equal(merges[0].payload.done_criteria_sha256, f.doneHash);
  assert.equal(merges[0].payload.operator, "owner");
  assert.equal(merges[0].payload.override_reason, "reconcile externally merged exact PR");
  assert.equal(factsAfter.filter((fact) => fact.type === "recovery_applied").length, 0);
  assert.ok(fs.existsSync(path.join(f.runDir, `merge-receipt-${output.operation_id}.json`)));
  const recoveryReceipt = path.join(f.runDir, `recovery-receipt-${action.key}.json`);
  assert.ok(fs.existsSync(recoveryReceipt));
  const activeFactsBytes = activeFactBytes(eventsPath);
  const receiptBytes = fs.readFileSync(recoveryReceipt, "utf8");
  const retry = spawnSync(process.execPath, [
    CLI, "recover", "--run-dir", f.runDir, "--reason", "reconcile externally merged exact PR",
    "--actor", "owner", "--expected-action-key", action.key, "--json",
  ], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).status, "noop");
  assert.equal(activeFactBytes(eventsPath), activeFactsBytes);
  assert.equal(fs.readFileSync(recoveryReceipt, "utf8"), receiptBytes);
});
