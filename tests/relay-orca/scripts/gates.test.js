"use strict";

// #947 — integration gates, follow-up waves, and evidence-backed completion. Scenarios
// D9.1–D9.12. Fakes only (fake --orca-bin and fake --gh-bin for every invocation, never
// the real app); poisons active everywhere so any mutation/reset/worktree call hard-fails.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPTS = path.join(REPO_ROOT, "skills", "relay-orca", "scripts");
const STATUS_JS = path.join(SCRIPTS, "status.js");
const RUN_JS = path.join(SCRIPTS, "run.js");

const { RECEIPT_NOTE } = require(path.join(SCRIPTS, "lib", "receipt.js"));
const { computeRepoSlug } = require(path.join(SCRIPTS, "lib", "repo-slug.js"));
const { programSegment } = require(path.join(SCRIPTS, "receipt-io.js"));
const { GATES_REPORT_KEYS, FINAL_SUMMARY_KEYS, GATE_ENTRY_KEYS, GATE_STATES, STOPPED_ON_VALUES } = require(path.join(SCRIPTS, "lib", "gate-report.js"));
const { DECISION_KEYS } = require(path.join(SCRIPTS, "lib", "decision-records.js"));
const { REASONS: GATE_REASONS } = require(path.join(SCRIPTS, "lib", "gate-reasons.js"));
const { installFakeOrcaStatus } = require(path.join(__dirname, "..", "fixtures", "fake-orca-status.js"));
const { installFakeGh } = require(path.join(__dirname, "..", "fixtures", "fake-gh.js"));
const { installFakeOrcaRun } = require(path.join(__dirname, "..", "fixtures", "fake-orca-run.js"));
const { DEFAULT_RUNTIME_ID } = require(path.join(__dirname, "..", "fixtures", "fake-orca.js"));

// --- builders (mirroring the status.test.js house harness) ----------------------

function makeReceipt({ programId, slug, root, runtimeId, tasks, decisions, authorizations, followUps, counters }) {
  const receipt = {
    schema: 1,
    program_id: programId,
    source: "/tmp/accepted-program.json",
    repo: { slug, root },
    runtime_id: runtimeId || DEFAULT_RUNTIME_ID,
    tasks: tasks.map((task) => {
      const orcaTaskId = task.orca_task_id === undefined ? `orca-live-${task.outcome_id}` : task.orca_task_id;
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
    created_at: "2026-07-13T00:00:00.000Z",
    updated_at: "2026-07-13T00:00:00.000Z",
    note: RECEIPT_NOTE,
  };
  // Additive #947 record fields appended ONLY when the scenario supplies them.
  if (decisions) receipt.decisions = decisions;
  if (authorizations) receipt.authorizations = authorizations;
  if (followUps) receipt.follow_ups = followUps;
  if (counters) receipt.counters = counters;
  return receipt;
}

function manifestText(fields) {
  const lines = ["---", "relay_version: 2", `run_id: '${fields.run_id}'`, `state: '${fields.state}'`, "git:"];
  lines.push(fields.pr_number != null ? `  pr_number: ${fields.pr_number}` : "  pr_number: null");
  lines.push(`  working_branch: '${fields.run_id}-branch'`);
  lines.push("  base_branch: 'main'");
  if (fields.head_sha) lines.push(`  head_sha: '${fields.head_sha}'`);
  lines.push("issue:");
  lines.push(fields.issue_number != null ? `  number: ${fields.issue_number}` : "  number: null");
  lines.push("  source: 'github'");
  lines.push("---");
  lines.push("# Notes");
  // Optional free-text notes (additive) so a scenario can plant a manifest whose body
  // references the program — the signal live→receipt back-pointer discovery scans for.
  if (fields.notes) lines.push(fields.notes);
  return `${lines.join("\n")}\n`;
}

function orcaTask(programId, outcome, extra = {}) {
  return {
    id: `orca-live-${outcome}`,
    // D4: the real mid-2026 task-list row carries `task_title` (and `display_name`), never
    // `title` — matching the status.test.js/resume.test.js helpers.
    task_title: `relay-orca: ${programSegment(programId)}/${outcome}`,
    display_name: `relay-orca: ${programSegment(programId)}/${outcome}`,
    status: extra.status || "dispatched",
    worker_done: extra.worker_done === true,
  };
}

function initGitRepo(root) {
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
}

function sanitizeArtifact(ref) {
  return String(ref == null ? "" : ref).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "gate";
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function verificationBinding(passed = true) {
  const binding = { input_sha256: `sha256:${"a".repeat(64)}`, result_sha256: `sha256:${"b".repeat(64)}`, passed };
  return { ...binding, binding_sha256: `sha256:${crypto.createHash("sha256").update(canonicalJson(binding)).digest("hex")}` };
}

function boundArtifactName(ref) {
  return `${sanitizeArtifact(ref)}-${crypto.createHash("sha256").update(ref).digest("hex")}.json`;
}

// Build a hermetic gate world: real tiny git repo, receipt at the collision-resistant
// segment path, run/fleet manifests, fake read-only orca + gh, an accepted program file
// carrying the exit_gates verbatim, and a gate-evidence directory of live artifacts.
function buildGateWorld({ programId, receipt, manifests = [], orcaScenario = {}, ghScenario = {}, exitGates = [], decisionGates = [], gateEvidence = {}, integrationEvidenceVersion, integrationEvidence = [] }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-gates-"));
  const repoRoot = path.join(base, "repo");
  const programsRoot = path.join(base, "programs");
  const runsRoot = path.join(base, "runs");
  const fleetsRoot = path.join(base, "fleets");
  const evidenceDir = path.join(base, "gate-evidence");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  initGitRepo(repoRoot);
  const slug = computeRepoSlug(fs.realpathSync(repoRoot));

  const receiptObject = receipt;
  if (receiptObject.repo && receiptObject.repo.slug === "__SELF__") receiptObject.repo.slug = slug;
  if (receiptObject.repo) receiptObject.repo.root = fs.realpathSync(repoRoot);
  const receiptDir = path.join(programsRoot, slug, programSegment(programId));
  fs.mkdirSync(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, "receipt.json");
  fs.writeFileSync(receiptPath, `${JSON.stringify(receiptObject, null, 2)}\n`, "utf-8");

  const runsDir = path.join(runsRoot, slug);
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(path.join(fleetsRoot, slug), { recursive: true });
  manifests.forEach((fields) => fs.writeFileSync(path.join(runsDir, `${fields.run_id}.md`), manifestText(fields), "utf-8"));

  // The accepted program file — the ONLY source of exit_gates (input artifacts).
  const programFile = path.join(base, "accepted-program.json");
  const acceptedProgram = { id: programId, exit_gates: exitGates, decision_gates: decisionGates, outcomes: receiptObject.tasks.map((task) => ({ id: task.outcome_id, task_kind: task.kind, accepted_outcomes: ["x"] })) };
  if (integrationEvidenceVersion !== undefined) acceptedProgram.integration_evidence_version = integrationEvidenceVersion;
  if (integrationEvidence.length > 0) acceptedProgram.integration_evidence = integrationEvidence;
  fs.writeFileSync(programFile, `${JSON.stringify({ program: acceptedProgram }, null, 2)}\n`, "utf-8");

  Object.entries(gateEvidence).forEach(([name, value]) => {
    fs.writeFileSync(path.join(evidenceDir, `${sanitizeArtifact(name)}.json`), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  });

  const orca = installFakeOrcaStatus({ runtimeId: DEFAULT_RUNTIME_ID, ...orcaScenario });
  const gh = installFakeGh(ghScenario);

  return {
    base,
    repoRoot,
    programFile,
    evidenceDir,
    receiptPath,
    slug,
    orca,
    gh,
    receiptOnDisk() {
      return fs.readFileSync(receiptPath, "utf-8");
    },
    run(mode, extraArgs = []) {
      const args = [
        STATUS_JS,
        "--program-id",
        programId,
        "--json",
        mode,
        "--program-file",
        programFile,
        "--gate-evidence-dir",
        evidenceDir,
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

// A single durable-complete relay_run outcome "a" (merged run + merged PR + closed issue +
// completed Orca task). This satisfies the D2 prerequisite so exit gates can evaluate.
function greenWorld(programId, opts = {}) {
  const receipt = makeReceipt({
    programId,
    slug: "__SELF__",
    root: "__SELF__",
    tasks: [{ outcome_id: "a", run: "run-a" }, ...(opts.extraTasks || [])],
    decisions: opts.decisions,
    authorizations: opts.authorizations,
    followUps: opts.followUps,
    counters: opts.counters,
  });
  return buildGateWorld({
    programId,
    receipt,
    manifests: [{ run_id: "run-a", state: "merged", pr_number: 10, issue_number: 100, head_sha: "abc" }, ...(opts.manifests || [])],
    orcaScenario: { tasks: [orcaTask(programId, "a", { status: "completed", worker_done: true }), ...(opts.orcaTasks || [])] },
    ghScenario: {
      prs: { 10: { state: "MERGED", mergedAt: "2026-07-13T01:00:00Z", headRefOid: "abc" }, ...(opts.prs || {}) },
      issues: { 100: { state: "CLOSED", stateReason: "COMPLETED" }, ...(opts.issues || {}) },
    },
    exitGates: opts.exitGates || [],
    decisionGates: opts.decisionGates || [],
    gateEvidence: opts.gateEvidence || {},
    integrationEvidenceVersion: opts.integrationEvidenceVersion,
    integrationEvidence: opts.integrationEvidence || [],
  });
}

function gateByString(body, gateString) {
  return body.gates.find((gate) => gate.gate === gateString);
}

// ---------------------------------------------------------------------------
// Report-shape sanity (D8)
// ---------------------------------------------------------------------------

test("D8: verbatim gate-state enum and stopped_on tokens are exactly the pinned sets", () => {
  assert.deepEqual([...GATE_STATES].sort(), ["awaiting_decision", "failed", "not_yet_evaluable", "passed", "unevaluable"]);
  assert.deepEqual([...GATE_ENTRY_KEYS], ["gate", "kind", "state", "evidence", "message"]);
  assert.ok(STOPPED_ON_VALUES.includes("integration_gate_failed") && STOPPED_ON_VALUES.includes("unaccepted_follow_up"));
});

// ---------------------------------------------------------------------------
// D9.1 — passing integration gate; masking (all tasks completed + failing gate)
// ---------------------------------------------------------------------------

test("D9.1: passing integration gate after all outcomes complete → passed; report has the seven verbatim keys", () => {
  const world = greenWorld("epic-gate-pass", { exitGates: ["integration:e2e"], gateEvidence: { e2e: { passed: true, evidence: "suite green" } } });
  try {
    const r = world.run("--gates");
    assert.equal(r.status, 0);
    assert.deepEqual(Object.keys(r.body).sort(), [...GATES_REPORT_KEYS].sort());
    assert.equal(r.body.prerequisites_met, true);
    const gate = gateByString(r.body, "integration:e2e");
    assert.equal(gate.state, "passed");
    assert.equal(gate.kind, "integration");
    assert.deepEqual(Object.keys(gate).sort(), [...GATE_ENTRY_KEYS].sort());
    assert.equal(world.orca.readPoison(), null);
    assert.equal(world.gh.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

test("#1046 red: a well-formed-looking cross-program identity artifact cannot pass a generic integration gate", () => {
  const programId = "epic-1046-red";
  const expected = { program_id: programId, runtime_id: DEFAULT_RUNTIME_ID, check_ref: "e2e", verification: verificationBinding(true) };
  const artifact = {
    schema: 1,
    program_id: "different-program",
    runtime_id: DEFAULT_RUNTIME_ID,
    check_ref: "e2e",
    verification: verificationBinding(true),
    passed: true,
    evidence: "suite green",
  };
  const world = greenWorld(programId, {
    exitGates: ["integration:e2e"],
    integrationEvidenceVersion: 1,
    integrationEvidence: [expected],
    gateEvidence: { e2e: artifact },
  });
  try {
    // Keep the legacy sanitized copy that the current reader consumes, and add the
    // collision-resistant location the new reader must inspect. Before the fix the
    // current implementation trusts only passed:true and incorrectly reports passed.
    fs.writeFileSync(path.join(world.evidenceDir, boundArtifactName("e2e")), `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
    const result = world.run("--gates");
    assert.equal(result.status, 0);
    assert.equal(gateByString(result.body, "integration:e2e").state, "failed");
    assert.match(gateByString(result.body, "integration:e2e").message, /identity|program/i);
  } finally {
    world.cleanup();
  }
});

test("D9.1/D2 MASKING: every Orca task completed but the integration check FAILS → gate failed, program NOT complete", () => {
  const world = greenWorld("epic-gate-mask", { exitGates: ["integration:e2e"], gateEvidence: { e2e: { passed: false, evidence: "suite RED" } } });
  try {
    // Gate view: the outcome durably reconciles complete (prereq met) yet the gate fails
    // from LIVE evidence — task completion cannot mask it.
    const g = world.run("--gates");
    assert.equal(g.body.prerequisites_met, true);
    assert.equal(gateByString(g.body, "integration:e2e").state, "failed");
    // Program-level: not complete, stop reason is the integration failure (never masked).
    const f = world.run("--final-summary");
    assert.equal(f.body.program_complete, false);
    assert.equal(f.body.stopped_on, "integration_gate_failed");
    // D7: a failed exit gate under --strict exits 71 (GATE_FAILED) in BOTH modes.
    assert.equal(world.run("--gates", ["--strict"]).status, GATE_REASONS.GATE_FAILED);
    assert.equal(world.run("--gates", ["--strict"]).status, 71);
    assert.equal(world.run("--final-summary", ["--strict"]).status, 71);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.2 — gates before prerequisites → not_yet_evaluable; --strict exit 70
// ---------------------------------------------------------------------------

function runningWorld(programId, exitGates) {
  const receipt = makeReceipt({ programId, slug: "__SELF__", root: "__SELF__", tasks: [{ outcome_id: "a", run: "run-a" }] });
  return buildGateWorld({
    programId,
    receipt,
    manifests: [{ run_id: "run-a", state: "review_pending", pr_number: 10, issue_number: 100 }],
    orcaScenario: { tasks: [orcaTask(programId, "a")] },
    ghScenario: { prs: { 10: { state: "OPEN" } }, issues: { 100: { state: "OPEN" } } },
    exitGates,
  });
}

test("D9.2: gates before prerequisites reconcile → not_yet_evaluable + blocking outcomes; --strict exits 70", () => {
  const world = runningWorld("epic-gate-early", ["integration:e2e"]);
  try {
    const r = world.run("--gates");
    assert.equal(r.status, 0);
    assert.equal(r.body.prerequisites_met, false);
    assert.equal(gateByString(r.body, "integration:e2e").state, "not_yet_evaluable");
    assert.ok(r.body.blocking_reasons.some((reason) => reason.reason_code === "PREREQUISITES_NOT_MET" && reason.message.includes("a")));
    const strict = world.run("--gates", ["--strict"]);
    assert.equal(strict.status, GATE_REASONS.GATES_NOT_EVALUABLE);
    assert.equal(strict.status, 70);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.3 — unrecognized prefix → unevaluable, never passed
// ---------------------------------------------------------------------------

test("D9.3: an unrecognized gate prefix evaluates as unevaluable (never passed) with a naming diagnostic", () => {
  const world = greenWorld("epic-gate-unknown", { exitGates: ["frobnicate:the-widget"] });
  try {
    const r = world.run("--gates");
    const gate = gateByString(r.body, "frobnicate:the-widget");
    assert.equal(gate.state, "unevaluable");
    assert.notEqual(gate.state, "passed");
    assert.match(gate.message, /no recognized kind prefix/);
    assert.match(gate.message, /frobnicate:the-widget/);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.4 — follow-up proposal recorded; NOTHING dispatched/created
// ---------------------------------------------------------------------------

test("D9.4: a failing gate proposes a follow-up in the report + receipt (--record-proposals); nothing is dispatched/created", () => {
  const world = greenWorld("epic-gate-followup", { exitGates: ["integration:e2e"], gateEvidence: { e2e: { passed: false } } });
  try {
    const before = world.receiptOnDisk();
    // Report always carries the proposal; the pinned entry shape (D3).
    const r = world.run("--gates");
    assert.equal(r.body.follow_ups.length, 1);
    const proposal = r.body.follow_ups[0];
    assert.equal(proposal.source_gate, "integration:e2e");
    assert.equal(proposal.status, "proposed");
    assert.equal(typeof proposal.proposed_wave, "number");
    assert.deepEqual(Object.keys(proposal).sort(), ["description", "id", "proposed_wave", "source_gate", "status"].sort());
    // WITHOUT --record-proposals the receipt is byte-identical (strictly read-only).
    assert.equal(world.receiptOnDisk(), before, "flagless --gates never writes the receipt");
    // WITH --record-proposals the proposal is appended to the receipt under follow_ups.
    const recorded = world.run("--gates", ["--record-proposals"]);
    assert.equal(recorded.status, 0);
    const persisted = JSON.parse(world.receiptOnDisk());
    assert.equal(persisted.follow_ups[0].source_gate, "integration:e2e");
    assert.equal(persisted.follow_ups[0].status, "proposed");
    // No mutation reached Orca or gh on any path (invocation log + poison proof). Note
    // `dispatch-show` is a READ and is expected in the log; only a bare `dispatch`,
    // task-create/task-update, terminal, reset, or worktree would be a mutation.
    assert.equal(world.orca.readPoison(), null);
    assert.equal(world.gh.readPoison(), null);
    const mutating = world.orca.readLog().some((line) => /task-create|task-update|reset|worktree|(^|\s)terminal(\s|$)|orchestration dispatch(\s|$)/.test(line));
    assert.equal(mutating, false, "no mutating Orca subcommand was invoked");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A1 (owner amendment) — --record-proposals UPSERTS follow_ups; never replaces.
// A prior operator-set `deferred` row must survive; only NEW derived ids append.
// ---------------------------------------------------------------------------

test("A1: --record-proposals upserts follow_ups — a pre-seeded deferred entry survives byte-for-byte and new proposals are appended", () => {
  const deferredEntry = { id: "followup-later", source_outcome: "a", description: "operator deferred this", proposed_wave: 3, status: "deferred" };
  const world = greenWorld("epic-a1-append", {
    exitGates: ["integration:e2e"],
    gateEvidence: { e2e: { passed: false } },
    followUps: [deferredEntry],
  });
  try {
    const before = JSON.parse(world.receiptOnDisk());
    const recorded = world.run("--gates", ["--record-proposals"]);
    assert.equal(recorded.status, 0);
    const persisted = JSON.parse(world.receiptOnDisk());
    // The operator-set deferred row survives byte-for-byte (still first, still deferred).
    assert.deepEqual(persisted.follow_ups[0], deferredEntry);
    // The freshly-derived proposal for the failing gate is APPENDED, not a replacement.
    assert.equal(persisted.follow_ups.length, 2);
    const appended = persisted.follow_ups[1];
    assert.equal(appended.id, "followup-integration-e2e");
    assert.equal(appended.source_gate, "integration:e2e");
    assert.equal(appended.status, "proposed");
    // Nothing else in the receipt changed (everything except follow_ups + the updated_at bump).
    const strip = (r) => { const c = { ...r }; delete c.follow_ups; delete c.updated_at; return c; };
    assert.deepEqual(strip(persisted), strip(before));
    // Strictly read-only toward Orca/gh on the record path (poisons + the same log guard as D9.4).
    assert.equal(world.orca.readPoison(), null);
    assert.equal(world.gh.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

test("A1: a derived proposal whose id collides with a recorded deferred entry does NOT overwrite it (recorded wins)", () => {
  // The recorded entry shares the exact id the failing gate would derive, but the operator
  // deferred it — recording must keep the deferral, never flip it back to a blocking proposal.
  const deferredEntry = { id: "followup-integration-e2e", source_gate: "integration:e2e", description: "known-flaky, deferred by operator", proposed_wave: 4, status: "deferred" };
  const world = greenWorld("epic-a1-conflict", {
    exitGates: ["integration:e2e"],
    gateEvidence: { e2e: { passed: false } },
    followUps: [deferredEntry],
  });
  try {
    const recorded = world.run("--gates", ["--record-proposals"]);
    assert.equal(recorded.status, 0);
    const persisted = JSON.parse(world.receiptOnDisk());
    // Exactly one entry — the recorded deferred one, unchanged. The derived proposed twin was
    // dropped on conflict rather than clobbering the operator's deferral.
    assert.equal(persisted.follow_ups.length, 1);
    assert.deepEqual(persisted.follow_ups[0], deferredEntry);
    assert.equal(persisted.follow_ups[0].status, "deferred");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.5 — follow-up ACCEPTANCE path; frozen compiler protections re-raise
// ---------------------------------------------------------------------------

function runRun(fixtureName, extraArgs = []) {
  const fake = installFakeOrcaRun({});
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-gates-run-"));
  const programsRoot = path.join(base, "programs");
  const repoRoot = path.join(base, "repo");
  fs.mkdirSync(programsRoot, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  initGitRepo(repoRoot);
  const args = ["--json", "--orca-bin", fake.orcaPath, "--repo-root", repoRoot, "--program-file", path.join(REPO_ROOT, "tests", "relay-orca", "fixtures", fixtureName), ...extraArgs];
  const result = { status: 0, stdout: "", stderr: "" };
  try {
    result.stdout = execFileSync(process.execPath, [RUN_JS, ...args], { encoding: "utf-8", env: { ...process.env, RELAY_ORCA_PROGRAMS_ROOT: programsRoot }, stdio: "pipe" });
  } catch (error) {
    result.status = error.status;
    result.stdout = error.stdout ? String(error.stdout) : "";
    result.stderr = error.stderr ? String(error.stderr) : "";
  }
  result.body = result.stdout ? JSON.parse(result.stdout) : null;
  result.cleanup = () => {
    fake.cleanup();
    fs.rmSync(base, { recursive: true, force: true });
  };
  return result;
}

test("D9.5: an accepted follow-up (appended later-wave outcome) compiles and runs through the existing run intent", () => {
  const r = runRun("followup-later-wave.json", ["--operator-handle", "h1", "--operator-handle", "h2"]);
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.body.ok, true);
    // The base outcome (wave 1) is materialized/dispatched; the follow-up sits in a strictly
    // later wave, honoring the immutable-wave contract.
    const base = r.body.tasks.find((task) => task.outcome_id === "base-widget");
    assert.ok(base && base.orca_task_id, "base outcome dispatched");
  } finally {
    r.cleanup();
  }
});

test("D9.5: a follow-up with a SAME-WAVE dependency is re-raised verbatim by the frozen compiler (exit 14)", () => {
  const r = runRun("reject-same-wave.json");
  try {
    assert.equal(r.status, 14);
    assert.equal(r.body.reason_code, "SAME_WAVE_DEPENDENCY");
  } finally {
    r.cleanup();
  }
});

test("D9.6: an UNPREPARED fleet follow-up is re-raised verbatim (UNPREPARED_FLEET_LEAF, exit 12)", () => {
  const r = runRun("reject-unprepared-fleet.json");
  try {
    assert.equal(r.status, 12);
    assert.equal(r.body.reason_code, "UNPREPARED_FLEET_LEAF");
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.7 — decision gate provenance + explicit-flag write boundary
// ---------------------------------------------------------------------------

const DECISION_GATE_DEF = { id: "signoff", question: "proceed to completion?", options: ["yes", "no"], downstream_wave: 2 };

test("D9.7: an unresolved decision gate reports awaiting_decision and blocks completion", () => {
  const world = greenWorld("epic-decision-open", { exitGates: ["decision:signoff"], decisionGates: [DECISION_GATE_DEF] });
  try {
    const g = world.run("--gates");
    assert.equal(gateByString(g.body, "decision:signoff").state, "awaiting_decision");
    const f = world.run("--final-summary");
    assert.equal(f.body.program_complete, false);
    assert.equal(f.body.stopped_on, "awaiting_decision");
  } finally {
    world.cleanup();
  }
});

test("D9.7: a decision resolved via the explicit run flag carries all six provenance keys and passes the gate", () => {
  // Resolve the decision by riding the flag on a `run` (the receipt gains a decisions[]).
  const r = runRun("valid-single-relay-run.json", ["--operator-handle", "h1", "--resolve-decision", "signoff", "--resolution", "approved by owner", "--resolver", "alice"]);
  try {
    assert.equal(r.status, 0, r.stderr);
    const receiptPath = r.body.receipt_path;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
    assert.equal(receipt.decisions.length, 1);
    const record = receipt.decisions[0];
    assert.equal(record.id, "signoff");
    // ALL six verbatim provenance keys present (question/options from the program's
    // decision_gates def; resolution/resolver from the flag; resolved_at stamped).
    DECISION_KEYS.forEach((key) => assert.ok(key in record, `decision record missing provenance key ${key}`));
    assert.equal(record.resolution, "approved by owner");
    assert.equal(record.resolver, "alice");
    // question/options/downstream_wave are sourced from the program's decision_gates def.
    assert.equal(record.question, "operator approves program completion");
    assert.ok(Array.isArray(record.options));
    assert.ok(record.downstream_wave === null || Number.isInteger(record.downstream_wave));
  } finally {
    r.cleanup();
  }
});

test("D9.7: a decision record missing a provenance key → unevaluable (fail closed), diagnostic naming the key", () => {
  const world = greenWorld("epic-decision-bad", {
    exitGates: ["decision:signoff"],
    decisionGates: [DECISION_GATE_DEF],
    // resolved_at and downstream_wave omitted → invalid record.
    decisions: [{ id: "signoff", question: "q", options: ["y"], resolution: "ok", resolver: "a" }],
  });
  try {
    const g = world.run("--gates");
    const gate = gateByString(g.body, "decision:signoff");
    assert.equal(gate.state, "unevaluable");
    assert.match(gate.message, /provenance key/);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.8 — budget gate: under ceiling passes; at/over fails with both numbers
// ---------------------------------------------------------------------------

test("D9.8: budget counter under ceiling → passed; at/over → failed with BOTH numbers", () => {
  // One dispatched task in the receipt → dispatches_performed = 1.
  const under = greenWorld("epic-budget-under", { exitGates: ["budget:dispatches_performed:5"] });
  try {
    const r = under.run("--gates");
    const gate = gateByString(r.body, "budget:dispatches_performed:5");
    assert.equal(gate.state, "passed");
    assert.match(gate.evidence, /dispatches_performed=1/);
  } finally {
    under.cleanup();
  }
  const over = greenWorld("epic-budget-over", { exitGates: ["budget:dispatches_performed:1"] });
  try {
    const r = over.run("--gates");
    const gate = gateByString(r.body, "budget:dispatches_performed:1");
    assert.equal(gate.state, "failed");
    assert.match(gate.message, /dispatches_performed=1/);
    assert.match(gate.message, /ceiling 1/);
    const f = over.run("--final-summary");
    assert.equal(f.body.stopped_on, "budget_ceiling_reached");
  } finally {
    over.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.9 — authorization gate: absent never passes; present passes
// ---------------------------------------------------------------------------

test("D9.9: an absent authorization record never passes; a present record (explicit flag) passes", () => {
  const absent = greenWorld("epic-auth-absent", { exitGates: ["authorization:deploy"] });
  try {
    const r = absent.run("--gates");
    const gate = gateByString(r.body, "authorization:deploy");
    assert.notEqual(gate.state, "passed");
    assert.equal(gate.state, "awaiting_decision");
  } finally {
    absent.cleanup();
  }
  const present = greenWorld("epic-auth-present", { exitGates: ["authorization:deploy"], authorizations: [{ id: "deploy", authorizer: "release-captain" }] });
  try {
    const r = present.run("--gates");
    assert.equal(gateByString(r.body, "authorization:deploy").state, "passed");
  } finally {
    present.cleanup();
  }
});

test("D9.9: an authorization record is written ONLY via the explicit run flag", () => {
  const r = runRun("valid-single-relay-run.json", ["--operator-handle", "h1", "--record-authorization", "deploy", "--authorizer", "release-captain"]);
  try {
    assert.equal(r.status, 0, r.stderr);
    const receipt = JSON.parse(fs.readFileSync(r.body.receipt_path, "utf-8"));
    assert.deepEqual(receipt.authorizations, [{ id: "deploy", authorizer: "release-captain" }]);
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.10 — final summary: fully green completes + reproducible; stop-condition map
// ---------------------------------------------------------------------------

test("D9.10: a fully green program declares program_complete:true with the eleven verbatim keys, and is REPRODUCIBLE", () => {
  const world = greenWorld("epic-complete", {
    exitGates: ["integration:e2e", "budget:waves_dispatched:9", "decision:signoff", "authorization:deploy"],
    decisionGates: [DECISION_GATE_DEF],
    gateEvidence: { e2e: { passed: true, evidence: "green" } },
    decisions: [{ id: "signoff", question: "proceed?", options: ["y", "n"], resolution: "approved", resolver: "alice", resolved_at: "2026-07-13T02:00:00Z", downstream_wave: 2 }],
    authorizations: [{ id: "deploy", authorizer: "release-captain" }],
  });
  try {
    const first = world.run("--final-summary");
    assert.equal(first.status, 0);
    assert.deepEqual(Object.keys(first.body).sort(), [...FINAL_SUMMARY_KEYS].sort());
    assert.equal(first.body.program_complete, true);
    assert.equal(first.body.stopped_on, null);
    assert.equal(first.body.gates.every((gate) => gate.state === "passed"), true);
    // Reproducible: re-running against unchanged live state yields byte-identical bytes.
    const second = world.run("--final-summary");
    assert.equal(first.stdout, second.stdout, "final summary must be reproducible (no timestamps/randomness)");
  } finally {
    world.cleanup();
  }
});

test("D9.10: each pinned stop condition maps to its distinct stopped_on value", () => {
  // (a) integration gate failure
  const gateFail = greenWorld("epic-stop-gate", { exitGates: ["integration:e2e"], gateEvidence: { e2e: { passed: false } } });
  try {
    assert.equal(gateFail.run("--final-summary").body.stopped_on, "integration_gate_failed");
  } finally {
    gateFail.cleanup();
  }
  // (b) awaiting decision
  const awaiting = greenWorld("epic-stop-dec", { exitGates: ["decision:signoff"], decisionGates: [DECISION_GATE_DEF] });
  try {
    assert.equal(awaiting.run("--final-summary").body.stopped_on, "awaiting_decision");
  } finally {
    awaiting.cleanup();
  }
  // (c) escalated outcome (force-closed relay manifest) — prereq not met
  const escalated = buildGateWorld({
    programId: "epic-stop-esc",
    receipt: makeReceipt({ programId: "epic-stop-esc", slug: "__SELF__", root: "__SELF__", tasks: [{ outcome_id: "a", run: "run-a" }] }),
    manifests: [{ run_id: "run-a", state: "closed", pr_number: 10, issue_number: 100 }],
    orcaScenario: { tasks: [orcaTask("epic-stop-esc", "a")] },
    ghScenario: { prs: { 10: { state: "OPEN" } }, issues: { 100: { state: "OPEN" } } },
    exitGates: ["integration:e2e"],
  });
  try {
    assert.equal(escalated.run("--final-summary").body.stopped_on, "relay_escalated");
  } finally {
    escalated.cleanup();
  }
  // (d) unaccepted follow-up (recorded proposed follow_up, everything else green)
  const unaccepted = greenWorld("epic-stop-fu", {
    exitGates: ["budget:waves_dispatched:9"],
    followUps: [{ id: "followup-old", source_gate: "integration:old", description: "prior discovery", proposed_wave: 2, status: "proposed" }],
  });
  try {
    const f = unaccepted.run("--final-summary");
    assert.equal(f.body.program_complete, false);
    assert.equal(f.body.stopped_on, "unaccepted_follow_up");
  } finally {
    unaccepted.cleanup();
  }
  // (e) budget ceiling
  const budget = greenWorld("epic-stop-budget", { exitGates: ["budget:dispatches_performed:1"] });
  try {
    assert.equal(budget.run("--final-summary").body.stopped_on, "budget_ceiling_reached");
  } finally {
    budget.cleanup();
  }
});

test("D9.10: a deferred follow-up is listed separately and does NOT block completion; --strict exits 72 when blocked", () => {
  const deferred = greenWorld("epic-deferred", {
    exitGates: ["budget:waves_dispatched:9"],
    followUps: [{ id: "followup-later", source_outcome: "a", description: "nice to have", proposed_wave: 3, status: "deferred" }],
  });
  try {
    const f = deferred.run("--final-summary");
    assert.equal(f.body.program_complete, true, "a deferred follow-up does not block");
    assert.equal(f.body.deferred.length, 1);
    assert.equal(f.body.deferred[0].status, "deferred");
  } finally {
    deferred.cleanup();
  }
  // --strict completion-blocked exit 72 when a decision gate blocks completion.
  const blocked = greenWorld("epic-blocked", { exitGates: ["decision:signoff"], decisionGates: [DECISION_GATE_DEF] });
  try {
    const strict = blocked.run("--final-summary", ["--strict"]);
    assert.equal(strict.status, GATE_REASONS.COMPLETION_BLOCKED);
    assert.equal(strict.status, 72);
  } finally {
    blocked.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A2 (owner amendment) — ANY present stop condition VETOES program_complete, even when
// the D6 conjunction (outcomes complete + prerequisites met + gates passed + no blocking
// follow-up) is otherwise fully green. stopped_on is never null while a stop is present.
// ---------------------------------------------------------------------------

test("A2: an unmapped back-pointer repair candidate vetoes program_complete though D6 is otherwise green → stopped_on graph_ambiguous", () => {
  // Every D6 term is green: outcome "a" is durably complete and the budget gate passes. The
  // ONLY blemish is a live relay manifest that references this program but is ABSENT from the
  // receipt mapping — an unmapped back-pointer surfaced as a repair_candidate (graph ambiguous).
  const world = greenWorld("epic-a2-backptr", {
    exitGates: ["budget:waves_dispatched:9"],
    manifests: [{ run_id: "run-orphan", state: "review_pending", pr_number: 20, issue_number: 200, notes: "relay-orca run for program epic-a2-backptr (unmapped back-pointer)" }],
  });
  try {
    const f = world.run("--final-summary");
    // The exit gate itself passed and there is NO gate/outcome/follow-up blocking reason —
    // completion is denied solely because a stop condition is present.
    assert.equal(f.body.gates.every((gate) => gate.state === "passed"), true, "the exit gate passed");
    assert.equal(f.body.blocking_reasons.length, 0, "no gate/outcome/follow-up blocking reason — only the stop condition vetoes");
    assert.equal(f.body.program_complete, false, "a present stop condition vetoes completion");
    assert.equal(f.body.stopped_on, "graph_ambiguous");
  } finally {
    world.cleanup();
  }
});

test("A2: a runtime mismatch vetoes program_complete though the outcome is durably complete → stopped_on orca_lifecycle_failure", () => {
  // The outcome reconciles complete_with_evidence off DURABLE evidence (merged manifest +
  // merged PR + closed issue) regardless of runtime trust, and the budget gate passes — so
  // the D6 conjunction holds. But the live runtime id does not match the receipt's, so the
  // report attributes runtime "mismatch" (a lifecycle failure). It must veto completion.
  const world = buildGateWorld({
    programId: "epic-a2-runtime",
    receipt: makeReceipt({ programId: "epic-a2-runtime", slug: "__SELF__", root: "__SELF__", runtimeId: "runtime-receipt-abc", tasks: [{ outcome_id: "a", run: "run-a" }] }),
    manifests: [{ run_id: "run-a", state: "merged", pr_number: 10, issue_number: 100, head_sha: "abc" }],
    orcaScenario: { runtimeId: "runtime-live-xyz", tasks: [orcaTask("epic-a2-runtime", "a", { status: "completed", worker_done: true })] },
    ghScenario: { prs: { 10: { state: "MERGED", mergedAt: "2026-07-13T01:00:00Z", headRefOid: "abc" } }, issues: { 100: { state: "CLOSED", stateReason: "COMPLETED" } } },
    exitGates: ["budget:waves_dispatched:9"],
  });
  try {
    const g = world.run("--gates");
    assert.equal(g.body.prerequisites_met, true, "the outcome is durably complete even under a runtime mismatch");
    assert.equal(g.body.gates.every((gate) => gate.state === "passed"), true, "the exit gate passed");
    const f = world.run("--final-summary");
    assert.equal(f.body.program_complete, false, "a runtime mismatch vetoes completion");
    assert.equal(f.body.stopped_on, "orca_lifecycle_failure");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.11 — stale worker_done + escalated relay run block completion (#945 classifier)
// ---------------------------------------------------------------------------

test("D9.11: a stale worker_done (task done + PR open) reconciles inconsistent → gates not_yet_evaluable, completion blocked", () => {
  const world = buildGateWorld({
    programId: "epic-stale",
    receipt: makeReceipt({ programId: "epic-stale", slug: "__SELF__", root: "__SELF__", tasks: [{ outcome_id: "a", run: "run-a" }] }),
    manifests: [{ run_id: "run-a", state: "review_pending", pr_number: 10, issue_number: 100 }],
    orcaScenario: { tasks: [orcaTask("epic-stale", "a", { status: "completed", worker_done: true })] },
    ghScenario: { prs: { 10: { state: "OPEN" } }, issues: { 100: { state: "OPEN" } } },
    exitGates: ["integration:e2e"],
  });
  try {
    const g = world.run("--gates");
    assert.equal(g.body.prerequisites_met, false);
    assert.equal(gateByString(g.body, "integration:e2e").state, "not_yet_evaluable");
    const f = world.run("--final-summary");
    assert.equal(f.body.program_complete, false);
    assert.equal(f.body.stopped_on, "relay_escalated");
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.12 — read-only boundary: flagless modes write NOTHING; poisons active
// ---------------------------------------------------------------------------

test("D9.12: --gates and --final-summary WITHOUT --record-proposals leave the receipt byte-identical (read-only)", () => {
  const world = greenWorld("epic-readonly", { exitGates: ["integration:e2e", "decision:signoff"], decisionGates: [DECISION_GATE_DEF], gateEvidence: { e2e: { passed: true } } });
  try {
    const before = world.receiptOnDisk();
    world.run("--gates");
    assert.equal(world.receiptOnDisk(), before, "--gates is read-only without --record-proposals");
    world.run("--final-summary");
    assert.equal(world.receiptOnDisk(), before, "--final-summary is strictly read-only");
    // No mutating/reset/worktree Orca or write-gh call ever ran.
    assert.equal(world.orca.readPoison(), null);
    assert.equal(world.gh.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

test("D9.12: gate/final-summary modes never leak engine/model tokens into the report", () => {
  const world = greenWorld("epic-engine-agnostic", { exitGates: ["integration:e2e"], gateEvidence: { e2e: { passed: true } } });
  try {
    const lowered = JSON.stringify(world.run("--final-summary").body).toLowerCase();
    ["codex", "claude", "cursor", "cline", "opencode", "gpt", "opus", "sonnet"].forEach((token) => {
      assert.equal(lowered.includes(token), false, `report leaked engine token ${token}`);
    });
  } finally {
    world.cleanup();
  }
});
