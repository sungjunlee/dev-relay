const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const {
  buildDefaultRelayPolicy,
  validateRelayPolicy,
} = require("../../../skills/relay-dispatch/scripts/relay-policy");
const {
  validateRouteConfig,
} = require("../../../skills/relay-dispatch/scripts/relay-routing");
const {
  getManifestPath,
  getProjectPolicyPath,
  getProjectRoutesPath,
  getRunDir,
} = require("../../../skills/relay-dispatch/scripts/manifest/paths");
const {
  createManifestSkeleton,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/manifest/store");
const {
  STATES,
  updateManifestState,
} = require("../../../skills/relay-dispatch/scripts/manifest/lifecycle");
const {
  EVENTS,
  readRunEvents,
} = require("../../../skills/relay-dispatch/scripts/relay-events");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "relay-config.js");

function tempDir(prefix = "relay-config-") {
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

function parseJsonAllowingStderr(result) {
  return JSON.parse(result.stdout);
}

function readPolicy(relayHome) {
  const policyPath = path.join(relayHome, "policy.json");
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf-8"));
  return validateRelayPolicy(policy, policyPath);
}

function readRoutes(relayHome) {
  return JSON.parse(fs.readFileSync(path.join(relayHome, "routes.json"), "utf-8"));
}

function validateRoutes(relayHome) {
  const routesPath = path.join(relayHome, "routes.json");
  return validateRouteConfig(readRoutes(relayHome), routesPath);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function writeExecutable(filePath, body = "#!/bin/sh\nexit 0\n") {
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
}

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Config Test"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-config@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function withRelayHome(relayHome, fn) {
  const previousRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = relayHome;
  try {
    return fn();
  } finally {
    if (previousRelayHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousRelayHome;
  }
}

function writeDeadDispatchedRun(repoRoot, relayHome, runId = "issue-802-20260707010101000-a1b2c3d4") {
  return withRelayHome(relayHome, () => {
    const runDir = getRunDir(repoRoot, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  size_class: S\n", "utf-8");
    let manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch: "issue-802-doctor",
      baseBranch: "main",
      issueNumber: 802,
      worktreePath: path.join(repoRoot, "worktrees", runId),
    });
    manifest = {
      ...manifest,
      anchor: {
        ...(manifest.anchor || {}),
        rubric_path: "rubric.yaml",
      },
    };
    manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
    writeManifest(getManifestPath(repoRoot, runId), manifest);
    return { runId, manifestPath: getManifestPath(repoRoot, runId) };
  });
}

function writeHostMismatchedLease(manifestPath, runId) {
  const runDir = path.join(path.dirname(manifestPath), runId);
  fs.writeFileSync(path.join(runDir, "lease.json"), JSON.stringify({
    pid: process.pid,
    pgid: process.pid,
    host: "other-host.example.test",
    started_at: new Date().toISOString(),
    timeout_s: 60,
  }, null, 2), "utf-8");
}

test("init --profile company writes strict global routes config without optional scaffolding", () => {
  const relayHome = tempDir();

  const result = runConfig(["init", "--profile", "company", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.equal(output.profile, "company");
  assert.equal(output.path, path.join(relayHome, "routes.json"));
  assert.deepEqual(output.warnings, []);

  assert.deepEqual(readRoutes(relayHome), {
    version: 2,
    strict: true,
    routes: [],
    denied_routes: [],
  });
  assert.equal(fs.existsSync(path.join(relayHome, "policy.json")), false);
  assert.deepEqual(validateRoutes(relayHome).routes, []);
});

test("init --profile personal writes open global routes config without optional scaffolding", () => {
  const relayHome = tempDir();

  const result = runConfig(["init", "--profile", "personal", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  assert.deepEqual(readRoutes(relayHome), {
    version: 2,
    strict: false,
    routes: [],
    denied_routes: [],
  });
  assert.equal(fs.existsSync(path.join(relayHome, "policy.json")), false);
});

test("show --effective emits deterministic JSON for routes-backed config", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "--profile", "company", "--json"], { relayHome }).status, 0);

  const result = runConfig(["show", "--effective", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.equal(output.status, "ok");
  assert.equal(output.sources.routes.global, path.join(relayHome, "routes.json"));
  assert.equal(output.policy.profile, "routes-config");
  assert.equal(output.policy.deny_unknown_model_routes, true);
});

test("show --effective preserves legacy policy-only JSON behavior", () => {
  const relayHome = tempDir();
  writeJson(path.join(relayHome, "policy.json"), {
    ...buildDefaultRelayPolicy(),
    profile: "legacy-company",
  });

  const result = runConfig(["show", "--effective", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.equal(output.status, "ok");
  assert.equal(output.sources.global, path.join(relayHome, "policy.json"));
  assert.equal(output.policy.profile, "legacy-company");
});

test("doctor uses local PATH only and labels installed disallowed harnesses as policy-disallowed", () => {
  const relayHome = tempDir();
  const binDir = tempDir("relay-config-bin-");
  writeExecutable(path.join(binDir, "opencode"));
  assert.equal(runConfig(["init", "--profile", "company", "--json"], { relayHome }).status, 0);

  const result = runConfig(["doctor", "--json"], {
    relayHome,
    env: { PATH: `${binDir}${path.delimiter}/usr/bin:/bin` },
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

test("doctor reports diagnostics instead of failing outside git checkouts", () => {
  const relayHome = tempDir();
  const nonRepoRoot = tempDir("relay-config-doctor-nonrepo-");
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: false,
    routes: [],
    denied_routes: [],
  });

  const result = runConfig(["doctor", "--json"], { relayHome, cwd: nonRepoRoot });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.equal(output.project_config.status, "error");
  assert.match(output.project_config.error, /unable to resolve main repo root/);
  assert.equal(output.project_routes.status, "error");
  assert.match(output.project_routes.error, /unable to resolve main repo root/);
  assert.deepEqual(output.advisories, []);
});

test("doctor includes project route provenance and best-effort model probes", () => {
  const relayHome = tempDir();
  const repoRoot = tempDir("relay-config-doctor-repo-");
  initGitRepo(repoRoot);
  const binDir = tempDir("relay-config-doctor-bin-");
  writeExecutable(path.join(binDir, "opencode"), "#!/bin/sh\nif [ \"$1\" = models ]; then printf 'example/opencode-model-fast\\nopenai/gpt-5\\n'; exit 0; fi\nexit 0\n");
  writeExecutable(path.join(binDir, "pi"), "#!/bin/sh\nif [ \"$1\" = --list-models ]; then printf 'example/pi-model-fast\\n'; exit 0; fi\nexit 0\n");
  writeJson(getProjectPolicyPath(repoRoot, { relayHome }), {
    ...buildDefaultRelayPolicy(),
    profile: "project",
    allowed_model_routes: [],
  });
  writeJson(path.join(relayHome, "policy.json"), {
    ...buildDefaultRelayPolicy(),
    profile: "global",
  });
  writeJson(path.join(path.dirname(getProjectPolicyPath(repoRoot, { relayHome })), "routes.json"), {
    version: 1,
    defaults: { dispatch: { executor: "codex" } },
  });

  const result = runConfig(["doctor", "--json"], {
    relayHome,
    cwd: repoRoot,
    env: {
      PATH: `${binDir}${path.delimiter}/usr/bin:/bin`,
      // This test asserts a successful ("ok") probe outcome, not timeout
      // behavior (that is covered separately below by the sleep(2s) fixture
      // in "doctor reports optional Pi model-list probe timeouts...").
      // relay-config.js bounds each model-list probe with execFileSync's
      // own `timeout` option (see probeModels in relay-config.js), which
      // races real process fork/exec latency against the wall clock. Under
      // full-suite parallel load (many test files forking subprocesses at
      // once), that fork/exec latency for the trivial opencode/pi fixture
      // scripts here can occasionally exceed a short window even though the
      // fixtures themselves do no work (#759). Use a generous ceiling so the
      // probe has real headroom to complete under contention.
      RELAY_CONFIG_MODEL_PROBE_TIMEOUT_MS: "20000",
    },
  });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.sources.project, getProjectPolicyPath(repoRoot, { relayHome }));
  assert.equal(output.project_routes.status, "ok");
  const opencode = output.tools.find((tool) => tool.name === "opencode");
  assert.equal(opencode.model_probe.status, "ok");
  assert.deepEqual(opencode.model_probe.models, ["example/opencode-model-fast", "openai/gpt-5"]);
  const pi = output.tools.find((tool) => tool.name === "pi");
  assert.deepEqual(pi.model_probe.models, ["example/pi-model-fast"]);
});

test("doctor surfaces dead dispatched runs as advisory reconcile findings", () => {
  const relayHome = tempDir();
  const repoRoot = tempDir("relay-config-doctor-dead-run-");
  initGitRepo(repoRoot);
  writeJson(path.join(relayHome, "policy.json"), {
    ...buildDefaultRelayPolicy(),
    profile: "global",
  });
  const deadRun = writeDeadDispatchedRun(repoRoot, relayHome);

  const result = runConfig(["doctor", "--json"], { relayHome, cwd: repoRoot });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  const finding = output.advisories.find((entry) => entry.kind === "dead_dispatched_run");
  assert.ok(finding, "doctor should include a dead_dispatched_run advisory");
  assert.equal(finding.runId, deadRun.runId);
  assert.equal(finding.manifestPath, deadRun.manifestPath);
  assert.equal(finding.mutated, false);
  assert.equal(finding.reconcile.rowName, "dead_no_result_no_work");
  assert.equal(finding.reconcile.dryRun, true);
  assert.deepEqual(finding.reconcile.plannedActions, [
    "journal_dispatch_interrupted_if_needed",
    "remove_lease_if_present",
  ]);
  assert.deepEqual(withRelayHome(relayHome, () => readRunEvents(repoRoot, deadRun.runId)), []);
});

test("doctor surfaces host-mismatched dispatched run leases as advisory reconcile findings", () => {
  const relayHome = tempDir();
  const repoRoot = tempDir("relay-config-doctor-host-mismatch-run-");
  initGitRepo(repoRoot);
  writeJson(path.join(relayHome, "policy.json"), {
    ...buildDefaultRelayPolicy(),
    profile: "global",
  });
  const deadRun = writeDeadDispatchedRun(repoRoot, relayHome);
  writeHostMismatchedLease(deadRun.manifestPath, deadRun.runId);

  const result = runConfig(["doctor", "--json"], { relayHome, cwd: repoRoot });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  const finding = output.advisories.find((entry) => entry.kind === "dead_dispatched_run");
  assert.ok(finding, "doctor should include a dead_dispatched_run advisory");
  assert.equal(finding.runId, deadRun.runId);
  assert.equal(finding.leaseStatus, "host_mismatch");
  assert.equal(finding.mutated, false);
  assert.equal(finding.reconcile.rowName, "dead_no_result_no_work");
  assert.equal(finding.reconcile.dryRun, true);
});

test("doctor mutates dead dispatched run reconciliation only with explicit flag", () => {
  const relayHome = tempDir();
  const repoRoot = tempDir("relay-config-doctor-reconcile-run-");
  initGitRepo(repoRoot);
  writeJson(path.join(relayHome, "policy.json"), {
    ...buildDefaultRelayPolicy(),
    profile: "global",
  });
  const deadRun = writeDeadDispatchedRun(repoRoot, relayHome);

  const result = runConfig(["doctor", "--json", "--reconcile"], { relayHome, cwd: repoRoot });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  const finding = output.advisories.find((entry) => entry.kind === "dead_dispatched_run");
  assert.ok(finding, "doctor should include a dead_dispatched_run advisory");
  assert.equal(finding.runId, deadRun.runId);
  assert.equal(finding.mutated, true);
  assert.equal(finding.reconcile.rowName, "dead_no_result_no_work");
  assert.equal(finding.reconcile.dryRun, false);
  assert.equal(finding.reconcile.journaled, true);

  const events = withRelayHome(relayHome, () => readRunEvents(repoRoot, deadRun.runId));
  assert.equal(events.at(-1).event, EVENTS.DISPATCH_INTERRUPTED);
  assert.equal(events.at(-1).reason, "reconcile_dead_no_work");
});

test("doctor reports optional Pi model-list probe timeouts without masking install or policy status", () => {
  const relayHome = tempDir();
  const binDir = tempDir("relay-config-doctor-timeout-bin-");
  writeExecutable(path.join(binDir, "pi"), "#!/bin/sh\nif [ \"$1\" = --list-models ]; then sleep 2; fi\nexit 0\n");
  writeJson(path.join(relayHome, "policy.json"), {
    ...buildDefaultRelayPolicy(),
    profile: "allow-pi-review",
    allowed_model_routes: [{ route: "example/pi-*", phases: ["review"], reviewers: ["pi"] }],
  });

  const result = runConfig(["doctor", "--json"], {
    relayHome,
    env: {
      PATH: `${binDir}${path.delimiter}/usr/bin:/bin`,
      RELAY_CONFIG_MODEL_PROBE_TIMEOUT_MS: "50",
    },
  });

  assert.equal(result.status, 0, result.combined);
  const pi = parseJson(result).tools.find((tool) => tool.name === "pi");
  assert.equal(pi.installed, true);
  assert.equal(pi.policy, "route-configured");
  assert.equal(pi.reason, "provider_model_route_required");
  assert.equal(pi.model_probe.status, "warning");
  assert.match(pi.model_probe.warning, /optional model-list probe failed for pi/i);
  assert.match(pi.model_probe.warning, /after 50ms/);
  assert.match(pi.model_probe.warning, /set RELAY_CONFIG_MODEL_PROBE_TIMEOUT_MS to adjust/);
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

test("set-default writes exactly the requested default path in routes config", () => {
  const relayHome = tempDir();

  const advisory = runConfig(["set-default", "advisory_review.reviewer", "claude", "--json"], { relayHome });
  assert.equal(advisory.status, 0, advisory.combined);

  assert.deepEqual(readRoutes(relayHome), {
    version: 2,
    defaults: {
      advisory_review: { reviewer: "claude" },
    },
  });
});

test("add-route maps mixed executor phases to executors and reviewer phases to reviewers", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "--profile", "company", "--json"], { relayHome }).status, 0);

  const mutation = runConfig([
    "add-route",
    "example/opencode-model-*",
    "--executor",
    "opencode",
    "--phase",
    "advisory_review,dispatch",
    "--json",
  ], { relayHome });
  assert.equal(mutation.status, 0, mutation.combined);

  const [entry] = readRoutes(relayHome).routes;
  assert.equal(entry.route, "example/opencode-model-*");
  assert.deepEqual(new Set(entry.phases), new Set(["advisory_review", "dispatch"]));
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

test("check requires only the actor role required by the selected phase", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "--profile", "company", "--json"], { relayHome }).status, 0);
  assert.equal(runConfig([
    "add-route",
    "example/opencode-model-*",
    "--reviewer",
    "opencode",
    "--phase",
    "review,advisory_review",
    "--json",
  ], { relayHome }).status, 0);

  const review = runConfig([
    "check",
    "--phase",
    "review",
    "--reviewer",
    "opencode",
    "--model",
    "example/opencode-model-fast",
    "--json",
  ], { relayHome });
  assert.equal(review.status, 0, review.combined);
  assert.equal(parseJson(review).decision.reason, "allowed_model_route");

  const advisory = runConfig([
    "check",
    "--phase",
    "advisory_review",
    "--reviewer",
    "opencode",
    "--model",
    "example/opencode-model-fast",
    "--json",
  ], { relayHome });
  assert.equal(advisory.status, 0, advisory.combined);
  assert.equal(parseJson(advisory).decision.reason, "allowed_model_route");

  const missingExecutor = runConfig([
    "check",
    "--phase",
    "dispatch",
    "--reviewer",
    "opencode",
    "--model",
    "example/opencode-model-fast",
    "--json",
  ], { relayHome });
  assert.notEqual(missingExecutor.status, 0, missingExecutor.combined);
  assert.match(missingExecutor.combined, /--executor is required/);

  const missingReviewer = runConfig([
    "check",
    "--phase",
    "advisory_review",
    "--executor",
    "opencode",
    "--model",
    "example/opencode-model-fast",
    "--json",
  ], { relayHome });
  assert.notEqual(missingReviewer.status, 0, missingReviewer.combined);
  assert.match(missingReviewer.combined, /--reviewer is required/);
});

test("deny-route preserves route scopes and denied routes win during check", () => {
  const relayHome = tempDir();
  assert.equal(runConfig(["init", "--profile", "company", "--json"], { relayHome }).status, 0);
  assert.equal(runConfig([
    "add-route",
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

  const [entry] = readRoutes(relayHome).denied_routes;
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

test("allow-route is a deprecated alias with stdout parity and one stderr line", () => {
  const relayHome = tempDir();
  const args = [
    "add-route",
    "example/opencode-model-*",
    "--executor",
    "opencode",
    "--phase",
    "dispatch",
    "--json",
  ];
  const addRoute = runConfig(args, { relayHome });
  assert.equal(addRoute.status, 0, addRoute.combined);

  fs.unlinkSync(path.join(relayHome, "routes.json"));
  const alias = runConfig(["allow-route", ...args.slice(1)], { relayHome });
  assert.equal(alias.status, 0, alias.combined);
  assert.equal(alias.stdout, addRoute.stdout);
  const stderrLines = alias.stderr.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(stderrLines.length, 1);
  assert.match(stderrLines[0], /allow-route is deprecated; use add-route/i);
  assert.equal(parseJsonAllowingStderr(alias).action, "add-route");
});

test("mutation commands create routes.json, preserve existing v2 fields, and warn only when shadowing legacy config", () => {
  const specs = [
    {
      name: "init",
      args: ["init", "--profile", "company", "--json"],
      assertCreated(routes) {
        assert.deepEqual(routes, {
          version: 2,
          strict: true,
          routes: [],
          denied_routes: [],
        });
      },
      // init has overwrite semantics: the pre-existing config is replaced by
      // the fresh profile shape rather than merged into.
      overwrites: true,
      assertExisting(routes) {
        assert.deepEqual(routes, {
          version: 2,
          strict: true,
          routes: [],
          denied_routes: [],
        });
      },
    },
    {
      name: "set-default",
      args: ["set-default", "review.reviewer", "claude", "--json"],
      assertCreated(routes) {
        assert.deepEqual(routes, {
          version: 2,
          defaults: {
            review: { reviewer: "claude" },
          },
        });
      },
      assertExisting(routes) {
        assert.deepEqual(routes.defaults, {
          dispatch: { executor: "opencode" },
          review: { reviewer: "claude" },
        });
      },
    },
    {
      name: "add-route",
      args: ["add-route", "openai/new", "--phase", "dispatch", "--executor", "opencode", "--json"],
      assertCreated(routes) {
        assert.deepEqual(routes, {
          version: 2,
          routes: [{ route: "openai/new", phases: ["dispatch"], executors: ["opencode"] }],
        });
      },
      assertExisting(routes) {
        assert.deepEqual(routes.routes, [
          { route: "openai/existing", phases: ["dispatch"], executors: ["opencode"] },
          { route: "openai/new", phases: ["dispatch"], executors: ["opencode"] },
        ]);
      },
    },
    {
      name: "deny-route",
      args: ["deny-route", "openai/new-deny", "--phase", "review", "--reviewer", "pi", "--json"],
      assertCreated(routes) {
        assert.deepEqual(routes, {
          version: 2,
          denied_routes: [{ route: "openai/new-deny", phases: ["review"], reviewers: ["pi"] }],
        });
      },
      assertExisting(routes) {
        assert.deepEqual(routes.denied_routes, [
          { route: "openai/blocked", phases: ["review"], reviewers: ["pi"] },
          { route: "openai/new-deny", phases: ["review"], reviewers: ["pi"] },
        ]);
      },
    },
  ];

  for (const spec of specs) {
    const createdHome = tempDir(`relay-config-${spec.name}-created-`);
    const created = runConfig(spec.args, { relayHome: createdHome });
    assert.equal(created.status, 0, `${spec.name} create\n${created.combined}`);
    assert.deepEqual(parseJson(created).warnings, []);
    spec.assertCreated(readRoutes(createdHome));
    assert.equal(fs.existsSync(path.join(createdHome, "policy.json")), false);

    const existingHome = tempDir(`relay-config-${spec.name}-existing-`);
    writeJson(path.join(existingHome, "routes.json"), {
      version: 2,
      strict: true,
      defaults: {
        dispatch: { executor: "opencode" },
      },
      executor_defaults: {
        opencode: { model: "openai/existing" },
      },
      routes: [{ route: "openai/existing", phases: ["dispatch"], executors: ["opencode"] }],
      denied_routes: [{ route: "openai/blocked", phases: ["review"], reviewers: ["pi"] }],
      presets: {
        fast: { dispatch: { executor: "opencode", model: "openai/existing" } },
      },
    });
    const existing = runConfig(spec.args, { relayHome: existingHome });
    assert.equal(existing.status, 0, `${spec.name} existing\n${existing.combined}`);
    assert.deepEqual(parseJson(existing).warnings, []);
    const existingRoutes = readRoutes(existingHome);
    spec.assertExisting(existingRoutes);
    if (!spec.overwrites) {
      assert.equal(existingRoutes.strict, true);
      assert.deepEqual(existingRoutes.executor_defaults, {
        opencode: { model: "openai/existing" },
      });
      assert.deepEqual(existingRoutes.presets, {
        fast: { dispatch: { executor: "opencode", model: "openai/existing" } },
      });
    }

    const legacyHome = tempDir(`relay-config-${spec.name}-legacy-`);
    const legacyPath = path.join(legacyHome, "policy.json");
    const legacyPolicy = {
      ...buildDefaultRelayPolicy(),
      profile: "legacy",
      allowed_model_routes: [{ route: "legacy/*", phases: ["dispatch"], executors: ["opencode"] }],
    };
    writeJson(legacyPath, legacyPolicy);
    const before = fs.readFileSync(legacyPath, "utf-8");
    const legacy = runConfig(spec.args, { relayHome: legacyHome });
    assert.equal(legacy.status, 0, `${spec.name} legacy\n${legacy.combined}`);
    const legacyOutput = parseJson(legacy);
    assert.equal(legacyOutput.warnings.length, 1);
    assert.match(legacyOutput.warnings[0], /routes\.json now takes precedence/i);
    assert.match(legacyOutput.warnings[0], /policy\.json\/executors\.json are ignored/i);
    assert.equal(fs.readFileSync(legacyPath, "utf-8"), before);
    assert.equal(fs.existsSync(path.join(legacyHome, "routes.json")), true);
  }
});

test("route mutations preserve omitted optional keys and absent default phases", () => {
  const addHome = tempDir("relay-config-add-omission-");
  assert.equal(runConfig([
    "add-route",
    "openai/new",
    "--phase",
    "dispatch",
    "--executor",
    "opencode",
    "--json",
  ], { relayHome: addHome }).status, 0);
  const addRoutes = readRoutes(addHome);
  assert.deepEqual(Object.keys(addRoutes).sort(), ["routes", "version"]);
  assert.equal(hasOwn(addRoutes, "strict"), false);
  assert.equal(hasOwn(addRoutes, "defaults"), false);
  assert.equal(hasOwn(addRoutes, "executor_defaults"), false);
  assert.equal(hasOwn(addRoutes, "presets"), false);

  const defaultHome = tempDir("relay-config-default-omission-");
  assert.equal(runConfig([
    "set-default",
    "advisory_review.reviewer",
    "pi",
    "--json",
  ], { relayHome: defaultHome }).status, 0);
  const defaultRoutes = readRoutes(defaultHome);
  assert.deepEqual(defaultRoutes, {
    version: 2,
    defaults: {
      advisory_review: { reviewer: "pi" },
    },
  });
  assert.equal(hasOwn(defaultRoutes.defaults, "dispatch"), false);
  assert.equal(hasOwn(defaultRoutes.defaults, "review"), false);

  const presetHome = tempDir("relay-config-preset-omission-");
  assert.equal(runConfig([
    "preset",
    "add",
    "hardened",
    "--review-assurance",
    "hardened",
    "--json",
  ], { relayHome: presetHome }).status, 0);
  assert.deepEqual(readRoutes(presetHome), {
    version: 2,
    presets: {
      hardened: { review_assurance: "hardened" },
    },
  });
});

test("preset add supports review assurance and validates referenced routes with warnings", () => {
  const relayHome = tempDir();
  const binDir = tempDir("relay-config-preset-bin-");
  writeExecutable(path.join(binDir, "opencode"));
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: true,
    routes: [
      { route: "openai/registered", phases: ["dispatch"], executors: ["opencode"] },
    ],
  });

  const result = runConfig([
    "preset",
    "add",
    "hardened",
    "--dispatch",
    "opencode:openai/unregistered",
    "--advisory-review",
    "pi:openai/advisory",
    "--review-assurance",
    "hardened",
    "--json",
  ], {
    relayHome,
    env: { PATH: `${binDir}${path.delimiter}/usr/bin:/bin` },
  });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.action, "preset add");
  assert.match(output.warnings.join("\n"), /strict routes config does not register dispatch route openai\/unregistered/i);
  assert.match(output.warnings.join("\n"), /pi CLI not found/i);
  assert.deepEqual(readRoutes(relayHome).presets.hardened, {
    dispatch: { executor: "opencode", model: "openai/unregistered" },
    advisory_review: { reviewer: "pi", model: "openai/advisory" },
    review_assurance: "hardened",
  });
});

test("preset add warns once when creating routes.json over legacy fallback config", () => {
  const relayHome = tempDir();
  const legacyPath = path.join(relayHome, "policy.json");
  writeJson(legacyPath, {
    ...buildDefaultRelayPolicy(),
    profile: "legacy",
  });
  const before = fs.readFileSync(legacyPath, "utf-8");

  const result = runConfig([
    "preset",
    "add",
    "hardened",
    "--review-assurance",
    "hardened",
    "--json",
  ], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.warnings.length, 1);
  assert.match(output.warnings[0], /routes\.json now takes precedence/i);
  assert.equal(fs.readFileSync(legacyPath, "utf-8"), before);
});

test("preset show reads global presets and preset remove drops empty preset scaffolding", () => {
  const relayHome = tempDir();
  const repoRoot = tempDir("relay-config-preset-show-repo-");
  initGitRepo(repoRoot);
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    presets: {
      light: { dispatch: { executor: "codex" } },
    },
  });
  writeJson(getProjectRoutesPath(repoRoot, { relayHome }), {
    version: 2,
    presets: {
      light: { dispatch: { executor: "opencode" } },
      project_only: { review: { reviewer: "claude" } },
    },
  });

  const show = runConfig(["preset", "show", "light", "--json"], { relayHome, cwd: repoRoot });
  assert.equal(show.status, 0, show.combined);
  assert.deepEqual(parseJson(show).preset, { dispatch: { executor: "codex" } });

  const showAll = runConfig(["preset", "show", "--json"], { relayHome, cwd: repoRoot });
  assert.equal(showAll.status, 0, showAll.combined);
  assert.deepEqual(parseJson(showAll).presets, {
    light: { dispatch: { executor: "codex" } },
  });

  const showProjectOnly = runConfig(["preset", "show", "project_only", "--json"], { relayHome, cwd: repoRoot });
  assert.notEqual(showProjectOnly.status, 0, showProjectOnly.combined);
  assert.match(showProjectOnly.combined, /unknown preset: project_only/);

  const remove = runConfig(["preset", "remove", "light", "--json"], { relayHome });
  assert.equal(remove.status, 0, remove.combined);
  assert.equal(hasOwn(readRoutes(relayHome), "presets"), false);

  const showEmpty = runConfig(["preset", "show", "--json"], { relayHome });
  assert.equal(showEmpty.status, 0, showEmpty.combined);
  assert.deepEqual(parseJson(showEmpty).presets, {});
});

test("preset show/remove reject add-only mutation flags and add requires --advisory-review for --advisory-profile", () => {
  const relayHome = tempDir();
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    presets: {
      light: { dispatch: { executor: "codex" } },
    },
  });

  const removeWithFlag = runConfig(["preset", "remove", "light", "--dispatch", "opencode:fast", "--json"], { relayHome });
  assert.notEqual(removeWithFlag.status, 0, removeWithFlag.combined);
  assert.match(removeWithFlag.combined, /preset remove does not accept --dispatch/);
  // The inapplicable mutation flag must be rejected before the preset is removed.
  assert.equal(hasOwn(readRoutes(relayHome).presets, "light"), true);

  const showWithFlag = runConfig(["preset", "show", "light", "--review-assurance", "hardened", "--json"], { relayHome });
  assert.notEqual(showWithFlag.status, 0, showWithFlag.combined);
  assert.match(showWithFlag.combined, /preset show does not accept --review-assurance/);

  // A bare value flag (present without a value) must still be rejected on remove.
  const removeBareFlag = runConfig(["preset", "remove", "light", "--dispatch", "--json"], { relayHome });
  assert.notEqual(removeBareFlag.status, 0, removeBareFlag.combined);
  assert.match(removeBareFlag.combined, /preset remove does not accept --dispatch/);
  assert.equal(hasOwn(readRoutes(relayHome).presets, "light"), true);

  const addProfileNoReviewer = runConfig(["preset", "add", "p", "--advisory-profile", "blindspot", "--json"], { relayHome });
  assert.notEqual(addProfileNoReviewer.status, 0, addProfileNoReviewer.combined);
  assert.match(addProfileNoReviewer.combined, /--advisory-profile requires --advisory-review/);
});

test("preset mutation validation failure leaves the routes file untouched", () => {
  const relayHome = tempDir();
  const routesPath = path.join(relayHome, "routes.json");
  writeJson(routesPath, {
    version: 2,
    routes: [],
    presets: [],
  });
  const before = fs.readFileSync(routesPath, "utf-8");

  const result = runConfig([
    "preset",
    "add",
    "light",
    "--dispatch",
    "opencode:openai/new",
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0, result.combined);
  assert.match(result.combined, /presets must be an object/);
  assert.equal(fs.readFileSync(routesPath, "utf-8"), before);
});

test("validation failure leaves the routes file untouched", () => {
  const relayHome = tempDir();
  const routesPath = path.join(relayHome, "routes.json");
  writeJson(routesPath, {
    version: 2,
    routes: [],
    presets: [],
  });
  const before = fs.readFileSync(routesPath, "utf-8");

  const result = runConfig([
    "add-route",
    "openai/new",
    "--phase",
    "dispatch",
    "--executor",
    "opencode",
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0, result.combined);
  assert.match(result.combined, /presets must be an object/);
  assert.equal(fs.readFileSync(routesPath, "utf-8"), before);
});

test("init overwrites an invalid existing routes.json instead of failing on it", () => {
  const relayHome = tempDir();
  const routesPath = path.join(relayHome, "routes.json");
  writeJson(routesPath, {
    version: 2,
    routes: [],
    presets: [],
  });

  const result = runConfig(["init", "--profile", "personal", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  assert.deepEqual(readRoutes(relayHome), {
    version: 2,
    strict: false,
    routes: [],
    denied_routes: [],
  });
});

test("init rejects profiles other than company or personal", () => {
  const relayHome = tempDir();

  const result = runConfig(["init", "--profile", "compnay", "--json"], { relayHome });

  assert.notEqual(result.status, 0, result.combined);
  assert.match(result.combined, /--profile must be one of: company, personal/);
  assert.equal(fs.existsSync(path.join(relayHome, "routes.json")), false);
});

test("legacy-shadow warning three states in text mode", () => {
  const warningPattern = /^warning: routes\.json now takes precedence; legacy policy\.json\/executors\.json are ignored/;
  const mutationArgs = ["add-route", "openai/new", "--phase", "dispatch", "--executor", "opencode"];

  const shadowHome = tempDir("relay-config-text-shadow-");
  writeJson(path.join(shadowHome, "policy.json"), {
    ...buildDefaultRelayPolicy(),
    profile: "legacy",
  });
  const shadow = runConfig(mutationArgs, { relayHome: shadowHome });
  assert.equal(shadow.status, 0, shadow.combined);
  const shadowWarningLines = shadow.stdout.split(/\r?\n/).filter((line) => warningPattern.test(line));
  assert.equal(shadowWarningLines.length, 1, shadow.stdout);
  assert.match(shadow.stdout, /relay-config: add-route wrote /);

  const existingHome = tempDir("relay-config-text-existing-");
  writeJson(path.join(existingHome, "policy.json"), {
    ...buildDefaultRelayPolicy(),
    profile: "legacy",
  });
  writeJson(path.join(existingHome, "routes.json"), { version: 2, routes: [] });
  const existing = runConfig(mutationArgs, { relayHome: existingHome });
  assert.equal(existing.status, 0, existing.combined);
  assert.doesNotMatch(existing.stdout, /warning:/);

  const freshHome = tempDir("relay-config-text-fresh-");
  const fresh = runConfig(mutationArgs, { relayHome: freshHome });
  assert.equal(fresh.status, 0, fresh.combined);
  assert.doesNotMatch(fresh.stdout, /warning:/);
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

  const addRoute = runConfig(["add-route", "openai/*", "--phase", "dispatch", "--model", "openai/gpt-5"], { relayHome });
  assert.notEqual(addRoute.status, 0, addRoute.combined);
  assert.match(addRoute.combined, /unsupported flags for add-route: --model/);

  const allowRoute = runConfig(["allow-route", "openai/*", "--phase", "dispatch", "--model", "openai/gpt-5"], { relayHome });
  assert.notEqual(allowRoute.status, 0, allowRoute.combined);
  assert.match(allowRoute.combined, /unsupported flags for allow-route: --model/);

  const preset = runConfig(["preset", "show", "--model", "openai/gpt-5"], { relayHome });
  assert.notEqual(preset.status, 0, preset.combined);
  assert.match(preset.combined, /unsupported flags for preset: --model/);
});

test("help explains harness actors and provider/model route boundaries without policy prose", () => {
  const result = runConfig(["--help"]);

  assert.equal(result.status, 0, result.combined);
  assert.match(result.stdout, /executor\/reviewer names are harnesses/i);
  assert.match(result.stdout, /provider\/model route strings are the routing boundary/i);
  assert.match(result.stdout, /add-route <pattern>/);
  assert.match(result.stdout, /preset add\|remove\|show/);
  assert.match(result.stdout, /allow-route <pattern>.*deprecated/i);
  assert.doesNotMatch(result.stdout, /\bpolicy\b/i);
});

test("plan-run previews managed Codex dispatch and review routes", () => {
  const relayHome = tempDir();

  const result = runConfig(["plan-run", "--dispatch", "codex", "--review", "codex", "--json"], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.equal(output.route_plan.phases.dispatch.executor, "codex");
  assert.equal(output.route_plan.phases.dispatch.policy_decision.reason, "managed_cli");
  assert.equal(output.route_plan.phases.review.reviewer, "codex");
  assert.equal(output.route_plan.phases.review.policy_decision.reason, "managed_cli");
});

test("plan-run previews allowed Pi route with policy source trace", () => {
  const relayHome = tempDir();
  writeJson(path.join(relayHome, "policy.json"), {
    version: 1,
    profile: "allow-pi",
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    managed_cli: ["codex", "claude"],
    allowed_model_routes: [{ route: "example/pi-*", phases: ["dispatch"], executors: ["pi"] }],
    denied_model_routes: [],
    routing_rules: [],
    deny_unknown_model_routes: true,
  });

  const result = runConfig([
    "plan-run",
    "--dispatch", "pi:example/pi-model-fast",
    "--review", "codex",
    "--json",
  ], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, true);
  assert.equal(output.policy.sources.global, path.join(relayHome, "policy.json"));
  assert.equal(output.route_plan.phases.dispatch.executor, "pi");
  assert.equal(output.route_plan.phases.dispatch.sources.executor, "run_intent");
  assert.equal(output.route_plan.phases.dispatch.policy_decision.reason, "allowed_model_route");
});

test("plan-run denies routes narrowed by project policy before dispatch", () => {
  const relayHome = tempDir();
  const repoRoot = tempDir("relay-config-plan-run-repo-");
  initGitRepo(repoRoot);
  writeJson(path.join(relayHome, "policy.json"), {
    version: 1,
    profile: "global",
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    managed_cli: ["codex", "claude"],
    allowed_model_routes: [{ route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] }],
    denied_model_routes: [],
    routing_rules: [],
    deny_unknown_model_routes: true,
  });
  writeJson(getProjectPolicyPath(repoRoot, { relayHome }), {
    version: 1,
    profile: "project",
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    managed_cli: ["codex", "claude"],
    allowed_model_routes: [{ route: "example/opencode-model-safe", phases: ["dispatch"], executors: ["opencode"] }],
    denied_model_routes: [],
    routing_rules: [],
    deny_unknown_model_routes: true,
  });

  const result = runConfig([
    "plan-run",
    "--repo", repoRoot,
    "--dispatch", "opencode:example/opencode-model-fast",
    "--json",
  ], { relayHome, cwd: repoRoot });

  assert.notEqual(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.equal(output.ok, false);
  assert.equal(output.policy.sources.project, getProjectPolicyPath(repoRoot, { relayHome }));
  assert.equal(output.route_plan.phases.dispatch.policy_decision.reason, "unknown_model_route");
});

test("plan-run labels Antigravity model route without implying agy model passthrough", () => {
  const relayHome = tempDir();
  writeJson(path.join(relayHome, "policy.json"), {
    version: 1,
    profile: "allow-antigravity",
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    managed_cli: ["codex", "claude"],
    allowed_model_routes: [{ route: "google/*", phases: ["dispatch"], executors: ["antigravity"] }],
    denied_model_routes: [],
    routing_rules: [],
    deny_unknown_model_routes: true,
  });

  const result = runConfig([
    "plan-run",
    "--dispatch", "antigravity:google/antigravity-cli",
    "--json",
  ], { relayHome });

  assert.equal(result.status, 0, result.combined);
  const output = parseJson(result);
  assert.match(output.warnings.join("\n"), /policy label; not passed to agy/i);
  assert.equal(output.route_plan.phases.dispatch.policy_decision.reason, "allowed_model_route");
});
