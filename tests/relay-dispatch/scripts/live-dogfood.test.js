const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { evaluateRelayRoute } = require("../../../skills/relay-dispatch/scripts/relay-policy");

const {
  OUTCOMES,
  buildPolicy,
  classifyAntigravityDispatch,
  classifyAntigravityPrimary,
  classifyProbeJson,
  renderMarkdown,
  runDogfood,
} = require("../../../skills/relay-dispatch/scripts/live-dogfood");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function jsonResult(payload, status = 0) {
  return { status, stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}

test("live dogfood uses temp RELAY_HOME by default and writes scoped policy", () => {
  const repo = tempDir("relay-live-dogfood-repo-");
  const homeBefore = path.join(os.homedir(), ".relay", "policy.json");
  const calls = [];
  const result = runDogfood({
    repo,
    dryRun: true,
    probeOnly: true,
  }, {
    spawnSync: (...args) => {
      calls.push(args);
      return jsonResult({});
    },
  });

  assert.equal(calls.length, 0);
  assert.equal(result.temp_relay_home, true);
  assert.match(result.relay_home, /relay-live-dogfood-/);
  assert.ok(fs.existsSync(path.join(result.relay_home, "policy.json")));
  const policy = JSON.parse(fs.readFileSync(path.join(result.relay_home, "policy.json"), "utf-8"));
  assert.equal(policy.profile, "live-adapter-dogfood");
  assert.deepEqual(policy.allowed_model_routes.map((entry) => entry.route), [
    "opencode-go/deepseek-v4-pro",
    "opencode-go/deepseek-v4-pro",
    "google/antigravity-cli",
  ]);
  assert.deepEqual(policy.allowed_model_routes[0].reviewers, ["pi"]);
  assert.deepEqual(policy.allowed_model_routes[1].reviewers, ["opencode"]);
  assert.ok(!result.relay_home.startsWith(path.dirname(homeBefore)) || result.relay_home !== path.dirname(homeBefore));
});

test("live dogfood classifies mocked command outcomes and preserves markdown distinctions", () => {
  const repo = tempDir("relay-live-dogfood-repo-");
  const relayHome = tempDir("relay-live-dogfood-home-");
  const responses = [
    jsonResult({ policy_decision: { allowed: true }, agent_tools_raw: "{\"version\":\"pi\"}" }),
    jsonResult({ policy_decision: { allowed: true }, agent_tools_raw: "{\"version\":\"opencode\"}" }),
    jsonResult({ policy_decision: { allowed: true }, agent_tools_raw: "{\"version\":\"agy\"}" }),
    jsonResult({ profile: "blindspot", advisory_findings: [] }),
    { status: 1, stdout: "", stderr: "Pi reviewer primary_review timed out after 1s (RELAY_PI_REVIEW_TIMEOUT)." },
    { status: 1, stdout: "", stderr: "Antigravity reviewer primary_review timed out after 5s (RELAY_ANTIGRAVITY_REVIEW_TIMEOUT)." },
    jsonResult({ status: "failed", runState: "escalated", prNumber: null, error: "executor timed out after 45s" }, 1),
  ];
  const calls = [];
  const result = runDogfood({
    repo,
    relayHome,
    commandTimeoutMs: 1000,
    piReviewTimeout: "1s",
  }, {
    spawnSync: (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return responses.shift();
    },
  });

  assert.equal(calls.length, 7);
  assert.equal(calls[0].env.RELAY_HOME, relayHome);
  assert.equal(calls[4].env.RELAY_PI_REVIEW_TIMEOUT, "1s");
  assert.deepEqual(result.outcomes.map((step) => step.outcome), [
    OUTCOMES.PASS,
    OUTCOMES.PASS,
    OUTCOMES.PASS,
    OUTCOMES.PASS,
    OUTCOMES.TIMEOUT,
    OUTCOMES.FAIL_SAFE_PASS,
    OUTCOMES.FAIL_SAFE_PASS,
  ]);

  const markdown = renderMarkdown(result);
  assert.match(markdown, /`pass` proves/);
  assert.match(markdown, /`fail-safe-pass` means/);
  assert.match(markdown, /`timeout` is inconclusive/);
  assert.match(markdown, /\| `pi-primary` \| `timeout` \|/);
  assert.match(markdown, /\| `antigravity-dispatch` \| `fail-safe-pass` \|/);
});

test("live dogfood policy reflects requested model route overrides", () => {
  const policy = buildPolicy({
    piModel: "custom-pi/model-a",
    opencodeModel: "custom-opencode/model-b",
    antigravityModel: "custom-google/agy",
  });

  assert.deepEqual(policy.allowed_model_routes.map((entry) => entry.route), [
    "custom-pi/model-a",
    "custom-opencode/model-b",
    "custom-google/agy",
  ]);
  assert.deepEqual(policy.allowed_model_routes[0].executors, ["pi"]);
  assert.deepEqual(policy.allowed_model_routes[0].reviewers, ["pi"]);
  assert.deepEqual(policy.allowed_model_routes[1].phases, ["dispatch", "advisory_review"]);
  assert.deepEqual(policy.allowed_model_routes[2].executors, ["antigravity"]);
});

test("live dogfood default policy does not widen same-route actor phase scope", () => {
  const policy = buildPolicy();
  assert.equal(evaluateRelayRoute(policy, {
    phase: "review",
    reviewer: "pi",
    model: "opencode-go/deepseek-v4-pro",
  }).allowed, true);
  assert.equal(evaluateRelayRoute(policy, {
    phase: "advisory_review",
    reviewer: "opencode",
    model: "opencode-go/deepseek-v4-pro",
  }).allowed, true);
  assert.equal(evaluateRelayRoute(policy, {
    phase: "review",
    reviewer: "opencode",
    model: "opencode-go/deepseek-v4-pro",
  }).allowed, false);
  assert.equal(evaluateRelayRoute(policy, {
    phase: "advisory_review",
    reviewer: "pi",
    model: "opencode-go/deepseek-v4-pro",
  }).allowed, false);
});

test("classification helpers separate harness timeout from safe adapter timeout", () => {
  assert.equal(classifyProbeJson(jsonResult({
    policy_decision: { allowed: true },
    agent_probe_error: "pi CLI not found",
    agent_tools_raw: "{}",
  })).outcome, OUTCOMES.FAIL);
  assert.equal(classifyProbeJson(jsonResult({
    policy_decision: { allowed: false, reason: "unknown_model_route" },
    agent_tools_raw: "{}",
  })).outcome, OUTCOMES.FAIL);
  assert.equal(classifyProbeJson(jsonResult({
    policy_decision: { allowed: true },
    agent_tools_raw: "{\"version\":\"1\"}",
  })).outcome, OUTCOMES.PASS);
  assert.equal(classifyAntigravityPrimary({ error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" }).outcome, OUTCOMES.TIMEOUT);
  assert.equal(classifyAntigravityPrimary({
    status: 1,
    stdout: "",
    stderr: "Antigravity reviewer primary_review timed out after 5s (RELAY_ANTIGRAVITY_REVIEW_TIMEOUT).",
  }).outcome, OUTCOMES.FAIL_SAFE_PASS);
  assert.equal(classifyAntigravityDispatch(jsonResult({
    status: "failed",
    runState: "escalated",
    prNumber: null,
    error: "executor produced no reviewable repository changes",
  }, 1)).outcome, OUTCOMES.FAIL_SAFE_PASS);
  assert.equal(classifyAntigravityDispatch(jsonResult({
    runState: "review_pending",
    prNumber: 123,
  })).outcome, OUTCOMES.PASS);
});
