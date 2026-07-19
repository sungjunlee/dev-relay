"use strict";

// #1019 focused lifecycle matrix. Every Orca invocation goes through the stateful fake;
// the fake rejects task-update/reset/worktree and every unsupported argument shape.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPTS = path.resolve(__dirname, "..", "..", "..", "skills", "relay-orca", "scripts");
const {
  canonicalIntegrationQuestion,
  completionCommand,
  prepareIntegrationGate,
  advanceIntegrationGate,
  IntegrationLifecycleError,
} = require(path.join(SCRIPTS, "lib", "integration-lifecycle.js"));
const { programSegment, withIntegrationLifecycleLock, readIntegrationEvidenceFile } = require(path.join(SCRIPTS, "receipt-io.js"));
const { deriveStatusReport } = require(path.join(SCRIPTS, "lib", "status-derive.js"));
const { buildFinalSummary } = require(path.join(SCRIPTS, "lib", "final-summary.js"));
const { installFakeOrcaIntegrationLifecycle } = require(path.join(__dirname, "..", "fixtures", "fake-orca-integration-lifecycle.js"));

const PROGRAM_ID = "repilot-941-20260715";
const OUTCOME_ID = "integration-check";
const TASK_ID = "task_integration_1019";
const DISPATCH_ID = "dispatch_integration_1019";
const ASSIGNEE = "term-integration-fresh";
const COORDINATOR = "coord-current";

function reportFile(passed = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-integration-report-"));
  const reportPath = path.join(dir, "integration.json");
  fs.writeFileSync(reportPath, JSON.stringify({ passed, evidence: passed ? "integration fixture passed" : "integration fixture failed" }) + "\n", "utf8");
  return { dir, reportPath };
}

function context(fake, reportPath, extra = {}) {
  return {
    run: (_bin, args) => fake.run(args),
    orcaBin: fake.orcaPath,
    programId: PROGRAM_ID,
    outcomeId: OUTCOME_ID,
    taskId: TASK_ID,
    dispatchId: DISPATCH_ID,
    assignee: ASSIGNEE,
    coordinatorHandle: COORDINATOR,
    reportPath,
    programSegment,
    lockRoot: fake.dir,
    withLock: (lockKey, callback) => withIntegrationLifecycleLock({ programId: PROGRAM_ID, outcomeId: OUTCOME_ID, taskId: TASK_ID, lockRoot: fake.dir, lockKey }, callback),
    readReport: readIntegrationEvidenceFile,
    ...extra,
  };
}

function initialState(extra = {}) {
  return {
    coordinator: COORDINATOR,
    tasks: [{ id: TASK_ID, status: "ready", worker_done: false }],
    dispatch: { [TASK_ID]: { dispatch_id: DISPATCH_ID, assignee: ASSIGNEE, terminal_present: true } },
    gates: [],
    ...extra,
  };
}

test("#1019 happy path is gate-create, evidence, resolve, fresh instruction, worker_done, completed re-read", () => {
  const fake = installFakeOrcaIntegrationLifecycle(initialState());
  const report = reportFile();
  try {
    const first = prepareIntegrationGate(context(fake, report.reportPath));
    assert.equal(first.ok, true);
    const advanced = advanceIntegrationGate(context(fake, report.reportPath));
    assert.equal(advanced.ok, false);
    assert.equal(advanced.reason_code, "INTEGRATION_WORKER_DONE_REQUIRED");
    const command = completionCommand(context(fake, report.reportPath));
    const workerDone = fake.run(command.argv);
    assert.equal(workerDone.status, 0);
    const completed = advanceIntegrationGate(context(fake, report.reportPath));
    assert.equal(completed.ok, true);
    const log = fake.readLog().map((argv) => argv.slice(0, 2).join(" "));
    assert.ok(log.includes("orchestration gate-create"));
    assert.ok(log.includes("orchestration gate-resolve"));
    assert.ok(log.includes("orchestration send"));
    assert.equal(fake.readSends().filter((argv) => argv.includes("worker_done")).length, 1);
    assert.equal(fake.readState().tasks[0].status, "completed");
    assert.equal(fake.readPoison(), null);
  } finally {
    fake.cleanup();
    fs.rmSync(report.dir, { recursive: true, force: true });
  }
});

test("#1019 create response loss is recovered by re-list/adopt without a second create", () => {
  const fake = installFakeOrcaIntegrationLifecycle(initialState({ createResponseLoss: true }));
  try {
    const report = reportFile();
    const result = prepareIntegrationGate(context(fake, report.reportPath));
    assert.equal(result.ok, true);
    assert.equal(fake.readLog().filter((argv) => argv[1] === "gate-create").length, 1);
    assert.equal(fake.readState().gates.length, 1);
    fake.cleanup();
    fs.rmSync(report.dir, { recursive: true, force: true });
  } catch (error) {
    fake.cleanup();
    throw error;
  }
});

test("#1019 duplicate or noncanonical gates fail closed before further mutation", () => {
  const question = canonicalIntegrationQuestion(PROGRAM_ID, OUTCOME_ID, programSegment);
  const cases = [
    { label: "duplicate", gates: [
      { id: "g1", task_id: TASK_ID, question, options: ["passed", "failed"], status: "pending" },
      { id: "g2", task_id: TASK_ID, question, options: ["passed", "failed"], status: "pending" },
    ] },
    { label: "wrong question", gates: [
      { id: "g1", task_id: TASK_ID, question: "stale question", options: ["passed", "failed"], status: "pending" },
    ] },
    { label: "conflicting result", gates: [
      { id: "g1", task_id: TASK_ID, question, options: ["passed", "failed"], status: "resolved", resolution: "failed" },
    ] },
  ];
  for (const scenario of cases) {
    const fake = installFakeOrcaIntegrationLifecycle(initialState({ gates: scenario.gates }));
    const report = reportFile();
    try {
      assert.throws(() => prepareIntegrationGate(context(fake, report.reportPath)), (error) => {
        assert.ok(error instanceof IntegrationLifecycleError);
        return true;
      }, scenario.label);
      const mutations = fake.readLog().filter((argv) => ["gate-create", "gate-resolve", "send"].includes(argv[1]));
      assert.deepEqual(mutations, [], `${scenario.label} must have zero further mutation`);
      assert.equal(fake.readPoison(), null);
    } finally {
      fake.cleanup();
      fs.rmSync(report.dir, { recursive: true, force: true });
    }
  }
});

test("#1019 stale coordinator, dispatch, assignee, and report provenance fail closed", () => {
  const cases = [
    { label: "coordinator", state: initialState({ coordinator: "coord-stale" }) },
    { label: "dispatch", state: initialState({ dispatch: { [TASK_ID]: { dispatch_id: "dispatch-other", assignee: ASSIGNEE } } }) },
    { label: "assignee", state: initialState({ dispatch: { [TASK_ID]: { dispatch_id: DISPATCH_ID, assignee: "term-other" } } }) },
  ];
  for (const scenario of cases) {
    const fake = installFakeOrcaIntegrationLifecycle(scenario.state);
    const report = reportFile();
    try {
      assert.throws(() => advanceIntegrationGate(context(fake, report.reportPath)), /provenance|coordinator|dispatch|assignee/i, scenario.label);
      const mutations = fake.readLog().filter((argv) => ["gate-create", "gate-resolve", "send"].includes(argv[1]));
      assert.deepEqual(mutations, [], `${scenario.label} must have zero lifecycle mutation`);
      assert.equal(fake.readPoison(), null);
    } finally {
      fake.cleanup();
      fs.rmSync(report.dir, { recursive: true, force: true });
    }
  }
  const fake = installFakeOrcaIntegrationLifecycle(initialState());
  const report = reportFile();
  fs.writeFileSync(report.reportPath, "not-json\n", "utf8");
  try {
    assert.throws(() => advanceIntegrationGate(context(fake, report.reportPath)), /report|evidence/i);
    assert.deepEqual(fake.readLog().filter((argv) => ["gate-create", "gate-resolve", "send"].includes(argv[1])), []);
  } finally {
    fake.cleanup();
    fs.rmSync(report.dir, { recursive: true, force: true });
  }
});

test("#1019 completion command is explicit and never raw-payload shaped", () => {
  const report = reportFile();
  try {
    const command = completionCommand(context({ dir: "locks" }, report.reportPath));
    assert.deepEqual(command.argv.slice(0, 2), ["orchestration", "send"]);
    ["--from", ASSIGNEE, "--to", COORDINATOR, "--type", "worker_done", "--task-id", TASK_ID, "--dispatch-id", DISPATCH_ID, "--report-path", report.reportPath, "--phase", "integration_gate", "--json"].forEach((token) => assert.ok(command.argv.includes(token), token));
    assert.equal(command.argv.includes("--payload"), false);
    assert.match(command.copy_paste, /--from/);
    assert.match(command.copy_paste, /--to/);
    assert.match(command.copy_paste, /--report-path/);
  } finally {
    fs.rmSync(report.dir, { recursive: true, force: true });
  }
});

test("#1019 final summary vetoes active integration task and generic resolved gate", () => {
  const question = canonicalIntegrationQuestion(PROGRAM_ID, OUTCOME_ID, programSegment);
  const makeReport = (taskStatus, gate) => {
    const fake = installFakeOrcaIntegrationLifecycle(initialState({
      tasks: [{ id: TASK_ID, task_title: `relay-orca: ${programSegment(PROGRAM_ID)}/${OUTCOME_ID}`, display_name: `relay-orca: ${programSegment(PROGRAM_ID)}/${OUTCOME_ID}`, status: taskStatus, worker_done: taskStatus === "completed" }],
      gates: [gate],
    }));
    const receipt = {
      program_id: PROGRAM_ID,
      runtime_id: "runtime-integration-fixture",
      tasks: [{ outcome_id: OUTCOME_ID, task_id: "orca-task-integration-check", kind: "integration_gate", wave: 1, orca_task_id: TASK_ID, dispatch_id: DISPATCH_ID, assignee: ASSIGNEE, relay_ids: { request: null, run: null, fleet: null } }],
    };
    const report = deriveStatusReport({
      receipt,
      programId: PROGRAM_ID,
      receiptPath: "/tmp/receipt.json",
      manifests: [],
      orca: (_bin, args) => fake.run(args[0] === "orchestration" && args[1] === "gate-list" && !args.includes("--task") ? ["orchestration", "gate-list", "--task", TASK_ID, "--json"] : args),
      gh: null,
      urlFor: () => null,
      programSegment,
      strictIntegration: true,
    });
    return { fake, report };
  };
  const gate = { id: "g1", task_id: TASK_ID, question, options: ["passed", "failed"], status: "resolved", resolution: "passed" };
  const active = makeReport("ready", gate);
  try {
    const summary = buildFinalSummary({
      programId: PROGRAM_ID,
      receiptPath: "/tmp/receipt.json",
      report: active.report,
      gateEval: { prerequisites_met: true, gates: [{ gate: "integration:integration-check", kind: "integration", state: "passed", evidence: { passed: true }, message: "" }], blocking_reasons: [] },
      followUps: { blocking: [], deferred: [] },
      decisions: [],
    });
    assert.equal(active.report.runtime, "ok", JSON.stringify({ diagnostics: active.report.diagnostics, log: active.fake.readLog() }));
    assert.equal(summary.program_complete, false);
    assert.equal(summary.stopped_on, "orca_lifecycle_failure");
    assert.ok(summary.blocking_reasons.some((reason) => reason.reason_code === "INTEGRATION_TASK_ACTIVE"), JSON.stringify({ diagnostics: active.report.diagnostics, outcomes: active.report.outcomes }));
  } finally {
    active.fake.cleanup();
  }
  const generic = makeReport("completed", { id: "g1", task_id: TASK_ID, question, options: ["passed", "failed"], status: "resolved" });
  try {
    assert.ok(generic.report.diagnostics.some((diagnostic) => diagnostic.code === "INTEGRATION_GATE_CONFLICT"));
  } finally {
    generic.fake.cleanup();
  }
});
