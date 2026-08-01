"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const host = require("../../../skills/relay-dispatch/scripts/host");
const LAUNCHER = path.join(__dirname, "../fixtures/host-launch-and-exit.js");

async function waitFor(filePath, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

test("20 independent detached attempts publish terminal proof after launcher exit", { timeout: 180_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-host-survival-")));
  const runDir = path.join(root, "run"), worktree = path.join(root, "worktree"); fs.mkdirSync(runDir); fs.mkdirSync(worktree);
  const handles = new Set(), resultDigests = new Set();
  for (let index = 0; index < 20; index += 1) {
    const attemptId = `survival-${index}`, marker = path.join(worktree, `${attemptId}.marker`);
    const launcher = spawnSync(process.execPath, [LAUNCHER, runDir, worktree, attemptId, marker], { encoding: "utf8", timeout: 30_000 });
    assert.equal(launcher.status, 0, launcher.stderr);
    const receipt = JSON.parse(launcher.stdout);
    await waitFor(receipt.result_path); await waitFor(marker);
    const inspection = host.inspectOwnership({ runDir });
    assert.equal(inspection.status, "stale");
    await host.breakStaleRunLock({ inspection, reason: "qualification terminal proof", resultPath: receipt.result_path });
    handles.add(receipt.host_handle);
    resultDigests.add(require("crypto").createHash("sha256").update(fs.readFileSync(receipt.result_path)).digest("hex"));
  }
  assert.equal(handles.size, 20);
  assert.equal(resultDigests.size, 20);
  assert.equal(host.inspectOwnership({ runDir }).status, "absent");
});
