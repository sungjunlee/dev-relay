const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { ADAPTER_PHASES, getAdapter } = require("../../../skills/relay-dispatch/scripts/adapters");

const ROOT = path.join(__dirname, "..", "..", "..");
const PROBE_SCRIPT = path.join(ROOT, "skills", "relay-plan", "scripts", "probe-executor-env.js");

test("pi live canary is opt-in and records explicit adapter/model capability", {
  skip: process.env.PI_INTEGRATION === "1" ? false : "set PI_INTEGRATION=1 and PI_MODEL to run",
}, () => {
  const model = process.env.PI_MODEL || "example/pi-model-fast";
  const adapter = getAdapter("pi");
  assert.equal(adapter.capabilities({ phase: ADAPTER_PHASES.DISPATCH }).supported, true);
  assert.equal(adapter.probe({ env: process.env, timeoutMs: 10_000 }).status, "available");

  const probe = spawnSync(process.execPath, [
    PROBE_SCRIPT, ROOT, "--executor", "pi", "--model", model, "--json",
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    env: process.env,
    timeout: 120_000,
  });
  assert.equal(probe.status, 0, probe.stderr);
  const output = JSON.parse(probe.stdout);
  assert.equal(output.executor, "pi");
  assert.equal(output.model, model);
  assert.equal(output.agent_probe_error, null);
  assert.equal(Object.hasOwn(output, "policy_decision"), false);
});
