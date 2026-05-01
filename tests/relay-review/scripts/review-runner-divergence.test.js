const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildScoreDivergenceAnalysis,
  getRubricScoreNumber,
  getRubricTargetNumber,
  parseTargetScore,
  parseScoreLog,
  toIterationScoreEventEntry,
} = require("../../../skills/relay-review/scripts/review-runner/divergence");

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

test("divergence numeric helpers prefer first-class score fields over observed text", () => {
  assert.equal(parseTargetScore(">= 8/10"), 8);
  assert.equal(parseTargetScore("exit 0"), null);
  assert.equal(getRubricScoreNumber({ observed: "5/10", score: 7 }), 7);
  assert.equal(getRubricTargetNumber({ target: ">= 8/10", target_score: 8.5 }), 8.5);
  assert.equal(getRubricScoreNumber({ observed: "5/10", score: null }), null);
  assert.equal(getRubricTargetNumber({ target: ">= 8/10", target_score: null }), null);
});

test("divergence/toIterationScoreEventEntry respects explicit null numeric fields", () => {
  assert.deepEqual(toIterationScoreEventEntry({
    factor: "Contract smoke",
    target: ">= 1/1",
    observed: "1/1",
    score: null,
    target_score: null,
    status: "pass",
    tier: "contract",
  }), {
    factor: "Contract smoke",
    target: ">= 1/1",
    observed: "1/1",
    met: true,
    status: "pass",
    tier: "contract",
  });
});

test("divergence/buildScoreDivergenceAnalysis uses first-class reviewer score when available", () => {
  const result = buildScoreDivergenceAnalysis([
    "| Factor | Status | Final |",
    "| --- | --- | --- |",
    "| Craft | pass | 9/10 |",
  ].join("\n"), [
    {
      factor: "Craft",
      observed: "looks good",
      score: 7,
      tier: "quality",
    },
  ]);

  assert.deepEqual(result.eventPayload, [{
    factor: "Craft",
    executor: "9/10",
    reviewer: "looks good",
    delta: 2,
    tier: "quality",
  }]);
});
