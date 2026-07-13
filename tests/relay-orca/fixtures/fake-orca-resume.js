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
    gateListOk: overrides.gateListOk !== undefined ? overrides.gateListOk : true,
    omitRuntimeId: overrides.omitRuntimeId === true,
    taskListRuntimeId: overrides.taskListRuntimeId,
    gateListRuntimeId: overrides.gateListRuntimeId,
    tasks: overrides.tasks || [],
    gates: overrides.gates || [],
    // Per-task dispatch-show seed (pre-resume state): { terminal_present, assignee,
    // dispatch_id, runtimeId }. A real dispatch supersedes it for that task.
    dispatch: overrides.dispatch || {},
    // Execution knobs (fail-closed / optional): an orca task id whose `dispatch --inject`
    // returns ok:false, and terminal-create failure modes.
    dispatchFailFor: overrides.dispatchFailFor || null,
    // D5.4: handles with no recognized agent — `dispatch --inject` to one hard-fails with
    // the real "no recognized agent detected" error. Empty by default.
    injectNonAgentHandles: Array.isArray(overrides.injectNonAgentHandles) ? overrides.injectNonAgentHandles : [],
    terminalCreateOkFalse: overrides.terminalCreateOkFalse || false,
    terminalCreateEmptyHandle: overrides.terminalCreateEmptyHandle || false,
    terminalSendOkFalse: overrides.terminalSendOkFalse || false,
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
function nestDispatch(flat) {
  const dispatch = { id: flat.dispatch_id, task_id: flat.task_id, assignee_handle: flat.assignee, status: flat.status || "dispatched" };
  const result = { dispatch: dispatch };
  if (flat.terminal_present !== undefined) result.terminal_present = flat.terminal_present;
  return result;
}
function loadScenario() { return JSON.parse(fs.readFileSync(scenarioPath, "utf-8")); }
function emit(payload, exitCode) { if (payload !== undefined && payload !== null) process.stdout.write(JSON.stringify(payload)); process.exit(typeof exitCode === "number" ? exitCode : 0); }
function argValue(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }
function stateFile(taskId) { return path.join(stateDir, "disp-" + String(taskId).replace(/[^a-zA-Z0-9._-]/g, "_") + ".json"); }
function poison(marker, code) { if (poisonPath) fs.writeFileSync(poisonPath, marker + ":" + args.join(" "), "utf-8"); process.stderr.write("POISON: " + marker + "\\n"); process.exit(code); }

// D7 poison: reset + worktree only (resume MAY dispatch/terminal). Active on every path.
if (args.includes("reset")) poison("RESET_INVOKED", 99);
if (args.includes("worktree")) poison("WORKTREE_INVOKED", 98);

const scenario = loadScenario();
const meta = { runtimeId: scenario.runtimeId };

if (args[0] === "status") {
  if (!scenario.statusOk) { process.stderr.write("orca status unreachable\\n"); process.exit(1); }
  const runtime = { state: "ready", reachable: true };
  if (!scenario.omitRuntimeId) runtime.runtimeId = scenario.runtimeId;
  const statusMeta = scenario.omitRuntimeId ? {} : meta;
  emit({ id: "status-1", ok: true, result: { app: { running: true, pid: 1 }, runtime, graph: { state: "ready" } }, _meta: statusMeta }, 0);
}
if (args[0] === "orchestration" && args[1] === "task-list") {
  if (scenario.taskListOk === false) { process.stderr.write("orca task-list unreachable\\n"); process.exit(1); }
  const tasks = Array.isArray(scenario.tasks) ? scenario.tasks : [];
  const taskMeta = scenario.taskListRuntimeId !== undefined ? { runtimeId: scenario.taskListRuntimeId } : meta;
  emit({ id: "task-list-1", ok: true, result: { tasks, count: tasks.length }, _meta: taskMeta }, 0);
}
if (args[0] === "orchestration" && args[1] === "gate-list") {
  if (scenario.gateListOk === false) { process.stderr.write("orca gate-list unreachable\\n"); process.exit(1); }
  const gates = Array.isArray(scenario.gates) ? scenario.gates : [];
  const gateMeta = scenario.gateListRuntimeId !== undefined ? { runtimeId: scenario.gateListRuntimeId } : meta;
  emit({ id: "gate-list-1", ok: true, result: { gates, count: gates.length }, _meta: gateMeta }, 0);
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
  emit({ id: "ds-" + task, ok: true, result: nestDispatch(result), _meta: dispatchMeta }, 0);
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
  emit({ ok: true, result: { delivered: true } }, 0);
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
