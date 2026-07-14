"use strict";

/**
 * Coordinator-only-stop fake Orca CLI fixture for relay-orca `stop` tests (#946 D5/D7).
 *
 * Serves ONLY `orca orchestration run-stop`. EVERY other mutating surface is POISONED on
 * every path (writes a marker, exits non-zero, hard-fails the test): `reset`, any
 * `worktree` subcommand, `orchestration task-create`/`task-update`/`dispatch`, and any
 * `terminal` subcommand. This is the restricted poison set D5 pins — "everything mutating
 * EXCEPT run-stop" — proving stop is coordinator-only.
 *
 * Behavior is scenario-driven with explicit success, no-active-run, and generic-failure
 * modes; every invocation is logged.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function defaultStopScenario(overrides = {}) {
  return {
    // `success` emits the existing ok envelope; `no-active-run` emits the real live-CLI
    // error envelope on stdout; `generic-failure` emits a distinct error envelope.
    mode: overrides.mode || "success",
    stopped: overrides.stopped !== undefined ? overrides.stopped : true,
    runId: overrides.runId || "coordinator-run-1",
    exitCode: overrides.exitCode,
  };
}

function fakeOrcaStopScript({ scenarioPath, logPath, poisonPath }) {
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
function poison(marker, code) { if (poisonPath) fs.writeFileSync(poisonPath, marker + ":" + args.join(" "), "utf-8"); process.stderr.write("POISON: " + marker + "\\n"); process.exit(code); }

// D5/D7 restricted poison set: everything mutating EXCEPT run-stop. Active on every path.
if (args.includes("reset")) poison("RESET_INVOKED", 99);
if (args.includes("worktree")) poison("WORKTREE_INVOKED", 98);
if (args[0] === "orchestration" && (args[1] === "task-create" || args[1] === "task-update" || args[1] === "dispatch")) poison("MUTATION_INVOKED", 97);
if (args[0] === "terminal") poison("TERMINAL_INVOKED", 96);

const scenario = loadScenario();

if (args[0] === "orchestration" && args[1] === "run-stop") {
  if (scenario.mode === "success") {
    emit({ id: "run-stop-1", ok: true, result: { stopped: scenario.stopped, run_id: scenario.runId } }, typeof scenario.exitCode === "number" ? scenario.exitCode : 0);
  }
  if (scenario.mode === "no-active-run") {
    emit({ id: "cb80f615-0000-4000-8000-000000001005", ok: false, error: { code: "runtime_error", message: "No active coordinator run" } }, typeof scenario.exitCode === "number" ? scenario.exitCode : 1);
  }
  if (scenario.mode === "generic-failure") {
    emit({ id: "run-stop-failure", ok: false, error: { code: "runtime_error", message: "Coordinator stop failed" } }, typeof scenario.exitCode === "number" ? scenario.exitCode : 1);
  }
  process.stderr.write("Unsupported fake stop mode: " + scenario.mode + "\\n");
  process.exit(2);
}

process.stderr.write("Unsupported fake orca (stop) invocation: " + args.join(" ") + "\\n");
process.exit(1);
`;
}

function installFakeOrcaStop(scenarioOverrides = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || "relay-fake-orca-stop-"));
  const orcaPath = path.join(dir, options.binName || "orca");
  const scenarioPath = path.join(dir, "scenario.json");
  const logPath = path.join(dir, "invocations.log");
  const poisonPath = path.join(dir, "poison.txt");
  const scenario = defaultStopScenario(scenarioOverrides);
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2), "utf-8");
  fs.writeFileSync(orcaPath, fakeOrcaStopScript({ scenarioPath, logPath, poisonPath }), "utf-8");
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
    writeScenario(next) {
      const updated = defaultStopScenario(next);
      fs.writeFileSync(scenarioPath, JSON.stringify(updated, null, 2), "utf-8");
      return updated;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { defaultStopScenario, fakeOrcaStopScript, installFakeOrcaStop };
