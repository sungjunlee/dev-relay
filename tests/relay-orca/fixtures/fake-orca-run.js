"use strict";

/**
 * Run-capable fake Orca CLI fixture for relay-orca `run` tests.
 *
 * Extends the #942 read-only fake (which stays untouched) with the mutating
 * orchestration/terminal surface `run` drives: task-create, dispatch,
 * dispatch-show, terminal create, terminal send. Behavior is scenario-driven via
 * a JSON file; every invocation is appended to a shared log. Two surfaces are
 * POISONED on EVERY path (they write a poison marker and exit non-zero so the
 * test hard-fails): `orca orchestration reset` (D2) and any `orca worktree`
 * subcommand (D5).
 *
 * Dispatch provenance is stateful: `dispatch` writes a per-task state file so a
 * following `dispatch-show` returns the same dispatch id and assignee handle,
 * making happy-path provenance verifiable. Scenario overrides force
 * null/empty/mismatched provenance for the fail-closed tests.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_RUNTIME_ID,
  readyStatus,
  emptyTaskList,
  emptyGateList,
} = require("./fake-orca");

function defaultRunScenario(overrides = {}) {
  const runtimeId = overrides.runtimeId || DEFAULT_RUNTIME_ID;
  return {
    runtimeId,
    // Admission surface (consumed by the frozen probe).
    status: overrides.status !== undefined ? overrides.status : readyStatus(runtimeId),
    statusExit: overrides.statusExit !== undefined ? overrides.statusExit : 0,
    statusStdout: overrides.statusStdout,
    taskList: overrides.taskList !== undefined ? overrides.taskList : emptyTaskList(runtimeId),
    taskListExit: overrides.taskListExit !== undefined ? overrides.taskListExit : 0,
    gateList: overrides.gateList !== undefined ? overrides.gateList : emptyGateList(runtimeId),
    gateListExit: overrides.gateListExit !== undefined ? overrides.gateListExit : 0,
    // Run surface knobs.
    taskCreateFailFor: overrides.taskCreateFailFor || null, // outcome id whose task-create fails
    taskCreateFailMode: overrides.taskCreateFailMode || "ok_false", // ok_false | nonzero | empty_id
    dispatchFailFor: overrides.dispatchFailFor || null, // orca task id whose dispatch returns ok:false
    provenanceOverride: overrides.provenanceOverride || null, // merged over dispatch-show result
    provenanceOverrideFor: overrides.provenanceOverrideFor || null, // limit override to one orca task id
    terminalCreateOkFalse: overrides.terminalCreateOkFalse || false,
    terminalCreateEmptyHandle: overrides.terminalCreateEmptyHandle || false,
    terminalSendOkFalse: overrides.terminalSendOkFalse || false,
  };
}

function fakeOrcaRunScript({ scenarioPath, logPath, poisonPath, stateDir }) {
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

function loadScenario() { return JSON.parse(fs.readFileSync(scenarioPath, "utf-8")); }
function writeJson(value) { process.stdout.write(JSON.stringify(value)); }
function emit(payload, exitCode, stdoutOverride) {
  if (stdoutOverride !== undefined && stdoutOverride !== null) process.stdout.write(String(stdoutOverride));
  else if (payload !== undefined && payload !== null) writeJson(payload);
  process.exit(typeof exitCode === "number" ? exitCode : 0);
}
function argValue(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }
function drainStdin() { try { fs.readFileSync(0); } catch (e) { /* no stdin */ } }
function stateFile(taskId) { return path.join(stateDir, "disp-" + String(taskId).replace(/[^a-zA-Z0-9._-]/g, "_") + ".json"); }

// D2 poison: reset must never be invoked.
if (args.includes("reset")) {
  if (poisonPath) fs.writeFileSync(poisonPath, "RESET_INVOKED:" + args.join(" "), "utf-8");
  process.stderr.write("POISON: orca orchestration reset must never be invoked\\n");
  process.exit(99);
}
// D5 poison: relay owns implementation worktrees; run never touches orca worktree.
if (args.includes("worktree")) {
  if (poisonPath) fs.writeFileSync(poisonPath, "WORKTREE_INVOKED:" + args.join(" "), "utf-8");
  process.stderr.write("POISON: orca worktree must never be invoked by run\\n");
  process.exit(98);
}

const scenario = loadScenario();

if (args[0] === "status") emit(scenario.status, scenario.statusExit, scenario.statusStdout);
if (args[0] === "orchestration" && args[1] === "task-list") emit(scenario.taskList, scenario.taskListExit);
if (args[0] === "orchestration" && args[1] === "gate-list") emit(scenario.gateList, scenario.gateListExit);

if (args[0] === "orchestration" && args[1] === "task-create") {
  const title = argValue("--task-title") || "";
  const outcome = title.split("/").pop();
  const orcaId = "orca-live-" + outcome;
  if (scenario.taskCreateFailFor && scenario.taskCreateFailFor === outcome) {
    if (scenario.taskCreateFailMode === "nonzero") emit({ ok: false, error: "task-create failed" }, 1);
    if (scenario.taskCreateFailMode === "empty_id") emit({ ok: true, result: {} }, 0);
    emit({ ok: false, error: "task-create rejected" }, 0);
  }
  emit({ id: "tc-" + orcaId, ok: true, result: { id: orcaId, task_id: orcaId }, _meta: { runtimeId: scenario.runtimeId } }, 0);
}

if (args[0] === "orchestration" && args[1] === "dispatch") {
  const task = argValue("--task");
  const handle = argValue("--to");
  if (scenario.dispatchFailFor && scenario.dispatchFailFor === task) {
    emit({ ok: false, error: "dispatch inject undelivered" }, 0);
  }
  const record = { task_id: task, dispatch_id: "disp-" + task, assignee: handle };
  try { fs.writeFileSync(stateFile(task), JSON.stringify(record), "utf-8"); } catch (e) { /* ignore */ }
  emit({ id: "d-" + task, ok: true, result: { id: record.dispatch_id, dispatch_id: record.dispatch_id, assignee: handle }, _meta: { runtimeId: scenario.runtimeId } }, 0);
}

if (args[0] === "orchestration" && args[1] === "dispatch-show") {
  const task = argValue("--task");
  let base = { task_id: task, dispatch_id: "disp-" + task, assignee: "assignee-" + task };
  try { base = JSON.parse(fs.readFileSync(stateFile(task), "utf-8")); } catch (e) { /* no prior dispatch */ }
  if (scenario.provenanceOverride && (!scenario.provenanceOverrideFor || scenario.provenanceOverrideFor === task)) {
    Object.assign(base, scenario.provenanceOverride);
  }
  emit({ id: "ds-" + task, ok: true, result: base, _meta: { runtimeId: scenario.runtimeId } }, 0);
}

if (args[0] === "terminal" && args[1] === "create") {
  if (scenario.terminalCreateOkFalse) emit({ ok: false, error: "terminal create failed" }, 1);
  if (scenario.terminalCreateEmptyHandle) emit({ ok: true, result: {} }, 0);
  let n = 0;
  const counter = path.join(stateDir, "term-counter");
  try { n = Number(fs.readFileSync(counter, "utf-8")) || 0; } catch (e) { n = 0; }
  n += 1;
  try { fs.writeFileSync(counter, String(n), "utf-8"); } catch (e) { /* ignore */ }
  emit({ ok: true, result: { handle: "orca-term-" + n, id: "orca-term-" + n }, _meta: { runtimeId: scenario.runtimeId } }, 0);
}

if (args[0] === "terminal" && args[1] === "send") {
  drainStdin();
  if (scenario.terminalSendOkFalse) emit({ ok: false, error: "terminal send failed" }, 1);
  emit({ ok: true, result: { delivered: true } }, 0);
}

process.stderr.write("Unsupported fake orca invocation: " + args.join(" ") + "\\n");
process.exit(1);
`;
}

function installFakeOrcaRun(scenarioOverrides = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || "relay-fake-orca-run-"));
  const orcaPath = path.join(dir, options.binName || "orca");
  const scenarioPath = path.join(dir, "scenario.json");
  const logPath = path.join(dir, "invocations.log");
  const poisonPath = path.join(dir, "poison.txt");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const scenario = defaultRunScenario(scenarioOverrides);
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2), "utf-8");
  fs.writeFileSync(orcaPath, fakeOrcaRunScript({ scenarioPath, logPath, poisonPath, stateDir }), "utf-8");
  fs.chmodSync(orcaPath, 0o755);

  return {
    dir,
    orcaPath,
    scenarioPath,
    logPath,
    poisonPath,
    stateDir,
    scenario,
    restore() {
      /* PATH is never mutated: tests pass --orca-bin explicitly. */
    },
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

module.exports = { defaultRunScenario, fakeOrcaRunScript, installFakeOrcaRun };
