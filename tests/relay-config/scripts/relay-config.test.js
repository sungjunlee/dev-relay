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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function legacyPolicy(overrides = {}) {
  return {
    version: 1,
    profile: "test",
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    managed_cli: ["codex", "claude"],
    allowed_model_routes: [],
    denied_model_routes: [],
    routing_rules: [],
    deny_unknown_model_routes: true,
    ...overrides,
  };
}

function writeFakeOpencode(binDir, models = []) {
  const opencodePath = path.join(binDir, "opencode");
  fs.writeFileSync(opencodePath, `#!/bin/sh
if [ "$1" = "models" ]; then
  cat <<'EOF'
${models.join("\n")}
EOF
  exit 0
fi
if [ "$1" = "--version" ]; then
  printf 'opencode-fake\\n'
  exit 0
fi
exit 0
`, "utf-8");
  fs.chmodSync(opencodePath, 0o755);
}

function writeFakeCli(binDir, name) {
  const cliPath = path.join(binDir, name);
  fs.writeFileSync(cliPath, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '${name}-fake\\n'
  exit 0
fi
exit 0
`, "utf-8");
  fs.chmodSync(cliPath, 0o755);
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

test("resolve-model passes through wrapper and resolves live short model names", () => {
  const relayHome = tempDir();
  const binDir = tempDir("relay-config-model-bin-");
  writeFakeOpencode(binDir, ["opencode-go/glm-5.2", "openai/gpt-5.3-codex-spark"]);
  assert.equal(runConfig([
    "add-route",
    "opencode-go/*",
    "--phase",
    "review",
    "--reviewer",
    "opencode",
    "--json",
  ], { relayHome }).status, 0);

  const result = runConfig([
    "resolve-model",
    "--phase",
    "review",
    "--reviewer",
    "opencode",
    "--model",
    "glm-5.2",
    "--json",
  ], {
    relayHome,
    env: {
      PATH: `${binDir}${path.delimiter}/usr/bin:/bin`,
      RELAY_CONFIG_MODEL_PROBE_TIMEOUT_MS: "1000",
    },
  });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.resolved_route, "opencode-go/glm-5.2");
  assert.equal(output.source, "live_probe");
  assert.equal(output.policy_decision.reason, "allowed_model_route");
});

test("catalog-report passes through wrapper", () => {
  const result = runConfig(["catalog-report", "--json"]);

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.ok(output.catalog.summary.total > 0);
  assert.equal(output.catalog.summary.total, output.catalog.entries.length);
});

test("preset add resolves compact actor short-model and stores explicit route provenance", () => {
  const relayHome = tempDir();
  const binDir = tempDir("relay-config-preset-model-bin-");
  writeFakeOpencode(binDir, ["opencode-go/glm-5.2"]);

  const result = runConfig([
    "preset",
    "add",
    "light",
    "--dispatch",
    "opencode:glm-5.2",
    "--json",
  ], {
    relayHome,
    env: {
      PATH: `${binDir}${path.delimiter}/usr/bin:/bin`,
      RELAY_CONFIG_MODEL_PROBE_TIMEOUT_MS: "1000",
    },
  });

  assert.equal(result.status, 0, result.combined);
  const routes = readRoutes(relayHome);
  assert.deepEqual(routes.presets.light.dispatch, {
    executor: "opencode",
    model: "opencode-go/glm-5.2",
  });
  assert.equal(routes.presets.light.model_resolution.dispatch.original_input, "opencode:glm-5.2");
  assert.equal(routes.presets.light.model_resolution.dispatch.resolved_route, "opencode-go/glm-5.2");
  assert.equal(routes.presets.light.model_resolution.dispatch.source, "live_probe");

  const output = parseJson(result);
  assert.equal(output.preset.model_resolution.dispatch.original_input, "opencode:glm-5.2");
});

test("preset add resolves cline short model through catalog fallback in open mode", () => {
  const relayHome = tempDir();

  const result = runConfig([
    "preset",
    "add",
    "diverse",
    "--advisory-review",
    "cline:glm-5.2",
    "--advisory-profile",
    "blindspot",
    "--json",
  ], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const routes = readRoutes(relayHome);
  assert.deepEqual(routes.presets.diverse.advisory_review, {
    reviewer: "cline",
    model: "cline-pass/glm-5.2",
    profile: "blindspot",
  });
  const metadata = routes.presets.diverse.model_resolution.advisory_review;
  assert.equal(metadata.original_input, "cline:glm-5.2");
  assert.equal(metadata.source, "catalog_fallback");
  assert.match(metadata.warnings.join("\n"), /catalog fallback/i);
});

test("strict preset add rejects unresolved unregistered compact routes", () => {
  const relayHome = tempDir();
  const binDir = tempDir("relay-config-preset-strict-bin-");
  writeFakeOpencode(binDir, ["opencode-go/glm-5.2"]);
  assert.equal(runConfig(["init", "company", "--json"], { relayHome }).status, 0);

  const result = runConfig([
    "preset",
    "add",
    "light",
    "--dispatch",
    "opencode:glm-5.2",
    "--json",
  ], {
    relayHome,
    env: {
      PATH: `${binDir}${path.delimiter}/usr/bin:/bin`,
      RELAY_CONFIG_MODEL_PROBE_TIMEOUT_MS: "1000",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.combined, /unknown_model_route|unregistered/i);
  const output = JSON.parse(result.stdout);
  assert.equal(output.resolution.error, "unknown_model_route");
  assert.equal(output.resolution.resolved_route, "opencode-go/glm-5.2");
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

test("migrate keeps project scoped legacy policy out of global routes and converts project v1 in place", () => {
  const relayHome = tempDir();
  const projectRoutesPath = parseJson(runConfig(["inspect", "--json"], { relayHome })).projectConfig.path.replace(/project\.json$/, "routes.json");
  writeJson(path.join(relayHome, "policy.json"), legacyPolicy({
    allowed_model_routes: [
      { route: "*", phases: ["dispatch"], executors: ["opencode"] },
      { route: "global/*", phases: ["dispatch"], executors: ["codex"] },
    ],
  }));
  writeJson(projectRoutesPath.replace(/routes\.json$/, "policy.json"), legacyPolicy({
    defaults: {
      dispatch: { executor: "opencode" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    allowed_model_routes: [
      { route: "project/*", phases: ["dispatch"], executors: ["opencode"] },
    ],
  }));
  writeJson(projectRoutesPath, {
    version: 1,
    defaults: {
      dispatch: { executor: "opencode", model: "project/model" },
    },
  });

  const result = runConfig(["migrate", "--yes", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const globalRoutes = readRoutes(relayHome);
  assert.equal(globalRoutes.defaults.dispatch.executor, "codex");
  assert.equal(globalRoutes.routes.some((route) => route.route === "project/*"), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(projectRoutesPath, "utf-8")), {
    version: 2,
    defaults: {
      dispatch: { executor: "opencode", model: "project/model" },
    },
  });
});

test("migrate preserves narrowed managed_cli so model-less claude stays denied", () => {
  const relayHome = tempDir();
  writeJson(path.join(relayHome, "policy.json"), legacyPolicy({
    managed_cli: ["codex"],
  }));

  const before = runConfig(["check", "review", "claude", "--json"], { relayHome });
  assert.notEqual(before.status, 0);
  assert.equal(JSON.parse(before.stdout).decision.reason, "missing_model_route");

  const migrate = runConfig(["migrate", "--yes", "--json"], { relayHome });
  assert.equal(migrate.status, 0, migrate.combined);
  assert.deepEqual(readRoutes(relayHome).managed_cli, ["codex"]);

  const after = runConfig(["check", "review", "claude", "--json"], { relayHome });
  assert.notEqual(after.status, 0);
  assert.equal(JSON.parse(after.stdout).decision.reason, "missing_model_route");
});

test("gaps reports installed strict default executor with no usable route", () => {
  const relayHome = tempDir();
  const binDir = tempDir("relay-config-pi-bin-");
  writeFakeCli(binDir, "pi");
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: true,
    defaults: {
      dispatch: { executor: "pi" },
    },
  });

  const result = runConfig(["gaps", "--json"], {
    relayHome,
    env: { PATH: `${binDir}${path.delimiter}/usr/bin:/bin` },
  });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  const gap = output.gaps.find((item) => item.actor === "pi" && item.phase === "dispatch");
  assert.ok(gap, JSON.stringify(output.gaps, null, 2));
  assert.match(gap.type, /installed_cli_unrouted|executor_missing_default_model/);
  assert.ok(["add-route", "set-default"].includes(gap.proposal.subcommand), JSON.stringify(gap.proposal));
  assert.ok(gap.proposal.args.length > 1);
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
