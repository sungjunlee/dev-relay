"use strict";

/**
 * Read-only fake Orca CLI fixture for relay-orca `status` tests (#945 D3/D10).
 *
 * Supports ONLY the read subcommands `status` needs: `status`,
 * `orchestration task-list`, `orchestration gate-list`, and
 * `orchestration dispatch-show`. EVERY mutating surface is POISONED on every path —
 * it writes a poison marker and exits non-zero so the test hard-fails: `reset`, any
 * `worktree` subcommand, and the mutating orchestration subcommands
 * `task-create`, `task-update`, and `dispatch` (note: `dispatch-show` is a read and
 * is NOT poisoned), plus any `terminal` subcommand.
 *
 * Behavior is scenario-driven via a JSON file; every invocation is appended to a
 * shared log.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_RUNTIME_ID } = require("./fake-orca");

function defaultStatusScenario(overrides = {}) {
  const runtimeId = overrides.runtimeId || DEFAULT_RUNTIME_ID;
  return {
    runtimeId,
    statusOk: overrides.statusOk !== undefined ? overrides.statusOk : true,
    // Required-read failure knobs (#945 A4): when false, the read subcommand exits
    // non-zero so the derive path can prove a failed task-list/gate-list read degrades
    // the runtime to "unreachable" instead of fabricating an empty [] with runtime "ok".
    taskListOk: overrides.taskListOk !== undefined ? overrides.taskListOk : true,
    gateListOk: overrides.gateListOk !== undefined ? overrides.gateListOk : true,
    // A13 knob: when true, the `status` read SUCCEEDS (ok:true) but carries NO live
    // runtime id — neither `result.runtime.runtimeId` nor `_meta.runtimeId` — so the
    // derive path can prove a missing runtime id degrades the runtime to "unreachable".
    omitRuntimeId: overrides.omitRuntimeId === true,
    tasks: overrides.tasks || [],
    gates: overrides.gates || [],
    dispatch: overrides.dispatch || {},
  };
}

function fakeOrcaStatusScript({ scenarioPath, logPath, poisonPath }) {
  return `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
const scenarioPath = ${JSON.stringify(scenarioPath)};
const logPath = ${JSON.stringify(logPath)};
const poisonPath = ${JSON.stringify(poisonPath)};

function appendLog(line) { if (logPath) fs.appendFileSync(logPath, line + "\\n", "utf-8"); }
appendLog(args.join(" "));
function loadScenario() { return JSON.parse(fs.readFileSync(scenarioPath, "utf-8")); }
function emit(payload, exitCode) { if (payload !== undefined && payload !== null) process.stdout.write(JSON.stringify(payload)); process.exit(typeof exitCode === "number" ? exitCode : 0); }
function argValue(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }
function poison(marker, code) { if (poisonPath) fs.writeFileSync(poisonPath, marker + ":" + args.join(" "), "utf-8"); process.stderr.write("POISON: " + marker + "\\n"); process.exit(code); }

if (args.includes("reset")) poison("RESET_INVOKED", 99);
if (args.includes("worktree")) poison("WORKTREE_INVOKED", 98);
if (args[0] === "orchestration" && (args[1] === "task-create" || args[1] === "task-update" || args[1] === "dispatch")) poison("MUTATION_INVOKED", 97);
if (args[0] === "terminal") poison("TERMINAL_INVOKED", 96);

const scenario = loadScenario();
const meta = { runtimeId: scenario.runtimeId };

if (args[0] === "status") {
  if (!scenario.statusOk) { process.stderr.write("orca status unreachable\\n"); process.exit(1); }
  // A13: omitRuntimeId emits a SUCCESSFUL status whose runtime block AND _meta both lack
  // a runtimeId, so orcaStatus normalizes runtimeId to null (missing live runtime id).
  const runtime = { state: "ready", reachable: true };
  if (!scenario.omitRuntimeId) runtime.runtimeId = scenario.runtimeId;
  const statusMeta = scenario.omitRuntimeId ? {} : meta;
  emit({ id: "status-1", ok: true, result: { app: { running: true, pid: 1 }, runtime, graph: { state: "ready" } }, _meta: statusMeta }, 0);
}
if (args[0] === "orchestration" && args[1] === "task-list") {
  if (scenario.taskListOk === false) { process.stderr.write("orca task-list unreachable\\n"); process.exit(1); }
  const tasks = Array.isArray(scenario.tasks) ? scenario.tasks : [];
  emit({ id: "task-list-1", ok: true, result: { tasks, count: tasks.length }, _meta: meta }, 0);
}
if (args[0] === "orchestration" && args[1] === "gate-list") {
  if (scenario.gateListOk === false) { process.stderr.write("orca gate-list unreachable\\n"); process.exit(1); }
  const gates = Array.isArray(scenario.gates) ? scenario.gates : [];
  emit({ id: "gate-list-1", ok: true, result: { gates, count: gates.length }, _meta: meta }, 0);
}
if (args[0] === "orchestration" && args[1] === "dispatch-show") {
  const task = argValue("--task");
  const override = (scenario.dispatch && scenario.dispatch[task]) || {};
  const result = Object.assign({ task_id: task, dispatch_id: "disp-" + task, assignee: "term-" + task, terminal_present: true }, override);
  emit({ id: "ds-" + task, ok: true, result, _meta: meta }, 0);
}

process.stderr.write("Unsupported fake orca (status) invocation: " + args.join(" ") + "\\n");
process.exit(1);
`;
}

function installFakeOrcaStatus(scenarioOverrides = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || "relay-fake-orca-status-"));
  const orcaPath = path.join(dir, options.binName || "orca");
  const scenarioPath = path.join(dir, "scenario.json");
  const logPath = path.join(dir, "invocations.log");
  const poisonPath = path.join(dir, "poison.txt");
  const scenario = defaultStatusScenario(scenarioOverrides);
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2), "utf-8");
  fs.writeFileSync(orcaPath, fakeOrcaStatusScript({ scenarioPath, logPath, poisonPath }), "utf-8");
  fs.chmodSync(orcaPath, 0o755);

  return {
    dir,
    orcaPath,
    scenarioPath,
    logPath,
    poisonPath,
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

module.exports = { defaultStatusScenario, fakeOrcaStatusScript, installFakeOrcaStatus };
