const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_MAX_REVIEW_ROUNDS,
  getMaxReviewRounds,
  shouldEscalateRepairCycle,
} = require("../../../skills/relay-review/scripts/review-runner/round-cap");
const {
  createReviewRoundBudget,
  getReviewRoundBudget,
  recordAppliedReviewBudget,
} = require("../../../skills/relay-dispatch/scripts/manifest/review-budget");

function withBudget({ failures = 0, maxRounds = 2 } = {}) {
  const roundBudget = createReviewRoundBudget();
  roundBudget.consumed.substantive_failures = failures;
  return {
    review: {
      rounds: failures,
      max_rounds: maxRounds,
      round_budget: roundBudget,
      latest_verdict: failures ? "changes_requested" : "pending",
    },
  };
}

test("default review policy permits one substantive repair and exempts protocol verification", () => {
  const data = withBudget();

  assert.equal(DEFAULT_MAX_REVIEW_ROUNDS, 2);
  assert.equal(getMaxReviewRounds(data), 2);
  assert.equal(shouldEscalateRepairCycle({ data, blocking: true }), false);

  data.review.round_budget = recordAppliedReviewBudget(data, {
    phase: "internal",
    substantiveFailure: true,
  });
  assert.equal(shouldEscalateRepairCycle({ data, blocking: true }), true);
  assert.equal(shouldEscalateRepairCycle({ data, blocking: false }), false);

  const snapshot = getReviewRoundBudget(data, { phase: "post_publication" });
  assert.equal(snapshot.limit, 2);
  assert.equal(snapshot.substantive_failures.consumed, 1);
  assert.equal(snapshot.substantive_failures.remaining_before_escalation, 1);
  assert.equal(snapshot.protocol_verifications.exempt_from_substantive_limit, true);
});

test("an explicit extended policy preserves additional substantive failure capacity", () => {
  const data = withBudget({ failures: 1, maxRounds: 5 });

  assert.equal(getMaxReviewRounds(data), 5);
  assert.equal(shouldEscalateRepairCycle({ data, blocking: true }), false);
  data.review.round_budget.consumed.substantive_failures = 4;
  assert.equal(shouldEscalateRepairCycle({ data, blocking: true }), true);
});

test("persisted max_rounds must be a plain positive integer and is never coerced", () => {
  for (const maxRounds of ["5", 0, -1, 2.5, Number.NaN]) {
    assert.throws(
      () => getMaxReviewRounds({ review: { max_rounds: maxRounds } }),
      /must be a positive integer/
    );
  }
});

test("assurance-derived thresholds bound compact and hardened repair depth", () => {
  const compact = withBudget({ maxRounds: 1 });
  const hardened = withBudget({ failures: 1, maxRounds: 3 });

  assert.equal(shouldEscalateRepairCycle({
    data: compact,
    blocking: true,
  }), true);
  assert.equal(shouldEscalateRepairCycle({
    data: hardened,
    blocking: true,
  }), false);
  hardened.review.round_budget.consumed.substantive_failures = 2;
  assert.equal(shouldEscalateRepairCycle({
    data: hardened,
    blocking: true,
  }), true);
});

test("legacy manifests receive a deterministic conservative budget bridge", () => {
  const legacy = {
    state: "publish_pending",
    review: {
      rounds: 2,
      max_rounds: 2,
      latest_verdict: "internal_lgtm",
    },
  };

  const internal = getReviewRoundBudget(legacy, { phase: "internal" });
  assert.equal(internal.compatibility, "legacy_conservative");
  assert.equal(internal.substantive_failures.consumed, 1);
  assert.equal(internal.applied_in_phase, 2);
  assert.equal(internal.protocol_verifications.consumed, 1);

  const persisted = recordAppliedReviewBudget(legacy, {
    phase: "post_publication",
    protocolVerification: true,
  });
  assert.equal(persisted.consumed.substantive_failures, 1);
  assert.deepEqual(persisted.consumed.applied_by_phase, {
    internal: 2,
    post_publication: 1,
  });
  assert.deepEqual(persisted.consumed.protocol_verifications, {
    internal: 1,
    post_publication: 1,
  });
});

test("legacy delayed-publication attribution requires unambiguous internal evidence", () => {
  const ambiguous = {
    state: "review_pending",
    dispatch: {
      publish_policy: "after-internal-review",
    },
    git: {
      pr_number: 123,
    },
    review: {
      rounds: 2,
      max_rounds: 2,
      latest_verdict: "pending",
    },
  };
  const ambiguousBudget = getReviewRoundBudget(ambiguous);
  assert.equal(ambiguousBudget.phase, "post_publication");
  assert.deepEqual(ambiguousBudget.consumed_by_phase, {
    internal: 0,
    post_publication: 2,
  });

  const phaseEvidence = {
    ...ambiguous,
    review: {
      ...ambiguous.review,
      last_review_phase: "internal",
    },
  };
  const migratedBudget = getReviewRoundBudget(phaseEvidence);
  assert.equal(migratedBudget.phase, "post_publication");
  assert.deepEqual(migratedBudget.consumed_by_phase, {
    internal: 2,
    post_publication: 0,
  });
});

test("malformed persisted accounting fails closed instead of falling back to legacy", () => {
  const data = withBudget();
  data.review.round_budget.consumed.substantive_failures = "0";

  assert.throws(
    () => getReviewRoundBudget(data),
    /substantive_failures must be a non-negative integer/
  );
});
