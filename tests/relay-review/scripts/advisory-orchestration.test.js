const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ADVISORY_PROFILE_DEFAULTS,
  createAdvisoryConfigSnapshot,
  resolveHardenedBindingWaitMs,
  resolveAdvisoryConfig,
  resolveAdvisoryTimeoutSeconds,
} = require("../../../skills/relay-review/scripts/review-runner/advisory-orchestration");
const {
  validateRouteConfig,
} = require("../../../skills/relay-dispatch/scripts/relay-routing");

test("createAdvisoryConfigSnapshot binds effective lanes to the round and HEAD", () => {
  const snapshot = createAdvisoryConfigSnapshot({
    headSha: "a".repeat(40),
    round: 3,
    lanes: [{
      index: 1,
      reviewer: "pi",
      profile: "adversarial",
      gating: true,
    }],
  });

  assert.deepEqual(snapshot.lanes, [{
    lane_index: 1,
    reviewer: "pi",
    profile: "adversarial",
    gating: true,
  }]);
  assert.equal(snapshot.head_sha, "a".repeat(40));
  assert.equal(snapshot.round, 3);
  assert.match(snapshot.advisory_config_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(
    snapshot.advisory_config_hash,
    createAdvisoryConfigSnapshot({
      headSha: "b".repeat(40),
      round: 3,
      lanes: snapshot.lanes,
    }).advisory_config_hash,
  );
});

test("resolveHardenedBindingWaitMs defaults to 10000ms when the env var is unset", () => {
  assert.equal(resolveHardenedBindingWaitMs({}), 10000);
});

test("resolveHardenedBindingWaitMs honors a valid override", () => {
  assert.equal(resolveHardenedBindingWaitMs({ RELAY_ADVISORY_EVENT_BINDING_WAIT_MS: "2500" }), 2500);
});

test("resolveHardenedBindingWaitMs falls back to the default on invalid values", () => {
  for (const invalid of ["0", "-5", "abc", "1.5"]) {
    assert.equal(
      resolveHardenedBindingWaitMs({ RELAY_ADVISORY_EVENT_BINDING_WAIT_MS: invalid }),
      10000,
      `expected default fallback for env value ${JSON.stringify(invalid)}`,
    );
  }
});

test("ADVISORY_PROFILE_DEFAULTS carries per-profile timeout budgets", () => {
  assert.equal(ADVISORY_PROFILE_DEFAULTS.blindspot.timeoutSeconds, 900);
  assert.equal(ADVISORY_PROFILE_DEFAULTS.adversarial.timeoutSeconds, 1800);
});

test("resolveAdvisoryTimeoutSeconds uses the adversarial profile default of 1800s", () => {
  assert.equal(resolveAdvisoryTimeoutSeconds(undefined, "adversarial"), 1800);
  assert.equal(resolveAdvisoryTimeoutSeconds(null, "adversarial"), 1800);
  assert.equal(resolveAdvisoryTimeoutSeconds("", "adversarial"), 1800);
});

test("resolveAdvisoryTimeoutSeconds keeps the blindspot profile default of 900s", () => {
  assert.equal(resolveAdvisoryTimeoutSeconds(undefined, "blindspot"), 900);
  assert.equal(resolveAdvisoryTimeoutSeconds(null, "blindspot"), 900);
  assert.equal(resolveAdvisoryTimeoutSeconds("", "blindspot"), 900);
});

test("resolveAdvisoryTimeoutSeconds lets an explicit override win for both profiles", () => {
  assert.equal(resolveAdvisoryTimeoutSeconds("1200", "adversarial"), 1200);
  assert.equal(resolveAdvisoryTimeoutSeconds("1200", "blindspot"), 1200);
  assert.equal(resolveAdvisoryTimeoutSeconds(2400, "adversarial"), 2400);
  assert.equal(resolveAdvisoryTimeoutSeconds(2400, "blindspot"), 2400);
});

test("resolveAdvisoryConfig settlement timeout follows adversarial profile default", () => {
  const config = resolveAdvisoryConfig({
    advisoryProfileArg: "adversarial",
    advisoryReviewerArg: "opencode",
    data: {},
  });
  assert.equal(config.profile, "adversarial");
  assert.equal(config.timeoutSeconds, 1800);
  assert.equal(resolveAdvisoryTimeoutSeconds(config.timeoutSecondsArg, config.profile), 1800);
});

test("resolveAdvisoryConfig settlement timeout keeps blindspot profile default", () => {
  const config = resolveAdvisoryConfig({
    advisoryProfileArg: "blindspot",
    advisoryReviewerArg: "opencode",
    data: {},
  });
  assert.equal(config.profile, "blindspot");
  assert.equal(config.timeoutSeconds, 900);
  assert.equal(resolveAdvisoryTimeoutSeconds(config.timeoutSecondsArg, config.profile), 900);
});

test("resolveAdvisoryConfig explicit --advisory-timeout overrides both profile defaults", () => {
  for (const profile of ["adversarial", "blindspot"]) {
    const config = resolveAdvisoryConfig({
      advisoryProfileArg: profile,
      advisoryReviewerArg: "opencode",
      advisoryTimeoutArg: "1500",
      data: {},
    });
    assert.equal(config.timeoutSeconds, 1500, `settlement timeout for ${profile}`);
    assert.equal(
      resolveAdvisoryTimeoutSeconds(config.timeoutSecondsArg, profile),
      1500,
      `lane request timeout for ${profile}`,
    );
  }
});

test("resolveAdvisoryConfig mixed lanes settle on the max profile default without an explicit timeout", () => {
  const config = resolveAdvisoryConfig({
    data: {
      routing: {
        selected: {
          advisory_review: [
            { reviewer: "opencode", model: "example/opencode-model-fast", profile: "blindspot" },
            { reviewer: "pi", model: "openai/gpt-5", profile: "adversarial" },
          ],
        },
      },
    },
  });
  assert.equal(config.timeoutSeconds, 1800);
  assert.equal(resolveAdvisoryTimeoutSeconds(config.timeoutSecondsArg, "blindspot"), 900);
  assert.equal(resolveAdvisoryTimeoutSeconds(config.timeoutSecondsArg, "adversarial"), 1800);
});

test("resolveAdvisoryConfig does not inherit a planned model when the routed reviewer differs", () => {
  const config = resolveAdvisoryConfig({
    data: { routing: { selected: { advisory_review: { reviewer: "opencode" } } } },
    routePlan: { phases: { advisory_review: { reviewer: "codex", model: "openai/planned-model" } } },
  });
  // Selected reviewer comes from routing; the planned model was for a different
  // planned reviewer and must not leak into the routed reviewer.
  assert.equal(config.reviewer, "opencode");
  assert.equal(config.source, "routing");
  assert.equal(config.model, null);
});

test("resolveAdvisoryConfig normalizes CLI advisory flags as a one-lane shorthand", () => {
  const config = resolveAdvisoryConfig({
    advisoryProfileArg: "blindspot",
    advisoryReviewerArg: "opencode",
    advisoryReviewerModel: "example/opencode-model-fast",
    data: {},
  });

  assert.equal(config.reviewer, "opencode");
  assert.equal(config.source, "cli");
  assert.deepEqual(config.lanes, [{
    index: 1,
    reviewer: "opencode",
    model: "example/opencode-model-fast",
    modelResolution: null,
    profile: "blindspot",
    trigger: "every_round",
    gating: false,
    source: "cli",
    artifactReviewerName: "opencode",
  }]);
});

test("resolveAdvisoryConfig honors an explicit empty manifest lane list over planned lanes", () => {
  const config = resolveAdvisoryConfig({
    data: { routing: { selected: { advisory_review: [] } } },
    routePlan: { phases: { advisory_review: [{ reviewer: "codex", model: "openai/planned-model" }] } },
  });

  assert.deepEqual(config.lanes, []);
  assert.equal(config.reviewer, null);
});

test("resolveAdvisoryConfig falls through to planned lanes when routing has no advisory value", () => {
  const config = resolveAdvisoryConfig({
    data: { routing: { selected: {} } },
    routePlan: { phases: { advisory_review: [{ reviewer: "codex", model: "openai/planned-model" }] } },
  });

  assert.equal(config.lanes.length, 1);
  assert.equal(config.reviewer, "codex");
  assert.equal(config.source, "route_plan");
});

test("resolveAdvisoryConfig accepts a manifest advisory lane list with defaults", () => {
  const config = resolveAdvisoryConfig({
    data: {
      routing: {
        selected: {
          advisory_review: [
            { reviewer: "opencode", model: "example/opencode-model-fast", gating: true },
            { reviewer: "pi", model: "openai/gpt-5", trigger: "on_pass" },
          ],
        },
      },
    },
  });

  assert.deepEqual(config.lanes.map(({ reviewer, model, profile, trigger, gating, source }) => ({
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
      source: "routing",
    },
    {
      reviewer: "pi",
      model: "openai/gpt-5",
      profile: "blindspot",
      trigger: "on_pass",
      gating: false,
      source: "routing",
    },
  ]);
});

test("resolveAdvisoryConfig applies profile-aware lane defaults that match dispatch routing", () => {
  const laneInputs = [
    { reviewer: "blind", model: "openai/blind", profile: "blindspot" },
    { reviewer: "attack", model: "openai/attack", profile: "adversarial" },
    { reviewer: "explicit", model: "openai/explicit", profile: "adversarial", trigger: "every_round", gating: false },
  ];
  const reviewConfig = resolveAdvisoryConfig({
    data: {
      routing: {
        selected: {
          advisory_review: laneInputs,
        },
      },
    },
  });
  const dispatchConfig = validateRouteConfig({
    version: 2,
    defaults: {
      advisory_review: laneInputs,
    },
  }, "routes.json");

  const reviewLanes = reviewConfig.lanes.map(({ reviewer, model, profile, trigger, gating }) => ({
    reviewer,
    model,
    profile,
    trigger,
    gating,
  }));
  assert.deepEqual(reviewLanes, dispatchConfig.defaults.advisory_review);
  assert.deepEqual(reviewLanes, [
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

test("resolveAdvisoryConfig accepts legacy reviewer_model from manifest routing", () => {
  const config = resolveAdvisoryConfig({
    data: {
      routing: {
        selected: {
          advisory_review: {
            reviewer: "opencode",
            reviewer_model: "example/opencode-model-fast",
          },
        },
      },
    },
  });

  assert.equal(config.reviewer, "opencode");
  assert.equal(config.source, "routing");
  assert.equal(config.model, "example/opencode-model-fast");
  assert.equal(config.lanes[0].model, "example/opencode-model-fast");
});

test("resolveAdvisoryConfig suffixes duplicate reviewer artifact names", () => {
  const config = resolveAdvisoryConfig({
    data: {
      routing: {
        selected: {
          advisory_review: [
            { reviewer: "opencode", model: "example/opencode-model-fast" },
            { reviewer: "opencode", model: "example/opencode-model-fast", trigger: "on_pass" },
          ],
        },
      },
    },
  });

  assert.deepEqual(config.lanes.map((lane) => lane.artifactReviewerName), [
    "opencode",
    "opencode-lane2",
  ]);
});

test("resolveAdvisoryConfig still inherits the planned model when the planned reviewer is selected", () => {
  const config = resolveAdvisoryConfig({
    data: {},
    routePlan: { phases: { advisory_review: { reviewer: "codex", model: "openai/planned-model" } } },
  });
  assert.equal(config.reviewer, "codex");
  assert.equal(config.source, "route_plan");
  assert.equal(config.model, "openai/planned-model");
});

test("resolveAdvisoryConfig accepts a route-plan advisory lane list", () => {
  const modelResolution = {
    original_input: "pi:gpt-5",
    resolved_route: "openai/gpt-5",
    source: "catalog_fallback",
  };
  const config = resolveAdvisoryConfig({
    data: {},
    routePlan: {
      phases: {
        advisory_review: [
          {
            reviewer: "pi",
            model: "openai/gpt-5",
            profile: "blindspot",
            trigger: "on_pass",
            gating: true,
            model_resolution: modelResolution,
          },
        ],
      },
    },
  });

  assert.equal(config.lanes.length, 1);
  assert.equal(config.lanes[0].reviewer, "pi");
  assert.equal(config.lanes[0].trigger, "on_pass");
  assert.equal(config.lanes[0].gating, true);
  assert.deepEqual(config.lanes[0].modelResolution, modelResolution);
});

test("resolveAdvisoryConfig keeps route-plan model resolution when routed selection matches the plan", () => {
  const modelResolution = {
    original_input: "opencode:planned-model",
    resolved_route: "openai/planned-model",
    source: "catalog_fallback",
  };
  const config = resolveAdvisoryConfig({
    data: {
      routing: {
        selected: {
          advisory_review: {
            reviewer: "opencode",
            model: "openai/planned-model",
            profile: "blindspot",
          },
        },
      },
    },
    routePlan: {
      phases: {
        advisory_review: {
          reviewer: "opencode",
          model: "openai/planned-model",
          profile: "blindspot",
          model_resolution: modelResolution,
        },
      },
    },
  });

  assert.equal(config.reviewer, "opencode");
  assert.equal(config.source, "routing");
  assert.equal(config.model, "openai/planned-model");
  assert.deepEqual(config.modelResolution, modelResolution);
});
