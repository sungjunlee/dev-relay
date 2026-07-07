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

test("resolveAdvisoryConfig still inherits the planned model when the planned reviewer is selected", () => {
  const config = resolveAdvisoryConfig({
    data: {},
    routePlan: { phases: { advisory_review: { reviewer: "codex", model: "openai/planned-model" } } },
  });
  assert.equal(config.reviewer, "codex");
  assert.equal(config.source, "route_plan");
  assert.equal(config.model, "openai/planned-model");
});
