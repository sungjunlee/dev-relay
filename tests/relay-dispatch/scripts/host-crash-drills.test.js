"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const facts = require("../../../skills/relay-dispatch/scripts/facts");
const host = require("../../../skills/relay-dispatch/scripts/host");
const { initializeHostRun } = require("../fixtures/host-run-fixture");
const CRASH_WORKER = path.join(__dirname, "..", "fixtures", "host-crash-worker.js");
const HOST_WORKER = path.join(__dirname, "..", "fixtures", "host-worker.js");
const PUBLISHER = path.join(__dirname, "..", "fixtures", "host-publisher.js");
const CRASH_POINTS = [
  "after_lock_audit",
  "after_attempt_started",
  "before_spawn",
  "after_spawn",
  "before_result",
  "after_result",
  "before_attempt_finished",
  "after_attempt_finished",
  "before_publication",
  "after_publication",
];
const SHA = "1".repeat(40);

function waitFor(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      if (fs.existsSync(filePath)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(poll, 10);
    };
    poll();
  });
}

function read(runDir) {
  return facts.readFacts({ eventsPath: path.join(runDir, "events.jsonl") }).facts;
}

function append(runDir, lockContext, fact) {
  return facts.appendFact({
    eventsPath: path.join(runDir, "events.jsonl"),
    lockContext,
    fact,
  });
}

function makeFact(runDir, type, payload, attemptId) {
  const fact = {
    event_id: crypto.randomUUID(),
    run_id: path.basename(runDir),
    type,
    at: new Date().toISOString(),
    actor: "crash-recovery",
    payload,
  };
  if (facts.ATTEMPT_TYPES.has(type)) fact.attempt_id = attemptId;
  return fact;
}

function auditAppender(runDir) {
  return (audit, capability) => {
    const eventId = `host-${audit.audit_key}`;
    if (!read(runDir).some((fact) => fact.event_id === eventId)) {
      append(runDir, capability, facts.factFromHostAudit({
        runId: path.basename(runDir),
        eventId,
        at: new Date().toISOString(),
        actor: "crash-recovery",
        audit,
      }));
    }
    return { durable: true, audit_key: audit.audit_key };
  };
}

async function reclaim(runDir, worktreeRoot) {
  const resultPath = path.join(runDir, "attempt-crash-attempt.result.json");
  const configPath = path.join(runDir, "host-attempt-crash-attempt.json");
  if (fs.existsSync(configPath)) {
    assert.equal(await waitFor(resultPath), true, `${path.basename(runDir)} terminal result`);
  }
  const inspection = host.inspectOwnership({
    runDir,
    eventsPath: path.join(runDir, "events.jsonl"),
    worktreeFacts: host.observeWorktree({
      runDir,
      worktreeDir: worktreeRoot,
    }),
  });
  assert.equal(inspection.status, "stale", path.basename(runDir));
  let evidence;
  if (fs.existsSync(configPath)) {
    evidence = host.terminalResultProof(inspection, { resultPath });
  } else {
    const first = host.captureLivenessProbe(inspection);
    await new Promise((resolve) => setTimeout(resolve, host.MIN_BREAK_PROBE_INTERVAL_MS));
    const second = host.captureLivenessProbe(inspection);
    evidence = [first, second];
  }
  host.breakStaleRunLock({
    inspection,
    reason: "crash drill owner is terminal",
    evidence,
    audit: auditAppender(runDir),
  });
}

async function recoverOnce(runDir, worktreeRoot) {
  const existing = read(runDir);
  if (existing.some((fact) => fact.type === "run_closed")) return;
  const recoveryAttempt = "recovery-attempt";
  const resultPath = path.join(runDir, "attempt-crash-attempt.result.json");
  const markerPath = path.join(runDir, "worker-invocations.log");
  const publicationPath = path.join(runDir, "publication.json");
  const lock = host.acquireRunLock({
    runDir,
    attemptId: recoveryAttempt,
    operation: "recover",
    worktreeDir: worktreeRoot,
    audit: auditAppender(runDir),
  });
  try {
    let current = read(runDir);
    let terminal = current.find((fact) => fact.type === "attempt_finished" && fact.attempt_id === "crash-attempt");
    if (!terminal && fs.existsSync(resultPath)) {
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      append(runDir, lock, makeFact(runDir, "attempt_finished", {
        status: result.status === "completed" ? "completed" : "failed",
        start_sha: SHA,
        final_sha: SHA,
        tree_sha: SHA,
        result_path: resultPath,
        exit_code: result.exit_code ?? 1,
        verification_status: result.status === "completed" ? "passed" : "failed",
      }, "crash-attempt"));
      terminal = true;
    }
    if (!terminal) {
      append(runDir, lock, makeFact(runDir, "attempt_interrupted", {
        last_known_sha: SHA,
        reason: "launcher_crashed_before_spawn",
        host_liveness: "dead",
        reviewable_work: false,
      }, "crash-attempt"));
      const recoveryResult = path.join(runDir, "attempt-recovery-attempt.result.json");
      const hostHandle = lock.host_handle;
      append(runDir, lock, makeFact(runDir, "attempt_started", {
        executor: "fixture",
        model: null,
        start_sha: SHA,
        host_kind: "local_supervisor",
        host_handle: hostHandle,
        stdout_path: path.join(runDir, "attempt-recovery-attempt.stdout.log"),
        stderr_path: path.join(runDir, "attempt-recovery-attempt.stderr.log"),
        result_path: recoveryResult,
        timeout_ms: 10_000,
      }, recoveryAttempt));
      const receipt = host.launchLocalSupervisor({
        runDir,
        attemptId: recoveryAttempt,
        lockContext: lock,
        command: process.execPath,
        args: [HOST_WORKER, markerPath, "20"],
        trustedWorktreeRoot: worktreeRoot,
        cwd: worktreeRoot,
        resultPath: recoveryResult,
        timeoutMs: 10_000,
      });
      const result = await host.waitForTerminalResult(receipt);
      append(runDir, lock, makeFact(runDir, "attempt_finished", {
        status: result.status === "completed" ? "completed" : "failed",
        start_sha: SHA,
        final_sha: SHA,
        tree_sha: SHA,
        result_path: recoveryResult,
        exit_code: result.exit_code ?? 1,
        verification_status: result.status === "completed" ? "passed" : "failed",
      }, recoveryAttempt));
    }
    current = read(runDir);
    if (!fs.existsSync(publicationPath)) {
      execFileSync(process.execPath, [PUBLISHER, publicationPath], { stdio: "ignore" });
    }
    if (!current.some((fact) => fact.type === "pull_request_recorded")) {
      const publication = JSON.parse(fs.readFileSync(publicationPath, "utf8"));
      append(runDir, lock, makeFact(runDir, "pull_request_recorded", publication));
    }
    if (!read(runDir).some((fact) => fact.type === "run_closed")) {
      append(runDir, lock, makeFact(runDir, "run_closed", {
        reason: "crash_drill_complete",
        operator: "test",
        last_sha: SHA,
        pr_number: 901,
      }));
    }
  } finally {
    host.releaseRunLock(lock, { audit: auditAppender(runDir) });
  }
}

test("ten real crash points recover with canonical facts, one execution, one publication, and terminal monotonicity", { timeout: 600_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-vnext-host-crash-")));
  const worktreeRoot = path.join(root, "worktree");
  fs.mkdirSync(worktreeRoot);
  fs.writeFileSync(path.join(worktreeRoot, "README.md"), "crash fixture\n", "utf8");
  for (const args of [
    ["init", "-q"],
    ["add", "README.md"],
    ["-c", "user.name=Relay Test", "-c", "user.email=relay@example.invalid", "commit", "-qm", "fixture"],
  ]) {
    const git = spawnSync("git", ["-C", worktreeRoot, ...args], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  const runDirs = CRASH_POINTS.map((point) => {
    const runDir = path.join(root, point);
    fs.mkdirSync(runDir);
    initializeHostRun(runDir, { worktreeDir: worktreeRoot });
    return runDir;
  });
  const inject = (point) => {
    const runDir = path.join(root, point);
    const crashed = spawnSync(process.execPath, [CRASH_WORKER, runDir, point, worktreeRoot], { encoding: "utf8" });
    assert.equal(crashed.status, 86, `${point}: ${crashed.stderr}`);
    const checkpoints = fs.readFileSync(path.join(runDir, "crash-checkpoints.log"), "utf8").trim().split("\n");
    assert.equal(checkpoints.at(-1), point);
    return runDir;
  };

  const earlyReclaims = CRASH_POINTS.slice(0, 3).map((point) => reclaim(inject(point), worktreeRoot));
  for (const point of CRASH_POINTS.slice(3)) {
    await reclaim(inject(point), worktreeRoot);
  }
  await Promise.all(earlyReclaims);
  for (const runDir of runDirs) {
    await recoverOnce(runDir, worktreeRoot);
    const before = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8");
    await recoverOnce(runDir, worktreeRoot);
    assert.equal(fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8"), before);
    const journal = read(runDir);
    assert.equal(journal.filter((fact) => fact.type === "pull_request_recorded").length, 1);
    assert.equal(journal.filter((fact) => fact.type === "run_closed").length, 1);
    assert.equal(
      fs.readFileSync(path.join(runDir, "worker-invocations.log"), "utf8").trim().split("\n").filter((line) => line.startsWith("completed:")).length,
      1,
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "publication.json"), "utf8")).pr_number, 901);
    const closedIndex = journal.findIndex((fact) => fact.type === "run_closed");
    assert.equal(journal.slice(closedIndex + 1).every((fact) => fact.type === "lock_released"), true);
  }
});
