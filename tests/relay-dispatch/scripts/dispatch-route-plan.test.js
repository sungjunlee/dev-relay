const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readManifest, writeManifest } = require("../../../skills/relay-dispatch/scripts/manifest/store");
const { getProjectPolicyPath, getProjectRoutesPath } = require("../../../skills/relay-dispatch/scripts/manifest/paths");
const { buildDefaultRelayPolicy } = require("../../../skills/relay-dispatch/scripts/relay-policy");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "dispatch.js");

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-route-plan-"));
  const repoRoot = path.join(root, "repo");
  const relayHome = path.join(root, "relay-home");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(relayHome, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Route Plan"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-route@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
  const rubricFile = path.join(root, "rubric.yaml");
  fs.writeFileSync(rubricFile, "rubric:\n  factors:\n    - name: route plan\n      target: pass\n", "utf-8");
  return { root, repoRoot, relayHome, rubricFile };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writePolicy(relayHome, overrides = {}) {
  writeJson(path.join(relayHome, "policy.json"), {
    ...buildDefaultRelayPolicy(),
    ...overrides,
  });
}

function writeFakeCodex(binDir) {
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
const output = args[args.indexOf("-o") + 1];
fs.writeFileSync(output, "route plan ok\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
}

function writeFakePi(binDir) {
  const piPath = path.join(binDir, "pi");
  fs.writeFileSync(piPath, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("pi-fake\\n");
  process.exit(0);
}
process.stdout.write("pi route plan ok\\n");
`, "utf-8");
  fs.chmodSync(piPath, 0o755);
}

test("dispatch dry-run consumes route intent and previews route plan", () => {
  const { root, repoRoot, relayHome, rubricFile } = setupRepo();
  writePolicy(relayHome, {
    profile: "allow-pi",
    allowed_model_routes: [{ route: "example/pi-*", phases: ["dispatch"], executors: ["pi"] }],
  });
  const intentPath = path.join(root, "route-intent.json");
  writeJson(intentPath, {
    dispatch: { executor: "pi", model: "example/pi-model-fast" },
    review: { reviewer: "codex" },
  });

  const proc = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-route-plan-dry",
    "-p", "dry route plan",
    "--rubric-file", rubricFile,
    "--route-intent-file", intentPath,
    "--dry-run",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome },
  });

  assert.equal(proc.status, 0, proc.stderr);
  const output = JSON.parse(proc.stdout);
  assert.equal(output.executor, "pi");
  assert.equal(output.route_plan.phases.dispatch.executor, "pi");
  assert.equal(output.route_plan.phases.dispatch.model, "example/pi-model-fast");
  assert.equal(output.route_plan.phases.dispatch.policy_decision.reason, "allowed_model_route");
});

test("dispatch denied route intent fails before executor invocation", () => {
  const { root, repoRoot, relayHome, rubricFile } = setupRepo();
  writePolicy(relayHome, {
    profile: "strict-deny-unknown",
    deny_unknown_model_routes: true,
  });
  const intentPath = path.join(root, "route-intent-denied.json");
  writeJson(intentPath, {
    dispatch: { executor: "pi", model: "example/pi-model-fast" },
  });

  const proc = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-route-plan-denied",
    "-p", "denied route plan",
    "--rubric-file", rubricFile,
    "--route-intent-file", intentPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome },
  });

  assert.notEqual(proc.status, 0);
  const output = JSON.parse(proc.stdout);
  assert.equal(output.policy_decision.reason, "unknown_model_route");
  assert.equal(output.route_plan.phases.dispatch.executor, "pi");
});

test("dispatch emits unregistered route event for open-mode unmanaged model route", () => {
  const { repoRoot, relayHome, rubricFile } = setupRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-route-open-bin-"));
  writeFakePi(binDir);

  const proc = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-open-unregistered",
    "-p", "open route plan",
    "--rubric-file", rubricFile,
    "--executor", "pi",
    "--model", "openai/unregistered",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` },
  });

  assert.equal(proc.status, 0, proc.stderr);
  const output = JSON.parse(proc.stdout);
  const events = fs.readFileSync(path.join(output.runDir, "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const routeResolution = events.find((event) => event.event === "route_resolution");
  assert.equal(routeResolution.policy_decision.reason, "unknown_allowed");
  const unregistered = events.find((event) => event.event === "unregistered_route_used");
  assert.equal(unregistered.phase, "dispatch");
  assert.equal(unregistered.actor_field, "executor");
  assert.equal(unregistered.executor, "pi");
  assert.equal(unregistered.model, "openai/unregistered");
});

test("dispatch does not emit unregistered route event for registered route", () => {
  const { repoRoot, relayHome, rubricFile } = setupRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-route-registered-bin-"));
  writeFakePi(binDir);
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: false,
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    routes: [
      { route: "openai/registered", phases: ["dispatch"], executors: ["pi"] },
    ],
    denied_routes: [],
    presets: {},
  });

  const proc = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-registered-route",
    "-p", "registered route plan",
    "--rubric-file", rubricFile,
    "--executor", "pi",
    "--model", "openai/registered",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` },
  });

  assert.equal(proc.status, 0, proc.stderr);
  const output = JSON.parse(proc.stdout);
  const events = fs.readFileSync(path.join(output.runDir, "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const routeResolution = events.find((event) => event.event === "route_resolution");
  assert.equal(routeResolution.policy_decision.reason, "allowed_model_route");
  assert.equal(events.some((event) => event.event === "unregistered_route_used"), false);
});

test("dispatch project policy deny overrides personal route before unmanaged CLI invocation", () => {
  const { root, repoRoot, relayHome, rubricFile } = setupRepo();
  writePolicy(relayHome, {
    profile: "personal-allow-opencode",
    allowed_model_routes: [
      { route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] },
    ],
  });
  writeJson(getProjectPolicyPath(repoRoot, { relayHome }), {
    ...buildDefaultRelayPolicy(),
    version: 1,
    profile: "company-deny-personal-opencode",
    denied_model_routes: [
      { route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] },
    ],
  });
  const intentPath = path.join(root, "route-intent-company-denied.json");
  writeJson(intentPath, {
    dispatch: { executor: "opencode", model: "example/opencode-model-fast" },
  });
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "relay-route-deny-bin-"));
  fs.writeFileSync(path.join(fakeBin, "opencode"), "#!/bin/sh\necho unmanaged CLI should not run >&2\nexit 42\n", "utf-8");
  fs.chmodSync(path.join(fakeBin, "opencode"), 0o755);

  const proc = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-company-deny",
    "-p", "company deny route plan",
    "--rubric-file", rubricFile,
    "--route-intent-file", intentPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome, PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}` },
  });

  assert.notEqual(proc.status, 0);
  assert.doesNotMatch(proc.stderr, /unmanaged CLI should not run/);
  const output = JSON.parse(proc.stdout);
  assert.equal(output.policy_decision.reason, "denied_model_route");
  assert.equal(output.route_plan.phases.dispatch.policy_decision.reason, "denied_model_route");
  assert.equal(output.route_plan.phases.dispatch.sources.model, "run_intent");
});

test("dispatch resume resolves project routes from manifest repo, not invocation cwd", () => {
  const { root, repoRoot, relayHome, rubricFile } = setupRepo();
  writePolicy(relayHome, {
    profile: "allow-pi-but-target-defaults-codex",
    allowed_model_routes: [{ route: "example/pi-*", phases: ["dispatch"], executors: ["pi"] }],
  });
  writeJson(getProjectRoutesPath(repoRoot, { relayHome }), {
    version: 1,
    defaults: { dispatch: { executor: "codex" }, review: { reviewer: "codex" } },
  });
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-route-resume-bin-"));
  writeFakeCodex(binDir);

  const first = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-route-plan-resume",
    "-p", "initial route plan",
    "--rubric-file", rubricFile,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` },
  });
  assert.equal(first.status, 0, first.stderr);
  const firstOutput = JSON.parse(first.stdout);

  const manifestRecord = readManifest(firstOutput.manifestPath);
  writeManifest(firstOutput.manifestPath, {
    ...manifestRecord.data,
    state: "changes_requested",
    next_action: "redispatch",
  }, manifestRecord.body);

  const unrelatedRepo = path.join(root, "unrelated");
  fs.mkdirSync(unrelatedRepo, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: unrelatedRepo, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Route Other"], { cwd: unrelatedRepo, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-route-other@example.com"], { cwd: unrelatedRepo, stdio: "pipe" });
  fs.writeFileSync(path.join(unrelatedRepo, "README.md"), "other\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: unrelatedRepo, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: unrelatedRepo, stdio: "pipe" });
  writeJson(getProjectRoutesPath(unrelatedRepo, { relayHome }), {
    version: 1,
    defaults: {
      dispatch: { executor: "pi", model: "example/pi-model-fast" },
      review: { reviewer: "codex" },
    },
  });

  const resumed = spawnSync(process.execPath, [
    SCRIPT,
    "--manifest", firstOutput.manifestPath,
    "-p", "resume route plan",
    "--dry-run",
    "--json",
  ], {
    cwd: unrelatedRepo,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome },
  });

  assert.equal(resumed.status, 0, resumed.stderr);
  const output = JSON.parse(resumed.stdout);
  assert.equal(output.executor, "codex");
  assert.equal(output.route_plan.phases.dispatch.executor, "codex");
  assert.equal(output.route_plan.project_routes.path, getProjectRoutesPath(repoRoot, { relayHome }));
});

test("dispatch writes route-plan snapshot, manifest summary, and route event", () => {
  const { repoRoot, relayHome, rubricFile } = setupRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-route-plan-bin-"));
  writeFakeCodex(binDir);
  writeJson(getProjectRoutesPath(repoRoot, { relayHome }), {
    version: 1,
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
    },
  });

  const proc = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-route-plan-real",
    "-p", "real route plan",
    "--rubric-file", rubricFile,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` },
  });

  assert.equal(proc.status, 0, proc.stderr);
  const output = JSON.parse(proc.stdout);
  assert.equal(fs.existsSync(output.routePlanPath), true);
  const snapshot = JSON.parse(fs.readFileSync(output.routePlanPath, "utf-8"));
  assert.equal(snapshot.phases.dispatch.executor, "codex");
  assert.equal(snapshot.project_routes.status, "ok");

  const manifest = readManifest(output.manifestPath).data;
  assert.equal(manifest.routes.plan_path, "route-plan.json");
  assert.equal(manifest.routes.summary.dispatch.actor, "codex");

  const events = fs.readFileSync(path.join(output.runDir, "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const routeEvent = events.find((event) => event.event === "route_resolution");
  assert.equal(routeEvent.route_plan_path, output.routePlanPath);
  assert.equal(routeEvent.policy_decision.reason, "managed_cli");
});
