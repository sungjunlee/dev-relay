const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildRubricGateRedispatchPrompt,
  buildRubricRecoveryCommand,
  buildReviewRunnerRubricGateFailure,
  computeFactorStatusFlips,
  computeRepeatedIssueCount,
  detectChurnGrowth,
  scanPriorVerdicts,
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

test("redispatch/computeRepeatedIssueCount repeats across line churn", () => {
  const runDir = tempRunDir();
  for (const [round, line] of [[1, 11], [2, 27], [3, 42]]) fs.writeFileSync(path.join(runDir, `review-round-${round}-verdict.json`), JSON.stringify({ verdict: "changes_requested", issues: [{ file: "line-shift.js", line, category: "bug", title: "Preserve retry budget" }] }), "utf-8");
  assert.equal(computeRepeatedIssueCount(runDir, 3, [{ file: "line-shift.js", line: 99, category: "bug", title: "Preserve retry budget" }]), 3);
});

test("redispatch/computeRepeatedIssueCount does not merge distinct titles", () => {
  const runDir = tempRunDir();
  for (const [round, title] of [[1, "First cache fix"], [2, "Second cache fix"], [3, "Third cache fix"]]) fs.writeFileSync(path.join(runDir, `review-round-${round}-verdict.json`), JSON.stringify({ verdict: "changes_requested", issues: [{ file: "title-guard.js", line: 18, category: "bug", title }] }), "utf-8");
  assert.equal(computeRepeatedIssueCount(runDir, 3, [{ file: "title-guard.js", line: 18, category: "bug", title: "Third cache fix" }]), 1);
});

test("redispatch/computeRepeatedIssueCount keeps identical non-regression fingerprints repeating", async (t) => {
  await t.test("same file/category/title still counts to three", () => {
    const runDir = tempRunDir();
    const issue = { file: "repeat-still.js", line: 14, category: "bug", title: "Keep diff anchor stable" };
    for (const round of [1, 2, 3]) fs.writeFileSync(path.join(runDir, `review-round-${round}-verdict.json`), JSON.stringify({ verdict: "changes_requested", issues: [issue] }), "utf-8");
    assert.equal(computeRepeatedIssueCount(runDir, 3, [issue]), 3);
  });
});

test("redispatch/scanPriorVerdicts walks reverse-chronological rounds and skips missing files", () => {
  const runDir = tempRunDir();
  for (const round of [1, 3, 4]) {
    fs.writeFileSync(path.join(runDir, `review-round-${round}-verdict.json`), JSON.stringify({ verdict: `round-${round}` }), "utf-8");
  }
  const rounds = [];
  scanPriorVerdicts(runDir, 5, (_verdict, round) => rounds.push(round));
  assert.deepEqual(rounds, [4, 3, 1]);
});

test("redispatch/scanPriorVerdicts only stops on false", () => {
  const runDir = tempRunDir();
  for (const round of [1, 2, 3]) {
    fs.writeFileSync(path.join(runDir, `review-round-${round}-verdict.json`), JSON.stringify({ verdict: `round-${round}` }), "utf-8");
  }
  const rounds = [];
  scanPriorVerdicts(runDir, 4, (_verdict, round) => {
    rounds.push(round);
    return round === 2 ? false : null;
  });
  assert.deepEqual(rounds, [3, 2]);
});

test("redispatch/scanPriorVerdicts does not invoke the callback when no prior verdicts exist", () => {
  const runDir = tempRunDir();
  let calls = 0;
  scanPriorVerdicts(runDir, 1, () => { calls += 1; });
  scanPriorVerdicts(runDir, 3, () => { calls += 1; });
  assert.equal(calls, 0);
});

test("redispatch/computeFactorStatusFlips detects pass-fail-pass with normalized factor names", () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, "review-round-1-verdict.json"), JSON.stringify({ rubric_scores: [{ factor: " Behavior ", status: "pass" }] }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-verdict.json"), JSON.stringify({ rubric_scores: [{ factor: "behavior", status: "fail" }] }), "utf-8");
  const flips = computeFactorStatusFlips(runDir, 3, { rubric_scores: [{ factor: "BEHAVIOR", status: "pass" }] });
  assert.deepEqual(flips, [{ factor: "BEHAVIOR", trace: ["pass", "fail", "pass"] }]);
});

test("redispatch/computeFactorStatusFlips ignores two-round changes and not_run gaps", () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, "review-round-1-verdict.json"), JSON.stringify({ rubric_scores: [{ factor: "behavior", status: "pass" }] }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-verdict.json"), JSON.stringify({ rubric_scores: [{ factor: "behavior", status: "not_run" }] }), "utf-8");
  const flips = computeFactorStatusFlips(runDir, 3, { rubric_scores: [{ factor: "behavior", status: "fail" }] });
  assert.deepEqual(flips, []);
});

test("redispatch/computeFactorStatusFlips ignores factors that change in different rounds", () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, "review-round-1-verdict.json"), JSON.stringify({ rubric_scores: [{ factor: "A", status: "pass" }, { factor: "B", status: "pass" }] }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-verdict.json"), JSON.stringify({ rubric_scores: [{ factor: "A", status: "fail" }, { factor: "B", status: "pass" }] }), "utf-8");
  const flips = computeFactorStatusFlips(runDir, 3, { rubric_scores: [{ factor: "A", status: "fail" }, { factor: "B", status: "fail" }] });
  assert.deepEqual(flips, []);
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

test("redispatch/buildRubricRecoveryCommand preserves the caller contract", () => {
  assert.equal(
    buildRubricRecoveryCommand("issue-189", "/tmp/review-round-2-redispatch.md"),
    "node skills/relay-dispatch/scripts/dispatch.js . --run-id issue-189 --prompt-file /tmp/review-round-2-redispatch.md --rubric-file <fixed-rubric.yaml>"
  );
});

test("redispatch/buildRubricGateRedispatchPrompt includes the recovery command and scope anchor", () => {
  const gateFailure = buildReviewRunnerRubricGateFailure("issue-189", "/tmp/review-round-2-redispatch.md", {
    state: "missing",
    status: "missing",
    error: "rubric missing",
  });
  const prompt = buildRubricGateRedispatchPrompt(
    gateFailure,
    "# Issue #189\n\nKeep the split scoped to extracted review-runner helpers.",
    "github-issue"
  );

  assert.match(prompt, /Gate status: rubric_state_failed_closed/);
  assert.match(prompt, /Recovery command: node skills\/relay-dispatch\/scripts\/dispatch\.js \. --run-id issue-189 --prompt-file \/tmp\/review-round-2-redispatch\.md --rubric-file <fixed-rubric\.yaml>/);
  assert.match(prompt, /Done Criteria source: github-issue/);
  assert.match(prompt, /Keep the split scoped to extracted review-runner helpers\./);
});
