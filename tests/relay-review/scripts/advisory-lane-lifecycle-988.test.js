const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  getAdvisoryLaneLeasePath,
  isProcessGroupAlive,
  readAdvisoryLaneLeases,
  writeAdvisoryLaneLease,
} = require("../../../skills/relay-dispatch/scripts/run-runtime-state");
const {
  reapPriorAdvisoryLaneAttempts,
  reapTimeoutAdvisoryLane,
} = require("../../../skills/relay-review/scripts/review-runner/advisory-lane-reap");
const { startAdvisoryReview } = require("../../../skills/relay-review/scripts/review-runner/advisory");
const {
  STATES,
  createManifestSkeleton,
  ensureRunLayout,
  updateManifestState,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { createEnforcementFixture, DEFAULT_ENFORCEMENT_RUBRIC } = require("../../relay-dispatch/scripts/test-support");
const { EXECUTION_EVIDENCE_FILENAME } = require("../../../skills/relay-review/scripts/review-runner/execution-evidence");

const TERM_IGNORING_LANE = path.join(
  __dirname,
  "..",
  "..",
  "relay-merge",
  "fixtures",
  "term-ignoring-lane.js"
);

function spawnTermIgnoringLane() {
  const child = spawn(process.execPath, [TERM_IGNORING_LANE], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  assert.ok(Number.isInteger(child.pid) && child.pid > 0);
  assert.equal(isProcessGroupAlive(child.pid), true);
  return child.pid;
}

function forceKillPgid(pgid) {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {}
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitUntil(predicate, { timeoutMs = 20000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    sleepSync(intervalMs);
  }
  return predicate();
}

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lane-reap-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lane-reap-origin-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-lane-reap-"));
  const { execFileSync } = require("child_process");
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["init", "--bare", remoteRoot], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Lane Reap Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-lane-reap@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteRoot], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const runId = "issue-988-20260713010000000";
  const worktreePath = path.join(repoRoot, "wt", "issue-988");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", "issue-988"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const headSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();
  const { manifestPath, runDir } = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-988",
    baseBranch: "main",
    issueNumber: 988,
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
  manifest = { ...manifest, git: { ...(manifest.git || {}), pr_number: 988, head_sha: headSha } };
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  writeManifest(manifestPath, manifest);
  fs.writeFileSync(path.join(runDir, EXECUTION_EVIDENCE_FILENAME), `${JSON.stringify({
    schema_version: 1,
    head_sha: headSha,
    test_command: "node --test",
    test_result_hash: "unspecified",
    test_result_summary: "pass",
    recorded_at: "2026-07-13T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  }, null, 2)}\n`, "utf-8");
  return { repoRoot, runDir, runId, headSha, worktreePath };
}

function writeFastAdvisoryReviewer(repoRoot) {
  const filePath = path.join(repoRoot, "fake-fast-reviewer.js");
  fs.writeFileSync(filePath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  profile: "blindspot",
  summary: "Fast fixture advisory.",
  required_findings: [],
  advisory_findings: [],
  duplicate_or_low_confidence: []
}));
`, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

test("timeout-observed reap escalates to SIGKILL and records lane_reap on the result artifact", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-timeout-reap-"));
  const pgid = spawnTermIgnoringLane();
  const resultPath = path.join(runDir, "review-round-1-advisory-codex-result.json");
  const priorEnv = {
    grace: process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS,
    worker: process.env.RELAY_ADVISORY_LANE_WORKER_EXIT_WAIT_MS,
  };
  process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS = "200";
  process.env.RELAY_ADVISORY_LANE_WORKER_EXIT_WAIT_MS = "50";
  try {
    writeAdvisoryLaneLease(runDir, {
      pid: pgid,
      pgid,
      round: 1,
      reviewer: "codex",
    });
    const result = {
      status: "timeout",
      failureReason: "fixture timeout",
      reviewer: "codex",
      profile: "blindspot",
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");

    const { laneReap, result: nextResult } = reapTimeoutAdvisoryLane({
      runDir,
      round: 1,
      reviewer: "codex",
      resultPath,
      result,
    });

    assert.equal(isProcessGroupAlive(pgid), false);
    assert.equal(fs.existsSync(getAdvisoryLaneLeasePath(runDir, 1, "codex")), false);
    assert.equal(laneReap.outcome, "reaped");
    assert.equal(laneReap.pgid, pgid);
    assert.equal(laneReap.signaled_kill, true);
    assert.equal(nextResult.lane_reap.outcome, "reaped");
    assert.equal(nextResult.lane_reap.pgid, pgid);
    const onDisk = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    assert.equal(onDisk.lane_reap.outcome, "reaped");
    assert.equal(onDisk.lane_reap.pgid, pgid);
    assert.equal(onDisk.lane_reap.signaled_kill, true);
    assert.equal(onDisk.status, "timeout");
  } finally {
    forceKillPgid(pgid);
    if (priorEnv.grace === undefined) delete process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS;
    else process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS = priorEnv.grace;
    if (priorEnv.worker === undefined) delete process.env.RELAY_ADVISORY_LANE_WORKER_EXIT_WAIT_MS;
    else process.env.RELAY_ADVISORY_LANE_WORKER_EXIT_WAIT_MS = priorEnv.worker;
  }
});

test("pre-spawn reap verifies prior attempt is gone before the new spawn", () => {
  const { repoRoot, runDir, runId, headSha } = setupRepo();
  const priorPgid = spawnTermIgnoringLane();
  const priorEnv = process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS;
  process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS = "200";
  let started = null;
  try {
    writeAdvisoryLaneLease(runDir, {
      pid: priorPgid,
      pgid: priorPgid,
      round: 1,
      reviewer: "opencode",
    });
    assert.equal(isProcessGroupAlive(priorPgid), true);

    const observerPath = path.join(runDir, "pre-spawn-liveness.jsonl");
    // Probe liveness transition via the shared reap helper first, then spawn —
    // startAdvisoryReview does the same ordering internally; assert the helper
    // transition, then that startAdvisoryReview leaves the prior group gone.
    const reaps = reapPriorAdvisoryLaneAttempts({
      runDir,
      round: 1,
      reviewer: "opencode",
    });
    assert.equal(reaps.length, 1);
    assert.equal(reaps[0].outcome, "reaped");
    assert.equal(isProcessGroupAlive(priorPgid), false);
    fs.appendFileSync(observerPath, `${JSON.stringify({ priorAlive: false, at: "after_reap" })}\n`);

    // Re-seed a second live prior group to exercise startAdvisoryReview's
    // built-in pre-spawn reap ordering end-to-end.
    const priorPgid2 = spawnTermIgnoringLane();
    writeAdvisoryLaneLease(runDir, {
      pid: priorPgid2,
      pgid: priorPgid2,
      round: 1,
      reviewer: "opencode",
    });
    assert.equal(isProcessGroupAlive(priorPgid2), true);

    const reviewerScript = writeFastAdvisoryReviewer(repoRoot);
    started = startAdvisoryReview({
      gating: false,
      headSha,
      laneIndex: 1,
      profile: "blindspot",
      promptText: "Pre-spawn reap prompt",
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

    assert.equal(isProcessGroupAlive(priorPgid2), false, "prior attempt must be gone after startAdvisoryReview");
    assert.ok(Array.isArray(started.priorLaneReaps));
    assert.equal(started.priorLaneReaps.some((entry) => entry.pgid === priorPgid2 && entry.outcome === "reaped"), true);
    assert.ok(Number.isInteger(started.child.pid) && started.child.pid > 0);
    assert.notEqual(started.child.pid, priorPgid2);
    assert.ok(started.laneAttempt >= 1);

    waitUntil(() => {
      try {
        process.kill(started.child.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, { timeoutMs: 15000 });
    forceKillPgid(priorPgid2);
  } finally {
    forceKillPgid(priorPgid);
    if (started?.child?.pid) forceKillPgid(started.child.pid);
    if (priorEnv === undefined) delete process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS;
    else process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS = priorEnv;
  }
});

test("legacy single-attempt lease filenames remain discoverable beside attempt-suffixed leases", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-legacy-lease-"));
  const legacyPath = getAdvisoryLaneLeasePath(runDir, 1, "codex", 1);
  fs.writeFileSync(legacyPath, `${JSON.stringify({
    pid: 101,
    pgid: 101,
    host: os.hostname(),
    started_at: new Date().toISOString(),
    round: 1,
    reviewer: "codex",
  }, null, 2)}\n`, "utf-8");
  const second = writeAdvisoryLaneLease(runDir, {
    pid: 202,
    pgid: 202,
    round: 1,
    reviewer: "codex",
  });
  assert.equal(second.lease.attempt, 2);
  const leases = readAdvisoryLaneLeases(runDir);
  assert.equal(leases.length, 2);
  assert.equal(leases[0].leasePath, legacyPath);
  assert.equal(leases[0].lease.attempt, 1);
  assert.equal(leases[1].leasePath, second.leasePath);
});
