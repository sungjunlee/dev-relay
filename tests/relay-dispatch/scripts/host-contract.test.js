"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const host = require("../../../skills/relay-dispatch/scripts/host");
const facts = require("../../../skills/relay-dispatch/scripts/facts");
const { initializeHostRun } = require("../fixtures/host-run-fixture");
const LOCK_AND_EXIT = path.join(__dirname, "..", "fixtures", "host-lock-and-exit.js");
const RESUME_TERMINAL = path.join(__dirname, "..", "fixtures", "host-resume-terminal.js");
const RESUME_TERMINAL_CANONICAL = path.join(
  __dirname,
  "..",
  "fixtures",
  "host-resume-terminal-canonical.js",
);

function runDir(label) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-vnext-host-${label}-`)));
}

function isolatedWorktree(label) {
  const directory = runDir(`worktree-${label}`);
  fs.writeFileSync(path.join(directory, "README.md"), "fixture\n", "utf8");
  for (const args of [
    ["init", "-q"],
    ["add", "README.md"],
    ["-c", "user.name=Relay Test", "-c", "user.email=relay@example.invalid", "commit", "-qm", "fixture"],
  ]) {
    const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return directory;
}

function waitForChildren(children) {
  return Promise.all(children.map((child) => new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  })));
}

async function waitForReadyFiles(directory, count) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.readdirSync(directory).filter((name) => name.endsWith(".ready")).length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${count} resume contenders`);
}

async function waitForSupervisorExit(receipt, timeoutMs = 10_000) {
  const ready = JSON.parse(fs.readFileSync(receipt.ready_path, "utf8"));
  const identity = {
    host: os.hostname(),
    pid: ready.supervisor_pid,
    process_started_at: ready.supervisor_started_at,
    process_fingerprint: ready.supervisor_fingerprint,
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (host.probeLocalProcess(identity).status === "dead") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for supervisor ${ready.supervisor_pid} to exit`);
}

test("issued capability binds object identity, token, run, fd, and lock inode", () => {
  const directory = runDir("capability");
  const audits = [];
  const lock = host.acquireRunLock({
    runDir: directory,
    attemptId: "attempt-1",
    operation: "dispatch",
    hostKind: "local_supervisor",
    hostHandle: "host-handle-1",
    processStartedAt: "2026-07-31T00:00:00.000Z",
    audit: (entry, capability) => {
      assert.equal(host.assertRunLockHeld(capability, directory), true);
      audits.push(entry);
    },
  });
  const publicOwner = host.readOwner(directory);
  assert.equal(publicOwner.owner.token, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(publicOwner, "raw"), false);
  assert.equal(host.assertRunLockHeld(lock, path.join(directory, "events.jsonl")), true);
  assert.throws(() => host.assertRunLockHeld({ ...lock }, directory), (error) => error.code === "LOCK_CAPABILITY_INVALID");
  assert.throws(
    () => host.assertRunLockHeld(lock, path.join(runDir("other"), "events.jsonl")),
    (error) => error.code === "LOCK_RUN_MISMATCH",
  );
  const ownerPath = host.lockPathFor(directory);
  const ownerBytes = fs.readFileSync(ownerPath);
  fs.unlinkSync(ownerPath);
  fs.writeFileSync(ownerPath, ownerBytes);
  assert.throws(() => host.assertRunLockHeld(lock, directory), (error) => error.code === "LOCK_INODE_MISMATCH");
  fs.unlinkSync(ownerPath);
  // The inode-tampered capability cannot safely release; use a fresh run for
  // the release/audit contract.
  const releaseDir = runDir("release");
  const releaseAudits = [];
  const releasable = host.acquireRunLock({
    runDir: releaseDir,
    attemptId: "attempt-2",
    operation: "dispatch",
    hostHandle: "host-handle-2",
    processStartedAt: "2026-07-31T00:00:01.000Z",
    audit: (entry) => releaseAudits.push(entry),
  });
  host.releaseRunLock(releasable, { audit: (entry, capability) => {
    assert.equal(host.assertRunLockHeld(capability, releaseDir), true);
    releaseAudits.push(entry);
  } });
  assert.deepEqual(releaseAudits.map((entry) => [entry.type, entry.attempt_id]), [
    ["lock_acquired", "attempt-2"],
    ["lock_released", "attempt-2"],
  ]);
  assert.equal(releaseAudits[1].payload.outcome, "released");
  assert.equal(audits[0].payload.host, os.hostname());
});

test("terminal decision precedes audit completion and an interrupted release resumes", () => {
  const directory = runDir("release-fault");
  const audit = [];
  const lock = host.acquireRunLock({
    runDir: directory,
    attemptId: "attempt-1",
    operation: "recover",
    hostHandle: "host-handle",
    processStartedAt: "2026-07-31T00:00:00.000Z",
  });
  assert.throws(() => host.releaseRunLock(lock, {
    audit: (entry) => audit.push(entry),
    fault: (point) => {
      if (point === "before_release_cleanup") {
        const error = new Error("injected cleanup failure");
        error.code = "EIO";
        throw error;
      }
    },
  }), (error) => error.code === "EIO");
  assert.deepEqual(audit.map((entry) => entry.type), ["lock_released"]);
  const ownership = path.join(directory, "ownership");
  assert.equal(fs.readdirSync(ownership).filter((name) => name.endsWith(".terminal.json")).length, 1);
  assert.equal(fs.readdirSync(ownership).filter((name) => name.endsWith(".terminal-audit.json")).length, 0);
  assert.throws(
    () => host.acquireRunLock({
      runDir: directory,
      attemptId: "attempt-2",
      operation: "recover",
      processStartedAt: "2026-07-31T00:00:01.000Z",
    }),
    (error) => error.code === "LOCK_HELD",
  );
  assert.equal(host.releaseRunLock(lock).released, true);
  assert.equal(fs.readdirSync(ownership).filter((name) => name.endsWith(".terminal-audit.json")).length, 1);
  const next = host.acquireRunLock({
    runDir: directory,
    attemptId: "attempt-2",
    operation: "recover",
    processStartedAt: "2026-07-31T00:00:01.000Z",
  });
  host.releaseRunLock(next);
});

test("a fresh process resumes an elected release after the issuing capability is lost", () => {
  const directory = runDir("release-process-resume");
  const auditPath = path.join(directory, "resume-audit.jsonl");
  const lock = host.acquireRunLock({
    runDir: directory,
    attemptId: "attempt-before-crash",
    operation: "recover",
    hostHandle: "host-before-crash",
    processStartedAt: "2026-07-31T00:00:00.000Z",
  });
  assert.throws(() => host.releaseRunLock(lock, {
    fault: (point) => {
      if (point === "after_release_audit") throw new Error("simulated process crash");
    },
  }), /simulated process crash/);
  const resumed = spawnSync(process.execPath, [RESUME_TERMINAL, directory, auditPath], {
    encoding: "utf8",
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).outcome, "released");
  const replayedAudit = JSON.parse(fs.readFileSync(auditPath, "utf8").trim());
  assert.equal(replayedAudit.type, "lock_released");
  assert.equal(replayedAudit.payload.outcome, "released");
  assert.equal(host.readOwner(directory).exists, false);
  const next = host.acquireRunLock({
    runDir: directory,
    attemptId: "attempt-after-resume",
    operation: "recover",
    processStartedAt: "2026-07-31T00:00:01.000Z",
  });
  host.releaseRunLock(next);
});

test("fresh release recovery cannot bypass a persisted required audit", () => {
  const directory = runDir("release-required-audit");
  const auditPath = path.join(directory, "required-resume-audit.jsonl");
  const lock = host.acquireRunLock({
    runDir: directory,
    attemptId: "required-audit",
    operation: "recover",
    processStartedAt: "2026-07-31T00:00:00.000Z",
  });
  assert.throws(() => host.releaseRunLock(lock, {
    audit: () => undefined,
    fault: (point) => {
      if (point === "after_release_audit") throw new Error("simulated process crash");
    },
  }), /simulated process crash/);
  const bypass = spawnSync(process.execPath, [RESUME_TERMINAL, directory], { encoding: "utf8" });
  assert.notEqual(bypass.status, 0);
  assert.match(bypass.stderr, /LOCK_AUDIT_REQUIRED/);
  assert.equal(host.readOwner(directory).exists, true);
  const resumed = spawnSync(process.execPath, [RESUME_TERMINAL, directory, auditPath], {
    encoding: "utf8",
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(host.readOwner(directory).exists, false);
});

test("concurrent fresh resumes coalesce an identical canonical audit event", async () => {
  const directory = runDir("concurrent-release-resume");
  const worktree = isolatedWorktree("concurrent-release-resume");
  initializeHostRun(directory, { worktreeDir: worktree });
  const barrierDir = fs.mkdtempSync(path.join(directory, "resume-barrier-"));
  const lock = host.acquireRunLock({
    runDir: directory,
    worktreeDir: worktree,
    attemptId: "concurrent-resume",
    operation: "recover",
    processStartedAt: "2026-07-31T00:00:00.000Z",
  });
  assert.throws(() => host.releaseRunLock(lock, {
    audit: () => undefined,
    fault: (point) => {
      if (point === "after_release_audit") throw new Error("simulated process crash");
    },
  }), /simulated process crash/);
  const contenders = Array.from({ length: 2 }, () => spawn(
    process.execPath,
    [RESUME_TERMINAL_CANONICAL, directory, barrierDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  ));
  await waitForReadyFiles(barrierDir, 2);
  fs.writeFileSync(path.join(barrierDir, "go"), "go\n", "utf8");
  const results = await waitForChildren(contenders);
  assert.equal(results.every((result) => result.status === 0), true, JSON.stringify(results));
  const journal = facts.readFacts({ eventsPath: path.join(directory, "events.jsonl") });
  assert.equal(journal.facts.filter((fact) => fact.type === "lock_released").length, 1);
  assert.equal(host.readOwner(directory).exists, false);
});

test("immutable owner generations are never reused, renamed, or deleted", () => {
  const directory = runDir("release-exclusion");
  const lock = host.acquireRunLock({
    runDir: directory,
    attemptId: "old-owner",
    operation: "dispatch",
    processStartedAt: "2026-07-31T00:00:00.000Z",
  });
  const firstPath = host.lockPathFor(directory);
  const firstBytes = fs.readFileSync(firstPath);
  const released = host.releaseRunLock(lock);
  assert.match(released.markerPath, /000000000001\.terminal\.json$/);
  assert.deepEqual(fs.readFileSync(firstPath), firstBytes);
  const fresh = host.acquireRunLock({
    runDir: directory,
    attemptId: "fresh-owner-after-release",
    operation: "dispatch",
    processStartedAt: "2026-07-31T00:00:01.000Z",
  });
  const secondPath = host.lockPathFor(directory);
  assert.notEqual(secondPath, firstPath);
  assert.match(firstPath, /000000000001\.owner\.json$/);
  assert.match(secondPath, /000000000002\.owner\.json$/);
  host.releaseRunLock(fresh);
});

test("an unauthenticated terminal marker cannot retire an active generation", () => {
  const directory = runDir("forged-terminal-marker");
  host.acquireRunLock({
    runDir: directory,
    attemptId: "active-owner",
    operation: "dispatch",
    processStartedAt: "2026-07-31T00:00:00.000Z",
  });
  const ownerPath = host.lockPathFor(directory);
  const markerPath = ownerPath.replace(/\.owner\.json$/, ".released.json");
  fs.writeFileSync(markerPath, `${JSON.stringify({
    generation: 1,
    lock_id: "forged",
    outcome: "released",
    marker_auth_sha256: "0".repeat(64),
  })}\n`, { mode: 0o600 });
  assert.throws(
    () => host.acquireRunLock({
      runDir: directory,
      attemptId: "forged-successor",
      operation: "dispatch",
      processStartedAt: "2026-07-31T00:00:00.000Z",
    }),
    (error) => error.code === "LOCK_LEDGER_INVALID",
  );
});

test("a second valid legacy terminal marker conflicts with the single terminal decision", () => {
  const directory = runDir("terminal-conflict");
  const lock = host.acquireRunLock({
    runDir: directory,
    attemptId: "terminal-owner",
    operation: "dispatch",
    processStartedAt: "2026-07-31T00:00:00.000Z",
  });
  const ownerPath = host.lockPathFor(directory);
  const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  host.releaseRunLock(lock);
  const unsigned = {
    generation: owner.generation,
    lock_id: owner.lock_id,
    attempt_id: owner.attempt_id,
    outcome: "broken",
    reason: "injected conflicting legacy marker",
    broken_at: new Date().toISOString(),
  };
  const resultKey = crypto.createHmac("sha256", owner.token)
    .update(`relay-host-result\0${owner.lock_id}\0${owner.attempt_id}`)
    .digest("hex");
  const marker = {
    ...unsigned,
    marker_auth_sha256: crypto.createHmac("sha256", resultKey)
      .update(JSON.stringify(unsigned))
      .digest("hex"),
  };
  fs.writeFileSync(
    ownerPath.replace(/\.owner\.json$/, ".broken.json"),
    `${JSON.stringify(marker)}\n`,
    { mode: 0o600 },
  );
  assert.throws(
    () => host.acquireRunLock({
      runDir: directory,
      attemptId: "must-not-advance",
      operation: "dispatch",
      processStartedAt: "2026-07-31T00:00:00.000Z",
    }),
    (error) => error.code === "LEDGER_TERMINAL_CONFLICT",
  );
});

test("stale break rejects bare evidence and requires exact terminal result, attempt, host, and worktree binding", () => {
  const directory = runDir("break");
  const worktree = isolatedWorktree("break");
  initializeHostRun(directory, { worktreeDir: worktree });
  const dead = spawnSync(process.execPath, [LOCK_AND_EXIT, directory, worktree], { encoding: "utf8" });
  assert.equal(dead.status, 0, dead.stderr);
  const lock = JSON.parse(dead.stdout);
  assert.equal(host.inspectOwnership({
    runDir: directory,
    worktreeFacts: {
      head_sha: "a".repeat(40),
      tree_sha: "b".repeat(40),
      reviewable_work: false,
      observed_at: new Date().toISOString(),
    },
  }).status, "unknown");
  const inspection = host.inspectOwnership({
    runDir: directory,
    worktreeFacts: host.observeWorktree({
      runDir: directory,
      worktreeDir: worktree,
    }),
  });
  assert.equal(inspection.status, "stale");
  assert.throws(
    () => host.breakStaleRunLock({ inspection, reason: "bare boolean", evidence: { host_terminal: true } }),
    (error) => error.code === "BREAK_EVIDENCE_INSUFFICIENT",
  );
  const resultPath = path.join(directory, "result.json");
  fs.writeFileSync(resultPath, JSON.stringify({
    lock_id: lock.lock_id,
    attempt_id: lock.attempt_id,
    host_kind: lock.host_kind,
    host_handle: lock.host_handle,
    status: "completed",
    result_auth_sha256: "0".repeat(64),
  }) + "\n");
  assert.throws(
    () => host.terminalResultProof(inspection, { resultPath }),
    (error) => error.code === "BREAK_EVIDENCE_INSUFFICIENT",
  );
  const first = host.captureLivenessProbe(inspection);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, host.MIN_BREAK_PROBE_INTERVAL_MS + 20);
  const second = host.captureLivenessProbe(inspection);
  assert.throws(() => host.breakStaleRunLock({
    inspection,
    reason: "two real dead-process probes prove owner completion",
    evidence: [first, second],
    audit: () => { throw new Error("injected break audit failure"); },
  }), (error) => error.break_retryable === true);
  assert.throws(
    () => host.acquireRunLock({
      runDir: directory,
      attemptId: "attempt-2",
      operation: "recover",
      processStartedAt: "2026-07-31T00:00:01.000Z",
    }),
    (error) => error.code === "LOCK_HELD",
  );
  const broken = host.breakStaleRunLock({
    inspection,
    reason: "two real dead-process probes prove owner completion",
    evidence: [first, second],
  });
  assert.equal(broken.released, true);
  assert.equal(host.readOwner(directory).exists, false);
});

test("acquisition audit failure closes its generation with an authenticated completion marker", () => {
  const directory = runDir("acquisition-audit-failure");
  assert.throws(() => host.acquireRunLock({
    runDir: directory,
    attemptId: "failed-acquisition",
    operation: "dispatch",
    processStartedAt: "2026-07-31T00:00:00.000Z",
    audit: () => { throw new Error("injected acquisition audit failure"); },
  }), (error) => error.code === "LOCK_AUDIT_FAILED");
  const ownership = path.join(directory, "ownership");
  assert.equal(fs.readdirSync(ownership).filter((name) => name.endsWith(".terminal.json")).length, 1);
  assert.equal(fs.readdirSync(ownership).filter((name) => name.endsWith(".terminal-audit.json")).length, 1);
  const next = host.acquireRunLock({
    runDir: directory,
    attemptId: "next-acquisition",
    operation: "dispatch",
    processStartedAt: "2026-07-31T00:00:01.000Z",
  });
  assert.equal(host.releaseRunLock(next).released, true);
});

test("authenticated terminal result recovers an unknown host identity without liveness proofs", { timeout: 30_000 }, async () => {
  const directory = runDir("unknown-terminal");
  const worktree = isolatedWorktree("unknown-terminal");
  initializeHostRun(directory, { worktreeDir: worktree });
  const audit = (entry, capability) => facts.appendFact({
    eventsPath: path.join(directory, "events.jsonl"),
    lockContext: capability,
    fact: facts.factFromHostAudit({
      runId: path.basename(directory),
      eventId: `host-${entry.audit_key}`,
      at: new Date().toISOString(),
      actor: "unknown-terminal-test",
      audit: entry,
    }),
  });
  const lock = host.acquireRunLock({
    runDir: directory,
    worktreeDir: worktree,
    attemptId: "unknown-terminal",
    operation: "dispatch",
    audit,
  });
  const receipt = host.launchLocalSupervisor({
    runDir: directory,
    attemptId: "unknown-terminal",
    lockContext: lock,
    command: "/usr/bin/true",
    timeoutMs: 10_000,
  });
  assert.equal((await host.waitForTerminalResult(receipt)).status, "completed");
  // Result publication precedes process exit by design. Inspecting immediately
  // raced the still-live supervisor and made this terminal-result recovery
  // test nondeterministic; prove actual bounded termination before inspection.
  await waitForSupervisorExit(receipt);
  const executor = JSON.parse(fs.readFileSync(receipt.executor_path, "utf8"));
  fs.writeFileSync(receipt.executor_path, `${JSON.stringify({
    ...executor,
    executor_nonce: "tampered",
  })}\n`);
  const inspection = host.inspectOwnership({
    runDir: directory,
    worktreeFacts: host.observeWorktree({ runDir: directory, worktreeDir: worktree }),
  });
  assert.equal(inspection.status, "unknown");
  const proof = host.terminalResultProof(inspection, { resultPath: receipt.result_path });
  const broken = host.breakStaleRunLock({
    inspection,
    reason: "signed terminal result proves completion despite unknown process identity",
    evidence: proof,
  });
  assert.equal(broken.released, true);
  assert.equal(fs.existsSync(host.lockPathFor(directory)), false);
});

test("attempt IDs and every configured path reject traversal, outside roots, and symlinks", () => {
  const directory = runDir("paths");
  const outside = runDir("outside");
  assert.throws(
    () => host.acquireRunLock({ runDir: directory, attemptId: "../escape", operation: "dispatch" }),
    (error) => error.code === "INVALID_ATTEMPT_ID",
  );
  assert.throws(
    () => host.launchLocalSupervisor({
      runDir: directory,
      attemptId: "safe",
      command: process.execPath,
      args: [],
      cwd: directory,
      resultPath: path.join(outside, "result.json"),
    }),
    (error) => error.code === "UNTRUSTED_PATH",
  );
  const link = path.join(directory, "result-link");
  fs.symlinkSync(path.join(outside, "result.json"), link);
  assert.throws(
    () => host.launchLocalSupervisor({
      runDir: directory,
      attemptId: "safe",
      command: process.execPath,
      args: [],
      cwd: directory,
      resultPath: link,
    }),
    (error) => error.code === "UNTRUSTED_PATH",
  );
  const linkedDirectory = path.join(directory, "linked");
  fs.symlinkSync(outside, linkedDirectory);
  assert.throws(
    () => host.launchLocalSupervisor({
      runDir: directory,
      attemptId: "nested-link",
      command: process.execPath,
      cwd: directory,
      resultPath: path.join(linkedDirectory, "result.json"),
    }),
    (error) => error.code === "UNTRUSTED_PATH",
  );
  const nested = path.join(directory, "nested");
  fs.mkdirSync(nested);
  assert.throws(
    () => host.launchLocalSupervisor({
      runDir: directory,
      attemptId: "nested-real",
      command: process.execPath,
      cwd: directory,
      resultPath: path.join(nested, "result.json"),
    }),
    (error) => error.code === "UNTRUSTED_PATH",
  );
});

test("host selection accepts only an internally issued 20-trial zero-loss measurement", () => {
  const directory = runDir("selection");
  assert.equal(host.selectHost({ runDir: directory, survivalMeasurement: { trials: 20, losses: 0 } }).blocker, "survival_gate_not_verified");
  const rows = Array.from({ length: 20 }, (_, index) => ({ trial: index + 1, launcher_exit: true, status: "completed" }));
  assert.throws(() => host.issueSurvivalMeasurement(rows), (error) => error.code === "SURVIVAL_GATE_FAILED");
  assert.equal(host.selectHost({ runDir: directory, requestedHostKind: "codex_app" }).recommended_action, "inspect");
});

test("host selection exposes detached-session capability without launchd registration", () => {
  const directory = runDir("detached-capability");
  const probe = host.probeHostEnvironment({ runDir: directory });
  assert.equal(probe.supported, process.platform !== "win32");
  if (process.platform !== "win32") {
    assert.equal(probe.launch_primitive, "detached_session");
  }
});

test("lock-bound supervisor rejects attempt, handle, and worktree identity drift", () => {
  const directory = runDir("bound-host");
  const worktree = isolatedWorktree("bound-host");
  const otherWorktree = isolatedWorktree("bound-host-other");
  const lock = host.acquireRunLock({
    runDir: directory,
    worktreeDir: worktree,
    attemptId: "bound-attempt",
    operation: "dispatch",
    hostKind: "local_supervisor",
    hostHandle: "dev.relay.host.bound.contract",
  });
  const base = {
    runDir: directory,
    lockContext: lock,
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
  };
  assert.throws(
    () => host.launchLocalSupervisor({ ...base, attemptId: "other-attempt" }),
    (error) => error.code === "HOST_LOCK_IDENTITY_MISMATCH",
  );
  assert.throws(
    () => host.launchLocalSupervisor({
      ...base,
      attemptId: "bound-attempt",
      hostHandle: "dev.relay.host.other",
    }),
    (error) => error.code === "HOST_LOCK_IDENTITY_MISMATCH",
  );
  assert.throws(
    () => host.launchLocalSupervisor({
      ...base,
      attemptId: "bound-attempt",
      trustedWorktreeRoot: otherWorktree,
      cwd: otherWorktree,
    }),
    (error) => error.code === "HOST_LOCK_IDENTITY_MISMATCH",
  );
  host.releaseRunLock(lock);
});

test("CLI diagnostics retain structured fail-closed host fields", () => {
  const error = new host.HostError("submit failed", "HOST_SUBMIT_FAILED", {
    recommended_action: "inspect",
    hostHandle: "fixture:host",
    primitive: "detached_session",
  });
  const text = host.__testing.cliErrorText(error);
  assert.match(text, /HOST_DIAGNOSTIC /);
  assert.match(text, /"primitive":"detached_session"/);
  assert.match(text, /"recommended_action":"inspect"/);
});
