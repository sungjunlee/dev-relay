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
const { discoverBackPointers } = require(path.join(SCRIPTS, "lib", "status-derive.js"));
const { orcaDispatchShow } = require(path.join(SCRIPTS, "lib", "orca-reads.js"));
const { RECEIPT_NOTE } = require(path.join(SCRIPTS, "lib", "receipt.js"));
const { computeRepoSlug } = require(path.join(SCRIPTS, "lib", "repo-slug.js"));
const {
  programSegment,
  runsRoot: resolveRunsRoot,
  fleetsRoot: resolveFleetsRoot,
  resolveCanonicalRepoRoot,
  resolveRepoContext,
} = require(path.join(SCRIPTS, "receipt-io.js"));
// status.js guards main() behind `require.main === module`, so importing it here exercises
// the A28 read-only boundary directly without triggering a real status run.
const { assertGhReadOnly } = require(STATUS_JS);
const { installFakeOrcaStatus } = require(path.join(__dirname, "..", "fixtures", "fake-orca-status.js"));
const { installFakeGh } = require(path.join(__dirname, "..", "fixtures", "fake-gh.js"));
const { DEFAULT_RUNTIME_ID } = require(path.join(__dirname, "..", "fixtures", "fake-orca.js"));
const { assertReceiptEngineAgnostic } = require("./receipt-hygiene.js");

const FORBIDDEN_ENGINE_TOKENS = ["codex", "claude", "cursor", "cline", "opencode"];

// --- receipt / manifest / scenario builders ------------------------------------

function makeReceipt({ programId, slug, root, runtimeId, tasks }) {
  return {
    schema: 1,
    program_id: programId,
    source: "/tmp/accepted-program.json",
    repo: { slug, root },
    runtime_id: runtimeId || DEFAULT_RUNTIME_ID,
    tasks: tasks.map((task) => {
      const orcaTaskId = task.orca_task_id === undefined ? `orca-live-${task.outcome_id}` : task.orca_task_id;
      // Default the recorded dispatch id to what the fake orca's dispatch-show returns
      // for this task ("disp-" + orca_task_id), so a healthy (non-drifted) scenario has
      // the live dispatch id EQUAL the receipt's — drift (#945 A10) is then modeled by
      // an explicit dispatch_id override in the scenario.
      const defaultDispatchId = orcaTaskId ? `disp-${orcaTaskId}` : `disp-${task.outcome_id}`;
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
    // A26/D4: the real mid-2026 task-list row carries `task_title` (and `display_name`),
    // NOT `title`. run.js titles tasks with the collision-resistant program SEGMENT, not
    // the raw id, so a healthy fixture row must carry the SAME segment for the foreign-task
    // check (resolved display string `.includes("relay-orca: <segment>/")`) to attribute it.
    task_title: `relay-orca: ${programSegment(programId)}/${outcome}`,
    display_name: `relay-orca: ${programSegment(programId)}/${outcome}`,
    status: extra.status || "dispatched",
    worker_done: extra.worker_done === true,
  };
}

// Real mid-2026 fingerprint row used by #1063: exact task_title marker plus the
// materialized JSON spec identity. Dispatch provenance remains nested under
// result.dispatch in the fake CLI, with assignee_handle and no coordinator field.
function fingerprintedOrcaTask(programId, outcome, extra = {}) {
  return {
    ...orcaTask(programId, outcome),
    spec: JSON.stringify({
      marker: "relay-orca",
      program_id: programId,
      program_segment: programSegment(programId),
      outcome_id: outcome,
      task_kind: "relay_run",
      wave: 1,
      depends_on: [],
    }),
    ...extra,
  };
}

// A relay-fleet manifest fixture matching the real shape (#945 A3): `fleet_id`,
// `fleet_state`, and a single-line JSON `children` array of { leaf_ref, run_id, ... }.
// Detected by buildWorld via the presence of `fleet_state`.
function fleetManifestText(fields) {
  const children = JSON.stringify(fields.children || []);
  const lines = [
    "---",
    `fleet_id: '${fields.fleet_id || fields.run_id}'`,
    `fleet_state: '${fields.fleet_state}'`,
    `children: ${children}`,
    "timestamps:",
    "  created_at: '2026-07-12T00:00:00.000Z'",
    "  updated_at: '2026-07-12T00:00:00.000Z'",
    "---",
    "# Notes",
  ];
  if (fields.body) lines.push(fields.body);
  return `${lines.join("\n")}\n`;
}

function gate(orcaTaskId, extra = {}) {
  return { id: extra.id || `gate-${orcaTaskId}`, task_id: orcaTaskId, status: extra.status || "pending", kind: extra.kind };
}

// --- world harness -------------------------------------------------------------

// Initialize a REAL (tiny) git repo so `resolveCanonicalRepoRoot` succeeds. A24 removed
// the non-git realpath fallback (git-failure now fails closed with exit 52), so the
// hermetic --repo-root MUST be a git checkout. A freshly-init'd repo's git-common-dir is
// `<root>/.git`, whose parent realpath's back to `<root>` — the same slug the fallback
// used to yield — so every downstream slug/receipt-path assertion stays byte-stable.
function initGitRepo(root) {
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
}

function buildWorld({ programId, receipt, manifests = [], orcaScenario = {}, ghScenario = {}, runtimeId }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-status-"));
  const repoRoot = path.join(base, "repo");
  const programsRoot = path.join(base, "programs");
  const runsRoot = path.join(base, "runs");
  // Fleet manifests live under a SEPARATE fleets root (#945 A8), modeling relay's real
  // split: child run manifests under runs root, fleet manifests under fleets root.
  const fleetsRoot = path.join(base, "fleets");
  fs.mkdirSync(repoRoot, { recursive: true });
  initGitRepo(repoRoot);
  const slug = computeRepoSlug(fs.realpathSync(repoRoot));

  const receiptObject = receipt || makeReceipt({ programId, slug, root: fs.realpathSync(repoRoot), runtimeId, tasks: [] });
  if (receiptObject.repo && receiptObject.repo.slug === "__SELF__") receiptObject.repo.slug = slug;
  // The receipt lives at the SAME collision-resistant segment path status.js derives
  // (#945 A6) so `run`-written receipts resolve back for `status`.
  const receiptDir = path.join(programsRoot, slug, programSegment(programId));
  fs.mkdirSync(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, "receipt.json");
  fs.writeFileSync(receiptPath, `${JSON.stringify(receiptObject, null, 2)}\n`, "utf-8");

  const runsDir = path.join(runsRoot, slug);
  const fleetsDir = path.join(fleetsRoot, slug);
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(fleetsDir, { recursive: true });
  // A fleet manifest (detected by `fleet_state`) lands under the fleets root; every
  // ordinary run manifest (including fleet CHILDREN) lands under the runs root.
  manifests.forEach((fields) => {
    if (fields.fleet_state !== undefined) {
      fs.writeFileSync(path.join(fleetsDir, `${fields.run_id}.md`), fleetManifestText(fields), "utf-8");
    } else {
      fs.writeFileSync(path.join(runsDir, `${fields.run_id}.md`), manifestText(fields), "utf-8");
    }
  });

  const orca = installFakeOrcaStatus({ runtimeId: runtimeId || DEFAULT_RUNTIME_ID, ...orcaScenario });
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
    run(extraArgs = [], runOptions = {}) {
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
          env: {
            ...process.env,
            RELAY_ORCA_PROGRAMS_ROOT: programsRoot,
            RELAY_ORCA_RUNS_ROOT: runsRoot,
            RELAY_ORCA_FLEETS_ROOT: fleetsRoot,
          },
          cwd: runOptions.cwd || undefined,
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

test("D7: the detector codes exist verbatim in DIAGNOSTIC_CODES", () => {
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
      "SUPERSEDED_MARKED_RUN",
    ],
  );
});

test("#1066: marked-run discovery only suppresses a closed exact-outcome residue with mapped complete evidence", () => {
  const programId = "pilot-1066";
  const programSegment = () => "pilot-1066-segment";
  const discover = ({ state, markerOutcome = "a", tasks, outcomes }) => {
    const diagnostics = [];
    const candidates = discoverBackPointers({
      manifests: [{ run_id: `run-${state || "absent"}`, text: `relay-orca: pilot-1066-segment/${markerOutcome}`, parsed: state === undefined ? {} : { state } }],
      tasks: tasks || [{ outcome_id: "a", relay_ids: { run: null } }],
      outcomes: outcomes || [],
      programId,
      programSegment,
    }, diagnostics);
    return { candidates, diagnostics };
  };

  const superseded = discover({
    state: "closed",
    tasks: [{ outcome_id: "a", relay_ids: { run: "run-superseding" } }],
    outcomes: [{ outcome_id: "a", state: "complete_with_evidence" }],
  });
  assert.deepEqual(superseded.candidates, []);
  assert.equal(superseded.diagnostics[0].code, "SUPERSEDED_MARKED_RUN");
  assert.deepEqual(superseded.diagnostics[0].ids, {
    superseded_run_id: "run-closed",
    superseding_run_id: "run-superseding",
  });

  const closedWithoutComplete = discover({ state: "closed" });
  assert.equal(closedWithoutComplete.candidates[0].kind, "adopt_relay_run");
  assert.deepEqual(closedWithoutComplete.diagnostics, []);

  const differentOutcome = discover({
    state: "closed",
    markerOutcome: "b",
    tasks: [
      { outcome_id: "a", relay_ids: { run: "run-complete-a" } },
      { outcome_id: "b", relay_ids: { run: null } },
    ],
    outcomes: [{ outcome_id: "a", state: "complete_with_evidence" }],
  });
  assert.equal(differentOutcome.candidates[0].kind, "adopt_relay_run");

  for (const state of ["draft", "dispatched", "review_pending", "changes_requested", "ready_to_merge", "escalated", "merged", "unparseable", undefined]) {
    const result = discover({ state: state === "unparseable" ? "[invalid" : state });
    assert.equal(result.candidates.length, 1, `state ${String(state)} remains blocking`);
    assert.deepEqual(result.diagnostics, [], `state ${String(state)} is not classified as superseded`);
  }
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
      tasks: [{ id: "foreign-1", task_title: "someone-else: other/thing", status: "dispatched", worker_done: false }],
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

test("#1063 status: complete proof is a read-only runtime rebind repair candidate", () => {
  const programId = "epic-status-runtime-rebind";
  const oldRuntime = DEFAULT_RUNTIME_ID;
  const newRuntime = "99999999-9999-4999-8999-999999999999";
  const world = buildWorld({
    programId,
    runtimeId: oldRuntime,
    orcaScenario: {
      runtimeId: newRuntime,
      tasks: [fingerprintedOrcaTask(programId, "a")],
    },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    runtimeId: oldRuntime,
    tasks: [{ outcome_id: "a" }],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  const before = fs.readFileSync(world.receiptPath, "utf-8");
  try {
    const result = world.run();
    assert.equal(result.status, 0);
    assert.equal(result.body.runtime, "mismatch");
    const candidate = result.body.repair_candidates.find((entry) => entry.kind === "runtime_rebind");
    assert.deepEqual(candidate, {
      kind: "runtime_rebind",
      old_runtime_id: oldRuntime,
      new_runtime_id: newRuntime,
      verified_rows: [{ orca_task_id: "orca-live-a", outcome_id: "a" }],
      proposal: `receipt runtime ${oldRuntime} can be rebound to live runtime ${newRuntime} from a complete task fingerprint proof; status performed no mutation`,
    });
    assert.equal(fs.readFileSync(world.receiptPath, "utf-8"), before, "status never writes the receipt");
    assert.equal(world.orca.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D4 — real task-list row shape (task_title, no title) + nested dispatch facts
// ---------------------------------------------------------------------------

test("D4.1: the verbatim live task_title row (no title key) attributes the runtime as OWNED, not foreign_state", () => {
  const programId = "pilot-948";
  // The exact live row captured on 2026-07-13 (Done Criteria D4): task_title carries the
  // program marker; there is NO `title` key. Program `pilot-948` resolves to the same segment.
  assert.equal(programSegment(programId), "pilot-948-92ff09e7");
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-g", state: "dispatched", pr_number: 990, issue_number: 9900 }],
    orcaScenario: {
      tasks: [
        {
          id: "task_5a43aa730015",
          parent_id: null,
          created_by_terminal_handle: "term_a18f2822-64ad-4825-9e43-a2135ca3a0ea",
          task_title: "relay-orca: pilot-948-92ff09e7/gh-guard-990",
          display_name: "relay-orca: pilot-948-92ff09e7/gh-guard-990",
          status: "dispatched",
          deps: "[]",
          result: null,
        },
      ],
    },
    ghScenario: { prs: { 990: { state: "OPEN" } }, issues: { 9900: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [{ outcome_id: "gh-guard-990", orca_task_id: "task_5a43aa730015", run: "run-g" }],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(r.body.runtime, "ok", "the markered real row attributes the runtime as owned");
    assert.equal(diagCodes(r.body).includes("RUNTIME_MISMATCH"), false, "an owned runtime never fires RUNTIME_MISMATCH");
    assert.equal(world.orca.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

test("D4.2: a real task_title row LACKING the program marker still forces foreign_state", () => {
  const programId = "pilot-948";
  const world = buildWorld({
    programId,
    orcaScenario: {
      tasks: [{ id: "task_intruder", task_title: "relay-orca: someone-else-deadbeef/other", display_name: "relay-orca: someone-else-deadbeef/other", status: "dispatched" }],
    },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "x" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(r.body.runtime, "foreign_state", "an unmarkered real row makes the runtime foreign");
    assert.ok(diagCodes(r.body).includes("RUNTIME_MISMATCH"));
    assert.equal(world.orca.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

test("D4.3: status derives provenance from the nested result.dispatch shape (present → no MISSING_*, terminal_present:false → MISSING_TERMINAL)", () => {
  const programId = "epic-status-nested-dispatch";
  const world = buildWorld({
    programId,
    manifests: [
      { run_id: "run-ok", state: "dispatched", pr_number: 70, issue_number: 700 },
      { run_id: "run-lost", state: "dispatched", pr_number: 71, issue_number: 701 },
    ],
    orcaScenario: {
      tasks: [orcaTask(programId, "ok"), orcaTask(programId, "lost")],
      // 'lost' outcome: dispatch present but the operator terminal is gone
      // (nested terminal_present:false in the real result.dispatch shape).
      dispatch: { "orca-live-lost": { terminal_present: false } },
    },
    ghScenario: { prs: { 70: { state: "OPEN" }, 71: { state: "OPEN" } }, issues: { 700: { state: "OPEN" }, 701: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [
      { outcome_id: "ok", orca_task_id: "orca-live-ok", run: "run-ok" },
      { outcome_id: "lost", orca_task_id: "orca-live-lost", run: "run-lost" },
    ],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(r.body.runtime, "ok");
    // 'ok' outcome: full nested provenance present → no MISSING_* diagnostics forged.
    assert.equal(diagCodes(r.body, "ok").some((c) => c.startsWith("MISSING_")), false, "nested provenance present yields no MISSING_* for ok");
    // 'lost' outcome: nested terminal_present:false feeds MISSING_TERMINAL.
    assert.ok(diagCodes(r.body, "lost").includes("MISSING_TERMINAL"), "nested terminal_present:false feeds MISSING_TERMINAL");
    assert.equal(world.orca.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

test("D4.3: a present result.dispatch is authoritative — empty nested facts resolve null, never rescued by flat fields", () => {
  // The dispatch-show payload nests provenance under an authoritative result.dispatch whose
  // fields are empty, while legacy flat result.* fields carry conflicting values. Every fact
  // must resolve from the nested object ONLY: empty nested → null, and the empty nested
  // assignee (with no explicit terminal_present) yields terminalPresent:false.
  const payload = {
    ok: true,
    result: {
      dispatch: { task_id: "", id: "", assignee_handle: "" },
      task_id: "flat-task",
      dispatch_id: "flat-disp",
      assignee: "flat-term",
    },
  };
  const show = orcaDispatchShow(() => ({ status: 0, stdout: JSON.stringify(payload), stderr: "" }), "orca", "flat-task");
  assert.equal(show.ok, true);
  assert.equal(show.taskId, null, "empty nested task_id resolves null, never the flat value");
  assert.equal(show.dispatchId, null, "empty nested dispatch id resolves null, never the flat value");
  assert.equal(show.assignee, null, "empty nested assignee resolves null, never the flat value");
  assert.equal(show.terminalPresent, false, "a null resolved assignee means the terminal is gone");
});

// ---------------------------------------------------------------------------
// A26 — the foreign-task marker embeds the collision-resistant program segment
// ---------------------------------------------------------------------------

test("A26: program `alpha` does NOT adopt a task titled for `alpha/child` (distinct segments); a same-segment task IS adopted", () => {
  const programId = "alpha";
  const siblingId = "alpha/child";
  assert.notEqual(programSegment(programId), programSegment(siblingId), "the two program ids must resolve to DISTINCT segments");

  // (a) collision avoided: the ONLY live task is titled for the SIBLING program
  //     `alpha/child`. With the raw-id marker `relay-orca: alpha/` this task WOULD have
  //     been adopted as alpha's (`alpha/child/...`.includes(`alpha/`)); the segment-based
  //     marker is not a prefix of the sibling's segment, so it is FOREIGN and never adopted.
  const foreign = buildWorld({
    programId,
    manifests: [{ run_id: "run-al", state: "dispatched", pr_number: 12, issue_number: 120 }],
    orcaScenario: {
      tasks: [{ id: "orca-live-sib", task_title: `relay-orca: ${programSegment(siblingId)}/child-oc`, status: "dispatched", worker_done: false }],
    },
    ghScenario: { prs: { 12: { state: "OPEN" } }, issues: { 120: { state: "OPEN" } } },
  });
  const foreignReceipt = makeReceipt({ programId, slug: foreign.slug, root: fs.realpathSync(foreign.repoRoot), tasks: [{ outcome_id: "al", run: "run-al" }] });
  fs.writeFileSync(foreign.receiptPath, `${JSON.stringify(foreignReceipt, null, 2)}\n`, "utf-8");
  try {
    const r = foreign.run();
    assert.equal(r.status, 0);
    assert.equal(r.body.runtime, "foreign_state", "a task titled for alpha/child is foreign to alpha");
    assert.ok(diagCodes(r.body).includes("RUNTIME_MISMATCH"));
    // durable truth still renders; Orca facts degrade because the runtime is foreign.
    assert.equal(outcomeById(r.body, "al").state, "stale_missing");
  } finally {
    foreign.cleanup();
  }

  // (b) healthy adoption still works: a task titled with alpha's OWN segment is adopted →
  //     runtime ok, the mapped outcome renders normally.
  const healthy = buildWorld({
    programId,
    manifests: [{ run_id: "run-al2", state: "dispatched", pr_number: 13, issue_number: 130 }],
    orcaScenario: { tasks: [orcaTask(programId, "al2")] },
    ghScenario: { prs: { 13: { state: "OPEN" } }, issues: { 130: { state: "OPEN" } } },
  });
  const healthyReceipt = makeReceipt({ programId, slug: healthy.slug, root: fs.realpathSync(healthy.repoRoot), tasks: [{ outcome_id: "al2", run: "run-al2" }] });
  fs.writeFileSync(healthy.receiptPath, `${JSON.stringify(healthyReceipt, null, 2)}\n`, "utf-8");
  try {
    const r = healthy.run();
    assert.equal(r.status, 0);
    assert.equal(r.body.runtime, "ok", "alpha's own segment-marked task is adopted");
    assert.equal(outcomeById(r.body, "al2").state, "running");
  } finally {
    healthy.cleanup();
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
// A28 — the read-only gh boundary rejects mutation-shaped `gh api`
// ---------------------------------------------------------------------------

// Layer 1: the status.js structural guard (`assertGhReadOnly`).
test("A28: assertGhReadOnly refuses mutation-shaped `gh api`, allows bare GET reads", () => {
  // Body/field options make `gh api` default to a POST — every form is a write.
  for (const argv of [
    ["api", "repos/x", "-f", "a=b"],
    ["api", "repos/x", "--field", "a=b"],
    ["api", "repos/x", "-F", "a=b"],
    ["api", "repos/x", "--raw-field", "a=b"],
    ["api", "repos/x", "--input", "body.json"],
    ["api", "repos/x", "--field=a=b"],
    ["api", "repos/x", "--raw-field=a=b"],
    ["api", "repos/x", "--input=body.json"],
    ["api", "repos/x", "-fa=b"],
    ["api", "repos/x", "-Fa=b"],
    ["api", "repos/x", "-ifa=b"],
    ["api", "repos/x", "-iFa=b"],
  ]) {
    assert.throws(() => assertGhReadOnly(argv), /non-read gh subcommand/, `must reject: gh ${argv.join(" ")}`);
  }
  // Explicit non-GET method (separated or attached) is a write.
  for (const argv of [
    ["api", "-X", "POST", "repos/x"],
    ["api", "--method", "PATCH", "repos/x"],
    ["api", "-XDELETE", "repos/x"],
    ["api", "-iXPOST", "repos/x"],
    ["api", "--method=PUT", "repos/x"],
    ["api", "repos/x", "POST"],
  ]) {
    assert.throws(() => assertGhReadOnly(argv), /non-read gh subcommand/, `must reject: gh ${argv.join(" ")}`);
  }
  // Read-shaped invocations are allowed: bare/`-X GET` api reads and the two view reads.
  for (const argv of [
    ["api", "repos/x"],
    ["api", "repos/x", "--jq", ".state"],
    ["api", "-X", "GET", "repos/x"],
    ["api", "-XGET", "repos/x"],
    ["api", "-iXGET", "repos/x"],
    ["issue", "view", "1", "--json", "state,stateReason"],
    ["pr", "view", "2", "--json", "mergedAt,state"],
  ]) {
    assert.doesNotThrow(() => assertGhReadOnly(argv), `must allow: gh ${argv.join(" ")}`);
  }
  // A non-view, non-api write subcommand is still refused (existing contract).
  assert.throws(() => assertGhReadOnly(["pr", "merge", "1"]), /non-read gh subcommand/);
});

// Layer 2: the fake-gh poison used by the read-only tests.
test("A28: the fake gh poison rejects mutation-shaped `gh api` and serves a bare GET", () => {
  const gh = installFakeGh({});
  try {
    for (const argv of [
      ["api", "repos/x", "-f", "a=b"],
      ["api", "repos/x", "--field", "a=b"],
      ["api", "repos/x", "--field=a=b"],
      ["api", "repos/x", "--raw-field=a=b"],
      ["api", "repos/x", "--input=body.json"],
      ["api", "repos/x", "-fa=b"],
      ["api", "repos/x", "-Fa=b"],
      ["api", "repos/x", "-ifa=b"],
      ["api", "repos/x", "-iFa=b"],
      ["api", "-X", "POST", "repos/x"],
      ["api", "--method=PATCH", "repos/x"],
      ["api", "-iXPOST", "repos/x"],
      ["api", "repos/x", "--input", "body.json"],
    ]) {
      fs.rmSync(gh.poisonPath, { force: true });
      let code = 0;
      try {
        execFileSync(gh.ghPath, argv, { stdio: "pipe" });
      } catch (error) {
        code = error.status;
      }
      assert.notEqual(code, 0, `gh ${argv.join(" ")} must poison`);
      assert.match(gh.readPoison(), /GH_WRITE_INVOKED/, `gh ${argv.join(" ")} must write a poison marker`);
    }
    // Bare and explicitly attached GET `gh api` reads are served (exit 0), no poison.
    for (const argv of [["api", "repos/x"], ["api", "-XGET", "repos/x"], ["api", "-iXGET", "repos/x"]]) {
      fs.rmSync(gh.poisonPath, { force: true });
      const out = execFileSync(gh.ghPath, argv, { stdio: "pipe", encoding: "utf-8" });
      assert.equal(gh.readPoison(), null, `gh ${argv.join(" ")} must never poison`);
      assert.equal(out, "{}", `the fake serves read-shaped gh ${argv.join(" ")}`);
    }
  } finally {
    gh.cleanup();
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

test("D10.11: segment-only markers discover unmapped run and fleet back-pointers", () => {
  const programId = "epic status/segment";
  const segment = programSegment(programId);
  assert.equal(segment.includes(programId), false, "the raw id must not occur inside its sanitized segment");
  const world = buildWorld({
    programId,
    manifests: [
      { run_id: "run-segment", state: "dispatched", pr_number: 191, issue_number: 1901, body: `relay-orca: ${segment}/run-outcome` },
      { run_id: "fleet-segment", fleet_state: "dispatching", children: [], body: `relay-orca: ${segment}/fleet-outcome` },
    ],
    orcaScenario: { tasks: [orcaTask(programId, "existing")] },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [{ outcome_id: "existing" }],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  const before = fs.readFileSync(world.receiptPath, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.ok(r.body.repair_candidates.some((candidate) => candidate.kind === "adopt_relay_run" && /run-segment/.test(candidate.proposal)));
    assert.ok(r.body.repair_candidates.some((candidate) => candidate.kind === "adopt_relay_fleet" && /fleet-segment/.test(candidate.proposal)));
    assert.equal(fs.readFileSync(world.receiptPath, "utf-8"), before, "segment discovery is mutation-free");
  } finally {
    world.cleanup();
  }
});

// A2 (#946 R2, owner amendment A2) — an unmapped FLEET manifest under the SEPARATE fleets
// root referencing the program → adopt_relay_fleet repair candidate (mirrors the runs-root
// back-pointer discovery so resume can block a duplicate fleet redispatch).
test("A2: unmapped fleet manifest (fleets root) referencing the program → adopt_relay_fleet repair_candidate", () => {
  const programId = "epic-status-fleet-orphan";
  const world = buildWorld({
    programId,
    manifests: [
      { run_id: "run-1", state: "dispatched", pr_number: 92, issue_number: 902 },
      // an orphan FLEET manifest (lands under the fleets root via `fleet_state`) referencing
      // this program but absent from the receipt's relay_ids.fleet mappings.
      { run_id: "fleet-orphan", fleet_state: "dispatching", children: [], body: `relay-orca program ${programId} operator fleet` },
    ],
    orcaScenario: { tasks: [orcaTask(programId, "a")] },
    ghScenario: { prs: { 92: { state: "OPEN" } }, issues: { 902: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [{ outcome_id: "a", orca_task_id: "orca-live-a", run: "run-1" }],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.ok(
      r.body.repair_candidates.some((c) => c.kind === "adopt_relay_fleet" && /fleet-orphan/.test(c.proposal)),
      "fleet back-pointer discovery emits an adopt_relay_fleet repair candidate (no mutation)",
    );
    assert.equal(world.orca.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

// A2 — a fleet manifest that IS mapped in relay_ids.fleet is NOT reported as unmapped
// back-pointer work (the properly mapped variant is unaffected).
test("A2: a fleet manifest mapped in relay_ids.fleet emits NO adopt_relay_fleet candidate", () => {
  const programId = "epic-status-fleet-mapped";
  const world = buildWorld({
    programId,
    manifests: [
      { run_id: "fleet-mapped", fleet_state: "dispatching", children: [], body: `relay-orca program ${programId} operator fleet` },
    ],
    orcaScenario: { tasks: [orcaTask(programId, "fc")] },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [{ outcome_id: "fc", kind: "relay_fleet", orca_task_id: "orca-live-fc", fleet: "fleet-mapped" }],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.ok(
      !r.body.repair_candidates.some((c) => c.kind === "adopt_relay_fleet"),
      "a mapped fleet is never reported as unmapped fleet back-pointer work",
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
// A14 — relay_run completion is merged-only (a closed manifest never completes)
// ---------------------------------------------------------------------------

test("A14: a closed manifest with a merged PR + closed issue → escalated, never complete; the merged variant stays complete", () => {
  // Closed variant: the run manifest is force-closed (terminal, but NOT merged) yet the
  // PR shows MERGED and the issue shows CLOSED. A14 requires state === "merged" for
  // relay_run completion, so `manifest_terminal` stays false and the outcome escalates —
  // it must never complete off the stray merged PR / closed issue.
  const closedProgram = "epic-status-closed-merged-pr";
  const closedWorld = buildWorld({
    programId: closedProgram,
    manifests: [{ run_id: "run-cm", state: "closed", pr_number: 170, issue_number: 1700 }],
    orcaScenario: { tasks: [orcaTask(closedProgram, "cm", { status: "dispatched", worker_done: false })] },
    ghScenario: { prs: { 170: { state: "MERGED", mergedAt: "2026-07-12T11:00:00Z" } }, issues: { 1700: { state: "CLOSED" } } },
  });
  const closedReceipt = makeReceipt({ programId: closedProgram, slug: closedWorld.slug, root: fs.realpathSync(closedWorld.repoRoot), tasks: [{ outcome_id: "cm", run: "run-cm" }] });
  fs.writeFileSync(closedWorld.receiptPath, `${JSON.stringify(closedReceipt, null, 2)}\n`, "utf-8");
  try {
    const r = closedWorld.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "cm");
    assert.equal(outcome.state, "escalated", "a closed (not merged) manifest can never yield completion evidence");
    assert.notEqual(outcome.state, "complete_with_evidence");
    assert.equal(outcome.evidence.manifest_terminal, false, "manifest_terminal is merged-only, not any-terminal");
    assert.equal(r.body.program_state, "escalated");
  } finally {
    closedWorld.cleanup();
  }

  // Merged variant: the SAME PR/issue evidence with a `merged` manifest stays complete.
  const mergedProgram = "epic-status-merged-variant";
  const mergedWorld = buildWorld({
    programId: mergedProgram,
    manifests: [{ run_id: "run-mm", state: "merged", pr_number: 171, issue_number: 1710 }],
    orcaScenario: { tasks: [orcaTask(mergedProgram, "mm", { status: "completed", worker_done: true })] },
    ghScenario: { prs: { 171: { state: "MERGED", mergedAt: "2026-07-12T11:05:00Z" } }, issues: { 1710: { state: "CLOSED" } } },
  });
  const mergedReceipt = makeReceipt({ programId: mergedProgram, slug: mergedWorld.slug, root: fs.realpathSync(mergedWorld.repoRoot), tasks: [{ outcome_id: "mm", run: "run-mm" }] });
  fs.writeFileSync(mergedWorld.receiptPath, `${JSON.stringify(mergedReceipt, null, 2)}\n`, "utf-8");
  try {
    const r = mergedWorld.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "mm");
    assert.equal(outcome.state, "complete_with_evidence", "the merged variant still completes on the same evidence");
    assert.deepEqual(outcome.evidence, { manifest_terminal: true, pr_merged: true, issue_closed: true });
  } finally {
    mergedWorld.cleanup();
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
    const receipt = JSON.parse(fs.readFileSync(world.receiptPath, "utf-8"));
    assertReceiptEngineAgnostic(receipt);
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

// ---------------------------------------------------------------------------
// A3 — per-task-kind evidence contracts (each kind names its own live checks)
// ---------------------------------------------------------------------------

test("A3 relay_fleet complete: every child terminal + fleet manifest closed → complete_with_evidence", () => {
  const programId = "epic-status-fleet-ok";
  const world = buildWorld({
    programId,
    manifests: [
      { run_id: "fleet-a", fleet_state: "closed", children: [{ leaf_ref: "l1", run_id: "child-1" }, { leaf_ref: "l2", run_id: "child-2" }] },
      { run_id: "child-1", state: "merged", pr_number: 201, issue_number: 2001 },
      { run_id: "child-2", state: "merged", pr_number: 202, issue_number: 2002 },
    ],
    orcaScenario: { tasks: [orcaTask(programId, "fc", { status: "completed", worker_done: true })] },
    ghScenario: {},
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "fc", kind: "relay_fleet", fleet: "fleet-a" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "fc");
    assert.equal(outcome.state, "complete_with_evidence");
    assert.deepEqual(outcome.evidence, { fleet_children_terminal: true, fleet_manifest_closed: true });
  } finally {
    world.cleanup();
  }
});

test("A3 relay_fleet not complete: a non-terminal child holds the outcome back", () => {
  const programId = "epic-status-fleet-partial";
  const world = buildWorld({
    programId,
    manifests: [
      { run_id: "fleet-b", fleet_state: "closed", children: [{ leaf_ref: "l1", run_id: "child-x" }, { leaf_ref: "l2", run_id: "child-y" }] },
      { run_id: "child-x", state: "merged", pr_number: 210, issue_number: 2100 },
      { run_id: "child-y", state: "review_pending", pr_number: 211, issue_number: 2101 },
    ],
    orcaScenario: { tasks: [orcaTask(programId, "fp")] },
    ghScenario: {},
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "fp", kind: "relay_fleet", fleet: "fleet-b" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "fp");
    assert.notEqual(outcome.state, "complete_with_evidence");
    assert.equal(outcome.evidence.fleet_children_terminal, false);
    assert.equal(outcome.evidence.fleet_manifest_closed, true);
  } finally {
    world.cleanup();
  }
});

test("A3 integration_gate complete: a passing live gate → complete_with_evidence", () => {
  const programId = "epic-status-igate-ok";
  const world = buildWorld({
    programId,
    manifests: [],
    orcaScenario: {
      tasks: [orcaTask(programId, "ig")],
      gates: [gate("orca-live-ig", { status: "passed", kind: "integration" })],
    },
    ghScenario: {},
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "ig", kind: "integration_gate" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "ig");
    assert.equal(outcome.state, "complete_with_evidence");
    assert.deepEqual(outcome.evidence, { gate_report_present: true, gate_check_passes: true });
  } finally {
    world.cleanup();
  }
});

test("A3 integration_gate not complete: a pending gate → awaiting_decision, gate check not passed", () => {
  const programId = "epic-status-igate-pending";
  const world = buildWorld({
    programId,
    manifests: [],
    orcaScenario: {
      tasks: [orcaTask(programId, "ig")],
      gates: [gate("orca-live-ig", { status: "pending", kind: "integration" })],
    },
    ghScenario: {},
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "ig", kind: "integration_gate" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "ig");
    assert.equal(outcome.state, "awaiting_decision");
    assert.deepEqual(outcome.evidence, { gate_report_present: true, gate_check_passes: false });
  } finally {
    world.cleanup();
  }
});

test("A3 advisory_review complete: advisory gate resolved → complete_with_evidence", () => {
  const programId = "epic-status-adv-ok";
  const world = buildWorld({
    programId,
    manifests: [],
    orcaScenario: {
      tasks: [orcaTask(programId, "ar")],
      gates: [gate("orca-live-ar", { status: "resolved", kind: "advisory" })],
    },
    ghScenario: {},
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "ar", kind: "advisory_review" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "ar");
    assert.equal(outcome.state, "complete_with_evidence");
    assert.deepEqual(outcome.evidence, { advisory_evidence_posted: true, blocking_findings_triaged: true });
  } finally {
    world.cleanup();
  }
});

test("A3 advisory_review not complete: an unresolved advisory gate is not triaged", () => {
  const programId = "epic-status-adv-open";
  const world = buildWorld({
    programId,
    manifests: [],
    orcaScenario: {
      tasks: [orcaTask(programId, "ar")],
      gates: [gate("orca-live-ar", { status: "pending", kind: "advisory" })],
    },
    ghScenario: {},
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "ar", kind: "advisory_review" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "ar");
    assert.notEqual(outcome.state, "complete_with_evidence");
    assert.equal(outcome.evidence.advisory_evidence_posted, true);
    assert.equal(outcome.evidence.blocking_findings_triaged, false);
  } finally {
    world.cleanup();
  }
});

test("A3 tracker_reconciliation complete: terminal manifest + closed issue → tracker_reconciled", () => {
  const programId = "epic-status-tracker-ok";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-tr", state: "merged", pr_number: 220, issue_number: 2200 }],
    orcaScenario: { tasks: [orcaTask(programId, "tr", { status: "completed", worker_done: true })] },
    ghScenario: { prs: { 220: { state: "MERGED", mergedAt: "2026-07-12T08:00:00Z" } }, issues: { 2200: { state: "CLOSED" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "tr", kind: "tracker_reconciliation", run: "run-tr" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "tr");
    assert.equal(outcome.state, "complete_with_evidence");
    assert.deepEqual(outcome.evidence, { tracker_reconciled: true });
  } finally {
    world.cleanup();
  }
});

test("A3 tracker_reconciliation not complete: a still-open issue is not reconciled", () => {
  const programId = "epic-status-tracker-open";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-tro", state: "merged", pr_number: 221, issue_number: 2210 }],
    orcaScenario: { tasks: [orcaTask(programId, "tro")] },
    ghScenario: { prs: { 221: { state: "MERGED", mergedAt: "2026-07-12T08:10:00Z" } }, issues: { 2210: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "tro", kind: "tracker_reconciliation", run: "run-tro" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "tro");
    assert.notEqual(outcome.state, "complete_with_evidence");
    assert.equal(outcome.evidence.tracker_reconciled, false);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A4 — failed required Orca reads degrade to unreachable (never fabricate empty)
// ---------------------------------------------------------------------------

test("A4: a failed required task-list read → runtime unreachable, no fabricated MISSING_TASK", () => {
  const programId = "epic-status-tl-fail";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-tl", state: "dispatched", pr_number: 300, issue_number: 3000 }],
    orcaScenario: { taskListOk: false, tasks: [] },
    ghScenario: { prs: { 300: { state: "OPEN" } }, issues: { 3000: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "t", run: "run-tl" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(r.body.runtime, "unreachable");
    assert.equal(diagCodes(r.body).includes("MISSING_TASK"), false, "a failed task-list must not forge MISSING_TASK");
    // Orca facts withheld → the mapped outcome degrades to stale_missing (durable facts still render).
    assert.equal(outcomeById(r.body, "t").state, "stale_missing");
    assert.deepEqual(Object.keys(r.body).sort(), [...REPORT_KEYS].sort());
  } finally {
    world.cleanup();
  }
});

test("A4: a failed required gate-list read → runtime unreachable, no false awaiting_decision suppression", () => {
  const programId = "epic-status-gl-fail";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-gl", state: "dispatched", pr_number: 310, issue_number: 3100 }],
    orcaScenario: {
      gateListOk: false,
      tasks: [orcaTask(programId, "g")],
      gates: [{ id: "sec-gate", task_id: "orca-live-g", status: "pending" }],
    },
    ghScenario: { prs: { 310: { state: "OPEN" } }, issues: { 3100: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "g", run: "run-gl" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(r.body.runtime, "unreachable");
    // A gate-list that could not be read is WITHHELD, never fabricated as "no pending gate":
    // the outcome degrades to stale_missing, not a false-clean running.
    assert.equal(outcomeById(r.body, "g").state, "stale_missing");
    assert.notEqual(outcomeById(r.body, "g").state, "running");
    assert.equal(diagCodes(r.body).includes("MISSING_TASK"), false);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A13 — a status read with a missing live runtime id degrades to unreachable
// ---------------------------------------------------------------------------

test("A13: status succeeds but carries no live runtime id → runtime unreachable, no Orca-fact adoption, exit 0", () => {
  const programId = "epic-status-no-runtimeid";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-nr", state: "dispatched", pr_number: 320, issue_number: 3200 }],
    // status SUCCEEDS (ok:true) but carries NO runtimeId. A foreign task is present so a
    // TRUSTED runtime would have adopted Orca facts here — the A13 guard withholds them
    // instead of silently passing the mismatch check and trusting an unidentified runtime.
    orcaScenario: { omitRuntimeId: true, tasks: [{ id: "foreign-x", task_title: "someone-else: other/thing", status: "dispatched" }] },
    ghScenario: { prs: { 320: { state: "OPEN" } }, issues: { 3200: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "nr", run: "run-nr" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0, "a missing live runtime id never fails the command");
    assert.equal(r.body.runtime, "unreachable");
    // Facts are WITHHELD (same degradation as A4), never fabricated as a RUNTIME_MISMATCH.
    assert.equal(diagCodes(r.body).includes("RUNTIME_MISMATCH"), false, "no mismatch diagnostic is forged");
    // Orca facts withheld → the mapped outcome degrades to stale_missing; durable renders.
    assert.equal(outcomeById(r.body, "nr").state, "stale_missing");
    assert.deepEqual(Object.keys(r.body).sort(), [...REPORT_KEYS].sort());
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A5 — relay runs-root resolution precedence (levels 1, 2, 4)
// ---------------------------------------------------------------------------

function withRunsRootEnv(overrides, fn) {
  const keys = ["RELAY_ORCA_RUNS_ROOT", "RELAY_RUNS_BASE", "RELAY_HOME"];
  const saved = {};
  keys.forEach((key) => {
    saved[key] = process.env[key];
    delete process.env[key];
  });
  Object.entries(overrides).forEach(([key, value]) => {
    if (value !== undefined) process.env[key] = value;
  });
  try {
    return fn();
  } finally {
    keys.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }
}

test("A5: level 1 RELAY_ORCA_RUNS_ROOT wins over every lower precedence source", () => {
  withRunsRootEnv({ RELAY_ORCA_RUNS_ROOT: "/abs/orca-runs", RELAY_RUNS_BASE: "/abs/runs-base", RELAY_HOME: "/abs/relay-home" }, () => {
    assert.equal(resolveRunsRoot(), "/abs/orca-runs");
  });
});

test("A5: level 2 RELAY_RUNS_BASE wins when level 1 is absent OR invalid (non-absolute → next)", () => {
  withRunsRootEnv({ RELAY_RUNS_BASE: "/abs/runs-base", RELAY_HOME: "/abs/relay-home" }, () => {
    assert.equal(resolveRunsRoot(), "/abs/runs-base");
  });
  // An invalid (non-absolute) level-1 value falls THROUGH to level 2, not to the default.
  withRunsRootEnv({ RELAY_ORCA_RUNS_ROOT: "relative/not/absolute", RELAY_RUNS_BASE: "/abs/runs-base" }, () => {
    assert.equal(resolveRunsRoot(), "/abs/runs-base");
  });
});

test("A5: level 4 default ~/.relay/runs when no override is set", () => {
  withRunsRootEnv({}, () => {
    assert.equal(resolveRunsRoot(), path.join(os.homedir(), ".relay", "runs"));
  });
});

// ---------------------------------------------------------------------------
// A8 — fleet manifests resolve from the SEPARATE fleets root (not the runs root)
// ---------------------------------------------------------------------------

function withFleetsRootEnv(overrides, fn) {
  const keys = ["RELAY_ORCA_FLEETS_ROOT", "RELAY_FLEETS_BASE", "RELAY_HOME"];
  const saved = {};
  keys.forEach((key) => {
    saved[key] = process.env[key];
    delete process.env[key];
  });
  Object.entries(overrides).forEach(([key, value]) => {
    if (value !== undefined) process.env[key] = value;
  });
  try {
    return fn();
  } finally {
    keys.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }
}

test("A8: fleetsRoot precedence — RELAY_ORCA_FLEETS_ROOT > RELAY_FLEETS_BASE > RELAY_HOME/fleets > default", () => {
  withFleetsRootEnv({ RELAY_ORCA_FLEETS_ROOT: "/abs/orca-fleets", RELAY_FLEETS_BASE: "/abs/fleets-base", RELAY_HOME: "/abs/relay-home" }, () => {
    assert.equal(resolveFleetsRoot(), "/abs/orca-fleets");
  });
  withFleetsRootEnv({ RELAY_FLEETS_BASE: "/abs/fleets-base", RELAY_HOME: "/abs/relay-home" }, () => {
    assert.equal(resolveFleetsRoot(), "/abs/fleets-base");
  });
  // relay-fleet's actual convention: RELAY_HOME + "/fleets" when no base override is set.
  withFleetsRootEnv({ RELAY_HOME: "/abs/relay-home" }, () => {
    assert.equal(resolveFleetsRoot(), path.join("/abs/relay-home", "fleets"));
  });
  // A non-absolute higher-precedence value falls THROUGH (not straight to the default).
  withFleetsRootEnv({ RELAY_ORCA_FLEETS_ROOT: "relative/not/absolute", RELAY_HOME: "/abs/relay-home" }, () => {
    assert.equal(resolveFleetsRoot(), path.join("/abs/relay-home", "fleets"));
  });
  withFleetsRootEnv({}, () => {
    assert.equal(resolveFleetsRoot(), path.join(os.homedir(), ".relay", "fleets"));
  });
});

test("A8: a relay_fleet outcome resolves the fleet manifest from the FLEETS root, children from the RUNS root", () => {
  // buildWorld routes the `fleet_state` manifest to the fleets root and the children to
  // the runs root, so a green result proves the split lookup (fleet ← fleets root,
  // children ← runs root) end to end.
  const programId = "epic-status-fleet-split";
  const world = buildWorld({
    programId,
    manifests: [
      { run_id: "fleet-split", fleet_state: "closed", children: [{ leaf_ref: "l1", run_id: "child-s1" }, { leaf_ref: "l2", run_id: "child-s2" }] },
      { run_id: "child-s1", state: "merged", pr_number: 241, issue_number: 2401 },
      { run_id: "child-s2", state: "merged", pr_number: 242, issue_number: 2402 },
    ],
    orcaScenario: { tasks: [orcaTask(programId, "fs", { status: "completed", worker_done: true })] },
    ghScenario: {},
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "fs", kind: "relay_fleet", fleet: "fleet-split" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  // Prove the fleet manifest lives ONLY under the fleets root, never the runs root.
  assert.ok(fs.existsSync(path.join(world.fleetsRoot, world.slug, "fleet-split.md")));
  assert.equal(fs.existsSync(path.join(world.runsRoot, world.slug, "fleet-split.md")), false);
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "fs");
    assert.equal(outcome.state, "complete_with_evidence");
    assert.deepEqual(outcome.evidence, { fleet_children_terminal: true, fleet_manifest_closed: true });
  } finally {
    world.cleanup();
  }
});

test("A8: a fleet manifest mistakenly left under the runs root is NOT adopted (split is enforced)", () => {
  const programId = "epic-status-fleet-wrongroot";
  const world = buildWorld({
    programId,
    manifests: [
      { run_id: "child-w1", state: "merged", pr_number: 251, issue_number: 2501 },
      { run_id: "child-w2", state: "merged", pr_number: 252, issue_number: 2502 },
    ],
    orcaScenario: { tasks: [orcaTask(programId, "fw", { status: "completed", worker_done: true })] },
    ghScenario: {},
  });
  // Write the fleet manifest into the WRONG (runs) root; status must not find it there.
  const runsDir = path.join(world.runsRoot, world.slug);
  fs.writeFileSync(
    path.join(runsDir, "fleet-wrong.md"),
    fleetManifestText({ run_id: "fleet-wrong", fleet_state: "closed", children: [{ leaf_ref: "l1", run_id: "child-w1" }, { leaf_ref: "l2", run_id: "child-w2" }] }),
    "utf-8",
  );
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "fw", kind: "relay_fleet", fleet: "fleet-wrong" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "fw");
    // The fleet manifest is not on the fleets root → its evidence stays unknown (null)
    // and the outcome never completes.
    assert.notEqual(outcome.state, "complete_with_evidence");
    assert.equal(outcome.evidence.fleet_manifest_closed, null);
    assert.equal(outcome.evidence.fleet_children_terminal, null);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A6 — receipt program-id identity check on load
// ---------------------------------------------------------------------------

test("A6: a receipt whose program_id != requested --program-id → RECEIPT_CORRUPT exit 51 naming both", () => {
  const programId = "epic-status-identity";
  const world = buildWorld({ programId, orcaScenario: {}, ghScenario: {} });
  const receipt = makeReceipt({ programId: "epic-OTHER-program", slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "x", run: "run-x" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, REASONS.RECEIPT_CORRUPT);
    assert.equal(r.body.reason_code, "RECEIPT_CORRUPT");
    assert.match(r.body.message, /epic-status-identity/, "message names the requested program-id");
    assert.match(r.body.message, /epic-OTHER-program/, "message names the receipt's program-id");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A7 — every subprocess-derived diagnostic field (incl. ids) is bounded
// ---------------------------------------------------------------------------

test("A7: an adversarial 10,000-char PR head is bounded in the PR_CHANGED diagnostic ids", () => {
  const programId = "epic-status-adversarial";
  const huge = "f".repeat(10000);
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-adv", state: "merged", pr_number: 400, issue_number: 4000, head_sha: "expected-sha" }],
    orcaScenario: { tasks: [orcaTask(programId, "adv", { status: "completed", worker_done: true })] },
    ghScenario: { prs: { 400: { state: "MERGED", mergedAt: "2026-07-12T09:00:00Z", headRefOid: huge } }, issues: { 4000: { state: "CLOSED" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "adv", run: "run-adv" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const prChanged = r.body.diagnostics.filter((d) => d.code === "PR_CHANGED");
    assert.ok(prChanged.length > 0, "PR_CHANGED fires on the adversarial live head");
    for (const d of prChanged) {
      assert.ok(d.message.length <= 256, `message bounded: ${d.message.length}`);
      for (const [key, value] of Object.entries(d.ids)) {
        if (typeof value === "string") assert.ok(value.length <= 256, `ids.${key} bounded: ${value.length}`);
      }
    }
    // The raw 10k subprocess string never leaks anywhere into the serialized report.
    assert.equal(JSON.stringify(r.body).includes(huge), false, "no unbounded subprocess value leaks into the report");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A9 — every gh read is scoped to the selected repository (cwd = repo.root)
// ---------------------------------------------------------------------------

test("A9: every gh read runs in repo.root even when status is invoked from an unrelated cwd", () => {
  const world = completeWorld("epic-status-ghcwd");
  const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-other-cwd-"));
  try {
    const r = world.run([], { cwd: otherCwd });
    assert.equal(r.status, 0);
    const cwds = world.gh.readCwdLog();
    assert.ok(cwds.length > 0, "the fake gh recorded at least one invocation cwd");
    const expected = fs.realpathSync(world.repoRoot);
    // Sanity: the caller cwd is genuinely different from the repo root.
    assert.notEqual(fs.realpathSync(otherCwd), expected);
    cwds.forEach((cwd) => assert.equal(fs.realpathSync(cwd), expected, "each gh read ran in repo.root, not the caller cwd"));
  } finally {
    fs.rmSync(otherCwd, { recursive: true, force: true });
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A10 — a changed live dispatch id is a stale mapping (MISSING_DISPATCH)
// ---------------------------------------------------------------------------

test("A10: a changed live dispatch id → MISSING_DISPATCH + stale_missing when durable evidence is non-terminal", () => {
  const programId = "epic-status-dispatch-drift";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-d", state: "dispatched", pr_number: 500, issue_number: 5000 }],
    orcaScenario: {
      tasks: [orcaTask(programId, "d")],
      // dispatch-show reports a DIFFERENT dispatch id than the receipt recorded (the
      // task was re-dispatched) → the recorded mapping drifted.
      dispatch: { "orca-live-d": { dispatch_id: "disp-REDISPATCHED", assignee: "term-d", terminal_present: true } },
    },
    ghScenario: { prs: { 500: { state: "OPEN" } }, issues: { 5000: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "d", run: "run-d" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(outcomeById(r.body, "d").state, "stale_missing");
    const missing = r.body.diagnostics.filter((x) => x.code === "MISSING_DISPATCH" && x.outcome_id === "d");
    assert.equal(missing.length, 1, "the drifted mapping emits exactly one MISSING_DISPATCH");
    // The diagnostic carries BOTH the receipt id and the changed live id.
    assert.equal(missing[0].ids.dispatch_id, "disp-orca-live-d");
    assert.equal(missing[0].ids.live_dispatch_id, "disp-REDISPATCHED");
  } finally {
    world.cleanup();
  }
});

test("A10: the durable-complete variant stays complete_with_evidence despite a drifted dispatch id", () => {
  const programId = "epic-status-dispatch-drift-complete";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-dc", state: "merged", pr_number: 501, issue_number: 5001 }],
    orcaScenario: {
      tasks: [orcaTask(programId, "dc", { status: "completed", worker_done: true })],
      dispatch: { "orca-live-dc": { dispatch_id: "disp-REDISPATCHED", assignee: "term-dc", terminal_present: true } },
    },
    ghScenario: { prs: { 501: { state: "MERGED", mergedAt: "2026-07-12T10:00:00Z" } }, issues: { 5001: { state: "CLOSED" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "dc", run: "run-dc" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    // Durable evidence still wins over the drifted runtime mapping.
    assert.equal(outcomeById(r.body, "dc").state, "complete_with_evidence");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A11 — a failed REQUIRED live GitHub read degrades the outcome (never "running")
// ---------------------------------------------------------------------------

test("A11: a failed required `pr view` read → stale_missing, exit 0", () => {
  const programId = "epic-status-pr-unreachable";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-pu", state: "dispatched", pr_number: 600, issue_number: 6000 }],
    orcaScenario: { tasks: [orcaTask(programId, "pu")] },
    // PR 600 is intentionally ABSENT from the scenario → `gh pr view 600` exits non-zero.
    ghScenario: { issues: { 6000: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "pu", run: "run-pu" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0, "an unreachable GitHub read never fails the command");
    assert.equal(outcomeById(r.body, "pu").state, "stale_missing");
    assert.equal(world.gh.readPoison(), null, "a failed read is not a write poison");
  } finally {
    world.cleanup();
  }
});

test("A11: a failed required `issue view` read → stale_missing, exit 0", () => {
  const programId = "epic-status-issue-unreachable";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-iu", state: "dispatched", pr_number: 610, issue_number: 6100 }],
    orcaScenario: { tasks: [orcaTask(programId, "iu")] },
    // Issue 6100 is ABSENT → `gh issue view 6100` exits non-zero; the PR read succeeds.
    ghScenario: { prs: { 610: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "iu", run: "run-iu" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0, "an unreachable GitHub read never fails the command");
    assert.equal(outcomeById(r.body, "iu").state, "stale_missing");
    assert.equal(world.gh.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A17 — every adopted read's runtime id is validated (task-list/gate-list + per-task)
// ---------------------------------------------------------------------------

test("A17: a task-list read carrying a DIFFERENT runtime id → runtime unreachable, Orca facts withheld, exit 0", () => {
  const programId = "epic-status-tasklist-runtime-drift";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-tld", state: "dispatched", pr_number: 700, issue_number: 7000 }],
    // status carries the receipt's runtime, but task-list's _meta.runtimeId is a DIFFERENT
    // runtime — the read cannot be attributed to the receipt's runtime, so it is WITHHELD
    // (unreachable) exactly like a failed required read (A4), never adopted.
    orcaScenario: {
      tasks: [orcaTask(programId, "tld")],
      taskListRuntimeId: "77777777-7777-4777-8777-777777777777",
    },
    ghScenario: { prs: { 700: { state: "OPEN" } }, issues: { 7000: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "tld", run: "run-tld" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(r.body.runtime, "unreachable");
    // Withheld like A4 — never a forged RUNTIME_MISMATCH or MISSING_TASK.
    assert.equal(diagCodes(r.body).includes("RUNTIME_MISMATCH"), false);
    assert.equal(diagCodes(r.body).includes("MISSING_TASK"), false);
    assert.equal(outcomeById(r.body, "tld").state, "stale_missing");
    assert.deepEqual(Object.keys(r.body).sort(), [...REPORT_KEYS].sort());
  } finally {
    world.cleanup();
  }
});

test("A17: a per-task dispatch-show from a MISMATCHED runtime id → that task unknown (stale_missing); other tasks unaffected", () => {
  const programId = "epic-status-dispatch-runtime-drift";
  const world = buildWorld({
    programId,
    manifests: [
      { run_id: "run-good", state: "dispatched", pr_number: 710, issue_number: 7100 },
      { run_id: "run-bad", state: "dispatched", pr_number: 711, issue_number: 7101 },
    ],
    orcaScenario: {
      tasks: [orcaTask(programId, "good"), orcaTask(programId, "bad")],
      // "bad"'s dispatch-show carries a DIFFERENT _meta.runtimeId → that task's runtime
      // facts are unknown; "good"'s dispatch-show matches and classifies normally.
      dispatch: { "orca-live-bad": { runtimeId: "66666666-6666-4666-8666-666666666666" } },
    },
    ghScenario: { prs: { 710: { state: "OPEN" }, 711: { state: "OPEN" } }, issues: { 7100: { state: "OPEN" }, 7101: { state: "OPEN" } } },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [
      { outcome_id: "good", run: "run-good" },
      { outcome_id: "bad", run: "run-bad" },
    ],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    // The whole runtime stays trusted (status + task-list + gate-list all matched)...
    assert.equal(r.body.runtime, "ok");
    // ...but the mismatched per-task dispatch-show marks ONLY "bad" unknown.
    assert.equal(outcomeById(r.body, "bad").state, "stale_missing");
    assert.equal(outcomeById(r.body, "good").state, "running");
    // No false MISSING_DISPATCH / MISSING_TERMINAL forged for the withheld task.
    assert.equal(diagCodes(r.body, "bad").includes("MISSING_DISPATCH"), false);
    assert.equal(diagCodes(r.body, "bad").includes("MISSING_TERMINAL"), false);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A18 — an escalated fleet child is TERMINAL but not complete → fleet escalated
// ---------------------------------------------------------------------------

test("A18: a closed fleet with one ESCALATED child → outcome escalated (terminal ≠ complete); the all-merged variant stays complete", () => {
  // Escalated variant: the fleet manifest is closed and every child is TERMINAL, but one
  // child ESCALATED. An escalated child is terminal (it will not progress) yet NOT complete,
  // so the fleet cannot complete from that configuration and surfaces as escalated.
  const escProgram = "epic-status-fleet-escalated";
  const escWorld = buildWorld({
    programId: escProgram,
    manifests: [
      { run_id: "fleet-esc", fleet_state: "closed", children: [{ leaf_ref: "l1", run_id: "child-e1" }, { leaf_ref: "l2", run_id: "child-e2" }] },
      { run_id: "child-e1", state: "merged", pr_number: 261, issue_number: 2601 },
      { run_id: "child-e2", state: "escalated", pr_number: 262, issue_number: 2602 },
    ],
    orcaScenario: { tasks: [orcaTask(escProgram, "fe")] },
    ghScenario: {},
  });
  const escReceipt = makeReceipt({ programId: escProgram, slug: escWorld.slug, root: fs.realpathSync(escWorld.repoRoot), tasks: [{ outcome_id: "fe", kind: "relay_fleet", fleet: "fleet-esc" }] });
  fs.writeFileSync(escWorld.receiptPath, `${JSON.stringify(escReceipt, null, 2)}\n`, "utf-8");
  try {
    const r = escWorld.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "fe");
    assert.equal(outcome.state, "escalated", "an escalated terminal child surfaces the fleet as escalated");
    assert.notEqual(outcome.state, "complete_with_evidence");
    // The escalated child IS terminal ({merged,closed,escalated}), so the fleet reached a
    // terminal configuration — fleet_children_terminal is true — but it is not complete.
    assert.equal(outcome.evidence.fleet_children_terminal, true);
    assert.equal(outcome.evidence.fleet_manifest_closed, true);
    assert.equal(r.body.program_state, "escalated");
  } finally {
    escWorld.cleanup();
  }

  // All-merged variant: every child complete (merged/closed) → still complete_with_evidence.
  const okProgram = "epic-status-fleet-allmerged";
  const okWorld = buildWorld({
    programId: okProgram,
    manifests: [
      { run_id: "fleet-ok2", fleet_state: "closed", children: [{ leaf_ref: "l1", run_id: "child-m1" }, { leaf_ref: "l2", run_id: "child-m2" }] },
      { run_id: "child-m1", state: "merged", pr_number: 271, issue_number: 2701 },
      { run_id: "child-m2", state: "merged", pr_number: 272, issue_number: 2702 },
    ],
    orcaScenario: { tasks: [orcaTask(okProgram, "fm", { status: "completed", worker_done: true })] },
    ghScenario: {},
  });
  const okReceipt = makeReceipt({ programId: okProgram, slug: okWorld.slug, root: fs.realpathSync(okWorld.repoRoot), tasks: [{ outcome_id: "fm", kind: "relay_fleet", fleet: "fleet-ok2" }] });
  fs.writeFileSync(okWorld.receiptPath, `${JSON.stringify(okReceipt, null, 2)}\n`, "utf-8");
  try {
    const r = okWorld.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "fm");
    assert.equal(outcome.state, "complete_with_evidence");
    assert.deepEqual(outcome.evidence, { fleet_children_terminal: true, fleet_manifest_closed: true });
  } finally {
    okWorld.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A19 — advisory evidence requires an EXPLICITLY advisory gate (no gates[0] fallback)
// ---------------------------------------------------------------------------

test("A19: a passed NON-advisory gate mapped to an advisory_review task is not advisory evidence → NOT complete_with_evidence", () => {
  const programId = "epic-status-adv-nonadvisory";
  const world = buildWorld({
    programId,
    manifests: [],
    orcaScenario: {
      tasks: [orcaTask(programId, "ar")],
      // A PASSED gate mapped to the task, but typed "integration" (NOT advisory). With the
      // gates[0] fallback removed, an unmarked/non-advisory gate can never satisfy advisory
      // evidence, so a passed integration gate must not forge advisory completion.
      gates: [gate("orca-live-ar", { status: "passed", kind: "integration" })],
    },
    ghScenario: {},
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "ar", kind: "advisory_review" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    const outcome = outcomeById(r.body, "ar");
    assert.notEqual(outcome.state, "complete_with_evidence");
    assert.equal(outcome.evidence.advisory_evidence_posted, false, "a non-advisory gate is never advisory evidence");
    assert.equal(outcome.evidence.blocking_findings_triaged, false);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A20 — a failed required PR sub-read = unreachable (no false complete via a null head)
// ---------------------------------------------------------------------------

test("A20: a merged outcome whose PR HEAD sub-read fails → stale_missing, never a false complete off a null head", () => {
  // The merge read (mergedAt,state) SUCCEEDS (MERGED) but the head read (headRefOid) FAILS.
  // Before A20 the head failure substituted {} and kept ok:true, so headRefOid=null silently
  // disabled the PR_CHANGED head-moved detector and the merged manifest + closed issue would
  // FALSE-complete. A20 makes any failed required PR sub-read unreachable → stale_missing.
  const programId = "epic-status-pr-head-fail";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-ph", state: "merged", pr_number: 800, issue_number: 8000, head_sha: "expected-sha" }],
    orcaScenario: { tasks: [orcaTask(programId, "ph", { status: "completed", worker_done: true })] },
    ghScenario: { prs: { 800: { state: "MERGED", mergedAt: "2026-07-12T12:00:00Z", headReadFails: true } }, issues: { 8000: { state: "CLOSED" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "ph", run: "run-ph" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0, "an unreachable PR read never fails the command");
    const outcome = outcomeById(r.body, "ph");
    assert.equal(outcome.state, "stale_missing", "a partial PR read degrades the outcome, never false-completes");
    assert.notEqual(outcome.state, "complete_with_evidence");
    assert.equal(outcome.evidence.pr_merged, null, "the PR fact is withheld, not fabricated");
    assert.equal(world.gh.readPoison(), null, "a failed read is not a write poison");
  } finally {
    world.cleanup();
  }
});

test("A25: a merged PR whose head read SUCCEEDS but omits headRefOid → stale_missing, never complete off a null head", () => {
  // The merge read (mergedAt,state) SUCCEEDS (MERGED) AND the head read SUCCEEDS (status 0,
  // valid JSON) but carries NO headRefOid. Before A25 that parsed-but-missing head counted
  // as reachable with headRefOid=null, silently skipping the live-head comparison while the
  // merged manifest + closed issue false-completed. A25 makes a missing/empty head OID from a
  // successful read UNREACHABLE too → the outcome degrades to stale_missing and pr_merged is
  // never counted as completion evidence when the head comparison was skipped.
  const programId = "epic-status-head-absent";
  const world = buildWorld({
    programId,
    manifests: [{ run_id: "run-ha", state: "merged", pr_number: 810, issue_number: 8100 }],
    orcaScenario: { tasks: [orcaTask(programId, "ha", { status: "completed", worker_done: true })] },
    ghScenario: { prs: { 810: { state: "MERGED", mergedAt: "2026-07-12T12:30:00Z", headOmitted: true } }, issues: { 8100: { state: "CLOSED" } } },
  });
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot), tasks: [{ outcome_id: "ha", run: "run-ha" }] });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0, "a head-missing PR read never fails the command");
    const outcome = outcomeById(r.body, "ha");
    assert.equal(outcome.state, "stale_missing", "a head-missing PR read degrades the outcome, never false-completes");
    assert.notEqual(outcome.state, "complete_with_evidence");
    assert.equal(outcome.evidence.pr_merged, null, "pr_merged is withheld, not fabricated, when the head comparison was skipped");
    assert.equal(world.gh.readPoison(), null, "a read never writes a poison");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A22 — --repo-root is canonicalized through Git (a linked worktree → PRIMARY slug)
// ---------------------------------------------------------------------------

// Build a REAL primary git checkout + a LINKED WORKTREE whose `.git` FILE points at the
// primary's git-common-dir. Pointing --repo-root at the worktree must derive the PRIMARY
// slug, not the worktree-directory slug.
function makeGitWorktree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-status-worktree-"));
  const primary = path.join(base, "primary");
  const worktree = path.join(base, "wt");
  fs.mkdirSync(primary, { recursive: true });
  const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"], primary);
  git(["config", "user.email", "t@t.com"], primary);
  git(["config", "user.name", "t"], primary);
  git(["commit", "-q", "--allow-empty", "-m", "init"], primary);
  git(["worktree", "add", "-q", "--detach", worktree, "HEAD"], primary);
  const primaryRoot = fs.realpathSync(primary);
  return { base, primary, worktree, primaryRoot, primarySlug: computeRepoSlug(primaryRoot), worktreeSlug: computeRepoSlug(fs.realpathSync(worktree)) };
}

test("A22/A24: resolveRepoContext canonicalizes a linked worktree to the PRIMARY root/slug; a non-git dir FAILS CLOSED (no realpath fallback)", () => {
  const wt = makeGitWorktree();
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-nongit-"));
  try {
    assert.notEqual(wt.primarySlug, wt.worktreeSlug, "the worktree dir slug genuinely differs from the primary slug");
    // run.js and status.js BOTH resolve --repo-root through resolveRepoContext, so this
    // equality is exactly what makes them agree on where the receipt lives.
    const fromWorktree = resolveRepoContext({ repoRootOverride: wt.worktree });
    assert.equal(fromWorktree.root, wt.primaryRoot, "the linked worktree collapses to the primary checkout root");
    assert.equal(fromWorktree.slug, wt.primarySlug, "the slug derives from the PRIMARY root, not the worktree dir");
    assert.equal(resolveCanonicalRepoRoot({ repoRootOverride: wt.primary }), wt.primaryRoot, "the primary checkout resolves to itself");
    // A24: on git failure (a plain non-repo dir) the resolver FAILS CLOSED — it throws a
    // RECEIPT_REPO_MISMATCH (exit 52) CanonicalizationError rather than silently falling
    // back to a realpath of an arbitrary directory (which could point at another repo).
    assert.throws(
      () => resolveCanonicalRepoRoot({ repoRootOverride: nonGit }),
      (error) => {
        assert.equal(error.reasonCode, "RECEIPT_REPO_MISMATCH");
        assert.equal(error.exitCode, 52);
        assert.match(error.message, /could not be canonicalized/i);
        return true;
      },
    );
  } finally {
    fs.rmSync(wt.base, { recursive: true, force: true });
    fs.rmSync(nonGit, { recursive: true, force: true });
  }
});

test("A22: status --repo-root pointed at a LINKED WORKTREE loads the receipt stored under the PRIMARY slug", () => {
  const wt = makeGitWorktree();
  const programId = "epic-status-worktree";
  const orca = installFakeOrcaStatus({ runtimeId: DEFAULT_RUNTIME_ID, tasks: [] });
  const gh = installFakeGh({});
  const programsRoot = path.join(wt.base, "programs");
  const runsRoot = path.join(wt.base, "runs");
  const fleetsRoot = path.join(wt.base, "fleets");
  // The receipt is stored under the PRIMARY slug (where `run` from the same worktree would
  // have written it). A worktree-slug resolver would look under `worktreeSlug` and 404.
  const receiptDir = path.join(programsRoot, wt.primarySlug, programSegment(programId));
  fs.mkdirSync(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, "receipt.json");
  const receipt = makeReceipt({ programId, slug: wt.primarySlug, root: wt.primaryRoot, tasks: [{ outcome_id: "x", orca_task_id: null, dispatch_id: null, assignee: null, run: "run-x" }] });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  fs.mkdirSync(path.join(runsRoot, wt.primarySlug), { recursive: true });
  fs.writeFileSync(path.join(runsRoot, wt.primarySlug, "run-x.md"), manifestText({ run_id: "run-x", state: "dispatched", pr_number: null, issue_number: null }), "utf-8");
  const args = [STATUS_JS, "--program-id", programId, "--json", "--orca-bin", orca.orcaPath, "--gh-bin", gh.ghPath, "--repo-root", wt.worktree];
  const result = { status: 0, stdout: "" };
  try {
    result.stdout = execFileSync(process.execPath, args, {
      encoding: "utf-8",
      env: { ...process.env, RELAY_ORCA_PROGRAMS_ROOT: programsRoot, RELAY_ORCA_RUNS_ROOT: runsRoot, RELAY_ORCA_FLEETS_ROOT: fleetsRoot },
      stdio: "pipe",
    });
  } catch (error) {
    result.status = error.status;
    result.stdout = error.stdout ? String(error.stdout) : "";
  }
  const body = result.stdout ? JSON.parse(result.stdout) : null;
  try {
    assert.equal(result.status, 0, "status finds the primary-slug receipt from the linked worktree (no RECEIPT_NOT_FOUND / REPO_MISMATCH)");
    assert.equal(body.program_id, programId);
    assert.equal(body.receipt_path, receiptPath, "the loaded receipt is the one under the primary slug");
    assert.equal(outcomeById(body, "x").state, "running");
  } finally {
    orca.cleanup();
    gh.cleanup();
    fs.rmSync(wt.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A23 — a durable fleet mapping (relay_ids.fleet / live fleet manifest) counts as started
// ---------------------------------------------------------------------------

test("A23: a relay_fleet outcome with only relay_ids.fleet + a live non-complete fleet manifest is started → running", () => {
  const facts = {
    receiptTask: {
      outcome_id: "f",
      task_id: "orca-task-f",
      kind: "relay_fleet",
      wave: 2,
      orca_task_id: null,
      dispatch_id: null,
      assignee: null,
      relay_ids: { request: null, run: null, fleet: "fleet-live" },
    },
    manifest: null,
    mappedRunId: null,
    mappedRunMissing: false,
    // A live fleet manifest is mapped for this outcome, but it is NOT terminal yet.
    fleetManifest: { fleet_id: "fleet-live", fleet_state: "dispatched", fleet_children: [] },
    mappedFleetId: "fleet-live",
    fleetChildren: [],
    fleetChildEscalated: false,
    pr: null,
    issue: null,
    prUrl: null,
    issueUrl: null,
  };
  const { outcome, started } = classifyOutcome(facts, { orcaTrusted: true, isDuplicate: false });
  assert.equal(started, true, "a durable fleet mapping counts as started even with no dispatch_id / relay_ids.run / PR");
  assert.equal(outcome.state, "running", "an in-progress fleet is running, never treated as unstarted");
});

test("A23: a wave whose only in-progress outcome is a live relay_fleet is NOT ready_for_next_wave — the program is running", () => {
  const programId = "epic-status-fleet-started";
  const world = buildWorld({
    programId,
    manifests: [
      // wave 1: a fully complete relay_run
      { run_id: "run-w1", state: "merged", pr_number: 900, issue_number: 9000 },
      // wave 2: a LIVE, non-complete fleet manifest (fleets root) + a non-terminal child
      { run_id: "fleet-w2", fleet_state: "dispatched", children: [{ leaf_ref: "l1", run_id: "child-w2" }] },
      { run_id: "child-w2", state: "dispatched", pr_number: 901, issue_number: 9001 },
    ],
    orcaScenario: { tasks: [orcaTask(programId, "w1", { status: "completed", worker_done: true })] },
    ghScenario: { prs: { 900: { state: "MERGED", mergedAt: "2026-07-12T13:00:00Z" } }, issues: { 9000: { state: "CLOSED" } } },
  });
  const receipt = makeReceipt({
    programId,
    slug: world.slug,
    root: fs.realpathSync(world.repoRoot),
    tasks: [
      { outcome_id: "w1", wave: 1, run: "run-w1" },
      // The wave-2 fleet outcome has NO dispatch_id / run / orca task yet — only relay_ids.fleet.
      { outcome_id: "w2", wave: 2, kind: "relay_fleet", orca_task_id: null, dispatch_id: null, assignee: null, fleet: "fleet-w2" },
    ],
  });
  fs.writeFileSync(world.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  try {
    const r = world.run();
    assert.equal(r.status, 0);
    assert.equal(outcomeById(r.body, "w1").state, "complete_with_evidence");
    assert.equal(outcomeById(r.body, "w2").state, "running", "the mapped, live fleet outcome is running");
    // Because the wave-2 fleet is already started, the program is NOT falsely ready_for_next_wave.
    assert.equal(r.body.program_state, "running");
    assert.notEqual(r.body.program_state, "ready_for_next_wave");
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
