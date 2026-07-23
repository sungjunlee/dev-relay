"use strict";

/**
 * Resume-capable fake Orca CLI fixture for relay-orca `resume` tests (#946).
 *
 * A SUPERSET of the read-only status fake and the run fake's mutation surface: it serves
 * the reconciliation reads `resume` runs FIRST (`status`, `orchestration task-list`,
 * `orchestration gate-list`, `orchestration dispatch-show`) AND the restoration mutations
 * `resume` may run AFTER reconciliation (`orchestration dispatch --inject`,
 * `terminal create`, `terminal send`). Behavior is scenario-driven; every invocation is
 * appended to a shared log.
 *
 * Poison set (D7): ONLY `orca orchestration reset` and any `orca worktree` subcommand are
 * poisoned — resume MAY use dispatch/terminal, so those are NOT poisoned here. A poisoned
 * surface writes a marker and exits non-zero so the test hard-fails on EVERY path.
 *
 * Dispatch provenance is stateful: a real `dispatch --inject` writes a per-task state
 * file, and a following `dispatch-show` returns that FRESH dispatch (terminal present)
 * — this is what makes a second resume idempotent (the re-established mapping now reads
 * back as live). The scenario's initial per-task `dispatch` overrides seed the pre-resume
 * state (e.g. a lost terminal) and are superseded by a real dispatch's state file.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_RUNTIME_ID } = require("./fake-orca");

function defaultResumeScenario(overrides = {}) {
  const runtimeId = overrides.runtimeId || DEFAULT_RUNTIME_ID;
  return {
    runtimeId,
    statusOk: overrides.statusOk !== undefined ? overrides.statusOk : true,
    taskListOk: overrides.taskListOk !== undefined ? overrides.taskListOk : true,
    taskListMalformed: overrides.taskListMalformed === true,
    gateListOk: overrides.gateListOk !== undefined ? overrides.gateListOk : true,
    omitRuntimeId: overrides.omitRuntimeId === true,
    taskListRuntimeId: overrides.taskListRuntimeId,
    gateListRuntimeId: overrides.gateListRuntimeId,
    tasks: overrides.tasks || [],
    gates: overrides.gates || [],
    // Per-task dispatch-show seed (pre-resume state): { terminal_present, assignee,
    // dispatch_id, runtimeId }. A real dispatch supersedes it for that task.
    dispatch: overrides.dispatch || {},
    liveTerminals: overrides.liveTerminals !== undefined
      ? overrides.liveTerminals
      : (overrides.coordinator !== undefined ? [overrides.coordinator] : []),
    terminalListOk: overrides.terminalListOk !== undefined ? overrides.terminalListOk : true,
    terminalListMalformed: overrides.terminalListMalformed === true,
    structuredCoordinator: overrides.structuredCoordinator,
    preamble: overrides.preamble,
    // Execution knobs (fail-closed / optional): an orca task id whose `dispatch --inject`
    // returns ok:false, and terminal-create failure modes.
    dispatchFailFor: overrides.dispatchFailFor || null,
    // D5.4: handles with no recognized agent — `dispatch --inject` to one hard-fails with
    // the real "no recognized agent detected" error. Empty by default.
    injectNonAgentHandles: Array.isArray(overrides.injectNonAgentHandles) ? overrides.injectNonAgentHandles : [],
    terminalCreateOkFalse: overrides.terminalCreateOkFalse || false,
    terminalCreateEmptyHandle: overrides.terminalCreateEmptyHandle || false,
    terminalSendOkFalse: overrides.terminalSendOkFalse || false,
    // #1019: the coordinator handle is verified by the live terminal list. UNDEFINED by
    // default keeps non-integration scenarios free of coordinator-specific fixture state.
    coordinator: overrides.coordinator,
  };
}

function fakeOrcaResumeScript({ scenarioPath, logPath, poisonPath, stateDir }) {
  return `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const scenarioPath = ${JSON.stringify(scenarioPath)};
const logPath = ${JSON.stringify(logPath)};
const poisonPath = ${JSON.stringify(poisonPath)};
const stateDir = ${JSON.stringify(stateDir)};

function appendLog(line) { if (logPath) fs.appendFileSync(logPath, line + "\\n", "utf-8"); }
appendLog(args.join(" "));
// The real dispatch-show payload nests provenance under result.dispatch (D4.3/D5.2).
function nestDispatch(flat, structuredCoordinator, preamble) {
  const dispatch = {
    id: flat.dispatch_id,
    task_id: flat.task_id,
    assignee_handle: flat.assignee,
    status: flat.status || "dispatched",
    failure_count: flat.failure_count || 0,
    last_failure: flat.last_failure || null,
    dispatched_at: flat.dispatched_at || null,
    completed_at: flat.completed_at || null,
    created_at: flat.created_at || null,
    last_heartbeat_at: flat.last_heartbeat_at || null,
    assignee_pane_key: flat.assignee_pane_key || flat.assignee,
  };
  const result = { dispatch: dispatch };
  if (flat.terminal_present !== undefined) result.terminal_present = flat.terminal_present;
  // The real --preamble read is a string and, with --from <assignee>, can name the assignee
  // as coordinator. It is corroboration only; structuredCoordinator is the optional feature
  // detection variant used by dedicated lifecycle tests.
  result.preamble = preamble !== undefined ? String(preamble) : "Coordinator: " + flat.assignee;
  if (structuredCoordinator !== undefined) result.coordinator_handle = structuredCoordinator;
  return result;
}
function loadScenario() { return JSON.parse(fs.readFileSync(scenarioPath, "utf-8")); }
function emit(payload, exitCode) { if (payload !== undefined && payload !== null) process.stdout.write(JSON.stringify(payload)); process.exit(typeof exitCode === "number" ? exitCode : 0); }
function argValue(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }
function stateFile(taskId) { return path.join(stateDir, "disp-" + String(taskId).replace(/[^a-zA-Z0-9._-]/g, "_") + ".json"); }
function poison(marker, code) { if (poisonPath) fs.writeFileSync(poisonPath, marker + ":" + args.join(" "), "utf-8"); process.stderr.write("POISON: " + marker + "\\n"); process.exit(code); }

// D7 poison: reset + worktree only (resume MAY dispatch/terminal). Active on every path.
// #1019 adds task-update: the integration lifecycle must reach completion through the
// operator's explicit worker_done, never a coordinator-side task status write.
if (args.includes("reset")) poison("RESET_INVOKED", 99);
if (args.includes("worktree")) poison("WORKTREE_INVOKED", 98);
if (args.includes("task-update")) poison("TASK_UPDATE_INVOKED", 97);

const scenario = loadScenario();
const meta = { runtimeId: scenario.runtimeId };
const gatesFile = path.join(stateDir, "gates.json");
function loadGates() {
  try { return JSON.parse(fs.readFileSync(gatesFile, "utf-8")); } catch (e) { return Array.isArray(scenario.gates) ? scenario.gates : []; }
}
function saveGates(gates) { try { fs.writeFileSync(gatesFile, JSON.stringify(gates), "utf-8"); } catch (e) { /* ignore */ } }

if (args[0] === "status") {
  if (!scenario.statusOk) { process.stderr.write("orca status unreachable\\n"); process.exit(1); }
  const runtime = { state: "ready", reachable: true };
  if (!scenario.omitRuntimeId) runtime.runtimeId = scenario.runtimeId;
  const statusMeta = scenario.omitRuntimeId ? {} : meta;
  const statusResult = { app: { running: true, pid: 1 }, runtime, graph: { state: "ready" } };
  if (scenario.structuredCoordinator !== undefined) statusResult.coordinator_handle = scenario.structuredCoordinator;
  emit({ id: "status-1", ok: true, result: statusResult, _meta: statusMeta }, 0);
}
if (args[0] === "terminal" && args[1] === "list") {
  if (!scenario.terminalListOk) { process.stderr.write("orca terminal list unreachable\\n"); process.exit(1); }
  if (scenario.terminalListMalformed) emit({ id: "terminal-list-1", ok: true, result: { count: 0 }, _meta: meta }, 0);
  const terminals = (Array.isArray(scenario.liveTerminals) ? scenario.liveTerminals : []).map((terminal) => (
    typeof terminal === "string" ? { handle: terminal, id: terminal, status: "running" } : terminal
  ));
  emit({ id: "terminal-list-1", ok: true, result: { terminals, count: terminals.length }, _meta: meta }, 0);
}
if (args[0] === "orchestration" && args[1] === "task-list") {
  if (scenario.taskListOk === false) { process.stderr.write("orca task-list unreachable\\n"); process.exit(1); }
  const tasks = Array.isArray(scenario.tasks) ? scenario.tasks : [];
  const taskMeta = scenario.taskListRuntimeId !== undefined ? { runtimeId: scenario.taskListRuntimeId } : meta;
  const taskResult = scenario.taskListMalformed ? { count: tasks.length } : { tasks, count: tasks.length };
  emit({ id: "task-list-1", ok: true, result: taskResult, _meta: taskMeta }, 0);
}
if (args[0] === "orchestration" && args[1] === "gate-list") {
  if (scenario.gateListOk === false) { process.stderr.write("orca gate-list unreachable\\n"); process.exit(1); }
  const all = loadGates();
  // The real CLI scopes to --task when given; unscoped reconciliation reads see every gate.
  const task = argValue("--task");
  const gates = task === undefined ? all : all.filter((g) => (g.task_id || g.task) === task);
  const gateMeta = scenario.gateListRuntimeId !== undefined ? { runtimeId: scenario.gateListRuntimeId } : meta;
  emit({ id: "gate-list-1", ok: true, result: { gates, count: gates.length }, _meta: gateMeta }, 0);
}
if (args[0] === "orchestration" && args[1] === "gate-create") {
  if (!args.includes("--task") || !args.includes("--question") || !args.includes("--options") || !args.includes("--json")) {
    emit({ ok: false, error: "gate-create shape rejected" }, 2);
  }
  const gates = loadGates();
  const gate = { id: "physical-gate-" + (gates.length + 1), task_id: argValue("--task"), question: argValue("--question"), options: JSON.parse(argValue("--options")), status: "pending" };
  gates.push(gate);
  saveGates(gates);
  emit({ id: "gc-1", ok: true, result: { gate }, _meta: meta }, 0);
}
if (args[0] === "orchestration" && args[1] === "gate-resolve") {
  if (!args.includes("--id") || !args.includes("--resolution") || !args.includes("--json")) {
    emit({ ok: false, error: "gate-resolve shape rejected" }, 2);
  }
  const gates = loadGates();
  const gate = gates.find((g) => g.id === argValue("--id"));
  if (!gate) emit({ ok: false, error: "gate not found" }, 1);
  gate.status = "resolved";
  gate.resolution = argValue("--resolution");
  saveGates(gates);
  emit({ id: "gr-1", ok: true, result: { gate }, _meta: meta }, 0);
}
// #1019 orchestration send: validated against the authoritative explicit-flag shape. Raw
// --payload and any unknown flag are rejected exactly as the real CLI would.
if (args[0] === "orchestration" && args[1] === "send") {
  const VALUE_FLAGS = ["--to", "--subject", "--from", "--body", "--type", "--task-id", "--dispatch-id", "--report-path", "--phase"];
  const BOOL_FLAGS = ["--json"];
  const sendArgs = args.slice(2);
  for (let i = 0; i < sendArgs.length; i++) {
    const flag = sendArgs[i];
    if (VALUE_FLAGS.indexOf(flag) >= 0) {
      if (i + 1 >= sendArgs.length) emit({ ok: false, error: "orchestration send: flag " + flag + " requires a value" }, 2);
      i++;
    } else if (BOOL_FLAGS.indexOf(flag) < 0) {
      process.stderr.write("orchestration send: unrecognized flag " + flag + "\\n");
      emit({ ok: false, error: "orchestration send does not accept " + flag }, 2);
    }
  }
  emit({ id: "send-1", ok: true, result: { delivered: true, type: argValue("--type") }, _meta: meta }, 0);
}
if (args[0] === "orchestration" && args[1] === "dispatch-show") {
  const task = argValue("--task");
  // base -> scenario seed -> real-dispatch state file (state file WINS so a re-established
  // mapping reads back live and a second resume is idempotent).
  let result = { task_id: task, dispatch_id: "disp-" + task, assignee: "term-" + task, terminal_present: true };
  const seed = (scenario.dispatch && scenario.dispatch[task]) || {};
  let seedRuntime;
  Object.keys(seed).forEach((k) => { if (k === "runtimeId") seedRuntime = seed[k]; else result[k] = seed[k]; });
  try { Object.assign(result, JSON.parse(fs.readFileSync(stateFile(task), "utf-8"))); } catch (e) { /* no real dispatch yet */ }
  const dispatchMeta = seedRuntime !== undefined ? { runtimeId: seedRuntime } : meta;
  emit({ id: "ds-" + task, ok: true, result: nestDispatch(result, scenario.structuredCoordinator, scenario.preamble), _meta: dispatchMeta }, 0);
}
if (args[0] === "orchestration" && args[1] === "dispatch") {
  const task = argValue("--task");
  const handle = argValue("--to");
  if (scenario.dispatchFailFor && scenario.dispatchFailFor === task) emit({ ok: false, error: "dispatch inject undelivered" }, 0);
  // D5.4: a handle with no recognized agent CLI cannot accept --inject (verbatim error).
  if (scenario.injectNonAgentHandles && scenario.injectNonAgentHandles.indexOf(handle) >= 0) {
    process.stderr.write("Cannot dispatch --inject to terminal " + handle + ": no recognized agent detected. Start an agent CLI (e.g. claude, codex, gemini, droid) in the terminal first, or dispatch without --inject and send the prompt manually.\\n");
    emit({ ok: false, error: "no recognized agent detected for terminal " + handle }, 0);
  }
  const record = { task_id: task, dispatch_id: "disp-" + task, assignee: handle, terminal_present: true };
  try { fs.writeFileSync(stateFile(task), JSON.stringify(record), "utf-8"); } catch (e) { /* ignore */ }
  emit({ id: "d-" + task, ok: true, result: { id: record.dispatch_id, dispatch_id: record.dispatch_id, assignee: handle }, _meta: meta }, 0);
}
if (args[0] === "terminal" && args[1] === "create") {
  if (scenario.terminalCreateOkFalse) emit({ ok: false, error: "terminal create failed" }, 1);
  if (scenario.terminalCreateEmptyHandle) emit({ ok: true, result: {} }, 0);
  let n = 0;
  const counter = path.join(stateDir, "term-counter");
  try { n = Number(fs.readFileSync(counter, "utf-8")) || 0; } catch (e) { n = 0; }
  n += 1;
  try { fs.writeFileSync(counter, String(n), "utf-8"); } catch (e) { /* ignore */ }
  emit({ ok: true, result: { handle: "orca-term-" + n, id: "orca-term-" + n }, _meta: meta }, 0);
}
if (args[0] === "terminal" && args[1] === "send") {
  // D1/D5.3: validate the COMPLETE argv against the real 'terminal send' allowlist. Value
  // flags take exactly one argument; boolean flags take none. ANY unknown flag (e.g. --to,
  // --task, --bogus) or wrong arity hard-fails (non-zero exit, ok:false, error naming the
  // offending flag) — the fake never silently accepts a flag the real CLI would reject.
  const VALUE_FLAGS = ["--terminal", "--text"];
  const BOOL_FLAGS = ["--enter", "--interrupt", "--json"];
  const sendArgs = args.slice(2);
  for (let i = 0; i < sendArgs.length; i++) {
    const flag = sendArgs[i];
    if (VALUE_FLAGS.indexOf(flag) >= 0) {
      if (i + 1 >= sendArgs.length) {
        process.stderr.write("terminal send: flag " + flag + " requires a value\\n");
        emit({ ok: false, error: "terminal send: flag " + flag + " requires a value" }, 2);
      }
      i++; // consume the flag's value (taken literally, even if it looks like a flag)
    } else if (BOOL_FLAGS.indexOf(flag) < 0) {
      process.stderr.write("terminal send: unrecognized flag " + flag + "\\n");
      emit({ ok: false, error: "terminal send does not accept " + flag }, 2);
    }
  }
  if (scenario.terminalSendOkFalse) emit({ ok: false, error: "terminal send failed" }, 1);
  emit({ ok: true, result: { delivered: true }, _meta: meta }, 0);
}

process.stderr.write("Unsupported fake orca (resume) invocation: " + args.join(" ") + "\\n");
process.exit(1);
`;
}

function installFakeOrcaResume(scenarioOverrides = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || "relay-fake-orca-resume-"));
  const orcaPath = path.join(dir, options.binName || "orca");
  const scenarioPath = path.join(dir, "scenario.json");
  const logPath = path.join(dir, "invocations.log");
  const poisonPath = path.join(dir, "poison.txt");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const scenario = defaultResumeScenario(scenarioOverrides);
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2), "utf-8");
  fs.writeFileSync(orcaPath, fakeOrcaResumeScript({ scenarioPath, logPath, poisonPath, stateDir }), "utf-8");
  fs.chmodSync(orcaPath, 0o755);

  return {
    dir,
    orcaPath,
    scenarioPath,
    logPath,
    poisonPath,
    stateDir,
    scenario,
    readLog() {
      if (!fs.existsSync(logPath)) return [];
      return fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    },
    readPoison() {
      if (!fs.existsSync(poisonPath)) return null;
      return fs.readFileSync(poisonPath, "utf-8");
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { defaultResumeScenario, fakeOrcaResumeScript, installFakeOrcaResume };
