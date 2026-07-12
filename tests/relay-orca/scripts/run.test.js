"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPTS = path.join(REPO_ROOT, "skills", "relay-orca", "scripts");
const RUN_JS = path.join(SCRIPTS, "run.js");

const { REASONS } = require(path.join(SCRIPTS, "lib", "run-reasons.js"));
const { REPORT_KEYS } = require(path.join(SCRIPTS, "lib", "run-report.js"));
const { compileProgram } = require(path.join(SCRIPTS, "lib", "compile-program.js"));
const { RECEIPT_KEYS, TASK_KEYS, RECEIPT_NOTE, parseReceipt } = require(path.join(SCRIPTS, "lib", "receipt.js"));
const { computeRepoSlug } = require(path.join(SCRIPTS, "lib", "repo-slug.js"));
const { writeReceiptAtomic, programSegment } = require(path.join(SCRIPTS, "receipt-io.js"));
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

// Isolate receipt persistence (#945 D2) into temp roots so run tests never touch the
// real ~/.relay: a temp programs root + a temp --repo-root (realpath'd for a stable
// slug). fake.cleanup() is extended to remove them.
function makeReceiptWorld() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-run-receipt-"));
  const programsRoot = path.join(base, "programs");
  const repoRoot = path.join(base, "repo");
  fs.mkdirSync(programsRoot, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  return { base, programsRoot, repoRoot, slug: computeRepoSlug(fs.realpathSync(repoRoot)) };
}

function receiptPathForWorld(world, programId) {
  // Use the SAME collision-resistant segment encoder run.js/status.js use (#945 A6),
  // so the expected path stays in lock-step with the production path derivation.
  return path.join(world.programsRoot, world.slug, programSegment(programId), "receipt.json");
}

// A22 harness: a REAL primary git checkout plus a LINKED WORKTREE whose `.git` FILE points
// at the primary's git-common-dir. `--repo-root` is pointed at the worktree; run.js must
// canonicalize it through git to the PRIMARY root so the receipt lands under the primary
// slug (`primarySlug`), NOT the worktree-directory slug (`worktreeSlug`).
function makeGitWorktreeReceiptWorld() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-run-worktree-"));
  const programsRoot = path.join(base, "programs");
  const primary = path.join(base, "primary");
  const worktree = path.join(base, "wt");
  fs.mkdirSync(programsRoot, { recursive: true });
  fs.mkdirSync(primary, { recursive: true });
  const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"], primary);
  git(["config", "user.email", "t@t.com"], primary);
  git(["config", "user.name", "t"], primary);
  git(["commit", "-q", "--allow-empty", "-m", "init"], primary);
  git(["worktree", "add", "-q", "--detach", worktree, "HEAD"], primary);
  const primaryRoot = fs.realpathSync(primary);
  return {
    base,
    programsRoot,
    primary,
    worktree,
    primaryRoot,
    primarySlug: computeRepoSlug(primaryRoot),
    worktreeSlug: computeRepoSlug(fs.realpathSync(worktree)),
  };
}

function runProgram(fixtureName, extraArgs, scenario, options = {}) {
  const fake = installFakeOrcaRun(scenario || {});
  const world = makeReceiptWorld();
  const args = [
    "--json",
    "--orca-bin",
    fake.orcaPath,
    "--repo-root",
    world.repoRoot,
    "--program-file",
    fixture(fixtureName),
    ...(extraArgs || []),
  ];
  const result = runRun(args, { RELAY_ORCA_PROGRAMS_ROOT: world.programsRoot, ...options.env });
  result.fake = fake;
  result.world = world;
  const origCleanup = fake.cleanup;
  fake.cleanup = () => {
    origCleanup();
    fs.rmSync(world.base, { recursive: true, force: true });
  };
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
// A12 — partial materialization persists earlier mappings before failing (exit 41)
// ---------------------------------------------------------------------------

test("A12: a mid-wave task-create failure persists the earlier task's orca_task_id to disk, then exits 41", () => {
  const r = runProgram(
    "run-two-wave1.json",
    ["--operator-handle", "h1", "--operator-handle", "h2"],
    { taskCreateFailFor: "bravo" },
  );
  try {
    // The run still fails closed with TASK_MATERIALIZE_FAILED (exit 41)...
    assert.equal(r.status, REASONS.TASK_MATERIALIZE_FAILED);
    assert.equal(r.body.blocking_reasons[0].reason_code, "TASK_MATERIALIZE_FAILED");

    // ...but because the receipt is persisted after EACH successful task-create (A12),
    // the receipt ON DISK already carries alpha's orca_task_id even though bravo's
    // create failed and no post-materialization write ever ran.
    const receiptPath = receiptPathForWorld(r.world, "epic-run-two");
    assert.ok(fs.existsSync(receiptPath), "the partial mapping is durable on disk");
    assert.equal(r.body.receipt_path, receiptPath, "the report echoes the partially-written receipt path");
    const parsed = parseReceipt(fs.readFileSync(receiptPath, "utf-8"));
    assert.equal(parsed.ok, true, `partial receipt must parse+validate: ${parsed.reason || ""}`);
    assert.equal(taskByOutcome(parsed.receipt, "alpha").orca_task_id, "orca-live-alpha", "alpha's mapping survived the later failure");
    assert.equal(taskByOutcome(parsed.receipt, "bravo").orca_task_id, null, "the failed create leaves bravo unmapped");
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

// ---------------------------------------------------------------------------
// #945 D1/D2 — receipt persistence wired into the run intent
// ---------------------------------------------------------------------------

test("D2: a successful run persists a schema-1 receipt (identity/mapping only) and reports receipt_path", () => {
  const r = runProgram("run-two-wave1.json", ["--operator-handle", "h1", "--operator-handle", "h2"]);
  try {
    assert.equal(r.status, 0);
    const receiptPath = receiptPathForWorld(r.world, "epic-run-two");
    assert.equal(r.body.receipt_path, receiptPath, "receipt_path echoes the atomically-written receipt");
    assert.ok(fs.existsSync(receiptPath), "receipt file exists on disk");

    const parsed = parseReceipt(fs.readFileSync(receiptPath, "utf-8"));
    assert.equal(parsed.ok, true, `receipt must parse+validate: ${parsed.reason || ""}`);
    const receipt = parsed.receipt;
    assert.deepEqual(Object.keys(receipt).sort(), [...RECEIPT_KEYS].sort());
    assert.equal(receipt.schema, 1);
    assert.equal(receipt.note, RECEIPT_NOTE, "verbatim authority-disclaimer note");
    assert.equal(receipt.program_id, "epic-run-two");
    assert.equal(receipt.repo.slug, r.world.slug);
    assert.equal(receipt.repo.root, fs.realpathSync(r.world.repoRoot));
    assert.ok(receipt.runtime_id, "runtime_id captured from admission");
    assert.match(receipt.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(receipt.updated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(receipt.terminals_created, []);

    // Each task entry carries EXACTLY the identity/mapping keys — never lifecycle
    // state, PR/issue status, completion flags, prompts, or terminal output.
    assert.equal(receipt.tasks.length, 2);
    receipt.tasks.forEach((task) => {
      assert.deepEqual(Object.keys(task).sort(), [...TASK_KEYS].sort());
      assert.ok(task.orca_task_id, "materialized orca id recorded");
      assert.ok(task.dispatch_id, "dispatch id recorded after verification");
      assert.deepEqual(task.relay_ids, { request: null, run: null, fleet: null });
    });
    assert.equal(taskByOutcome(receipt, "alpha").assignee, "h1");
    assert.equal(taskByOutcome(receipt, "bravo").assignee, "h2");

    // D11-style engine-agnostic proof over the written receipt bytes.
    const lowered = fs.readFileSync(receiptPath, "utf-8").toLowerCase();
    FORBIDDEN_ENGINE_TOKENS.forEach((token) =>
      assert.equal(lowered.includes(token), false, `receipt leaked engine/model token ${token}`),
    );
  } finally {
    r.fake.cleanup();
  }
});

test("A22: run --repo-root pointed at a LINKED WORKTREE writes the receipt under the PRIMARY slug (git-canonical repo root)", () => {
  // The provided --repo-root is a linked worktree whose `.git` FILE points at the primary
  // checkout's git-common-dir. run.js canonicalizes it through git to the PRIMARY root, so the
  // receipt lands under the primary slug — the SAME slug status derives from the same worktree
  // input (both call resolveRepoContext). A plain-realpath resolver would have used the
  // worktree-directory slug and written the receipt somewhere status could never find it.
  const world = makeGitWorktreeReceiptWorld();
  const fake = installFakeOrcaRun({});
  try {
    assert.notEqual(world.primarySlug, world.worktreeSlug, "the worktree dir slug differs from the primary slug");
    const r = runRun(
      [
        "--json",
        "--orca-bin",
        fake.orcaPath,
        "--repo-root",
        world.worktree,
        "--program-file",
        fixture("run-two-wave1.json"),
        "--operator-handle",
        "h1",
        "--operator-handle",
        "h2",
      ],
      { RELAY_ORCA_PROGRAMS_ROOT: world.programsRoot },
    );
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    // The receipt is written under the PRIMARY slug, never the worktree-directory slug.
    const primaryPath = path.join(world.programsRoot, world.primarySlug, programSegment("epic-run-two"), "receipt.json");
    const worktreePath = path.join(world.programsRoot, world.worktreeSlug, programSegment("epic-run-two"), "receipt.json");
    assert.equal(body.receipt_path, primaryPath, "receipt_path is under the canonical PRIMARY slug");
    assert.ok(fs.existsSync(primaryPath), "receipt exists under the primary slug");
    assert.equal(fs.existsSync(worktreePath), false, "no receipt is written under the worktree-directory slug");
    const receipt = parseReceipt(fs.readFileSync(primaryPath, "utf-8")).receipt;
    assert.equal(receipt.repo.slug, world.primarySlug, "receipt records the primary slug");
    assert.equal(receipt.repo.root, world.primaryRoot, "receipt records the canonical primary root");
  } finally {
    fake.cleanup();
    fs.rmSync(world.base, { recursive: true, force: true });
  }
});

test("D2: an admission rejection never writes a receipt (persist happens after materialization)", () => {
  const status = readyStatus();
  status.result.app.running = false;
  const r = runProgram("run-two-wave1.json", ["--operator-handle", "h1"], { status });
  try {
    assert.equal(r.status, REASONS.ADMISSION_REJECTED);
    assert.equal(r.body.receipt_path, null);
    assert.equal(fs.existsSync(receiptPathForWorld(r.world, "epic-run-two")), false);
  } finally {
    r.fake.cleanup();
  }
});

test("A2: a prompt-delivery failure still leaves the receipt carrying the verified provenance trio", () => {
  // sendPrompt (terminal send) fails AFTER dispatch-show verifies the provenance trio.
  // The receipt must already carry the non-null (orca_task_id, dispatch_id, assignee)
  // for the escalated outcome — provenance persists BEFORE prompt delivery (A2) — while
  // the failure's report semantics stay exactly as before (INJECTION_UNDELIVERED, exit 42).
  const r = runProgram("valid-single-relay-run.json", ["--operator-handle", "h1"], { terminalSendOkFalse: true });
  try {
    assert.equal(r.status, REASONS.INJECTION_UNDELIVERED);
    assert.equal(r.body.blocking_reasons[0].reason_code, "INJECTION_UNDELIVERED");
    const task = taskByOutcome(r.body, "outcome-a");
    assert.equal(task.status, "escalated");

    const receiptPath = receiptPathForWorld(r.world, "epic-demo-single");
    assert.ok(fs.existsSync(receiptPath), "receipt persisted before the prompt hand-off failed");
    const parsed = parseReceipt(fs.readFileSync(receiptPath, "utf-8"));
    assert.equal(parsed.ok, true, `receipt must parse+validate: ${parsed.reason || ""}`);
    const entry = taskByOutcome(parsed.receipt, "outcome-a");
    // The full verified provenance trio is durable despite the prompt failure.
    assert.ok(entry.orca_task_id, "orca_task_id persisted");
    assert.ok(entry.dispatch_id, "dispatch_id persisted before prompt delivery");
    assert.ok(entry.assignee, "assignee persisted before prompt delivery");
    assert.equal(entry.assignee, "h1");
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

test("A16: a dispatch failure right after an AUTO-created terminal leaves the on-disk receipt already carrying the handle", () => {
  // No explicit --operator-handle → run auto-creates a terminal ("orca-term-1"), records
  // it, and (A16) persists the receipt IMMEDIATELY — BEFORE the dispatch. The dispatch then
  // fails (INJECTION_UNDELIVERED, exit 42) before any provenance-verification write could run.
  // Without the immediate persist the mapping-changing writes only happen after dispatch-show,
  // so the handle would be lost from disk; A16 makes the created terminal durable so a
  // reconcile can adopt (not re-create) it.
  const r = runProgram("valid-single-relay-run.json", [], { dispatchFailFor: "orca-live-outcome-a" });
  try {
    assert.equal(r.status, REASONS.INJECTION_UNDELIVERED);
    assert.equal(r.body.blocking_reasons[0].reason_code, "INJECTION_UNDELIVERED");
    assert.equal(taskByOutcome(r.body, "outcome-a").status, "escalated");
    // The in-memory report is truthful about the auto-created terminal...
    assert.deepEqual(r.body.terminals_created, ["orca-term-1"]);

    // ...and so is the receipt ON DISK, written before the failing dispatch.
    const receiptPath = receiptPathForWorld(r.world, "epic-demo-single");
    assert.ok(fs.existsSync(receiptPath), "receipt persisted right after the terminal was created");
    assert.equal(r.body.receipt_path, receiptPath, "the report echoes the persisted receipt path");
    const parsed = parseReceipt(fs.readFileSync(receiptPath, "utf-8"));
    assert.equal(parsed.ok, true, `receipt must parse+validate: ${parsed.reason || ""}`);
    assert.deepEqual(parsed.receipt.terminals_created, ["orca-term-1"], "the created terminal handle is durable despite the dispatch failure");
    assertNoPoison(r.fake);
  } finally {
    r.fake.cleanup();
  }
});

test("D10.12: writeReceiptAtomic is temp+rename — a crash during rename leaves no partial receipt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-atomic-"));
  const finalPath = path.join(dir, "nested", "receipt.json");
  const crashingIo = {
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    renameSync: () => {
      throw new Error("crash during publish");
    },
  };
  assert.throws(() => writeReceiptAtomic(finalPath, '{"schema":1}\n', crashingIo));
  assert.equal(fs.existsSync(finalPath), false, "the published receipt never appears when rename crashes");
  const leftovers = fs.readdirSync(path.dirname(finalPath));
  assert.ok(leftovers.some((name) => name.startsWith(".receipt.")), "the temp file lives in the SAME directory");
  assert.ok(leftovers.every((name) => name !== "receipt.json"), "no torn receipt.json is published");

  // Happy path: rename publishes exactly the final file with the full contents.
  const published = writeReceiptAtomic(finalPath, '{"schema":1}\n');
  assert.equal(published, finalPath);
  assert.equal(fs.readFileSync(finalPath, "utf-8"), '{"schema":1}\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test("D1/A6: programSegment is traversal-safe AND collision-resistant (sanitized base + stable hash)", () => {
  // Traversal neutralized: no separators, and `.` / `..` collapse to the `program` base.
  assert.ok(!programSegment("../../etc/passwd").includes("/"));
  assert.match(programSegment("../../etc/passwd"), /^\.\.-\.\.-etc-passwd-[0-9a-f]{8}$/);
  assert.match(programSegment(".."), /^program-[0-9a-f]{8}$/);
  assert.match(programSegment("."), /^program-[0-9a-f]{8}$/);
  // `.` and `..` sanitize identically but MUST NOT collide (distinct paths).
  assert.notEqual(programSegment("."), programSegment(".."));

  // Collision resistance: two ids that sanitize to the SAME base get DISTINCT segments.
  assert.match(programSegment("a b"), /^a-b-[0-9a-f]{8}$/);
  assert.match(programSegment("a+b"), /^a-b-[0-9a-f]{8}$/);
  assert.notEqual(programSegment("a b"), programSegment("a+b"));

  // Stable + deterministic: the same id always yields the same segment.
  assert.equal(programSegment("epic-941"), programSegment("epic-941"));
  assert.match(programSegment("epic-941"), /^epic-941-[0-9a-f]{8}$/);
  assert.match(programSegment("epic.941_v2"), /^epic\.941_v2-[0-9a-f]{8}$/);
});

test("A15: a very long program id yields a bounded segment that writes+loads a receipt; shared 64-char prefixes stay distinct", () => {
  const longId = "z".repeat(300);
  const seg = programSegment(longId);
  // The readable prefix is capped at 64 chars; the whole segment (≤ 64 + "-" + 8 hex)
  // stays well under the filesystem per-segment name limit (NAME_MAX ~255).
  assert.ok(seg.length <= 64 + 1 + 8, `segment must be bounded, got ${seg.length}`);
  assert.match(seg, /^z{64}-[0-9a-f]{8}$/);

  // The derived path must WRITE and LOAD a receipt without an ENAMETOOLONG error — the
  // whole point of the bound (the un-truncated ~308-char segment would overflow NAME_MAX).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-longseg-"));
  try {
    const finalPath = path.join(dir, programSegment(longId), "receipt.json");
    const text = `${JSON.stringify({ schema: 1, program_id: longId }, null, 2)}\n`;
    const written = writeReceiptAtomic(finalPath, text);
    assert.equal(written, finalPath);
    assert.equal(fs.readFileSync(finalPath, "utf-8"), text, "the long-id receipt round-trips on disk");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Two distinct 300-char ids sharing the SAME 64-char readable prefix must NOT collide:
  // the hash (over the full raw id, not the truncated prefix) keeps them on distinct paths.
  const sharedPrefix = "p".repeat(64);
  const idA = `${sharedPrefix}${"a".repeat(236)}`;
  const idB = `${sharedPrefix}${"b".repeat(236)}`;
  assert.equal(programSegment(idA).length, programSegment(idB).length);
  assert.match(programSegment(idA), /^p{64}-[0-9a-f]{8}$/);
  assert.match(programSegment(idB), /^p{64}-[0-9a-f]{8}$/);
  assert.notEqual(programSegment(idA), programSegment(idB), "shared 64-char prefixes must resolve to distinct segments");
});

// Keep the imported parse helper referenced.
void parse;
