"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const host = require("../../../skills/relay-dispatch/scripts/host");

function launchdSnapshot() {
  if (process.platform !== "darwin") return null;
  const output = execFileSync("/bin/launchctl", ["print", `gui/${process.getuid()}`], {
    encoding: "utf8",
  });
  return {
    service_count: Number(output.match(/service count = (\d+)/)?.[1]),
    relay_labels: output.split("\n").filter((line) => line.includes("dev.relay.")).length,
  };
}

test("OS-owned supervisor preserves 20/20 worker results after launcher exit", { timeout: 600_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-vnext-host-survival-")));
  const outcomes = [];
  for (let index = 0; index < 20; index += 1) {
    const runDir = path.join(root, `run-${index}`);
    fs.mkdirSync(runDir);
    const outcome = host.runSurvivalTrial({
      runDir,
      trialId: `survival-${index}`,
      timeoutMs: 15_000,
    });
    assert.equal(outcome.status, "completed", `trial ${index + 1}`);
    outcomes.push(outcome);
  }
  assert.throws(
    () => host.issueSurvivalMeasurement(Array(20).fill(outcomes[0])),
    (error) => error.code === "SURVIVAL_GATE_FAILED",
  );
  const measurement = host.issueSurvivalMeasurement(outcomes);
  assert.equal(measurement.trials, 20);
  assert.equal(measurement.losses, 0);
  assert.equal(host.selectHost({ runDir: root, survivalMeasurement: measurement }).supported, true);
});

test("100 detached attempts add zero launchd services", { timeout: 600_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-vnext-host-volume-")));
  const before = launchdSnapshot();
  for (let index = 0; index < 100; index += 1) {
    const runDir = path.join(root, `run-${index}`);
    fs.mkdirSync(runDir);
    const attemptId = `volume-${index}`;
    try {
      const receipt = host.launchLocalSupervisor({
        runDir,
        attemptId,
        command: "/usr/bin/true",
        cwd: runDir,
        timeoutMs: 10_000,
      });
      assert.equal((await host.waitForTerminalResult(receipt)).status, "completed", attemptId);
    } catch (error) {
      error.message = `${attemptId}: ${error.message}`;
      throw error;
    }
  }
  const after = launchdSnapshot();
  if (before && after) {
    assert.equal(after.relay_labels, before.relay_labels);
    assert.equal(after.service_count <= before.service_count, true);
  }
});
