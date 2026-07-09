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
  assert.deepEqual(decision.selected.advisory_review, [{
    reviewer: "claude",
    profile: "blindspot",
    trigger: "every_round",
    gating: false,
  }]);
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
    advisory_review: [{
      reviewer: "claude",
      profile: "blindspot",
      trigger: "every_round",
      gating: false,
    }],
  });
  assert.deepEqual(originalPolicy.defaults.review, { reviewer: "codex" });
  assert.deepEqual(decision.ignored_primary_review, { reviewer: "opencode" });
});

test("routing preserves legacy reviewer_model advisory shorthand as lane model", () => {
  const decision = resolveRoutingDecision({
    policy: policy([
      {
        name: "legacy-advisory",
        match: { tags: ["compat"] },
        advisory_review: {
          reviewer: "opencode",
          reviewer_model: "example/opencode-model-fast",
        },
      },
    ]),
    issueLabels: ["compat"],
  });

  assert.deepEqual(decision.selected.advisory_review, [{
    reviewer: "opencode",
    model: "example/opencode-model-fast",
    profile: "blindspot",
    trigger: "every_round",
    gating: false,
  }]);
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
  assert.deepEqual(decision.selected.advisory_review, [{
    reviewer: "claude",
    profile: "blindspot",
    trigger: "every_round",
    gating: false,
  }]);
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

  fs.writeFileSync(absent.path, JSON.stringify({ version: 2, strict: true }, null, 2), "utf-8");
  const ignoredV2 = loadProjectRoutes({ repoRoot, relayHome });
  assert.equal(ignoredV2.ok, true);
  assert.equal(ignoredV2.status, "ignored_v2");
  assert.equal(ignoredV2.routes, null);
});

test("project routes schema accepts phase defaults and rejects malformed actors", () => {
  const normalized = validateProjectRoutes({
    version: 1,
    defaults: {
      dispatch: { executor: "pi", model: "example/pi-model-fast" },
      review: { reviewer: "codex" },
      advisory_review: { reviewer: "opencode", model: "example/opencode-model-cheap", profile: "blindspot" },
    },
  }, "routes.json");

  assert.deepEqual(normalized.defaults.review, { reviewer: "codex" });
  assert.deepEqual(normalized.defaults.advisory_review, [{
    reviewer: "opencode",
    model: "example/opencode-model-cheap",
    profile: "blindspot",
    trigger: "every_round",
    gating: false,
  }]);

  assert.deepEqual(validateProjectRoutes({
    version: 1,
    defaults: {
      advisory_review: [
        { reviewer: "opencode", model: "example/opencode-model-fast", gating: true },
        { reviewer: "pi", model: "openai/gpt-5", trigger: "on_pass" },
      ],
    },
  }, "routes.json").defaults.advisory_review, [
    {
      reviewer: "opencode",
      model: "example/opencode-model-fast",
      profile: "blindspot",
      trigger: "every_round",
      gating: true,
    },
    {
      reviewer: "pi",
      model: "openai/gpt-5",
      profile: "blindspot",
      trigger: "on_pass",
      gating: false,
    },
  ]);

  assert.throws(
    () => validateProjectRoutes({
      version: 1,
      defaults: { dispatch: { reviewer: "codex" } },
    }, "routes.json"),
    /defaults\.dispatch\.executor must be a non-empty string/
  );
});

test("routing applies profile-aware advisory lane defaults and preserves explicit values", () => {
  assert.deepEqual(validateProjectRoutes({
    version: 1,
    defaults: {
      advisory_review: [
        { reviewer: "blind", model: "openai/blind", profile: "blindspot" },
        { reviewer: "attack", model: "openai/attack", profile: "adversarial" },
        { reviewer: "explicit", model: "openai/explicit", profile: "adversarial", trigger: "every_round", gating: false },
      ],
    },
  }, "routes.json").defaults.advisory_review, [
    {
      reviewer: "blind",
      model: "openai/blind",
      profile: "blindspot",
      trigger: "every_round",
      gating: false,
    },
    {
      reviewer: "attack",
      model: "openai/attack",
      profile: "adversarial",
      trigger: "on_pass",
      gating: true,
    },
    {
      reviewer: "explicit",
      model: "openai/explicit",
      profile: "adversarial",
      trigger: "every_round",
      gating: false,
    },
  ]);
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

test("route config loader accepts global-only routes config", () => {
  const { relayHome, repoRoot } = tempRepo();
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: false,
    defaults: {
      dispatch: { executor: "opencode" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    executor_defaults: {
      opencode: { model: "openai/global" },
    },
    routes: [
      { route: "openai/global", phases: ["dispatch"], executors: ["opencode"] },
    ],
    denied_routes: [],
    presets: {},
  });

  const result = loadRouteConfig({ repoRoot, relayHome });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.config.strict, false);
  assert.deepEqual(result.config.defaults.dispatch, { executor: "opencode" });
  assert.deepEqual(result.config.executor_defaults.opencode, { model: "openai/global" });
  assert.deepEqual(result.config.routes.map((entry) => entry.route), ["openai/global"]);
});

test("project-only v2 routes config stays inactive without a global routes file", () => {
  const { relayHome, repoRoot } = tempRepo();
  writeJson(getProjectRoutesPath(repoRoot, { relayHome }), {
    version: 2,
    strict: true,
    defaults: {
      dispatch: { executor: "pi", model: "openai/project" },
    },
    executor_defaults: {
      pi: { model: "openai/project" },
    },
    routes: [
      { route: "openai/project", phases: ["dispatch"], executors: ["pi"] },
    ],
    denied_routes: [],
    presets: {},
  });

  // DC #781 A1 §3: without the GLOBAL routes.json, legacy precedence holds;
  // a project-only routes file must not become the source of truth.
  const result = loadRouteConfig({ repoRoot, relayHome });

  assert.equal(result.ok, true);
  assert.equal(result.status, "absent");
  assert.equal(result.config, null);

  // Even a malformed project routes file must not break anything while the
  // global file is absent — the routes-config world is inert.
  fs.writeFileSync(getProjectRoutesPath(repoRoot, { relayHome }), "{not-json\n", "utf-8");
  const malformed = loadRouteConfig({ repoRoot, relayHome });
  assert.equal(malformed.ok, true);
  assert.equal(malformed.status, "absent");
  assert.equal(malformed.config, null);
});

test("project null model does not erase inherited global dispatch model", () => {
  const { relayHome, repoRoot } = tempRepo();
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    defaults: {
      dispatch: { executor: "opencode", model: "openai/global-model" },
    },
  });
  writeJson(getProjectRoutesPath(repoRoot, { relayHome }), {
    version: 2,
    defaults: {
      dispatch: { model: null },
    },
  });

  const result = loadRouteConfig({ repoRoot, relayHome });

  assert.equal(result.ok, true);
  assert.deepEqual(result.config.defaults.dispatch, {
    executor: "opencode",
    model: "openai/global-model",
  });
});

test("route config rejects non-object preset values", () => {
  assert.throws(
    () => validateRouteConfig({ version: 2, presets: { light: "opencode" } }, "unit"),
    /presets\.light must be an object/
  );
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
  assert.deepEqual(result.config.presets.diverse.advisory_review, [{
    reviewer: "pi",
    profile: "blindspot",
    trigger: "every_round",
    gating: false,
  }]);
});

test("route config loader accepts project v1 routes when global v2 routes is source of truth", () => {
  const { relayHome, repoRoot } = tempRepo();
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: false,
    defaults: {
      dispatch: { executor: "opencode" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    executor_defaults: {
      opencode: { model: "openai/global" },
    },
    routes: [
      { route: "openai/global", phases: ["dispatch"], executors: ["opencode"] },
    ],
    denied_routes: [],
    presets: {},
  });
  writeJson(getProjectRoutesPath(repoRoot, { relayHome }), {
    version: 1,
    defaults: {
      dispatch: { executor: "pi", model: "openai/project-v1" },
      review: { reviewer: "codex" },
    },
  });

  const result = loadRouteConfig({ repoRoot, relayHome });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.config.strict, false);
  assert.deepEqual(result.config.defaults.dispatch, { executor: "pi", model: "openai/project-v1" });
  assert.deepEqual(result.config.defaults.review, { reviewer: "codex" });
  assert.deepEqual(result.config.executor_defaults.opencode, { model: "openai/global" });
  assert.deepEqual(result.config.routes.map((entry) => entry.route), ["openai/global"]);
});

test("project routes that omit strict inherit global strict mode", () => {
  const { relayHome, repoRoot } = tempRepo();
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: true,
    routes: [
      { route: "openai/global", phases: ["dispatch"], executors: ["opencode"] },
    ],
  });
  writeJson(getProjectRoutesPath(repoRoot, { relayHome }), {
    version: 2,
    executor_defaults: {
      pi: { model: "openai/project" },
    },
  });

  const result = loadRouteConfig({ repoRoot, relayHome });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.config.strict, true);

  const explicitOverride = loadRouteConfig({
    repoRoot,
    relayHome,
    projectRoutes: { version: 2, strict: false },
  });
  assert.equal(explicitOverride.ok, true);
  assert.equal(explicitOverride.config.strict, false);

  // v1 project routes have no strict concept and must inherit global strict too.
  const v1Project = loadRouteConfig({
    repoRoot,
    relayHome,
    projectRoutes: {
      version: 1,
      defaults: {
        dispatch: { executor: "pi", model: "openai/project-v1" },
      },
    },
  });
  assert.equal(v1Project.ok, true);
  assert.equal(v1Project.config.strict, true);
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

test("partial project advisory default overlays the model onto the policy lane", () => {
  const result = resolveRouteIntent({
    projectRoutes: {
      version: 2,
      defaults: {
        advisory_review: { model: "example/opencode-model-fast" },
      },
    },
    policy: routePolicy({
      defaults: {
        dispatch: { executor: "codex" },
        review: { reviewer: "codex" },
        advisory_review: { reviewer: "opencode", model: "example/opencode-model-cheap" },
      },
      allowed_model_routes: [
        { route: "example/opencode-model-*", phases: ["advisory_review"], reviewers: ["opencode"] },
      ],
    }),
  });

  assert.equal(result.phases.advisory_review[0].reviewer, "opencode");
  assert.equal(result.phases.advisory_review[0].model, "example/opencode-model-fast");
  assert.equal(result.phases.advisory_review[0].sources.model, "project_routes");
});

test("partial project advisory default composes with an inherited single global lane at merge time", () => {
  const result = resolveRouteIntent({
    projectRoutes: {
      version: 2,
      defaults: {
        advisory_review: { model: "example/opencode-model-fast" },
      },
    },
    policy: routePolicy({
      defaults: {
        dispatch: { executor: "codex" },
        review: { reviewer: "codex" },
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-cheap" },
        ],
      },
      allowed_model_routes: [
        { route: "example/opencode-model-*", phases: ["advisory_review"], reviewers: ["opencode"] },
      ],
    }),
  });

  assert.equal(result.phases.advisory_review[0].reviewer, "opencode");
  assert.equal(result.phases.advisory_review[0].model, "example/opencode-model-fast");
});

test("partial advisory default over a multi-lane list fails closed", () => {
  assert.throws(() => resolveRouteIntent({
    projectRoutes: {
      version: 2,
      defaults: {
        advisory_review: { model: "example/opencode-model-fast" },
      },
    },
    policy: routePolicy({
      defaults: {
        dispatch: { executor: "codex" },
        review: { reviewer: "codex" },
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-cheap" },
          { reviewer: "pi", model: "example/pi-model-fast" },
        ],
      },
    }),
  }), /cannot overlay the multi-lane list/);
});

test("partial advisory preset object is rejected", () => {
  assert.throws(() => resolveRouteIntent({
    routePresetName: "light",
    policy: routePolicy({
      presets: {
        light: {
          advisory_review: { model: "example/pi-model-fast" },
        },
      },
    }),
  }), /advisory_review must be a full lane or lane list/);
});

test("run intent advisory model overlay composes with a single-lane preset", () => {
  const result = resolveRouteIntent({
    runIntent: {
      advisory_review: { model: "example/pi-model-large" },
    },
    routePresetName: "light",
    policy: routePolicy({
      presets: {
        light: {
          advisory_review: { reviewer: "pi", model: "example/pi-model-fast", profile: "blindspot" },
        },
      },
      allowed_model_routes: [
        { route: "example/pi-model-*", phases: ["advisory_review"], reviewers: ["pi"] },
      ],
    }),
  });

  assert.equal(result.phases.advisory_review[0].reviewer, "pi");
  assert.equal(result.phases.advisory_review[0].model, "example/pi-model-large");
});

test("advisory lane without model falls back to a legacy single-object default's model", () => {
  const result = resolveRouteIntent({
    runIntent: {
      advisory_review: [{ reviewer: "opencode" }],
    },
    policy: routePolicy({
      defaults: {
        dispatch: { executor: "codex" },
        review: { reviewer: "codex" },
        advisory_review: { reviewer: "opencode", model: "example/opencode-model-cheap" },
      },
      allowed_model_routes: [
        { route: "example/opencode-model-*", phases: ["advisory_review"], reviewers: ["opencode"] },
      ],
    }),
  });

  assert.equal(result.phases.advisory_review[0].reviewer, "opencode");
  assert.equal(result.phases.advisory_review[0].model, "example/opencode-model-cheap");
  assert.equal(result.phases.advisory_review[0].sources.model, "policy_defaults");
});

test("route preset expansion fills only unset run intent fields with preset sources", () => {
  const result = resolveRouteIntent({
    runIntent: {
      dispatch: { executor: "codex" },
    },
    routePresetName: "light",
    policy: routePolicy({
      presets: {
        light: {
          dispatch: { executor: "opencode", model: "example/opencode-model-fast" },
          advisory_review: { reviewer: "pi", model: "example/pi-model-fast", profile: "blindspot" },
        },
      },
      allowed_model_routes: [
        { route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] },
        { route: "example/pi-model-*", phases: ["advisory_review"], reviewers: ["pi"] },
      ],
    }),
  });

  assert.equal(result.route_preset.name, "light");
  assert.equal(result.phases.dispatch.executor, "codex");
  assert.equal(result.phases.dispatch.sources.executor, "run_intent");
  assert.equal(result.phases.dispatch.model, "example/opencode-model-fast");
  assert.equal(result.phases.dispatch.sources.model, "preset:light");
  assert.equal(result.phases.advisory_review[0].reviewer, "pi");
  assert.equal(result.phases.advisory_review[0].sources.reviewer, "preset:light");
  assert.equal(result.phases.advisory_review[0].profile, "blindspot");
  assert.equal(result.phases.advisory_review[0].trigger, "every_round");
  assert.equal(result.phases.advisory_review[0].gating, false);
  assert.equal(result.phases.advisory_review[0].sources.profile, "preset:light");
});

test("route intent resolver preserves advisory lane lists from policy defaults", () => {
  const result = resolveRouteIntent({
    policy: routePolicy({
      defaults: {
        dispatch: { executor: "codex" },
        review: { reviewer: "codex" },
        advisory_review: [
          { reviewer: "opencode", model: "example/opencode-model-fast", gating: true },
          { reviewer: "pi", model: "openai/gpt-5", trigger: "on_pass" },
        ],
      },
      allowed_model_routes: [
        { route: "example/opencode-model-*", phases: ["advisory_review"], reviewers: ["opencode"] },
        { route: "openai/*", phases: ["advisory_review"], reviewers: ["pi"] },
      ],
    }),
  });

  assert.deepEqual(result.phases.advisory_review.map(({ reviewer, model, profile, trigger, gating, source }) => ({
    reviewer,
    model,
    profile,
    trigger,
    gating,
    source,
  })), [
    {
      reviewer: "opencode",
      model: "example/opencode-model-fast",
      profile: "blindspot",
      trigger: "every_round",
      gating: true,
      source: "policy_defaults",
    },
    {
      reviewer: "pi",
      model: "openai/gpt-5",
      profile: "blindspot",
      trigger: "on_pass",
      gating: false,
      source: "policy_defaults",
    },
  ]);
});

test("route preset expansion carries model resolution metadata with resolved model", () => {
  const result = resolveRouteIntent({
    routePresetName: "light",
    policy: routePolicy({
      presets: {
        light: {
          dispatch: { executor: "opencode", model: "opencode-go/glm-5.2" },
          model_resolution: {
            dispatch: {
              original_input: "opencode:glm-5.2",
              actor: "opencode",
              phase: "dispatch",
              resolved_route: "opencode-go/glm-5.2",
              source: "live_probe",
              candidates: ["opencode-go/glm-5.2"],
              warnings: [],
            },
          },
        },
      },
      allowed_model_routes: [
        { route: "opencode-go/*", phases: ["dispatch"], executors: ["opencode"] },
      ],
    }),
  });

  assert.equal(result.phases.dispatch.model, "opencode-go/glm-5.2");
  assert.equal(result.phases.dispatch.model_resolution.original_input, "opencode:glm-5.2");
  assert.equal(result.phases.dispatch.model_resolution.source, "live_probe");
});

test("route preset expansion carries advisory model resolution metadata onto preset lanes", () => {
  const result = resolveRouteIntent({
    routePresetName: "diverse",
    policy: routePolicy({
      presets: {
        diverse: {
          advisory_review: {
            reviewer: "cline",
            model: "cline-pass/glm-5.2",
            profile: "blindspot",
          },
          model_resolution: {
            advisory_review: {
              original_input: "cline:glm-5.2",
              actor: "cline",
              actor_field: "reviewer",
              phase: "advisory_review",
              requested_model: "glm-5.2",
              resolved_route: "cline-pass/glm-5.2",
              source: "catalog_fallback",
              candidates: ["cline-pass/glm-5.2"],
              warnings: ["catalog fallback"],
            },
          },
        },
      },
      allowed_model_routes: [
        { route: "cline-pass/*", phases: ["advisory_review"], reviewers: ["cline"] },
      ],
    }),
  });

  assert.equal(result.phases.advisory_review[0].reviewer, "cline");
  assert.equal(result.phases.advisory_review[0].model, "cline-pass/glm-5.2");
  assert.equal(result.phases.advisory_review[0].model_resolution.original_input, "cline:glm-5.2");
  assert.equal(result.phases.advisory_review[0].model_resolution.source, "catalog_fallback");
});

test("route preset expansion errors with available presets when missing or unconfigured", () => {
  assert.throws(
    () => resolveRouteIntent({
      routePresetName: "missing",
      policy: routePolicy({
        presets: {
          light: { dispatch: { executor: "codex" } },
          hardened: { review_assurance: "hardened" },
        },
      }),
    }),
    /unknown route preset 'missing'.*available presets: hardened, light/
  );

  assert.throws(
    () => resolveRouteIntent({
      routePresetName: "light",
      policy: routePolicy(),
    }),
    /no route presets configured.*relay-config/
  );
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
