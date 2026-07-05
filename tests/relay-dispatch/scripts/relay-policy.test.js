const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildDefaultRelayPolicy,
  evaluateRelayRoute,
  loadRelayPolicy,
  matchRoutePattern,
  validateRelayPolicy,
} = require("../../../skills/relay-dispatch/scripts/relay-policy");
const { getProjectPolicyPath, getProjectRoutesPath } = require("../../../skills/relay-dispatch/scripts/manifest/paths");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-"));
}

function initGitRepo(repoRoot) {
  require("child_process").execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
  return filePath;
}

function policy(overrides = {}) {
  return {
    ...buildDefaultRelayPolicy(),
    ...overrides,
  };
}

test("loadRelayPolicy uses open built-in defaults when config is missing", () => {
  const relayHome = tempDir();

  const result = loadRelayPolicy({ relayHome });

  assert.equal(result.ok, true);
  assert.equal(result.status, "defaulted");
  assert.deepEqual(result.policy.managed_cli, ["codex", "claude", "cursor"]);
  assert.deepEqual(result.policy.allowed_model_routes, []);
  assert.equal(result.policy.deny_unknown_model_routes, false);

  assert.deepEqual(
    evaluateRelayRoute(result.policy, { phase: "dispatch", executor: "codex" }),
    {
      allowed: true,
      reason: "managed_cli",
      phase: "dispatch",
      actor: "codex",
      model: null,
      matchedRoute: null,
    }
  );

  assert.equal(
    evaluateRelayRoute(result.policy, {
      phase: "dispatch",
      executor: "opencode",
      model: "openai/gpt-5",
    }).reason,
    "unknown_allowed"
  );
});

test("global routes config maps to policy shape and ignores legacy policy files", () => {
  const relayHome = tempDir();
  const repoRoot = tempDir();
  initGitRepo(repoRoot);
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: false,
    defaults: {
      dispatch: { executor: "opencode" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    routes: [
      { route: "openai/registered", phases: ["dispatch"], executors: ["opencode"] },
    ],
    denied_routes: [
      { route: "openai/denied", phases: ["dispatch"], executors: ["opencode"] },
    ],
    presets: {
      light: { dispatch: { executor: "opencode", model: "openai/registered" } },
    },
  });
  writeJson(path.join(relayHome, "policy.json"), policy({
    profile: "legacy-global-should-be-ignored",
    deny_unknown_model_routes: true,
    allowed_model_routes: [],
  }));
  writeJson(path.join(repoRoot, ".relay", "policy.json"), policy({
    profile: "legacy-repo-should-be-ignored",
    deny_unknown_model_routes: true,
    denied_model_routes: ["openai/registered"],
  }));
  writeJson(getProjectPolicyPath(repoRoot, { relayHome }), policy({
    profile: "legacy-project-should-be-ignored",
    deny_unknown_model_routes: true,
    denied_model_routes: ["openai/registered"],
  }));

  const result = loadRelayPolicy({ relayHome, repoRoot });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.policy.profile, "routes-config");
  assert.equal(result.policy.deny_unknown_model_routes, false);
  assert.deepEqual(result.policy.allowed_model_routes.map((entry) => entry.route), ["openai/registered"]);
  assert.deepEqual(result.policy.denied_model_routes.map((entry) => entry.route), ["openai/denied"]);
  assert.deepEqual(result.policy.presets.light.dispatch, {
    executor: "opencode",
    model: "openai/registered",
  });
  assert.equal(evaluateRelayRoute(result.policy, {
    phase: "dispatch",
    executor: "opencode",
    model: "openai/registered",
  }).reason, "allowed_model_route");
  assert.equal(evaluateRelayRoute(result.policy, {
    phase: "dispatch",
    executor: "opencode",
    model: "openai/unregistered",
  }).reason, "unknown_allowed");
  assert.equal(evaluateRelayRoute(result.policy, {
    phase: "dispatch",
    executor: "opencode",
    model: "openai/denied",
  }).reason, "denied_model_route");
});

test("project routes v2 can opt a repo into strict mode over global open routes", () => {
  const relayHome = tempDir();
  const repoRoot = tempDir();
  initGitRepo(repoRoot);
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: false,
    defaults: {
      dispatch: { executor: "opencode" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    routes: [
      { route: "openai/registered", phases: ["dispatch"], executors: ["opencode"] },
    ],
    denied_routes: [],
    presets: {},
  });
  writeJson(getProjectRoutesPath(repoRoot, { relayHome }), {
    version: 2,
    strict: true,
    defaults: {
      dispatch: { executor: "opencode", model: "openai/registered" },
    },
  });

  const result = loadRelayPolicy({ relayHome, repoRoot });

  assert.equal(result.ok, true);
  assert.equal(result.policy.deny_unknown_model_routes, true);
  assert.equal(evaluateRelayRoute(result.policy, {
    phase: "dispatch",
    executor: "opencode",
    model: "openai/registered",
  }).reason, "allowed_model_route");
  assert.equal(evaluateRelayRoute(result.policy, {
    phase: "dispatch",
    executor: "opencode",
    model: "openai/unregistered",
  }).reason, "unknown_model_route");
});

test("malformed global policy load fails closed with status and errors", () => {
  const relayHome = tempDir();
  writeJson(path.join(relayHome, "policy.json"), {
    version: 1,
    profile: "broken",
    defaults: {},
    managed_cli: "codex",
    allowed_model_routes: [],
    denied_model_routes: [],
    routing_rules: [],
    deny_unknown_model_routes: true,
  });

  const result = loadRelayPolicy({ relayHome });

  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.equal(result.policy, null);
  assert.equal(result.errors[0].reason, "invalid_policy");
  assert.match(result.errors[0].message, /defaults\.dispatch is required/);
});

test("validateRelayPolicy rejects invalid v1 schema shapes", () => {
  assert.throws(
    () => validateRelayPolicy([], "bad.json"),
    /expected object/
  );
  assert.throws(
    () => validateRelayPolicy({ ...buildDefaultRelayPolicy(), version: 2 }, "bad.json"),
    /version must be 1/
  );
  assert.throws(
    () => validateRelayPolicy({ ...buildDefaultRelayPolicy(), managed_cli: "codex" }, "bad.json"),
    /managed_cli must be an array/
  );
  assert.throws(
    () =>
      validateRelayPolicy(
        {
          ...buildDefaultRelayPolicy(),
          allowed_model_routes: [{ route: "example/*", phases: "dispatch" }],
        },
        "bad.json"
      ),
    /allowed_model_routes\[0\]\.phases must be an array/
  );
});

test("global-only policy allows matching model routes and denies unknown routes", () => {
  const relayHome = tempDir();
  writeJson(
    path.join(relayHome, "policy.json"),
    policy({
      profile: "global-only",
      managed_cli: ["codex"],
      allowed_model_routes: [
        {
          route: "example/*",
          phases: ["dispatch"],
          executors: ["opencode"],
        },
      ],
    })
  );

  const result = loadRelayPolicy({ relayHome });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(
    evaluateRelayRoute(result.policy, {
      phase: "dispatch",
      executor: "opencode",
      model: "example/opencode-model-5",
    }).reason,
    "allowed_model_route"
  );
  assert.equal(
    evaluateRelayRoute(result.policy, {
      phase: "dispatch",
      executor: "opencode",
      model: "openai/gpt-5",
    }).reason,
    "unknown_model_route"
  );
  assert.equal(
    evaluateRelayRoute(result.policy, { phase: "review", reviewer: "claude" }).reason,
    "missing_model_route"
  );
});

test("RELAY_POLICY_PATH overrides the default global policy path", () => {
  const relayHome = tempDir();
  const policyPath = writeJson(
    path.join(tempDir(), "custom-policy.json"),
    policy({
      profile: "env-global",
      managed_cli: ["codex"],
    })
  );
  const previousPolicyPath = process.env.RELAY_POLICY_PATH;

  process.env.RELAY_POLICY_PATH = policyPath;
  try {
    const result = loadRelayPolicy({ relayHome });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ok");
    assert.equal(result.policy.profile, "env-global");
    assert.equal(result.sources.global, policyPath);
    assert.deepEqual(result.policy.managed_cli, ["codex"]);
  } finally {
    if (previousPolicyPath === undefined) {
      delete process.env.RELAY_POLICY_PATH;
    } else {
      process.env.RELAY_POLICY_PATH = previousPolicyPath;
    }
  }
});

test("repo-local policy can narrow managed CLIs, allowed routes, and unknown-route behavior", () => {
  const relayHome = tempDir();
  const repoRoot = tempDir();
  writeJson(
    path.join(relayHome, "policy.json"),
    policy({
      profile: "global",
      deny_unknown_model_routes: false,
      allowed_model_routes: [
        {
          route: "example/*",
          phases: ["dispatch", "review"],
          executors: ["opencode"],
          reviewers: ["opencode"],
        },
      ],
    })
  );
  writeJson(
    path.join(repoRoot, ".relay", "policy.json"),
    policy({
      profile: "repo",
      managed_cli: ["codex"],
      deny_unknown_model_routes: true,
      allowed_model_routes: [
        {
          route: "example/opencode-model-*",
          phases: ["dispatch"],
          executors: ["opencode"],
        },
      ],
      denied_model_routes: ["example/opencode-model-bad"],
    })
  );

  const result = loadRelayPolicy({ relayHome, repoRoot });

  assert.equal(result.ok, true);
  assert.equal(result.policy.profile, "repo");
  assert.deepEqual(result.policy.managed_cli, ["codex"]);
  assert.equal(
    evaluateRelayRoute(result.policy, {
      phase: "dispatch",
      executor: "opencode",
      model: "example/opencode-model-5",
    }).reason,
    "allowed_model_route"
  );
  assert.equal(
    evaluateRelayRoute(result.policy, {
      phase: "review",
      reviewer: "opencode",
      model: "example/opencode-model-5",
    }).reason,
    "unknown_model_route"
  );
  assert.equal(
    evaluateRelayRoute(result.policy, { phase: "review", reviewer: "claude" }).reason,
    "missing_model_route"
  );
});

test("repo-local policy that widens global policy is rejected", () => {
  const relayHome = tempDir();
  const repoRoot = tempDir();
  writeJson(
    path.join(relayHome, "policy.json"),
    policy({
      profile: "global",
      managed_cli: ["codex"],
      allowed_model_routes: [{ route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] }],
    })
  );
  writeJson(
    path.join(repoRoot, ".relay", "policy.json"),
    policy({
      profile: "repo",
      managed_cli: ["codex", "claude"],
      allowed_model_routes: [{ route: "example/*", phases: ["dispatch"], executors: ["opencode"] }],
    })
  );

  const result = loadRelayPolicy({ relayHome, repoRoot });

  assert.equal(result.ok, false);
  assert.equal(result.policy, null);
  assert.equal(result.errors[0].reason, "repo_policy_widens_global_policy");
});

test("project-local policy narrows globally allowed provider routes", () => {
  const relayHome = tempDir();
  const repoRoot = tempDir();
  initGitRepo(repoRoot);
  writeJson(
    path.join(relayHome, "policy.json"),
    policy({
      profile: "global",
      allowed_model_routes: [{ route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] }],
    })
  );
  writeJson(
    getProjectPolicyPath(repoRoot, { relayHome }),
    policy({
      profile: "project",
      allowed_model_routes: [{ route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] }],
    })
  );

  const result = loadRelayPolicy({ relayHome, repoRoot });

  assert.equal(result.ok, true);
  assert.equal(result.policy.profile, "project");
  assert.equal(result.sources.project, getProjectPolicyPath(repoRoot, { relayHome }));
  assert.equal(evaluateRelayRoute(result, {
    phase: "dispatch",
    executor: "opencode",
    model: "example/opencode-model-fast",
  }).reason, "allowed_model_route");
  assert.equal(evaluateRelayRoute(result, {
    phase: "dispatch",
    executor: "opencode",
    model: "example/opencode-other",
  }).reason, "unknown_model_route");
});

test("project-local policy cannot widen or remove inherited deny routes", () => {
  const relayHome = tempDir();
  const repoRoot = tempDir();
  initGitRepo(repoRoot);
  writeJson(
    path.join(relayHome, "policy.json"),
    policy({
      profile: "global",
      managed_cli: ["codex"],
      allowed_model_routes: [{ route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] }],
      denied_model_routes: [{ route: "example/opencode-model-bad", phases: ["dispatch"], executors: ["opencode"] }],
    })
  );

  writeJson(
    getProjectPolicyPath(repoRoot, { relayHome }),
    policy({
      profile: "project",
      managed_cli: ["codex", "claude"],
      allowed_model_routes: [{ route: "example/*", phases: ["dispatch"], executors: ["opencode"] }],
      denied_model_routes: [],
    })
  );

  const result = loadRelayPolicy({ relayHome, repoRoot });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].reason, "project_policy_widens_effective_policy");
  assert.equal(result.errors[0].source, getProjectPolicyPath(repoRoot, { relayHome }));
});

test("denied model routes win over allowed model routes", () => {
  const currentPolicy = policy({
    allowed_model_routes: ["example/*"],
    denied_model_routes: ["example/opencode-model-bad"],
  });

  const decision = evaluateRelayRoute(currentPolicy, {
    phase: "dispatch",
    executor: "opencode",
    model: "example/opencode-model-bad",
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "denied_model_route");
  assert.equal(decision.matchedRoute, "example/opencode-model-bad");
});

test("route actor scopes are bound to the evaluated phase", () => {
  const currentPolicy = policy({
    allowed_model_routes: [
      {
        route: "example/*",
        phases: ["review"],
        executors: ["opencode"],
      },
      {
        route: "example/*",
        phases: ["review"],
        reviewers: ["codex"],
      },
    ],
  });

  assert.equal(
    evaluateRelayRoute(currentPolicy, {
      phase: "review",
      executor: "opencode",
      reviewer: "opencode",
      model: "example/opencode-model-5",
    }).reason,
    "unknown_model_route"
  );
  assert.equal(
    evaluateRelayRoute(currentPolicy, {
      phase: "review",
      executor: "opencode",
      reviewer: "codex",
      model: "example/opencode-model-5",
    }).reason,
    "allowed_model_route"
  );
});

test("unknown route denial can be explicitly disabled for non-managed executors", () => {
  const currentPolicy = policy({
    deny_unknown_model_routes: false,
  });

  assert.equal(
    evaluateRelayRoute(currentPolicy, { phase: "dispatch", executor: "opencode" }).reason,
    "unknown_allowed"
  );
  assert.equal(
    evaluateRelayRoute(currentPolicy, {
      phase: "dispatch",
      executor: "opencode",
      model: "provider/model",
    }).reason,
    "unknown_allowed"
  );
});

test("matchRoutePattern supports simple star globs", () => {
  assert.equal(matchRoutePattern("example/*", "example/opencode-model-5"), true);
  assert.equal(matchRoutePattern("example/opencode-model-*", "example/opencode-model-5"), true);
  assert.equal(matchRoutePattern("example/opencode-model-*", "example/opencode-qwen-3"), false);
});
