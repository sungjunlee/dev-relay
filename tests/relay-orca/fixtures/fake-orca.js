"use strict";

/**
 * Fake Orca CLI fixture for relay-orca probe tests.
 *
 * Installs an executable `orca` on PATH (or at a chosen path). Behavior is
 * driven by a scenario JSON file pointed to by RELAY_FAKE_ORCA_SCENARIO.
 * Every invocation is appended to RELAY_FAKE_ORCA_LOG. Invoking `reset` writes
 * a poison marker and exits non-zero so tests hard-fail (D2).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_RUNTIME_ID = "00000000-0000-4000-8000-000000000001";

function readyStatus(runtimeId = DEFAULT_RUNTIME_ID) {
  return {
    id: "status-1",
    ok: true,
    result: {
      app: { running: true, pid: 4242 },
      runtime: { state: "ready", reachable: true, runtimeId },
      graph: { state: "ready" },
    },
    _meta: { runtimeId },
  };
}

function emptyTaskList(runtimeId = DEFAULT_RUNTIME_ID) {
  return {
    id: "task-list-1",
    ok: true,
    result: { tasks: [], count: 0 },
    _meta: { runtimeId },
  };
}

function emptyGateList(runtimeId = DEFAULT_RUNTIME_ID) {
  return {
    id: "gate-list-1",
    ok: true,
    result: { gates: [], count: 0 },
    _meta: { runtimeId },
  };
}

function defaultScenario(overrides = {}) {
  const runtimeId = overrides.runtimeId || DEFAULT_RUNTIME_ID;
  return {
    runtimeId,
    status: overrides.status !== undefined ? overrides.status : readyStatus(runtimeId),
    statusExit: overrides.statusExit !== undefined ? overrides.statusExit : 0,
    statusStdout: overrides.statusStdout,
    taskList: overrides.taskList !== undefined ? overrides.taskList : emptyTaskList(runtimeId),
    taskListExit: overrides.taskListExit !== undefined ? overrides.taskListExit : 0,
    taskListStdout: overrides.taskListStdout,
    taskListStderr: overrides.taskListStderr || "",
    gateList: overrides.gateList !== undefined ? overrides.gateList : emptyGateList(runtimeId),
    gateListExit: overrides.gateListExit !== undefined ? overrides.gateListExit : 0,
    gateListStdout: overrides.gateListStdout,
    gateListStderr: overrides.gateListStderr || "",
    taskCreate: overrides.taskCreate !== undefined
      ? overrides.taskCreate
      : {
          id: "task-create-1",
          ok: true,
          result: { id: "smoke-task-1", task_id: "smoke-task-1" },
          _meta: { runtimeId },
        },
    taskCreateExit: overrides.taskCreateExit !== undefined ? overrides.taskCreateExit : 0,
    dispatch: overrides.dispatch !== undefined
      ? overrides.dispatch
      : {
          id: "dispatch-1",
          ok: true,
          result: {
            id: "smoke-dispatch-1",
            dispatch_id: "smoke-dispatch-1",
            assignee: "relay-orca-probe-smoke",
          },
          _meta: { runtimeId },
        },
    dispatchExit: overrides.dispatchExit !== undefined ? overrides.dispatchExit : 0,
    taskUpdate: overrides.taskUpdate !== undefined
      ? overrides.taskUpdate
      : {
          id: "task-update-1",
          ok: true,
          result: { id: "smoke-task-1", status: "cancelled" },
          _meta: { runtimeId },
        },
    taskUpdateExit: overrides.taskUpdateExit !== undefined ? overrides.taskUpdateExit : 0,
    taskUpdateStderr: overrides.taskUpdateStderr || "",
  };
}

function writeFakeOrcaScript({ orcaPath, scenarioPath, logPath, poisonPath }) {
  const script = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
const scenarioPath = ${JSON.stringify(scenarioPath)};
const logPath = ${JSON.stringify(logPath)};
const poisonPath = ${JSON.stringify(poisonPath)};

function appendLog(line) {
  if (logPath) fs.appendFileSync(logPath, line + "\\n", "utf-8");
}

appendLog(args.join(" "));

function loadScenario() {
  return JSON.parse(fs.readFileSync(scenarioPath, "utf-8"));
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

function emit(payload, exitCode, stdoutOverride, stderrText) {
  if (stderrText) process.stderr.write(String(stderrText));
  if (stdoutOverride !== undefined && stdoutOverride !== null) {
    process.stdout.write(String(stdoutOverride));
  } else if (payload !== undefined && payload !== null) {
    writeJson(payload);
  }
  process.exit(typeof exitCode === "number" ? exitCode : 0);
}

// D2 poison: any reset invocation hard-fails the fixture (and thus the test).
if (args.includes("reset")) {
  if (poisonPath) fs.writeFileSync(poisonPath, "RESET_INVOKED:" + args.join(" "), "utf-8");
  process.stderr.write("POISON: orca orchestration reset must never be invoked\\n");
  process.exit(99);
}

// Deterministic stall mode: when RELAY_FAKE_ORCA_STALL_MS is a positive integer
// and the invocation matches RELAY_FAKE_ORCA_STALL_CMD (default "status"), block
// synchronously so the probe's finite timeout must fire. SIGTERM still kills us.
const stallMs = Number(process.env.RELAY_FAKE_ORCA_STALL_MS);
const stallCmd = process.env.RELAY_FAKE_ORCA_STALL_CMD || "status";
if (Number.isInteger(stallMs) && stallMs > 0 && args[0] === stallCmd) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
}

const scenario = loadScenario();

if (args[0] === "status") {
  emit(scenario.status, scenario.statusExit, scenario.statusStdout, scenario.statusStderr);
}

if (args[0] === "orchestration" && args[1] === "task-list") {
  emit(scenario.taskList, scenario.taskListExit, scenario.taskListStdout, scenario.taskListStderr);
}

if (args[0] === "orchestration" && args[1] === "gate-list") {
  emit(scenario.gateList, scenario.gateListExit, scenario.gateListStdout, scenario.gateListStderr);
}

if (args[0] === "orchestration" && args[1] === "task-create") {
  emit(scenario.taskCreate, scenario.taskCreateExit, scenario.taskCreateStdout, scenario.taskCreateStderr);
}

if (args[0] === "orchestration" && args[1] === "dispatch") {
  emit(scenario.dispatch, scenario.dispatchExit, scenario.dispatchStdout, scenario.dispatchStderr);
}

if (args[0] === "orchestration" && args[1] === "task-update") {
  emit(scenario.taskUpdate, scenario.taskUpdateExit, scenario.taskUpdateStdout, scenario.taskUpdateStderr);
}

process.stderr.write("Unsupported fake orca invocation: " + args.join(" ") + "\\n");
process.exit(1);
`;

  fs.writeFileSync(orcaPath, script, "utf-8");
  fs.chmodSync(orcaPath, 0o755);
  return orcaPath;
}

function installFakeOrca(scenarioOverrides = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || "relay-fake-orca-"));
  const orcaPath = path.join(dir, options.binName || "orca");
  const scenarioPath = path.join(dir, "scenario.json");
  const logPath = path.join(dir, "invocations.log");
  const poisonPath = path.join(dir, "poison.txt");
  const scenario = defaultScenario(scenarioOverrides);
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2), "utf-8");
  writeFakeOrcaScript({ orcaPath, scenarioPath, logPath, poisonPath });

  const originalPath = process.env.PATH;
  if (options.prependPath !== false) {
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ""}`;
  }

  let restored = false;
  const restore = () => {
    if (restored) return;
    if (options.prependPath !== false) process.env.PATH = originalPath;
    restored = true;
  };

  return {
    dir,
    orcaPath,
    scenarioPath,
    logPath,
    poisonPath,
    scenario,
    restore,
    readLog() {
      if (!fs.existsSync(logPath)) return [];
      return fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    },
    readPoison() {
      if (!fs.existsSync(poisonPath)) return null;
      return fs.readFileSync(poisonPath, "utf-8");
    },
    writeScenario(next) {
      const merged = defaultScenario(next);
      fs.writeFileSync(scenarioPath, JSON.stringify(merged, null, 2), "utf-8");
      return merged;
    },
  };
}

module.exports = {
  DEFAULT_RUNTIME_ID,
  readyStatus,
  emptyTaskList,
  emptyGateList,
  defaultScenario,
  writeFakeOrcaScript,
  installFakeOrca,
};
