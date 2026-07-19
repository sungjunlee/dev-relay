const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_MAX_REVIEW_ROUNDS,
  getMaxReviewRounds,
  shouldEscalateRepairCycle,
} = require("../../../skills/relay-review/scripts/review-runner/round-cap");

test("default review policy permits one repair and two independent reviews", () => {
  const data = { review: {} };

  assert.equal(DEFAULT_MAX_REVIEW_ROUNDS, 2);
  assert.equal(getMaxReviewRounds(data), 2);
  assert.equal(shouldEscalateRepairCycle({ data, round: 1, blocking: true }), false);
  assert.equal(shouldEscalateRepairCycle({ data, round: 2, blocking: true }), true);
  assert.equal(shouldEscalateRepairCycle({ data, round: 2, blocking: false }), false);
});

test("an explicit extended policy preserves additional review rounds", () => {
  const data = { review: { max_rounds: 5 } };

  assert.equal(getMaxReviewRounds(data), 5);
  assert.equal(shouldEscalateRepairCycle({ data, round: 2, blocking: true }), false);
  assert.equal(shouldEscalateRepairCycle({ data, round: 5, blocking: true }), true);
});
