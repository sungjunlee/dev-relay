"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const fleet = require("../../../skills/relay-fleet/scripts/relay-fleet");
const { getManifestPath } = require("../../../skills/relay-dispatch/scripts/manifest/paths");
const { writeManifest } = require("../../../skills/relay-dispatch/scripts/manifest/store");

function setup() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-vnext-"));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fleet@example.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Fleet"]);
  fs.mkdirSync(path.join(repo, "backlog", "sprints"), { recursive: true });
  fs.writeFileSync(path.join(repo, "backlog", "sprints", "fleet-track.md"), "---\ncomponent: fleet-component\n---\n");
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-home-")));
  const sprintState = path.join(repo, "sprint-state.js");
  fs.writeFileSync(sprintState, [
    "if (process.argv.includes('--help')) { console.log('--track --component'); process.exit(0); }",
    "console.log(JSON.stringify({schema_version:2,active_sprint:{path:process.argv.at(-1) + '/sprints/fleet-track.md',track:'fleet-track',frontmatter:{component:'fleet-component'}}}));",
  ].join("\n"));
  return { repo, relayHome, sprintState };
}

function leaf(repo) {
  const prompt = path.join(repo, "prompt.md"); const rubric = path.join(repo, "rubric.yaml"); const done = path.join(repo, "done.md");
  fs.writeFileSync(prompt, "do it\n"); fs.writeFileSync(rubric, "criteria: []\n"); fs.writeFileSync(done, "# done\n");
  return { leaf_ref: "leaf-1", issue_number: 1, branch: "issue-1", prompt_file: prompt, rubric_file: rubric, done_criteria_file: done, ownership: { sprint: "backlog/sprints/fleet-track.md", track: "fleet-track", component: "fleet-component" } };
}

test("fleet CLI keeps parsed sibling booleans visible while preserving opaque test commands", () => {
  const parsed = fleet.parseArgs(["--fleet-id", "fleet-vnext", "--parallel", "--json", "--test-command", "--grep smoke"]);
  assert.equal(parsed.parallel, 4, "missing parsed --parallel value must fall back rather than consume --json");
  assert.equal(parsed.json, true);
  assert.equal(parsed.testCommand, "--grep smoke");
  assert.throws(() => fleet.parseArgs(["--fleet-id", "fleet-vnext", "--not-real"]), /unknown flags/);
});

test("immutable cohort is byte-idempotent and status is byte-invariant", () => {
  const fixture = setup(); const original = { RELAY_HOME: process.env.RELAY_HOME, RELAY_SPRINT_STATE_BIN: process.env.RELAY_SPRINT_STATE_BIN };
  process.env.RELAY_HOME = fixture.relayHome; process.env.RELAY_SPRINT_STATE_BIN = fixture.sprintState;
  try {
    const cohort = [leaf(fixture.repo)];
    const cohortPath = fleet.writeCohortExclusive(fixture.repo, "fleet-vnext", cohort);
    const before = fs.readFileSync(cohortPath);
    fleet.writeCohortExclusive(fixture.repo, "fleet-vnext", cohort);
    assert.deepEqual(fs.readFileSync(cohortPath), before);
    const summary = fleet.deriveFleet(fixture.repo, "fleet-vnext");
    assert.equal(summary.children[0].run_state, "no_run_manifest");
    assert.deepEqual(fs.readFileSync(cohortPath), before, "read-only derivation must not alter cohort bytes");
    assert.throws(() => fleet.writeCohortExclusive(fixture.repo, "fleet-vnext", [{ ...cohort[0], branch: "issue-2" }]), /different bytes/);
  } finally { process.env.RELAY_HOME = original.RELAY_HOME; process.env.RELAY_SPRINT_STATE_BIN = original.RELAY_SPRINT_STATE_BIN; }
});

test("cohort store refuses a symlinked logical parent instead of writing through its canonical target", () => {
  const fixture = setup(); const original = { RELAY_HOME: process.env.RELAY_HOME, RELAY_SPRINT_STATE_BIN: process.env.RELAY_SPRINT_STATE_BIN };
  process.env.RELAY_HOME = fixture.relayHome; process.env.RELAY_SPRINT_STATE_BIN = fixture.sprintState;
  try {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-cohort-escape-")));
    const logicalFleets = path.join(fixture.relayHome, "fleets");
    fs.symlinkSync(outside, logicalFleets, "dir");
    const logicalStore = fleet.getFleetLeavesStorePath(fixture.repo, "fleet-symlink-parent");
    const expectedOutsideStore = path.join(outside, path.basename(path.dirname(logicalStore)), path.basename(logicalStore));

    assert.throws(
      () => fleet.writeCohortExclusive(fixture.repo, "fleet-symlink-parent", [leaf(fixture.repo)]),
      /contains a symlink component/,
    );
    assert.equal(fs.existsSync(expectedOutsideStore), false, "publication must not traverse the symlinked parent");
    assert.throws(() => fleet.readCohort(fixture.repo, "fleet-symlink-parent"), /contains a symlink component/);
  } finally { process.env.RELAY_HOME = original.RELAY_HOME; process.env.RELAY_SPRINT_STATE_BIN = original.RELAY_SPRINT_STATE_BIN; }
});

test("duplicate derived child matches fail closed", () => {
  const fixture = setup(); const original = { RELAY_HOME: process.env.RELAY_HOME, RELAY_SPRINT_STATE_BIN: process.env.RELAY_SPRINT_STATE_BIN };
  process.env.RELAY_HOME = fixture.relayHome; process.env.RELAY_SPRINT_STATE_BIN = fixture.sprintState;
  try {
    const cohort = [leaf(fixture.repo)]; fleet.writeCohortExclusive(fixture.repo, "fleet-vnext", cohort);
    for (const suffix of ["aaaaaaaa", "bbbbbbbb"]) {
      const runId = `issue-1-20260801000000000-${suffix}`;
      writeManifest(getManifestPath(fixture.repo, runId), { run_id: runId, state: "dispatched", fleet_id: "fleet-vnext", git: { working_branch: "issue-1" }, anchor: { done_criteria_path: cohort[0].done_criteria_file }, ownership: cohort[0].ownership });
    }
    const summary = fleet.deriveFleet(fixture.repo, "fleet-vnext");
    assert.equal(summary.children[0].run_state, "conflict");
    assert.equal(summary.operator_attention.length, 1);
  } finally { process.env.RELAY_HOME = original.RELAY_HOME; process.env.RELAY_SPRINT_STATE_BIN = original.RELAY_SPRINT_STATE_BIN; }
});

test("branch, Done Criteria, and ownership drift remain orphan attention", () => {
  const fixture = setup(); const original = { RELAY_HOME: process.env.RELAY_HOME, RELAY_SPRINT_STATE_BIN: process.env.RELAY_SPRINT_STATE_BIN };
  process.env.RELAY_HOME = fixture.relayHome; process.env.RELAY_SPRINT_STATE_BIN = fixture.sprintState;
  try {
    const cohort = [leaf(fixture.repo)]; fleet.writeCohortExclusive(fixture.repo, "fleet-vnext", cohort);
    const drifted = [
      { git: { working_branch: "issue-9" }, anchor: { done_criteria_path: cohort[0].done_criteria_file }, ownership: cohort[0].ownership },
      { git: { working_branch: cohort[0].branch }, anchor: { done_criteria_path: path.join(fixture.repo, "prompt.md") }, ownership: cohort[0].ownership },
      { git: { working_branch: cohort[0].branch }, anchor: { done_criteria_path: cohort[0].done_criteria_file }, ownership: { ...cohort[0].ownership, component: "other-component" } },
    ];
    drifted.forEach((fields, index) => {
      const runId = `issue-1-2026080100000000${index}-${String(index + 1).repeat(8)}`;
      writeManifest(getManifestPath(fixture.repo, runId), { run_id: runId, state: "dispatched", fleet_id: "fleet-vnext", ...fields });
    });
    const summary = fleet.deriveFleet(fixture.repo, "fleet-vnext");
    assert.equal(summary.children[0].run_state, "no_run_manifest");
    assert.equal(summary.operator_attention.length, 3);
  } finally { process.env.RELAY_HOME = original.RELAY_HOME; process.env.RELAY_SPRINT_STATE_BIN = original.RELAY_SPRINT_STATE_BIN; }
});
