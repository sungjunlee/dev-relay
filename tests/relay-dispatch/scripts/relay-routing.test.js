const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  classifyChangedFiles,
  collectRoutingTagSources,
  loadRouteConfig,
  loadProjectRoutes,
  normalizeTags,
  resolveRouteIntent,
  resolveRoutingDecision,
  validateRouteConfig,
  validateProjectRoutes,
  validateRoutingRules,
} = require("../../../skills/relay-dispatch/scripts/relay-routing");
const { buildDefaultRelayPolicy } = require("../../../skills/relay-dispatch/scripts/relay-policy");
const { getProjectRoutesPath } = require("../../../skills/relay-dispatch/scripts/manifest/paths");

function policy(routingRules = []) {
  return {
    defaults: {
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    routing_rules: routingRules,
  };
}

function routePolicy(overrides = {}) {
  return {
    ...buildDefaultRelayPolicy(),
    ...overrides,
  };
}

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
}

function tempRepo() {
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-routing-repo-"));
  initGitRepo(repoRoot);
  return { relayHome, repoRoot };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

test("routing normalizes tags from CSV and arrays deterministically", () => {
  assert.deepEqual(
    normalizeTags([" Docs ", "docs", "TEST-GAP", "", null, "test-gap"]),
    ["docs", "test-gap"]
  );
  assert.deepEqual(normalizeTags(" Docs, 'test-gap' ,, \"SECURITY\" "), ["docs", "test-gap", "security"]);
});

test("routing CLI tags override inferred labels, profile, rubric, and file tags", () => {
  const decision = resolveRoutingDecision({
    policy: policy([
      {
        name: "docs",
        match: { tags: ["docs-only"] },
        advisory_review: { reviewer: "opencode", profile: "docs" },
      },
      {
        name: "security",
        match: { tags: ["security"] },
        advisory_review: { reviewer: "claude", profile: "blindspot" },
      },
    ]),
    cliTags: "security",
    issueLabels: ["docs-only"],
    taskProfile: { risk_tags: ["docs-only"], domains: ["docs"] },
    rubric: { tags: ["docs-only"] },
    changedFiles: ["README.md"],
  });

  assert.equal(decision.effective_source, "cli");
  assert.deepEqual(decision.effective_tags, ["security"]);
  assert.equal(decision.matched, true);
  assert.equal(decision.matched_rule.name, "security");
  assert.deepEqual(decision.selected.advisory_review, { reviewer: "claude", profile: "blindspot" });
});

test("routing collects label, task_profile, rubric, and test-command tags when CLI tags are absent", () => {
  const sources = collectRoutingTagSources({
    issueLabels: ["needs-review", "Docs"],
    taskProfile: {
      domains: ["relay-dispatch"],
      risk_tags: ["trust-boundary"],
      guidance_packs: ["verification-evidence"],
    },
    rubric: {
      tags: ["rubric-tag"],
      task_profile: { risk_tags: ["profile-rubric"] },
    },
    testCommands: ["node --test tests/relay-dispatch/scripts/relay-routing.test.js"],
  });

  assert.deepEqual(sources.effective_tags, [
    "needs-review",
    "docs",
    "relay-dispatch",
    "trust-boundary",
    "verification-evidence",
    "rubric-tag",
    "profile-rubric",
    "test-gap",
  ]);
  assert.equal(sources.effective_source, "inferred");
});

test("routing changed-file classifier recognizes docs-only and test-gap candidates", () => {
  assert.deepEqual(
    classifyChangedFiles(["README.md", "docs/usage.md", "skills/relay/SKILL.md"]),
    ["docs", "docs-only"]
  );
  assert.deepEqual(classifyChangedFiles(["tests/relay-dispatch/scripts/relay-routing.test.js"]), [
    "tests",
    "test-gap",
  ]);
  assert.deepEqual(classifyChangedFiles(["skills/relay-dispatch/scripts/dispatch.js"]), []);
});

test("routing first matching rule selects advisory defaults only", () => {
  const originalPolicy = policy([
    {
      name: "first",
      match: { tags: ["docs"] },
      review: { reviewer: "opencode" },
      advisory_review: { reviewer: "claude", profile: "blindspot" },
    },
    {
      name: "second",
      match: { tags: ["docs"] },
      advisory_review: { reviewer: "opencode" },
    },
  ]);

  const decision = resolveRoutingDecision({
    policy: originalPolicy,
    issueLabels: ["docs"],
  });

  assert.equal(decision.matched, true);
  assert.equal(decision.matched_rule.name, "first");
  assert.deepEqual(decision.selected, {
    advisory_review: { reviewer: "claude", profile: "blindspot" },
  });
  assert.deepEqual(originalPolicy.defaults.review, { reviewer: "codex" });
  assert.deepEqual(decision.ignored_primary_review, { reviewer: "opencode" });
});

test("routing reports no match with null advisory selection", () => {
  const decision = resolveRoutingDecision({
    policy: policy([
      {
        name: "docs",
        match: { tags: ["docs"] },
        advisory_review: { reviewer: "opencode" },
      },
    ]),
    issueLabels: ["security"],
  });

  assert.equal(decision.matched, false);
  assert.equal(decision.matched_rule, null);
  assert.deepEqual(decision.selected, { advisory_review: null });
  assert.equal(decision.no_match_reason, "no_routing_rule_matched");
});

test("routing duplicate rule names warn but preserve first-match order", () => {
  const rules = [
    {
      name: "dup",
      match: { tags: ["docs"] },
      advisory_review: { reviewer: "claude" },
    },
    {
      name: "dup",
      match: { tags: ["docs"] },
      advisory_review: { reviewer: "opencode" },
    },
  ];

  assert.deepEqual(validateRoutingRules(rules).warnings, [
    {
      code: "duplicate_rule_name",
      name: "dup",
      first_index: 0,
      duplicate_index: 1,
    },
  ]);

  const decision = resolveRoutingDecision({ policy: policy(rules), issueLabels: ["docs"] });
  assert.equal(decision.matched_rule.name, "dup");
  assert.equal(decision.matched_rule.index, 0);
  assert.deepEqual(decision.selected.advisory_review, { reviewer: "claude" });
  assert.deepEqual(decision.warnings, [
    {
      code: "duplicate_rule_name",
      name: "dup",
      first_index: 0,
      duplicate_index: 1,
    },
  ]);
});

test("project routes reader reports absent and malformed routes.json deterministically", () => {
  const { relayHome, repoRoot } = tempRepo();
  const absent = loadProjectRoutes({ repoRoot, relayHome });
  assert.equal(absent.ok, true);
  assert.equal(absent.status, "absent");
  assert.equal(absent.routes, null);
  assert.equal(absent.path, getProjectRoutesPath(repoRoot, { relayHome }));

  fs.mkdirSync(path.dirname(absent.path), { recursive: true });
  fs.writeFileSync(absent.path, "{not-json\n", "utf-8");
  const malformed = loadProjectRoutes({ repoRoot, relayHome });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.status, "error");
  assert.match(malformed.error, /failed to parse project routes/);
});

test("project routes schema accepts phase defaults and rejects malformed actors", () => {
  assert.deepEqual(validateProjectRoutes({
    version: 1,
    defaults: {
      dispatch: { executor: "pi", model: "example/pi-model-fast" },
      review: { reviewer: "codex" },
      advisory_review: { reviewer: "opencode", model: "example/opencode-model-cheap", profile: "blindspot" },
    },
  }, "routes.json").defaults.review, { reviewer: "codex" });

  assert.throws(
    () => validateProjectRoutes({
      version: 1,
      defaults: { dispatch: { reviewer: "codex" } },
    }, "routes.json"),
    /defaults\.dispatch\.executor must be a non-empty string/
  );
});

test("route config v2 accepts unified fields and carries presets unconsumed", () => {
  const config = validateRouteConfig({
    version: 2,
    strict: true,
    defaults: {
      dispatch: { executor: "opencode" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    executor_defaults: {
      opencode: { model: "openai/gpt-5.3-codex-spark" },
    },
    routes: [
      { route: "openai/*", phases: ["dispatch"], executors: ["opencode"] },
    ],
    denied_routes: ["openai/banned"],
    presets: {
      light: { dispatch: { executor: "opencode", model: "openai/gpt-5.3-codex-spark" } },
    },
  }, "routes.json");

  assert.equal(config.version, 2);
  assert.equal(config.strict, true);
  assert.deepEqual(config.executor_defaults.opencode, { model: "openai/gpt-5.3-codex-spark" });
  assert.deepEqual(config.presets.light.dispatch, {
    executor: "opencode",
    model: "openai/gpt-5.3-codex-spark",
  });
});

test("route config loader merges global and project v2 per field with project presets winning", () => {
  const { relayHome, repoRoot } = tempRepo();
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: false,
    defaults: {
      dispatch: { executor: "codex" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    executor_defaults: {
      opencode: { model: "openai/global" },
    },
    routes: [
      { route: "openai/global", phases: ["dispatch"], executors: ["opencode"] },
    ],
    denied_routes: ["openai/denied-global"],
    presets: {
      light: { dispatch: { executor: "opencode", model: "openai/global" } },
      diverse: { advisory_review: { reviewer: "pi", profile: "blindspot" } },
    },
  });
  writeJson(getProjectRoutesPath(repoRoot, { relayHome }), {
    version: 2,
    strict: true,
    defaults: {
      dispatch: { executor: "pi", model: "openai/project" },
    },
    executor_defaults: {
      opencode: { model: "openai/project" },
    },
    routes: [
      { route: "openai/project", phases: ["review"], reviewers: ["opencode"] },
    ],
    denied_routes: ["openai/denied-project"],
    presets: {
      light: { dispatch: { executor: "pi", model: "openai/project" } },
    },
  });

  const result = loadRouteConfig({ repoRoot, relayHome });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.config.strict, true);
  assert.deepEqual(result.config.defaults.dispatch, { executor: "pi", model: "openai/project" });
  assert.deepEqual(result.config.defaults.review, { reviewer: "codex" });
  assert.deepEqual(result.config.executor_defaults.opencode, { model: "openai/project" });
  assert.deepEqual(result.config.routes.map((entry) => entry.route), ["openai/global", "openai/project"]);
  assert.deepEqual(result.config.denied_routes.map((entry) => entry.route), ["openai/denied-global", "openai/denied-project"]);
  assert.deepEqual(result.config.presets.light.dispatch, { executor: "pi", model: "openai/project" });
  assert.deepEqual(result.config.presets.diverse.advisory_review, { reviewer: "pi", profile: "blindspot" });
});

test("route intent resolver gives run intent precedence over project defaults", () => {
  const result = resolveRouteIntent({
    runIntent: {
      dispatch: { executor: "pi", model: "example/pi-model-fast" },
      review: { reviewer: "claude" },
    },
    projectRoutes: {
      version: 1,
      defaults: {
        dispatch: { executor: "opencode", model: "example/opencode-model-fast" },
        review: { reviewer: "codex" },
      },
    },
    policy: routePolicy({
      allowed_model_routes: [{ route: "example/pi-*", phases: ["dispatch"], executors: ["pi"] }],
    }),
  });

  assert.equal(result.phases.dispatch.executor, "pi");
  assert.equal(result.phases.dispatch.model, "example/pi-model-fast");
  assert.equal(result.phases.dispatch.sources.executor, "run_intent");
  assert.equal(result.phases.dispatch.policy_decision.reason, "allowed_model_route");
  assert.equal(result.phases.review.reviewer, "claude");
  assert.equal(result.phases.review.policy_decision.reason, "managed_cli");
});

test("route intent resolver uses project defaults before built-in managed defaults", () => {
  const result = resolveRouteIntent({
    projectRoutes: {
      version: 1,
      defaults: {
        dispatch: { executor: "pi", model: "example/pi-model-fast" },
        review: { reviewer: "codex" },
      },
    },
    policy: routePolicy({
      allowed_model_routes: [{ route: "example/pi-*", phases: ["dispatch"], executors: ["pi"] }],
    }),
  });

  assert.equal(result.phases.dispatch.executor, "pi");
  assert.equal(result.phases.dispatch.sources.executor, "project_routes");
  assert.equal(result.phases.review.reviewer, "codex");
  assert.equal(result.phases.review.model, null);
  assert.equal(result.phases.review.policy_decision.reason, "managed_cli");
});

test("route intent resolver preserves missing unmanaged model as policy denial", () => {
  const result = resolveRouteIntent({
    runIntent: { dispatch: { executor: "pi" } },
    policy: routePolicy({
      allowed_model_routes: [{ route: "example/pi-*", phases: ["dispatch"], executors: ["pi"] }],
    }),
  });

  assert.equal(result.phases.dispatch.executor, "pi");
  assert.equal(result.phases.dispatch.model, null);
  assert.equal(result.phases.dispatch.policy_decision.allowed, false);
  assert.equal(result.phases.dispatch.policy_decision.reason, "missing_model_route");
});
