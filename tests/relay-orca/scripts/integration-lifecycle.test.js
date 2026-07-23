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

// The lifecycle provenance the CURRENT fixture dispatch stamps into its evidence artifact.
const LIVE_PROVENANCE = Object.freeze({
  runtime_id: DEFAULT_RUNTIME_ID,
  task_id: TASK_ID,
  dispatch_id: DISPATCH_ID,
  assignee: ASSIGNEE,
});

function writeReport(reportPath, body) {
  fs.writeFileSync(reportPath, JSON.stringify(body) + "\n", "utf8");
}

// Evidence artifacts are provenance-bound (#1019 H2/R3): the deterministic path alone is not
// proof of freshness, so the artifact must carry the live runtime/task/dispatch/assignee
// identity. `provenance` overrides let a test forge a stale/incomplete artifact; a key present
// with value `undefined` forges an OMITTED field.
function reportFile(passed = true, provenance = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-integration-report-"));
  const reportPath = path.join(dir, "integration.json");
  writeReport(reportPath, {
    passed,
    evidence: passed ? "integration fixture passed" : "integration fixture failed",
    ...LIVE_PROVENANCE,
    ...provenance,
  });
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

function lifecycleMutations(fake) {
  return fake.readLog().filter((argv) => ["gate-create", "gate-resolve", "send"].includes(argv[1]));
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
    assert.ok(log.includes("terminal list"), "coordinator liveness must be checked through the live terminal query");
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

test("#1067 coordinator liveness matrix is fail-closed and structured metadata remains optional", () => {
  const cases = [
    { label: "handle absent from live terminal set", state: initialState({ liveTerminals: [] }) },
    { label: "terminal query failed", state: initialState({ terminalListOk: false }) },
    { label: "terminal query is unparseable", state: initialState({ terminalListMalformed: true }) },
  ];
  for (const scenario of cases) {
    const fake = installFakeOrcaIntegrationLifecycle(scenario.state);
    const report = reportFile();
    try {
      assert.throws(() => prepareIntegrationGate(context(fake, report.reportPath)), (error) => {
        assert.ok(error instanceof IntegrationLifecycleError, scenario.label);
        assert.equal(error.reasonCode, "INTEGRATION_COORDINATOR_PROVENANCE_MISSING", scenario.label);
        return true;
      }, scenario.label);
      assert.deepEqual(lifecycleMutations(fake), [], `${scenario.label} must not mutate the lifecycle`);
      assert.equal(fake.readPoison(), null);
    } finally {
      fake.cleanup();
      fs.rmSync(report.dir, { recursive: true, force: true });
    }
  }

  const matching = installFakeOrcaIntegrationLifecycle(initialState({ structuredCoordinator: COORDINATOR }));
  const matchingReport = reportFile();
  try {
    const prepared = prepareIntegrationGate(context(matching, matchingReport.reportPath));
    assert.equal(prepared.ok, true, "a matching structured coordinator field remains compatible");
    assert.equal(matching.readState().gates.length, 1);
  } finally {
    matching.cleanup();
    fs.rmSync(matchingReport.dir, { recursive: true, force: true });
  }

  const mismatching = installFakeOrcaIntegrationLifecycle(initialState({
    structuredCoordinator: "coord-stale",
    liveTerminals: [COORDINATOR],
  }));
  const mismatchingReport = reportFile();
  try {
    assert.throws(() => prepareIntegrationGate(context(mismatching, mismatchingReport.reportPath)), (error) => {
      assert.equal(error.reasonCode, "INTEGRATION_COORDINATOR_PROVENANCE_MISMATCH");
      return true;
    });
    assert.deepEqual(lifecycleMutations(mismatching), [], "a structured mismatch must not mutate the lifecycle");
  } finally {
    mismatching.cleanup();
    fs.rmSync(mismatchingReport.dir, { recursive: true, force: true });
  }
});

test("#1067 string preambles are inert corroboration, including contradictory text", () => {
  const fake = installFakeOrcaIntegrationLifecycle(initialState({ preamble: "Coordinator: coord-stale" }));
  const report = reportFile();
  try {
    const status = JSON.parse(fake.run(["status", "--json"]).stdout);
    assert.deepEqual(Object.keys(status.result).sort(), ["app", "graph", "runtime"]);
    assert.equal("coordinator" in status.result, false);
    assert.equal(status._meta.runtimeId, DEFAULT_RUNTIME_ID);
    const dispatch = JSON.parse(fake.run([
      "orchestration", "dispatch-show", "--task", TASK_ID, "--preamble", "--from", ASSIGNEE, "--json",
    ]).stdout);
    assert.equal(typeof dispatch.result.preamble, "string");
    assert.match(dispatch.result.preamble, /coord-stale/);
    assert.equal(dispatch.result.dispatch.assignee_handle, ASSIGNEE);
    assert.equal("coordinator_handle" in dispatch.result.dispatch, false);
    assert.equal("from" in dispatch.result.dispatch, false);
    assert.equal(dispatch._meta.runtimeId, DEFAULT_RUNTIME_ID);

    // The contradictory text cannot replace the criterion-1 liveness proof or cause a
    // coordinator mismatch. The canonical gate mutation is authorized by the verified live
    // handle and the remaining dispatch/runtime bindings, never by preamble text.
    const prepared = prepareIntegrationGate(context(fake, report.reportPath));
    assert.equal(prepared.ok, true);
    assert.equal(fake.readState().gates.length, 1);
    assert.equal(lifecycleMutations(fake).filter((argv) => argv[1] === "gate-create").length, 1);
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

// #1019 R7: the live integration task is already terminal `failed` (or otherwise
// non-completable), yet a historical dispatch still verifies and provenance-bound evidence
// exists. Resolving the canonical gate passed and re-issuing worker_done would strand a passed
// gate on a task that can never legitimately complete — a harder residue than failing closed. The
// advance must refuse BEFORE any gate-create/resolve/send, with an actionable reason and zero mutation.
test("#1019 R7 a terminal non-completable integration task fails closed before any gate mutation", () => {
  const question = canonicalIntegrationQuestion(PROGRAM_ID, OUTCOME_ID, programSegment);
  // A pending canonical gate already exists AND the operator's provenance-bound evidence landed;
  // only the still-live task status stops the flow.
  for (const status of ["failed", "cancelled"]) {
    const fake = installFakeOrcaIntegrationLifecycle(initialState({
      tasks: [{ id: TASK_ID, status, worker_done: false }],
      gates: [{ id: "g1", task_id: TASK_ID, question, options: ["passed", "failed"], status: "pending" }],
    }));
    const report = reportFile();
    try {
      assert.throws(() => advanceIntegrationGate(context(fake, report.reportPath)), (error) => {
        assert.ok(error instanceof IntegrationLifecycleError, status);
        assert.equal(error.reasonCode, "INTEGRATION_TASK_NOT_COMPLETABLE", status);
        return true;
      }, status);
      const mutations = fake.readLog().filter((argv) => ["gate-create", "gate-resolve", "send"].includes(argv[1]));
      assert.deepEqual(mutations, [], `${status} must have zero lifecycle mutation`);
      assert.equal(fake.readState().gates[0].status, "pending", `${status} must leave the canonical gate unresolved`);
      assert.equal(fake.readPoison(), null);
    } finally {
      fake.cleanup();
      fs.rmSync(report.dir, { recursive: true, force: true });
    }
  }

  // The same guard holds when the canonical gate is still MISSING: a non-completable task must
  // never even materialize a gate to write evidence against.
  const fake = installFakeOrcaIntegrationLifecycle(initialState({
    tasks: [{ id: TASK_ID, status: "failed", worker_done: false }],
  }));
  const report = reportFile();
  try {
    assert.throws(() => advanceIntegrationGate(context(fake, report.reportPath)), (error) => {
      assert.equal(error.reasonCode, "INTEGRATION_TASK_NOT_COMPLETABLE");
      return true;
    });
    assert.deepEqual(fake.readLog().filter((argv) => ["gate-create", "gate-resolve", "send"].includes(argv[1])), []);
    assert.equal(fake.readState().gates.length, 0, "a failed task must not even create a gate");
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
    { label: "coordinator", reasonCode: "INTEGRATION_COORDINATOR_PROVENANCE_MISMATCH", state: initialState({ structuredCoordinator: "coord-stale", liveTerminals: [COORDINATOR] }) },
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

// #1019 R3: the evidence path is deterministic, so an artifact left behind by an EARLIER
// runtime/task/dispatch/assignee sits exactly where the current lifecycle looks. Each stale
// variant must be rejected BEFORE gate inspection or resolution, with a provenance reason code
// (not the lock's) and a completely clean invocation log.
test("#1019 H2/R3 evidence not bound to the live runtime/task/dispatch/assignee fails closed before gate-resolve", () => {
  const question = canonicalIntegrationQuestion(PROGRAM_ID, OUTCOME_ID, programSegment);
  const staleCases = [
    { label: "prior-run runtime", provenance: { runtime_id: "runtime-prior-run" }, reasonCode: "INTEGRATION_REPORT_PROVENANCE_MISMATCH" },
    { label: "prior-run task", provenance: { task_id: "task-prior-run" }, reasonCode: "INTEGRATION_REPORT_PROVENANCE_MISMATCH" },
    { label: "reused-dir dispatch", provenance: { dispatch_id: "dispatch-prior-run" }, reasonCode: "INTEGRATION_REPORT_PROVENANCE_MISMATCH" },
    { label: "previous pane assignee", provenance: { assignee: "term-previous-pane" }, reasonCode: "INTEGRATION_REPORT_PROVENANCE_MISMATCH" },
    { label: "missing dispatch id", provenance: { dispatch_id: undefined }, reasonCode: "INTEGRATION_REPORT_PROVENANCE_MISSING" },
    { label: "missing assignee", provenance: { assignee: undefined }, reasonCode: "INTEGRATION_REPORT_PROVENANCE_MISSING" },
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

  // An artifact with no provenance at all cannot be attributed to any dispatch, so it is a
  // missing-provenance failure rather than a silently-accepted legacy shape. The gate is
  // absent here too, proving the rejection precedes gate CREATION as well as resolution.
  const unbound = installFakeOrcaIntegrationLifecycle(initialState());
  const unboundReport = reportFile();
  writeReport(unboundReport.reportPath, { passed: true, evidence: "unbound legacy evidence" });
  try {
    assert.throws(() => advanceIntegrationGate(context(unbound, unboundReport.reportPath)), (error) => {
      assert.equal(error.reasonCode, "INTEGRATION_REPORT_PROVENANCE_MISSING");
      return true;
    });
    assert.deepEqual(unbound.readLog().filter((argv) => ["gate-create", "gate-resolve", "send"].includes(argv[1])), []);
    assert.equal(unbound.readState().gates.length, 0, "an unbound artifact must not even create a gate");
    assert.equal(unbound.readPoison(), null);
  } finally {
    unbound.cleanup();
    fs.rmSync(unboundReport.dir, { recursive: true, force: true });
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

// The counterpart guarantee: binding evidence to the dispatch must NOT break crash recovery.
// A restart against the SAME runtime/task/dispatch/assignee re-reads its own artifact and
// drives the lifecycle all the way to completed.
test("#1019 R3 same-dispatch evidence stays valid across a coordinator restart", () => {
  const fake = installFakeOrcaIntegrationLifecycle(initialState());
  const report = reportFile();
  try {
    // "Restart": a brand-new context object over the same live dispatch and the artifact the
    // previous coordinator process already wrote.
    const first = advanceIntegrationGate(context(fake, report.reportPath));
    assert.equal(first.ok, false);
    assert.equal(first.reason_code, "INTEGRATION_WORKER_DONE_REQUIRED");
    assert.equal(fake.readLog().filter((argv) => argv[1] === "gate-resolve").length, 1);

    const command = completionCommand(context(fake, report.reportPath));
    assert.equal(fake.run(command.argv).status, 0);
    const completed = advanceIntegrationGate(context(fake, report.reportPath));
    assert.equal(completed.ok, true);
    assert.equal(completed.state, "completed");
    assert.equal(fake.readState().tasks[0].status, "completed");
    assert.equal(fake.readPoison(), null);
  } finally {
    fake.cleanup();
    fs.rmSync(report.dir, { recursive: true, force: true });
  }
});

// #1019 R4: exactly one canonical gate is a lifecycle invariant of a verified live integration
// dispatch, and the operator ordering is gate-before-evidence. Awaiting evidence against NO gate
// left the invariant unsatisfied and gave the operator nothing to write evidence against, so the
// gate must be materialized first — and materialized only once, however many times resume runs.
test("#1019 R4 a live dispatch with no gate and no evidence materializes exactly one canonical gate and still awaits evidence", () => {
  const fake = installFakeOrcaIntegrationLifecycle(initialState());
  const absentDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-r4-absent-report-"));
  const reportPath = path.join(absentDir, "integration.json");
  try {
    assert.equal(fake.readState().gates.length, 0, "precondition: the live dispatch carries no canonical gate");
    assert.equal(fs.existsSync(reportPath), false, "precondition: no deterministic evidence artifact exists yet");

    const first = advanceIntegrationGate(context(fake, reportPath));
    assert.equal(first.ok, true);
    assert.equal(first.state, "awaiting_evidence");
    assert.ok(first.gate, "awaiting_evidence must carry the materialized canonical gate, never null");
    assert.equal(first.gate.question, canonicalIntegrationQuestion(PROGRAM_ID, OUTCOME_ID, programSegment));
    assert.deepEqual(first.gate.options, ["passed", "failed"]);
    assert.equal(first.report_path, reportPath);
    assert.equal(fake.readState().gates.length, 1, "exactly one canonical gate is created");
    assert.equal(fake.readLog().filter((argv) => argv[1] === "gate-create").length, 1);
    // Materializing the gate must resolve and complete nothing.
    assert.equal(fake.readLog().filter((argv) => argv[1] === "gate-resolve").length, 0);
    assert.deepEqual(fake.readSends(), [], "no completion instruction or worker_done before evidence");
    assert.equal(fake.readState().tasks[0].status, "ready");
    assert.equal(fake.readPoison(), null);

    // Idempotency: the next pass adopts the same gate instead of creating a second one.
    const second = advanceIntegrationGate(context(fake, reportPath));
    assert.equal(second.ok, true);
    assert.equal(second.state, "awaiting_evidence");
    assert.equal(second.gate.id, first.gate.id, "the same canonical gate is adopted, not duplicated");
    assert.equal(fake.readLog().filter((argv) => argv[1] === "gate-create").length, 1, "no duplicate gate-create");
    assert.equal(fake.readState().gates.length, 1);
    assert.equal(fake.readLog().filter((argv) => argv[1] === "gate-resolve").length, 0);
    assert.deepEqual(fake.readSends(), []);
    assert.equal(fake.readState().tasks[0].status, "ready");
    assert.equal(fake.readPoison(), null);

    // The gate materialized ahead of the evidence is the very gate that evidence later resolves:
    // no second gate appears once the operator writes its provenance-bound artifact.
    writeReport(reportPath, { passed: true, evidence: "integration fixture passed", ...LIVE_PROVENANCE });
    const advanced = advanceIntegrationGate(context(fake, reportPath));
    assert.equal(advanced.ok, false);
    assert.equal(advanced.reason_code, "INTEGRATION_WORKER_DONE_REQUIRED");
    assert.equal(fake.readLog().filter((argv) => argv[1] === "gate-create").length, 1);
    assert.equal(fake.readState().gates.length, 1);
    assert.equal(fake.readState().gates[0].id, first.gate.id);
    assert.equal(fake.readState().gates[0].resolution, "passed");
    assert.equal(fake.readPoison(), null);
  } finally {
    fake.cleanup();
    fs.rmSync(absentDir, { recursive: true, force: true });
  }
});

// The advancement selection matrix. Eligibility is the CONJUNCTION of planResume's own verdict
// (only `reused`/`redispatched` leave a currently verified live dispatch behind), the shared
// wave blanket, and recorded dispatch provenance. Each inert row below flips exactly one
// conjunct while the others stay satisfied, so a filter that drops any conjunct fails here.
test("#1019 H1/R3 resume leaves an action-ineligible, undispatched, or wave-ineligible integration gate inert", () => {
  const receiptFor = (integrationTask) => ({
    program_id: PROGRAM_ID,
    runtime_id: DEFAULT_RUNTIME_ID,
    tasks: [
      { outcome_id: "impl", kind: "implementation", wave: 1, orca_task_id: "orca-impl", dispatch_id: "d-impl", assignee: "term-impl" },
      integrationTask,
    ],
  });
  // Wave 1 has not completed_with_evidence, so a wave-2 integration gate is not yet eligible.
  const waveShut = { outcomes: [{ outcome_id: "impl", wave: 1, state: "reused" }, { outcome_id: OUTCOME_ID, wave: 2, state: "pending" }] };
  // Wave 1 durably complete: the wave blanket is OPEN, so only the other conjuncts can hold.
  const waveOpen = { outcomes: [{ outcome_id: "impl", wave: 1, state: "complete_with_evidence" }] };
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-h1-lock-"));
  const opts = {
    coordinatorHandle: COORDINATOR,
    integrationLockRoot: lockRoot,
    integrationReportPath: () => path.join(os.tmpdir(), "relay-orca-h1-nonexistent-report.json"),
  };
  const dispatched = { dispatch_id: DISPATCH_ID, assignee: ASSIGNEE };
  const inertCases = [
    // The wave blanket alone holds these back: the plan reused/re-established a live dispatch.
    { label: "undispatched wave-2 gate (the #1019 live shape)", report: waveShut, action: "redispatched", task: { wave: 2, dispatch_id: null, assignee: null } },
    { label: "dispatched wave-2 gate before earlier waves complete", report: waveShut, action: "reused", task: { wave: 2, ...dispatched } },
    // The dispatch-provenance conjunct alone holds these back.
    { label: "wave-eligible gate with no dispatch_id", report: waveOpen, action: "reused", task: { wave: 2, dispatch_id: null, assignee: ASSIGNEE } },
    { label: "wave-eligible gate with no assignee", report: waveOpen, action: "reused", task: { wave: 2, dispatch_id: DISPATCH_ID, assignee: null } },
    { label: "wave-eligible gate with blank dispatch provenance", report: waveOpen, action: "reused", task: { wave: 2, dispatch_id: "   ", assignee: ASSIGNEE } },
    // The planResume action conjunct alone holds these back: receipt strings look complete and
    // the wave blanket is open, but the plan deliberately left the outcome alone this run, so
    // the recorded dispatch is NOT a currently verified live dispatch.
    { label: "plan skipped the outcome", report: waveOpen, action: "skipped", task: { wave: 2, ...dispatched } },
    { label: "plan requires a decision", report: waveOpen, action: "decision_required", task: { wave: 2, ...dispatched } },
    { label: "outcome absent from the plan entirely", report: waveOpen, action: undefined, task: { wave: 2, ...dispatched } },
  ];
  try {
    for (const scenario of inertCases) {
      // orcaBin points at an absent binary: an inert gate must never reach it, so a broken
      // filter would surface as an INTEGRATION_CAPABILITY_GAP blocking entry, not [].
      const blocking = advanceIntegrationTasks({
        receipt: receiptFor({ outcome_id: OUTCOME_ID, kind: "integration_gate", orca_task_id: TASK_ID, ...scenario.task }),
        opts,
        orcaBin: path.join(os.tmpdir(), "relay-orca-h1-absent-orca-bin"),
        report: scenario.report,
        actions: scenario.action === undefined ? [] : [{ outcome_id: OUTCOME_ID, action: scenario.action }],
      });
      assert.deepEqual(blocking, [], scenario.label);
    }
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
  }
});

test("#1019 H1/R3 resume advances a dispatched, wave-eligible integration gate the plan reused", () => {
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
      actions: [{ outcome_id: OUTCOME_ID, action: "reused" }],
    });
    // Wave-1 eligible + `reused` + dispatched → the gate resolves and the operator is asked for
    // worker_done. This is the positive control for the inert matrix above: without it, those
    // assertions could pass for the wrong reason (a lifecycle that never runs at all).
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

function lockPathFor(lockRoot) {
  return path.join(lockRoot, `${integrationLockName({ programId: PROGRAM_ID, outcomeId: OUTCOME_ID, taskId: TASK_ID })}.lock`);
}

function holdLock(lockRoot, ownerContent) {
  const lockPath = lockPathFor(lockRoot);
  fs.mkdirSync(lockPath, { recursive: true });
  if (ownerContent !== null) fs.writeFileSync(path.join(lockPath, "owner"), ownerContent, "utf8");
  return lockPath;
}

// A coordinator killed mid-critical-section leaves its lock directory behind. Its recorded
// owner pid is provably gone (kill(pid,0) → ESRCH), so the next coordinator reclaims it
// automatically — an abandoned lock must never require manual deletion to recover the program.
test("#1019 M3/R3 a lock abandoned by a provably dead owner is reclaimed automatically", () => {
  const { execFileSync } = require("node:child_process");
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-m3-lock-"));
  const lockArgs = { programId: PROGRAM_ID, outcomeId: OUTCOME_ID, taskId: TASK_ID, lockRoot };
  // A guaranteed-dead PID: a child process that has already been reaped by the time
  // execFileSync returns, so kill(pid, 0) reports exactly ESRCH.
  const deadPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
  const lockPath = holdLock(lockRoot, `${deadPid}\n`);
  assert.ok(fs.existsSync(lockPath), "precondition: the abandoned lock exists");
  try {
    let ran = false;
    const reclaimed = withIntegrationLifecycleLock({ ...lockArgs, timeoutMs: 300, pollMs: 5 }, () => {
      ran = true;
      return "acquired";
    });
    assert.equal(ran, true, "the critical section must run after reclaiming a dead owner's lock");
    assert.equal(reclaimed, "acquired", "a dead owner's lock is reclaimed, not stranded");
    assert.equal(fs.existsSync(lockPath), false, "the reclaiming holder releases the lock when it finishes");
    // The rename-then-remove reclaim leaves no staging residue behind.
    assert.deepEqual(fs.readdirSync(lockRoot), [], "the reclaim leaves no rename staging residue");
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
  }
});

// The safety counterpart: a lock held by a LIVE owner is never stolen, and neither is one whose
// ownership record is absent or malformed — that could belong to a live holder whose owner stamp
// has not landed yet, and an old mtime is not evidence the owner is gone. All fail closed at the
// bounded timeout with the lock left in place.
test("#1019 M3/R3 live-owner and ambiguous-owner locks are never stolen", () => {
  const lockArgs = { programId: PROGRAM_ID, outcomeId: OUTCOME_ID, taskId: TASK_ID };
  const cases = [
    { label: "live owner", owner: `${process.pid}\n` },
    { label: "absent owner record", owner: null },
    { label: "non-numeric owner", owner: "not-a-pid\n" },
    { label: "trailing-garbage owner", owner: "123abc\n" },
    { label: "zero owner", owner: "0\n" },
    { label: "negative owner", owner: "-5\n" },
  ];
  for (const scenario of cases) {
    const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-lock-held-"));
    const lockPath = holdLock(lockRoot, scenario.owner);
    // An mtime far in the past: a lease-based reclaim would steal these; an ESRCH-only reclaim
    // must not.
    const stale = new Date(Date.now() - 3600_000);
    fs.utimesSync(lockPath, stale, stale);
    try {
      let ran = false;
      assert.throws(
        () => withIntegrationLifecycleLock({ ...lockArgs, lockRoot, timeoutMs: 60, pollMs: 5 }, () => { ran = true; }),
        /integration lifecycle lock timed out/,
        scenario.label,
      );
      assert.equal(ran, false, `${scenario.label} must never enter the critical section`);
      assert.ok(fs.existsSync(lockPath), `${scenario.label} must leave the held lock in place`);
    } finally {
      fs.rmSync(lockRoot, { recursive: true, force: true });
    }
  }
});
