const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveHardenedBindingWaitMs } = require("../../../skills/relay-review/scripts/review-runner/advisory-orchestration");

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
