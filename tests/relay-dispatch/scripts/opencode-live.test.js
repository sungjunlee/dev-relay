const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ADAPTER_PHASES, getAdapter } = require("../../../skills/relay-dispatch/scripts/adapters");

const ROOT = path.join(__dirname, "..", "..", "..");
const DISPATCH_SCRIPT = path.join(ROOT, "skills", "relay-dispatch", "scripts", "dispatch.js");

test("opencode live canary is opt-in and uses explicit adapter/model selection", {
  skip: process.env.OPENCODE_INTEGRATION === "1" ? false : "set OPENCODE_INTEGRATION=1 and OPENCODE_MODEL to run",
}, () => {
  const model = process.env.OPENCODE_MODEL || "example/opencode-model-fast";
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-opencode-live-"));
  const adapter = getAdapter("opencode");
  assert.equal(adapter.capabilities({ phase: ADAPTER_PHASES.DISPATCH }).supported, true);
  assert.equal(adapter.probe({ env: process.env, timeoutMs: 10_000 }).status, "available");
  const rubricPath = path.join(relayHome, "rubric.yaml");
  fs.writeFileSync(rubricPath, "size: S\nrubric:\n  factors: []\n", "utf8");

  const dryRun = spawnSync(process.execPath, [
    DISPATCH_SCRIPT, ROOT,
    "-b", `opencode-live-canary-${Date.now()}`,
    "-p", "OpenCode explicit adapter/model canary dry-run",
    "--executor", "opencode",
    "--model", model,
    "--rubric-file", rubricPath,
    "--dry-run",
    "--json",
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome },
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const output = JSON.parse(dryRun.stdout);
  assert.equal(output.executor, "opencode");
  assert.equal(output.effective_dispatch_model, model);
  assert.equal(output.provider, model.split("/")[0]);
  assert.equal(Object.hasOwn(output, "route_plan"), false);
});
