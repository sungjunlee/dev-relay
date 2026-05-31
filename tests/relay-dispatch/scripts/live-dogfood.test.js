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
  classifyAntigravityFailSafeTimeout,
  classifyAntigravityNoOpDispatch,
  classifyAntigravityPrimary,
  classifyHealthyDispatch,
  classifyProbeJson,
  LIVE_DOGFOOD_SCENARIOS,
  parseArgs,
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

test("live dogfood exposes explicit scenario metadata rows", () => {
  assert.ok(Array.isArray(LIVE_DOGFOOD_SCENARIOS));
  const rows = new Map(LIVE_DOGFOOD_SCENARIOS.map((scenario) => [scenario.name, scenario]));

  for (const [name, adapter, phase, category] of [
    ["probe-pi", "pi", "probe", "probe"],
    ["probe-opencode", "opencode", "probe", "probe"],
    ["probe-antigravity", "antigravity", "probe", "probe"],
    ["opencode-advisory", "opencode", "advisory_review", "healthy-review"],
    ["pi-primary", "pi", "primary_review", "healthy-review"],
    ["antigravity-primary", "antigravity", "primary_review", "healthy-review"],
    ["antigravity-primary-fail-safe-timeout", "antigravity", "primary_review", "fail-safe"],
    ["antigravity-dispatch-fail-safe-noop", "antigravity", "dispatch", "fail-safe"],
    ["pi-dispatch-canary", "pi", "dispatch", "healthy-dispatch"],
    ["opencode-dispatch-canary", "opencode", "dispatch", "healthy-dispatch"],
    ["antigravity-dispatch-canary", "antigravity", "dispatch", "healthy-dispatch"],
  ]) {
    const scenario = rows.get(name);
    assert.ok(scenario, `${name} scenario row`);
    assert.equal(scenario.adapter, adapter);
    assert.equal(scenario.phase, phase);
    assert.equal(scenario.category, category);
  }

  assert.equal(rows.get("antigravity-primary-fail-safe-timeout").healthyPromotion, false);
  assert.equal(rows.get("antigravity-dispatch-fail-safe-noop").healthyPromotion, false);
  assert.equal(rows.get("pi-dispatch-canary").healthyPromotion, true);
  assert.equal(rows.get("opencode-dispatch-canary").healthyPromotion, true);
  assert.equal(rows.get("antigravity-dispatch-canary").healthyPromotion, true);
});

test("live dogfood healthy dispatch canaries use run-level route intent files", () => {
  const repo = tempDir("relay-live-dogfood-repo-");
  const result = runDogfood({
    repo,
    dryRun: true,
    dispatchCanary: true,
    dispatchStamp: "routeux",
  });

  for (const name of ["pi-dispatch-canary", "opencode-dispatch-canary", "antigravity-dispatch-canary"]) {
    const step = result.outcomes.find((entry) => entry.name === name);
    assert.ok(step, `${name} planned`);
    assert.match(step.command, /--route-intent-file /);
    assert.doesNotMatch(step.command, / --executor /);
    assert.doesNotMatch(step.command, / --model /);
    const routeIntentPath = step.command.match(/--route-intent-file ([^ ]+)/)?.[1];
    assert.ok(routeIntentPath, `${name} route intent path`);
    const routeIntent = JSON.parse(fs.readFileSync(routeIntentPath, "utf-8"));
    assert.equal(routeIntent.dispatch.executor, name.replace("-dispatch-canary", ""));
    assert.equal(routeIntent.review.reviewer, "codex");
    if (routeIntent.dispatch.executor === "antigravity") {
      assert.equal(routeIntent.dispatch.model, "google/antigravity-cli");
    }
  }
});

test("live dogfood dry-run plans default non-dispatch scenarios without invoking CLIs", () => {
  const repo = tempDir("relay-live-dogfood-repo-");
  const calls = [];
  const result = runDogfood({
    repo,
    dryRun: true,
  }, {
    spawnSync: (...args) => {
      calls.push(args);
      return jsonResult({});
    },
  });

  assert.equal(calls.length, 0);
  assert.deepEqual(result.outcomes.map((step) => step.name), LIVE_DOGFOOD_SCENARIOS
    .filter((scenario) => scenario.defaultEnabled)
    .map((scenario) => scenario.name));
  assert.ok(result.outcomes.some((step) => step.name === "antigravity-primary-fail-safe-timeout"));
  assert.ok(result.outcomes.some((step) => step.name === "antigravity-dispatch-fail-safe-noop"));
  assert.ok(result.outcomes.every((step) => step.outcome === OUTCOMES.NOT_RUN));
  assert.deepEqual(result.coverage.scenarios.map((scenario) => scenario.name), LIVE_DOGFOOD_SCENARIOS.map((scenario) => scenario.name));
  assert.ok(result.coverage.readiness_exemptions.some((exemption) => (
    exemption.adapter === "opencode" && exemption.phase === "primary_review"
  )));
  assert.ok(result.coverage.scenarios.every((scenario) => typeof scenario.healthyPromotion === "boolean"));
});

test("live dogfood can target named scenarios for isolated adapter evidence", () => {
  const repo = tempDir("relay-live-dogfood-repo-");
  const calls = [];
  const result = runDogfood({
    repo,
    dryRun: true,
    scenarios: ["pi-primary"],
  }, {
    spawnSync: (...args) => {
      calls.push(args);
      return jsonResult({});
    },
  });

  assert.equal(calls.length, 0);
  assert.deepEqual(result.outcomes.map((step) => step.name), ["pi-primary"]);
  assert.match(result.outcomes[0].command, /invoke-reviewer-pi\.js/);
  assert.doesNotMatch(result.outcomes[0].command, /invoke-reviewer-opencode\.js/);
});

test("live dogfood rejects unknown scenario filters", () => {
  assert.throws(
    () => parseArgs(["--scenario", "missing-scenario"]),
    /unknown --scenario "missing-scenario"/
  );
});

test("live dogfood parses repeated scenario filters", () => {
  const parsed = parseArgs(["--scenario", "probe-pi", "--scenario", "pi-primary"]);

  assert.deepEqual(parsed.scenarios, ["probe-pi", "pi-primary"]);
});

test("live dogfood classifies mocked command outcomes and preserves markdown distinctions", () => {
  const repo = tempDir("relay-live-dogfood-repo-");
  const relayHome = tempDir("relay-live-dogfood-home-");
  const responses = [
    jsonResult({ policy_decision: { allowed: true }, agent_tools_raw: "{\"version\":\"pi\"}" }),
    jsonResult({ policy_decision: { allowed: true }, agent_tools_raw: "{\"version\":\"opencode\"}" }),
    jsonResult({ policy_decision: { allowed: true }, agent_tools_raw: "{\"version\":\"agy\"}" }),
    jsonResult({ profile: "blindspot", advisory_findings: [] }),
    jsonResult({ verdict: "pass", summary: "Pi ok." }),
    jsonResult({ verdict: "pass", summary: "Antigravity ok." }),
    { status: 1, stdout: "", stderr: "Antigravity reviewer primary_review timed out after 2s (RELAY_ANTIGRAVITY_REVIEW_TIMEOUT)." },
    jsonResult({ status: "completed-no-op", runState: "review_pending", prNumber: null }),
  ];
  const calls = [];
  const previousPolicyPath = process.env.RELAY_POLICY_PATH;
  process.env.RELAY_POLICY_PATH = path.join(tempDir("relay-live-dogfood-external-"), "policy.json");
  let result;
  try {
    result = runDogfood({
      repo,
      relayHome,
      commandTimeoutMs: 1000,
      piReviewTimeout: "1s",
      antigravityReviewTimeout: "90s",
      antigravityFailSafeReviewTimeout: "2s",
    }, {
      spawnSync: (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return responses.shift();
      },
    });
  } finally {
    if (previousPolicyPath === undefined) delete process.env.RELAY_POLICY_PATH;
    else process.env.RELAY_POLICY_PATH = previousPolicyPath;
  }

  assert.equal(calls.length, 8);
  assert.deepEqual(result.outcomes.map((step) => step.name), [
    "probe-pi",
    "probe-opencode",
    "probe-antigravity",
    "opencode-advisory",
    "pi-primary",
    "antigravity-primary",
    "antigravity-primary-fail-safe-timeout",
    "antigravity-dispatch-fail-safe-noop",
  ]);
  assert.equal(calls[0].env.RELAY_HOME, relayHome);
  assert.equal(calls[0].env.RELAY_POLICY_PATH, path.join(relayHome, "policy.json"));
  assert.equal(calls[4].env.RELAY_PI_REVIEW_TIMEOUT, "1s");
  assert.equal(calls[5].env.RELAY_ANTIGRAVITY_REVIEW_TIMEOUT, "90s");
  assert.equal(calls[6].env.RELAY_ANTIGRAVITY_REVIEW_TIMEOUT, "2s");
  assert.deepEqual(result.outcomes.map((step) => step.outcome), [
    OUTCOMES.PASS,
    OUTCOMES.PASS,
    OUTCOMES.PASS,
    OUTCOMES.PASS,
    OUTCOMES.PASS,
    OUTCOMES.PASS,
    OUTCOMES.FAIL_SAFE_PASS,
    OUTCOMES.FAIL_SAFE_PASS,
  ]);

  const markdown = renderMarkdown(result);
  assert.match(markdown, /`pass` proves/);
  assert.match(markdown, /`fail-safe-pass` means/);
  assert.match(markdown, /`timeout` is inconclusive/);
  assert.match(markdown, /not healthy success/);
  assert.match(markdown, /\| `antigravity-primary` \| `pass` \|/);
  assert.match(markdown, /\| `antigravity-primary-fail-safe-timeout` \| `fail-safe-pass` \|/);
  assert.match(markdown, /\| `antigravity-dispatch-fail-safe-noop` \| `fail-safe-pass` \|/);
});

test("live dogfood dispatch canary adds healthy Pi, OpenCode, and Antigravity dispatch steps", () => {
  const repo = tempDir("relay-live-dogfood-repo-");
  const relayHome = tempDir("relay-live-dogfood-home-");
  const responses = [
    { status: 0, stdout: "", stderr: "" },
    jsonResult({ policy_decision: { allowed: true }, agent_tools_raw: "{\"version\":\"pi\"}" }),
    jsonResult({ policy_decision: { allowed: true }, agent_tools_raw: "{\"version\":\"opencode\"}" }),
    jsonResult({ policy_decision: { allowed: true }, agent_tools_raw: "{\"version\":\"agy\"}" }),
    jsonResult({ profile: "blindspot", advisory_findings: [] }),
    jsonResult({ verdict: "pass", summary: "Pi ok." }),
    jsonResult({ verdict: "pass", summary: "Antigravity ok." }),
    { status: 1, stdout: "", stderr: "Antigravity reviewer primary_review timed out after 2s (RELAY_ANTIGRAVITY_REVIEW_TIMEOUT)." },
    jsonResult({ status: "completed-no-op", runState: "review_pending", prNumber: null }),
    jsonResult({ status: "completed", runState: "review_pending", prNumber: 601 }),
    jsonResult({ status: "completed", runState: "review_pending", prNumber: 602 }),
    jsonResult({ status: "completed", runState: "review_pending", prNumber: 603 }),
  ];
  const calls = [];

  const result = runDogfood({
    repo,
    relayHome,
    dispatchCanary: true,
    dispatchTimeoutSeconds: 222,
    dispatchBranchPrefix: "healthy-dogfood",
    commandTimeoutMs: 1000,
  }, {
    spawnSync: (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return responses.shift();
    },
  });

  assert.equal(calls.length, 12);
  assert.equal(calls[0].command, "git");
  assert.deepEqual(calls[0].args, ["status", "--porcelain"]);
  assert.deepEqual(result.outcomes.map((step) => step.name), [
    "probe-pi",
    "probe-opencode",
    "probe-antigravity",
    "opencode-advisory",
    "pi-primary",
    "antigravity-primary",
    "antigravity-primary-fail-safe-timeout",
    "antigravity-dispatch-fail-safe-noop",
    "pi-dispatch-canary",
    "opencode-dispatch-canary",
    "antigravity-dispatch-canary",
  ]);
  assert.deepEqual(result.outcomes.slice(8).map((step) => step.outcome), [
    OUTCOMES.PASS,
    OUTCOMES.PASS,
    OUTCOMES.PASS,
  ]);
  for (const [call, executor] of calls.slice(9).map((call, index) => [call, ["pi", "opencode", "antigravity"][index]])) {
    assert.match(call.args[call.args.indexOf("-b") + 1], /^healthy-dogfood-(pi|opencode|antigravity)-\d+$/);
    assert.equal(call.args[call.args.indexOf("--timeout") + 1], "222");
    assert.ok(call.args.includes("--prompt-file"));
    assert.ok(call.args.includes("--rubric-file"));
    assert.ok(call.args.includes("--route-intent-file"));
    assert.equal(call.args.includes("--executor"), false);
    assert.equal(call.args.includes("--model"), false);
    const routeIntent = JSON.parse(fs.readFileSync(call.args[call.args.indexOf("--route-intent-file") + 1], "utf-8"));
    assert.equal(routeIntent.dispatch.executor, executor);
  }
});

test("live dogfood dispatch canary refuses dirty repositories before creating live branches", () => {
  const repo = tempDir("relay-live-dogfood-repo-");
  const calls = [];

  assert.throws(() => runDogfood({
    repo,
    dispatchCanary: true,
  }, {
    spawnSync: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: " M docs/relay-operator-guide.md\n", stderr: "" };
    },
  }), /--dispatch-canary requires a clean worktree/);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "git");
  assert.deepEqual(calls[0].args, ["status", "--porcelain"]);
});

test("live dogfood targeted dispatch canary also refuses dirty repositories", () => {
  const repo = tempDir("relay-live-dogfood-repo-");
  const calls = [];

  assert.throws(() => runDogfood({
    repo,
    scenarios: ["pi-dispatch-canary"],
  }, {
    spawnSync: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: " M README.md\n", stderr: "" };
    },
  }), /--dispatch-canary requires a clean worktree/);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "git");
  assert.deepEqual(calls[0].args, ["status", "--porcelain"]);
});

test("live dogfood defaults use realistic healthy reviewer timeouts and bounded dispatch canary settings", () => {
  const defaults = parseArgs([]);

  assert.equal(defaults.commandTimeoutMs, 300_000);
  assert.equal(defaults.piReviewTimeout, "120s");
  assert.equal(defaults.antigravityReviewTimeout, "120s");
  assert.equal(defaults.antigravityFailSafeReviewTimeout, "5s");
  assert.equal(defaults.dispatchCanary, false);
  assert.equal(defaults.dispatchTimeoutSeconds, 180);
  assert.equal(defaults.dispatchBranchPrefix, "dogfood-dispatch");

  const parsed = parseArgs([
    "--dispatch-canary",
    "--dispatch-timeout", "240",
    "--dispatch-branch-prefix", "relay-healthy",
    "--antigravity-review-timeout", "180s",
    "--antigravity-fail-safe-timeout", "3s",
  ]);
  assert.equal(parsed.dispatchCanary, true);
  assert.equal(parsed.dispatchTimeoutSeconds, 240);
  assert.equal(parsed.dispatchBranchPrefix, "relay-healthy");
  assert.equal(parsed.antigravityReviewTimeout, "180s");
  assert.equal(parsed.antigravityFailSafeReviewTimeout, "3s");
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
  const piTimeout = classifyProbeJson({
    status: 1,
    stdout: "",
    stderr: [
      "Pi reviewer primary_review timed out after 20s (RELAY_PI_REVIEW_TIMEOUT).",
      "The pi --print invocation did not return before the parent-process timeout, so relay cannot treat this as healthy review evidence.",
      "First verify Pi non-interactive auth/provider health with: timeout 20s pi --no-session --no-context-files --no-tools --print 'Return exactly {\"ok\":true} and nothing else.'.",
    ].join(" "),
  });
  assert.equal(piTimeout.outcome, OUTCOMES.TIMEOUT);
  assert.match(piTimeout.notes, /cannot treat this as healthy review evidence/);
  assert.match(piTimeout.notes, /verify Pi non-interactive auth\/provider health/);
  assert.equal(classifyAntigravityPrimary({
    status: 1,
    stdout: "",
    stderr: "Antigravity reviewer primary_review timed out after 5s (RELAY_ANTIGRAVITY_REVIEW_TIMEOUT).",
  }).outcome, OUTCOMES.TIMEOUT);
  assert.equal(classifyAntigravityFailSafeTimeout({
    status: 1,
    stdout: "",
    stderr: "Antigravity reviewer primary_review timed out after 5s (RELAY_ANTIGRAVITY_REVIEW_TIMEOUT).",
  }).outcome, OUTCOMES.FAIL_SAFE_PASS);
  assert.equal(classifyAntigravityFailSafeTimeout(jsonResult({ verdict: "pass" })).outcome, OUTCOMES.FAIL);
  assert.equal(classifyAntigravityNoOpDispatch(jsonResult({
    status: "failed",
    runState: "escalated",
    prNumber: null,
    error: "executor produced no reviewable repository changes",
  }, 1)).outcome, OUTCOMES.FAIL_SAFE_PASS);
  assert.equal(classifyAntigravityNoOpDispatch(jsonResult({
    status: "completed-no-op",
    runState: "review_pending",
    prNumber: null,
  })).outcome, OUTCOMES.FAIL_SAFE_PASS);
  assert.equal(classifyAntigravityNoOpDispatch(jsonResult({
    runState: "review_pending",
    prNumber: 123,
  })).outcome, OUTCOMES.FAIL);
  assert.equal(classifyHealthyDispatch(jsonResult({
    runState: "review_pending",
    prNumber: 123,
  })).outcome, OUTCOMES.PASS);
  assert.equal(classifyHealthyDispatch(jsonResult({
    status: "failed",
    runState: "escalated",
    prNumber: null,
    error: "executor timed out after 180s",
  }, 1)).outcome, OUTCOMES.TIMEOUT);
  assert.equal(classifyAntigravityDispatch(jsonResult({
    runState: "review_pending",
    prNumber: 123,
  })).outcome, OUTCOMES.PASS);
});
