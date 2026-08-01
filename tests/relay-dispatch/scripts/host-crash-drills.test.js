"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const host = require("../../../skills/relay-dispatch/scripts/host");
const OWNER_CRASH = path.join(__dirname, "../fixtures/host-crash-worker.js");
const LAUNCHER_CRASH = path.join(__dirname, "../fixtures/host-launch-and-exit.js");
const PRELAUNCH_CUTS = ["after_owner_publish", "after_owner_observe", "before_second_dead_probe"];
const LAUNCHED_CUTS = [
  "after_config_claim",
  "after_supervisor_publish",
  "after_running_publish",
  "after_executor_release",
  "before_terminal_observe",
  "after_terminal_publish",
  "before_owner_close",
];

async function waitFor(filePath, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function digest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("ten caller-crash cuts recover once without duplicate execution or terminal reversal", { timeout: 180_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-host-crash-drills-")));
  const worktree = path.join(root, "worktree"); fs.mkdirSync(worktree);

  const early = PRELAUNCH_CUTS.map((cut) => {
    const runDir = path.join(root, cut); fs.mkdirSync(runDir);
    const crashed = spawnSync(process.execPath, [OWNER_CRASH, runDir, worktree, cut], { encoding: "utf8", timeout: 30_000 });
    assert.equal(crashed.status, 86, `${cut}: ${crashed.stderr}`);
    assert.ok(JSON.parse(crashed.stdout).lock_id);
    const inspection = host.inspectOwnership({ runDir });
    assert.equal(inspection.status, "stale", cut);
    return { cut, runDir, inspection };
  });

  const reclaimed = await Promise.all(early.map(({ cut, inspection }) => host.breakStaleRunLock({
    inspection,
    reason: `${cut} owner died before launch`,
  })));
  assert.equal(reclaimed.every((entry) => entry.outcome === "broken"), true);
  for (const { cut, runDir } of early) {
    assert.equal(host.inspectOwnership({ runDir }).status, "absent", cut);
    assert.equal(fs.readdirSync(path.join(runDir, "ownership")).filter((name) => name.endsWith(".closed.json")).length, 1);
    assert.equal(fs.readdirSync(runDir).some((name) => name.endsWith(".result.json")), false);
  }

  for (const cut of LAUNCHED_CUTS) {
    const runDir = path.join(root, cut); fs.mkdirSync(runDir);
    const marker = path.join(worktree, `${cut}.marker`);
    const crashed = spawnSync(process.execPath, [LAUNCHER_CRASH, runDir, worktree, cut, marker], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(crashed.status, 0, `${cut}: ${crashed.stderr}`);
    const receipt = JSON.parse(crashed.stdout);
    await waitFor(receipt.result_path); await waitFor(marker);
    const paths = [
      `host-attempt-${cut}.config.json`,
      `host-attempt-${cut}.supervisor.json`,
      `host-attempt-${cut}.running.json`,
    ].map((name) => path.join(runDir, name));
    assert.equal(paths.every((filePath) => fs.existsSync(filePath)), true, cut);
    assert.equal(fs.readFileSync(marker, "utf8"), "completed", cut);
    const terminalDigest = digest(receipt.result_path);
    const inspection = host.inspectOwnership({ runDir });
    assert.equal(inspection.status, "stale", cut);
    await host.breakStaleRunLock({ inspection, reason: `${cut} recovered by terminal proof`, resultPath: receipt.result_path });
    assert.equal(host.inspectOwnership({ runDir }).status, "absent", cut);
    await assert.rejects(
      host.breakStaleRunLock({ inspection, reason: "duplicate recovery", resultPath: receipt.result_path }),
      (error) => error.code === "LOCK_CHANGED",
    );
    const followup = host.acquireRunLock({ runDir, worktreeDir: worktree, attemptId: `${cut}-followup`, operation: "verify-monotonicity" });
    host.releaseRunLock(followup);
    assert.equal(digest(receipt.result_path), terminalDigest, cut);
    assert.equal(fs.readdirSync(path.join(runDir, "ownership")).filter((name) => name.endsWith(".closed.json")).length, 2, cut);
  }
});
