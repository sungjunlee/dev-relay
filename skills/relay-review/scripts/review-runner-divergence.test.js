const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildScoreDivergenceAnalysis,
  parseScoreLog,
} = require("./review-runner/divergence");

test("divergence/parseScoreLog falls back to the last populated iteration", () => {
  const result = parseScoreLog([
    "| Factor | Status | Iter 1 | Iter 2 | Final |",
    "| --- | --- | --- | --- | --- |",
    "| Behavior | pass | 6/10 | 8/10 | — |",
  ].join("\n"));

  assert.deepEqual(result, [{ factor: "Behavior", score: "8/10" }]);
});

test("divergence/buildScoreDivergenceAnalysis keeps warning and event payload thresholds", () => {
  const result = buildScoreDivergenceAnalysis([
    "| Factor | Status | Final |",
    "| --- | --- | --- |",
    "| Behavior | pass | 9/10 |",
  ].join("\n"), [
    {
      factor: "Behavior",
      observed: "5/10",
      tier: "contract",
    },
  ]);

  assert.deepEqual(result.eventPayload, [{
    factor: "Behavior",
    executor: "9/10",
    reviewer: "5/10",
    delta: 4,
    tier: "contract",
  }]);
  assert.match(result.warnings[0], /executor 9\/10, reviewer 5\/10 \(\+4\)/);
});
