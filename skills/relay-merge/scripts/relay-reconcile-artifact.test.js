const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");
const { readRunEvents } = require("../../relay-dispatch/scripts/relay-events");
const { createEnforcementFixture } = require("../../relay-dispatch/scripts/test-support");

const SCRIPT = path.join(__dirname, "relay-reconcile-artifact.js");
const REPORT_SCRIPT = path.join(__dirname, "../../relay-dispatch/scripts/reliability-report.js");

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Reconcile Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-reconcile@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
}

function buildManifestForState(manifest, targetState) {
  switch (targetState) {
    case STATES.DRAFT:
      return manifest;
    case STATES.DISPATCHED:
      return updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
    case STATES.REVIEW_PENDING: {
      const dispatched = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
      const reviewPending = updateManifestState(dispatched, STATES.REVIEW_PENDING, "run_review");
      return {
        ...reviewPending,
        review: {
          ...(reviewPending.review || {}),
          rounds: 1,
          latest_verdict: "pending",
          last_reviewed_sha: reviewPending.git?.head_sha || null,
        },
      };
    }
    case STATES.READY_TO_MERGE: {
      const reviewPending = buildManifestForState(manifest, STATES.REVIEW_PENDING);
      const ready = updateManifestState(reviewPending, STATES.READY_TO_MERGE, "await_explicit_merge");
      return {
        ...ready,
        review: {
          ...(ready.review || {}),
          latest_verdict: "lgtm",
        },
      };
    }
    case STATES.MERGED: {
      const ready = buildManifestForState(manifest, STATES.READY_TO_MERGE);
      return updateManifestState(ready, STATES.MERGED, "done");
    }
    case STATES.CLOSED: {
      const ready = buildManifestForState(manifest, STATES.READY_TO_MERGE);
      return updateManifestState(ready, STATES.CLOSED, "done");
    }
    default:
      throw new Error(`Unsupported fixture manifest state: ${targetState}`);
  }
}

function setupRun({
  manifestState = STATES.REVIEW_PENDING,
  bootstrapExempt = null,
} = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reconcile-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot);

  const branch = "issue-269";
  const runId = createRunId({
    branch,
    timestamp: new Date("2026-04-20T09:00:00.000Z"),
  });
  const manifestPath = ensureRunLayout(repoRoot, runId).manifestPath;
  const worktreePath = path.join(repoRoot, "wt", branch);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 269,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest.anchor = createEnforcementFixture({
    repoRoot,
    runId,
    state: "loaded",
  }).anchor;
  manifest.git.pr_number = 1269;
  manifest.git.head_sha = "abc123def456";
  manifest = buildManifestForState(manifest, manifestState);
  if (bootstrapExempt) {
    manifest.bootstrap_exempt = bootstrapExempt;
  }
  writeManifest(manifestPath, manifest);

  return { repoRoot, runId, manifestPath, branch, worktreePath };
}

function runReconcile(fixture, {
  artifactPath = "execution-evidence.json",
  writerPr = "267",
  reason = "run predates the artifact writer",
  extraArgs = [],
  selectorArgs = ["--repo", fixture.repoRoot, "--run-id", fixture.runId],
} = {}) {
  const stdout = execFileSync("node", [
    SCRIPT,
    ...selectorArgs,
    "--artifact-path", artifactPath,
    "--writer-pr", writerPr,
    "--reason", reason,
    ...extraArgs,
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return JSON.parse(stdout);
}

function spawnReconcile(fixture, args) {
  return spawnSync("node", [SCRIPT, "--repo", fixture.repoRoot, "--run-id", fixture.runId, ...args, "--json"], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

test("relay-reconcile-artifact stamps bootstrap exemption, emits force event, and reports count", () => {
  const fixture = setupRun();
  const artifactPath = "artifacts/execution-evidence.json";
  const result = runReconcile(fixture, { artifactPath, writerPr: "267" });
  const manifest = readManifest(fixture.manifestPath).data;
  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  const forceEvent = events.find((event) => event.event === "force_finalize");
  const report = JSON.parse(execFileSync("node", [
    REPORT_SCRIPT,
    "--repo", fixture.repoRoot,
    "--json",
  ], { encoding: "utf-8" }));

  assert.equal(result.previousState, STATES.REVIEW_PENDING);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.bootstrapExempt, true);
  assert.equal(result.artifactPath, artifactPath);
  assert.equal(result.writerPr, 267);
  assert.equal(manifest.state, STATES.MERGED);
  assert.deepEqual(manifest.bootstrap_exempt, {
    enabled: true,
    artifact_path: artifactPath,
    writer_pr: 267,
    reason: "run predates the artifact writer",
  });
  assert.equal(manifest.last_force.from_state, STATES.REVIEW_PENDING);
  assert.equal(manifest.last_force.to_state, STATES.MERGED);
  assert.equal(manifest.last_force.reason, "run predates the artifact writer");
  assert.equal(forceEvent?.bootstrap_exempt, true);
  assert.equal(forceEvent?.state_from, STATES.REVIEW_PENDING);
  assert.equal(forceEvent?.state_to, STATES.MERGED);
  assert.equal(forceEvent?.pr_number, 267);
  assert.equal(report.bootstrap_exempt_runs, 1);
});

test("relay-reconcile-artifact is idempotent for identical already-exempt merged manifests", () => {
  const fixture = setupRun();
  runReconcile(fixture);
  const firstEvents = readRunEvents(fixture.repoRoot, fixture.runId);
  const result = runReconcile(fixture, {
    selectorArgs: ["--manifest", fixture.manifestPath],
  });
  const secondEvents = readRunEvents(fixture.repoRoot, fixture.runId);

  assert.equal(result.idempotent, true);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(firstEvents.length, 1);
  assert.deepEqual(secondEvents, firstEvents);
});

for (const terminalState of [STATES.MERGED, STATES.CLOSED]) {
  test(`relay-reconcile-artifact rejects non-exempt terminal state ${terminalState}`, () => {
    const fixture = setupRun({ manifestState: terminalState });
    const result = spawnReconcile(fixture, [
      "--artifact-path", "execution-evidence.json",
      "--writer-pr", "267",
      "--reason", "operator checked artifact writer",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`force-finalize cannot be used from terminal state ${terminalState}`));
    const manifest = readManifest(fixture.manifestPath).data;
    assert.equal(manifest.state, terminalState);
    assert.equal("bootstrap_exempt" in manifest, false);
    assert.deepEqual(readRunEvents(fixture.repoRoot, fixture.runId), []);
  });
}

for (const { name, args, pattern } of [
  {
    name: "missing artifact path",
    args: ["--writer-pr", "267", "--reason", "operator checked"],
    pattern: /--artifact-path <path> is required/,
  },
  {
    name: "empty artifact path",
    args: ["--artifact-path", "", "--writer-pr", "267", "--reason", "operator checked"],
    pattern: /--artifact-path (?:<path> is required|requires a non-empty value)/,
  },
  {
    name: "missing writer PR",
    args: ["--artifact-path", "execution-evidence.json", "--reason", "operator checked"],
    pattern: /--writer-pr <int> is required/,
  },
  {
    name: "empty writer PR",
    args: ["--artifact-path", "execution-evidence.json", "--writer-pr", "", "--reason", "operator checked"],
    pattern: /--writer-pr <int> is required/,
  },
]) {
  test(`relay-reconcile-artifact rejects ${name} before mutation`, () => {
    const fixture = setupRun();
    const result = spawnReconcile(fixture, args);

    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
    const manifest = readManifest(fixture.manifestPath).data;
    assert.equal(manifest.state, STATES.REVIEW_PENDING);
    assert.equal("bootstrap_exempt" in manifest, false);
    assert.deepEqual(readRunEvents(fixture.repoRoot, fixture.runId), []);
  });
}

test("relay-reconcile-artifact skip-review is additive with bootstrap reconciliation", () => {
  const fixture = setupRun();
  const result = runReconcile(fixture, {
    extraArgs: ["--skip-review", "manual artifact audit"],
  });
  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  const skipEvent = events.find((event) => event.event === "skip_review");
  const forceEvent = events.find((event) => event.event === "force_finalize");
  const manifest = readManifest(fixture.manifestPath).data;

  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.skipReviewReason, "manual artifact audit");
  assert.equal(skipEvent?.reason, "manual artifact audit");
  assert.equal(skipEvent?.state_from, STATES.REVIEW_PENDING);
  assert.equal(skipEvent?.state_to, STATES.REVIEW_PENDING);
  assert.equal(forceEvent?.bootstrap_exempt, true);
  assert.equal(manifest.bootstrap_exempt.enabled, true);
});
