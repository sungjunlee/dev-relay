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
const SCRIPT = path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "relay-config.js");

function tempDir(prefix = "relay-config-") {
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

function writeExecutable(filePath, body = "#!/bin/sh\nexit 0\n") {
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
}

test("init --profile company writes a company-safe global policy", () => {
  const relayHome = tempDir();

  const result = runConfig(["init", "--profile", "company", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.equal(output.profile, "company");
  assert.equal(output.path, path.join(relayHome, "policy.json"));

  const policy = readPolicy(relayHome);
  assert.equal(policy.profile, "company");
  assert.deepEqual(policy.defaults, {
    dispatch: { executor: "codex" },
    review: { reviewer: "codex" },
    advisory_review: null,
    sidecar: null,
  });
  assert.deepEqual(policy.managed_cli, ["codex", "claude"]);
  assert.deepEqual(policy.allowed_model_routes, []);
  assert.deepEqual(policy.denied_model_routes, []);
  assert.equal(policy.deny_unknown_model_routes, true);
  assert.equal(Object.prototype.hasOwnProperty.call(policy.defaults.dispatch, "model"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(policy.defaults.review, "model"), false);
});

test("init --profile personal remains explicit and does not add OpenCode or Pi routes", () => {
  const relayHome = tempDir();

  const result = runConfig(["init", "--profile", "personal", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const policy = readPolicy(relayHome);
  assert.equal(policy.profile, "personal");
  assert.deepEqual(policy.managed_cli, ["codex", "claude"]);
  assert.deepEqual(policy.allowed_model_routes, []);
  assert.deepEqual(policy.denied_model_routes, []);
  assert.equal(policy.deny_unknown_model_routes, true);
});

test("show --effective emits deterministic JSON for the loaded effective policy", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "--profile", "company", "--json"], { relayHome }).status, 0);

  const result = runConfig(["show", "--effective", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.equal(output.status, "ok");
  assert.equal(output.sources.global, path.join(relayHome, "policy.json"));
  assert.equal(output.policy.profile, "company");
});

test("doctor uses local PATH only and labels installed disallowed harnesses as policy-disallowed", () => {
  const relayHome = tempDir();
  const binDir = tempDir("relay-config-bin-");
  writeExecutable(path.join(binDir, "opencode"));
  assert.equal(runConfig(["init", "--profile", "company", "--json"], { relayHome }).status, 0);

  const result = runConfig(["doctor", "--json"], {
    relayHome,
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` },
  });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  const opencode = output.tools.find((tool) => tool.name === "opencode");
  assert.deepEqual(
    {
      installed: opencode.installed,
      policy: opencode.policy,
      reason: opencode.reason,
    },
    {
      installed: true,
      policy: "policy-disallowed",
      reason: "missing_model_route",
    }
  );
});

test("check exits zero for allowed managed CLI routes and reports the decision reason", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "--profile", "company", "--json"], { relayHome }).status, 0);

  const result = runConfig(["check", "--phase", "dispatch", "--executor", "codex", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.equal(output.decision.allowed, true);
  assert.equal(output.decision.reason, "managed_cli");
});

test("check exits non-zero for missing and unknown OpenCode/Pi provider routes", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "--profile", "company", "--json"], { relayHome }).status, 0);

  const missing = runConfig(["check", "--phase", "dispatch", "--executor", "opencode", "--json"], { relayHome });
  assert.notEqual(missing.status, 0, missing.combined);
  assert.equal(parseJson(missing).decision.reason, "missing_model_route");

  const unknown = runConfig([
    "check",
    "--phase",
    "dispatch",
    "--executor",
    "opencode",
    "--model",
    "example/opencode-model-fast",
    "--json",
  ], { relayHome });
  assert.notEqual(unknown.status, 0, unknown.combined);
  assert.equal(parseJson(unknown).decision.reason, "unknown_model_route");
});

test("set-default mutates supported default actor paths and preserves v1 policy shape", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "--profile", "company", "--json"], { relayHome }).status, 0);

  const sidecar = runConfig(["set-default", "sidecar.executor", "opencode", "--json"], { relayHome });
  assert.equal(sidecar.status, 0, sidecar.combined);
  const advisory = runConfig(["set-default", "advisory_review.reviewer", "claude", "--json"], { relayHome });
  assert.equal(advisory.status, 0, advisory.combined);

  const policy = readPolicy(relayHome);
  assert.deepEqual(policy.defaults.sidecar, { executor: "opencode" });
  assert.deepEqual(policy.defaults.advisory_review, { reviewer: "claude" });
});

test("allow-route maps mixed executor phases to executors and reviewer phases to reviewers", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "--profile", "company", "--json"], { relayHome }).status, 0);

  const mutation = runConfig([
    "allow-route",
    "example/opencode-model-*",
    "--executor",
    "opencode",
    "--phase",
    "sidecar,advisory_review,dispatch",
    "--json",
  ], { relayHome });
  assert.equal(mutation.status, 0, mutation.combined);

  const [entry] = readPolicy(relayHome).allowed_model_routes;
  assert.equal(entry.route, "example/opencode-model-*");
  assert.deepEqual(new Set(entry.phases), new Set(["sidecar", "advisory_review", "dispatch"]));
  assert.deepEqual(entry.executors, ["opencode"]);
  assert.deepEqual(entry.reviewers, ["opencode"]);

  const dispatch = runConfig([
    "check",
    "--phase",
    "dispatch",
    "--executor",
    "opencode",
    "--model",
    "example/opencode-model-fast",
    "--json",
  ], { relayHome });
  assert.equal(dispatch.status, 0, dispatch.combined);
  assert.equal(parseJson(dispatch).decision.reason, "allowed_model_route");

  const advisory = runConfig([
    "check",
    "--phase",
    "advisory_review",
    "--executor",
    "opencode",
    "--reviewer",
    "opencode",
    "--model",
    "example/opencode-model-fast",
    "--json",
  ], { relayHome });
  assert.equal(advisory.status, 0, advisory.combined);
  assert.equal(parseJson(advisory).decision.reason, "allowed_model_route");
});

test("deny-route preserves route scopes and denied routes win during check", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "--profile", "company", "--json"], { relayHome }).status, 0);
  assert.equal(runConfig([
    "allow-route",
    "example/opencode-model-*",
    "--executor",
    "opencode",
    "--phase",
    "dispatch",
    "--json",
  ], { relayHome }).status, 0);

  const mutation = runConfig([
    "deny-route",
    "example/opencode-model-bad",
    "--executor",
    "opencode",
    "--phase",
    "dispatch",
    "--json",
  ], { relayHome });
  assert.equal(mutation.status, 0, mutation.combined);

  const [entry] = readPolicy(relayHome).denied_model_routes;
  assert.deepEqual(entry, {
    route: "example/opencode-model-bad",
    phases: ["dispatch"],
    executors: ["opencode"],
  });

  const denied = runConfig([
    "check",
    "--phase",
    "dispatch",
    "--executor",
    "opencode",
    "--model",
    "example/opencode-model-bad",
    "--json",
  ], { relayHome });
  assert.notEqual(denied.status, 0, denied.combined);
  assert.equal(parseJson(denied).decision.reason, "denied_model_route");
});

test("invalid args fail closed with non-zero exits", () => {
  const relayHome = tempDir();

  const unknown = runConfig(["init", "--profile", "company", "--bogus"], { relayHome });
  assert.notEqual(unknown.status, 0, unknown.combined);
  assert.match(unknown.combined, /unknown flag.*--bogus/i);

  const profile = runConfig(["init", "--profile", "enterprise"], { relayHome });
  assert.notEqual(profile.status, 0, profile.combined);
  assert.match(profile.combined, /--profile must be one of: company, personal/);

  const pathResult = runConfig(["set-default", "dispatch.model", "openai/gpt-5"], { relayHome });
  assert.notEqual(pathResult.status, 0, pathResult.combined);
  assert.match(pathResult.combined, /unsupported default path: dispatch\.model/);
});

test("subcommands reject known relay-config flags outside their supported grammar", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "--profile", "company", "--json"], { relayHome }).status, 0);

  const init = runConfig(["init", "--profile", "company", "--model", "foo"], { relayHome });
  assert.notEqual(init.status, 0, init.combined);
  assert.match(init.combined, /unsupported flags for init: --model/);

  const doctor = runConfig(["doctor", "--profile", "company"], { relayHome });
  assert.notEqual(doctor.status, 0, doctor.combined);
  assert.match(doctor.combined, /unsupported flags for doctor: --profile/);

  const show = runConfig(["show", "--effective", "--executor", "codex"], { relayHome });
  assert.notEqual(show.status, 0, show.combined);
  assert.match(show.combined, /unsupported flags for show: --executor/);
});

test("help explains harness actors and provider/model route boundaries", () => {
  const result = runConfig(["--help"]);

  assert.equal(result.status, 0, result.combined);
  assert.match(result.stdout, /executor\/reviewer names are harnesses/i);
  assert.match(result.stdout, /provider\/model route strings are the policy boundary/i);
});
