"use strict";

// #1135 production lock reclamation contract.  This intentionally creates an
// owner in another real Node process: a same-process fabricated capability
// would not exercise the durable owner identity or stale-inspection boundary.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const facts = require("../../../skills/relay-dispatch/scripts/facts");
const host = require("../../../skills/relay-dispatch/scripts/host");
const recovery = require("../../../skills/relay-dispatch/scripts/recover");
const runtime = { inspectRun: recovery.inspectProductionRun, recoverRun: recovery.recoverProductionRun };
const { createRunRecord } = require("../../../skills/relay-dispatch/scripts/run-store");

const ROOT = path.resolve(__dirname, "../../..");
const HOST_PATH = path.join(ROOT, "skills/relay-dispatch/scripts/host.js");
const FACTS_PATH = path.join(ROOT, "skills/relay-dispatch/scripts/facts.js");
const SHA = "a".repeat(40);

function git(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function requireGit(cwd, args) {
  const result = git(cwd, args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-recover-stale-${label}-`)));
  const repo = path.join(root, "repo");
  const active = path.join(root, "active");
  const runDir = path.join(root, `issue-1135-${label}`);
  fs.mkdirSync(repo);
  fs.mkdirSync(active);
  fs.mkdirSync(runDir);
  requireGit(repo, ["init", "-b", "main"]);
  requireGit(repo, ["config", "user.email", "relay@example.test"]);
  requireGit(repo, ["config", "user.name", "Relay Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "stale owner fixture\n");
  requireGit(repo, ["add", "README.md"]);
  requireGit(repo, ["commit", "-m", "initial"]);
  requireGit(repo, ["checkout", "-b", "issue-1135-stale-owner"]);
  const head = requireGit(repo, ["rev-parse", "HEAD"]);
  const donePath = path.join(runDir, "done-criteria.md");
  const done = "# Done\n\nRecover stale ownership safely.\n";
  fs.writeFileSync(donePath, done);
  createRunRecord({
    runDir,
    record: {
      version: 3,
      run_id: path.basename(runDir),
      // Stale-owner recovery is delivery-neutral. Keep this fixture on the
      // exact no-remote local identity so it also proves local dead-attempt
      // recovery without a forge or transport side effect.
      repo: { root: active, remote: "local/active" },
      git: {
        branch: "issue-1135-stale-owner",
        base_branch: "main",
        worktree: repo,
        start_sha: head,
      },
      contract: {
        done_criteria_path: donePath,
        done_criteria_sha256: crypto.createHash("sha256").update(done).digest("hex"),
      },
      roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
      parent: null,
      ownership_digest: null,
      created_at: "2026-08-01T00:00:00.000Z",
    },
  });
  fs.writeFileSync(path.join(runDir, "events.jsonl"), "");
  const fakeGh = path.join(root, "fake-gh.js");
  fs.writeFileSync(fakeGh, [
    "#!/usr/bin/env node",
    "if (process.argv.slice(2, 4).join(' ') === 'pr list') process.stdout.write('[]');",
    "else { process.stderr.write('unexpected gh command\\n'); process.exit(2); }",
    "",
  ].join("\n"));
  fs.chmodSync(fakeGh, 0o755);
  return { root, active, repo, runDir, fakeGh, runId: path.basename(runDir) };
}

const OWNER_WORKER = String.raw`
const fs = require("fs");
const path = require("path");
const host = require(process.env.RELAY_TEST_HOST);
const facts = require(process.env.RELAY_TEST_FACTS);
const cfg = JSON.parse(process.env.RELAY_TEST_OWNER_CONFIG);
const lock = host.acquireRunLock({
  runDir: cfg.runDir,
  worktreeDir: cfg.worktreeDir,
  attemptId: cfg.attemptId,
  operation: "dispatch",
  hostKind: "local_supervisor",
  hostHandle: cfg.hostHandle,
  audit(audit, capability) {
    facts.appendFact({
      eventsPath: path.join(cfg.runDir, "events.jsonl"),
      lockContext: capability,
      fact: facts.factFromHostAudit({
        runId: cfg.runId,
        eventId: "owner-lock-" + audit.audit_key,
        at: new Date().toISOString(),
        actor: "stale-owner-worker",
        audit,
      }),
    });
  },
});
facts.appendFact({
  eventsPath: path.join(cfg.runDir, "events.jsonl"),
  lockContext: lock,
  fact: {
    event_id: "owner-attempt-" + lock.lock_id,
    run_id: cfg.runId,
    attempt_id: cfg.attemptId,
    type: "attempt_started",
    at: new Date().toISOString(),
    actor: "stale-owner-worker",
    payload: {
      executor: "codex", model: null, start_sha: cfg.startSha,
      host_kind: "local_supervisor", host_handle: cfg.hostHandle,
      stdout_path: "/run/stdout", stderr_path: "/run/stderr", result_path: "/run/result",
      timeout_ms: 60000,
    },
  },
});
process.stdout.write(JSON.stringify(lock));
if (cfg.exit) process.exit(0);
setInterval(() => {}, 1000);
`;

function startOwner(f, { attemptId, exit }) {
  const child = spawn(process.execPath, ["-e", OWNER_WORKER], {
    cwd: ROOT,
    env: {
      ...process.env,
      RELAY_TEST_HOST: HOST_PATH,
      RELAY_TEST_FACTS: FACTS_PATH,
      RELAY_TEST_OWNER_CONFIG: JSON.stringify({
        runDir: f.runDir,
        worktreeDir: f.repo,
        runId: f.runId,
        attemptId,
        hostHandle: `owner-${attemptId}`,
        startSha: requireGit(f.repo, ["rev-parse", "HEAD"]),
        exit,
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

async function childJsonAndExit(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve) => child.once("close", (code) => resolve(code)));
  assert.equal(status, 0, stderr);
  return JSON.parse(stdout);
}

async function childJsonWhenReady(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (stdout) return JSON.parse(stdout);
    if (child.exitCode !== null) throw new Error(`owner exited early (${child.exitCode}): ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for live owner: ${stderr}`);
}

function rawOwner(runDir) {
  const ownerDir = path.join(runDir, "ownership");
  const ownerName = fs.readdirSync(ownerDir).find((name) => name.endsWith(".owner.json"));
  assert.ok(ownerName, "a durable owner record must exist");
  return JSON.parse(fs.readFileSync(path.join(ownerDir, ownerName), "utf8"));
}

function writeAuthenticatedCancelledResult(f, owner) {
  const unsigned = {
    lock_id: owner.lock_id,
    attempt_id: owner.attempt_id,
    host_kind: "local_supervisor",
    host_handle: owner.host_handle,
    status: "cancelled",
    exit_code: null,
    signal: null,
    error: null,
    completed_at: new Date().toISOString(),
  };
  const result = {
    ...unsigned,
    result_auth_sha256: crypto.createHmac("sha256", owner.secret)
      .update(JSON.stringify(unsigned))
      .digest("hex"),
  };
  const resultPath = path.join(f.runDir, `attempt-${owner.attempt_id}.result.json`);
  fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  return resultPath;
}

function writeAuthenticatedCleanup(f, owner) {
  const identity = {
    pid: owner.process.pid, pgid: owner.process.pgid, started_at: owner.process.started_at,
  };
  const unsigned = {
    v: 2, kind: "executor", attempt_id: owner.attempt_id, lock_id: owner.lock_id, host_handle: owner.host_handle,
    identities: { supervisor: identity, executor: null }, error: "injected cleanup obligation",
    terminal: { status: "failed", exit_code: 1, signal: null },
    obligation: { processes: [identity], staged_input_root: null, scope_seal: null },
    observed_at: new Date().toISOString(),
  };
  const marker = { ...unsigned, auth_sha256: crypto.createHmac("sha256", owner.secret).update(JSON.stringify(unsigned)).digest("hex") };
  fs.writeFileSync(path.join(f.runDir, `host-attempt-${owner.attempt_id}.cleanup-incomplete.json`), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  return null;
}

function createForeignUnknownOwner(f, attemptId) {
  const lock = host.acquireRunLock({
    runDir: f.runDir,
    worktreeDir: f.repo,
    attemptId,
    operation: "dispatch",
    host: "foreign.example.test",
    hostKind: "local_supervisor",
    hostHandle: `foreign-${attemptId}`,
  });
  facts.appendFact({
    eventsPath: path.join(f.runDir, "events.jsonl"),
    lockContext: lock,
    fact: {
      event_id: `foreign-attempt-${attemptId}`,
      run_id: f.runId,
      attempt_id: attemptId,
      type: "attempt_started",
      at: "2026-08-01T00:01:00Z",
      actor: "foreign-owner",
      payload: {
        executor: "codex", model: null,
        start_sha: requireGit(f.repo, ["rev-parse", "HEAD"]),
        host_kind: "local_supervisor", host_handle: `foreign-${attemptId}`,
        stdout_path: "/run/stdout", stderr_path: "/run/stderr",
        result_path: "/run/result", timeout_ms: 60000,
      },
    },
  });
  return { lock, owner: rawOwner(f.runDir) };
}

function factsFor(f) {
  return facts.readFacts({ eventsPath: path.join(f.runDir, "events.jsonl") }).facts;
}

async function withFakeGh(f, callback) {
  const previous = process.env.RELAY_GH_BIN;
  const previousWorktreeBase = process.env.RELAY_WORKTREE_BASE;
  process.env.RELAY_GH_BIN = f.fakeGh;
  process.env.RELAY_WORKTREE_BASE = f.root;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.RELAY_GH_BIN;
    else process.env.RELAY_GH_BIN = previous;
    if (previousWorktreeBase === undefined) delete process.env.RELAY_WORKTREE_BASE;
    else process.env.RELAY_WORKTREE_BASE = previousWorktreeBase;
  }
}

test("explicit close intent appends one terminal fact and is exactly idempotent", async (t) => {
  const f = fixture("close-intent");
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await withFakeGh(f, async () => {
    await assert.rejects(recovery.recoverProductionRun({
      runDir: f.runDir,
      closeIntent: { operator: "owner", reason: "reviewed_result_ready" },
      activeCheckout: f.active, relayWorktreeBase: f.root,
    }), (error) => error.code === "RESERVED_CLOSE_REASON");
    assert.equal(factsFor(f).filter((entry) => entry.type === "run_closed").length, 0);
    const first = await recovery.recoverProductionRun({
      runDir: f.runDir, actor: "ignored-for-close", reason: "close",
      closeIntent: { operator: "owner", reason: "superseded" },
      activeCheckout: f.active, relayWorktreeBase: f.root,
    });
    assert.equal(first.closed, true);
    assert.equal(first.after.derived.reason, "closed");
    const second = await recovery.recoverProductionRun({
      runDir: f.runDir, closeIntent: { operator: "owner", reason: "superseded" },
      activeCheckout: f.active, relayWorktreeBase: f.root,
    });
    assert.equal(second.idempotent, true);
    assert.equal(factsFor(f).filter((entry) => entry.type === "run_closed").length, 1);
    await assert.rejects(recovery.recoverProductionRun({
      runDir: f.runDir, closeIntent: { operator: "another", reason: "different" },
      activeCheckout: f.active, relayWorktreeBase: f.root,
    }), (error) => error.code === "TERMINAL_FACT_CONFLICT");
  });
});

test("canonical recover reclaims an issued dead local owner with authenticated proof exactly once", { timeout: 30_000 }, async (t) => {
  const f = fixture("dead");
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const dead = startOwner(f, { attemptId: "dead-owner", exit: true });
  const lock = await childJsonAndExit(dead);
  const owner = rawOwner(f.runDir);
  assert.equal(owner.lock_id, lock.lock_id);
  const resultPath = writeAuthenticatedCancelledResult(f, owner);

  await withFakeGh(f, async () => {
    const inspected = await runtime.inspectRun({ runDir: f.runDir });
    assert.equal(inspected.recommended_action.kind, "recover", JSON.stringify(inspected, null, 2));
    assert.equal(inspected.recommended_action.reason, "attempt_liveness_unknown");
    assert.deepEqual(inspected.recommended_action.steps, ["close_dead_attempt"]);

    await assert.rejects(
      runtime.recoverRun({
        runDir: f.runDir,
        actor: "owner",
        reason: "ordinary recovery must not break ownership",
        expectedActionKey: inspected.recommended_action.key,
      }),
      /explicit --break-lock is required/,
    );

    const recovered = await runtime.recoverRun({
      runDir: f.runDir,
      actor: "owner",
      reason: "recover issued stale owner after authenticated terminal result",
      expectedActionKey: inspected.recommended_action.key,
      breakLock: true,
    });
    assert.equal(recovered.status, "converged");
    assert.deepEqual(recovered.applied.map((entry) => entry.step), ["close_dead_attempt"]);

    const after = factsFor(f);
    assert.equal(after.filter((entry) => (
      entry.type === "attempt_interrupted" && entry.attempt_id === "dead-owner"
    )).length, 1);
    assert.equal(after.filter((entry) => (
      entry.type === "lock_released" && entry.attempt_id === "dead-owner" && entry.payload.outcome === "broken"
    )).length, 1, "stale break must leave a canonical audit fact");
    assert.equal(host.inspectOwnership({ runDir: f.runDir }).status, "absent", "recovery must release its ownership generation");
    assert.ok(fs.existsSync(resultPath));

    const beforeRetry = factsFor(f).filter((entry) => (
      !new Set(["lock_acquired", "lock_released"]).has(entry.type)
    ));
    const retry = await runtime.recoverRun({
      runDir: f.runDir,
      actor: "owner",
      reason: "recover issued stale owner after authenticated terminal result",
      expectedActionKey: inspected.recommended_action.key,
    });
    assert.equal(retry.status, "noop");
    assert.deepEqual(factsFor(f).filter((entry) => (
      !new Set(["lock_acquired", "lock_released"]).has(entry.type)
    )), beforeRetry);
  });
});

test("canonical recover settles an authenticated cleanup obligation and records one outcome", { timeout: 30_000 }, async (t) => {
  const f = fixture("cleanup-obligation");
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await childJsonAndExit(startOwner(f, { attemptId: "cleanup-owner", exit: true }));
  const owner = rawOwner(f.runDir); writeAuthenticatedCleanup(f, owner);
  await withFakeGh(f, async () => {
    const inspected = await runtime.inspectRun({ runDir: f.runDir });
    assert.equal(inspected.observations.host.cleanup_pending, true);
    assert.deepEqual(inspected.recommended_action.steps, ["close_dead_attempt"]);
    const recovered = await runtime.recoverRun({
      runDir: f.runDir, actor: "owner", reason: "settle exact cleanup obligation",
      expectedActionKey: inspected.recommended_action.key, breakLock: true,
    });
    assert.equal(recovered.status, "converged");
    assert.deepEqual(recovered.applied.map((entry) => entry.step), ["close_dead_attempt"]);
    assert.equal(fs.existsSync(path.join(f.runDir, "host-attempt-cleanup-owner.cleanup-settled.json")), true);
    assert.equal(fs.existsSync(path.join(f.runDir, "attempt-cleanup-owner.result.json")), true);
    assert.equal(factsFor(f).filter((entry) => entry.type === "attempt_interrupted" && entry.attempt_id === "cleanup-owner").length, 1);
    const retry = await runtime.recoverRun({ runDir: f.runDir, actor: "owner", reason: "settle exact cleanup obligation",
      expectedActionKey: inspected.recommended_action.key });
    assert.equal(retry.status, "noop");
    assert.equal(factsFor(f).filter((entry) => entry.type === "attempt_interrupted" && entry.attempt_id === "cleanup-owner").length, 1);
  });
});

test("canonical recover never breaks a live local owner", { timeout: 30_000 }, async (t) => {
  const f = fixture("live");
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const live = startOwner(f, { attemptId: "live-owner", exit: false });
  t.after(() => { try { live.kill("SIGKILL"); } catch {} });
  await childJsonWhenReady(live);

  await withFakeGh(f, async () => {
    const inspected = await runtime.inspectRun({ runDir: f.runDir });
    assert.equal(inspected.recommended_action.kind, "wait", JSON.stringify(inspected, null, 2));
    assert.equal(inspected.recommended_action.reason, "attempt_live");
    await assert.rejects(
      runtime.recoverRun({
        runDir: f.runDir,
        actor: "owner",
        reason: "must not preempt live owner",
        expectedActionKey: inspected.recommended_action.key,
        breakLock: true,
      }),
      /run lock is already held|action.*recoverable|live/i,
    );
  });

  assert.equal(host.inspectOwnership({ runDir: f.runDir }).status, "live");
  const ownership = fs.readdirSync(path.join(f.runDir, "ownership"));
  assert.equal(ownership.some((name) => name.endsWith(".closed.json")), false);
  assert.equal(factsFor(f).filter((entry) => entry.type === "attempt_interrupted").length, 0);
});

test("explicit recovery breaks an unknown foreign owner only with its authenticated terminal result", async (t) => {
  const f = fixture("foreign-authenticated");
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const { owner } = createForeignUnknownOwner(f, "foreign-authenticated");
  writeAuthenticatedCancelledResult(f, owner);

  await withFakeGh(f, async () => {
    const inspected = await runtime.inspectRun({ runDir: f.runDir });
    assert.equal(inspected.observations.host.status, "unknown");
    assert.equal(inspected.recommended_action.kind, "operator_attention");
    await assert.rejects(runtime.recoverRun({
      runDir: f.runDir,
      actor: "owner",
      reason: "ordinary recovery cannot break unknown ownership",
    }), /explicit --break-lock is required/);
    const recovered = await runtime.recoverRun({
      runDir: f.runDir,
      actor: "owner",
      reason: "authenticated foreign terminal result",
      breakLock: true,
    });
    assert.equal(recovered.status, "converged");
  });
  const after = factsFor(f);
  assert.equal(after.filter((entry) => (
    entry.type === "lock_released"
    && entry.attempt_id === "foreign-authenticated"
    && entry.payload.outcome === "broken"
  )).length, 1);
  assert.equal(after.filter((entry) => (
    entry.type === "attempt_interrupted" && entry.attempt_id === "foreign-authenticated"
  )).length, 1);
});

test("unknown foreign owner without a terminal result never falls back to liveness probes", async (t) => {
  const f = fixture("foreign-missing");
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  createForeignUnknownOwner(f, "foreign-missing");
  await withFakeGh(f, async () => {
    const inspected = await runtime.inspectRun({ runDir: f.runDir });
    assert.equal(inspected.observations.host.status, "unknown");
    await assert.rejects(runtime.recoverRun({
      runDir: f.runDir,
      actor: "owner",
      reason: "missing proof must fail",
      breakLock: true,
    }), (error) => {
      assert.match(error.message, /requires terminal proof/);
      assert.equal(error.code, "BREAK_EVIDENCE_INSUFFICIENT");
      return true;
    });
  });
  const ownership = fs.readdirSync(path.join(f.runDir, "ownership"));
  assert.equal(ownership.some((name) => name.endsWith(".closed.json")), false);
});

test("unknown foreign owner with a forged terminal result fails closed", async (t) => {
  const f = fixture("foreign-forged");
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const { owner } = createForeignUnknownOwner(f, "foreign-forged");
  const resultPath = writeAuthenticatedCancelledResult(f, owner);
  const forged = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  forged.result_auth_sha256 = "0".repeat(64);
  fs.writeFileSync(resultPath, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
  await withFakeGh(f, async () => {
    const inspected = await runtime.inspectRun({ runDir: f.runDir });
    assert.equal(inspected.observations.host.status, "unknown");
    await assert.rejects(runtime.recoverRun({
      runDir: f.runDir,
      actor: "owner",
      reason: "forged proof must fail",
      breakLock: true,
    }), /unauthenticated|insufficient|exactly match/i);
  });
  const ownership = fs.readdirSync(path.join(f.runDir, "ownership"));
  assert.equal(ownership.some((name) => name.endsWith(".closed.json")), false);
});
