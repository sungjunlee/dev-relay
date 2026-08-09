"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const fleet = require("../../../skills/relay-fleet/scripts/relay-fleet");
const { createRunRecord } = require("../../../skills/relay-dispatch/scripts/run-store");

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function slug(repo) {
  const base = path.basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  return `${base}-${hash(repo).slice(0, 8)}`;
}
function setup() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-")));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fleet@example.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Fleet"]);
  fs.mkdirSync(path.join(repo, "backlog", "sprints"), { recursive: true });
  fs.writeFileSync(path.join(repo, "backlog", "sprints", "fleet.md"), "---\ncomponent: fleet\n---\n");
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-home-")));
  const runsBase = path.join(relayHome, "runs");
  const sprintState = path.join(repo, "sprint-state.js");
  fs.writeFileSync(sprintState, [
    "if (process.argv.includes('--help')) { console.log('--track --component'); process.exit(0); }",
    `console.log(JSON.stringify({schema_version:2,active_sprint:{path:${JSON.stringify(path.join(repo, "backlog", "sprints", "fleet.md"))},track:'fleet',frontmatter:{component:'fleet'}}}));`,
  ].join("\n"));
  return { repo, relayHome, runsBase, sprintState };
}
function leaf(repo, issue, branch = `issue-${issue}`) {
  const prompt = path.join(repo, `prompt-${issue}.md`); const rubric = path.join(repo, `rubric-${issue}.yaml`); const done = path.join(repo, `done-${issue}.md`);
  fs.writeFileSync(prompt, `work ${issue}\n`); fs.writeFileSync(rubric, "criteria: []\n"); fs.writeFileSync(done, `done ${issue}\n`);
  return { leaf_ref: `leaf-${issue}`, issue_number: issue, branch, prompt_file: prompt, rubric_file: rubric, done_criteria_file: done, ownership: { sprint: "backlog/sprints/fleet.md", track: "fleet", component: "fleet" } };
}
async function fixtureWork(fixture, work) {
  const before = { home: process.env.RELAY_HOME, runs: process.env.RELAY_RUNS_BASE, sprint: process.env.RELAY_SPRINT_STATE_BIN };
  process.env.RELAY_HOME = fixture.relayHome; process.env.RELAY_RUNS_BASE = fixture.runsBase; process.env.RELAY_SPRINT_STATE_BIN = fixture.sprintState;
  try { return await work(); }
  finally {
    for (const [name, value] of [["RELAY_HOME", before.home], ["RELAY_RUNS_BASE", before.runs], ["RELAY_SPRINT_STATE_BIN", before.sprint]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}
function child(fixture, fleetId, item, suffix = "aaaaaaaa") {
  const runId = `issue-${item.issue_number}-20260801000000000-${suffix}`;
  const runDir = path.join(fixture.runsBase, slug(fixture.repo), runId);
  fs.mkdirSync(runDir, { recursive: true });
  const criteria = path.join(runDir, "done-criteria.md"); const criteriaBytes = fs.readFileSync(item.done_criteria_file); fs.writeFileSync(criteria, criteriaBytes);
  createRunRecord({ runDir, record: {
    version: 3, run_id: runId, repo: { root: fixture.repo, remote: `local/${path.basename(fixture.repo)}` },
    git: { branch: item.branch, base_branch: "main", worktree: fixture.repo, start_sha: "a".repeat(40) },
    contract: { done_criteria_path: criteria, done_criteria_sha256: hash(criteriaBytes) },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
    parent: { kind: "fleet", id: fleetId }, ownership_digest: hash(JSON.stringify(item.ownership)),
    created_at: "2026-08-01T00:00:00.000Z",
  } });
  fs.writeFileSync(path.join(runDir, "events.jsonl"), "");
  return { runId, runDir };
}
function inspector(actions) {
  return async ({ runDir }) => {
    const runId = path.basename(runDir); const action = actions[runId] || "wait";
    if (action === "blocked") return { blockers: [{ code: "FACT_CONFLICT" }], derived: { action: "none" }, recommended_action: { kind: "none" } };
    return { blockers: [], derived: { action: action === "merged" ? "none" : action, terminal_kind: action === "merged" ? "merged" : null, reason: action === "redispatch" ? "changes_requested" : null }, recommended_action: { kind: action === "merged" ? "none" : action } };
  };
}
function executable(fixture, name, body) {
  const file = path.join(fixture.repo, name); fs.writeFileSync(file, body); return file;
}

test("closed fleet CLI rejects removed child-dispatch flags", () => {
  assert.throws(() => fleet.parseArgs(["--fleet-id", "fleet-a", "--test-command", "test"]), /Unknown option/);
  assert.throws(() => fleet.parseArgs(["--fleet-id", "fleet-a", "--parallel", "0"]), /positive integer/);
  assert.equal(fleet.parseArgs(["--fleet-id", "fleet-a", "--json"]).json, true);
});

test("immutable leaf schema rejects retired lineage and policy fields", async () => {
  const fixture = setup();
  await fixtureWork(fixture, () => {
    const leavesFile = path.join(fixture.repo, "retired.json");
    fs.writeFileSync(leavesFile, JSON.stringify({ leaves: [{ ...leaf(fixture.repo, 99), request_id: "old-request" }] }));
    assert.throws(() => fleet.loadLeavesFile(fixture.repo, leavesFile), /unsupported fields: request_id/);
  });
});

test("immutable cohort is byte-idempotent and derived status writes nothing", async () => {
  const fixture = setup();
  await fixtureWork(fixture, async () => {
    const leaves = [leaf(fixture.repo, 1)]; const store = fleet.writeCohortExclusive(fixture.repo, "fleet-a", leaves); const before = fs.readFileSync(store);
    fleet.writeCohortExclusive(fixture.repo, "fleet-a", leaves);
    const summary = await fleet.deriveFleet(fixture.repo, "fleet-a", null, { inspectRun: inspector({}) });
    assert.equal(summary.children[0].action, "dispatch"); assert.deepEqual(fs.readFileSync(store), before);
    assert.throws(() => fleet.writeCohortExclusive(fixture.repo, "fleet-a", [{ ...leaves[0], branch: "other" }]), /different bytes/);
  });
});

test("exact parent, issue, branch, Done Criteria, and ownership binding fails closed on duplicates and orphans", async () => {
  const fixture = setup();
  await fixtureWork(fixture, async () => {
    const item = leaf(fixture.repo, 2); fleet.writeCohortExclusive(fixture.repo, "fleet-bind", [item]);
    const first = child(fixture, "fleet-bind", item, "aaaaaaaa"); child(fixture, "fleet-bind", item, "bbbbbbbb");
    let summary = await fleet.deriveFleet(fixture.repo, "fleet-bind", null, { inspectRun: inspector({ [first.runId]: "wait" }) });
    assert.equal(summary.children[0].run_state, "conflict"); assert.equal(summary.operator_attention.length, 1);
    fs.rmSync(path.join(fixture.runsBase, slug(fixture.repo)), { recursive: true });
    const drift = { ...item, branch: "wrong-branch" }; const orphan = child(fixture, "fleet-bind", drift, "cccccccc");
    summary = await fleet.deriveFleet(fixture.repo, "fleet-bind", null, { inspectRun: inspector({ [orphan.runId]: "wait" }) });
    assert.equal(summary.children[0].action, "dispatch"); assert.equal(summary.operator_attention.length, 1);
  });
});

test("corrupt run.json for the cohort issue blocks retry rather than falling back", async () => {
  const fixture = setup();
  await fixtureWork(fixture, async () => {
    const item = leaf(fixture.repo, 3); fleet.writeCohortExclusive(fixture.repo, "fleet-corrupt", [item]);
    const record = child(fixture, "fleet-corrupt", item); fs.writeFileSync(path.join(record.runDir, "run.json"), "{bad\n");
    const summary = await fleet.deriveFleet(fixture.repo, "fleet-corrupt", null, { inspectRun: inspector({}) });
    assert.equal(summary.children[0].disposition, "attention"); assert.match(summary.children[0].error, /not valid JSON/);
  });
});

test("dispatch invokes only no-child new and exact redispatch resume, without retired flags", async () => {
  const fixture = setup();
  await fixtureWork(fixture, async () => {
    const leaves = [leaf(fixture.repo, 4), leaf(fixture.repo, 5)]; const leavesFile = path.join(fixture.repo, "leaves.json"); fs.writeFileSync(leavesFile, JSON.stringify({ leaves }));
    const resumed = child(fixture, "fleet-dispatch", leaves[1]); const capture = path.join(fixture.repo, "dispatch.jsonl");
    const dispatchScript = executable(fixture, "dispatch-capture.js", `require('fs').appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))+'\\n');\n`);
    const result = await fleet.runFleet({ repo: fixture.repo, fleetId: "fleet-dispatch", leavesFile, parallel: 2, dispatchScript, reviewScript: dispatchScript, finalizeScript: dispatchScript, services: { inspectRun: inspector({ [resumed.runId]: "redispatch" }) } });
    const calls = fs.readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 2); assert.equal(result.dispatch.filter((item) => item.mode === "new").length, 1); assert.equal(result.dispatch.filter((item) => item.mode === "resume").length, 1);
    for (const args of calls) for (const retired of ["--leaf-id", "--request-id", "--publish-policy", "--test-command"]) assert.equal(args.includes(retired), false);
  });
});

test("wait action never double-dispatches an existing child", async () => {
  const fixture = setup();
  await fixtureWork(fixture, async () => {
    const item = leaf(fixture.repo, 6); const leavesFile = path.join(fixture.repo, "leaves.json"); fs.writeFileSync(leavesFile, JSON.stringify({ leaves: [item] }));
    const existing = child(fixture, "fleet-wait", item); const capture = path.join(fixture.repo, "should-not-exist"); const script = executable(fixture, "capture.js", `require('fs').writeFileSync(${JSON.stringify(capture)},'called');\n`);
    const result = await fleet.runFleet({ repo: fixture.repo, fleetId: "fleet-wait", leavesFile, parallel: 1, dispatchScript: script, reviewScript: script, finalizeScript: script, services: { inspectRun: inspector({ [existing.runId]: "wait" }) } });
    assert.equal(result.dispatch.length, 0); assert.equal(fs.existsSync(capture), false);
  });
});

test("--review drives exact review actions and serial merge actions through current CLIs", async () => {
  const fixture = setup();
  await fixtureWork(fixture, async () => {
    const leaves = [leaf(fixture.repo, 7), leaf(fixture.repo, 8), leaf(fixture.repo, 9)]; fleet.writeCohortExclusive(fixture.repo, "fleet-drive", leaves);
    const reviewChild = child(fixture, "fleet-drive", leaves[0]); const mergeA = child(fixture, "fleet-drive", leaves[1]); const mergeB = child(fixture, "fleet-drive", leaves[2]);
    const actions = { [reviewChild.runId]: "review", [mergeA.runId]: "merge", [mergeB.runId]: "merge" };
    const reviewCapture = path.join(fixture.repo, "review.jsonl"); const mergeCapture = path.join(fixture.repo, "merge.jsonl");
    const noop = executable(fixture, "noop.js", "process.exit(0);\n");
    const reviewScript = executable(fixture, "review.js", `require('fs').appendFileSync(${JSON.stringify(reviewCapture)},JSON.stringify(process.argv.slice(2))+'\\n');\n`);
    const finalizeScript = executable(fixture, "finalize.js", `require('fs').appendFileSync(${JSON.stringify(mergeCapture)},JSON.stringify(process.argv.slice(2))+'\\n');\n`);
    const result = await fleet.runFleet({ repo: fixture.repo, fleetId: "fleet-drive", review: true, reviewer: "claude", reviewerModel: "opus", mergeMethod: "squash", parallel: 3, dispatchScript: noop, reviewScript, finalizeScript, services: { inspectRun: inspector(actions) } });
    assert.equal(result.review.length, 1); assert.equal(result.merge.length, 2);
    const reviewArgs = JSON.parse(fs.readFileSync(reviewCapture, "utf8").trim()); assert.deepEqual(reviewArgs.slice(reviewArgs.indexOf("--model"), reviewArgs.indexOf("--model") + 2), ["--model", "opus"]); assert.equal(reviewArgs.includes("--reviewer-model"), false);
    const mergeCalls = fs.readFileSync(mergeCapture, "utf8").trim().split("\n").map(JSON.parse); assert.deepEqual(mergeCalls.map((args) => args[args.indexOf("--run-id") + 1]), [mergeA.runId, mergeB.runId]);
  });
});

test("artifact drift is operator attention and dry-run publishes no cohort", async () => {
  const fixture = setup();
  await fixtureWork(fixture, async () => {
    const item = leaf(fixture.repo, 10); fleet.writeCohortExclusive(fixture.repo, "fleet-drift", [item]); fs.writeFileSync(item.prompt_file, "changed\n");
    const drift = await fleet.deriveFleet(fixture.repo, "fleet-drift", null, { inspectRun: inspector({}) }); assert.equal(drift.children[0].run_state, "artifact_drift");
    const fresh = leaf(fixture.repo, 11); const leavesFile = path.join(fixture.repo, "dry.json"); fs.writeFileSync(leavesFile, JSON.stringify({ leaves: [fresh] })); const noop = executable(fixture, "noop.js", "process.exit(0);\n");
    const result = await fleet.runFleet({ repo: fixture.repo, fleetId: "fleet-dry", leavesFile, dryRun: true, parallel: 1, dispatchScript: noop, reviewScript: noop, finalizeScript: noop, services: { inspectRun: inspector({}) } });
    assert.equal(result.dry_run, true); assert.equal(fs.existsSync(fleet.getFleetLeavesStorePath(fixture.repo, "fleet-dry")), false);
  });
});

// #1173 item 4: the --allow-toolset-mismatch escape hatch must thread through a fleet leaf override,
// and the leaf field must reject non-booleans instead of coercing them.
test("fleet leaf allow_toolset_mismatch threads the dispatch flag and rejects non-booleans", async () => {
  const fixture = setup();
  await fixtureWork(fixture, () => {
    const item = { ...leaf(fixture.repo, 40), allow_toolset_mismatch: true };
    const leavesFile = path.join(fixture.repo, "leaves.json");
    fs.writeFileSync(leavesFile, JSON.stringify({ leaves: [item] }));
    const [loaded] = fleet.loadLeavesFile(fixture.repo, leavesFile);
    assert.equal(loaded.allow_toolset_mismatch, true);
    const args = fleet.buildDispatchArgs({ repoRoot: fixture.repo, fleetId: "fleet-toolset", leaf: loaded, options: { dispatchScript: "dispatch.js" } });
    assert.equal(args.includes("--allow-toolset-mismatch"), true);
    fs.writeFileSync(leavesFile, JSON.stringify({ leaves: [{ ...leaf(fixture.repo, 41), allow_toolset_mismatch: "yes" }] }));
    assert.throws(() => fleet.loadLeavesFile(fixture.repo, leavesFile), /allow_toolset_mismatch must be a boolean/);
  });
});
