const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildRedispatchPrompt,
  computeFactorStatusFlips,
} = require("../../../skills/relay-review/scripts/review-runner/redispatch");
const {
  buildConvergenceSummary,
  formatConvergenceMarkdown,
} = require("../../../skills/relay-review/scripts/review-runner/convergence");

function tempRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-convergence-"));
}

function writeVerdict(runDir, round, verdict) {
  fs.writeFileSync(
    path.join(runDir, `review-round-${round}-verdict.json`),
    `${JSON.stringify(verdict, null, 2)}\n`,
    "utf-8"
  );
}

function score(factor, scoreValue, status) {
  return { factor, score: scoreValue, status };
}

function issue(overrides = {}) {
  return {
    file: "src/widget.js",
    line: 12,
    title: "Behavior breaks when state changes",
    category: "Behavior",
    lineage: "repeat",
    ...overrides,
  };
}

function buildSummary({ runDir = tempRunDir(), round, verdict, repeatedIssueCount = 0 }) {
  return buildConvergenceSummary({
    runDir,
    round,
    verdict,
    factorFlips: computeFactorStatusFlips(runDir, round, verdict),
    repeatedIssueCount,
  });
}

test("rounds below 3 yield no convergence summary", () => {
  const verdict = {
    verdict: "changes_requested",
    issues: [issue()],
    rubric_scores: [score("Behavior", 6, "fail")],
  };

  assert.equal(buildSummary({ round: 1, verdict }), null);
  assert.equal(buildSummary({ round: 2, verdict }), null);
});

test("round 3 summary lists repeated factors, lineage counts, score trends, and flip candidates", () => {
  const runDir = tempRunDir();
  writeVerdict(runDir, 1, {
    verdict: "changes_requested",
    issues: [issue({ line: 7 })],
    rubric_scores: [score("Behavior", 7, "pass"), score("Coverage", 5, "fail")],
  });
  writeVerdict(runDir, 2, {
    verdict: "changes_requested",
    issues: [issue({ line: 9 })],
    rubric_scores: [score("behavior", 5, "fail"), score("Coverage", 6, "fail")],
  });
  const verdict = {
    verdict: "changes_requested",
    issues: [issue({ line: 11, lineage: "repeat" })],
    rubric_scores: [score("BEHAVIOR", 6, "pass"), score("Coverage", 7, "pass")],
  };

  const summary = buildSummary({ runDir, round: 3, verdict, repeatedIssueCount: 3 });

  assert.equal(summary.status, "watch");
  assert.deepEqual(summary.repeated_factors, ["BEHAVIOR"]);
  assert.deepEqual(summary.lineage_counts, {
    deepening: 0,
    repeat: 1,
    stale: 0,
    new: 0,
    newly_scoreable: 0,
    unknown: 0,
  });
  assert.deepEqual(summary.score_trends, {
    BEHAVIOR: [7, 5, 6],
    Coverage: [5, 6, 7],
  });
  assert.deepEqual(summary.flip_candidates, [{ factor: "BEHAVIOR", trace: ["pass", "fail", "pass"] }]);
});

test("round 5 summary recommends an operator decision path", async (t) => {
  await t.test("decide_semantics", () => {
    const runDir = tempRunDir();
    writeVerdict(runDir, 3, { rubric_scores: [score("Behavior", 8, "pass")] });
    writeVerdict(runDir, 4, { rubric_scores: [score("Behavior", 5, "fail")] });
    const verdict = {
      verdict: "changes_requested",
      issues: [issue({ lineage: "repeat" })],
      rubric_scores: [score("Behavior", 6, "pass")],
    };

    const summary = buildSummary({ runDir, round: 5, verdict, repeatedIssueCount: 1 });
    assert.equal(summary.status, "decision_recommended");
    assert.equal(summary.recommendation, "decide_semantics");
    assert.match(summary.recommendation_reason, /semantic_instability/);
  });

  await t.test("manual_pairing", () => {
    const verdict = {
      verdict: "changes_requested",
      issues: [issue({ lineage: "deepening" })],
      rubric_scores: [score("Behavior", 6, "fail")],
    };

    const summary = buildSummary({ round: 5, verdict, repeatedIssueCount: 2 });
    assert.equal(summary.recommendation, "manual_pairing");
    assert.match(summary.recommendation_reason, /repeatedIssueCount >= 2/);
  });

  await t.test("narrow_rubric", () => {
    const verdict = {
      verdict: "changes_requested",
      issues: [issue({ lineage: "deepening" })],
      rubric_scores: [
        score("Behavior", 6, "fail"),
        score("Coverage", 5, "fail"),
        score("Scope", 4, "fail"),
      ],
    };

    const summary = buildSummary({ round: 5, verdict, repeatedIssueCount: 1 });
    assert.equal(summary.recommendation, "narrow_rubric");
    assert.match(summary.recommendation_reason, /3 failing rubric factors/);
  });

  await t.test("split_issue", () => {
    const verdict = {
      verdict: "changes_requested",
      issues: [
        issue({ title: "First new finding", lineage: "new" }),
        issue({ title: "Second new finding", lineage: "new" }),
      ],
      rubric_scores: [score("Behavior", 6, "fail")],
    };

    const summary = buildSummary({ round: 5, verdict, repeatedIssueCount: 1 });
    assert.equal(summary.recommendation, "split_issue");
    assert.match(summary.recommendation_reason, /lineage_counts.new >= 2/);
  });

  await t.test("defer_follow_up", () => {
    const verdict = {
      verdict: "changes_requested",
      issues: [issue({ lineage: "deepening" })],
      rubric_scores: [score("Behavior", 6, "fail")],
    };

    const summary = buildSummary({ round: 5, verdict, repeatedIssueCount: 1 });
    assert.equal(summary.recommendation, "defer_follow_up");
    assert.match(summary.recommendation_reason, /no earlier convergence-budget condition matched/);
  });
});

test("progressive deepening flip is not semantic instability", () => {
  const runDir = tempRunDir();
  writeVerdict(runDir, 1, { rubric_scores: [score("Behavior", 8, "pass")] });
  writeVerdict(runDir, 2, { rubric_scores: [score("Behavior", 5, "fail")] });
  const verdict = {
    verdict: "changes_requested",
    issues: [issue({ lineage: "deepening" })],
    rubric_scores: [score("Behavior", 7, "pass")],
  };

  const summary = buildSummary({ runDir, round: 3, verdict });

  assert.deepEqual(summary.flip_candidates, [{ factor: "Behavior", trace: ["pass", "fail", "pass"] }]);
  assert.deepEqual(summary.semantic_instability, []);
});

test("repeat and stale lineage issues surface in the round summary", () => {
  const verdict = {
    verdict: "changes_requested",
    issues: [
      issue({ title: "Behavior repeat", lineage: "repeat" }),
      issue({ title: "Behavior stale", lineage: "stale" }),
    ],
    rubric_scores: [score("Behavior", 5, "fail")],
  };

  const summary = buildSummary({ round: 3, verdict });
  const markdown = formatConvergenceMarkdown(summary);

  assert.deepEqual(summary.lineage_counts, {
    deepening: 0,
    repeat: 1,
    stale: 1,
    new: 0,
    newly_scoreable: 0,
    unknown: 0,
  });
  assert.match(markdown, /repeat=1/);
  assert.match(markdown, /stale=1/);
});

test("clean pass at round 3 yields converged status without recommendation", () => {
  const verdict = {
    verdict: "pass",
    issues: [],
    rubric_scores: [score("Behavior", 9, "pass")],
  };

  const summary = buildSummary({ round: 3, verdict });

  assert.equal(summary.status, "converged");
  assert.equal(Object.hasOwn(summary, "recommendation"), false);
});

test("redispatch prompt includes convergence context without new directives", () => {
  const summary = {
    round: 5,
    status: "decision_recommended",
    repeated_factors: ["Behavior"],
    lineage_counts: { deepening: 0, repeat: 1, stale: 0, new: 0, newly_scoreable: 0, unknown: 0 },
    score_trends: { Behavior: [7, 5, 6] },
    flip_candidates: [{ factor: "Behavior", trace: ["pass", "fail", "pass"] }],
    semantic_instability: [{
      factor: "Behavior",
      trace: ["pass", "fail", "pass"],
      reason: "Flipped factor has tied issues with repeat lineage.",
    }],
    recommendation: "decide_semantics",
    recommendation_reason: "semantic_instability non-empty",
  };

  const prompt = buildRedispatchPrompt({
    verdict: "changes_requested",
    issues: [issue()],
    scope_drift: { creep: [], missing: [] },
    rubric_scores: [score("Behavior", 6, "pass")],
  }, "# Done Criteria\n\n- Keep redispatch targeted.", null, 5, null, "planner_decision", null, summary);

  assert.match(prompt, /## Convergence context/);
  assert.match(prompt, /Status: decision_recommended/);
  assert.match(prompt, /Recommendation: decide_semantics/);
  assert.doesNotMatch(prompt, /modify any file/i);
  assert.doesNotMatch(prompt, /widen/i);
});
