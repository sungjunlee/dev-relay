const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  ensureRunLayout,
  updateManifestState,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { createEnforcementFixture, DEFAULT_ENFORCEMENT_RUBRIC } = require("../../relay-dispatch/scripts/test-support");
const { EXECUTION_EVIDENCE_FILENAME } = require("../../../skills/relay-review/scripts/review-runner/execution-evidence");
const { startAdvisoryReview } = require("../../../skills/relay-review/scripts/review-runner/advisory");
const {
  getAdvisoryLaneLeasePath,
  readAdvisoryLaneLeases,
  writeAdvisoryLaneLease,
} = require("../../../skills/relay-dispatch/scripts/run-runtime-state");

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lane-lease-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lane-lease-origin-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-lane-lease-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["init", "--bare", remoteRoot], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Lane Lease Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-lane-lease@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteRoot], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const runId = "issue-963-20260712010000000";
  const worktreePath = path.join(repoRoot, "wt", "issue-963");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", "issue-963"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const headSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();
  const { manifestPath, runDir } = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-963",
    baseBranch: "main",
    issueNumber: 963,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor = createEnforcementFixture({
    repoRoot,
    runId,
    state: "loaded",
    rubricContent: DEFAULT_ENFORCEMENT_RUBRIC,
  }).anchor;
  manifest = { ...manifest, git: { ...(manifest.git || {}), pr_number: 963, head_sha: headSha } };
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  writeManifest(manifestPath, manifest);
  fs.writeFileSync(path.join(runDir, EXECUTION_EVIDENCE_FILENAME), `${JSON.stringify({
    schema_version: 1,
    head_sha: headSha,
    test_command: "node --test",
    test_result_hash: "unspecified",
    test_result_summary: "pass",
    recorded_at: "2026-07-12T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  }, null, 2)}\n`, "utf-8");
  return { repoRoot, runDir, runId, headSha, worktreePath };
}

function writeDelayedAdvisoryReviewer(repoRoot, { delayMs = 1500 } = {}) {
  const filePath = path.join(repoRoot, "fake-lane-reviewer.js");
  fs.writeFileSync(filePath, `#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    profile: "blindspot",
    summary: "Lane lease fixture advisory.",
    required_findings: [],
    advisory_findings: [{
      title: "Advisory-only test gap",
      body: "Recorded for lease bookkeeping coverage.",
      file: "README.md",
      line: 1,
      severity: "P3",
      category: "test-gap",
      confidence: 0.8
    }],
    duplicate_or_low_confidence: []
  }));
}, ${Number(delayMs)});
`, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitUntil(predicate, { timeoutMs = 20000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    sleepSync(intervalMs);
  }
  return predicate();
}

test("writeAdvisoryLaneLease retry overwrites the same reviewer+round lease", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lane-lease-unit-"));
  writeAdvisoryLaneLease(runDir, {
    pid: 111,
    pgid: 111,
    round: 1,
    reviewer: "opencode",
  });
  writeAdvisoryLaneLease(runDir, {
    pid: 222,
    pgid: 222,
    round: 1,
    reviewer: "opencode",
  });
  const leases = readAdvisoryLaneLeases(runDir);
  assert.equal(leases.length, 1);
  assert.equal(leases[0].lease.pid, 222);
  assert.equal(leases[0].lease.pgid, 222);
  assert.equal(leases[0].lease.round, 1);
  assert.equal(leases[0].lease.reviewer, "opencode");
  assert.ok(leases[0].lease.host);
  assert.ok(leases[0].lease.started_at);
});

test("startAdvisoryReview writes a lane lease and the worker removes it on completion", () => {
  const { repoRoot, runDir, runId, headSha } = setupRepo();
  const reviewerScript = writeDelayedAdvisoryReviewer(repoRoot, { delayMs: 1200 });
  const started = startAdvisoryReview({
    gating: false,
    headSha,
    laneIndex: 1,
    profile: "blindspot",
    promptText: "Advisory lease prompt",
    reviewerModel: "example/opencode-model-fast",
    reviewerName: "opencode",
    reviewerScript,
    reviewRepoPath: repoRoot,
    round: 1,
    runDir,
    runId,
    runRepoPath: repoRoot,
    state: STATES.REVIEW_PENDING,
    timeoutSeconds: 30,
    trigger: "every_round",
  });

  const leasePath = getAdvisoryLaneLeasePath(runDir, 1, "opencode");
  assert.equal(fs.existsSync(leasePath), true);
  const lease = JSON.parse(fs.readFileSync(leasePath, "utf-8"));
  assert.equal(lease.pid, started.child.pid);
  assert.equal(lease.pgid, started.child.pid);
  assert.equal(lease.round, 1);
  assert.equal(lease.reviewer, "opencode");
  assert.equal(lease.host, os.hostname());
  assert.ok(lease.started_at);
  assert.ok(!Number.isNaN(Date.parse(lease.started_at)));

  assert.equal(
    waitUntil(() => !fs.existsSync(leasePath), { timeoutMs: 25000 }),
    true,
    "worker should remove its lane lease on normal completion"
  );
  assert.equal(readAdvisoryLaneLeases(runDir).length, 0);

  // Ensure the detached worker has fully exited so temp dirs can be cleaned later.
  waitUntil(() => {
    try {
      process.kill(started.child.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, { timeoutMs: 5000 });
});

test("advisory-worker best-effort lease removal tolerates a missing lease file", () => {
  const { repoRoot, runDir, runId, headSha } = setupRepo();
  const reviewerScript = writeDelayedAdvisoryReviewer(repoRoot, { delayMs: 0 });
  const requestPath = path.join(runDir, "review-round-1-advisory-opencode-request.json");
  const resultPath = path.join(runDir, "review-round-1-advisory-opencode-result.json");
  const promptPath = path.join(runDir, "review-round-1-advisory-opencode-prompt.md");
  const decisionPath = path.join(runDir, "review-round-1-advisory-opencode-decision.json");
  fs.writeFileSync(promptPath, "prompt\n", "utf-8");
  fs.writeFileSync(requestPath, `${JSON.stringify({
    artifactReviewerName: "opencode",
    decisionPath,
    gating: false,
    headSha,
    laneIndex: 1,
    profile: "blindspot",
    promptPath,
    requestPath,
    resultPath,
    reviewerModel: null,
    reviewerName: "opencode",
    reviewerPolicy: null,
    policyDecision: null,
    modelResolution: null,
    reviewerScript,
    reviewRepoPath: repoRoot,
    round: 1,
    runDir,
    runId,
    runRepoPath: repoRoot,
    source: null,
    startedAt: Date.now(),
    state: STATES.REVIEW_PENDING,
    timeoutSeconds: 30,
    trigger: "every_round",
  }, null, 2)}\n`, "utf-8");

  const workerPath = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "advisory-worker.js");
  const result = spawnSync(process.execPath, [workerPath, requestPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(getAdvisoryLaneLeasePath(runDir, 1, "opencode")), false);
  assert.ok(fs.existsSync(resultPath));
});
