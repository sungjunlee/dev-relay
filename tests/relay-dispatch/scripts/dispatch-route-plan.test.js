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

test("dispatch dry-run expands route preset below explicit flags and records preset sources", () => {
  const { repoRoot, relayHome, rubricFile } = setupRepo();
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: true,
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    routes: [
      { route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] },
      { route: "example/opencode-model-*", phases: ["dispatch"], executors: ["codex"] },
      { route: "example/pi-model-*", phases: ["advisory_review"], reviewers: ["pi"] },
    ],
    presets: {
      light: {
        dispatch: { executor: "opencode", model: "example/opencode-model-fast" },
        advisory_review: { reviewer: "pi", model: "example/pi-model-fast", profile: "blindspot" },
      },
    },
  });

  const proc = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-route-preset-dry",
    "-p", "dry preset route plan",
    "--rubric-file", rubricFile,
    "--route-preset", "light",
    "--executor", "codex",
    "--dry-run",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome },
  });

  assert.equal(proc.status, 0, proc.stderr);
  const output = JSON.parse(proc.stdout);
  assert.equal(output.executor, "codex");
  assert.equal(output.route_plan.phases.dispatch.executor, "codex");
  assert.equal(output.route_plan.phases.dispatch.sources.executor, "run_intent");
  assert.equal(output.route_plan.phases.dispatch.model, "example/opencode-model-fast");
  assert.equal(output.route_plan.phases.dispatch.sources.model, "preset:light");
  assert.equal(output.route_plan.phases.advisory_review.reviewer, "pi");
  assert.equal(output.route_plan.phases.advisory_review.sources.reviewer, "preset:light");
  assert.equal(output.route_plan.phases.advisory_review.profile, "blindspot");
});

test("dispatch unknown route preset fails before creating run side effects including fleet locks", () => {
  const { repoRoot, relayHome, rubricFile } = setupRepo();
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: false,
    presets: {
      light: { dispatch: { executor: "codex" } },
      hardened: { review_assurance: "hardened" },
    },
  });

  const proc = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-123-unknown-preset",
    "-p", "unknown preset route plan",
    "--rubric-file", rubricFile,
    "--fleet-id", "issue-123",
    "--route-preset", "missing",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome },
  });

  assert.notEqual(proc.status, 0);
  const output = JSON.parse(proc.stdout);
  assert.match(output.error, /unknown route preset 'missing'/);
  assert.deepEqual(output.available_presets, ["hardened", "light"]);
  assert.equal(fs.existsSync(path.join(relayHome, "runs")), false);
  assert.equal(fs.existsSync(path.join(relayHome, "worktrees")), false);
  assert.equal(fs.existsSync(path.join(relayHome, "fleets")), false);
});

test("dispatch route preset review_assurance maps to existing review assurance path", () => {
  const { repoRoot, relayHome, rubricFile } = setupRepo();
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: true,
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    presets: {
      hardened: { review_assurance: "hardened" },
    },
  });

  const proc = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-preset-hardened",
    "-p", "hardened preset route plan",
    "--rubric-file", rubricFile,
    "--route-preset", "hardened",
    "--dry-run",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome },
  });

  assert.equal(proc.status, 0, proc.stderr);
  const output = JSON.parse(proc.stdout);
  assert.equal(output.reviewAssurance, "hardened");
});

test("dispatch persists review assurance route preset source metadata in route-plan snapshot", () => {
  const { repoRoot, relayHome, rubricFile } = setupRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-route-preset-hardened-bin-"));
  writeFakeCodex(binDir);
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: true,
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    presets: {
      hardened: { review_assurance: "hardened" },
    },
  });

  const proc = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-preset-hardened-real",
    "-p", "hardened preset persisted route plan",
    "--rubric-file", rubricFile,
    "--route-preset", "hardened",
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
  assert.equal(snapshot.route_preset.name, "hardened");
  assert.equal(snapshot.route_preset.source, "preset:hardened");
  assert.equal(snapshot.route_preset.review_assurance, "hardened");
  assert.deepEqual(snapshot.route_preset.filled, [{ field: "review_assurance" }]);
  const manifest = readManifest(output.manifestPath).data;
  assert.equal(manifest.policy.review_assurance, "hardened");
});

test("dispatch keeps explicit --review-assurance over a preset in the route-plan snapshot", () => {
  const { repoRoot, relayHome, rubricFile } = setupRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-route-preset-cli-override-bin-"));
  writeFakeCodex(binDir);
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: true,
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    presets: {
      hardened: { review_assurance: "hardened" },
    },
  });

  const proc = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-preset-cli-override-real",
    "-p", "preset with explicit review-assurance override",
    "--rubric-file", rubricFile,
    "--route-preset", "hardened",
    "--review-assurance", "standard",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` },
  });

  assert.equal(proc.status, 0, proc.stderr);
  const output = JSON.parse(proc.stdout);
  // The explicit CLI flag wins for execution ...
  const manifest = readManifest(output.manifestPath).data;
  assert.equal(manifest.policy.review_assurance, "standard");
  // ... and the snapshot must not attribute review_assurance to the preset.
  const snapshot = JSON.parse(fs.readFileSync(output.routePlanPath, "utf-8"));
  assert.equal(snapshot.route_preset.name, "hardened");
  assert.equal(snapshot.route_preset.review_assurance, null);
  assert.ok(
    !snapshot.route_preset.filled.some((entry) => entry.field === "review_assurance"),
    "preset must not claim it filled review_assurance when the CLI overrode it"
  );
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
  const { root, repoRoot, relayHome, rubricFile } = setupRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-route-open-bin-"));
  writeFakePi(binDir);
  const intentPath = path.join(root, "route-intent-open-model-resolution.json");
  writeJson(intentPath, {
    dispatch: { executor: "pi", model: "openai/unregistered" },
    model_resolution: {
      dispatch: {
        original_input: "pi:unregistered",
        actor: "pi",
        phase: "dispatch",
        resolved_route: "openai/unregistered",
        source: "catalog_fallback",
        candidates: ["openai/unregistered"],
        warnings: ["catalog fallback used"],
      },
    },
  });

  const proc = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-open-unregistered",
    "-p", "open route plan",
    "--rubric-file", rubricFile,
    "--route-intent-file", intentPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: relayHome, PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` },
  });

  assert.equal(proc.status, 0, proc.stderr);
  const output = JSON.parse(proc.stdout);
  const snapshot = JSON.parse(fs.readFileSync(output.routePlanPath, "utf-8"));
  assert.equal(snapshot.phases.dispatch.model_resolution.original_input, "pi:unregistered");
  assert.equal(snapshot.phases.dispatch.model_resolution.source, "catalog_fallback");

  const events = fs.readFileSync(path.join(output.runDir, "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const routeResolution = events.find((event) => event.event === "route_resolution");
  assert.equal(routeResolution.policy_decision.reason, "unknown_allowed");
  assert.equal(routeResolution.model_resolution.dispatch.source, "catalog_fallback");
  const unregistered = events.find((event) => event.event === "unregistered_route_used");
  assert.equal(unregistered.phase, "dispatch");
  assert.equal(unregistered.actor_field, "executor");
  assert.equal(unregistered.executor, "pi");
  assert.equal(unregistered.model, "openai/unregistered");
  assert.equal(unregistered.model_resolution_source, "catalog_fallback");
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

test("dispatch does not emit unregistered route event for managed model-less actor", () => {
  const { repoRoot, relayHome, rubricFile } = setupRepo();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-route-managed-bin-"));
  writeFakeCodex(binDir);

  const proc = spawnSync(process.execPath, [
    SCRIPT, repoRoot,
    "-b", "issue-managed-modelless",
    "-p", "managed model-less plan",
    "--rubric-file", rubricFile,
    "--executor", "codex",
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
  // Managed model-less actors resolve to managed_cli, never unknown_allowed,
  // so the UNREGISTERED_ROUTE_USED emission condition must not fire.
  assert.equal(routeResolution.policy_decision.reason, "managed_cli");
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
