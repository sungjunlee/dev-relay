"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPTS = path.join(REPO_ROOT, "skills", "relay-orca", "scripts");
const RESUME_JS = path.join(SCRIPTS, "resume.js");
const STATUS_JS = path.join(SCRIPTS, "status.js");

const { REPORT_KEYS, ACTIONS } = require(path.join(SCRIPTS, "lib", "resume-report.js"));
const { REASONS: RESUME_REASONS } = require(path.join(SCRIPTS, "lib", "resume-reasons.js"));
const { RECEIPT_NOTE, parseReceipt, serializeReceipt, serializeReceiptWithStop } = require(path.join(SCRIPTS, "lib", "receipt.js"));
const { computeRepoSlug } = require(path.join(SCRIPTS, "lib", "repo-slug.js"));
const { programSegment } = require(path.join(SCRIPTS, "receipt-io.js"));
const { integrationBlockingEntry } = require(RESUME_JS);
const { installFakeOrcaResume } = require(path.join(__dirname, "..", "fixtures", "fake-orca-resume.js"));
const { installFakeGh } = require(path.join(__dirname, "..", "fixtures", "fake-gh.js"));
const { DEFAULT_RUNTIME_ID } = require(path.join(__dirname, "..", "fixtures", "fake-orca.js"));

const FOLLOWUP_LATER_WAVE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "followup-later-wave.json"), "utf-8")).program;
const RESUME_THREE_WAVE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "resume-three-wave.json"), "utf-8")).program;

const FORBIDDEN_ENGINE_TOKENS = ["codex", "claude", "gpt", "opus", "sonnet", "haiku", "gemini", "cursor", "cline", "grok", "glm", "opencode"];
const CANCELLATION_TOKENS = ["cancel", "cancelled", "canceled", "complete", "completed", "aborted", "discard"];

// --- receipt / manifest / scenario builders ------------------------------------

function makeReceipt({ programId, slug, root, runtimeId, tasks, stop }) {
  const receipt = {
    schema: 1,
    program_id: programId,
    source: "/tmp/accepted-program.json",
    repo: { slug, root },
    runtime_id: runtimeId || DEFAULT_RUNTIME_ID,
    tasks: tasks.map((task) => {
      const orcaTaskId = task.orca_task_id === undefined ? `orca-live-${task.outcome_id}` : task.orca_task_id;
      const defaultDispatchId = orcaTaskId ? `disp-${orcaTaskId}` : null;
      return {
        outcome_id: task.outcome_id,
        task_id: task.task_id || `orca-task-${task.outcome_id}`,
        kind: task.kind || "relay_run",
        wave: task.wave || 1,
        orca_task_id: orcaTaskId,
        dispatch_id: task.dispatch_id === undefined ? defaultDispatchId : task.dispatch_id,
        assignee: task.assignee === undefined ? `term-${task.outcome_id}` : task.assignee,
        relay_ids: { request: null, run: task.run || null, fleet: task.fleet || null },
      };
    }),
    terminals_created: [],
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    note: RECEIPT_NOTE,
  };
  if (stop) {
    receipt.stopped_at = stop.stopped_at;
    receipt.stop_reason = stop.stop_reason;
  }
  return receipt;
}

function manifestText(fields) {
  const lines = ["---", "relay_version: 2", `run_id: '${fields.run_id}'`, `state: '${fields.state}'`, "git:"];
  lines.push(fields.pr_number != null ? `  pr_number: ${fields.pr_number}` : "  pr_number: null");
  lines.push(`  working_branch: '${fields.working_branch || `${fields.run_id}-branch`}'`);
  lines.push(`  base_branch: '${fields.base_branch || "main"}'`);
  if (fields.head_sha) lines.push(`  head_sha: '${fields.head_sha}'`);
  lines.push("issue:");
  lines.push(fields.issue_number != null ? `  number: ${fields.issue_number}` : "  number: null");
  lines.push("  source: 'github'");
  lines.push("---");
  lines.push("# Notes");
  if (fields.body) lines.push(fields.body);
  return `${lines.join("\n")}\n`;
}

function orcaTask(programId, outcome, extra = {}) {
  return {
    id: `orca-live-${outcome}`,
    // D4: the real task-list row carries `task_title` (and `display_name`), never `title`.
    task_title: `relay-orca: ${programSegment(programId)}/${outcome}`,
    display_name: `relay-orca: ${programSegment(programId)}/${outcome}`,
    status: extra.status || "dispatched",
    worker_done: extra.worker_done === true,
  };
}

// A task-list entry NOT marked for this program — makes the runtime foreign_state.
function foreignTask(id) {
  return { id, task_title: `relay-orca: other-program/${id}`, status: "dispatched", worker_done: false };
}

// A dispatch-show seed modeling GENUINE absence (owner amendment A1, #946 R1): the Orca
// task exists (materialized) but was never dispatched, so dispatch-show reports NO
// dispatch and no terminal. This live-absent read is the ONLY thing that qualifies an
// outcome as verifiably-absent for re-dispatch — a null receipt dispatch_id alone does
// not. Without this seed the fake reports a PRESENT dispatch (the crash-window state).
function absentDispatch(...outcomes) {
  const seed = {};
  outcomes.forEach((outcome) => {
    seed[`orca-live-${outcome}`] = { dispatch_id: null, terminal_present: false, assignee: null };
  });
  return seed;
}

function initGitRepo(root) {
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
}

function buildWorld({ programId, receipt, manifests = [], fleetManifests = [], orcaScenario = {}, ghScenario = {}, runtimeId, corruptReceipt }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-resume-"));
  const repoRoot = path.join(base, "repo");
  const programsRoot = path.join(base, "programs");
  const runsRoot = path.join(base, "runs");
  const fleetsRoot = path.join(base, "fleets");
  fs.mkdirSync(repoRoot, { recursive: true });
  initGitRepo(repoRoot);
  const slug = computeRepoSlug(fs.realpathSync(repoRoot));

  const receiptDir = path.join(programsRoot, slug, programSegment(programId));
  fs.mkdirSync(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, "receipt.json");
  if (corruptReceipt !== undefined) {
    fs.writeFileSync(receiptPath, corruptReceipt, "utf-8");
  } else {
    const receiptObject = receipt || makeReceipt({ programId, slug, root: fs.realpathSync(repoRoot), runtimeId, tasks: [] });
    if (receiptObject.repo && receiptObject.repo.slug === "__SELF__") receiptObject.repo.slug = slug;
    fs.writeFileSync(receiptPath, serializeReceipt(receiptObject), "utf-8");
  }

  const runsDir = path.join(runsRoot, slug);
  fs.mkdirSync(runsDir, { recursive: true });
  const fleetsDir = path.join(fleetsRoot, slug);
  fs.mkdirSync(fleetsDir, { recursive: true });
  manifests.forEach((fields) => fs.writeFileSync(path.join(runsDir, `${fields.run_id}.md`), manifestText(fields), "utf-8"));
  // Fleet manifests live under the SEPARATE fleets root (#945 A8), keyed by fleet id.
  fleetManifests.forEach((fields) => fs.writeFileSync(path.join(fleetsDir, `${fields.run_id}.md`), manifestText(fields), "utf-8"));

  const orca = installFakeOrcaResume({ runtimeId: runtimeId || DEFAULT_RUNTIME_ID, ...orcaScenario });
  const gh = installFakeGh(ghScenario);

  return {
    base,
    repoRoot,
    programsRoot,
    runsRoot,
    fleetsRoot,
    slug,
    receiptPath,
    orca,
    gh,
    receiptOnDisk() {
      return fs.readFileSync(receiptPath, "utf-8");
    },
    run(extraArgs = []) {
      const args = [RESUME_JS, "--program-id", programId, "--json", "--orca-bin", orca.orcaPath, "--gh-bin", gh.ghPath, "--repo-root", repoRoot, ...extraArgs];
      const result = { status: 0, stdout: "", stderr: "" };
      try {
        result.stdout = execFileSync(process.execPath, args, {
          encoding: "utf-8",
          env: { ...process.env, RELAY_ORCA_PROGRAMS_ROOT: programsRoot, RELAY_ORCA_RUNS_ROOT: runsRoot, RELAY_ORCA_FLEETS_ROOT: fleetsRoot },
          stdio: "pipe",
        });
      } catch (error) {
        result.status = error.status;
        result.stdout = error.stdout ? String(error.stdout) : "";
        result.stderr = error.stderr ? String(error.stderr) : "";
      }
      result.body = result.stdout ? JSON.parse(result.stdout) : null;
      return result;
    },
    cleanup() {
      orca.cleanup();
      gh.cleanup();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function actionFor(body, outcomeId) {
  return body.actions.find((entry) => entry.outcome_id === outcomeId);
}

function acceptedProgramFile(world, programId, outcomes) {
  const programPath = path.join(world.base, "accepted-program.json");
  fs.writeFileSync(programPath, `${JSON.stringify({ program: { id: programId, outcomes } }, null, 2)}\n`, "utf-8");
  return programPath;
}

function mappedRun(world, outcomeId) {
  const parsed = parseReceipt(world.receiptOnDisk());
  assert.equal(parsed.ok, true, parsed.reason || "receipt parses");
  return parsed.receipt.tasks.find((task) => task.outcome_id === outcomeId).relay_ids.run;
}

function runStatus(world, programId) {
  const args = [STATUS_JS, "--program-id", programId, "--json", "--orca-bin", world.orca.orcaPath, "--gh-bin", world.gh.ghPath, "--repo-root", world.repoRoot];
  const stdout = execFileSync(process.execPath, args, {
    encoding: "utf-8",
    env: {
      ...process.env,
      RELAY_ORCA_PROGRAMS_ROOT: world.programsRoot,
      RELAY_ORCA_RUNS_ROOT: world.runsRoot,
      RELAY_ORCA_FLEETS_ROOT: world.fleetsRoot,
    },
    stdio: "pipe",
  });
  return JSON.parse(stdout);
}

// Mutating Orca subcommand lines (dispatch --inject / terminal create / terminal send /
// task-create) — dispatch-show is a READ and is excluded.
function mutationLines(log) {
  return log.filter(
    (line) =>
      line.startsWith("orchestration dispatch --task") ||
      line.startsWith("terminal create") ||
      line.startsWith("terminal send") ||
      line.startsWith("orchestration task-create"),
  );
}

function assertNoPoison(world) {
  assert.equal(world.orca.readPoison(), null, "reset/worktree poison must never fire");
  assert.equal(world.gh.readPoison(), null, "gh write poison must never fire");
}

function assertReportShape(body) {
  assert.deepEqual(Object.keys(body).sort(), [...REPORT_KEYS].sort());
  assert.equal(body.reconciliation_required, true);
  body.actions.forEach((entry) => {
    assert.deepEqual(Object.keys(entry).sort(), ["action", "outcome_id", "reason"]);
    assert.ok(ACTIONS.includes(entry.action), `action ${entry.action} in the pinned enum`);
  });
  body.decision_required.forEach((entry) => {
    assert.deepEqual(Object.keys(entry).sort(), ["message", "options", "reason_code"]);
  });
}

// ---------------------------------------------------------------------------
// D9.1 — coordinator death, children alive: reuse everything, zero mutation
// ---------------------------------------------------------------------------

test("D9.1: coordinator death, children alive → all mappings reused, zero mutations, children untouched", () => {
  const programId = "epic-resume-coord-death";
  const world = buildWorld({
    programId,
    manifests: [
      { run_id: "run-a", state: "dispatched", pr_number: 10, issue_number: 100 },
      { run_id: "run-b", state: "review_pending", pr_number: 11, issue_number: 101 },
    ],
    orcaScenario: { tasks: [orcaTask(programId, "a"), orcaTask(programId, "b")] },
    ghScenario: { prs: { 10: { state: "OPEN" }, 11: { state: "OPEN" } }, issues: { 100: { state: "OPEN" }, 101: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "a", run: "run-a" }, { outcome_id: "b", run: "run-b" }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  const before = world.receiptOnDisk();
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assertReportShape(r.body);
    assert.equal(r.body.runtime, "ok");
    assert.equal(actionFor(r.body, "a").action, "reused");
    assert.equal(actionFor(r.body, "b").action, "reused");
    assert.deepEqual(r.body.terminals_created, []);
    assert.deepEqual(r.body.decision_required, []);
    assert.deepEqual(mutationLines(world.orca.readLog()), [], "zero mutating subcommands");
    assert.equal(world.receiptOnDisk(), before, "receipt untouched when nothing is re-dispatched");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.2 — Orca runtime restart (live id != receipt) → exit 60, zero mutation
// ---------------------------------------------------------------------------

test("D9.2: runtime restart (live id != receipt) → RESUME_RUNTIME_CHANGED exit 60, zero mutation", () => {
  const programId = "epic-resume-runtime-changed";
  const world = buildWorld({
    programId,
    runtimeId: DEFAULT_RUNTIME_ID,
    orcaScenario: { runtimeId: "99999999-9999-4999-8999-999999999999", tasks: [] },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), runtimeId: DEFAULT_RUNTIME_ID, tasks: [{ outcome_id: "a" }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  const before = world.receiptOnDisk();
  try {
    const r = world.run();
    assert.equal(r.status, RESUME_REASONS.RESUME_RUNTIME_CHANGED);
    assert.equal(r.status, 60);
    assertReportShape(r.body);
    assert.equal(r.body.runtime, "mismatch");
    assert.equal(r.body.ok, false);
    assert.ok(r.body.decision_required.some((d) => d.reason_code === "RESUME_RUNTIME_CHANGED"));
    assert.deepEqual(mutationLines(world.orca.readLog()), [], "no mutation on a runtime-changed abort");
    assert.equal(world.receiptOnDisk(), before, "receipt byte-identical on abort");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.3 — operator terminal loss → replacement terminal, receipt updated, verified
// ---------------------------------------------------------------------------

test("D9.3: terminal loss on a resumable outcome → terminal reacquired via inject->dispatch-show, receipt updated immediately", () => {
  const programId = "epic-resume-term-loss";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-a", state: "dispatched", pr_number: 10, issue_number: 100 }],
    orcaScenario: { tasks: [orcaTask(programId, "a")], dispatch: { "orca-live-a": { terminal_present: false } } },
    ghScenario: { prs: { 10: { state: "OPEN" } }, issues: { 100: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "a", run: "run-a" }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  try {
    const r = world.run(["--operator-handle", "h-reacq"]);
    assert.equal(r.status, 0);
    assertReportShape(r.body);
    assert.equal(actionFor(r.body, "a").action, "redispatched");
    // Explicit-handles-only (D3): resume reacquires through the PROVIDED handle and never
    // self-creates a terminal, so terminals_created stays [] on every path.
    assert.deepEqual(r.body.terminals_created, []);
    const log = world.orca.readLog();
    assert.ok(!log.some((l) => l.startsWith("terminal create")), "resume never creates its own terminal");
    assert.ok(log.some((l) => l.startsWith("orchestration dispatch --task orca-live-a")), "re-injected through dispatch");
    assert.ok(log.some((l) => l.startsWith("orchestration dispatch-show --task orca-live-a")), "provenance re-verified through dispatch-show");
    // The provided handle is recorded as the reacquired outcome's assignee, persisted at A2.
    const persisted = parseReceipt(world.receiptOnDisk()).receipt;
    assert.deepEqual(persisted.terminals_created, []);
    assert.equal(persisted.tasks[0].assignee, "h-reacq", "reacquired terminal recorded as the outcome assignee");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.4 — live child continuation: in-flight relay run is NEVER re-dispatched
// ---------------------------------------------------------------------------

test("D9.4: in-flight relay run (absent Orca dispatch) is skipped, never re-dispatched", () => {
  const programId = "epic-resume-live-child";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-live", state: "review_pending", pr_number: 20, issue_number: 200 }],
    orcaScenario: { tasks: [orcaTask(programId, "a")], dispatch: absentDispatch("a") },
    ghScenario: { prs: { 20: { state: "OPEN" } }, issues: { 200: { state: "OPEN" } } },
  });
  // Orca dispatch verifiably absent (live dispatch-show reports none) but the relay side is in-flight.
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "a", dispatch_id: null, assignee: null, run: "run-live" }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  const before = world.receiptOnDisk();
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(actionFor(r.body, "a").action, "skipped");
    assert.deepEqual(mutationLines(world.orca.readLog()), [], "an in-flight relay run is never re-dispatched");
    assert.equal(world.receiptOnDisk(), before, "the in-flight child's mapping is untouched");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.6 — partial dispatch: only the verifiably-absent, relay-clean outcome dispatches
// ---------------------------------------------------------------------------

function partialWorld(programId) {
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-a", state: "dispatched", pr_number: 10, issue_number: 100 }],
    // Outcome b's dispatch is verifiably absent via a live dispatch-show read (A1).
    orcaScenario: { tasks: [orcaTask(programId, "a"), orcaTask(programId, "b")], dispatch: absentDispatch("b") },
    ghScenario: { prs: { 10: { state: "OPEN" } }, issues: { 100: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [
      { outcome_id: "a", run: "run-a" }, // dispatched + live → reused
      { outcome_id: "b", dispatch_id: null, assignee: null }, // never dispatched, relay clean, wave 1 → redispatch
    ],
  });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  return world;
}

test("D9.6: partial dispatch → only the absent+clean outcome dispatches, through the verified path", () => {
  const programId = "epic-resume-partial";
  const world = partialWorld(programId);
  try {
    const r = world.run(["--operator-handle", "h1"]);
    assert.equal(r.status, 0);
    assert.equal(actionFor(r.body, "a").action, "reused");
    assert.equal(actionFor(r.body, "b").action, "redispatched");
    const injects = world.orca.readLog().filter((l) => l.startsWith("orchestration dispatch --task"));
    assert.equal(injects.length, 1, "exactly one re-dispatch");
    assert.ok(injects[0].includes("orca-live-b"), "only the absent outcome b is dispatched");
    assert.ok(!injects.some((l) => l.includes("orca-live-a")), "the reused outcome a is never re-dispatched");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #1009 — completion-driven advancement of already-materialized later waves
// ---------------------------------------------------------------------------

function completedFirstWaveWorld(program = FOLLOWUP_LATER_WAVE) {
  const first = program.outcomes.find((outcome) => outcome.wave === 1);
  const later = program.outcomes.find((outcome) => outcome.wave === 2);
  const runId = `run-${first.id}`;
  const prNumber = Number(first.issue) + 10000;
  const world = buildWorld({
    programId: program.id,
    manifests: [{ run_id: runId, state: "merged", pr_number: prNumber, issue_number: first.issue }],
    orcaScenario: {
      tasks: [
        orcaTask(program.id, first.id, { status: "completed", worker_done: true }),
        orcaTask(program.id, later.id, { status: "pending" }),
      ],
      dispatch: absentDispatch(later.id),
    },
    ghScenario: {
      prs: { [prNumber]: { state: "MERGED", mergedAt: "2026-07-14T01:00:00Z" } },
      issues: { [first.issue]: { state: "CLOSED" } },
    },
  });
  const receipt = makeReceipt({
    programId: program.id,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [
      { outcome_id: first.id, kind: first.task_kind, wave: first.wave, run: runId },
      { outcome_id: later.id, kind: later.task_kind, wave: later.wave, dispatch_id: null, assignee: null },
    ],
  });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  return { world, first, later };
}

test("#1009: wave 2 advances through the existing verified path and a second resume is idempotent", () => {
  const { world, first, later } = completedFirstWaveWorld();
  try {
    assert.equal(runStatus(world, FOLLOWUP_LATER_WAVE.id).program_state, "ready_for_next_wave");
    const firstRun = world.run(["--operator-handle", "h-wave-2"]);
    assert.equal(firstRun.status, 0);
    assertReportShape(firstRun.body);
    assert.equal(actionFor(firstRun.body, first.id).action, "skipped");
    assert.equal(actionFor(firstRun.body, later.id).action, "redispatched");

    const firstLog = world.orca.readLog();
    const injectIndex = firstLog.findIndex((line) => line.startsWith(`orchestration dispatch --task orca-live-${later.id}`));
    const verifyIndex = firstLog.findIndex((line, index) => index > injectIndex && line.startsWith(`orchestration dispatch-show --task orca-live-${later.id}`));
    const promptIndex = firstLog.findIndex((line, index) => index > verifyIndex && line.startsWith("terminal send"));
    assert.ok(injectIndex >= 0, "the already-materialized wave-2 Orca task is injected");
    assert.ok(verifyIndex > injectIndex, "dispatch provenance is verified after injection");
    assert.ok(promptIndex > verifyIndex, "the operator prompt is delivered after provenance verification");
    assert.ok(!firstLog.some((line) => line.startsWith("orchestration task-create")), "resume never creates a later-wave task");
    assert.ok(!firstLog.some((line) => line.startsWith("terminal create")), "resume uses only the explicit operator handle");

    const persisted = parseReceipt(world.receiptOnDisk()).receipt;
    const advanced = persisted.tasks.find((task) => task.outcome_id === later.id);
    assert.equal(advanced.orca_task_id, `orca-live-${later.id}`);
    assert.equal(advanced.dispatch_id, `disp-orca-live-${later.id}`);
    assert.equal(advanced.assignee, "h-wave-2");

    const beforeSecond = world.receiptOnDisk();
    const secondLogStart = firstLog.length;
    const secondRun = world.run(["--operator-handle", "h-wave-2"]);
    assert.equal(secondRun.status, 0);
    assert.equal(actionFor(secondRun.body, later.id).action, "reused");
    assert.deepEqual(mutationLines(world.orca.readLog().slice(secondLogStart)), [], "the second resume performs no duplicate inject or prompt send");
    assert.equal(world.receiptOnDisk(), beforeSecond, "the second resume leaves the receipt byte-identical");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

test("#1009: an eligible wave-2 outcome without an explicit operator handle fails closed with exit 66", () => {
  const { world, later } = completedFirstWaveWorld();
  const before = world.receiptOnDisk();
  try {
    const r = world.run();
    assert.equal(r.status, RESUME_REASONS.RESUME_NO_OPERATOR_HANDLE);
    assert.equal(r.status, 66);
    assert.equal(actionFor(r.body, later.id).action, "decision_required");
    assert.ok(r.body.decision_required.some((decision) => decision.reason_code === "RESUME_NO_OPERATOR_HANDLE"));
    assert.deepEqual(mutationLines(world.orca.readLog()), [], "no handle means zero mutating Orca calls");
    assert.equal(world.receiptOnDisk(), before, "no-handle advancement leaves the receipt byte-identical");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

test("#1009: a started wave-2 sibling does not block another absent wave-2 outcome", () => {
  const programId = "epic-resume-partial-wave-two";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-wave-one", state: "merged", pr_number: 17201, issue_number: 7201 }],
    orcaScenario: {
      tasks: [
        orcaTask(programId, "wave-one", { status: "completed", worker_done: true }),
        orcaTask(programId, "wave-two-started"),
        orcaTask(programId, "wave-two-pending", { status: "pending" }),
      ],
      dispatch: absentDispatch("wave-two-pending"),
    },
    ghScenario: {
      prs: { 17201: { state: "MERGED", mergedAt: "2026-07-14T01:10:00Z" } },
      issues: { 7201: { state: "CLOSED" } },
    },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [
      { outcome_id: "wave-one", wave: 1, run: "run-wave-one" },
      { outcome_id: "wave-two-started", wave: 2 },
      { outcome_id: "wave-two-pending", wave: 2, dispatch_id: null, assignee: null },
    ],
  });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  try {
    assert.equal(runStatus(world, programId).program_state, "running", "the started sibling deliberately prevents the aggregate ready_for_next_wave label");
    const r = world.run(["--operator-handle", "h-wave-2-pending"]);
    assert.equal(r.status, 0);
    assert.equal(actionFor(r.body, "wave-two-started").action, "reused");
    assert.equal(actionFor(r.body, "wave-two-pending").action, "redispatched", "eligibility is per-outcome, not coupled to program_state");
    const injects = world.orca.readLog().filter((line) => line.startsWith("orchestration dispatch --task"));
    assert.equal(injects.length, 1);
    assert.ok(injects[0].includes("orca-live-wave-two-pending"));
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

test("#1009: wave 3 stays skipped while wave 2 advances because wave 2 is not yet complete", () => {
  const [waveOne, waveTwo, waveThree] = RESUME_THREE_WAVE.outcomes;
  assert.deepEqual(waveTwo.depends_on, [], "the declared-wave fixture proves eligibility is wave-blanket, not dependency-scoped");
  const world = buildWorld({
    programId: RESUME_THREE_WAVE.id,
    manifests: [{ run_id: "run-foundation", state: "merged", pr_number: 17101, issue_number: waveOne.issue }],
    orcaScenario: {
      tasks: [
        orcaTask(RESUME_THREE_WAVE.id, waveOne.id, { status: "completed", worker_done: true }),
        orcaTask(RESUME_THREE_WAVE.id, waveTwo.id, { status: "pending" }),
        orcaTask(RESUME_THREE_WAVE.id, waveThree.id, { status: "pending" }),
      ],
      dispatch: absentDispatch(waveTwo.id, waveThree.id),
    },
    ghScenario: {
      prs: { 17101: { state: "MERGED", mergedAt: "2026-07-14T01:20:00Z" } },
      issues: { [waveOne.issue]: { state: "CLOSED" } },
    },
  });
  const receipt = makeReceipt({
    programId: RESUME_THREE_WAVE.id,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [
      { outcome_id: waveOne.id, wave: waveOne.wave, run: "run-foundation" },
      { outcome_id: waveTwo.id, wave: waveTwo.wave, dispatch_id: null, assignee: null },
      { outcome_id: waveThree.id, wave: waveThree.wave, dispatch_id: null, assignee: null },
    ],
  });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  try {
    const r = world.run(["--operator-handle", "h-wave-2"]);
    assert.equal(r.status, 0);
    assert.equal(actionFor(r.body, waveTwo.id).action, "redispatched");
    assert.equal(actionFor(r.body, waveThree.id).action, "skipped");
    assert.equal(
      actionFor(r.body, waveThree.id).reason,
      `outcome ${waveThree.id} is in wave ${waveThree.wave}; earlier waves are not yet complete_with_evidence; left untouched`,
    );
    const injects = world.orca.readLog().filter((line) => line.startsWith("orchestration dispatch --task"));
    assert.equal(injects.length, 1, "only wave 2 consumes the explicit handle");
    assert.ok(injects[0].includes(`orca-live-${waveTwo.id}`));
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

test("#1009 masking: worker_done with an open PR keeps wave 2 fail-closed and untouched", () => {
  const [waveOne, waveTwo] = FOLLOWUP_LATER_WAVE.outcomes;
  const world = buildWorld({
    programId: FOLLOWUP_LATER_WAVE.id,
    manifests: [{ run_id: "run-stale-worker", state: "review_pending", pr_number: 17301, issue_number: waveOne.issue }],
    orcaScenario: {
      tasks: [
        orcaTask(FOLLOWUP_LATER_WAVE.id, waveOne.id, { status: "completed", worker_done: true }),
        orcaTask(FOLLOWUP_LATER_WAVE.id, waveTwo.id, { status: "pending" }),
      ],
      dispatch: absentDispatch(waveTwo.id),
    },
    ghScenario: {
      prs: { 17301: { state: "OPEN" } },
      issues: { [waveOne.issue]: { state: "OPEN" } },
    },
  });
  const receipt = makeReceipt({
    programId: FOLLOWUP_LATER_WAVE.id,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [
      { outcome_id: waveOne.id, wave: 1, run: "run-stale-worker" },
      { outcome_id: waveTwo.id, wave: 2, dispatch_id: null, assignee: null },
    ],
  });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  const before = world.receiptOnDisk();
  try {
    const r = world.run(["--operator-handle", "h-must-not-be-used"]);
    assert.equal(r.status, RESUME_REASONS.RESUME_AMBIGUOUS_STATE);
    assert.equal(r.status, 61);
    assert.equal(r.body.reconciliation.find((outcome) => outcome.outcome_id === waveOne.id).state, "inconsistent");
    assert.equal(actionFor(r.body, waveTwo.id).action, "decision_required");
    assert.deepEqual(mutationLines(world.orca.readLog()), [], "an inconsistent earlier wave causes zero mutation");
    assert.equal(world.receiptOnDisk(), before, "the later-wave receipt mapping is untouched");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

test("#1009 masking: worker_done with all-null evidence does not unlock wave 2", () => {
  const [waveOne, waveTwo] = FOLLOWUP_LATER_WAVE.outcomes;
  const world = buildWorld({
    programId: FOLLOWUP_LATER_WAVE.id,
    orcaScenario: {
      tasks: [
        orcaTask(FOLLOWUP_LATER_WAVE.id, waveOne.id, { status: "completed", worker_done: true }),
        orcaTask(FOLLOWUP_LATER_WAVE.id, waveTwo.id, { status: "pending" }),
      ],
      dispatch: absentDispatch(waveTwo.id),
    },
  });
  const receipt = makeReceipt({
    programId: FOLLOWUP_LATER_WAVE.id,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [
      { outcome_id: waveOne.id, wave: 1 },
      { outcome_id: waveTwo.id, wave: 2, dispatch_id: null, assignee: null },
    ],
  });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  const before = world.receiptOnDisk();
  try {
    const r = world.run(["--operator-handle", "h-must-not-be-used"]);
    assert.equal(r.status, 0);
    const reconciledWaveOne = r.body.reconciliation.find((outcome) => outcome.outcome_id === waveOne.id);
    assert.notEqual(reconciledWaveOne.state, "complete_with_evidence");
    assert.ok(Object.values(reconciledWaveOne.evidence).every((value) => value === null), "all durable evidence is unresolved");
    assert.equal(actionFor(r.body, waveOne.id).action, "reused");
    assert.equal(actionFor(r.body, waveTwo.id).action, "skipped");
    assert.equal(
      actionFor(r.body, waveTwo.id).reason,
      `outcome ${waveTwo.id} is in wave ${waveTwo.wave}; earlier waves are not yet complete_with_evidence; left untouched`,
    );
    assert.deepEqual(mutationLines(world.orca.readLog()), [], "worker_done alone never dispatches the next wave");
    assert.equal(world.receiptOnDisk(), before);
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D3 — resume with an outcome to (re)dispatch but NO --operator-handle → decision_required
// ---------------------------------------------------------------------------

test("D3: resume needing re-dispatch with zero --operator-handle → RESUME_NO_OPERATOR_HANDLE exit 66, zero mutation", () => {
  const programId = "epic-resume-no-handle";
  const world = buildWorld({
    programId,
    // Outcome b is verifiably absent (genuine absence), so it would otherwise re-dispatch —
    // but resume never self-creates a terminal, so with no handle it must fail closed.
    orcaScenario: { tasks: [orcaTask(programId, "b")], dispatch: absentDispatch("b") },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "b", dispatch_id: null, assignee: null }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  const before = world.receiptOnDisk();
  try {
    const r = world.run(); // NO --operator-handle
    assert.equal(r.status, RESUME_REASONS.RESUME_NO_OPERATOR_HANDLE);
    assert.equal(r.status, 66);
    assertReportShape(r.body);
    assert.equal(r.body.ok, false);
    const decision = r.body.decision_required.find((d) => d.reason_code === "RESUME_NO_OPERATOR_HANDLE");
    assert.ok(decision, "RESUME_NO_OPERATOR_HANDLE decision present");
    assert.ok(decision.options.some((o) => o.includes("--operator-handle")), "options offer providing --operator-handle");
    assert.equal(actionFor(r.body, "b").action, "decision_required");
    assert.deepEqual(r.body.terminals_created, []);
    // ZERO mutation: no dispatch/terminal/task-create, and the receipt is byte-identical.
    assert.deepEqual(mutationLines(world.orca.readLog()), []);
    assert.equal(world.receiptOnDisk(), before, "receipt byte-identical on the no-handle abort");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A1 (#946 R1) — redispatch requires LIVE dispatch absence, not a null receipt id
// ---------------------------------------------------------------------------

// (a) Crash window: `dispatch --inject` landed a live dispatch, but the receipt write that
// records its provenance never happened (crash between inject and the receipt write). The
// receipt dispatch_id is null yet a live dispatch is PRESENT — re-injecting would duplicate
// operator work, so resume fails closed as RESUME_MISSING_PROVENANCE (exit 63) with ZERO
// dispatch invocations. A null receipt dispatch_id is NOT verifiable absence.
test("A1(a) crash window: live dispatch present + receipt dispatch_id null → RESUME_MISSING_PROVENANCE exit 63, zero dispatch", () => {
  const programId = "epic-resume-crash-window";
  const world = buildWorld({
    programId,
    // NO dispatch seed → the fake dispatch-show reports a PRESENT live dispatch for the task.
    orcaScenario: { tasks: [orcaTask(programId, "b")] },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "b", dispatch_id: null, assignee: null }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  const before = world.receiptOnDisk();
  try {
    const r = world.run();
    assert.equal(r.status, 63);
    assertReportShape(r.body);
    assert.equal(r.body.ok, false);
    assert.ok(r.body.decision_required.some((d) => d.reason_code === "RESUME_MISSING_PROVENANCE"), "crash window fails closed as RESUME_MISSING_PROVENANCE");
    assert.equal(actionFor(r.body, "b").action, "decision_required");
    assert.deepEqual(mutationLines(world.orca.readLog()), [], "no mutating subcommand on the crash-window abort");
    assert.ok(!world.orca.readLog().some((l) => l.startsWith("orchestration dispatch --task")), "ZERO dispatch invocations in the crash window");
    assert.equal(world.receiptOnDisk(), before, "receipt byte-identical on the fail-closed abort");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// (b) Genuine absence: the task exists but a live dispatch-show reports NO dispatch. THIS
// is verifiable absence, so the absent + relay-clean + wave-1 outcome re-dispatches through
// the verified inject->dispatch-show->prompt path, exactly as before.
test("A1(b) genuine absence: live dispatch-show empty + receipt dispatch_id null → re-dispatch proceeds through the verified path", () => {
  const programId = "epic-resume-genuine-absence";
  const world = buildWorld({
    programId,
    orcaScenario: { tasks: [orcaTask(programId, "b")], dispatch: absentDispatch("b") },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "b", dispatch_id: null, assignee: null }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  try {
    const r = world.run(["--operator-handle", "h1"]);
    assert.equal(r.status, 0);
    assert.deepEqual(r.body.decision_required, [], "no fail-closed decision on genuine absence");
    assert.equal(actionFor(r.body, "b").action, "redispatched");
    const log = world.orca.readLog();
    assert.ok(log.some((l) => l.startsWith("orchestration dispatch-show --task orca-live-b")), "reconciliation reads the live dispatch before deciding");
    assert.ok(log.some((l) => l.startsWith("orchestration dispatch --task orca-live-b")), "re-injected through the verified dispatch path");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// D3: unmapped relay work (a back-pointer) blocks re-dispatch of an absent outcome.
test("D3: an absent outcome is NOT re-dispatched while unmapped relay work references the program", () => {
  const programId = "epic-resume-backpointer";
  const world = buildWorld({
    programId,
    // An unmapped relay run manifest that references this program (a back-pointer).
    manifests: [{ run_id: "run-unmapped", state: "dispatched", pr_number: 40, issue_number: 400, body: `relay-orca program ${programId} operator run` }],
    orcaScenario: { tasks: [orcaTask(programId, "b")], dispatch: absentDispatch("b") },
    ghScenario: { prs: { 40: { state: "OPEN" } }, issues: { 400: { state: "OPEN" } } },
  });
  // Outcome b is verifiably absent + relay clean + wave 1 (would normally re-dispatch),
  // but the back-pointer means re-dispatch could duplicate the unmapped work.
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "b", dispatch_id: null, assignee: null }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  const before = world.receiptOnDisk();
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(actionFor(r.body, "b").action, "skipped", "absent outcome is skipped, not re-dispatched, to avoid duplicating unmapped relay work");
    assert.deepEqual(mutationLines(world.orca.readLog()), [], "no re-dispatch while unmapped relay work exists");
    assert.equal(world.receiptOnDisk(), before);
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// A2 (#946 R2, owner amendment A2): an unmapped FLEET manifest under the SEPARATE fleets
// root blocks re-dispatch of an absent relay_fleet outcome — re-injecting would duplicate
// the whole fleet (forbidden by the drain invariant), the same no-duplicate-work semantics
// as the runs-root back-pointer above.
test("A2: an absent relay_fleet outcome is NOT re-dispatched while an unmapped fleet manifest references the program", () => {
  const programId = "epic-resume-fleet-backpointer";
  const world = buildWorld({
    programId,
    // An unmapped fleet manifest under the fleets root that references this program.
    fleetManifests: [{ run_id: "fleet-unmapped", state: "dispatched", pr_number: 50, issue_number: 500, body: `relay-orca program ${programId} operator fleet` }],
    orcaScenario: { tasks: [orcaTask(programId, "b")], dispatch: absentDispatch("b") },
  });
  // Outcome b is a relay_fleet outcome, verifiably absent + relay clean (no fleet mapped in
  // the receipt) + wave 1 — it would normally re-dispatch, but the unmapped fleet back-pointer
  // means re-dispatch could duplicate the whole fleet.
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "b", kind: "relay_fleet", dispatch_id: null, assignee: null }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  const before = world.receiptOnDisk();
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(actionFor(r.body, "b").action, "skipped", "absent relay_fleet outcome is skipped, not re-dispatched, to avoid duplicating the unmapped fleet");
    assert.deepEqual(mutationLines(world.orca.readLog()), [], "no re-dispatch while an unmapped fleet references the program");
    assert.ok(!world.orca.readLog().some((l) => l.startsWith("orchestration dispatch --task")), "ZERO dispatch invocations for the fleet outcome");
    assert.equal(world.receiptOnDisk(), before);
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// D1: reconciliation reads run BEFORE any mutation.
test("D1: reconciliation (status/task-list/gate-list) runs before any mutating subcommand", () => {
  const programId = "epic-resume-order";
  const world = partialWorld(programId);
  try {
    const r = world.run(["--operator-handle", "h1"]);
    assert.equal(r.status, 0);
    const log = world.orca.readLog();
    const firstMutation = log.findIndex((l) => mutationLines([l]).length > 0);
    assert.ok(firstMutation > 0, "a mutation occurred");
    ["status", "orchestration task-list", "orchestration gate-list"].forEach((read) => {
      const idx = log.findIndex((l) => l.startsWith(read));
      assert.ok(idx >= 0 && idx < firstMutation, `${read} reconciliation read precedes the first mutation`);
    });
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.5 / D3 — double resume is idempotent (the core invariant)
// ---------------------------------------------------------------------------

test("D9.5: double resume is idempotent — second run does zero task-create/terminal/dispatch, all reused/skipped", () => {
  const programId = "epic-resume-idempotent";
  const world = partialWorld(programId);
  try {
    const first = world.run(["--operator-handle", "h1"]);
    assert.equal(first.status, 0);
    assert.equal(actionFor(first.body, "b").action, "redispatched");
    const firstMutations = mutationLines(world.orca.readLog()).length;
    assert.ok(firstMutations > 0, "the first resume mutated (re-dispatched the absent outcome)");

    // Second resume reads the receipt the first resume persisted → everything now live.
    const beforeSecond = world.receiptOnDisk();
    const secondLogStart = world.orca.readLog().length;
    const second = world.run(["--operator-handle", "h1"]);
    assert.equal(second.status, 0);
    const secondLog = world.orca.readLog().slice(secondLogStart);
    assert.deepEqual(mutationLines(secondLog), [], "the second resume performs ZERO task-create/terminal/dispatch");
    second.body.actions.forEach((entry) => assert.ok(["reused", "skipped"].includes(entry.action), `${entry.outcome_id} is reused/skipped on the second run`));
    assert.equal(actionFor(second.body, "b").action, "reused", "the re-established outcome reads back as reused");
    assert.equal(world.receiptOnDisk(), beforeSecond, "the second resume rewrites nothing (idempotent)");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.9 — corrupted global state (foreign) → 61; corrupted receipt → 51
// ---------------------------------------------------------------------------

test("D9.9a: foreign runtime tasks → RESUME_AMBIGUOUS_STATE exit 61, options listed, zero mutation", () => {
  const programId = "epic-resume-foreign";
  const world = buildWorld({
    programId,
    orcaScenario: { tasks: [orcaTask(programId, "a"), foreignTask("intruder-1")] },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "a" }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 61);
    assertReportShape(r.body);
    assert.equal(r.body.runtime, "foreign_state");
    const decision = r.body.decision_required.find((d) => d.reason_code === "RESUME_AMBIGUOUS_STATE");
    assert.ok(decision, "RESUME_AMBIGUOUS_STATE decision present");
    assert.ok(decision.options.length > 0, "recovery options listed");
    assert.deepEqual(mutationLines(world.orca.readLog()), []);
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

test("D9.9b: corrupted receipt → RECEIPT_CORRUPT exit 51 verbatim", () => {
  const programId = "epic-resume-corrupt";
  const world = buildWorld({ programId, corruptReceipt: "{ not valid json" });
  try {
    const r = world.run();
    assert.equal(r.status, 51);
    assert.equal(r.body.reason_code, "RECEIPT_CORRUPT");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.10 / D6 — worker_done + open PR → not re-dispatched, decision_required
// ---------------------------------------------------------------------------

test("D9.10: worker_done + open PR outcome is inconsistent → decision_required, never re-dispatched (D6)", () => {
  const programId = "epic-resume-stale-done";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-s", state: "review_pending", pr_number: 30, issue_number: 300 }],
    orcaScenario: { tasks: [orcaTask(programId, "s", { status: "completed", worker_done: true })] },
    ghScenario: { prs: { 30: { state: "OPEN" } }, issues: { 300: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "s", run: "run-s" }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 61);
    assertReportShape(r.body);
    assert.ok(r.body.reconciliation.find((o) => o.outcome_id === "s").state === "inconsistent");
    assert.ok(r.body.decision_required.some((d) => d.reason_code === "RESUME_AMBIGUOUS_STATE"));
    assert.deepEqual(mutationLines(world.orca.readLog()), [], "a worker_done+open-PR outcome is never re-dispatched");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.11 — conflicting mapping (changed dispatch id) → 62; missing provenance → 63
// ---------------------------------------------------------------------------

test("D9.11a: changed dispatch id under the mapping → RESUME_CONFLICTING_MAPPING exit 62, zero mutation", () => {
  const programId = "epic-resume-conflict";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-a", state: "dispatched", pr_number: 10, issue_number: 100 }],
    // Live dispatch id drifted away from the receipt's recorded dispatch id.
    orcaScenario: { tasks: [orcaTask(programId, "a")], dispatch: { "orca-live-a": { dispatch_id: "disp-CHANGED" } } },
    ghScenario: { prs: { 10: { state: "OPEN" } }, issues: { 100: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "a", run: "run-a" }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 62);
    assertReportShape(r.body);
    assert.ok(r.body.decision_required.some((d) => d.reason_code === "RESUME_CONFLICTING_MAPPING"));
    assert.deepEqual(mutationLines(world.orca.readLog()), []);
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

test("D9.11b: live dispatch present but recorded provenance incomplete → RESUME_MISSING_PROVENANCE exit 63", () => {
  const programId = "epic-resume-missing-prov";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-a", state: "dispatched", pr_number: 10, issue_number: 100 }],
    orcaScenario: { tasks: [orcaTask(programId, "a")] },
    ghScenario: { prs: { 10: { state: "OPEN" } }, issues: { 100: { state: "OPEN" } } },
  });
  // dispatch_id present (a live dispatch exists) but assignee missing → provenance gap.
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "a", assignee: null, run: "run-a" }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 63);
    assertReportShape(r.body);
    assert.ok(r.body.decision_required.some((d) => d.reason_code === "RESUME_MISSING_PROVENANCE"));
    assert.deepEqual(mutationLines(world.orca.readLog()), []);
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.8 — stop then resume: the stop record survives a resume that rewrites the receipt
// ---------------------------------------------------------------------------

test("D9.8: resume preserves a prior stop record when it rewrites the receipt", () => {
  const programId = "epic-resume-after-stop";
  const world = buildWorld({
    programId,
    orcaScenario: { tasks: [orcaTask(programId, "b")], dispatch: absentDispatch("b") },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [{ outcome_id: "b", dispatch_id: null, assignee: null }],
    stop: { stopped_at: "2026-07-12T05:00:00.000Z", stop_reason: "operator paused the coordinator" },
  });
  fs.writeFileSync(world.receiptPath, serializeReceiptWithStop(receipt), "utf-8");
  try {
    const r = world.run(["--operator-handle", "h1"]);
    assert.equal(r.status, 0);
    assert.equal(actionFor(r.body, "b").action, "redispatched", "resume still re-dispatches the absent outcome");
    const persisted = parseReceipt(world.receiptOnDisk()).receipt;
    assert.equal(persisted.stopped_at, "2026-07-12T05:00:00.000Z", "stop record survives the receipt rewrite");
    assert.equal(persisted.stop_reason, "operator paused the coordinator");
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D2 — decision options never advise a destructive action; no cancellation language
// ---------------------------------------------------------------------------

test("D2/D8: decision options name operator commands, are bounded, and never advise reset/deletion/force-close", () => {
  const programId = "epic-resume-options";
  const world = buildWorld({ programId, orcaScenario: { runtimeId: "88888888-8888-4888-8888-888888888888" } });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "a" }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 60);
    const serialized = JSON.stringify(r.body).toLowerCase();
    ["reset", "task delete", "task-delete", "delete task", "worktree", "force-close", "force close", "rm -rf"].forEach((forbidden) => {
      assert.ok(!serialized.includes(forbidden), `resume report must never advise ${forbidden}`);
    });
    CANCELLATION_TOKENS.forEach((token) => assert.ok(!serialized.includes(token), `resume report must not claim ${token}`));
    r.body.decision_required.forEach((decision) => {
      decision.options.forEach((option) => {
        assert.ok(option.length <= 256, "options bounded to <=256 chars");
        assert.ok(/status\.js|run\.js|dispatch-show|recovery\.md/.test(option), "each option names a concrete operator command/reference");
      });
    });
    FORBIDDEN_ENGINE_TOKENS.forEach((token) => assert.ok(!serialized.includes(token), `resume report must not name engine ${token}`));
    assertNoPoison(world);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Receipt-layer + usage fail-closed contracts
// ---------------------------------------------------------------------------

test("receipt: missing receipt → RECEIPT_NOT_FOUND exit 50", () => {
  const programId = "epic-resume-absent";
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-resume-nf-"));
  const repoRoot = path.join(base, "repo");
  const programsRoot = path.join(base, "programs");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(programsRoot, { recursive: true });
  initGitRepo(repoRoot);
  const orca = installFakeOrcaResume({});
  try {
    let status = 0;
    let body = null;
    try {
      execFileSync(process.execPath, [RESUME_JS, "--program-id", programId, "--json", "--orca-bin", orca.orcaPath, "--repo-root", repoRoot], {
        encoding: "utf-8",
        env: { ...process.env, RELAY_ORCA_PROGRAMS_ROOT: programsRoot },
        stdio: "pipe",
      });
    } catch (error) {
      status = error.status;
      body = error.stdout ? JSON.parse(String(error.stdout)) : null;
    }
    assert.equal(status, 50);
    assert.equal(body.reason_code, "RECEIPT_NOT_FOUND");
    assert.equal(orca.readPoison(), null);
  } finally {
    orca.cleanup();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("usage: unknown flag exits 64", () => {
  const world = buildWorld({ programId: "epic-resume-usage" });
  try {
    const r = world.run(["--bogus"]);
    assert.equal(r.status, 64);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #1008 — explicit, validated relay run mapping intake
// ---------------------------------------------------------------------------

test("#1008 usage: --map-relay-run requires a program file and a well-formed outcome=run value", () => {
  const programId = "epic-resume-map-usage";
  const world = buildWorld({ programId });
  const programFile = acceptedProgramFile(world, programId, [{ id: "a", issue: 100 }]);
  const before = world.receiptOnDisk();
  try {
    assert.equal(world.run(["--map-relay-run", "a=run-a"]).status, 64);
    for (const malformed of ["a", "=run-a", "a="]) {
      assert.equal(world.run(["--program-file", programFile, "--map-relay-run", malformed]).status, 64);
    }
    assert.equal(world.receiptOnDisk(), before, "usage failures leave the receipt byte-identical");
    assert.deepEqual(world.orca.readLog(), [], "usage failures never reconcile live state");
  } finally {
    world.cleanup();
  }
});

test("#1008 target validation rejects unknown, non-mappable, and issue-less outcomes with exit 67", () => {
  const cases = [
    { name: "unknown", task: { outcome_id: "a" }, outcomes: [{ id: "a", issue: 100 }], mapping: "missing=run-a" },
    { name: "non-mappable", task: { outcome_id: "a", kind: "advisory_review" }, outcomes: [{ id: "a", issue: 100 }], mapping: "a=run-a" },
    { name: "issue-less", task: { outcome_id: "a" }, outcomes: [{ id: "a", issue: null }], mapping: "a=run-a" },
  ];
  for (const scenario of cases) {
    const programId = `epic-resume-map-${scenario.name}`;
    const world = buildWorld({
      programId,
      manifests: [{ run_id: "run-a", state: "dispatched", issue_number: 100 }],
    });
    const receipt = makeReceipt({
      programId,
      slug: world.slug,
      root: fs.realpathSync(world.repoRoot),
      tasks: [scenario.task],
    });
    fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
    const programFile = acceptedProgramFile(world, programId, scenario.outcomes);
    const before = world.receiptOnDisk();
    try {
      const r = world.run(["--program-file", programFile, "--map-relay-run", scenario.mapping]);
      assert.equal(r.status, RESUME_REASONS.RESUME_MAP_TARGET_INVALID);
      assertReportShape(r.body);
      assert.equal(r.body.decision_required[0].reason_code, "RESUME_MAP_TARGET_INVALID");
      assert.equal(world.receiptOnDisk(), before, `${scenario.name} failure leaves receipt byte-identical`);
      assert.deepEqual(world.orca.readLog(), [], `${scenario.name} failure happens before reconciliation`);
      assert.deepEqual(world.gh.readLog(), [], `${scenario.name} failure makes no GitHub read`);
    } finally {
      world.cleanup();
    }
  }
});

test("#1008 manifest validation rejects a missing run with 68 and an issue mismatch with 69", () => {
  const cases = [
    { name: "missing", manifests: [], mapping: "a=run-missing", code: "RESUME_MAP_RUN_NOT_FOUND" },
    { name: "mismatch", manifests: [{ run_id: "run-a", state: "dispatched", issue_number: 999 }], mapping: "a=run-a", code: "RESUME_MAP_ISSUE_MISMATCH" },
  ];
  for (const scenario of cases) {
    const programId = `epic-resume-map-${scenario.name}`;
    const world = buildWorld({ programId, manifests: scenario.manifests });
    const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "a" }] });
    fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
    const programFile = acceptedProgramFile(world, programId, [{ id: "a", issue: 100 }]);
    const before = world.receiptOnDisk();
    try {
      const r = world.run(["--program-file", programFile, "--map-relay-run", scenario.mapping]);
      assert.equal(r.status, RESUME_REASONS[scenario.code]);
      assert.equal(r.body.decision_required[0].reason_code, scenario.code);
      assert.equal(world.receiptOnDisk(), before);
      assert.deepEqual(world.orca.readLog(), [], "mapping validation precedes live reconciliation");
      assert.deepEqual(world.gh.readLog(), []);
    } finally {
      world.cleanup();
    }
  }
});

// R1 #1008: an empty/non-numeric declared outcome issue is UNDECLARED, not a zero-coercible
// value that could slip past the target gate and then Number("")===Number(null)-match a
// manifest with no issue_number. It must fail closed as RESUME_MAP_TARGET_INVALID (exit 67).
test("#1008 an empty declared outcome issue is undeclared → RESUME_MAP_TARGET_INVALID exit 67, byte-identical receipt", () => {
  const programId = "epic-resume-map-empty-issue";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-a", state: "dispatched", issue_number: 100 }],
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "a" }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  const programFile = acceptedProgramFile(world, programId, [{ id: "a", issue: "" }]);
  const before = world.receiptOnDisk();
  try {
    const r = world.run(["--program-file", programFile, "--map-relay-run", "a=run-a"]);
    assert.equal(r.status, RESUME_REASONS.RESUME_MAP_TARGET_INVALID);
    assert.equal(r.status, 67);
    assertReportShape(r.body);
    assert.equal(r.body.decision_required[0].reason_code, "RESUME_MAP_TARGET_INVALID");
    assert.equal(world.receiptOnDisk(), before, "an empty declared issue leaves the receipt byte-identical");
    assert.deepEqual(world.orca.readLog(), [], "target validation precedes live reconciliation");
    assert.deepEqual(world.gh.readLog(), [], "an empty declared issue makes no GitHub read");
  } finally {
    world.cleanup();
  }
});

// R1 #1008: a finite declared issue paired with a manifest that carries NO issue_number must
// never coerce-match (both sides Number()->0). The mismatch gate fires (exit 69) instead of
// persisting run tracking for an issue-less manifest.
test("#1008 a declared finite issue vs a manifest without issue_number → RESUME_MAP_ISSUE_MISMATCH exit 69, byte-identical receipt", () => {
  const programId = "epic-resume-map-manifest-no-issue";
  const world = buildWorld({
    programId,
    // Manifest present (RUN_NOT_FOUND passes) but with no issue_number in frontmatter.
    manifests: [{ run_id: "run-a", state: "dispatched" }],
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "a" }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  const programFile = acceptedProgramFile(world, programId, [{ id: "a", issue: 100 }]);
  const before = world.receiptOnDisk();
  try {
    const r = world.run(["--program-file", programFile, "--map-relay-run", "a=run-a"]);
    assert.equal(r.status, RESUME_REASONS.RESUME_MAP_ISSUE_MISMATCH);
    assert.equal(r.status, 69);
    assertReportShape(r.body);
    assert.equal(r.body.decision_required[0].reason_code, "RESUME_MAP_ISSUE_MISMATCH");
    assert.equal(world.receiptOnDisk(), before, "a manifest without issue_number leaves the receipt byte-identical");
    assert.deepEqual(world.orca.readLog(), [], "mapping validation precedes live reconciliation");
    assert.deepEqual(world.gh.readLog(), [], "the mismatch makes no GitHub read");
  } finally {
    world.cleanup();
  }
});

test("#1008 duplicate or contradictory relay run mappings reuse exit 62", () => {
  const cases = [
    {
      name: "target-changed",
      tasks: [{ outcome_id: "a", run: "run-old" }],
      outcomes: [{ id: "a", issue: 100 }],
      manifests: [{ run_id: "run-new", state: "dispatched", issue_number: 100 }],
      mapping: "a=run-new",
    },
    {
      name: "run-on-other-task",
      tasks: [{ outcome_id: "a", run: "run-shared" }, { outcome_id: "b" }],
      outcomes: [{ id: "a", issue: 100 }, { id: "b", issue: 200 }],
      manifests: [{ run_id: "run-shared", state: "dispatched", issue_number: 200 }],
      mapping: "b=run-shared",
    },
    {
      name: "run-twice-in-batch",
      tasks: [{ outcome_id: "a" }, { outcome_id: "b" }],
      outcomes: [{ id: "a", issue: 100 }, { id: "b", issue: 100 }],
      manifests: [{ run_id: "run-shared", state: "dispatched", issue_number: 100 }],
      mapping: ["a=run-shared", "b=run-shared"],
    },
  ];
  for (const scenario of cases) {
    const programId = `epic-resume-map-${scenario.name}`;
    const world = buildWorld({ programId, manifests: scenario.manifests });
    const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: scenario.tasks });
    fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
    const programFile = acceptedProgramFile(world, programId, scenario.outcomes);
    const before = world.receiptOnDisk();
    try {
      const mappings = Array.isArray(scenario.mapping) ? scenario.mapping : [scenario.mapping];
      const mappingArgs = mappings.flatMap((mapping) => ["--map-relay-run", mapping]);
      const r = world.run(["--program-file", programFile, ...mappingArgs]);
      assert.equal(r.status, RESUME_REASONS.RESUME_CONFLICTING_MAPPING);
      assert.equal(r.body.decision_required[0].reason_code, "RESUME_CONFLICTING_MAPPING");
      assert.equal(world.receiptOnDisk(), before);
      assert.deepEqual(world.orca.readLog(), []);
    } finally {
      world.cleanup();
    }
  }
});

test("#1008 mapping batches are all-or-nothing and idempotent same-mapping replay is byte-identical", () => {
  const batchProgramId = "epic-resume-map-batch";
  const batchWorld = buildWorld({
    programId: batchProgramId,
    manifests: [{ run_id: "run-a", state: "dispatched", issue_number: 100 }],
  });
  const batchReceipt = makeReceipt({
    programId: batchProgramId,
    slug: batchWorld.slug,
    root: fs.realpathSync(batchWorld.repoRoot),
    tasks: [{ outcome_id: "a" }, { outcome_id: "b" }],
  });
  fs.writeFileSync(batchWorld.receiptPath, serializeReceipt(batchReceipt), "utf-8");
  const batchProgram = acceptedProgramFile(batchWorld, batchProgramId, [{ id: "a", issue: 100 }, { id: "b", issue: 200 }]);
  const batchBefore = batchWorld.receiptOnDisk();
  try {
    const r = batchWorld.run([
      "--program-file", batchProgram,
      "--map-relay-run", "a=run-a",
      "--map-relay-run", "b=run-missing",
    ]);
    assert.equal(r.status, RESUME_REASONS.RESUME_MAP_RUN_NOT_FOUND);
    assert.equal(batchWorld.receiptOnDisk(), batchBefore, "a valid first mapping is not persisted when the batch fails");
  } finally {
    batchWorld.cleanup();
  }

  const replayProgramId = "epic-resume-map-replay";
  const replayWorld = buildWorld({
    programId: replayProgramId,
    manifests: [{ run_id: "run-a", state: "dispatched", pr_number: 10, issue_number: 100 }],
    orcaScenario: { tasks: [orcaTask(replayProgramId, "a")] },
    ghScenario: { prs: { 10: { state: "OPEN" } }, issues: { 100: { state: "OPEN" } } },
  });
  const replayReceipt = makeReceipt({ programId: replayProgramId, slug: replayWorld.slug, root: fs.realpathSync(replayWorld.repoRoot), tasks: [{ outcome_id: "a", run: "run-a" }] });
  fs.writeFileSync(replayWorld.receiptPath, serializeReceipt(replayReceipt), "utf-8");
  const replayProgram = acceptedProgramFile(replayWorld, replayProgramId, [{ id: "a", issue: 100 }]);
  const replayBefore = replayWorld.receiptOnDisk();
  try {
    const r = replayWorld.run(["--program-file", replayProgram, "--map-relay-run", "a=run-a"]);
    assert.equal(r.status, 0);
    assertReportShape(r.body);
    assert.equal(replayWorld.receiptOnDisk(), replayBefore, "same mapping replay does not bump updated_at or rewrite bytes");
  } finally {
    replayWorld.cleanup();
  }
});

test("#1008 a valid mapping persists before an unrelated outcome later requires a decision", () => {
  const programId = "epic-resume-map-upfront";
  const world = buildWorld({
    programId,
    manifests: [
      { run_id: "run-a", state: "merged", pr_number: 10, issue_number: 100 },
      { run_id: "run-b", state: "review_pending", pr_number: 20, issue_number: 200 },
    ],
    orcaScenario: { tasks: [orcaTask(programId, "a", { status: "completed", worker_done: true }), orcaTask(programId, "b", { status: "completed", worker_done: true })] },
    ghScenario: {
      prs: { 10: { state: "MERGED", mergedAt: "2026-07-14T00:00:00Z" }, 20: { state: "OPEN" } },
      issues: { 100: { state: "CLOSED" }, 200: { state: "OPEN" } },
    },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [{ outcome_id: "a" }, { outcome_id: "b", run: "run-b" }],
  });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  const programFile = acceptedProgramFile(world, programId, [{ id: "a", issue: 100 }, { id: "b", issue: 200 }]);
  try {
    const r = world.run(["--program-file", programFile, "--map-relay-run", "a=run-a"]);
    assert.equal(r.status, RESUME_REASONS.RESUME_AMBIGUOUS_STATE);
    assert.equal(mappedRun(world, "a"), "run-a", "mapping survives the later decision_required exit");
    assert.ok(r.body.decision_required.some((entry) => entry.reason_code === "RESUME_AMBIGUOUS_STATE"));
  } finally {
    world.cleanup();
  }
});

test("#1008 mapping intake enables complete_with_evidence on the next status reconciliation", () => {
  const programId = "epic-resume-map-complete";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-done", state: "merged", pr_number: 30, issue_number: 300 }],
    orcaScenario: { tasks: [orcaTask(programId, "done", { status: "completed", worker_done: true })] },
    ghScenario: {
      prs: { 30: { state: "MERGED", mergedAt: "2026-07-14T00:00:00Z" } },
      issues: { 300: { state: "CLOSED", stateReason: "COMPLETED" } },
    },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "done" }] });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  const programFile = acceptedProgramFile(world, programId, [{ id: "done", issue: 300 }]);
  try {
    const resumed = world.run(["--program-file", programFile, "--map-relay-run", "done=run-done"]);
    assert.equal(resumed.status, 0);
    assert.equal(mappedRun(world, "done"), "run-done");
    const status = runStatus(world, programId);
    const outcome = status.outcomes.find((entry) => entry.outcome_id === "done");
    assert.equal(outcome.state, "complete_with_evidence");
    assert.deepEqual(outcome.evidence, { manifest_terminal: true, pr_merged: true, issue_closed: true });
  } finally {
    world.cleanup();
  }
});

// --- #1019 R2: resume surfaces the copy-paste worker_done command while awaiting completion ---

test("#1019 integrationBlockingEntry surfaces the full copy-paste worker_done command while awaiting completion", () => {
  const copyPaste = "orca orchestration send --to coord-current --subject 'worker_done: relay-orca: seg/out' --from term-fresh --body 'send once' --type worker_done --task-id task_x --dispatch-id disp_x --report-path /runs/out.json --phase integration_gate --json";
  const entry = integrationBlockingEntry({
    ok: false,
    state: "awaiting_worker_done",
    reason_code: "INTEGRATION_WORKER_DONE_REQUIRED",
    completion_command: { copy_paste: copyPaste },
  });
  assert.equal(entry.reason_code, "INTEGRATION_WORKER_DONE_REQUIRED");
  // The authoritative explicit-flag command is surfaced verbatim (not truncated) in the report.
  assert.equal(entry.completion_command, copyPaste);
  assert.match(entry.message, /worker_done/);
});

test("#1019 integrationBlockingEntry omits completion_command when the lifecycle failed without one", () => {
  const entry = integrationBlockingEntry({
    ok: false,
    reason_code: "INTEGRATION_COORDINATOR_PROVENANCE_MISMATCH",
  });
  assert.equal(entry.reason_code, "INTEGRATION_COORDINATOR_PROVENANCE_MISMATCH");
  assert.equal("completion_command" in entry, false);
});
