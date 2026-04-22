const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCommentBody } = require("./review-runner/comment");

test("comment/buildCommentBody preserves the LGTM review marker shape", () => {
  const body = buildCommentBody({
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
  }, 2);

  assert.match(body, /<!-- relay-review -->/);
  assert.match(body, /Verdict: LGTM/);
  assert.match(body, /Quality Review: PASS/);
  assert.match(body, /Quality Execution: PASS/);
  assert.match(body, /Rounds: 2/);
});

test("comment/buildCommentBody preserves rubric gate failures as CHANGES_REQUESTED comments", () => {
  const body = buildCommentBody({
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "missing",
    next_action: "ready_to_merge",
  }, 3, {
    gateFailure: {
      status: "rubric_state_failed_closed",
      layer: "review-runner",
      rubricState: "missing",
      rubricStatus: "missing",
      recoveryCommand: "node dispatch.js ...",
      reason: "rubric missing",
      recovery: "Restore the rubric.",
      summary: "review-runner fail-closed",
    },
  });

  assert.match(body, /<!-- relay-review-round -->/);
  assert.match(body, /Verdict: CHANGES_REQUESTED/);
  assert.match(body, /Quality Execution: MISSING/);
  assert.match(body, /Recovery command: node dispatch\.js/);
});
