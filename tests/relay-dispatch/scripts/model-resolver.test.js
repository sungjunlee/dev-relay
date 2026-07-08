const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  resolveModelRequest,
} = require("../../../skills/relay-dispatch/scripts/model-resolver");
const { MODEL_CATALOG } = require("../../../skills/relay-dispatch/scripts/model-catalog");
const { buildDefaultRelayPolicy } = require("../../../skills/relay-dispatch/scripts/relay-policy");

function policy(overrides = {}) {
  return {
    ...buildDefaultRelayPolicy(),
    ...overrides,
  };
}

function tempDir(prefix = "relay-model-resolver-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
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

test("model resolver uses live probe for unambiguous fuzzy short model matches", () => {
  const result = resolveModelRequest({
    phase: "dispatch",
    actor: "opencode",
    actorField: "executor",
    model: "codex-spark",
    policy: policy({
      allowed_model_routes: [
        { route: "openai/*", phases: ["dispatch"], executors: ["opencode"] },
      ],
    }),
    probeModels: () => ({
      status: "ok",
      models: ["opencode-go/glm-5.2", "openai/gpt-5.3-codex-spark"],
      warning: null,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolved_route, "openai/gpt-5.3-codex-spark");
  assert.equal(result.source, "live_probe");
  assert.deepEqual(result.candidates, ["openai/gpt-5.3-codex-spark"]);
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

test("model resolver rejects unmanaged model-less actors with missing_model", () => {
  const result = resolveModelRequest({
    phase: "dispatch",
    actor: "opencode",
    actorField: "executor",
    policy: policy({ deny_unknown_model_routes: false }),
    probeModels: () => {
      throw new Error("missing unmanaged model must fail before probing");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_model");
  assert.equal(result.resolved_route, null);
  assert.equal(result.source, null);
  assert.equal(result.policy_decision, null);
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

test("model resolver returns unknown_model when a healthy live probe has no match", () => {
  const result = resolveModelRequest({
    phase: "dispatch",
    actor: "opencode",
    actorField: "executor",
    model: "missing-model",
    policy: policy({ deny_unknown_model_routes: false }),
    probeModels: () => ({
      status: "ok",
      models: ["opencode-go/glm-5.2", "openai/gpt-5.3-codex-spark"],
      warning: null,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown_model");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.probe.status, "ok");
});

test("model resolver returns model_probe_failed with warning when live probe fails without fallback", () => {
  const result = resolveModelRequest({
    phase: "dispatch",
    actor: "opencode",
    actorField: "executor",
    model: "glm-5.2",
    policy: policy({ deny_unknown_model_routes: false }),
    probeModels: () => ({
      status: "warning",
      models: [],
      warning: "optional model-list probe failed for opencode",
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "model_probe_failed");
  assert.match(result.warnings.join("\n"), /optional model-list probe failed/);
  assert.equal(result.probe.status, "warning");
});

test("model resolver uses the Pi --list-models live probe path", () => {
  const dir = tempDir();
  const piPath = path.join(dir, "pi");
  const argsPath = path.join(dir, "pi-args.json");
  fs.writeFileSync(piPath, `#!/bin/sh
printf '["%s"]' "$1" > ${JSON.stringify(argsPath)}
if [ "$1" = "--list-models" ]; then
  printf 'openai/gpt-5-fast\\n'
  exit 0
fi
exit 2
`, "utf-8");
  fs.chmodSync(piPath, 0o755);

  const result = resolveModelRequest({
    phase: "dispatch",
    actor: "pi",
    actorField: "executor",
    model: "gpt-5-fast",
    policy: policy({
      allowed_model_routes: [
        { route: "openai/*", phases: ["dispatch"], executors: ["pi"] },
      ],
    }),
    findExecutable: () => piPath,
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, "utf-8")), ["--list-models"]);
  assert.equal(result.ok, true);
  assert.equal(result.resolved_route, "openai/gpt-5-fast");
  assert.equal(result.source, "live_probe");
  assert.equal(result.probe.status, "ok");
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
  assert.match(result.warnings.join("\n"), /last_checked=2026-07-06/);
});

test("model catalog entries carry per-entry last_checked provenance", () => {
  assert.ok(MODEL_CATALOG.length > 0);
  for (const entry of MODEL_CATALOG) {
    assert.match(entry.last_checked, /^\d{4}-\d{2}-\d{2}$/);
  }
});
