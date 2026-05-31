const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const PROBE_SCRIPT = path.join(ROOT, "skills", "relay-plan", "scripts", "probe-executor-env.js");
const RELAY_CONFIG_SCRIPT = path.join(ROOT, "skills", "relay-config", "scripts", "relay-config.js");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

test("pi live route canary is opt-in and distinguishes policy/probe state", {
  skip: process.env.PI_INTEGRATION === "1" ? false : "set PI_INTEGRATION=1 and PI_MODEL to run",
}, () => {
  const model = process.env.PI_MODEL || "deepseek/deepseek-v4-flash";
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pi-live-"));
  writeJson(path.join(relayHome, "policy.json"), {
    version: 1,
    profile: "pi-live-canary",
    managed_cli: ["codex", "claude"],
    allowed_model_routes: [{ route: model, phases: ["dispatch", "review"], executors: ["pi"], reviewers: ["pi"] }],
    denied_model_routes: [],
    routing_rules: [],
    deny_unknown_model_routes: true,
  });
  const intentPath = path.join(relayHome, "pi-route-intent.json");
  writeJson(intentPath, { dispatch: { executor: "pi", model }, review: { reviewer: "codex" } });

  const plan = spawnSync(process.execPath, [
    RELAY_CONFIG_SCRIPT, "plan-run", "--repo", ROOT, "--route-intent-file", intentPath, "--json",
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome },
  });
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).route_plan.phases.dispatch.policy_decision.allowed, true);

  const probe = spawnSync(process.execPath, [
    PROBE_SCRIPT, ROOT, "--executor", "pi", "--model", model, "--json",
  ], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome },
    timeout: 120_000,
  });
  assert.equal(probe.status, 0, probe.stderr);
  const output = JSON.parse(probe.stdout);
  assert.equal(output.policy_decision.allowed, true);
  assert.equal(output.policy_decision.model, model);
});
