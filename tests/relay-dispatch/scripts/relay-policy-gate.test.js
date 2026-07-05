const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  RelayPolicyGateError,
  assertRelayPolicyGate,
  evaluateRelayPolicyGate,
} = require("../../../skills/relay-dispatch/scripts/relay-policy-gate");
const { buildDefaultRelayPolicy } = require("../../../skills/relay-dispatch/scripts/relay-policy");
const { getProjectPolicyPath } = require("../../../skills/relay-dispatch/scripts/manifest/paths");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-gate-"));
}

function writePolicy(relayHome, policy) {
  fs.mkdirSync(relayHome, { recursive: true });
  fs.writeFileSync(path.join(relayHome, "policy.json"), JSON.stringify(policy, null, 2), "utf-8");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function initGitRepo(repoRoot) {
  require("child_process").execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
}

test("policy gate allows managed Codex without model under missing config", () => {
  const decision = evaluateRelayPolicyGate({
    relayHome: tempDir(),
    phase: "dispatch",
    executor: "codex",
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.phase, "dispatch");
  assert.equal(decision.actor_field, "executor");
  assert.equal(decision.executor, "codex");
  assert.equal(decision.actor, "codex");
  assert.equal(decision.model, null);
  assert.equal(decision.reason, "managed_cli");
  assert.equal(decision.matched_route, null);
  assert.equal(decision.policy.status, "defaulted");
});

test("policy gate keeps Codex and Claude model-less managed CLI routes compatible", () => {
  for (const tuple of [
    { phase: "dispatch", executor: "codex", actorField: "executor" },
    { phase: "dispatch", executor: "claude", actorField: "executor" },
    { phase: "review", reviewer: "codex", actorField: "reviewer" },
    { phase: "review", reviewer: "claude", actorField: "reviewer" },
  ]) {
    const decision = evaluateRelayPolicyGate({
      relayHome: tempDir(),
      ...tuple,
    });
    assert.equal(decision.allowed, true, `${tuple.phase} ${tuple.executor || tuple.reviewer}`);
    assert.equal(decision.reason, "managed_cli");
    assert.equal(decision.actor_field, tuple.actorField);
    assert.equal(decision.model, null);
  }
});

test("policy gate denies unmanaged executor model routes unless explicitly allowed", () => {
  // Open-by-default posture (#781): denial now requires strict routes config.
  const relayHome = tempDir();
  writeJson(path.join(relayHome, "routes.json"), { version: 2, strict: true });
  assert.throws(
    () => assertRelayPolicyGate({
      relayHome,
      phase: "dispatch",
      executor: "opencode",
      model: "example/opencode-model-fast",
    }),
    (error) => {
      assert.ok(error instanceof RelayPolicyGateError);
      assert.equal(error.decision.allowed, false);
      assert.equal(error.decision.phase, "dispatch");
      assert.equal(error.decision.actor_field, "executor");
      assert.equal(error.decision.executor, "opencode");
      assert.equal(error.decision.model, "example/opencode-model-fast");
      assert.equal(error.decision.reason, "unknown_model_route");
      assert.match(error.message, /phase=dispatch/);
      assert.match(error.message, /executor=opencode/);
      assert.match(error.message, /model=example\/opencode-model-fast/);
      assert.match(error.message, /reason=unknown_model_route/);
      return true;
    }
  );
});

test("policy gate can allow and deny Pi, OpenCode, and Antigravity routes by configuration", () => {
  const relayHome = tempDir();
  writePolicy(relayHome, {
    ...buildDefaultRelayPolicy(),
    profile: "non-managed-routes",
    allowed_model_routes: [
      { route: "example/opencode-model-*", phases: ["dispatch", "advisory_review"], executors: ["opencode"], reviewers: ["opencode"] },
      { route: "pi/*", phases: ["dispatch", "review"], executors: ["pi"], reviewers: ["pi"] },
      { route: "google/*", phases: ["dispatch", "review"], executors: ["antigravity"], reviewers: ["antigravity"] },
    ],
    denied_model_routes: [
      { route: "pi/blocked", phases: ["review"], reviewers: ["pi"] },
      { route: "google/blocked", phases: ["dispatch"], executors: ["antigravity"] },
    ],
  });

  assert.equal(assertRelayPolicyGate({
    relayHome,
    phase: "dispatch",
    executor: "opencode",
    model: "example/opencode-model-fast",
  }).reason, "allowed_model_route");
  assert.equal(assertRelayPolicyGate({
    relayHome,
    phase: "advisory_review",
    reviewer: "opencode",
    model: "example/opencode-model-fast",
  }).reason, "allowed_model_route");
  assert.equal(assertRelayPolicyGate({
    relayHome,
    phase: "review",
    reviewer: "pi",
    model: "pi/local-review",
  }).reason, "allowed_model_route");
  assert.equal(assertRelayPolicyGate({
    relayHome,
    phase: "dispatch",
    executor: "antigravity",
    model: "google/gemini-cli",
  }).reason, "allowed_model_route");

  assert.throws(
    () => assertRelayPolicyGate({
      relayHome,
      phase: "review",
      reviewer: "pi",
      model: "pi/blocked",
    }),
    /reason=denied_model_route/
  );
  assert.throws(
    () => assertRelayPolicyGate({
      relayHome,
      phase: "dispatch",
      executor: "antigravity",
      model: "google/blocked",
    }),
    /reason=denied_model_route/
  );
});

test("policy gate surfaces matched allow route details", () => {
  const relayHome = tempDir();
  writePolicy(relayHome, {
    ...buildDefaultRelayPolicy(),
    profile: "allow-opencode",
    allowed_model_routes: [{
      route: "example/opencode-model-*",
      phases: ["dispatch"],
      executors: ["opencode"],
    }],
  });

  const decision = assertRelayPolicyGate({
    relayHome,
    phase: "dispatch",
    executor: "opencode",
    model: "example/opencode-model-fast",
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "allowed_model_route");
  assert.equal(decision.matched_route, "example/opencode-model-*");
});

test("policy gate reports project policy sources when project layer denies a route", () => {
  const relayHome = tempDir();
  const repoRoot = tempDir();
  initGitRepo(repoRoot);
  writePolicy(relayHome, {
    ...buildDefaultRelayPolicy(),
    profile: "global",
    allowed_model_routes: [{ route: "example/opencode-model-*", phases: ["dispatch"], executors: ["opencode"] }],
  });
  writeJson(getProjectPolicyPath(repoRoot, { relayHome }), {
    ...buildDefaultRelayPolicy(),
    profile: "project",
    allowed_model_routes: [{ route: "example/opencode-model-safe", phases: ["dispatch"], executors: ["opencode"] }],
  });

  const decision = evaluateRelayPolicyGate({
    relayHome,
    repoRoot,
    phase: "dispatch",
    executor: "opencode",
    model: "example/opencode-model-fast",
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "unknown_model_route");
  assert.equal(decision.policy.sources.global, path.join(relayHome, "policy.json"));
  assert.equal(decision.policy.sources.project, getProjectPolicyPath(repoRoot, { relayHome }));
});
