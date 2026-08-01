"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const facts = require("../../../skills/relay-dispatch/scripts/facts");
const host = require("../../../skills/relay-dispatch/scripts/host");
const TREE_WORKER = path.join(__dirname, "..", "fixtures", "host-process-tree-worker.js");
const STDERR_PRELOAD = path.join(__dirname, "..", "fixtures", "host-stderr-preload.js");
const STARTUP_WINDOW_PRELOAD = path.join(__dirname, "..", "fixtures", "host-startup-window-preload.js");
const SIGNAL_FAILURE_PRELOAD = path.join(__dirname, "..", "fixtures", "host-signal-failure-preload.js");
const { initializeHostRun } = require("../fixtures/host-run-fixture");

function root(label) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-vnext-host-supervisor-${label}-`)));
}

function auditAppender(runDir) {
  return (audit, capability) => facts.appendFact({
    eventsPath: path.join(runDir, "events.jsonl"),
    lockContext: capability,
    fact: facts.factFromHostAudit({
      runId: path.basename(runDir),
      eventId: `host-${audit.audit_key}`,
      at: new Date().toISOString(),
      actor: "supervisor-test",
      audit,
    }),
  });
}

async function waitForGone(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === "ESRCH") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("spawn errors always produce an exactly bound terminal result", { timeout: 20_000 }, async () => {
  const runDir = root("spawn-error");
  const receipt = host.launchLocalSupervisor({
    runDir,
    attemptId: "spawn-error",
    lockId: "lock-spawn-error",
    hostHandle: `dev.relay.host.test.${process.pid}.spawnerror`,
    command: "relay-executor-that-does-not-exist",
    cwd: runDir,
    timeoutMs: 2_000,
  });
  const result = await host.waitForTerminalResult(receipt);
  assert.equal(result.status, "spawn_error");
  assert.equal(result.lock_id, receipt.lock_id);
  assert.equal(result.host_handle, receipt.host_handle);
});

test("supervisor rejects config bytes that do not match the launch binding", () => {
  const runDir = root("config-integrity");
  const configPath = path.join(runDir, "host-attempt-tampered.json");
  fs.writeFileSync(configPath, "{}\n", "utf8");
  const child = spawnSync(process.execPath, [
    require.resolve("../../../skills/relay-dispatch/scripts/host"),
    "--supervise",
    configPath,
    "0".repeat(64),
  ], { encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /integrity check failed/);
});

test("pre-existing attempt artifacts fail before config or process creation", () => {
  const runDir = root("startup-diagnostic");
  fs.writeFileSync(path.join(runDir, "host-attempt-claimed.supervisor-claim"), "occupied\n");
  assert.throws(
    () => host.launchLocalSupervisor({
      runDir,
      attemptId: "claimed",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: runDir,
      timeoutMs: 10_000,
    }),
    (error) => {
      assert.equal(error.code, "HOST_ATTEMPT_ARTIFACT_EXISTS");
      assert.equal(error.attemptId, "claimed");
      assert.equal(error.recommended_action, "inspect");
      return true;
    },
  );
});

test("forged pre-existing ready artifact is rejected before launch", () => {
  const runDir = root("forged-ready");
  fs.writeFileSync(path.join(runDir, "host-attempt-forged-ready.ready.json"), `${JSON.stringify({
    attempt_id: "forged-ready",
    host_handle: "forged",
    ready_at: "1999-01-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  assert.throws(
    () => host.launchLocalSupervisor({
      runDir,
      attemptId: "forged-ready",
      command: "/usr/bin/true",
      cwd: runDir,
    }),
    (error) => error.code === "HOST_ATTEMPT_ARTIFACT_EXISTS",
  );
});

test("attempt relaunch fails explicitly without clobbering config", { timeout: 60_000 }, async () => {
  const runDir = root("relaunch");
  const receipt = host.launchLocalSupervisor({
    runDir,
    attemptId: "once",
    command: "/usr/bin/true",
    cwd: runDir,
  });
  assert.equal((await host.waitForTerminalResult(receipt)).status, "completed");
  const before = fs.readFileSync(receipt.config_path);
  assert.throws(
    () => host.launchLocalSupervisor({
      runDir,
      attemptId: "once",
      command: "/usr/bin/true",
      cwd: runDir,
    }),
    (error) => error.code === "HOST_ATTEMPT_ALREADY_LAUNCHED"
      && error.recommended_action === "inspect",
  );
  assert.deepEqual(fs.readFileSync(receipt.config_path), before);
});

test("ordinary startup stderr does not abandon a live supervisor", { timeout: 60_000 }, async () => {
  const runDir = root("startup-banner");
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${STDERR_PRELOAD}`;
  let receipt;
  try {
    receipt = host.launchLocalSupervisor({
      runDir,
      attemptId: "startup-banner",
      command: "/usr/bin/true",
      cwd: runDir,
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
  assert.equal((await host.waitForTerminalResult(receipt)).status, "completed");
  assert.match(fs.readFileSync(receipt.startup_stderr_path, "utf8"), /fixture preload banner/);
});

test("startup timeout re-discovers and terminates an executor spawned before identity publication", { timeout: 40_000 }, async () => {
  const runDir = root("startup-window");
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${STARTUP_WINDOW_PRELOAD}`;
  try {
    assert.throws(
      () => host.launchLocalSupervisor({
        runDir,
        attemptId: "startup-window",
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        cwd: runDir,
        supervisorStartupTimeoutMs: 20_000,
      }),
      (error) => error.code === "HOST_START_FAILED",
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
  const executorPath = path.join(runDir, "host-attempt-startup-window.executor.json");
  assert.equal(fs.existsSync(executorPath), true);
  const executor = JSON.parse(fs.readFileSync(executorPath, "utf8"));
  assert.equal(await waitForGone(executor.executor_pid, 5_000), true);
});

test("supervisor death cannot make a live executor eligible for stale break", { timeout: 90_000 }, async () => {
  const runDir = root("supervisor-death");
  const worktreeDir = fs.realpathSync(process.cwd());
  initializeHostRun(runDir, { worktreeDir });
  const audit = auditAppender(runDir);
  const lock = host.acquireRunLock({
    runDir,
    worktreeDir,
    attemptId: "supervisor-death",
    operation: "dispatch",
    audit,
  });
  const receipt = host.launchLocalSupervisor({
    runDir,
    attemptId: "supervisor-death",
    lockContext: lock,
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    timeoutMs: 60_000,
  });
  const ready = JSON.parse(fs.readFileSync(receipt.ready_path, "utf8"));
  const executor = JSON.parse(fs.readFileSync(receipt.executor_path, "utf8"));
  process.kill(ready.supervisor_pid, "SIGKILL");
  await waitForGone(ready.supervisor_pid, 10_000);
  const inspection = host.inspectOwnership({
    runDir,
    worktreeFacts: host.observeWorktree({ runDir, worktreeDir }),
  });
  assert.notEqual(inspection.status, "stale");
  assert.throws(
    () => host.captureLivenessProbe(inspection),
    (error) => ["INSPECTION_CAPABILITY_INVALID", "BREAK_EVIDENCE_INSUFFICIENT"].includes(error.code),
  );
  try { process.kill(-executor.executor_pgid, "SIGKILL"); } catch {}
  host.releaseRunLock(lock, { audit });
});

test("missing ready or tampered executor identity never makes a live launch stale", { timeout: 90_000 }, async () => {
  for (const mode of ["missing-ready", "tampered-executor"]) {
    const runDir = root(mode);
    const worktreeDir = fs.realpathSync(process.cwd());
    initializeHostRun(runDir, { worktreeDir });
    const audit = auditAppender(runDir);
    const lock = host.acquireRunLock({
      runDir,
      worktreeDir,
      attemptId: mode,
      operation: "dispatch",
      audit,
    });
    const receipt = host.launchLocalSupervisor({
      runDir,
      attemptId: mode,
      lockContext: lock,
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      timeoutMs: 60_000,
    });
    const ready = JSON.parse(fs.readFileSync(receipt.ready_path, "utf8"));
    const executor = JSON.parse(fs.readFileSync(receipt.executor_path, "utf8"));
    if (mode === "missing-ready") {
      fs.unlinkSync(receipt.ready_path);
    } else {
      fs.writeFileSync(receipt.executor_path, `${JSON.stringify({
        ...executor,
        executor_nonce: "tampered",
      })}\n`);
      process.kill(ready.supervisor_pid, "SIGKILL");
      await waitForGone(ready.supervisor_pid, 10_000);
    }
    const inspection = host.inspectOwnership({
      runDir,
      worktreeFacts: host.observeWorktree({ runDir, worktreeDir }),
    });
    assert.notEqual(inspection.status, "stale", mode);
    try { process.kill(-executor.executor_pgid, "SIGKILL"); } catch {}
    host.releaseRunLock(lock, { audit });
  }
});

test("normal wait rejects a forged matching result without a valid HMAC", async () => {
  const runDir = root("forged-result");
  const receipt = host.launchLocalSupervisor({
    runDir,
    attemptId: "forged-result",
    lockId: "lock-forged-result",
    hostHandle: `dev.relay.host.test.${process.pid}.forged`,
    command: process.execPath,
    args: ["-e", "setTimeout(()=>process.exit(0),3000)"],
    cwd: runDir,
    timeoutMs: 10_000,
  });
  fs.writeFileSync(receipt.result_path, `${JSON.stringify({
    attempt_id: receipt.attempt_id,
    lock_id: receipt.lock_id,
    host_kind: receipt.host_kind,
    host_handle: receipt.host_handle,
    status: "completed",
    exit_code: 0,
    signal: null,
    error: null,
    completed_at: new Date().toISOString(),
    result_auth_sha256: "0".repeat(64),
  })}\n`, "utf8");
  await assert.rejects(
    host.waitForTerminalResult(receipt),
    (error) => error.code === "HOST_RESULT_MISMATCH",
  );
});

test("logical host handles are scoped by immutable run and attempt identity", { timeout: 120_000 }, async () => {
  const firstRun = root("duplicate-label-owner");
  const secondRun = root("duplicate-label-contender");
  const hostHandle = `dev.relay.host.test.${process.pid}.duplicate`;
  const owner = host.launchLocalSupervisor({
    runDir: firstRun,
    attemptId: "duplicate-owner",
    hostHandle,
    command: process.execPath,
    args: ["-e", "setTimeout(()=>process.exit(0),100)"],
    cwd: firstRun,
    timeoutMs: 60_000,
  });
  const contender = host.launchLocalSupervisor({
    runDir: secondRun,
    attemptId: "duplicate-contender",
    hostHandle,
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: secondRun,
    timeoutMs: 60_000,
  });
  const [ownerResult, contenderResult] = await Promise.all([
    host.waitForTerminalResult(owner),
    host.waitForTerminalResult(contender),
  ]);
  assert.equal(ownerResult.status, "completed");
  assert.equal(contenderResult.status, "completed");
  assert.notEqual(ownerResult.attempt_id, contenderResult.attempt_id);
});

test("timeout and explicit cancellation terminate the executor process group and descendants within a bound", { timeout: 180_000 }, async () => {
  for (const mode of ["timed_out", "cancelled"]) {
    const runDir = root(mode);
    const pidPath = path.join(runDir, "pids.json");
    const receipt = host.launchLocalSupervisor({
      runDir,
      attemptId: mode,
      lockId: `lock-${mode}`,
      hostHandle: `dev.relay.host.test.${process.pid}.${mode}`,
      command: process.execPath,
      args: [TREE_WORKER, pidPath, "ignore"],
      cwd: runDir,
      timeoutMs: mode === "timed_out" ? 30_000 : 60_000,
      cancelGraceMs: 100,
    });
    let cancelRequestedAt = null;
    if (mode === "cancelled") {
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(pidPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(fs.existsSync(pidPath), true, "cancel worker must become observable");
      cancelRequestedAt = Date.now();
      host.cancelHost(receipt, { reason: "contract_test" });
    }
    const result = await host.waitForTerminalResult(receipt);
    assert.equal(result.status, mode);
    if (mode === "timed_out") {
      assert.ok(Date.parse(result.completed_at) - Date.parse(receipt.started_at) < 35_000);
    } else {
      assert.ok(Date.parse(result.completed_at) - cancelRequestedAt < 5_000);
    }
    const pids = JSON.parse(fs.readFileSync(pidPath, "utf8"));
    for (const pid of [pids.parent, pids.descendant]) {
      assert.equal(await waitForGone(pid), true, `${mode}: pid ${pid} must be gone`);
    }
  }
});

test("normal exit with unanchored descendants fails closed without publishing terminal", { timeout: 30_000 }, async () => {
  const runDir = root("normal-descendants");
  const pidPath = path.join(runDir, "pids.json");
  const receipt = host.launchLocalSupervisor({
    runDir,
    attemptId: "normal-descendants",
    command: process.execPath,
    args: [TREE_WORKER, pidPath, "normal-exit"],
    cwd: runDir,
    timeoutMs: 10_000,
    cancelGraceMs: 100,
  });
  await assert.rejects(
    host.waitForTerminalResult(receipt, { timeoutMs: 2_000 }),
    (error) => error.code === "HOST_RESULT_TIMEOUT",
  );
  assert.equal(fs.existsSync(receipt.result_path), false);
  const pids = JSON.parse(fs.readFileSync(pidPath, "utf8"));
  try { process.kill(-pids.parent, "SIGKILL"); } catch {}
});

test("failed TERM and KILL never publish terminal while the executor group is live", { timeout: 20_000 }, async () => {
  const runDir = root("signal-failure");
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${SIGNAL_FAILURE_PRELOAD}`;
  let receipt;
  try {
    receipt = host.launchLocalSupervisor({
      runDir,
      attemptId: "signal-failure",
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: runDir,
      timeoutMs: 60_000,
      cancelGraceMs: 100,
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
  const ready = JSON.parse(fs.readFileSync(receipt.ready_path, "utf8"));
  const executor = JSON.parse(fs.readFileSync(receipt.executor_path, "utf8"));
  host.cancelHost(receipt);
  await assert.rejects(
    host.waitForTerminalResult(receipt, { timeoutMs: 2_000 }),
    (error) => error.code === "HOST_RESULT_TIMEOUT",
  );
  assert.equal(fs.existsSync(receipt.result_path), false);
  process.kill(-executor.executor_pgid, "SIGKILL");
  await waitForGone(ready.supervisor_pid, 5_000);
});
