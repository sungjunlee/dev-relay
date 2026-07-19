const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  validateEarnedRubricArtifact,
} = require("../../../skills/relay-plan/scripts/earned-rubric");

function fixture(name) {
  return fs.readFileSync(
    path.join(__dirname, "..", "fixtures", "evaluation", name),
    "utf8"
  );
}

test("accepts a planning artifact with no earned factors", () => {
  const result = validateEarnedRubricArtifact(fixture("structured-zero-earned.yaml"));

  assert.equal(result.valid, true);
  assert.equal(result.factor_count, 0);
  assert.deepEqual(result.errors, []);
});

test("accepts one earned factor grounded by four eligibility properties and qualitative anchors", () => {
  const result = validateEarnedRubricArtifact(fixture("structured-one-earned.yaml"));

  assert.equal(result.valid, true);
  assert.equal(result.factor_count, 1);
  assert.equal(result.numeric_factor_count, 0);
  assert.deepEqual(result.errors, []);
});

test("accepts several earned factors with optional numeric mapping on only one factor", () => {
  const result = validateEarnedRubricArtifact(fixture("structured-several-earned.yaml"));

  assert.equal(result.valid, true);
  assert.equal(result.factor_count, 3);
  assert.equal(result.numeric_factor_count, 1);
  assert.deepEqual(result.errors, []);
});

test("rejects an unearned generic factor without task evidence or full eligibility", () => {
  const result = validateEarnedRubricArtifact([
    "evaluation:",
    "  schema_version: 2",
    "  outcome_contract:",
    "    source: done_criteria",
    "  verification:",
    "    checks: []",
    "  earned_rubric:",
    "    factors:",
    "      - name: Code quality",
    "        anchors:",
    "          weak: poor",
    "          adequate: okay",
    "          strong: good",
  ].join("\n"));

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "ungrounded_factor"));
  assert.ok(result.errors.some((error) => error.code === "incomplete_eligibility"));
});
