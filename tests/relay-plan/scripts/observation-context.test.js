const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  validateObservationContext,
} = require("../../../skills/relay-plan/scripts/observation-context");

function fixture(name) {
  return fs.readFileSync(
    path.join(__dirname, "..", "fixtures", "evaluation", name),
    "utf8"
  );
}

test("accepts design observation grounded in rendered flows and viewports", () => {
  const result = validateObservationContext(fixture("observation-design.yaml"));

  assert.equal(result.valid, true);
  assert.equal(result.factor_count, 2);
  assert.equal(result.lens_count, 1);
  assert.deepEqual(result.errors, []);
});

test("accepts documentation observation without visual tooling", () => {
  const result = validateObservationContext(fixture("observation-documentation.yaml"));

  assert.equal(result.valid, true);
  assert.equal(result.factor_count, 1);
  assert.deepEqual(result.errors, []);
});

test("accepts operations and security observation from runtime and trust-boundary surfaces", () => {
  const result = validateObservationContext(fixture("observation-operations-security.yaml"));

  assert.equal(result.valid, true);
  assert.equal(result.factor_count, 2);
  assert.deepEqual(result.errors, []);
});

test("accepts an explicit no-lens planning result with no earned factors", () => {
  const result = validateObservationContext(fixture("observation-no-lens.yaml"));

  assert.equal(result.valid, true);
  assert.equal(result.factor_count, 0);
  assert.equal(result.lens_count, 0);
  assert.deepEqual(result.errors, []);
});

test("blocks earned quality claims when observation context is missing", () => {
  const result = validateObservationContext([
    "evaluation:",
    "  schema_version: 2",
    "  outcome_contract:",
    "    source: done_criteria",
    "  verification:",
    "    checks: []",
    "  earned_rubric:",
    "    factors:",
    "      - name: Information hierarchy",
  ].join("\n"));

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "missing_observation_context"));
});

test("blocks a design lens based on code inspection alone", () => {
  const content = fixture("observation-design.yaml")
    .replace("kind: rendered_output", "kind: code_inspection")
    .replace("user_flows:", "implementation_paths:")
    .replace("viewports:", "source_files:");
  const result = validateObservationContext(content);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "design_observation_incomplete"));
});

test("blocks quality derivation that omits either forcing inquiry", () => {
  const content = fixture("observation-documentation.yaml")
    .replace(/      expert_notice:.*\n/, "");
  const result = validateObservationContext(content);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "incomplete_observation_inquiry"));
});
