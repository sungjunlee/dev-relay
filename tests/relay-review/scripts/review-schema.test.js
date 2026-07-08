const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REVIEW_VERDICT_JSON_SCHEMA,
  REVIEWER_VERDICT_JSON_SCHEMA,
} = require("../../../skills/relay-review/scripts/review-schema");

const REJECTION_METADATA_FIELDS = ["factor", "attempted_approach", "fix_direction"];

function issueSchema(schema) {
  return schema.properties.issues.items;
}

test("schema/verdict issues mark rejection metadata as nullable+required (OpenAI strict-mode)", async (t) => {
  // OpenAI strict mode forbids genuinely-optional properties: every key in `properties` must
  // appear in `required`. Optional fields are expressed as nullable types instead.
  // Regression history: PR #304 (relates_to), #441 (factor/attempted_approach/fix_direction).
  for (const [label, schema] of [
    ["runner", REVIEW_VERDICT_JSON_SCHEMA],
    ["reviewer", REVIEWER_VERDICT_JSON_SCHEMA],
  ]) {
    await t.test(label, () => {
      const issue = issueSchema(schema);

      assert.equal(issue.additionalProperties, false);
      for (const field of REJECTION_METADATA_FIELDS) {
        assert.deepEqual(issue.properties[field], { type: ["string", "null"], minLength: 1 });
        assert.equal(issue.required.includes(field), true, `${field} must be in required`);
      }
      assert.equal(Object.hasOwn(issue.properties, "unknown_rejection_note"), false);
    });
  }
});

test("schema/verdict issue required matrix lists all 12 properties (strict-mode complete)", async (t) => {
  for (const [label, schema] of [
    ["runner", REVIEW_VERDICT_JSON_SCHEMA],
    ["reviewer", REVIEWER_VERDICT_JSON_SCHEMA],
  ]) {
    await t.test(label, () => {
      const issue = issueSchema(schema);

      assert.deepEqual(issue.required, [
        "title",
        "body",
        "file",
        "line",
        "category",
        "severity",
        "confidence",
        "factor",
        "attempted_approach",
        "fix_direction",
        "lineage",
        "relates_to",
      ]);
    });
  }
});

test("schema/verdict issue confidence enum is required", async (t) => {
  for (const [label, schema] of [
    ["runner", REVIEW_VERDICT_JSON_SCHEMA],
    ["reviewer", REVIEWER_VERDICT_JSON_SCHEMA],
  ]) {
    await t.test(label, () => {
      const issue = issueSchema(schema);

      assert.deepEqual(issue.properties.confidence, {
        type: "string",
        enum: ["low", "medium", "high"],
      });
      assert.equal(issue.required.includes("confidence"), true, "confidence must be required");
    });
  }
});

test("schema/verdict issue lineage enum includes stale", async (t) => {
  for (const [label, schema] of [
    ["runner", REVIEW_VERDICT_JSON_SCHEMA],
    ["reviewer", REVIEWER_VERDICT_JSON_SCHEMA],
  ]) {
    await t.test(label, () => {
      assert.deepEqual(issueSchema(schema).properties.lineage.enum, [
        "new",
        "deepening",
        "repeat",
        "stale",
        "newly_scoreable",
        "unknown",
      ]);
    });
  }
});
