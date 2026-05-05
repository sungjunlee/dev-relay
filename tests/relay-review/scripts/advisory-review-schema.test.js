const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAdvisoryReview, validateAdvisoryProfile } = require("../../../skills/relay-review/scripts/advisory-review-schema");

function advisoryPayload(overrides = {}) {
  return {
    profile: "blindspot",
    summary: "No blocking blind spots found.",
    required_findings: [],
    advisory_findings: [{
      title: "Exercise timeout path",
      body: "The new optional path should have a timeout regression test.",
      file: "skills/relay-review/scripts/review-runner.js",
      line: 42,
      severity: "P3",
      category: "test-gap",
      confidence: 0.8,
    }],
    duplicate_or_low_confidence: [],
    ...overrides,
  };
}

test("advisory schema accepts normalized blindspot payloads", () => {
  const parsed = parseAdvisoryReview(JSON.stringify(advisoryPayload()), { profile: "blindspot" });
  assert.equal(parsed.profile, "blindspot");
  assert.equal(parsed.required_findings.length, 0);
  assert.equal(parsed.advisory_findings[0].category, "test-gap");
});

test("advisory schema rejects unsupported profiles and invalid confidences", () => {
  assert.throws(() => validateAdvisoryProfile("cost"), /Unknown advisory profile/);
  assert.throws(
    () => parseAdvisoryReview(JSON.stringify(advisoryPayload({
      advisory_findings: [{
        title: "Bad confidence",
        body: "Confidence must be bounded.",
        file: "README.md",
        line: 1,
        severity: "P3",
        category: "other",
        confidence: 2,
      }],
    }))),
    /confidence must be a number from 0 to 1/
  );
});

test("advisory schema rejects malformed finding line values", () => {
  assert.throws(
    () => parseAdvisoryReview(JSON.stringify(advisoryPayload({
      advisory_findings: [{
        title: "Bad line",
        body: "Line values must not be silently coerced.",
        file: "README.md",
        line: 0,
        severity: "P3",
        category: "other",
        confidence: 0.6,
      }],
    }))),
    /line must be a positive integer or null/
  );
});
