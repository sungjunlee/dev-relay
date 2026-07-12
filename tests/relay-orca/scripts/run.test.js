"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPTS = path.join(REPO_ROOT, "skills", "relay-orca", "scripts");
const RUN_JS = path.join(SCRIPTS, "run.js");

const { REASONS } = require(path.join(SCRIPTS, "lib", "run-reasons.js"));
const { REPORT_KEYS } = require(path.join(SCRIPTS, "lib", "run-report.js"));
const { compileProgram } = require(path.join(SCRIPTS, "lib", "compile-program.js"));
const {
  buildOperatorPrompt,
  PAYLOAD_FIELDS,
  RECONCILIATION_SENTENCE,
  LIFECYCLE_NOTE,
  READ_ONLY_MARKER,
  NO_EDIT_CLAUSE,
} = require(path.join(SCRIPTS, "lib", "operator-prompt.js"));
const { installFakeOrcaRun } = require(path.join(__dirname, "..", "fixtures", "fake-orca-run.js"));
const { readyStatus } = require(path.join(__dirname, "..", "fixtures", "fake-orca.js"));

// Plan-library codes re-raised verbatim by run (D1/D9).
const PLAN_CODES = { UNPREPARED_FLEET_LEAF: 12, CONCURRENCY_EXCEEDED: 16, NESTED_RELAY_ORCA: 20 };

const MUTATING_TOKENS = ["task-create", "dispatch", "terminal", "task-update"];
const FORBIDDEN_ENGINE_TOKENS = [
  "codex",
  "claude",
  "gpt",
  "opus",
  "sonnet",
  "haiku",
  "gemini",
  "cursor",
  "cline",
  "grok",
  "glm",
  "opencode",
  "engine",
  "model",
];

function fixture(name) {
  return path.join(REPO_ROOT, "tests", "relay-orca", "fixtures", name);
}

function runRun(args, env = {}) {
  const result = { status: 0, stdout: "", stderr: "" };
  try {
    result.stdout = execFileSync(process.execPath, [RUN_JS, ...args], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
  } catch (error) {
    result.status = error.status;
    result.stdout = error.stdout ? String(error.stdout) : "";
    result.stderr = error.stderr ? String(error.stderr) : "";
  }
  return result;
}

function runProgram(fixtureName, extraArgs, scenario, options = {}) {
  const fake = installFakeOrcaRun(scenario || {});
  const args = ["--json", "--orca-bin", fake.orcaPath, "--program-file", fixture(fixtureName), ...(extraArgs || [])];
  const result = runRun(args, options.env);
  result.fake = fake;
  result.body = result.stdout ? JSON.parse(result.stdout) : null;
  return result;
}

function parse(stdout) {
  return JSON.parse(String(stdout));
}

function assertReportKeys(body) {
  assert.deepEqual(Object.keys(body).sort(), [...REPORT_KEYS].sort());
}

function assertNoPoison(fake) {
  assert.equal(fake.readPoison(), null, "reset/worktree poison marker must never be written");
}

function assertNoMutations(fake) {
  const tokens = fake.readLog().join(" ");
  MUTATING_TOKENS.forEach((forbidden) => {
    assert.equal(tokens.includes(forbidden), false, `no mutating subcommand ${forbidden} allowed; log=${tokens}`);
  });
}

function taskByOutcome(body, outcomeId) {
  return body.tasks.find((task) => task.outcome_id === outcomeId);
}

// ---------------------------------------------------------------------------
// D11.1 Successful injection — 2-task wave, provenance verified
// ---------------------------------------------------------------------------

test("D11.1: 2-task wave dispatches, provenance verified, exact D10 report", () => {
  const r = runProgram("run-two-wave1.json", ["--operator-handle", "h1", "--operator-handle", "h2"]);
  try {
    assert.equal(r.status, 0);
    assertReportKeys(r.body);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.reconciliation_required, true);
    assert.equal(r.body.program_id, "epic-run-two");
    assert.equal(r.body.concurrency, 2);
    assert.equal(r.body.admission.admitted, true);
    assert.ok(r.body.admission.runtime_id, "admission echoes the probe runtime_id");
    assert.deepEqual(r.body.terminals_created, []);
    assert.deepEqual(r.body.blocking_reasons, []);
    for (const outcome of ["alpha", "bravo"]) {
      const task = taskByOutcome(r.body, outcome);
      assert.equal(task.status, "dispatched");
      // A dispatched task MUST carry the full non-null provenance trio (D6/D10).
      assert.ok(task.orca_task_id && task.dispatch_id && task.assignee);
    }
    assert.equal(taskByOutcome(r.body, "alpha").assignee, "h1");
    assert.equal(taskByOutcome(r.body, "bravo").assignee, "h2");
    // Prompt (terminal send) is delivered ONLY after dispatch-show verification.
    const log = r.fake.readLog();
    const showIdx = log.findIndex((l) => l.includes("dispatch-show --task orca-live-alpha"));
    const sendIdx = log.findIndex((l) => l.includes("terminal send --to h1"));
    assert.ok(showIdx >= 0 && sendIdx > showIdx, "prompt must be sent after verification");
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D11.2 Admission rejection — exit 40, zero mutating subcommands
// ---------------------------------------------------------------------------

test("D11.2: probe rejects admission → ADMISSION_REJECTED exit 40, zero mutations", () => {
  const status = readyStatus();
  status.result.app.running = false;
  const r = runProgram("run-two-wave1.json", ["--operator-handle", "h1"], { status });
  try {
    assert.equal(r.status, REASONS.ADMISSION_REJECTED);
    assertReportKeys(r.body);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.admission.admitted, false);
    assert.equal(r.body.blocking_reasons[0].reason_code, "ADMISSION_REJECTED");
    assert.equal(r.body.reconciliation_required, true);
    // Every plan task stays pending; NO mutating subcommand ever ran.
    r.body.tasks.forEach((task) => assert.equal(task.status, "pending"));
    assertNoMutations(r.fake);
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D11.3 Undelivered injection — exit 42, escalated, no further dispatch
// ---------------------------------------------------------------------------

test("D11.3: dispatch ok:false → INJECTION_UNDELIVERED exit 42, escalated, prior stays dispatched", () => {
  const r = runProgram(
    "run-two-wave1.json",
    ["--operator-handle", "h1", "--operator-handle", "h2"],
    { dispatchFailFor: "orca-live-bravo" },
  );
  try {
    assert.equal(r.status, REASONS.INJECTION_UNDELIVERED);
    assertReportKeys(r.body);
    assert.equal(r.body.blocking_reasons[0].reason_code, "INJECTION_UNDELIVERED");
    assert.equal(taskByOutcome(r.body, "alpha").status, "dispatched");
    assert.equal(taskByOutcome(r.body, "bravo").status, "escalated");
    // bravo never advances: no dispatch-show, no prompt hand-off after the failure.
    const log = r.fake.readLog().join(" ");
    assert.equal(log.includes("dispatch-show --task orca-live-bravo"), false);
    assert.equal(log.includes("terminal send --to h2"), false);
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D11.4 Mismatched provenance — wrong task id AND null assignee → exit 43
// ---------------------------------------------------------------------------

test("D11.4a: dispatch-show wrong task id → PROVENANCE_MISMATCH exit 43, escalated, never dispatched", () => {
  const r = runProgram(
    "valid-single-relay-run.json",
    ["--operator-handle", "h1"],
    { provenanceOverride: { task_id: "orca-live-WRONG" } },
  );
  try {
    assert.equal(r.status, REASONS.PROVENANCE_MISMATCH);
    assert.equal(r.body.blocking_reasons[0].reason_code, "PROVENANCE_MISMATCH");
    const task = taskByOutcome(r.body, "outcome-a");
    assert.equal(task.status, "escalated");
    assert.notEqual(task.status, "dispatched");
    // Prompt never handed off on an unverified task.
    assert.equal(r.fake.readLog().join(" ").includes("terminal send"), false);
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

test("D11.4b: dispatch-show null assignee → PROVENANCE_MISMATCH exit 43, escalated", () => {
  const r = runProgram(
    "valid-single-relay-run.json",
    ["--operator-handle", "h1"],
    { provenanceOverride: { assignee: null } },
  );
  try {
    assert.equal(r.status, REASONS.PROVENANCE_MISMATCH);
    assert.equal(r.body.blocking_reasons[0].reason_code, "PROVENANCE_MISMATCH");
    assert.equal(taskByOutcome(r.body, "outcome-a").status, "escalated");
    assert.equal(r.fake.readLog().join(" ").includes("terminal send"), false);
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D11.5 Partial wave dispatch — 3 eligible, concurrency 2 → 2 dispatched, 1 pending
// ---------------------------------------------------------------------------

test("D11.5: 3 eligible with concurrency 2 → 2 dispatched, 1 pending, exit 0", () => {
  const r = runProgram("run-three-wave1.json", [
    "--operator-handle",
    "h1",
    "--operator-handle",
    "h2",
    "--operator-handle",
    "h3",
  ]);
  try {
    assert.equal(r.status, 0);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.concurrency, 2);
    const dispatched = r.body.tasks.filter((t) => t.status === "dispatched");
    const pending = r.body.tasks.filter((t) => t.status === "pending");
    assert.equal(dispatched.length, 2);
    assert.equal(pending.length, 1);
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D11.6 Duplicate active guard — busy handle never reused
// ---------------------------------------------------------------------------

test("D11.6: single handle for two eligible tasks → busy handle never reused, task never dispatched twice", () => {
  const r = runProgram("run-two-wave1.json", ["--operator-handle", "h1"]);
  try {
    assert.equal(r.status, 0);
    const dispatched = r.body.tasks.filter((t) => t.status === "dispatched");
    const pending = r.body.tasks.filter((t) => t.status === "pending");
    assert.equal(dispatched.length, 1);
    assert.equal(pending.length, 1);
    assert.equal(dispatched[0].assignee, "h1");
    // h1 is targeted by exactly one dispatch; the pending task is never dispatched.
    const dispatchLines = r.fake.readLog().filter((l) => l.startsWith("orchestration dispatch --task"));
    assert.equal(dispatchLines.length, 1);
    assert.ok(dispatchLines[0].includes("--to h1"));
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D11.7 task-create failure mid-materialization — exit 41, earlier tasks listed
// ---------------------------------------------------------------------------

test("D11.7: task-create failure → TASK_MATERIALIZE_FAILED exit 41, earlier task listed, nothing cleaned", () => {
  const r = runProgram(
    "run-two-wave1.json",
    ["--operator-handle", "h1", "--operator-handle", "h2"],
    { taskCreateFailFor: "bravo" },
  );
  try {
    assert.equal(r.status, REASONS.TASK_MATERIALIZE_FAILED);
    assert.equal(r.body.blocking_reasons[0].reason_code, "TASK_MATERIALIZE_FAILED");
    // alpha materialized first and is left in place (listed with its Orca id).
    assert.equal(taskByOutcome(r.body, "alpha").orca_task_id, "orca-live-alpha");
    assert.equal(taskByOutcome(r.body, "bravo").orca_task_id, null);
    const log = r.fake.readLog().join(" ");
    assert.equal(log.includes("dispatch"), false, "no dispatch after materialize failure");
    assert.equal(log.includes("task-update"), false, "nothing is cleaned up (cleanup is #946)");
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D11.8 / D11.9 / D11.12 — plan-library codes re-raised verbatim
// ---------------------------------------------------------------------------

test("D11.8: fleet leaf without prepared artifacts → UNPREPARED_FLEET_LEAF re-raised (exit 12)", () => {
  const r = runProgram("reject-unprepared-fleet.json", []);
  try {
    assert.equal(r.status, PLAN_CODES.UNPREPARED_FLEET_LEAF);
    assert.equal(r.body.reason_code, "UNPREPARED_FLEET_LEAF");
    assert.equal(r.body.ok, false);
    // Plan rejects before admission: no Orca invocation at all.
    assert.deepEqual(r.fake.readLog(), []);
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

test("D11.9: concurrency > 4 → CONCURRENCY_EXCEEDED re-raised (exit 16)", () => {
  const r = runProgram("valid-single-relay-run.json", ["--concurrency", "9"]);
  try {
    assert.equal(r.status, PLAN_CODES.CONCURRENCY_EXCEEDED);
    assert.equal(r.body.reason_code, "CONCURRENCY_EXCEEDED");
    assert.deepEqual(r.fake.readLog(), []);
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

test("D11.12: nested relay-orca program → NESTED_RELAY_ORCA re-raised (exit 20)", () => {
  const r = runProgram("reject-nested-orca.json", []);
  try {
    assert.equal(r.status, PLAN_CODES.NESTED_RELAY_ORCA);
    assert.equal(r.body.reason_code, "NESTED_RELAY_ORCA");
    assert.deepEqual(r.fake.readLog(), []);
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D11.10 Prompt content — engine-agnostic, read-only, payload contract
// ---------------------------------------------------------------------------

test("D11.10: operator prompts carry the pinned literals and never name an engine/model", () => {
  const raw = JSON.parse(fs.readFileSync(fixture("run-all-kinds.json"), "utf-8"));
  const program = raw.program;
  const plan = compileProgram(raw);
  const outcomeById = new Map(program.outcomes.map((o) => [o.id, o]));

  const kinds = new Set();
  for (const task of plan.tasks) {
    const prompt = buildOperatorPrompt(task, program, outcomeById.get(task.outcome_id));
    kinds.add(task.kind);
    // Every prompt: full payload contract + reconciliation + lifecycle literals (D8).
    PAYLOAD_FIELDS.forEach((field) => assert.ok(prompt.includes(field), `${task.kind} prompt missing payload field ${field}`));
    assert.ok(prompt.includes(RECONCILIATION_SENTENCE), `${task.kind} prompt missing reconciliation sentence`);
    assert.ok(prompt.includes(LIFECYCLE_NOTE), `${task.kind} prompt missing lifecycle note`);
    // No executor/reviewer engine or model name anywhere.
    const lowered = prompt.toLowerCase();
    FORBIDDEN_ENGINE_TOKENS.forEach((token) =>
      assert.equal(lowered.includes(token), false, `${task.kind} prompt leaked engine/model token ${token}`),
    );
    if (task.recommended_route.read_only) {
      assert.ok(prompt.includes(READ_ONLY_MARKER), `${task.kind} read-only prompt missing read-only marker`);
      assert.ok(prompt.includes(NO_EDIT_CLAUSE), `${task.kind} read-only prompt missing no-edit clause`);
      assert.ok(prompt.includes("tracker follow-ups"), `${task.kind} read-only prompt must route findings to tracker`);
    }
    if (task.kind === "relay_fleet") {
      // Fleet prompts embed already-prepared leaf artifacts (D8).
      assert.ok(prompt.includes("/tmp/leaf1-prompt.md"));
      assert.ok(prompt.includes("/tmp/leaf1-rubric.yaml"));
      assert.ok(prompt.includes("/tmp/leaf1-dc.md"));
    }
  }
  // All five kinds were exercised.
  assert.deepEqual(
    [...kinds].sort(),
    ["advisory_review", "integration_gate", "relay_fleet", "relay_run", "tracker_reconciliation"],
  );
});

// ---------------------------------------------------------------------------
// D11.11 Poison guards — reset AND worktree hard-fail the fixture
// ---------------------------------------------------------------------------

test("D11.11: reset AND worktree subcommands poison the fixture", () => {
  const fake = installFakeOrcaRun();
  try {
    let resetStatus = 0;
    try {
      execFileSync(fake.orcaPath, ["orchestration", "reset"], { stdio: "pipe" });
    } catch (error) {
      resetStatus = error.status;
    }
    assert.equal(resetStatus, 99);
    assert.match(fake.readPoison(), /RESET_INVOKED/);
    fs.rmSync(fake.poisonPath, { force: true });

    let worktreeStatus = 0;
    try {
      execFileSync(fake.orcaPath, ["worktree", "create"], { stdio: "pipe" });
    } catch (error) {
      worktreeStatus = error.status;
    }
    assert.equal(worktreeStatus, 98);
    assert.match(fake.readPoison(), /WORKTREE_INVOKED/);
  } finally {
    fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D4/D7 — dependency-ordered materialization + later-wave pending
// ---------------------------------------------------------------------------

test("D4/D7: deps carry real Orca ids in dependency order; later-wave task stays pending", () => {
  const r = runProgram("mixed-run-fleet.json", ["--operator-handle", "h1"]);
  try {
    assert.equal(r.status, 0);
    assert.equal(taskByOutcome(r.body, "foundation").status, "dispatched");
    // fanout is wave 2 → materialized but not dispatched in this invocation.
    assert.equal(taskByOutcome(r.body, "fanout").status, "pending");
    assert.equal(taskByOutcome(r.body, "fanout").orca_task_id, "orca-live-fanout");
    // The fanout task-create passes the real Orca id of its dependency via --deps.
    const fanoutCreate = r.fake
      .readLog()
      .find((l) => l.includes("task-create") && l.includes("epic-demo-mixed/fanout"));
    assert.ok(fanoutCreate.includes('--deps ["orca-live-foundation"]'), `deps missing: ${fanoutCreate}`);
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D5 — self-created terminals recorded; D7 — OPERATOR_DISPATCH_FAILED
// ---------------------------------------------------------------------------

test("D5: no explicit handle → run creates terminals and records them", () => {
  const r = runProgram("run-two-wave1.json", []);
  try {
    assert.equal(r.status, 0);
    assert.equal(r.body.terminals_created.length, 2);
    r.body.tasks.forEach((task) => {
      assert.equal(task.status, "dispatched");
      assert.ok(r.body.terminals_created.includes(task.assignee));
    });
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

test("D7: terminal create yields no usable handle → OPERATOR_DISPATCH_FAILED exit 44", () => {
  const r = runProgram("run-two-wave1.json", [], { terminalCreateEmptyHandle: true });
  try {
    assert.equal(r.status, REASONS.OPERATOR_DISPATCH_FAILED);
    assert.equal(r.body.blocking_reasons[0].reason_code, "OPERATOR_DISPATCH_FAILED");
    // No task ever became dispatched.
    assert.equal(r.body.tasks.every((t) => t.status !== "dispatched"), true);
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Usage errors exit 64
// ---------------------------------------------------------------------------

test("usage: unknown flag exits 64", () => {
  const r = runRun(["--program-file", fixture("run-two-wave1.json"), "--not-a-flag"]);
  assert.equal(r.status, 64);
});

test("usage: missing --program-file exits 64", () => {
  const r = runRun(["--json"]);
  assert.equal(r.status, 64);
});

// Keep the imported parse helper referenced.
void parse;
