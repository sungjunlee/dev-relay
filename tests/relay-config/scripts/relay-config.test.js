const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  validateRelayPolicy,
} = require("../../../skills/relay-dispatch/scripts/relay-policy");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "skills", "relay-config", "scripts", "relay-config.js");

function tempDir(prefix = "relay-config-wrapper-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function envFor(relayHome, extra = {}) {
  const env = {
    ...process.env,
    ...extra,
    RELAY_HOME: relayHome,
  };
  if (!Object.prototype.hasOwnProperty.call(extra, "RELAY_POLICY_PATH")) {
    delete env.RELAY_POLICY_PATH;
  }
  if (!Object.prototype.hasOwnProperty.call(extra, "RELAY_EXECUTORS_PATH")) {
    delete env.RELAY_EXECUTORS_PATH;
  }
  return env;
}

function runConfig(args, { relayHome = tempDir(), cwd = REPO_ROOT, env = {} } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: envFor(relayHome, env),
    encoding: "utf-8",
  });
  return {
    ...result,
    relayHome,
    combined: `${result.stdout}\n${result.stderr}`,
  };
}

function parseJson(result) {
  assert.equal(result.stderr, "", result.stderr);
  return JSON.parse(result.stdout);
}

function readPolicy(relayHome) {
  const policyPath = path.join(relayHome, "policy.json");
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf-8"));
  return validateRelayPolicy(policy, policyPath);
}

test("init company shorthand delegates to core init --profile company", () => {
  const relayHome = tempDir();

  const result = runConfig(["init", "company", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  assert.equal(parseJson(result).profile, "company");
  const policy = readPolicy(relayHome);
  assert.equal(policy.profile, "company");
  assert.deepEqual(policy.managed_cli, ["codex", "claude"]);
  assert.equal(Object.prototype.hasOwnProperty.call(policy.defaults.dispatch, "model"), false);
});

test("show shorthand adds --effective", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "personal", "--json"], { relayHome }).status, 0);

  const result = runConfig(["show", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.equal(output.status, "ok");
  assert.equal(output.policy.profile, "personal");
});

test("check shorthand maps reviewer phases to reviewer and executor scopes", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "company", "--json"], { relayHome }).status, 0);
  assert.equal(runConfig([
    "allow-route",
    "example/opencode-model-*",
    "--phase",
    "dispatch,advisory_review",
    "--executor",
    "opencode",
    "--json",
  ], { relayHome }).status, 0);

  const result = runConfig([
    "check",
    "advisory_review",
    "opencode",
    "example/opencode-model-fast",
    "--json",
  ], { relayHome });

  assert.equal(result.status, 0, result.combined);
  assert.equal(parseJson(result).decision.reason, "allowed_model_route");
});

test("inspect reports effective policy, doctor output, and executors config state", () => {
  const relayHome = tempDir();
  const executorsPath = path.join(relayHome, "executors.json");
  fs.writeFileSync(executorsPath, "{\"executors\":{}}\n", "utf-8");

  const result = runConfig(["inspect", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.equal(output.policy.status, "defaulted");
  assert.equal(output.executorsConfig.path, executorsPath);
  assert.equal(output.executorsConfig.exists, true);
  assert.equal(output.projectConfig.status, "absent");
  assert.match(output.projectConfig.path, /\/projects\/dev-relay-[a-f0-9]{8}\/project\.json$/);
  assert.ok(output.doctor.tools.some((tool) => tool.name === "codex"));
});

test("help advertises natural-language setup and provider/model boundary", () => {
  const result = runConfig(["--help"]);

  assert.equal(result.status, 0, result.combined);
  assert.match(result.stdout, /relay setup 해줘/);
  assert.match(result.stdout, /provider\/model route strings are the compliance boundary/i);
});

test("inspect rejects unsupported arguments instead of ignoring them", () => {
  const flag = runConfig(["inspect", "--bogus"]);

  assert.notEqual(flag.status, 0, flag.combined);
  assert.match(flag.combined, /unsupported arguments for inspect: --bogus/);

  const positional = runConfig(["inspect", "extra"]);
  assert.notEqual(positional.status, 0, positional.combined);
  assert.match(positional.combined, /unsupported arguments for inspect: extra/);
});
