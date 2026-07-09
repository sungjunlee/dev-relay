const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveHardenedBindingWaitMs,
  resolveAdvisoryConfig,
} = require("../../../skills/relay-review/scripts/review-runner/advisory-orchestration");

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
