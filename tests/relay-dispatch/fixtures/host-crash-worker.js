"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const facts = require("../../../skills/relay-dispatch/scripts/facts");
const host = require("../../../skills/relay-dispatch/scripts/host");

const [rawRunDir, point, rawWorktreeRoot] = process.argv.slice(2);
if (!rawRunDir || !point) process.exit(2);

const runDir = fs.realpathSync(rawRunDir);
const runId = path.basename(runDir);
const attemptId = "crash-attempt";
const eventsPath = path.join(runDir, "events.jsonl");
const resultPath = path.join(runDir, "attempt-crash-attempt.result.json");
const markerPath = path.join(runDir, "worker-invocations.log");
const publicationPath = path.join(runDir, "publication.json");
const worker = path.join(__dirname, "host-worker.js");
const publisher = path.join(__dirname, "host-publisher.js");
const worktreeRoot = fs.realpathSync(rawWorktreeRoot || path.resolve(__dirname, "..", "..", ".."));
const sha = "1".repeat(40);
let eventSequence = 0;
const checkpointPath = path.join(runDir, "crash-checkpoints.log");

function eventId(type) {
  eventSequence += 1;
  return `${runId}-${type}-${eventSequence}`;
}

function append(lockContext, type, payload) {
  facts.appendFact({
    eventsPath,
    lockContext,
    fact: {
      event_id: eventId(type),
      run_id: runId,
      attempt_id: attemptId,
      type,
      at: new Date().toISOString(),
      actor: "crash-worker",
      payload,
    },
  });
}

function checkpoint(name) {
  const fd = fs.openSync(checkpointPath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600);
  fs.writeSync(fd, `${name}\n`);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

function crash(name) {
  checkpoint(name);
  if (point === name) process.exit(86);
}

const hostHandle = `dev.relay.crash.${process.pid}.${point.replaceAll("_", ".")}`;
const lock = host.acquireRunLock({
  runDir,
  attemptId,
  operation: "dispatch",
  hostKind: "local_supervisor",
  hostHandle,
  worktreeDir: worktreeRoot,
  audit(audit, capability) {
    const durableEventId = `host-${audit.audit_key}`;
    facts.appendFact({
      eventsPath,
      lockContext: capability,
      fact: facts.factFromHostAudit({
        runId,
        eventId: durableEventId,
        at: new Date().toISOString(),
        actor: "crash-worker",
        audit,
      }),
    });
  },
});

crash("after_lock_audit");
append(lock, "attempt_started", {
  executor: "fixture",
  model: null,
  start_sha: sha,
  host_kind: "local_supervisor",
  host_handle: hostHandle,
  stdout_path: path.join(runDir, "attempt-crash-attempt.stdout.log"),
  stderr_path: path.join(runDir, "attempt-crash-attempt.stderr.log"),
  result_path: resultPath,
  timeout_ms: 10_000,
});
crash("after_attempt_started");
crash("before_spawn");

const receipt = host.launchLocalSupervisor({
  runDir,
  attemptId,
  lockContext: lock,
  hostHandle,
  command: process.execPath,
  args: [worker, markerPath, "80"],
  trustedWorktreeRoot: worktreeRoot,
  cwd: worktreeRoot,
  resultPath,
  timeoutMs: 10_000,
});
crash("after_spawn");

const waitForStarted = setInterval(() => {
  if (!fs.existsSync(markerPath) || !fs.readFileSync(markerPath, "utf8").includes("started:")) return;
  clearInterval(waitForStarted);
  crash("before_result");
  host.waitForTerminalResult(receipt).then((result) => {
  crash("after_result");
  crash("before_attempt_finished");
  append(lock, "attempt_finished", {
    status: result.status === "completed" ? "completed" : "failed",
    start_sha: sha,
    final_sha: sha,
    tree_sha: sha,
    result_path: resultPath,
    exit_code: result.exit_code ?? 1,
    verification_status: result.status === "completed" ? "passed" : "failed",
  });
  crash("after_attempt_finished");
  crash("before_publication");
  execFileSync(process.execPath, [publisher, publicationPath], { stdio: "ignore" });
  crash("after_publication");
  process.exit(87);
  }).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(3);
  });
}, 10);
