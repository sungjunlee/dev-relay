"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const fleet = require("../../../skills/relay-fleet/scripts/relay-fleet");
const { createRunRecord } = require("../../../skills/relay-dispatch/scripts/run-store");
const { getFleetManifestPath, getManifestPath, getRunDir } = require("../../../skills/relay-dispatch/scripts/manifest/paths");
const { writeManifest } = require("../../../skills/relay-dispatch/scripts/manifest/store");

const HEAD = "b".repeat(40);

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function setup() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-safety-")));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fleet@example.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Fleet"]);
  fs.mkdirSync(path.join(repo, "backlog", "sprints"), { recursive: true });
  fs.writeFileSync(path.join(repo, "backlog", "sprints", "fleet.md"), "---\ncomponent: fleet\n---\n");
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-safety-home-")));
  const sprintState = path.join(repo, "sprint-state.js");
  fs.writeFileSync(sprintState, [
    "if (process.argv.includes('--help')) { console.log('--track --component'); process.exit(0); }",
    `console.log(JSON.stringify({schema_version:2,active_sprint:{path:${JSON.stringify(path.join(repo, "backlog", "sprints", "fleet.md"))},track:'fleet',frontmatter:{component:'fleet'}}}));`,
  ].join("\n"));
  return { repo, relayHome, sprintState };
}

function makeLeaf(repo, issue = 7, branch = "feature/fleet-child") {
  const prompt = path.join(repo, `prompt-${issue}.md`);
  const rubric = path.join(repo, `rubric-${issue}.yaml`);
  const done = path.join(repo, `done-${issue}.md`);
  fs.writeFileSync(prompt, "do work\n"); fs.writeFileSync(rubric, "criteria: []\n"); fs.writeFileSync(done, "done\n");
  return { leaf_ref: `leaf-${issue}`, issue_number: issue, branch, prompt_file: prompt, rubric_file: rubric, done_criteria_file: done, ownership: { sprint: "backlog/sprints/fleet.md", track: "fleet", component: "fleet" } };
}

function withRelayHome(fixture, work) {
  const prior = { home: process.env.RELAY_HOME, sprint: process.env.RELAY_SPRINT_STATE_BIN };
  process.env.RELAY_HOME = fixture.relayHome; process.env.RELAY_SPRINT_STATE_BIN = fixture.sprintState;
  return Promise.resolve().then(work).finally(() => {
    if (prior.home === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = prior.home;
    if (prior.sprint === undefined) delete process.env.RELAY_SPRINT_STATE_BIN; else process.env.RELAY_SPRINT_STATE_BIN = prior.sprint;
  });
}

function writeVnextChild(repo, fleetId, leaf, facts = []) {
  const runId = `issue-${leaf.issue_number}-20260801000000000-aaaaaaaa`;
  const logical = getRunDir(repo, runId); fs.mkdirSync(logical, { recursive: true });
  const runDir = fs.realpathSync(logical);
  const criteria = path.join(runDir, "done-criteria.md");
  const criteriaBytes = fs.readFileSync(leaf.done_criteria_file); fs.writeFileSync(criteria, criteriaBytes);
  const ownershipDigest = hash(`${JSON.stringify(leaf.ownership, null, 2)}\n`);
  createRunRecord({ runDir, record: {
    version: 3, run_id: runId, repo: { root: repo, remote: "owner/repo" },
    git: { branch: leaf.branch, base_branch: "main", worktree: repo, start_sha: "a".repeat(40) },
    contract: { done_criteria_path: criteria, done_criteria_sha256: hash(criteriaBytes) },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
    parent: { kind: "fleet", id: fleetId }, ownership_digest: ownershipDigest,
    created_at: "2026-08-01T00:00:00.000Z",
  } });
  fs.writeFileSync(path.join(runDir, "events.jsonl"), facts.map((fact) => JSON.stringify({ ...fact, run_id: runId })).join("\n") + (facts.length ? "\n" : ""));
  return { runId, runDir };
}

function prFact() {
  return { event_id: "pr-1", type: "pull_request_recorded", at: "2026-08-01T00:00:01.000Z", actor: "relay", payload: { pr_number: 42, repo: "owner/repo", head_ref: "feature/fleet-child", base_ref: "main", head_sha: HEAD, created_by_relay: true } };
}

function reviewFact(doneHash, verdict = "pass") {
  return { event_id: "review-1", type: "review_recorded", at: "2026-08-01T00:00:02.000Z", actor: "reviewer", payload: { round: 1, verdict, reviewed_sha: HEAD, done_criteria_sha256: doneHash, reviewer: "claude", review_artifact: "/tmp/review.json", override: null } };
}

test("run.json-only child is discovered and forged legacy ready state cannot authorize merge", async () => {
  const fixture = setup();
  await withRelayHome(fixture, () => {
    const leaf = makeLeaf(fixture.repo); fleet.writeCohortExclusive(fixture.repo, "fleet-safe", [leaf]);
    const child = writeVnextChild(fixture.repo, "fleet-safe", leaf, [prFact()]);
    const runJsonOnly = fleet.deriveFleet(fixture.repo, "fleet-safe");
    assert.equal(runJsonOnly.children[0].run_id, child.runId);
    assert.equal(runJsonOnly.children[0].source, "vnext");
    writeManifest(getManifestPath(fixture.repo, child.runId), { run_id: child.runId, state: "ready_to_merge", fleet_id: "fleet-safe", git: { working_branch: leaf.branch }, issue: { number: leaf.issue_number }, anchor: { done_criteria_path: leaf.done_criteria_file }, ownership: leaf.ownership });
    const summary = fleet.deriveFleet(fixture.repo, "fleet-safe");
    assert.equal(summary.children[0].run_id, child.runId);
    assert.equal(summary.children[0].source, "vnext");
    assert.equal(summary.children[0].run_state, "review_pending");
  });
});

test("invalid run.json blocks legacy fallback and keeps the owning leaf in operator attention", async () => {
  const fixture = setup();
  await withRelayHome(fixture, () => {
    const leaf = makeLeaf(fixture.repo); fleet.writeCohortExclusive(fixture.repo, "fleet-invalid-run", [leaf]);
    const child = writeVnextChild(fixture.repo, "fleet-invalid-run", leaf, []);
    fs.writeFileSync(path.join(child.runDir, "run.json"), "{invalid\n");
    writeManifest(getManifestPath(fixture.repo, child.runId), {
      run_id: child.runId, state: "ready_to_merge", fleet_id: "fleet-invalid-run",
      git: { working_branch: leaf.branch }, issue: { number: leaf.issue_number },
      anchor: { done_criteria_path: leaf.done_criteria_file }, ownership: leaf.ownership,
    });
    const summary = fleet.deriveFleet(fixture.repo, "fleet-invalid-run");
    assert.equal(summary.children[0].run_id, child.runId);
    assert.equal(summary.children[0].source, "vnext_invalid");
    assert.equal(summary.children[0].disposition, "attention");
    assert.notEqual(summary.children[0].disposition, "retry_pending");
    assert.match(summary.children[0].error, /run\.json is not valid JSON/);
  });
});

test("malformed facts retain the vNext child as attention instead of erasing it for retry", async () => {
  const fixture = setup();
  await withRelayHome(fixture, () => {
    const leaf = makeLeaf(fixture.repo); fleet.writeCohortExclusive(fixture.repo, "fleet-invalid-facts", [leaf]);
    const child = writeVnextChild(fixture.repo, "fleet-invalid-facts", leaf, []);
    fs.writeFileSync(path.join(child.runDir, "events.jsonl"), "not-json\n");
    const summary = fleet.deriveFleet(fixture.repo, "fleet-invalid-facts");
    assert.equal(summary.children[0].run_id, child.runId);
    assert.equal(summary.children[0].run_state, "attention");
    assert.equal(summary.children[0].disposition, "attention");
    assert.notEqual(summary.children[0].run_state, "no_run_manifest");
    assert.match(summary.children[0].error, /invalid JSON/);
  });
});

test("redispatch folds resume the same run and never invoke review again", async () => {
  const fixture = setup();
  await withRelayHome(fixture, async () => {
    const leaves = [makeLeaf(fixture.repo, 31), makeLeaf(fixture.repo, 32, "feature/fleet-child-32")];
    fleet.writeCohortExclusive(fixture.repo, "fleet-redispatch", leaves);
    const noAttempt = writeVnextChild(fixture.repo, "fleet-redispatch", leaves[0], []);
    const doneHash = hash(fs.readFileSync(leaves[1].done_criteria_file));
    const changed = writeVnextChild(fixture.repo, "fleet-redispatch", leaves[1], [
      { ...prFact(), payload: { ...prFact().payload, head_ref: leaves[1].branch } },
      reviewFact(doneHash, "changes_requested"),
    ]);
    const dispatchCapture = path.join(fixture.repo, "dispatch-capture.jsonl");
    const dispatch = path.join(fixture.repo, "capture-dispatch.js");
    fs.writeFileSync(dispatch, `require('fs').appendFileSync(${JSON.stringify(dispatchCapture)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`);
    const reviewCapture = path.join(fixture.repo, "review-capture.jsonl");
    const review = path.join(fixture.repo, "capture-review.js");
    fs.writeFileSync(review, `require('fs').appendFileSync(${JSON.stringify(reviewCapture)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`);
    const result = await fleet.runFleet({
      repo: fixture.repo, fleetId: "fleet-redispatch", review: true, parallel: 2,
      dispatchScript: dispatch, reviewScript: review,
    });
    const invocations = fs.readFileSync(dispatchCapture, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(invocations.length, 2);
    assert.deepEqual(new Set(invocations.map((argv) => argv[argv.indexOf("--run-id") + 1])), new Set([noAttempt.runId, changed.runId]));
    assert.equal(result.dispatch.every((entry) => entry.mode === "resume"), true);
    assert.equal(result.review.length, 0);
    assert.equal(fs.existsSync(reviewCapture), false, "redispatch paths must not repeat review before a new attempt finishes");
  });
});

test("pending artifact drift is explicit operator attention without changing cohort identity", async () => {
  const fixture = setup();
  await withRelayHome(fixture, () => {
    const leaf = makeLeaf(fixture.repo); fleet.writeCohortExclusive(fixture.repo, "fleet-pending-drift", [leaf]);
    fs.writeFileSync(leaf.prompt_file, "mutated after cohort\n");
    const summary = fleet.deriveFleet(fixture.repo, "fleet-pending-drift");
    assert.equal(summary.children[0].run_state, "artifact_drift");
    assert.equal(summary.children[0].disposition, "attention");
    assert.match(summary.operator_attention[0].error, /changed after immutable cohort creation/);
  });
});

test("facts-derived passing review is the only vNext ready-to-merge authority", async () => {
  const fixture = setup();
  await withRelayHome(fixture, () => {
    const leaf = makeLeaf(fixture.repo); fleet.writeCohortExclusive(fixture.repo, "fleet-ready", [leaf]);
    const doneHash = hash(fs.readFileSync(leaf.done_criteria_file));
    writeVnextChild(fixture.repo, "fleet-ready", leaf, [prFact(), reviewFact(doneHash)]);
    assert.equal(fleet.deriveFleet(fixture.repo, "fleet-ready").children[0].run_state, "ready_to_merge");
  });
});

test("cohort hashes keep child identity stable after source Done Criteria drift", async () => {
  const fixture = setup();
  await withRelayHome(fixture, () => {
    const leaf = makeLeaf(fixture.repo); fleet.writeCohortExclusive(fixture.repo, "fleet-drift", [leaf]);
    const child = writeVnextChild(fixture.repo, "fleet-drift", leaf, []);
    fs.writeFileSync(leaf.done_criteria_file, "changed later\n");
    const summary = fleet.deriveFleet(fixture.repo, "fleet-drift");
    assert.equal(summary.children[0].run_id, child.runId);
    assert.notEqual(summary.children[0].run_state, "no_run_manifest");
    assert.deepEqual(summary.operator_attention, []);
  });
});

test("dry-run with a leaves file writes zero cohort bytes", async () => {
  const fixture = setup();
  await withRelayHome(fixture, async () => {
    const leaf = makeLeaf(fixture.repo); const leavesFile = path.join(fixture.repo, "leaves.json");
    fs.writeFileSync(leavesFile, JSON.stringify({ leaves: [leaf] }));
    const noop = path.join(fixture.repo, "noop.js"); fs.writeFileSync(noop, "process.exit(0);\n");
    const before = fs.existsSync(path.dirname(fleet.getFleetLeavesStorePath(fixture.repo, "fleet-dry"))) ? fs.readdirSync(path.dirname(fleet.getFleetLeavesStorePath(fixture.repo, "fleet-dry"))) : [];
    const result = await fleet.runFleet({ repo: fixture.repo, fleetId: "fleet-dry", leavesFile, dryRun: true, dispatchScript: noop, parallel: 1 });
    const after = fs.existsSync(path.dirname(fleet.getFleetLeavesStorePath(fixture.repo, "fleet-dry"))) ? fs.readdirSync(path.dirname(fleet.getFleetLeavesStorePath(fixture.repo, "fleet-dry"))) : [];
    assert.equal(result.dry_run, true); assert.deepEqual(after, before); assert.equal(fs.existsSync(fleet.getFleetLeavesStorePath(fixture.repo, "fleet-dry")), false);
  });
});

test("cohort publication leaves no partial final file and rejects symlink inputs", async () => {
  const fixture = setup();
  await withRelayHome(fixture, () => {
    const leaf = makeLeaf(fixture.repo); const finalPath = fleet.getFleetLeavesStorePath(fixture.repo, "fleet-partial");
    const original = fs.writeFileSync;
    fs.writeFileSync = function injected(target, bytes, ...rest) {
      if (typeof target === "number" && Buffer.isBuffer(bytes)) { original(target, bytes.subarray(0, 2)); throw new Error("injected partial write"); }
      return original(target, bytes, ...rest);
    };
    try { assert.throws(() => fleet.writeCohortExclusive(fixture.repo, "fleet-partial", [leaf]), /injected partial write/); }
    finally { fs.writeFileSync = original; }
    assert.equal(fs.existsSync(finalPath), false);

    const link = path.join(fixture.repo, "done-link.md"); fs.symlinkSync(leaf.done_criteria_file, link);
    const leavesFile = path.join(fixture.repo, "symlink-leaves.json"); fs.writeFileSync(leavesFile, JSON.stringify({ leaves: [{ ...leaf, done_criteria_file: link }] }));
    assert.throws(() => fleet.loadLeavesFile(fixture.repo, leavesFile), /non-symlink/);
  });
});

test("legacy active fleet without a cohort reports an explicit drain gate", async () => {
  const fixture = setup();
  await withRelayHome(fixture, () => {
    const legacy = getFleetManifestPath(fixture.repo, "fleet-legacy"); fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, "legacy\n");
    assert.throws(() => fleet.readCohort(fixture.repo, "fleet-legacy"), /drain it with the legacy runtime/);
  });
});

test("feature branches carry explicit immutable issue identity into dispatch", () => {
  const leaf = { ...makeLeaf(setup().repo, 99, "feature/no-issue-prefix"), leaf_id: "leaf-99" };
  const args = fleet.buildDispatchArgs({ repoRoot: "/repo", fleetId: "fleet-explicit", leaf, options: { dispatchScript: "/dispatch.js" } });
  assert.deepEqual(args.slice(args.indexOf("--issue-number"), args.indexOf("--issue-number") + 2), ["--issue-number", "99"]);
});

test("two-leaf full drive stops on serial merge failure and closes on retry", async () => {
  const fixture = setup();
  await withRelayHome(fixture, async () => {
    const leaves = [makeLeaf(fixture.repo, 21, "feature/leaf-a"), makeLeaf(fixture.repo, 22, "feature/leaf-b")];
    const leavesFile = path.join(fixture.repo, "drive-leaves.json"); fs.writeFileSync(leavesFile, JSON.stringify({ leaves }));
    const storeModule = path.join(ROOT, "skills", "relay-dispatch", "scripts", "manifest", "store.js");
    const pathsModule = path.join(ROOT, "skills", "relay-dispatch", "scripts", "manifest", "paths.js");
    const dispatch = path.join(fixture.repo, "fake-dispatch.js");
    fs.writeFileSync(dispatch, [
      `const {writeManifest}=require(${JSON.stringify(storeModule)}), {getManifestPath,createRunId}=require(${JSON.stringify(pathsModule)});`,
      "const a=process.argv.slice(2), get=f=>a[a.indexOf(f)+1], repo=a[0], issue=Number(get('--issue-number')), branch=get('--branch'), runId=createRunId({issueNumber:issue,branch});",
      "writeManifest(getManifestPath(repo,runId),{run_id:runId,state:'review_pending',fleet_id:get('--fleet-id'),git:{working_branch:branch},issue:{number:issue},anchor:{done_criteria_path:get('--done-criteria-file')},ownership:JSON.parse(get('--ownership-json'))});",
      "console.log(JSON.stringify({status:'completed',runId}));",
    ].join("\n"));
    const review = path.join(fixture.repo, "fake-review.js");
    fs.writeFileSync(review, [
      `const {readManifest,writeManifest}=require(${JSON.stringify(storeModule)}), {getManifestPath}=require(${JSON.stringify(pathsModule)});`,
      "const a=process.argv.slice(2), get=f=>a[a.indexOf(f)+1], p=getManifestPath(get('--repo'),get('--run-id')), m=readManifest(p).data; writeManifest(p,{...m,state:'ready_to_merge'});",
    ].join("\n"));
    const marker = path.join(fixture.repo, "merge-failed-once");
    const finalize = path.join(fixture.repo, "fake-finalize.js");
    fs.writeFileSync(finalize, [
      "const fs=require('fs');",
      `const {readManifest,writeManifest}=require(${JSON.stringify(storeModule)}), {getManifestPath}=require(${JSON.stringify(pathsModule)});`,
      `const marker=${JSON.stringify(marker)}; if(!fs.existsSync(marker)){fs.writeFileSync(marker,'failed');process.exit(1);}`,
      "const a=process.argv.slice(2), get=f=>a[a.indexOf(f)+1], p=getManifestPath(get('--repo'),get('--run-id')), m=readManifest(p).data; writeManifest(p,{...m,state:'merged'});",
    ].join("\n"));
    const options = { repo: fixture.repo, fleetId: "fleet-drive", leavesFile, review: true, parallel: 2, dispatchScript: dispatch, reviewScript: review, finalizeScript: finalize, mergeMethod: "squash" };
    const first = await fleet.runFleet(options);
    assert.equal(first.ok, false); assert.equal(first.merge.length, 1); assert.equal(first.merge[0].ok, false);
    const second = await fleet.runFleet({ ...options, leavesFile: null });
    assert.equal(second.ok, true); assert.equal(second.merge.length, 2); assert.equal(second.fleet_state, "closed");
  });
});
