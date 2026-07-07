const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "skills", "relay-config", "scripts", "relay-config.js");

function tempDir(prefix = "relay-config-wrapper-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function envFor(relayHome, extra = {}) {
  const env = {
    ...process.env,
    PATH: "/usr/bin:/bin",
    RELAY_CONFIG_MODEL_PROBE_TIMEOUT_MS: "50",
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

function readRoutes(relayHome) {
  return JSON.parse(fs.readFileSync(path.join(relayHome, "routes.json"), "utf-8"));
}

test("init company shorthand delegates to core init --profile company routes config", () => {
  const relayHome = tempDir();

  const result = runConfig(["init", "company", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  assert.equal(parseJson(result).profile, "company");
  assert.deepEqual(readRoutes(relayHome), {
    version: 2,
    strict: true,
    routes: [],
    denied_routes: [],
  });
  assert.equal(fs.existsSync(path.join(relayHome, "policy.json")), false);
});

test("show shorthand adds --effective", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "personal", "--json"], { relayHome }).status, 0);

  const result = runConfig(["show", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.equal(output.status, "ok");
  assert.equal(output.policy.profile, "routes-config");
  assert.equal(output.policy.deny_unknown_model_routes, false);
});

test("check shorthand maps reviewer phases to reviewer-only core checks", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "company", "--json"], { relayHome }).status, 0);
  assert.equal(runConfig([
    "add-route",
    "example/opencode-model-*",
    "--phase",
    "advisory_review",
    "--reviewer",
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

test("preset subcommands pass through wrapper shorthand", () => {
  const relayHome = tempDir();

  const add = runConfig([
    "preset",
    "add",
    "hardened",
    "--review-assurance",
    "hardened",
    "--json",
  ], { relayHome });
  assert.equal(add.status, 0, add.combined);
  assert.deepEqual(readRoutes(relayHome), {
    version: 2,
    presets: {
      hardened: { review_assurance: "hardened" },
    },
  });

  const show = runConfig(["preset", "show", "hardened", "--json"], { relayHome });
  assert.equal(show.status, 0, show.combined);
  assert.equal(parseJson(show).preset.review_assurance, "hardened");

  const remove = runConfig(["preset", "remove", "hardened", "--json"], { relayHome });
  assert.equal(remove.status, 0, remove.combined);
  assert.equal(Object.prototype.hasOwnProperty.call(readRoutes(relayHome), "presets"), false);
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

test("inspect human output describes routes without policy prose", () => {
  const relayHome = tempDir();

  const result = runConfig(["inspect"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  assert.match(result.stdout, /routes status:/i);
  assert.doesNotMatch(result.stdout.replace(/policy\.json/g, "legacy-file"), /\bpolicy\b/i);
});

test("help advertises natural-language setup and provider/model boundary", () => {
  const result = runConfig(["--help"]);

  assert.equal(result.status, 0, result.combined);
  assert.match(result.stdout, /relay setup 해줘/);
  assert.match(result.stdout, /provider\/model route strings are the routing boundary/i);
  assert.match(result.stdout, /add-route <pattern>/);
  assert.match(result.stdout, /preset add\|remove\|show/);
  assert.match(result.stdout, /allow-route <pattern>.*deprecated/i);
  assert.doesNotMatch(result.stdout, /\bpolicy\b/i);
});

test("inspect rejects unsupported arguments instead of ignoring them", () => {
  const flag = runConfig(["inspect", "--bogus"]);

  assert.notEqual(flag.status, 0, flag.combined);
  assert.match(flag.combined, /unsupported arguments for inspect: --bogus/);

  const positional = runConfig(["inspect", "extra"]);
  assert.notEqual(positional.status, 0, positional.combined);
  assert.match(positional.combined, /unsupported arguments for inspect: extra/);
});
