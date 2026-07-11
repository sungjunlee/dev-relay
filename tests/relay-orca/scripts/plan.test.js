"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SKILL_DIR = path.join(REPO_ROOT, "skills", "relay-orca");
const PLAN_JS = path.join(SKILL_DIR, "scripts", "plan.js");
const FIXTURES = path.join(__dirname, "..", "fixtures");
const { compileProgram } = require(path.join(SKILL_DIR, "scripts", "lib", "compile-program"));
const { REASONS } = require(path.join(SKILL_DIR, "scripts", "lib", "reasons"));

function fixturePath(name) {
  return path.join(FIXTURES, `${name}.json`);
}

function compileFixture(name) {
  return compileProgram(JSON.parse(fs.readFileSync(fixturePath(name), "utf-8")));
}

// Run plan.js in a throwaway cwd + HOME so any accidental write is observable.
function runPlanIsolated(name, extraArgs = []) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orca-cwd-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orca-home-"));
  const result = { status: 0, stdout: "", stderr: "" };
  try {
    result.stdout = execFileSync(process.execPath, [PLAN_JS, "--program-file", fixturePath(name), ...extraArgs], {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, HOME: home, RELAY_HOME: path.join(home, ".relay") },
      stdio: "pipe",
    });
  } catch (error) {
    result.status = error.status;
    result.stdout = error.stdout ? String(error.stdout) : "";
    result.stderr = error.stderr ? String(error.stderr) : "";
  }
  result.cwdEntries = fs.readdirSync(cwd);
  result.homeEntries = fs.readdirSync(home);
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

// ---------------------------------------------------------------------------
// D12 fixture matrix + D8 valid-plan shape
// ---------------------------------------------------------------------------

test("D12: valid single relay_run compiles to a one-task, one-wave plan (D8)", () => {
  const plan = compileFixture("valid-single-relay-run");
  assert.equal(plan.ok, true);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.concurrency, 2);
  const [task] = plan.tasks;
  assert.equal(task.task_id, "orca-task-outcome-a");
  assert.equal(task.kind, "relay_run");
  assert.deepEqual(task.recommended_route, { operator: "relay", mode: "single_run", read_only: false });
  assert.deepEqual(task.expected_evidence, ["PR merged", "issue 1001 closed"]);
  assert.deepEqual(plan.waves, [{ wave: 1, task_ids: ["orca-task-outcome-a"] }]);
});

test("D12: mixed relay_run + relay_fleet orders the fleet into a later wave", () => {
  const plan = compileFixture("mixed-run-fleet");
  assert.equal(plan.ok, true);
  assert.equal(plan.concurrency, 2, "default concurrency must be 2 when unspecified (D8)");
  const fleet = plan.tasks.find((task) => task.kind === "relay_fleet");
  assert.deepEqual(fleet.recommended_route, { operator: "relay-fleet", mode: "prepared_leaves", read_only: false });
  assert.deepEqual(fleet.depends_on, ["orca-task-foundation"]);
  assert.deepEqual(plan.waves, [
    { wave: 1, task_ids: ["orca-task-foundation"] },
    { wave: 2, task_ids: ["orca-task-fanout"] },
  ]);
});

test("D12: advisory-gate keeps independent advisory + integration tasks in the same wave", () => {
  const plan = compileFixture("advisory-gate");
  assert.equal(plan.ok, true);
  assert.equal(plan.waves.length, 3);
  assert.deepEqual(plan.waves[1].task_ids, ["orca-task-advisory", "orca-task-gate"]);
  const advisory = plan.tasks.find((task) => task.outcome_id === "advisory");
  assert.equal(advisory.recommended_route.read_only, true);
  assert.deepEqual(advisory.decision_gate, { id: "sec-gate", description: "no blocking findings", authorization: "operator" });
  const reconcile = plan.tasks.find((task) => task.outcome_id === "reconcile");
  assert.equal(reconcile.kind, "tracker_reconciliation");
  assert.deepEqual(reconcile.depends_on, ["orca-task-advisory", "orca-task-gate"]);
});

test("D8: task IDs and waves are deterministic across repeated compiles", () => {
  assert.deepEqual(compileFixture("advisory-gate"), compileFixture("advisory-gate"));
});

test("D8: same-wave tasks are always mutually independent across every valid fixture", () => {
  for (const name of ["valid-single-relay-run", "mixed-run-fleet", "advisory-gate"]) {
    const plan = compileFixture(name);
    const waveOf = new Map(plan.tasks.map((task) => [task.task_id, task.wave]));
    plan.waves.forEach((wave) => {
      wave.task_ids.forEach((taskId) => {
        const task = plan.tasks.find((candidate) => candidate.task_id === taskId);
        task.depends_on.forEach((dep) => {
          assert.ok(waveOf.get(dep) < wave.wave, `${name}: ${taskId} depends on same-or-later-wave ${dep}`);
        });
      });
    });
  }
});

test("D8: every task kind stays within the five supported kinds", () => {
  const supported = new Set(["relay_run", "relay_fleet", "integration_gate", "advisory_review", "tracker_reconciliation"]);
  for (const name of ["valid-single-relay-run", "mixed-run-fleet", "advisory-gate"]) {
    compileFixture(name).tasks.forEach((task) => assert.ok(supported.has(task.kind)));
  }
});

test("D11: no engine-specific execution fields leak into the compiled plan", () => {
  const serialized = JSON.stringify(compileFixture("advisory-gate"));
  // "executor/reviewer" are allowed as relay ROLE names in the depth invariant;
  // what must never appear is an agent-ENGINE selection (that is relay route config).
  for (const forbidden of ["codex", "claude", "opencode", "gpt-", "gemini", "antigravity", '"model"', '"engine"']) {
    assert.ok(!serialized.includes(forbidden), `plan output must not carry engine token ${forbidden}`);
  }
  compileFixture("advisory-gate").tasks.forEach((task) => {
    assert.deepEqual(Object.keys(task.recommended_route).sort(), ["mode", "operator", "read_only"]);
  });
});

test("D10: ownership invariants are stated in the plan output", () => {
  const { invariants } = compileFixture("valid-single-relay-run");
  assert.match(invariants.orca_workers_are_operators, /OPERATORS, not direct code workers/);
  assert.match(invariants.relay_owns_worktrees, /relay owns implementation worktrees/);
  assert.match(invariants.lifecycle_not_completion, /worker_done.*NOT completion authority/);
  assert.equal(invariants.nested_relay_orca, "forbidden");
});

// ---------------------------------------------------------------------------
// D7 seven-case rejection matrix + D9 depth/nesting — distinct reason + exit code
// ---------------------------------------------------------------------------

const REJECTIONS = [
  { fixture: "reject-vague", reason: "VAGUE_INTENT" }, // D7(a)
  { fixture: "reject-missing-exit-gates", reason: "MISSING_EXIT_GATES" }, // D7(b)
  { fixture: "reject-unprepared-fleet", reason: "UNPREPARED_FLEET_LEAF" }, // D7(c)
  { fixture: "reject-cycle", reason: "DEPENDENCY_CYCLE" }, // D7(d)
  { fixture: "reject-same-wave", reason: "SAME_WAVE_DEPENDENCY" }, // D7(e)
  { fixture: "reject-unsupported-kind", reason: "UNSUPPORTED_TASK_KIND" }, // D7(f)
  { fixture: "reject-concurrency", reason: "CONCURRENCY_EXCEEDED" }, // D7(g)
  { fixture: "reject-nested-orca", reason: "NESTED_RELAY_ORCA" }, // D9
  { fixture: "reject-excessive-depth", reason: "EXCESSIVE_DEPTH" }, // D9
];

for (const { fixture, reason } of REJECTIONS) {
  test(`plan rejects ${fixture} with ${reason} and a distinct non-zero exit code`, () => {
    const result = runPlanIsolated(fixture, ["--json"]);
    assert.equal(result.status, REASONS[reason], `${fixture} must exit with ${reason} code ${REASONS[reason]}`);
    assert.notEqual(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.reason_code, reason);
    assert.ok(body.message && body.message.length > 0);
  });
}

test("D7/D9: every rejection reason maps to a DISTINCT non-zero exit code", () => {
  const codes = REJECTIONS.map(({ reason }) => REASONS[reason]);
  assert.equal(new Set(codes).size, codes.length, "reason exit codes must be pairwise distinct");
  assert.ok(codes.every((code) => Number.isInteger(code) && code > 0));
});

// ---------------------------------------------------------------------------
// D6 read-only proof
// ---------------------------------------------------------------------------

test("D6: a valid plan run writes nothing to cwd or HOME", () => {
  const result = runPlanIsolated("advisory-gate", ["--json"]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.cwdEntries, [], "plan must not create files in the working directory");
  assert.deepEqual(result.homeEntries, [], "plan must not create ~/.relay or any HOME state");
  JSON.parse(result.stdout); // stdout is the only output surface
});

test("D6: a rejecting plan run also writes nothing outside stdout/stderr", () => {
  const result = runPlanIsolated("reject-cycle", ["--json"]);
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.cwdEntries, []);
  assert.deepEqual(result.homeEntries, []);
});

test("D6: plan sources contain no write, subprocess, or network APIs", () => {
  const sources = [PLAN_JS, ...fs.readdirSync(path.join(SKILL_DIR, "scripts", "lib")).map((file) => path.join(SKILL_DIR, "scripts", "lib", file))];
  const forbidden = [
    /child_process/, /execFileSync/, /execSync/, /spawnSync/, /spawn\s*\(/,
    /writeFile/, /appendFile/, /mkdirSync/, /rmSync/, /rmdirSync/, /createWriteStream/,
    /require\((['"])(node:)?(https?|net|dgram|dns)\1\)/,
  ];
  sources.forEach((source) => {
    const text = fs.readFileSync(source, "utf-8");
    forbidden.forEach((pattern) => assert.doesNotMatch(text, pattern, `${path.basename(source)} must not use ${pattern}`));
  });
});

// ---------------------------------------------------------------------------
// D5 explicit-only routing + CLI success contract
// ---------------------------------------------------------------------------

test("D5: agents/openai.yaml disables implicit invocation", () => {
  const yaml = fs.readFileSync(path.join(SKILL_DIR, "agents", "openai.yaml"), "utf-8");
  assert.match(yaml, /allow_implicit_invocation:\s*false/, "relay-orca must be explicit-only from the OpenAI agent surface");
});

test("D5: SKILL.md routing text is explicit-only and disclaims ordinary relay triggers", () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf-8");
  const front = skill.split(/\n---\n/)[0];
  assert.match(front, /explicit-only/i, "description must declare explicit-only routing");
  assert.match(front, /NOT for ordinary relay, relay-fleet, delegation, implementation, or planning/i);
  // keywords must be relay-orca-specific, never bare generic triggers.
  const keywords = (front.match(/keywords:\s*(.*)/) || [])[1] || "";
  for (const bare of ["dispatch", "implement", "delegate", "review"]) {
    assert.ok(!keywords.split(/[\s,]+/).includes(bare), `keyword "${bare}" would auto-trigger on ordinary requests`);
  }
});

test("CLI: --json success emits a parseable plan and exits 0", () => {
  const result = runPlanIsolated("valid-single-relay-run", ["--json"]);
  assert.equal(result.status, 0);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.program_id, "epic-demo-single");
});

test("CLI: --concurrency override above 4 is rejected", () => {
  const result = runPlanIsolated("valid-single-relay-run", ["--json", "--concurrency", "8"]);
  assert.equal(result.status, REASONS.CONCURRENCY_EXCEEDED);
});
