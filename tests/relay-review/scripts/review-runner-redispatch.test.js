const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildRedispatchPrompt,
  buildRubricGateRedispatchPrompt,
  buildScoreOptimizationTarget,
  computeFactorStatusFlips,
  computeRepeatedIssueCount,
  decideFlipFlopEscalation,
  detectChurnGrowth,
  findWeakestBelowTargetQualityScore,
  scanPriorVerdicts,
  summarizeLineage,
} = require("../../../skills/relay-review/scripts/review-runner/redispatch");
const {
  buildRubricRecoveryCommand,
  buildReviewRunnerRubricGateFailure,
} = require("../../../skills/relay-dispatch/scripts/manifest/rubric");

function tempRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-redispatch-"));
}

function makeFlipIssue(overrides = {}) {
  return {
    title: "Behavior edge case",
    category: "Behavior",
    lineage: "deepening",
    ...overrides,
  };
}

function makeFlipDecision(overrides = {}) {
  return decideFlipFlopEscalation({
    verdict: { issues: [makeFlipIssue()] },
    factorFlips: [{ factor: "Behavior", trace: ["pass", "fail", "pass"] }],
    repeatedIssueCount: 0,
    ...overrides,
  });
}

function makeReviewIssue() {
  return {
    title: "Improve hierarchy",
    body: "The visual hierarchy is still flat.",
    file: "src/view.js",
    line: 12,
  };
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

test("redispatch/computeRepeatedIssueCount treats applied-pass downgrade history as a pass boundary", () => {
  const runDir = tempRunDir();
  const issue = { file: "repeat-after-downgrade.js", line: 14, category: "bug", title: "Keep retry guard" };
  fs.writeFileSync(path.join(runDir, "review-round-1-verdict.json"), JSON.stringify({
    verdict: "changes_requested",
    applied_verdict: "changes_requested",
    issues: [issue],
  }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-verdict.json"), JSON.stringify({
    verdict: "changes_requested",
    applied_verdict: "pass",
    issues: [{ ...issue, line: 27, confidence: "low" }],
  }), "utf-8");

  assert.equal(computeRepeatedIssueCount(runDir, 3, [{ ...issue, line: 42 }]), 1);
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

test("redispatch/findWeakestBelowTargetQualityScore selects the largest quality score gap", () => {
  const weakest = findWeakestBelowTargetQualityScore({
    rubric_scores: [
      { factor: "Contract", tier: "contract", target: "exit 0", observed: "pass", status: "pass" },
      { factor: "Craft", tier: "quality", target: ">= 8/10", observed: "7/10", status: "fail", notes: "Needs polish." },
      { factor: "Originality", tier: "quality", target: ">= 8/10", observed: "5.5/10", status: "fail", notes: "Too generic." },
    ],
  });

  assert.deepEqual(weakest, {
    factor: "Originality",
    score: 5.5,
    target_score: 8,
    gap: 2.5,
    notes: "Too generic.",
  });
});

test("redispatch/buildScoreOptimizationTarget includes trend and stagnation guidance", () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, "review-round-1-verdict.json"), JSON.stringify({
    rubric_scores: [{ factor: "Originality", tier: "quality", target: ">= 8/10", observed: "5.5/10", status: "fail" }],
  }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-verdict.json"), JSON.stringify({
    rubric_scores: [{ factor: "Originality", tier: "quality", target: ">= 8/10", observed: "5.5/10", status: "fail" }],
  }), "utf-8");

  const text = buildScoreOptimizationTarget({
    rubric_scores: [{ factor: "Originality", tier: "quality", target: ">= 8/10", observed: "5.5/10", status: "fail", notes: "Too close to stock UI." }],
  }, runDir, 3);

  assert.match(text, /Score optimization target/);
  assert.match(text, /Weakest below-target quality factor: Originality/);
  assert.match(text, /Reviewer score: 5.5\/10 \(target 8\/10, gap 2.5\)/);
  assert.match(text, /Score trend: round 1: 5.5 → round 2: 5.5 → round 3: 5.5/);
  assert.match(text, /Stagnation signal/);
  assert.match(text, /pivot the implementation approach without expanding scope/);
});

test("redispatch/buildRedispatchPrompt adds score optimization beside issue fixes", () => {
  const prompt = buildRedispatchPrompt({
    issues: [makeReviewIssue()],
    scope_drift: { creep: [], missing: [] },
    rubric_scores: [
      { factor: "Design craft", tier: "quality", target: ">= 8/10", observed: "6/10", score: 6, target_score: 8, status: "fail", notes: "Spacing and hierarchy are inconsistent." },
    ],
  }, "# Done Criteria\n\n- Improve design quality.", null, 1, null, "planner_decision");

  assert.match(prompt, /Issues to fix/);
  assert.match(prompt, /src\/view\.js:12/);
  assert.match(prompt, /Score optimization target/);
  assert.match(prompt, /Design craft/);
  assert.match(prompt, /Improve this factor without regressing already passing contract or quality factors/);
});

test("redispatch/buildRedispatchPrompt includes demoting lane required findings and preserves no-demotion output", () => {
  const runDir = tempRunDir();
  const artifactPath = path.join(runDir, "review-round-1-advisory-opencode.json");
  fs.writeFileSync(artifactPath, JSON.stringify({
    profile: "adversarial",
    summary: "Required adversarial finding.",
    required_findings: [{
      title: "Retry race corrupts state",
      body: "Concurrent redispatch can write stale state after the new branch wins.",
      file: "skills/relay-review/scripts/review-runner/redispatch.js",
      line: 42,
      severity: "P1",
      category: "edge-case",
      confidence: 0.92,
    }],
    advisory_findings: [],
    duplicate_or_low_confidence: [],
  }), "utf-8");
  const verdict = {
    issues: [makeReviewIssue()],
    scope_drift: { creep: [], missing: [] },
    rubric_scores: [],
  };

  const baseline = buildRedispatchPrompt(verdict, "# Done Criteria\n\n- Keep redispatch targeted.", runDir, 1, null, "planner_decision");
  const noDemotion = buildRedispatchPrompt(verdict, "# Done Criteria\n\n- Keep redispatch targeted.", runDir, 1, null, "planner_decision", null, null, {
    demotingAdvisoryResults: [],
  });
  const withDemotion = buildRedispatchPrompt(verdict, "# Done Criteria\n\n- Keep redispatch targeted.", runDir, 1, null, "planner_decision", null, null, {
    demotingAdvisoryResults: [{
      reviewer: "opencode",
      profile: "adversarial",
      status: "success",
      artifactPath,
      required_count: 1,
    }],
  });

  assert.equal(noDemotion, baseline);
  assert.match(withDemotion, /Demoting advisory lane findings:/);
  assert.match(withDemotion, /opencode \(profile=adversarial\)/);
  assert.match(withDemotion, /Retry race corrupts state/);
  assert.match(withDemotion, /Concurrent redispatch can write stale state/);
  assert.match(withDemotion, /skills\/relay-review\/scripts\/review-runner\/redispatch\.js:42/);
  assert.match(withDemotion, /severity=P1/);
});

test("redispatch/buildRedispatchPrompt omits rejected approaches when prior issues have no metadata", () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, "review-round-1-verdict.json"), JSON.stringify({
    verdict: "changes_requested",
    summary: "Missing smoke coverage",
    issues: [{ title: "Add smoke coverage", body: "The dispatch path lacks coverage.", file: "tests/dispatch.test.js", line: 18, category: "contract", severity: "high" }],
    rubric_scores: [],
  }), "utf-8");

  const prompt = buildRedispatchPrompt({
    issues: [makeReviewIssue()],
    scope_drift: { creep: [], missing: [] },
    rubric_scores: [],
  }, "# Done Criteria\n\n- Preserve prior summary behavior.", runDir, 2, null, "planner_decision");

  assert.match(prompt, /Prior review rounds:/);
  assert.match(prompt, /Round 1: changes_requested — Missing smoke coverage/);
  assert.doesNotMatch(prompt, /Previously rejected approaches/);
});

test("redispatch/buildRedispatchPrompt renders compact rejected approaches grouped by factor", () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, "review-round-1-verdict.json"), JSON.stringify({
    verdict: "changes_requested",
    summary: "Round 1 rejected approach",
    issues: [{
      title: "Scope drift remains",
      body: "The state helper still widens scope.",
      file: "src/state.js",
      line: 11,
      category: "contract",
      severity: "high",
      factor: "Scope control",
      attempted_approach: "Copied the old helper without checking callers.",
      fix_direction: "Audit the state helper callers before changing behavior.",
    }],
    rubric_scores: [],
  }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-verdict.json"), JSON.stringify({
    verdict: "changes_requested",
    summary: "Round 2 rejected approach",
    issues: [{
      title: "Scope drift still remains",
      body: "The state helper still widens scope.",
      file: "src/state.js",
      line: 22,
      category: "contract",
      severity: "high",
      factor: "Scope control",
      attempted_approach: "Reverted only the direct diff hunk.",
      fix_direction: "Follow the helper import chain and revert the paired state change.",
    }, {
      title: "Rubric score lacks coverage",
      body: "The reviewer cannot score the factor.",
      file: "tests/review.test.js",
      line: 31,
      category: "contract",
      severity: "high",
      factor: "Rubric coverage",
      attempted_approach: "Added assertions for the generic summary only.",
      fix_direction: "Assert the structured rejection section.",
    }],
    rubric_scores: [],
  }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-3-verdict.json"), JSON.stringify({
    verdict: "changes_requested",
    summary: "Round 3 rejected approach",
    issues: [{
      title: "Scope drift persists",
      body: "The state helper still widens scope.",
      file: "src/state.js",
      line: 33,
      category: "contract",
      severity: "high",
      factor: "Scope control",
      attempted_approach: "Moved the state change behind a wrapper.",
      fix_direction: "Remove the state change instead of hiding it.",
    }],
    rubric_scores: [],
  }), "utf-8");

  const prompt = buildRedispatchPrompt({
    issues: [makeReviewIssue()],
    scope_drift: { creep: [], missing: [] },
    rubric_scores: [],
  }, "# Done Criteria\n\n- Keep redispatch targeted.", runDir, 4, null, "planner_decision");

  assert.match(prompt, /Previously rejected approaches:/);
  assert.match(prompt, /- Scope control:/);
  assert.match(prompt, /Round 3: attempted Moved the state change behind a wrapper\. Fix direction: Remove the state change instead of hiding it\./);
  assert.match(prompt, /Round 2: attempted Reverted only the direct diff hunk\. Fix direction: Follow the helper import chain and revert the paired state change\./);
  assert.doesNotMatch(prompt, /Copied the old helper without checking callers/);
  assert.match(prompt, /- Rubric coverage:/);
  assert.match(prompt, /Round 2: attempted Added assertions for the generic summary only\. Fix direction: Assert the structured rejection section\./);
});

test("redispatch/computeFactorStatusFlips detects pass-fail-pass with normalized factor names", () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, "review-round-1-verdict.json"), JSON.stringify({ rubric_scores: [{ factor: " Behavior ", status: "pass" }] }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-verdict.json"), JSON.stringify({ rubric_scores: [{ factor: "behavior", status: "fail" }] }), "utf-8");
  const flips = computeFactorStatusFlips(runDir, 3, { rubric_scores: [{ factor: "BEHAVIOR", status: "pass" }] });
  assert.deepEqual(flips, [{ factor: "BEHAVIOR", trace: ["pass", "fail", "pass"] }]);
});

test("redispatch/computeFactorStatusFlips detects fail-pass-fail (symmetric direction)", () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, "review-round-1-verdict.json"), JSON.stringify({ rubric_scores: [{ factor: "Behavior", status: "fail" }] }), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-verdict.json"), JSON.stringify({ rubric_scores: [{ factor: "Behavior", status: "pass" }] }), "utf-8");
  const flips = computeFactorStatusFlips(runDir, 3, { rubric_scores: [{ factor: "Behavior", status: "fail" }] });
  assert.deepEqual(flips, [{ factor: "Behavior", trace: ["fail", "pass", "fail"] }]);
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

test("redispatch/decideFlipFlopEscalation suppresses progressive deepening flip-flops", () => {
  assert.deepEqual(makeFlipDecision(), {
    decision: "continue",
    reason: "progressive_deepening",
    factors: ["Behavior"],
    traces: [{ factor: "Behavior", trace: ["pass", "fail", "pass"] }],
    lineage_summary: { deepening: 1, repeat: 0, stale: 0, new: 0, newly_scoreable: 0, unknown: 0 },
  });
});

test("redispatch/decideFlipFlopEscalation preserves clean pass verdicts on flip-flop with zero repeats", () => {
  assert.deepEqual(makeFlipDecision({ verdict: { verdict: "pass", issues: [] } }), {
    decision: "continue",
    reason: "progressive_deepening",
    factors: ["Behavior"],
    traces: [{ factor: "Behavior", trace: ["pass", "fail", "pass"] }],
    lineage_summary: { deepening: 0, repeat: 0, stale: 0, new: 0, newly_scoreable: 0, unknown: 0 },
  });
});

test("redispatch/decideFlipFlopEscalation escalates mixed lineage flip-flops", () => {
  const decision = makeFlipDecision({
    verdict: { issues: [makeFlipIssue(), makeFlipIssue({ title: "Behavior still broken", lineage: "repeat" })] },
  });
  assert.equal(decision.decision, "escalate");
  assert.equal(decision.reason, "flip_flop_thrash");
  assert.deepEqual(decision.lineage_summary, { deepening: 1, repeat: 1, stale: 0, new: 0, newly_scoreable: 0, unknown: 0 });
});

test("redispatch/decideFlipFlopEscalation escalates repeated-issue thrash even with deepening lineage", () => {
  const decision = makeFlipDecision({ repeatedIssueCount: 1 });
  assert.equal(decision.decision, "escalate");
  assert.equal(decision.reason, "flip_flop_thrash");
});

test("redispatch/decideFlipFlopEscalation escalates missing lineage on flipped-factor issues", () => {
  const decision = makeFlipDecision({ verdict: { issues: [makeFlipIssue({ lineage: undefined })] } });
  assert.equal(decision.decision, "escalate");
  assert.equal(decision.reason, "flip_flop_thrash");
  assert.deepEqual(decision.lineage_summary, { deepening: 0, repeat: 0, stale: 0, new: 0, newly_scoreable: 0, unknown: 1 });
});

test("redispatch/decideFlipFlopEscalation escalates stale lineage on flipped-factor issues", () => {
  const decision = makeFlipDecision({ verdict: { issues: [makeFlipIssue({ lineage: "stale" })] } });
  assert.equal(decision.decision, "escalate");
  assert.equal(decision.reason, "flip_flop_thrash");
  assert.deepEqual(decision.lineage_summary, { deepening: 0, repeat: 0, stale: 1, new: 0, newly_scoreable: 0, unknown: 0 });
});

test("redispatch/summarizeLineage distinguishes unknown from repeat", () => {
  assert.deepEqual(summarizeLineage([
    { lineage: "repeat" },
    { lineage: "stale" },
    { lineage: "unknown" },
    {},
    { lineage: "made_up" },
  ]), { deepening: 0, repeat: 1, stale: 1, new: 0, newly_scoreable: 0, unknown: 3 });
});

test("redispatch/buildRedispatchPrompt shows lineage counts and same-HEAD stale candidates", () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
    event: "review_apply",
    round: 1,
    head_sha: "abc123",
  })}\n`, "utf-8");

  const prompt = buildRedispatchPrompt({
    issues: [
      { ...makeReviewIssue(), title: "Repeat issue", lineage: "repeat", relates_to: "Round 1 repeat" },
      { ...makeReviewIssue(), title: "Stale issue", lineage: "stale", relates_to: "Round 1 stale" },
      { ...makeReviewIssue(), title: "Deeper issue", lineage: "deepening", relates_to: "Behavior" },
    ],
    scope_drift: { creep: [], missing: [] },
    rubric_scores: [],
  }, "# Done Criteria\n\n- Keep lineage visible.", runDir, 2, null, "planner_decision", "abc123");

  assert.match(prompt, /Current review lineage: deepening=1, repeat=1, stale=1, new=0, newly_scoreable=0, unknown=0/);
  assert.match(prompt, /Current issue lineage labels:/);
  assert.match(prompt, /Repeat issue: lineage=repeat, relates_to=Round 1 repeat/);
  assert.match(prompt, /Stale issue: lineage=stale, relates_to=Round 1 stale/);
  assert.match(prompt, /Deeper issue: lineage=deepening, relates_to=Behavior/);
  assert.match(prompt, /Same-HEAD stale candidates:/);
  assert.match(prompt, /matches prior review round 1 \(abc123\)/);
  assert.match(prompt, /Deterministic signal only/);
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
