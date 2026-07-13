const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES, createManifestSkeleton, ensureRunLayout, updateManifestState, writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { createEnforcementFixture, DEFAULT_ENFORCEMENT_RUBRIC } = require("../../relay-dispatch/scripts/test-support");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "review-runner.js");

function setupRun() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-capability-preflight-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Test"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "relay@example.com"], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
  const runId = "issue-910-20260713010515947";
  const worktreePath = path.join(repoRoot, "wt", "issue-910");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", `issue-910-${Date.now()}`], { cwd: repoRoot, stdio: "pipe" });
  const priorHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = relayHome;
  const { manifestPath, runDir } = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot, runId, branch: "issue-910", baseBranch: "main", issueNumber: 910,
    worktreePath, orchestrator: "codex", executor: "codex", reviewer: "codex",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor = createEnforcementFixture({ repoRoot, runId, state: "loaded", rubricContent: DEFAULT_ENFORCEMENT_RUBRIC }).anchor;
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  writeManifest(manifestPath, manifest);
  if (priorHome === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = priorHome;
  const doneCriteriaPath = path.join(repoRoot, "done.md");
  const diffPath = path.join(repoRoot, "change.diff");
  fs.writeFileSync(doneCriteriaPath, "# Done\n");
  fs.writeFileSync(diffPath, "diff --git a/a b/a\n");
  return { repoRoot, relayHome, runId, runDir, manifestPath, doneCriteriaPath, diffPath };
}

function baseArgs(fixture) {
  return [
    SCRIPT, "--repo", fixture.repoRoot, "--run-id", fixture.runId,
    "--pr", "123",
    "--done-criteria-file", fixture.doneCriteriaPath, "--diff-file", fixture.diffPath,
    "--reviewer", "cline", "--no-comment", "--json",
  ];
}

function run(fixture, extra = [], env = {}) {
  return spawnSync(process.execPath, [...baseArgs(fixture), ...extra], {
    encoding: "utf-8", env: { ...process.env, RELAY_HOME: fixture.relayHome, ...env },
  });
}

function roundArtifacts(runDir) {
  return fs.readdirSync(runDir).filter((name) => name.startsWith("review-round-"));
}

test("entry preflight rejects before swap, events, artifacts, or checks wait", () => {
  const fixture = setupRun();
  const before = fs.readFileSync(fixture.manifestPath);
  const eventsPath = path.join(fixture.runDir, "events.jsonl");
  const eventsBefore = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath) : null;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-capability-gh-"));
  const ghMarker = path.join(binDir, "gh-called");
  const gh = path.join(binDir, "gh");
  fs.writeFileSync(gh, `#!/bin/sh\ntouch ${JSON.stringify(ghMarker)}\nexit 1\n`);
  fs.chmodSync(gh, 0o755);

  const result = run(fixture, ["--wait-for-checks", "30"], { PATH: `${binDir}${path.delimiter}${process.env.PATH}` });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /supports advisory_review but not primary_review/);
  assert.match(result.stderr, /Primary-review-capable adapters:/);
  assert.deepEqual(fs.readFileSync(fixture.manifestPath), before, "manifest remains byte-identical");
  assert.equal(fs.existsSync(ghMarker), false, "CI checks were never queried");
  assert.deepEqual(roundArtifacts(fixture.runDir), []);
  assert.deepEqual(fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath) : null, eventsBefore);
});

test("detach parent rejects without receipt, lease, supervisor, or round artifacts", () => {
  const fixture = setupRun();
  const before = fs.readFileSync(fixture.manifestPath);
  const detachTmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-capability-detach-tmp-"));
  const result = run(fixture, ["--detach"], { TMPDIR: detachTmp });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /supports advisory_review but not primary_review/);
  assert.doesNotMatch(result.stdout, /detached|receipt|sentinel|lease/i);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "lease.json")), false);
  const detachDirs = fs.readdirSync(detachTmp).filter((name) => name.startsWith("relay-review-detach-"));
  assert.deepEqual(detachDirs, [], "no supervisor receipt directory or receipt.json artifact is created");
  assert.deepEqual(roundArtifacts(fixture.runDir), []);
  assert.deepEqual(fs.readFileSync(fixture.manifestPath), before);
});

test("review-file and reviewer-script overrides bypass capability preflight", () => {
  const reviewFileFixture = setupRun();
  const reviewFile = path.join(reviewFileFixture.repoRoot, "verdict.json");
  fs.writeFileSync(reviewFile, "{}\n");
  const fromFile = run(reviewFileFixture, ["--review-file", reviewFile, "--prepare-only"]);
  assert.equal(fromFile.status, 0, `${fromFile.stderr}\n${fromFile.stdout}`);

  const scriptFixture = setupRun();
  const reviewerScript = path.join(scriptFixture.repoRoot, "reviewer.js");
  fs.writeFileSync(reviewerScript, "#!/usr/bin/env node\n", "utf-8");
  fs.chmodSync(reviewerScript, 0o755);
  const fromScript = run(scriptFixture, ["--reviewer-script", reviewerScript, "--prepare-only"]);
  assert.equal(fromScript.status, 0, `${fromScript.stderr}\n${fromScript.stdout}`);
});
