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

const { REPORT_KEYS, ACTIONS } = require(path.join(SCRIPTS, "lib", "resume-report.js"));
const { REASONS: RESUME_REASONS } = require(path.join(SCRIPTS, "lib", "resume-reasons.js"));
const { RECEIPT_NOTE, parseReceipt, serializeReceipt, serializeReceiptWithStop } = require(path.join(SCRIPTS, "lib", "receipt.js"));
const { computeRepoSlug } = require(path.join(SCRIPTS, "lib", "repo-slug.js"));
const { programSegment } = require(path.join(SCRIPTS, "receipt-io.js"));
const { installFakeOrcaResume } = require(path.join(__dirname, "..", "fixtures", "fake-orca-resume.js"));
const { installFakeGh } = require(path.join(__dirname, "..", "fixtures", "fake-gh.js"));
const { DEFAULT_RUNTIME_ID } = require(path.join(__dirname, "..", "fixtures", "fake-orca.js"));

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
    title: `relay-orca: ${programSegment(programId)}/${outcome}`,
    status: extra.status || "dispatched",
    worker_done: extra.worker_done === true,
  };
}

// A task-list entry NOT marked for this program — makes the runtime foreign_state.
function foreignTask(id) {
  return { id, title: `relay-orca: other-program/${id}`, status: "dispatched", worker_done: false };
}

function initGitRepo(root) {
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
}

function buildWorld({ programId, receipt, manifests = [], orcaScenario = {}, ghScenario = {}, runtimeId, corruptReceipt }) {
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
  fs.mkdirSync(path.join(fleetsRoot, slug), { recursive: true });
  manifests.forEach((fields) => fs.writeFileSync(path.join(runsDir, `${fields.run_id}.md`), manifestText(fields), "utf-8"));

  const orca = installFakeOrcaResume({ runtimeId: runtimeId || DEFAULT_RUNTIME_ID, ...orcaScenario });
  const gh = installFakeGh(ghScenario);

  return {
    base,
    repoRoot,
    programsRoot,
    runsRoot,
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
    const r = world.run();
    assert.equal(r.status, 0);
    assertReportShape(r.body);
    assert.equal(actionFor(r.body, "a").action, "redispatched");
    assert.equal(r.body.terminals_created.length, 1);
    const log = world.orca.readLog();
    assert.ok(log.some((l) => l.startsWith("terminal create")), "a replacement terminal is created");
    assert.ok(log.some((l) => l.startsWith("orchestration dispatch --task orca-live-a")), "re-injected through dispatch");
    assert.ok(log.some((l) => l.startsWith("orchestration dispatch-show --task orca-live-a")), "provenance re-verified through dispatch-show");
    // Receipt persisted immediately (A16): the created handle is durable on disk.
    const persisted = parseReceipt(world.receiptOnDisk()).receipt;
    assert.deepEqual(persisted.terminals_created, r.body.terminals_created);
    assert.equal(persisted.tasks[0].assignee, r.body.terminals_created[0], "reacquired terminal recorded as the outcome assignee");
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
    orcaScenario: { tasks: [orcaTask(programId, "a")] },
    ghScenario: { prs: { 20: { state: "OPEN" } }, issues: { 200: { state: "OPEN" } } },
  });
  // Orca dispatch verifiably absent (dispatch_id null) but the relay side is in-flight.
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
    orcaScenario: { tasks: [orcaTask(programId, "a"), orcaTask(programId, "b")] },
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
    const r = world.run();
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

// D3: unmapped relay work (a back-pointer) blocks re-dispatch of an absent outcome.
test("D3: an absent outcome is NOT re-dispatched while unmapped relay work references the program", () => {
  const programId = "epic-resume-backpointer";
  const world = buildWorld({
    programId,
    // An unmapped relay run manifest that references this program (a back-pointer).
    manifests: [{ run_id: "run-unmapped", state: "dispatched", pr_number: 40, issue_number: 400, body: `relay-orca program ${programId} operator run` }],
    orcaScenario: { tasks: [orcaTask(programId, "b")] },
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

// D1: reconciliation reads run BEFORE any mutation.
test("D1: reconciliation (status/task-list/gate-list) runs before any mutating subcommand", () => {
  const programId = "epic-resume-order";
  const world = partialWorld(programId);
  try {
    const r = world.run();
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
    const first = world.run();
    assert.equal(first.status, 0);
    assert.equal(actionFor(first.body, "b").action, "redispatched");
    const firstMutations = mutationLines(world.orca.readLog()).length;
    assert.ok(firstMutations > 0, "the first resume mutated (re-dispatched the absent outcome)");

    // Second resume reads the receipt the first resume persisted → everything now live.
    const beforeSecond = world.receiptOnDisk();
    const secondLogStart = world.orca.readLog().length;
    const second = world.run();
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
    orcaScenario: { tasks: [orcaTask(programId, "b")] },
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
    const r = world.run();
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
