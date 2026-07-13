"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ADVISORY_LANE_PID_REUSE_TOLERANCE_MS,
  isProcessGroupAlive,
  reapAdvisoryLaneLeases,
  writeAdvisoryLaneLease,
} = require("../../../skills/relay-dispatch/scripts/run-runtime-state");

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

test("ADVISORY_LANE_PID_REUSE_TOLERANCE_MS is a named constant in [5s, 60s]", () => {
  assert.ok(Number.isFinite(ADVISORY_LANE_PID_REUSE_TOLERANCE_MS));
  assert.ok(ADVISORY_LANE_PID_REUSE_TOLERANCE_MS >= 5000);
  assert.ok(ADVISORY_LANE_PID_REUSE_TOLERANCE_MS <= 60000);
});

test("reapAdvisoryLaneLeases #996 reused pgid → skipped_pid_reuse, lease removed, process untouched", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pid-reuse-"));
  const pgid = spawnTermIgnoringLane();
  const priorEnv = process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES;
  // Lease claims an old start; hook says the live leader started long after → reuse.
  const leaseStartedAt = "2020-01-01T00:00:00.000Z";
  const leaderStart = "2026-07-13T12:00:00.000Z";
  try {
    const { leasePath } = writeAdvisoryLaneLease(runDir, {
      pid: pgid,
      pgid,
      round: 1,
      reviewer: "codex",
      startedAt: leaseStartedAt,
    });
    process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES = JSON.stringify({
      [String(pgid)]: leaderStart,
    });

    const outcomes = reapAdvisoryLaneLeases({ runDir });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, "skipped_pid_reuse");
    assert.equal(outcomes[0].pgid, pgid);
    assert.equal(fs.existsSync(leasePath), false);
    assert.equal(isProcessGroupAlive(pgid), true, "must not signal a reused pgid");
  } finally {
    forceKillPgid(pgid);
    if (priorEnv === undefined) delete process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES;
    else process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES = priorEnv;
  }
});

test("reapAdvisoryLaneLeases #996 reused pgid dry-run → would_skip_pid_reuse, lease intact", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pid-reuse-dry-"));
  const pgid = spawnTermIgnoringLane();
  const priorEnv = process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES;
  const leaseStartedAt = "2020-01-01T00:00:00.000Z";
  const leaderStart = "2026-07-13T12:00:00.000Z";
  try {
    const { leasePath } = writeAdvisoryLaneLease(runDir, {
      pid: pgid,
      pgid,
      round: 1,
      reviewer: "opencode",
      startedAt: leaseStartedAt,
    });
    process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES = JSON.stringify({
      [String(pgid)]: leaderStart,
    });

    const outcomes = reapAdvisoryLaneLeases({ runDir, dryRun: true });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, "would_skip_pid_reuse");
    assert.equal(outcomes[0].pgid, pgid);
    assert.equal(fs.existsSync(leasePath), true);
    assert.equal(isProcessGroupAlive(pgid), true);
  } finally {
    forceKillPgid(pgid);
    if (priorEnv === undefined) delete process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES;
    else process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES = priorEnv;
  }
});

test("reapAdvisoryLaneLeases #996 leader start within tolerance → normal reap proceeds", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pid-reuse-ok-"));
  const pgid = spawnTermIgnoringLane();
  const priorEnv = {
    startTimes: process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES,
    grace: process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS,
  };
  // Spawn-then-write: leader start equals lease started_at → within tolerance.
  const startedAt = new Date().toISOString();
  try {
    process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS = "200";
    const { leasePath } = writeAdvisoryLaneLease(runDir, {
      pid: pgid,
      pgid,
      round: 1,
      reviewer: "codex",
      startedAt,
    });
    process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES = JSON.stringify({
      [String(pgid)]: startedAt,
    });

    const outcomes = reapAdvisoryLaneLeases({ runDir });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, "reaped");
    assert.equal(outcomes[0].pgid, pgid);
    assert.equal(fs.existsSync(leasePath), false);
    assert.equal(isProcessGroupAlive(pgid), false);
  } finally {
    forceKillPgid(pgid);
    if (priorEnv.startTimes === undefined) delete process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES;
    else process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES = priorEnv.startTimes;
    if (priorEnv.grace === undefined) delete process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS;
    else process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS = priorEnv.grace;
  }
});

test("reapAdvisoryLaneLeases #996 hook absent for pgid → fail open (normal reap)", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pid-reuse-absent-"));
  const pgid = spawnTermIgnoringLane();
  const priorEnv = {
    startTimes: process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES,
    grace: process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS,
  };
  try {
    process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS = "200";
    // Env set but maps a different pgid — this pgid's key is absent → fall through
    // to real ps (legitimate leader start ≤ lease.started_at) → normal reap.
    const { leasePath } = writeAdvisoryLaneLease(runDir, {
      pid: pgid,
      pgid,
      round: 1,
      reviewer: "codex",
    });
    process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES = JSON.stringify({
      "999999999": "2026-07-13T12:00:00.000Z",
    });

    const outcomes = reapAdvisoryLaneLeases({ runDir });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, "reaped");
    assert.equal(fs.existsSync(leasePath), false);
    assert.equal(isProcessGroupAlive(pgid), false);
  } finally {
    forceKillPgid(pgid);
    if (priorEnv.startTimes === undefined) delete process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES;
    else process.env.RELAY_TEST_PROCESS_GROUP_START_TIMES = priorEnv.startTimes;
    if (priorEnv.grace === undefined) delete process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS;
    else process.env.RELAY_ADVISORY_LANE_REAP_GRACE_MS = priorEnv.grace;
  }
});
