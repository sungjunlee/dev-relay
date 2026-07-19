const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  classifyEvaluationArtifact,
} = require("../../../skills/relay-dispatch/scripts/evaluation-contract");

const STRUCTURED_WITHOUT_RUBRIC = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "..",
    "relay-plan",
    "fixtures",
    "evaluation",
    "structured-zero-earned.yaml"
  ),
  "utf8"
);

test("classifies all three structured evaluation channels without requiring earned factors", () => {
  assert.deepEqual(classifyEvaluationArtifact(STRUCTURED_WITHOUT_RUBRIC), {
    kind: "structured",
    schema_version: 2,
    has_outcome_contract: true,
    has_verification: true,
    earned_factor_count: 0,
  });
});

test("counts only list items nested under earned_rubric.factors", () => {
  const artifact = STRUCTURED_WITHOUT_RUBRIC.replace(
    "    factors: []",
    [
      "    factors:",
      "      - name: Recovery clarity",
      "        type: evaluated",
      "        target: strong",
      "      - name: Interaction coherence",
      "        type: evaluated",
      "        target: strong",
    ].join("\n")
  );

  assert.equal(classifyEvaluationArtifact(artifact).earned_factor_count, 2);
});

test("keeps legacy rubric artifacts distinguishable and readable", () => {
  const legacy = [
    "rubric:",
    "  prerequisites:",
    "    - command: node --test",
    "      target: exit 0",
    "  factors:",
    "    - name: Existing contract factor",
    "      tier: contract",
    "      target: pass",
  ].join("\n");

  assert.deepEqual(classifyEvaluationArtifact(legacy), {
    kind: "legacy",
    schema_version: 1,
    has_outcome_contract: false,
    has_verification: false,
    earned_factor_count: null,
  });
});
