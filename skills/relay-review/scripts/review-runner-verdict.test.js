const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseReviewVerdict,
  validateReviewVerdict,
  validateScopeDrift,
} = require("./review-runner/verdict");

function makePassVerdict(overrides = {}) {
  return {
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
    ...overrides,
  };
}

test("verdict/parseReviewVerdict accepts a valid PASS payload", () => {
  const parsed = parseReviewVerdict(JSON.stringify(makePassVerdict()));
  assert.equal(parsed.verdict, "pass");
  assert.equal(parsed.next_action, "ready_to_merge");
});

test("verdict/parseReviewVerdict rejects invalid JSON", () => {
  assert.throws(() => parseReviewVerdict("{"), /must be valid JSON/i);
});

test("verdict/validateReviewVerdict rejects PASS with issues", () => {
  assert.throws(() => validateReviewVerdict(makePassVerdict({
    issues: [{ title: "x", body: "y", file: "a.js", category: "bug", severity: "high", line: 1 }],
  })), /PASS verdict must not include issues/);
});

test("verdict/validateReviewVerdict rejects PASS with blocking scope drift", () => {
  assert.throws(() => validateReviewVerdict(makePassVerdict({
    scope_drift: { creep: [], missing: [{ criteria: "Ship feature", status: "not_done" }] },
  })), /scope_drift\.missing entries/i);
});

test("verdict/validateReviewVerdict rejects changes_requested without issues", () => {
  assert.throws(() => validateReviewVerdict({
    ...makePassVerdict(),
    verdict: "changes_requested",
    next_action: "changes_requested",
  }), /must include at least one issue/);
});

test("verdict/validateReviewVerdict rejects escalated with wrong next_action", () => {
  assert.throws(() => validateReviewVerdict({
    ...makePassVerdict(),
    verdict: "escalated",
    next_action: "changes_requested",
    issues: [{ title: "x", body: "y", file: "a.js", category: "bug", severity: "high", line: 1 }],
  }), /escalated verdict must set next_action=escalated/);
});

test("verdict/validateScopeDrift rejects missing status entries", () => {
  assert.throws(() => validateScopeDrift({
    creep: [],
    missing: [{ criteria: "Ship feature" }],
  }), /scope_drift\.missing\[0\]\.status/i);
});
