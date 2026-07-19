const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateReviewerScoresForArtifact,
} = require("../../../skills/relay-review/scripts/review-runner/evaluation-channels");

function structuredArtifact(factors) {
  return [
    "evaluation:",
    "  schema_version: 2",
    "  outcome_contract:",
    "    source: done_criteria",
    "  verification:",
    "    checks: []",
    "  earned_rubric:",
    factors.length === 0 ? "    factors: []" : "    factors:",
    ...factors.map((factor) => `      - name: ${factor}`),
  ].join("\n");
}

function score(factor, tier = "quality") {
  return {
    factor,
    tier,
    target: "strong",
    observed: "adequate",
    score: null,
    target_score: null,
    status: "fail",
    notes: "Reviewer observation.",
  };
}

test("structured zero-factor artifacts require no invented reviewer scores", () => {
  assert.doesNotThrow(() => validateReviewerScoresForArtifact({
    content: structuredArtifact([]),
  }, []));
  assert.throws(
    () => validateReviewerScoresForArtifact({
      content: structuredArtifact([]),
    }, [score("Generic code quality")]),
    /must not invent scores/i
  );
});

test("structured reviewer scores must exactly match persisted Earned Rubric factors", () => {
  const rubricLoad = {
    content: structuredArtifact(["Recovery clarity", "Product character fit"]),
  };

  assert.doesNotThrow(() => validateReviewerScoresForArtifact(rubricLoad, [
    score("Recovery clarity"),
    score("Product character fit"),
  ]));
  assert.throws(
    () => validateReviewerScoresForArtifact(rubricLoad, [
      score("Recovery clarity"),
      score("Generic code quality"),
    ]),
    /missing.*Product character fit.*unexpected.*Generic code quality/is
  );
});

test("structured channels reject contract or verification entries in reviewer scores", () => {
  assert.throws(
    () => validateReviewerScoresForArtifact({
      content: structuredArtifact(["Recovery clarity"]),
    }, [score("Recovery clarity", "contract")]),
    /tier=quality/i
  );
});

test("legacy rubric verdict compatibility still requires non-empty scores", () => {
  const rubricLoad = {
    content: [
      "rubric:",
      "  factors:",
      "    - name: Legacy behavior",
    ].join("\n"),
  };

  assert.doesNotThrow(() => validateReviewerScoresForArtifact(
    rubricLoad,
    [score("Legacy behavior", "contract")]
  ));
  assert.throws(
    () => validateReviewerScoresForArtifact(rubricLoad, []),
    /legacy rubric.*score every factor/i
  );
});
