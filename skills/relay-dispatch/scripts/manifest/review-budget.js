const { STATES } = require("./lifecycle");

const REVIEW_BUDGET_SCHEMA_VERSION = 1;
const REVIEW_BUDGET_TOPOLOGY = "substantive_failures_with_protocol_verifications";
const REVIEW_BUDGET_LIMIT_SOURCE = "review.max_rounds";
const DEFAULT_MAX_REVIEW_ROUNDS = 2;
const REVIEW_PHASES = Object.freeze({
  INTERNAL: "internal",
  POST_PUBLICATION: "post_publication",
});

function zeroPhaseCounts() {
  return {
    [REVIEW_PHASES.INTERNAL]: 0,
    [REVIEW_PHASES.POST_PUBLICATION]: 0,
  };
}

function createReviewRoundBudget() {
  return {
    schema_version: REVIEW_BUDGET_SCHEMA_VERSION,
    topology: REVIEW_BUDGET_TOPOLOGY,
    limit_source: REVIEW_BUDGET_LIMIT_SOURCE,
    consumed: {
      substantive_failures: 0,
      protocol_verifications: zeroPhaseCounts(),
      applied_by_phase: zeroPhaseCounts(),
    },
  };
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function requirePhase(phase) {
  if (!Object.values(REVIEW_PHASES).includes(phase)) {
    throw new Error(
      `Review phase must be one of: ${Object.values(REVIEW_PHASES).join(", ")}`
    );
  }
  return phase;
}

function getMaxReviewRounds(data) {
  const configured = data?.review?.max_rounds;
  if (configured === undefined || configured === null) return DEFAULT_MAX_REVIEW_ROUNDS;
  if (!Number.isInteger(configured) || configured <= 0) {
    throw new Error("Persisted review.max_rounds must be a positive integer");
  }
  return configured;
}

function reviewPhaseForManifest(data) {
  if (data?.state === STATES.INTERNAL_REVIEW_PENDING) {
    return REVIEW_PHASES.INTERNAL;
  }
  if (data?.state === STATES.REVIEW_PENDING) {
    return REVIEW_PHASES.POST_PUBLICATION;
  }
  if (data?.state === STATES.PUBLISH_PENDING) {
    return REVIEW_PHASES.INTERNAL;
  }
  const persistedPhase = data?.review?.last_review_phase;
  if (Object.values(REVIEW_PHASES).includes(persistedPhase)) {
    return persistedPhase;
  }
  if (data?.review?.latest_verdict === "internal_lgtm") {
    return REVIEW_PHASES.INTERNAL;
  }
  if (
    data?.dispatch?.publish_policy === "after-internal-review"
    && !data?.git?.pr_number
  ) {
    return REVIEW_PHASES.INTERNAL;
  }
  return REVIEW_PHASES.POST_PUBLICATION;
}

function normalizePersistedBudget(budget) {
  if (budget.schema_version !== REVIEW_BUDGET_SCHEMA_VERSION) {
    throw new Error(
      `Persisted review.round_budget.schema_version must be ${REVIEW_BUDGET_SCHEMA_VERSION}`
    );
  }
  if (budget.topology !== REVIEW_BUDGET_TOPOLOGY) {
    throw new Error(
      `Persisted review.round_budget.topology must be '${REVIEW_BUDGET_TOPOLOGY}'`
    );
  }
  if (budget.limit_source !== REVIEW_BUDGET_LIMIT_SOURCE) {
    throw new Error(
      `Persisted review.round_budget.limit_source must be '${REVIEW_BUDGET_LIMIT_SOURCE}'`
    );
  }

  const consumed = budget.consumed;
  if (!consumed || typeof consumed !== "object" || Array.isArray(consumed)) {
    throw new Error("Persisted review.round_budget.consumed must be an object");
  }
  const protocolVerifications = consumed.protocol_verifications;
  const appliedByPhase = consumed.applied_by_phase;
  if (
    !protocolVerifications
    || typeof protocolVerifications !== "object"
    || Array.isArray(protocolVerifications)
  ) {
    throw new Error(
      "Persisted review.round_budget.consumed.protocol_verifications must be an object"
    );
  }
  if (!appliedByPhase || typeof appliedByPhase !== "object" || Array.isArray(appliedByPhase)) {
    throw new Error(
      "Persisted review.round_budget.consumed.applied_by_phase must be an object"
    );
  }

  return {
    schema_version: REVIEW_BUDGET_SCHEMA_VERSION,
    topology: REVIEW_BUDGET_TOPOLOGY,
    limit_source: REVIEW_BUDGET_LIMIT_SOURCE,
    consumed: {
      substantive_failures: requireNonNegativeInteger(
        consumed.substantive_failures,
        "Persisted review.round_budget.consumed.substantive_failures"
      ),
      protocol_verifications: {
        [REVIEW_PHASES.INTERNAL]: requireNonNegativeInteger(
          protocolVerifications[REVIEW_PHASES.INTERNAL],
          "Persisted review.round_budget.consumed.protocol_verifications.internal"
        ),
        [REVIEW_PHASES.POST_PUBLICATION]: requireNonNegativeInteger(
          protocolVerifications[REVIEW_PHASES.POST_PUBLICATION],
          "Persisted review.round_budget.consumed.protocol_verifications.post_publication"
        ),
      },
      applied_by_phase: {
        [REVIEW_PHASES.INTERNAL]: requireNonNegativeInteger(
          appliedByPhase[REVIEW_PHASES.INTERNAL],
          "Persisted review.round_budget.consumed.applied_by_phase.internal"
        ),
        [REVIEW_PHASES.POST_PUBLICATION]: requireNonNegativeInteger(
          appliedByPhase[REVIEW_PHASES.POST_PUBLICATION],
          "Persisted review.round_budget.consumed.applied_by_phase.post_publication"
        ),
      },
    },
  };
}

function isProtocolPass(latestVerdict) {
  return ["internal_lgtm", "lgtm", "pass"].includes(latestVerdict);
}

function deriveLegacyBudget(data) {
  const rounds = requireNonNegativeInteger(
    data?.review?.rounds ?? 0,
    "Persisted review.rounds"
  );
  const phase = reviewPhaseForManifest(data);
  const budget = createReviewRoundBudget();
  const latestVerdict = data?.review?.latest_verdict;

  // A legacy manifest cannot reveal every prior verdict from frontmatter alone.
  // Count every round except a definitely passing latest verdict as substantive.
  // This deterministic over-count is conservative and never grants hidden repair
  // capacity merely because the accounting block predates this schema.
  budget.consumed.substantive_failures = isProtocolPass(latestVerdict)
    ? Math.max(0, rounds - 1)
    : rounds;
  budget.consumed.applied_by_phase[phase] = rounds;
  if (isProtocolPass(latestVerdict) && rounds > 0) {
    budget.consumed.protocol_verifications[phase] = 1;
  }
  return budget;
}

function normalizeReviewRoundBudget(data) {
  const persisted = data?.review?.round_budget;
  if (persisted === undefined || persisted === null) {
    return {
      budget: deriveLegacyBudget(data),
      compatibility: "legacy_conservative",
    };
  }
  return {
    budget: normalizePersistedBudget(persisted),
    compatibility: "persisted",
  };
}

function getReviewRoundBudget(data, { phase = reviewPhaseForManifest(data) } = {}) {
  const normalizedPhase = requirePhase(phase);
  const { budget, compatibility } = normalizeReviewRoundBudget(data);
  const limit = getMaxReviewRounds(data);
  const substantiveFailures = budget.consumed.substantive_failures;
  return {
    schema_version: budget.schema_version,
    topology: budget.topology,
    limit_source: budget.limit_source,
    compatibility,
    phase: normalizedPhase,
    limit,
    substantive_failures: {
      consumed: substantiveFailures,
      remaining_before_escalation: Math.max(0, limit - substantiveFailures),
    },
    protocol_verifications: {
      consumed: budget.consumed.protocol_verifications[normalizedPhase],
      exempt_from_substantive_limit: true,
    },
    applied_in_phase: budget.consumed.applied_by_phase[normalizedPhase],
    consumed_by_phase: {
      ...budget.consumed.applied_by_phase,
    },
  };
}

function recordAppliedReviewBudget(data, {
  phase = reviewPhaseForManifest(data),
  protocolVerification = false,
  substantiveFailure = false,
} = {}) {
  const normalizedPhase = requirePhase(phase);
  const { budget } = normalizeReviewRoundBudget(data);
  const updated = {
    ...budget,
    consumed: {
      substantive_failures: (
        budget.consumed.substantive_failures
        + (substantiveFailure ? 1 : 0)
      ),
      protocol_verifications: {
        ...budget.consumed.protocol_verifications,
        [normalizedPhase]: (
          budget.consumed.protocol_verifications[normalizedPhase]
          + (protocolVerification ? 1 : 0)
        ),
      },
      applied_by_phase: {
        ...budget.consumed.applied_by_phase,
        [normalizedPhase]: budget.consumed.applied_by_phase[normalizedPhase] + 1,
      },
    },
  };
  return normalizePersistedBudget(updated);
}

module.exports = {
  DEFAULT_MAX_REVIEW_ROUNDS,
  REVIEW_BUDGET_LIMIT_SOURCE,
  REVIEW_BUDGET_SCHEMA_VERSION,
  REVIEW_BUDGET_TOPOLOGY,
  REVIEW_PHASES,
  createReviewRoundBudget,
  getMaxReviewRounds,
  getReviewRoundBudget,
  normalizeReviewRoundBudget,
  recordAppliedReviewBudget,
  reviewPhaseForManifest,
};
