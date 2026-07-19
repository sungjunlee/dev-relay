const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getRubricScoreNumber,
  getRubricTargetNumber,
  parseTargetScore,
  toIterationScoreEventEntry,
} = require("../../../skills/relay-review/scripts/review-runner/score-utils");

test("score utils prefer first-class score fields over observed text", () => {
  assert.equal(parseTargetScore(">= 8/10"), 8);
  assert.equal(parseTargetScore("exit 0"), null);
  assert.equal(getRubricScoreNumber({ observed: "5/10", score: 7 }), 7);
  assert.equal(getRubricTargetNumber({ target: ">= 8/10", target_score: 8.5 }), 8.5);
  assert.equal(getRubricScoreNumber({ observed: "5/10", score: null }), null);
  assert.equal(getRubricTargetNumber({ target: ">= 8/10", target_score: null }), null);
});

test("score utils preserve explicit null numeric fields in iteration events", () => {
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

