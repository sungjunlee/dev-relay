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

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-"));
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

test("loadRelayPolicy uses managed Codex and Claude defaults when config is missing", () => {
  const relayHome = tempDir();

  const result = loadRelayPolicy({ relayHome });

  assert.equal(result.ok, true);
  assert.equal(result.status, "defaulted");
  assert.deepEqual(result.policy.managed_cli, ["codex", "claude"]);
  assert.deepEqual(result.policy.allowed_model_routes, []);
  assert.equal(result.policy.deny_unknown_model_routes, true);

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
    evaluateRelayRoute(result.policy, { phase: "dispatch", executor: "opencode" }).reason,
    "missing_model_route"
  );
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
          allowed_model_routes: [{ route: "kakao/*", phases: "dispatch" }],
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
          route: "kakao/*",
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
      model: "kakao/opencode-glm-5",
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
          route: "kakao/*",
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
          route: "kakao/opencode-glm-*",
          phases: ["dispatch"],
          executors: ["opencode"],
        },
      ],
      denied_model_routes: ["kakao/opencode-glm-bad"],
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
      model: "kakao/opencode-glm-5",
    }).reason,
    "allowed_model_route"
  );
  assert.equal(
    evaluateRelayRoute(result.policy, {
      phase: "review",
      reviewer: "opencode",
      model: "kakao/opencode-glm-5",
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
      allowed_model_routes: [{ route: "kakao/opencode-glm-*", phases: ["dispatch"], executors: ["opencode"] }],
    })
  );
  writeJson(
    path.join(repoRoot, ".relay", "policy.json"),
    policy({
      profile: "repo",
      managed_cli: ["codex", "claude"],
      allowed_model_routes: [{ route: "kakao/*", phases: ["dispatch"], executors: ["opencode"] }],
    })
  );

  const result = loadRelayPolicy({ relayHome, repoRoot });

  assert.equal(result.ok, false);
  assert.equal(result.policy, null);
  assert.equal(result.errors[0].reason, "repo_policy_widens_global_policy");
});

test("denied model routes win over allowed model routes", () => {
  const currentPolicy = policy({
    allowed_model_routes: ["kakao/*"],
    denied_model_routes: ["kakao/opencode-glm-bad"],
  });

  const decision = evaluateRelayRoute(currentPolicy, {
    phase: "dispatch",
    executor: "opencode",
    model: "kakao/opencode-glm-bad",
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "denied_model_route");
  assert.equal(decision.matchedRoute, "kakao/opencode-glm-bad");
});

test("route actor scopes are bound to the evaluated phase", () => {
  const currentPolicy = policy({
    allowed_model_routes: [
      {
        route: "kakao/*",
        phases: ["review"],
        executors: ["opencode"],
      },
      {
        route: "kakao/*",
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
      model: "kakao/opencode-glm-5",
    }).reason,
    "unknown_model_route"
  );
  assert.equal(
    evaluateRelayRoute(currentPolicy, {
      phase: "review",
      executor: "opencode",
      reviewer: "codex",
      model: "kakao/opencode-glm-5",
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
  assert.equal(matchRoutePattern("kakao/*", "kakao/opencode-glm-5"), true);
  assert.equal(matchRoutePattern("kakao/opencode-glm-*", "kakao/opencode-glm-5"), true);
  assert.equal(matchRoutePattern("kakao/opencode-glm-*", "kakao/opencode-qwen-3"), false);
});
