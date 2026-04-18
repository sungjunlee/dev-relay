const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STATES,
  forceTransitionState,
  updateManifestState,
  validateTransition,
} = require("./lifecycle");

test("manifest/lifecycle validateTransition rejects invalid edges", () => {
  assert.throws(
    () => validateTransition(STATES.DISPATCHED, STATES.MERGED),
    /Invalid relay state transition/
  );
});

test("manifest/lifecycle forceTransitionState keeps invariant-free recovery paths", () => {
  const updated = forceTransitionState(
    { state: STATES.CHANGES_REQUESTED, timestamps: {} },
    STATES.REVIEW_PENDING,
    "run_review"
  );
  assert.equal(updated.state, STATES.REVIEW_PENDING);
  assert.equal(updated.next_action, "run_review");
  assert.throws(
    () => updateManifestState({ state: "bogus", timestamps: {} }, STATES.CLOSED, "done"),
    /Unknown relay state/
  );
});
