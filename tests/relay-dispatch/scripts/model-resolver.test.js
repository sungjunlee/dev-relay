const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveModelRequest,
} = require("../../../skills/relay-dispatch/scripts/model-resolver");
const { buildDefaultRelayPolicy } = require("../../../skills/relay-dispatch/scripts/relay-policy");

function policy(overrides = {}) {
  return {
    ...buildDefaultRelayPolicy(),
    ...overrides,
  };
}

test("model resolver preserves explicit provider/model routes without probing", () => {
  let probed = false;
  const result = resolveModelRequest({
    phase: "review",
    actor: "opencode",
    actorField: "reviewer",
    model: "opencode-go/glm-5.2",
    policy: policy({
      allowed_model_routes: [
        { route: "opencode-go/*", phases: ["review"], reviewers: ["opencode"] },
      ],
    }),
    probeModels: () => {
      probed = true;
      return { status: "ok", models: [] };
    },
  });

  assert.equal(probed, false);
  assert.equal(result.ok, true);
  assert.equal(result.resolved_route, "opencode-go/glm-5.2");
  assert.equal(result.source, "explicit_route");
  assert.equal(result.policy_decision.reason, "allowed_model_route");
});

test("model resolver uses live probe for exact short model matches", () => {
  const result = resolveModelRequest({
    phase: "dispatch",
    actor: "opencode",
    actorField: "executor",
    model: "glm-5.2",
    policy: policy({
      allowed_model_routes: [
        { route: "opencode-go/*", phases: ["dispatch"], executors: ["opencode"] },
      ],
    }),
    probeModels: () => ({
      status: "ok",
      models: ["opencode-go/glm-5.2", "openai/gpt-5.3-codex-spark"],
      warning: null,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolved_route, "opencode-go/glm-5.2");
  assert.equal(result.source, "live_probe");
  assert.deepEqual(result.candidates, ["opencode-go/glm-5.2"]);
});

test("model resolver keeps managed codex model-less routes model-less", () => {
  const result = resolveModelRequest({
    phase: "dispatch",
    actor: "codex",
    actorField: "executor",
    policy: policy(),
    probeModels: () => {
      throw new Error("model-less managed defaults must not probe");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolved_route, null);
  assert.equal(result.source, "model_less");
  assert.equal(result.policy_decision.reason, "managed_cli");
});

test("model resolver returns structured ambiguous_model diagnostics", () => {
  const result = resolveModelRequest({
    phase: "dispatch",
    actor: "opencode",
    actorField: "executor",
    model: "glm-5.2",
    policy: policy({ deny_unknown_model_routes: false }),
    probeModels: () => ({
      status: "ok",
      models: ["opencode-go/glm-5.2", "openrouter/glm-5.2"],
      warning: null,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "ambiguous_model");
  assert.deepEqual(result.candidates, ["opencode-go/glm-5.2", "openrouter/glm-5.2"]);
  assert.equal(result.resolved_route, null);
});

test("model resolver uses actor-scoped catalog fallback only when requested", () => {
  const withoutFallback = resolveModelRequest({
    phase: "dispatch",
    actor: "cline",
    actorField: "executor",
    model: "glm-5.2",
    policy: policy({ deny_unknown_model_routes: false }),
    probeModels: () => ({ status: "not_applicable", models: [], warning: null }),
  });
  assert.equal(withoutFallback.ok, false);
  assert.equal(withoutFallback.error, "model_probe_unavailable");

  const withFallback = resolveModelRequest({
    phase: "dispatch",
    actor: "cline",
    actorField: "executor",
    model: "glm-5.2",
    fallback: "catalog",
    policy: policy({ deny_unknown_model_routes: false }),
    probeModels: () => ({ status: "not_applicable", models: [], warning: null }),
  });

  assert.equal(withFallback.ok, true);
  assert.equal(withFallback.resolved_route, "cline-pass/glm-5.2");
  assert.equal(withFallback.source, "catalog_fallback");
  assert.match(withFallback.warnings.join("\n"), /catalog fallback/i);
});

test("model resolver marks stale catalog fallback metadata", () => {
  const result = resolveModelRequest({
    phase: "dispatch",
    actor: "cline",
    actorField: "executor",
    model: "glm-5.2",
    fallback: "catalog",
    now: new Date("2026-10-01T00:00:00Z"),
    policy: policy({ deny_unknown_model_routes: false }),
    probeModels: () => ({ status: "not_applicable", models: [], warning: null }),
  });

  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => /stale catalog/i.test(warning)));
});
