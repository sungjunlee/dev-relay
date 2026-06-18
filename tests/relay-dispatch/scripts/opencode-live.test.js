const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const DISPATCH_SCRIPT = path.join(ROOT, "skills", "relay-dispatch", "scripts", "dispatch.js");
const RELAY_CONFIG_SCRIPT = path.join(ROOT, "skills", "relay-config", "scripts", "relay-config.js");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

test("opencode live route canary is opt-in and uses run route intent", {
  skip: process.env.OPENCODE_INTEGRATION === "1" ? false : "set OPENCODE_INTEGRATION=1 and OPENCODE_MODEL to run",
}, () => {
  const model = process.env.OPENCODE_MODEL || "example/opencode-model-fast";
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-opencode-live-"));
  writeJson(path.join(relayHome, "policy.json"), {
    version: 1,
    profile: "opencode-live-canary",
    managed_cli: ["codex", "claude"],
    allowed_model_routes: [{ route: model, phases: ["dispatch"], executors: ["opencode"] }],
    denied_model_routes: [],
    routing_rules: [],
    deny_unknown_model_routes: true,
  });
  const intentPath = path.join(relayHome, "opencode-route-intent.json");
  writeJson(intentPath, { dispatch: { executor: "opencode", model }, review: { reviewer: "codex" } });

  const plan = spawnSync(process.execPath, [
    RELAY_CONFIG_SCRIPT, "plan-run", "--repo", ROOT, "--route-intent-file", intentPath, "--json",
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome },
  });
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).route_plan.phases.dispatch.policy_decision.allowed, true);

  const dryRun = spawnSync(process.execPath, [
    DISPATCH_SCRIPT, ROOT,
    "-b", `opencode-live-route-${Date.now()}`,
    "-p", "OpenCode live route canary dry-run",
    "--route-intent-file", intentPath,
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
  assert.equal(output.route_plan.phases.dispatch.model, model);
});
