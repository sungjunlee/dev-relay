const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSkipComment,
  evaluateReviewGate,
  hasRelayReviewMarker,
} = require("../../../skills/relay-merge/scripts/review-gate");

function comment(body, author = "relay-reviewer", createdAt = "2026-07-31T00:00:00.000Z") {
  return { body, author, createdAt };
}

test("review gate recognizes primary review markers only", () => {
  assert.equal(hasRelayReviewMarker("<!-- relay-review -->\nVerdict: LGTM"), true);
  assert.equal(hasRelayReviewMarker("<!-- relay-review-round -->\nVerdict: CHANGES_REQUESTED"), true);
  assert.equal(hasRelayReviewMarker("<!-- relay-review-skip -->"), false);
});

test("review gate accepts an authorized primary LGTM without advisory metadata", () => {
  const result = evaluateReviewGate({
    prNumber: 42,
    comments: [comment("<!-- relay-review -->\nVerdict: LGTM\nRounds: 1")],
    commits: [],
    manifestData: null,
    expectedReviewerLogin: "relay-reviewer",
  });
  assert.equal(result.status, "lgtm");
  assert.equal(result.readyToMerge, true);
});

test("review gate keeps primary requested changes blocking", () => {
  const result = evaluateReviewGate({
    prNumber: 42,
    comments: [comment("<!-- relay-review-round -->\nVerdict: CHANGES_REQUESTED\nIssues:\n- fix the bug")],
    commits: [],
    manifestData: null,
    expectedReviewerLogin: "relay-reviewer",
  });
  assert.equal(result.status, "changes_requested");
  assert.equal(result.readyToMerge, false);
  assert.match(result.issues, /fix the bug/);
});

test("review gate rejects an unauthorized primary review marker", () => {
  const result = evaluateReviewGate({
    prNumber: 42,
    comments: [comment("<!-- relay-review -->\nVerdict: LGTM", "untrusted-user")],
    commits: [],
    manifestData: null,
    expectedReviewerLogin: "relay-reviewer",
  });
  assert.equal(result.status, "unauthorized_reviewer");
  assert.equal(result.readyToMerge, false);
});

test("skip comment records the closed rubric audit field", () => {
  assert.equal(
    buildSkipComment("owner override", "missing"),
    [
      "<!-- relay-review-skip -->",
      "## Relay Review — Skipped",
      "Reason: owner override",
      "rubric_status: missing",
    ].join("\n"),
  );
});
