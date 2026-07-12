"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPTS = path.join(REPO_ROOT, "skills", "relay-orca", "scripts");
const STATUS_JS = path.join(SCRIPTS, "status.js");

const { REASONS } = require(path.join(SCRIPTS, "lib", "status-reasons.js"));
const { REPORT_KEYS, OUTCOME_KEYS, DIAGNOSTIC_CODES } = require(path.join(SCRIPTS, "lib", "status-report.js"));
const { classifyOutcome } = require(path.join(SCRIPTS, "lib", "status-classify.js"));
const { RECEIPT_NOTE } = require(path.join(SCRIPTS, "lib", "receipt.js"));
const { computeRepoSlug } = require(path.join(SCRIPTS, "lib", "repo-slug.js"));
const { installFakeOrcaStatus } = require(path.join(__dirname, "..", "fixtures", "fake-orca-status.js"));
const { installFakeGh } = require(path.join(__dirname, "..", "fixtures", "fake-gh.js"));
const { DEFAULT_RUNTIME_ID } = require(path.join(__dirname, "..", "fixtures", "fake-orca.js"));

const FORBIDDEN_ENGINE_TOKENS = ["codex", "claude", "cursor", "cline", "opencode"];

// --- receipt / manifest / scenario builders ------------------------------------

function makeReceipt({ programId, slug, root, runtimeId, tasks }) {
  return {
    schema: 1,
    program_id: programId,
    source: "/tmp/accepted-program.json",
    repo: { slug, root },
    runtime_id: runtimeId || DEFAULT_RUNTIME_ID,
    tasks: tasks.map((task) => ({
      outcome_id: task.outcome_id,
      task_id: task.task_id || `orca-task-${task.outcome_id}`,
      kind: task.kind || "relay_run",
      wave: task.wave || 1,
      orca_task_id: task.orca_task_id === undefined ? `orca-live-${task.outcome_id}` : task.orca_task_id,
      dispatch_id: task.dispatch_id === undefined ? `disp-${task.outcome_id}` : task.dispatch_id,
      assignee: task.assignee === undefined ? `term-${task.outcome_id}` : task.assignee,
      relay_ids: { request: null, run: task.run || null, fleet: null },
    })),
    terminals_created: [],
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    note: RECEIPT_NOTE,
  };
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
    title: `relay-orca: ${programId}/${outcome}`,
    status: extra.status || "dispatched",
    worker_done: extra.worker_done === true,
  };
}

// --- world harness -------------------------------------------------------------

function buildWorld({ programId, receipt, manifests = [], orcaScenario = {}, ghScenario = {}, runtimeId }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-status-"));
  const repoRoot = path.join(base, "repo");
  const programsRoot = path.join(base, "programs");
  const runsRoot = path.join(base, "runs");
  fs.mkdirSync(repoRoot, { recursive: true });
  const slug = computeRepoSlug(fs.realpathSync(repoRoot));

  const receiptObject = receipt || makeReceipt({ programId, slug, root: fs.realpathSync(repoRoot), runtimeId, tasks: [] });
  if (receiptObject.repo && receiptObject.repo.slug === "__SELF__") receiptObject.repo.slug = slug;
  const receiptDir = path.join(programsRoot, slug, programId);
  fs.mkdirSync(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, "receipt.json");
  fs.writeFileSync(receiptPath, `${JSON.stringify(receiptObject, null, 2)}\n`, "utf-8");

  const runsDir = path.join(runsRoot, slug);
  fs.mkdirSync(runsDir, { recursive: true });
  manifests.forEach((fields) => fs.writeFileSync(path.join(runsDir, `${fields.run_id}.md`), manifestText(fields), "utf-8"));

  const orca = installFakeOrcaStatus({ runtimeId: runtimeId || DEFAULT_RUNTIME_ID, ...orcaScenario });
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
    run(extraArgs = []) {
      const args = [
        STATUS_JS,
        "--program-id",
        programId,
        "--json",
        "--orca-bin",
        orca.orcaPath,
        "--gh-bin",
        gh.ghPath,
        "--repo-root",
        repoRoot,
        ...extraArgs,
      ];
      const result = { status: 0, stdout: "", stderr: "" };
      try {
        result.stdout = execFileSync(process.execPath, args, {
          encoding: "utf-8",
          env: { ...process.env, RELAY_ORCA_PROGRAMS_ROOT: programsRoot, RELAY_ORCA_RUNS_ROOT: runsRoot },
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

function outcomeById(body, id) {
  return body.outcomes.find((outcome) => outcome.outcome_id === id);
}

function diagCodes(body, outcomeId) {
  return body.diagnostics.filter((d) => outcomeId === undefined || d.outcome_id === outcomeId).map((d) => d.code);
}

// ---------------------------------------------------------------------------
// D9 report shape + verbatim taxonomy sanity
// ---------------------------------------------------------------------------

test("D7: the nine detector codes exist verbatim in DIAGNOSTIC_CODES", () => {
  assert.deepEqual(
    [...DIAGNOSTIC_CODES].sort(),
    [
      "DUPLICATE_MAPPING",
      "ISSUE_REOPENED",
      "MISSING_DISPATCH",
      "MISSING_RELAY_RUN",
      "MISSING_TASK",
      "MISSING_TERMINAL",
      "PR_CHANGED",
      "RUNTIME_MISMATCH",
      "STALE_WORKER_DONE",
    ],
  );
});

// ---------------------------------------------------------------------------
// Scenario 1 — clean running program
// ---------------------------------------------------------------------------

test("D10.1: clean running program → outcomes running, program running, exit 0", () => {
  const programId = "epic-status-running";
  const world = buildWorld({
    programId,
    receipt: null,
    manifests: [
      { run_id: "run-a", state: "dispatched", pr_number: 10, issue_number: 100 },
      { run_id: "run-b", state: "review_pending", pr_number: 11, issue_number: 101 },
    ],
    orcaScenario: { tasks: [orcaTask(programId, "a"), orcaTask(programId, "b")] },
    ghScenario: { prs: { 10: { state: "OPEN" }, 11: { state: "OPEN" } }, issues: { 100: { state: "OPEN" }, 101: { state: "OPEN" } } },
  });
  // author the receipt with mapped runs
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [
      { outcome_id: "a", run: "run-a" },
      { outcome_id: "b", run: "run-b" },
    ],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.deepEqual(Object.keys(r.body).sort(), [...REPORT_KEYS].sort());
    assert.equal(r.body.evidence_checked, true);
    assert.equal(r.body.runtime, "ok");
    assert.equal(outcomeById(r.body, "a").state, "running");
    assert.equal(outcomeById(r.body, "b").state, "running");
    assert.equal(r.body.program_state, "running");
    assert.deepEqual(Object.keys(outcomeById(r.body, "a")).sort(), [...OUTCOME_KEYS].sort());
    assert.equal(world.orca.readPoison(), null);
    assert.equal(world.gh.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 2 — fully complete program
// ---------------------------------------------------------------------------

function completeWorld(programId) {
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-done", state: "merged", pr_number: 20, issue_number: 200, head_sha: "abc123" }],
    orcaScenario: { tasks: [orcaTask(programId, "done", { status: "completed", worker_done: true })] },
    ghScenario: { prs: { 20: { state: "MERGED", mergedAt: "2026-07-12T01:00:00Z", headRefOid: "abc123" } }, issues: { 200: { state: "CLOSED", stateReason: "COMPLETED" } } },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [{ outcome_id: "done", run: "run-done" }],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  return world;
}

test("D10.2: fully complete program → complete_with_evidence everywhere, exit 0", () => {
  const world = completeWorld("epic-status-complete");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "done");
    assert.equal(outcome.state, "complete_with_evidence");
    assert.deepEqual(outcome.evidence, { manifest_terminal: true, pr_merged: true, issue_closed: true });
    assert.equal(r.body.program_state, "complete_with_evidence");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 3 — stale worker_done (never complete)
// ---------------------------------------------------------------------------

test("D10.3: Orca task done + PR open → inconsistent + STALE_WORKER_DONE, never complete", () => {
  const programId = "epic-status-stale";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-s", state: "review_pending", pr_number: 30, issue_number: 300 }],
    orcaScenario: { tasks: [orcaTask(programId, "s", { status: "completed", worker_done: true })] },
    ghScenario: { prs: { 30: { state: "OPEN" } }, issues: { 300: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "s", run: "run-s" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(outcomeById(r.body, "s").state, "inconsistent");
    assert.ok(diagCodes(r.body, "s").includes("STALE_WORKER_DONE"));
    assert.notEqual(outcomeById(r.body, "s").state, "complete_with_evidence");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 4 — missing terminal but durable evidence complete (durable wins)
// ---------------------------------------------------------------------------

test("D10.4: durable-complete with vanished terminal → complete_with_evidence + MISSING_TERMINAL", () => {
  const programId = "epic-status-missterm";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-m", state: "merged", pr_number: 40, issue_number: 400 }],
    orcaScenario: {
      tasks: [orcaTask(programId, "m", { status: "completed", worker_done: true })],
      dispatch: { "orca-live-m": { assignee: null, terminal_present: false } },
    },
    ghScenario: { prs: { 40: { state: "MERGED", mergedAt: "2026-07-12T02:00:00Z" } }, issues: { 400: { state: "CLOSED" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "m", run: "run-m" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(outcomeById(r.body, "m").state, "complete_with_evidence");
    assert.ok(diagCodes(r.body, "m").includes("MISSING_TERMINAL"));
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 5 — missing relay manifest for a dispatched mapping
// ---------------------------------------------------------------------------

test("D10.5: dispatched mapping with no relay manifest → stale_missing + MISSING_RELAY_RUN", () => {
  const programId = "epic-status-norun";
  const world = buildWorld({
    programId,
    manifests: [],
    orcaScenario: { tasks: [orcaTask(programId, "n")] },
    ghScenario: {},
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "n", run: "run-vanished" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(outcomeById(r.body, "n").state, "stale_missing");
    assert.ok(diagCodes(r.body, "n").includes("MISSING_RELAY_RUN"));
    assert.ok(r.body.repair_candidates.some((c) => c.kind === "reconcile_relay_run"));
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 6 — reopened issue after merge
// ---------------------------------------------------------------------------

test("D10.6: reopened issue after merge → inconsistent + ISSUE_REOPENED", () => {
  const programId = "epic-status-reopened";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-r", state: "merged", pr_number: 60, issue_number: 600 }],
    orcaScenario: { tasks: [orcaTask(programId, "r", { status: "completed", worker_done: true })] },
    ghScenario: { prs: { 60: { state: "MERGED", mergedAt: "2026-07-12T03:00:00Z" } }, issues: { 600: { state: "OPEN", stateReason: "REOPENED" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "r", run: "run-r" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(outcomeById(r.body, "r").state, "inconsistent");
    assert.ok(diagCodes(r.body, "r").includes("ISSUE_REOPENED"));
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 7 — PR merged while Orca task still says dispatched
// ---------------------------------------------------------------------------

test("D10.7: PR merged while Orca task dispatched → evidence recognized, durable complete wins", () => {
  const programId = "epic-status-prmerged";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-p", state: "merged", pr_number: 70, issue_number: 700 }],
    orcaScenario: { tasks: [orcaTask(programId, "p", { status: "dispatched", worker_done: false })] },
    ghScenario: { prs: { 70: { state: "MERGED", mergedAt: "2026-07-12T04:00:00Z" } }, issues: { 700: { state: "CLOSED" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "p", run: "run-p" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "p");
    assert.equal(outcome.evidence.pr_merged, true, "PR merged feeds evidence");
    assert.equal(outcome.state, "complete_with_evidence", "durable evidence outranks the lagging Orca task state");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 8 — runtime restart (live runtimeId ≠ receipt)
// ---------------------------------------------------------------------------

test("D10.8: runtime restart → runtime mismatch, Orca facts degrade, durable-complete still complete, exit 0", () => {
  const programId = "epic-status-restart";
  const otherRuntime = "99999999-9999-4999-8999-999999999999";
  const world = buildWorld({
    programId,
    runtimeId: DEFAULT_RUNTIME_ID, // the receipt's runtime
    manifests: [
      { run_id: "run-done", state: "merged", pr_number: 80, issue_number: 800 },
      { run_id: "run-live", state: "dispatched", pr_number: 81, issue_number: 801 },
    ],
    orcaScenario: {
      runtimeId: otherRuntime, // live runtime restarted
      tasks: [{ id: "foreign-1", title: "someone-else: other/thing", status: "dispatched", worker_done: false }],
    },
    ghScenario: {
      prs: { 80: { state: "MERGED", mergedAt: "2026-07-12T05:00:00Z" }, 81: { state: "OPEN" } },
      issues: { 800: { state: "CLOSED" }, 801: { state: "OPEN" } },
    },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    runtimeId: DEFAULT_RUNTIME_ID,
    tasks: [
      { outcome_id: "done", run: "run-done" },
      { outcome_id: "live", run: "run-live" },
    ],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(r.body.runtime, "mismatch");
    assert.ok(diagCodes(r.body).includes("RUNTIME_MISMATCH"));
    assert.equal(outcomeById(r.body, "done").state, "complete_with_evidence", "durable truth still renders");
    assert.equal(outcomeById(r.body, "live").state, "stale_missing", "Orca facts degrade to stale_missing");
    // foreign tasks are never attributed to this program's outcomes.
    assert.deepEqual(r.body.outcomes.map((o) => o.outcome_id).sort(), ["done", "live"]);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 9 — fail-closed receipt errors (exit 50/51/52)
// ---------------------------------------------------------------------------

test("D10.9: missing receipt → RECEIPT_NOT_FOUND exit 50", () => {
  const programId = "epic-status-missing";
  const world = buildWorld({ programId, orcaScenario: {}, ghScenario: {} });
  fs.rmSync(world.receiptPath, { force: true });
  try {
    const r = world.run();
    assert.equal(r.status, REASONS.RECEIPT_NOT_FOUND);
    assert.equal(r.body.reason_code, "RECEIPT_NOT_FOUND");
    assert.equal(r.body.ok, false);
  } finally {
    world.cleanup();
  }
});

test("D10.9: truncated receipt JSON → RECEIPT_CORRUPT exit 51", () => {
  const programId = "epic-status-corrupt";
  const world = buildWorld({ programId, orcaScenario: {}, ghScenario: {} });
  fs.writeFileSync(world.receiptPath, '{ "schema": 1, "program_id": "epic-status-corrupt", "tas', "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, REASONS.RECEIPT_CORRUPT);
    assert.equal(r.body.reason_code, "RECEIPT_CORRUPT");
  } finally {
    world.cleanup();
  }
});

test("D10.9: wrong repo slug → RECEIPT_REPO_MISMATCH exit 52", () => {
  const programId = "epic-status-wrongrepo";
  const world = buildWorld({ programId, orcaScenario: {}, ghScenario: {} });
  const receipt = makeReceipt({ programId, slug: "some-other-repo-deadbeef", root: "/tmp/other", tasks: [{ outcome_id: "x", run: "run-x" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, REASONS.RECEIPT_REPO_MISMATCH);
    assert.equal(r.body.reason_code, "RECEIPT_REPO_MISMATCH");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 10 — read-only proof
// ---------------------------------------------------------------------------

test("D10.10: status is read-only — receipt bytes identical, no gh/orca write poison fires", () => {
  const world = completeWorld("epic-status-readonly");
  try {
    const before = fs.readFileSync(world.receiptPath);
    const r = world.run();
    assert.equal(r.status, 0);
    const after = fs.readFileSync(world.receiptPath);
    assert.ok(before.equals(after), "receipt bytes must be identical before and after status");
    assert.equal(world.gh.readPoison(), null, "gh non-read poison must never fire");
    assert.equal(world.orca.readPoison(), null, "orca mutating/reset/worktree poison must never fire");
    // The gh + orca logs prove only read subcommands ran.
    world.gh.readLog().forEach((line) => assert.match(line, /^(issue view|pr view|api)/));
    world.orca.readLog().forEach((line) => assert.match(line, /^(status|orchestration (task-list|gate-list|dispatch-show))/));
  } finally {
    world.cleanup();
  }
});

test("D3: the fake gh poisons a non-read subcommand and the fake orca poisons a mutating subcommand", () => {
  const world = completeWorld("epic-status-poisoncheck");
  try {
    let ghStatus = 0;
    try {
      execFileSync(world.gh.ghPath, ["pr", "merge", "1"], { stdio: "pipe" });
    } catch (error) {
      ghStatus = error.status;
    }
    assert.notEqual(ghStatus, 0);
    assert.match(world.gh.readPoison(), /GH_WRITE_INVOKED/);

    for (const mutating of [["orchestration", "reset"], ["worktree", "create"], ["orchestration", "task-create"], ["orchestration", "dispatch", "--task", "t"]]) {
      fs.rmSync(world.orca.poisonPath, { force: true });
      let orcaStatus = 0;
      try {
        execFileSync(world.orca.orcaPath, mutating, { stdio: "pipe" });
      } catch (error) {
        orcaStatus = error.status;
      }
      assert.notEqual(orcaStatus, 0, `mutating ${mutating.join(" ")} must poison`);
      assert.ok(world.orca.readPoison(), `mutating ${mutating.join(" ")} must write a poison marker`);
    }
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 11 — duplicate mapping + back-pointer discovery
// ---------------------------------------------------------------------------

test("D10.11: duplicate mapping → DUPLICATE_MAPPING; unmapped manifest referencing the program → repair_candidate", () => {
  const programId = "epic-status-dup";
  const world = buildWorld({
    programId,
    manifests: [
      { run_id: "run-1", state: "dispatched", pr_number: 90, issue_number: 900 },
      // an orphan manifest referencing this program but absent from the receipt
      { run_id: "run-orphan", state: "dispatched", pr_number: 91, issue_number: 901, body: `# relay-orca: ${programId}/orphan` },
    ],
    orcaScenario: { tasks: [orcaTask(programId, "a"), orcaTask(programId, "b")] },
    ghScenario: { prs: { 90: { state: "OPEN" }, 91: { state: "OPEN" } }, issues: { 900: { state: "OPEN" }, 901: { state: "OPEN" } } },
  });
  // two outcomes share the SAME orca_task_id
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [
      { outcome_id: "a", orca_task_id: "orca-live-shared", run: "run-1" },
      { outcome_id: "b", orca_task_id: "orca-live-shared", run: "run-2" },
    ],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.ok(diagCodes(r.body).includes("DUPLICATE_MAPPING"));
    assert.ok(
      r.body.repair_candidates.some((c) => c.kind === "adopt_relay_run" && /run-orphan/.test(c.proposal)),
      "back-pointer discovery emits an adopt repair candidate (no mutation)",
    );
    assert.equal(world.orca.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Additional detector coverage — MISSING_TASK / MISSING_DISPATCH / PR_CHANGED
// ---------------------------------------------------------------------------

test("D7: absent Orca task → MISSING_TASK; absent dispatch → MISSING_DISPATCH", () => {
  const programId = "epic-status-misstask";
  const world = buildWorld({
    programId,
    manifests: [
      { run_id: "run-mt", state: "dispatched", pr_number: 110, issue_number: 1100 },
      { run_id: "run-md", state: "dispatched", pr_number: 111, issue_number: 1101 },
    ],
    orcaScenario: {
      // outcome "mt" has NO live task; outcome "md" has a task but dispatch-show returns no dispatch id
      tasks: [orcaTask(programId, "md")],
      dispatch: { "orca-live-md": { dispatch_id: null, assignee: "term-md", terminal_present: true } },
    },
    ghScenario: { prs: { 110: { state: "OPEN" }, 111: { state: "OPEN" } }, issues: { 1100: { state: "OPEN" }, 1101: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [
      { outcome_id: "mt", orca_task_id: "orca-live-mt", run: "run-mt" },
      { outcome_id: "md", orca_task_id: "orca-live-md", run: "run-md" },
    ],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.ok(diagCodes(r.body, "mt").includes("MISSING_TASK"));
    assert.ok(diagCodes(r.body, "md").includes("MISSING_DISPATCH"));
    assert.equal(outcomeById(r.body, "mt").state, "stale_missing");
  } finally {
    world.cleanup();
  }
});

test("D7: merged manifest with a moved live PR head → PR_CHANGED + inconsistent", () => {
  const programId = "epic-status-prchanged";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-pc", state: "merged", pr_number: 120, issue_number: 1200, head_sha: "expected-sha" }],
    orcaScenario: { tasks: [orcaTask(programId, "pc", { status: "completed", worker_done: true })] },
    ghScenario: { prs: { 120: { state: "MERGED", mergedAt: "2026-07-12T06:00:00Z", headRefOid: "moved-sha" } }, issues: { 1200: { state: "CLOSED" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "pc", run: "run-pc" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.ok(diagCodes(r.body, "pc").includes("PR_CHANGED"));
    assert.equal(outcomeById(r.body, "pc").state, "inconsistent");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Regression — a transient dispatch-show failure must NOT forge MISSING_DISPATCH
// ---------------------------------------------------------------------------

test("D7: a failed (unreachable) dispatch-show read does not forge MISSING_DISPATCH / stale_missing", () => {
  const facts = {
    receiptTask: {
      outcome_id: "x",
      task_id: "orca-task-x",
      kind: "relay_run",
      wave: 1,
      orca_task_id: "orca-live-x",
      dispatch_id: "disp-x",
      assignee: "term-x",
      relay_ids: { request: null, run: "run-x", fleet: null },
    },
    manifest: { state: "dispatched", pr_number: 1, issue_number: 2 },
    mappedRunId: "run-x",
    mappedRunMissing: false,
    orcaTask: { status: "dispatched", worker_done: false },
    orcaTaskMissing: false,
    dispatch: { ok: false, reachable: false }, // dispatch-show itself failed transiently
    gateBlocking: false,
    pr: { state: "OPEN" },
    issue: { state: "OPEN" },
    prUrl: null,
    issueUrl: null,
  };
  const { outcome, diagnostics } = classifyOutcome(facts, { orcaTrusted: true, isDuplicate: false });
  assert.equal(diagnostics.some((d) => d.code === "MISSING_DISPATCH"), false, "a flaky dispatch-show read must not forge MISSING_DISPATCH");
  assert.equal(outcome.state, "running", "the outcome stays running, not stale_missing, on a transient read failure");
});

// ---------------------------------------------------------------------------
// Regression — a force-closed (abandoned) relay manifest is escalated, not running
// ---------------------------------------------------------------------------

test("D5: a closed (abandoned, unmerged) relay manifest → escalated, never a silent running", () => {
  const programId = "epic-status-closed";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-c", state: "closed", pr_number: 160, issue_number: 1600 }],
    orcaScenario: { tasks: [orcaTask(programId, "c", { status: "dispatched", worker_done: false })] },
    ghScenario: { prs: { 160: { state: "OPEN" } }, issues: { 1600: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "c", run: "run-c" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(outcomeById(r.body, "c").state, "escalated");
    assert.equal(r.body.program_state, "escalated");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 13 — awaiting decision (pending gate)
// ---------------------------------------------------------------------------

test("D10.13: a pending gate blocking a task → outcome awaiting_decision", () => {
  const programId = "epic-status-gate";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-g", state: "dispatched", pr_number: 130, issue_number: 1300 }],
    orcaScenario: {
      tasks: [orcaTask(programId, "g")],
      gates: [{ id: "sec-gate", task_id: "orca-live-g", status: "pending" }],
    },
    ghScenario: { prs: { 130: { state: "OPEN" } }, issues: { 1300: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "g", run: "run-g" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(outcomeById(r.body, "g").state, "awaiting_decision");
    assert.equal(r.body.program_state, "awaiting_decision");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 14 — ready for next wave
// ---------------------------------------------------------------------------

test("D10.14: wave-1 complete, wave-2 pending → program ready_for_next_wave", () => {
  const programId = "epic-status-nextwave";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-w1", state: "merged", pr_number: 140, issue_number: 1400 }],
    orcaScenario: {
      tasks: [
        orcaTask(programId, "w1", { status: "completed", worker_done: true }),
        orcaTask(programId, "w2", { status: "pending", worker_done: false }),
      ],
    },
    ghScenario: { prs: { 140: { state: "MERGED", mergedAt: "2026-07-12T07:00:00Z" } }, issues: { 1400: { state: "CLOSED" } } },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [
      { outcome_id: "w1", wave: 1, run: "run-w1" },
      { outcome_id: "w2", wave: 2, dispatch_id: null, assignee: null, run: null },
    ],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(outcomeById(r.body, "w1").state, "complete_with_evidence");
    assert.equal(r.body.program_state, "ready_for_next_wave");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D11 engine-agnostic — receipt fixture + rendered report carry no engine tokens
// ---------------------------------------------------------------------------

test("D11: neither the receipt fixture nor a rendered status report names an engine/model", () => {
  const world = completeWorld("epic-status-agnostic");
  try {
    const receiptBytes = fs.readFileSync(world.receiptPath, "utf-8").toLowerCase();
    FORBIDDEN_ENGINE_TOKENS.forEach((token) => assert.equal(receiptBytes.includes(token), false, `receipt leaked ${token}`));
    const r = world.run();
    const reportBytes = JSON.stringify(r.body).toLowerCase();
    FORBIDDEN_ENGINE_TOKENS.forEach((token) => assert.equal(reportBytes.includes(token), false, `report leaked ${token}`));
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9 degraded-path key set + usage
// ---------------------------------------------------------------------------

test("D9: a degraded (runtime unreachable) view still emits the exact nine keys and exits 0", () => {
  const programId = "epic-status-unreachable";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-u", state: "dispatched", pr_number: 150, issue_number: 1500 }],
    orcaScenario: { statusOk: false },
    ghScenario: { prs: { 150: { state: "OPEN" } }, issues: { 1500: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "u", run: "run-u" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(r.body.runtime, "unreachable");
    assert.deepEqual(Object.keys(r.body).sort(), [...REPORT_KEYS].sort());
    assert.equal(r.body.evidence_checked, true);
    assert.equal(outcomeById(r.body, "u").state, "stale_missing");
  } finally {
    world.cleanup();
  }
});

test("usage: missing --program-id exits 64", () => {
  const result = { status: 0 };
  try {
    execFileSync(process.execPath, [STATUS_JS, "--json"], { stdio: "pipe" });
  } catch (error) {
    result.status = error.status;
  }
  assert.equal(result.status, 64);
});
