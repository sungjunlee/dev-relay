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
const { programSegment, withIntegrationLifecycleLock, readIntegrationEvidenceFile, integrationLockName } = require(path.join(SCRIPTS, "receipt-io.js"));
const { deriveStatusReport } = require(path.join(SCRIPTS, "lib", "status-derive.js"));
const { buildFinalSummary } = require(path.join(SCRIPTS, "lib", "final-summary.js"));
const { advanceIntegrationTasks } = require(path.join(SCRIPTS, "resume.js"));
const { installFakeOrcaIntegrationLifecycle, DEFAULT_RUNTIME_ID } = require(path.join(__dirname, "..", "fixtures", "fake-orca-integration-lifecycle.js"));

const PROGRAM_ID = "repilot-941-20260715";
const OUTCOME_ID = "integration-check";
const TASK_ID = "task_integration_1019";
const DISPATCH_ID = "dispatch_integration_1019";
const ASSIGNEE = "term-integration-fresh";
const COORDINATOR = "coord-current";

// Evidence artifacts are provenance-bound (#1019 H2): the deterministic path alone is not
// proof of freshness, so the artifact must carry the live runtime/task/dispatch identity.
// `provenance` overrides let a test forge a stale/incomplete artifact.
function reportFile(passed = true, provenance = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-integration-report-"));
  const reportPath = path.join(dir, "integration.json");
  const body = {
    passed,
    evidence: passed ? "integration fixture passed" : "integration fixture failed",
    runtime_id: "runtime_id" in provenance ? provenance.runtime_id : DEFAULT_RUNTIME_ID,
    task_id: "task_id" in provenance ? provenance.task_id : TASK_ID,
    dispatch_id: "dispatch_id" in provenance ? provenance.dispatch_id : DISPATCH_ID,
  };
  fs.writeFileSync(reportPath, JSON.stringify(body) + "\n", "utf8");
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

test("#1019 repeated resume on passed gate + active task re-issues the completion instruction idempotently", () => {
  const question = canonicalIntegrationQuestion(PROGRAM_ID, OUTCOME_ID, programSegment);
  // Live residue after a lost completion instruction / second resume: the canonical gate is
  // already resolved passed, evidence is valid, yet the program-owned task is still active.
  const gate = { id: "g1", task_id: TASK_ID, question, options: ["passed", "failed"], status: "resolved", resolution: "passed" };
  const fake = installFakeOrcaIntegrationLifecycle(initialState({
    tasks: [{ id: TASK_ID, status: "ready", worker_done: false }],
    gates: [gate],
  }));
  const report = reportFile();
  try {
    const firstResume = advanceIntegrationGate(context(fake, report.reportPath));
    assert.equal(firstResume.ok, false);
    assert.equal(firstResume.state, "awaiting_worker_done");
    assert.equal(firstResume.reason_code, "INTEGRATION_WORKER_DONE_REQUIRED");
    assert.ok(firstResume.completion_command, "awaiting_worker_done must carry a copy-paste completion command");
    assert.match(firstResume.completion_command.copy_paste, /worker_done/);
    // It re-issued the worker-owned completion instruction, never a coordinator-side worker_done.
    assert.equal(fake.readSends().filter((argv) => argv.includes("worker_done")).length, 0);
    assert.equal(fake.readSends().filter((argv) => argv.includes("integration_gate_completion")).length, 1);
    // No duplicate gate creation and no gate re-resolution — the gate was already passed.
    assert.equal(fake.readLog().filter((argv) => argv[1] === "gate-create").length, 0);
    assert.equal(fake.readLog().filter((argv) => argv[1] === "gate-resolve").length, 0);

    // A second resume is idempotent: it re-issues again, still no duplicate gate.
    const secondResume = advanceIntegrationGate(context(fake, report.reportPath));
    assert.equal(secondResume.ok, false);
    assert.equal(secondResume.state, "awaiting_worker_done");
    assert.equal(fake.readLog().filter((argv) => argv[1] === "gate-create").length, 0);
    assert.equal(fake.readState().gates.length, 1);
    assert.equal(fake.readSends().filter((argv) => argv.includes("integration_gate_completion")).length, 2);

    // Once the operator finally sends the explicit worker_done, the task terminalizes with no task-update.
    const command = completionCommand(context(fake, report.reportPath));
    assert.equal(fake.run(command.argv).status, 0);
    const completed = advanceIntegrationGate(context(fake, report.reportPath));
    assert.equal(completed.ok, true);
    assert.equal(completed.state, "completed");
    assert.equal(fake.readState().tasks[0].status, "completed");
    assert.equal(fake.readSends().filter((argv) => argv.includes("worker_done")).length, 1);
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
    { label: "duplicate", reasonCode: "INTEGRATION_GATE_DUPLICATE", gates: [
      { id: "g1", task_id: TASK_ID, question, options: ["passed", "failed"], status: "pending" },
      { id: "g2", task_id: TASK_ID, question, options: ["passed", "failed"], status: "pending" },
    ] },
    { label: "wrong question", reasonCode: "INTEGRATION_GATE_NONCANONICAL", gates: [
      { id: "g1", task_id: TASK_ID, question: "stale question", options: ["passed", "failed"], status: "pending" },
    ] },
    { label: "conflicting result", reasonCode: "INTEGRATION_GATE_CONFLICT", gates: [
      { id: "g1", task_id: TASK_ID, question, options: ["passed", "failed"], status: "resolved", resolution: "failed" },
    ] },
  ];
  for (const scenario of cases) {
    const fake = installFakeOrcaIntegrationLifecycle(initialState({ gates: scenario.gates }));
    const report = reportFile();
    try {
      assert.throws(() => prepareIntegrationGate(context(fake, report.reportPath)), (error) => {
        assert.ok(error instanceof IntegrationLifecycleError, scenario.label);
        assert.equal(error.reasonCode, scenario.reasonCode, scenario.label);
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
    { label: "coordinator", reasonCode: "INTEGRATION_COORDINATOR_PROVENANCE_MISMATCH", state: initialState({ coordinator: "coord-stale" }) },
    { label: "dispatch", reasonCode: "INTEGRATION_DISPATCH_PROVENANCE_MISMATCH", state: initialState({ dispatch: { [TASK_ID]: { dispatch_id: "dispatch-other", assignee: ASSIGNEE } } }) },
    // A stale --from is rejected at the dispatch-show CLI boundary, surfacing as a capability gap.
    { label: "assignee", reasonCode: "INTEGRATION_CAPABILITY_GAP", state: initialState({ dispatch: { [TASK_ID]: { dispatch_id: DISPATCH_ID, assignee: "term-other" } } }) },
  ];
  for (const scenario of cases) {
    const fake = installFakeOrcaIntegrationLifecycle(scenario.state);
    const report = reportFile();
    try {
      assert.throws(() => advanceIntegrationGate(context(fake, report.reportPath)), (error) => {
        assert.ok(error instanceof IntegrationLifecycleError, scenario.label);
        assert.equal(error.reasonCode, scenario.reasonCode, scenario.label);
        return true;
      }, scenario.label);
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
    assert.throws(() => advanceIntegrationGate(context(fake, report.reportPath)), (error) => {
      assert.ok(error instanceof IntegrationLifecycleError);
      assert.equal(error.reasonCode, "INTEGRATION_REPORT_INVALID");
      return true;
    });
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

test("#1019 H2 evidence not bound to the live runtime/task/dispatch fails closed before gate-resolve", () => {
  const question = canonicalIntegrationQuestion(PROGRAM_ID, OUTCOME_ID, programSegment);
  const staleCases = [
    { label: "prior-run runtime", provenance: { runtime_id: "runtime-prior-run" }, reasonCode: "INTEGRATION_REPORT_PROVENANCE_MISMATCH" },
    { label: "prior-run task", provenance: { task_id: "task-prior-run" }, reasonCode: "INTEGRATION_REPORT_PROVENANCE_MISMATCH" },
    { label: "reused-dir dispatch", provenance: { dispatch_id: "dispatch-prior-run" }, reasonCode: "INTEGRATION_REPORT_PROVENANCE_MISMATCH" },
    { label: "missing dispatch id", provenance: { dispatch_id: undefined }, reasonCode: "INTEGRATION_REPORT_PROVENANCE_MISSING" },
  ];
  for (const scenario of staleCases) {
    // A canonical gate already exists pending; only fresh, provenance-bound evidence may resolve it.
    const fake = installFakeOrcaIntegrationLifecycle(initialState({
      gates: [{ id: "g1", task_id: TASK_ID, question, options: ["passed", "failed"], status: "pending" }],
    }));
    const report = reportFile(true, scenario.provenance);
    try {
      assert.throws(() => advanceIntegrationGate(context(fake, report.reportPath)), (error) => {
        assert.ok(error instanceof IntegrationLifecycleError, scenario.label);
        assert.equal(error.reasonCode, scenario.reasonCode, scenario.label);
        return true;
      }, scenario.label);
      // Stale evidence must NEVER authorize a gate-create, gate-resolve, or worker_done.
      assert.deepEqual(fake.readLog().filter((argv) => ["gate-create", "gate-resolve", "send"].includes(argv[1])), [], scenario.label);
      assert.equal(fake.readPoison(), null);
    } finally {
      fake.cleanup();
      fs.rmSync(report.dir, { recursive: true, force: true });
    }
  }
  // The SAME dispatch's fresh, provenance-bound evidence still resolves the gate (crash recovery preserved).
  const fresh = installFakeOrcaIntegrationLifecycle(initialState({
    gates: [{ id: "g1", task_id: TASK_ID, question, options: ["passed", "failed"], status: "pending" }],
  }));
  const freshReport = reportFile();
  try {
    const advanced = advanceIntegrationGate(context(fresh, freshReport.reportPath));
    assert.equal(advanced.ok, false);
    assert.equal(advanced.reason_code, "INTEGRATION_WORKER_DONE_REQUIRED");
    assert.equal(fresh.readLog().filter((argv) => argv[1] === "gate-resolve").length, 1);
    assert.equal(fresh.readPoison(), null);
  } finally {
    fresh.cleanup();
    fs.rmSync(freshReport.dir, { recursive: true, force: true });
  }
});

test("#1019 H1 resume leaves a materialized, undispatched or wave-ineligible integration gate inert", () => {
  const receiptFor = (integrationTask) => ({
    program_id: PROGRAM_ID,
    runtime_id: DEFAULT_RUNTIME_ID,
    tasks: [
      { outcome_id: "impl", kind: "implementation", wave: 1, orca_task_id: "orca-impl", dispatch_id: "d-impl", assignee: "term-impl" },
      integrationTask,
    ],
  });
  // Wave 1 has not completed_with_evidence, so the wave-2 integration gate is not yet eligible.
  const report = { outcomes: [{ outcome_id: "impl", wave: 1, state: "reused" }, { outcome_id: OUTCOME_ID, wave: 2, state: "pending" }] };
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-h1-lock-"));
  const opts = {
    coordinatorHandle: COORDINATOR,
    integrationLockRoot: lockRoot,
    integrationReportPath: () => path.join(os.tmpdir(), "relay-orca-h1-nonexistent-report.json"),
  };
  const inertCases = [
    { label: "undispatched wave-2 gate (the #1019 live shape)", task: { outcome_id: OUTCOME_ID, kind: "integration_gate", wave: 2, orca_task_id: TASK_ID, dispatch_id: null, assignee: null } },
    { label: "dispatched wave-2 gate before earlier waves complete", task: { outcome_id: OUTCOME_ID, kind: "integration_gate", wave: 2, orca_task_id: TASK_ID, dispatch_id: DISPATCH_ID, assignee: ASSIGNEE } },
  ];
  try {
    for (const scenario of inertCases) {
      // orcaBin points at an absent binary: an inert gate must never reach it, so a broken
      // filter would surface as an INTEGRATION_CAPABILITY_GAP blocking entry, not [].
      const blocking = advanceIntegrationTasks({
        receipt: receiptFor(scenario.task),
        opts,
        orcaBin: path.join(os.tmpdir(), "relay-orca-h1-absent-orca-bin"),
        report,
      });
      assert.deepEqual(blocking, [], scenario.label);
    }
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
  }
});

test("#1019 H1 resume advances a dispatched, wave-eligible integration gate", () => {
  const fake = installFakeOrcaIntegrationLifecycle(initialState({
    gates: [{ id: "g1", task_id: TASK_ID, question: canonicalIntegrationQuestion(PROGRAM_ID, OUTCOME_ID, programSegment), options: ["passed", "failed"], status: "pending" }],
  }));
  const report = reportFile();
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-h1-pos-lock-"));
  try {
    const blocking = advanceIntegrationTasks({
      receipt: {
        program_id: PROGRAM_ID,
        runtime_id: DEFAULT_RUNTIME_ID,
        tasks: [{ outcome_id: OUTCOME_ID, kind: "integration_gate", wave: 1, orca_task_id: TASK_ID, dispatch_id: DISPATCH_ID, assignee: ASSIGNEE }],
      },
      opts: { coordinatorHandle: COORDINATOR, integrationLockRoot: lockRoot, integrationReportPath: () => report.reportPath },
      orcaBin: fake.orcaPath,
      report: { outcomes: [{ outcome_id: OUTCOME_ID, wave: 1, state: "pending" }] },
    });
    // Wave-1 eligible + dispatched → the gate resolves and the operator is asked for worker_done.
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].reason_code, "INTEGRATION_WORKER_DONE_REQUIRED");
    assert.equal(fake.readLog().filter((argv) => argv[1] === "gate-resolve").length, 1);
    assert.equal(fake.readPoison(), null);
  } finally {
    fake.cleanup();
    fs.rmSync(report.dir, { recursive: true, force: true });
    fs.rmSync(lockRoot, { recursive: true, force: true });
  }
});

test("#1019 M3 integration lifecycle lock reclaims a dead owner but never steals a live one", () => {
  const { execFileSync } = require("node:child_process");
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-m3-lock-"));
  const lockArgs = { programId: PROGRAM_ID, outcomeId: OUTCOME_ID, taskId: TASK_ID, lockRoot };
  const lockPath = path.join(lockRoot, `${integrationLockName(lockArgs)}.lock`);
  // A guaranteed-dead PID: a child process that has already exited by the time execFileSync returns.
  const deadPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
  try {
    // Dead owner: a crash left the lock dir + the PID of a process that no longer exists.
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner"), `${deadPid}\n`, "utf8");
    const reclaimed = withIntegrationLifecycleLock({ ...lockArgs, timeoutMs: 300, pollMs: 5 }, () => "acquired");
    assert.equal(reclaimed, "acquired", "a dead owner's lock is reclaimed, not stranded");
    assert.equal(fs.existsSync(lockPath), false, "the reclaiming holder releases the lock when it finishes");

    // Live owner: the current process holds the lock; a competing acquire must fail closed.
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner"), `${process.pid}\n`, "utf8");
    assert.throws(
      () => withIntegrationLifecycleLock({ ...lockArgs, timeoutMs: 60, pollMs: 5 }, () => "should-not-run"),
      /integration lifecycle lock timed out/,
    );
    assert.equal(fs.existsSync(lockPath), true, "a live owner's lock is never stolen");
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
  }
});
