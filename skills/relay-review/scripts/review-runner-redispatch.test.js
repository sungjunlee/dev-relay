const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildReviewRunnerRubricGateFailure,
  computeRepeatedIssueCount,
  detectChurnGrowth,
} = require("./review-runner/redispatch");

function tempRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-redispatch-"));
}

test("redispatch/detectChurnGrowth preserves the diff-growth matrix", () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, "review-round-1-diff.patch"), "1\n2\n", "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-diff.patch"), "1\n2\n3\n", "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-3-diff.patch"), "1\n2\n3\n4\n", "utf-8");

  assert.equal(detectChurnGrowth(runDir, 2), null);
  assert.deepEqual(detectChurnGrowth(runDir, 3), {
    prevPrevLines: 2,
    prevLines: 3,
    curLines: 4,
  });
});

test("redispatch/computeRepeatedIssueCount only counts consecutive identical changes_requested rounds", () => {
  const runDir = tempRunDir();
  const issue = { file: "a.js", line: 9, category: "bug", title: "Fix auth" };
  const other = { file: "b.js", line: 3, category: "bug", title: "Other" };
  fs.writeFileSync(path.join(runDir, "review-round-1-verdict.json"), JSON.stringify({
    verdict: "changes_requested",
    issues: [issue],
  }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-verdict.json"), JSON.stringify({
    verdict: "changes_requested",
    issues: [issue],
  }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-3-verdict.json"), JSON.stringify({
    verdict: "changes_requested",
    issues: [other],
  }), "utf-8");

  assert.equal(computeRepeatedIssueCount(runDir, 4, [issue]), 1);
  assert.equal(computeRepeatedIssueCount(runDir, 3, [issue]), 3);
});

test("redispatch/buildReviewRunnerRubricGateFailure preserves the fail-closed recovery matrix", async (t) => {
  const cases = [
    ["not_set", /Persist a rubric/i],
    ["missing", /Restore or replace the missing rubric/i],
    ["outside_run_dir", /escaped rubric anchor/i],
    ["empty", /Regenerate the empty rubric/i],
    ["invalid", /Fix or replace the rubric anchor/i],
  ];

  for (const [state, message] of cases) {
    await t.test(state, () => {
      const failure = buildReviewRunnerRubricGateFailure("issue-189", "/tmp/redispatch.md", {
        state,
        status: state,
        error: `error-${state}`,
      });
      assert.equal(failure.status, "rubric_state_failed_closed");
      assert.match(failure.recovery, message);
      assert.match(failure.recoveryCommand, /dispatch\.js/);
    });
  }

  await t.test("loaded passthrough", () => {
    assert.equal(buildReviewRunnerRubricGateFailure("issue-189", "/tmp/redispatch.md", {
      state: "loaded",
      status: "satisfied",
      error: null,
    }), null);
  });
});
