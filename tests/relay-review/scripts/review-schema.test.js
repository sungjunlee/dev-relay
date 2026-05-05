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

test("schema/verdict issues allow optional rejection metadata while staying strict", async (t) => {
  for (const [label, schema] of [
    ["runner", REVIEW_VERDICT_JSON_SCHEMA],
    ["reviewer", REVIEWER_VERDICT_JSON_SCHEMA],
  ]) {
    await t.test(label, () => {
      const issue = issueSchema(schema);

      assert.equal(issue.additionalProperties, false);
      for (const field of REJECTION_METADATA_FIELDS) {
        assert.deepEqual(issue.properties[field], { type: "string", minLength: 1 });
        assert.equal(issue.required.includes(field), false);
      }
      assert.equal(Object.hasOwn(issue.properties, "unknown_rejection_note"), false);
    });
  }
});

test("schema/verdict issue historical required fields do not gain rejection metadata", async (t) => {
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
        "lineage",
        "relates_to",
      ]);
    });
  }
});
