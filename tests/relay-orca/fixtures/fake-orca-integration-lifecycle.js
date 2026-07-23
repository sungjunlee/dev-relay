"use strict";

// Stateful, hermetic Orca fixture for #1019. It intentionally models only the
// authoritative mid-2026 integration lifecycle shapes. Any unsupported or unsafe
// command poisons the fixture so a test cannot pass through an accidental fallback.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_RUNTIME_ID = "runtime-integration-fixture";

function defaultScenario(overrides = {}) {
  return {
    runtimeId: overrides.runtimeId || DEFAULT_RUNTIME_ID,
    coordinator: overrides.coordinator || "coord-current",
    liveTerminals: overrides.liveTerminals !== undefined ? overrides.liveTerminals : [overrides.coordinator || "coord-current"],
    terminalListOk: overrides.terminalListOk !== undefined ? overrides.terminalListOk : true,
    terminalListMalformed: overrides.terminalListMalformed === true,
    structuredCoordinator: overrides.structuredCoordinator,
    preamble: overrides.preamble,
    tasks: overrides.tasks || [],
    dispatch: overrides.dispatch || {},
    gates: overrides.gates || [],
    createResponseLoss: overrides.createResponseLoss === true,
    createFailure: overrides.createFailure === true,
    taskListAfterWorkerDone: overrides.taskListAfterWorkerDone || "completed",
  };
}

function script({ scenarioPath, logPath, statePath, poisonPath, sendPath }) {
  return `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
const scenarioPath = ${JSON.stringify(scenarioPath)};
const logPath = ${JSON.stringify(logPath)};
const statePath = ${JSON.stringify(statePath)};
const poisonPath = ${JSON.stringify(poisonPath)};
const sendPath = ${JSON.stringify(sendPath)};
function readState() { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
function writeState(value) { fs.writeFileSync(statePath, JSON.stringify(value, null, 2), "utf8"); }
function log() { fs.appendFileSync(logPath, JSON.stringify(args) + "\\n", "utf8"); }
function poison(reason) { fs.writeFileSync(poisonPath, reason + ":" + args.join(" "), "utf8"); process.exit(99); }
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
function has(flag) { return args.includes(flag); }
function emit(body, code = 0) {
  if (body !== null && body && typeof body === "object" && !body._meta) body._meta = { runtimeId: readState().runtimeId };
  if (body !== null) process.stdout.write(JSON.stringify(body));
  process.exit(code);
}
function envelope(result) { return { ok: true, result, _meta: { runtimeId: readState().runtimeId } }; }
function taskFor(state, taskId) {
  return state.tasks.find((task) => task.id === taskId) || null;
}
function gateTaskId(gate) { return gate.task_id || gate.task || null; }
function gateOptions(gate) { return Array.isArray(gate.options) ? gate.options : []; }
function validateSend() {
  const valueFlags = new Set(["--to", "--subject", "--from", "--body", "--type", "--task-id", "--dispatch-id", "--report-path", "--phase"]);
  const boolFlags = new Set(["--json"]);
  for (let i = 2; i < args.length; i += 1) {
    const token = args[i];
    if (valueFlags.has(token)) {
      if (i + 1 >= args.length) emit({ ok: false, error: token + " requires a value" }, 2);
      i += 1;
    } else if (!boolFlags.has(token)) {
      emit({ ok: false, error: "orchestration send does not accept " + token }, 2);
    }
  }
  const required = ["--to", "--subject", "--type", "--task-id", "--dispatch-id", "--report-path", "--phase"];
  required.forEach((flag) => { if (!has(flag)) emit({ ok: false, error: "missing " + flag }, 2); });
}

log();
if (has("reset")) poison("RESET_INVOKED");
if (has("worktree")) poison("WORKTREE_INVOKED");
if (has("task-update")) poison("TASK_UPDATE_INVOKED");
const state = readState();

if (args[0] === "status" && args[1] === "--json") {
  const result = { app: { running: true, pid: 1 }, runtime: { runtimeId: state.runtimeId }, graph: { state: "ready" } };
  if (state.structuredCoordinator !== undefined) result.coordinator_handle = state.structuredCoordinator;
  emit(envelope(result));
}
if (args[0] === "terminal" && args[1] === "list" && has("--json")) {
  if (!state.terminalListOk) emit({ ok: false, error: "terminal list failed" }, 1);
  if (state.terminalListMalformed) emit(envelope({ count: 0 }));
  const terminals = (Array.isArray(state.liveTerminals) ? state.liveTerminals : []).map((terminal) => (
    typeof terminal === "string" ? { handle: terminal, id: terminal, status: "running" } : terminal
  ));
  emit(envelope({ terminals, count: terminals.length }));
}
if (args[0] === "orchestration" && args[1] === "task-list") {
  emit(envelope({ tasks: state.tasks }));
}
if (args[0] === "orchestration" && args[1] === "dispatch-show") {
  if (!has("--task") || !has("--json")) emit({ ok: false, error: "dispatch-show requires --task and --json" }, 2);
  const taskId = value("--task");
  const dispatch = state.dispatch[taskId] || {};
  if (has("--from") && value("--from") !== dispatch.assignee) emit({ ok: false, error: "dispatch-show stale --from" }, 3);
  const dispatchRow = {
    id: dispatch.dispatch_id,
    task_id: taskId,
    assignee_handle: dispatch.assignee,
    status: dispatch.status || "dispatched",
    failure_count: dispatch.failure_count || 0,
    last_failure: dispatch.last_failure || null,
    dispatched_at: dispatch.dispatched_at || null,
    completed_at: dispatch.completed_at || null,
    created_at: dispatch.created_at || null,
    last_heartbeat_at: dispatch.last_heartbeat_at || null,
    assignee_pane_key: dispatch.assignee_pane_key || dispatch.assignee,
  };
  const result = {
    dispatch: dispatchRow,
    // Real Orca injects the assignee into this text when dispatch-show is called with --from
    // <assignee>. It is deliberately not coordinator identity authority.
    preamble: state.preamble !== undefined ? String(state.preamble) : "Coordinator: " + value("--from"),
  };
  if (dispatch.terminal_present !== undefined) result.terminal_present = dispatch.terminal_present;
  if (state.structuredCoordinator !== undefined) result.coordinator_handle = state.structuredCoordinator;
  emit(envelope(result));
}
if (args[0] === "orchestration" && args[1] === "gate-list") {
  if (!has("--task") || !has("--json")) emit({ ok: false, error: "gate-list requires --task and --json" }, 2);
  const taskId = value("--task");
  emit(envelope({ gates: state.gates.filter((gate) => gateTaskId(gate) === taskId), count: state.gates.filter((gate) => gateTaskId(gate) === taskId).length }));
}
if (args[0] === "orchestration" && args[1] === "gate-create") {
  if (!has("--task") || !has("--question") || !has("--options") || !has("--json")) emit({ ok: false, error: "gate-create shape rejected" }, 2);
  const gate = { id: "physical-gate-" + (state.gates.length + 1), task_id: value("--task"), question: value("--question"), options: JSON.parse(value("--options")), status: "pending" };
  if (!state.createFailure) state.gates.push(gate);
  writeState(state);
  if (state.createFailure) emit({ ok: false, error: "gate-create failed" }, 1);
  if (state.createResponseLoss) emit(null, 1);
  emit(envelope({ gate }));
}
if (args[0] === "orchestration" && args[1] === "gate-resolve") {
  if (!has("--id") || !has("--resolution") || !has("--json")) emit({ ok: false, error: "gate-resolve shape rejected" }, 2);
  const gate = state.gates.find((candidate) => candidate.id === value("--id"));
  if (!gate) emit({ ok: false, error: "gate not found" }, 1);
  gate.status = "resolved";
  gate.resolution = value("--resolution");
  writeState(state);
  emit(envelope({ gate }));
}
if (args[0] === "orchestration" && args[1] === "send") {
  validateSend();
  const type = value("--type");
  fs.appendFileSync(sendPath, JSON.stringify(args) + "\\n", "utf8");
  if (type === "worker_done") {
    const taskId = value("--task-id");
    const dispatch = state.dispatch[taskId] || {};
    if (value("--from") !== dispatch.assignee || value("--to") !== state.coordinator) emit({ ok: false, error: "worker_done provenance rejected" }, 3);
    if (value("--dispatch-id") !== dispatch.dispatch_id) emit({ ok: false, error: "worker_done dispatch rejected" }, 3);
    const task = taskFor(state, taskId);
    if (task) { task.status = state.taskListAfterWorkerDone; task.worker_done = true; }
    writeState(state);
  }
  emit(envelope({ delivered: true, type }));
}
process.stderr.write("Unsupported integration fixture invocation: " + args.join(" ") + "\\n");
process.exit(2);
`;
}

function installFakeOrcaIntegrationLifecycle(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-integration-lifecycle-"));
  const scenarioPath = path.join(dir, "scenario.json");
  const statePath = path.join(dir, "state.json");
  const orcaPath = path.join(dir, "orca");
  const logPath = path.join(dir, "invocations.jsonl");
  const sendPath = path.join(dir, "sends.jsonl");
  const poisonPath = path.join(dir, "poison.txt");
  const state = defaultScenario(overrides);
  fs.writeFileSync(scenarioPath, JSON.stringify(state), "utf8");
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
  fs.writeFileSync(orcaPath, script({ scenarioPath, statePath, logPath, poisonPath, sendPath }), "utf8");
  fs.chmodSync(orcaPath, 0o755);
  return {
    dir,
    orcaPath,
    statePath,
    logPath,
    sendPath,
    poisonPath,
    run(args) {
      const { execFileSync } = require("node:child_process");
      try {
        return { status: 0, stdout: execFileSync(orcaPath, args, { encoding: "utf8", stdio: "pipe" }), stderr: "" };
      } catch (error) {
        return { status: error.status || 1, stdout: error.stdout ? String(error.stdout) : "", stderr: error.stderr ? String(error.stderr) : "" };
      }
    },
    readState() { return JSON.parse(fs.readFileSync(statePath, "utf8")); },
    readLog() { return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []; },
    readSends() { return fs.existsSync(sendPath) ? fs.readFileSync(sendPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []; },
    readPoison() { return fs.existsSync(poisonPath) ? fs.readFileSync(poisonPath, "utf8") : null; },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

module.exports = { DEFAULT_RUNTIME_ID, installFakeOrcaIntegrationLifecycle };
