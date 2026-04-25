const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseReviewVerdict,
  validateIssue,
  validateReviewVerdict,
  validateRubricScore,
  validateScopeDrift,
} = require("./review-runner/verdict");

function makeIssue(overrides = {}) {
  return {
    title: "Fix auth flow",
    body: "The login branch still skips token refresh.",
    file: "skills/relay-review/scripts/review-runner.js",
    category: "bug",
    severity: "high",
    line: 42,
    ...overrides,
  };
}

function makeRubricScore(overrides = {}) {
  return {
    factor: "Behavior parity",
    target: "All extracted stages preserve legacy semantics",
    observed: "Focused suites cover the split helpers",
    status: "pass",
    tier: "contract",
    notes: "No semantic drift found.",
    ...overrides,
  };
}

function makePassVerdict(overrides = {}) {
  return {
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [makeRubricScore()],
    scope_drift: { creep: [], missing: [] },
    ...overrides,
  };
}

function makeChangesRequestedVerdict(issueOverrides = {}) {
  return makePassVerdict({
    verdict: "changes_requested",
    summary: "Fix the blocking issue.",
    contract_status: "fail",
    quality_review_status: "not_run",
    next_action: "changes_requested",
    issues: [makeIssue(issueOverrides)],
  });
}

test("verdict/parseReviewVerdict preserves a valid payload shape", () => {
  const payload = makePassVerdict();
  const encoded = JSON.stringify(payload);
  const parsed = parseReviewVerdict(encoded);

  assert.deepEqual(parsed, payload);
  assert.equal(JSON.stringify(parsed), encoded);
});

test("verdict/validateReviewVerdict allows reviewer payloads to omit quality_execution_status before runner override", () => {
  const reviewerPayload = makePassVerdict();
  delete reviewerPayload.quality_execution_status;

  const validated = validateReviewVerdict(reviewerPayload, { requireExecutionStatus: false });
  assert.equal(validated.quality_execution_status, undefined);
});

test("verdict/validateReviewVerdict accepts every lineage enum value", async (t) => {
  for (const lineage of ["new", "deepening", "repeat", "newly_scoreable", "unknown"]) {
    await t.test(lineage, () => {
      const verdict = validateReviewVerdict(makeChangesRequestedVerdict({ lineage, relates_to: "round-1 issue" }));
      assert.equal(verdict.issues[0].lineage, lineage);
    });
  }
});

test("verdict/validateReviewVerdict accepts missing lineage for back-compat", () => {
  const verdict = validateReviewVerdict(makeChangesRequestedVerdict());
  assert.equal(verdict.issues[0].lineage, undefined);
});

test("verdict/validateReviewVerdict rejects unrecognized lineage values", () => {
  assert.throws(
    () => validateReviewVerdict(makeChangesRequestedVerdict({ lineage: "made_up" })),
    /issues\[0\]\.lineage must be one of: new, deepening, repeat, newly_scoreable, unknown/
  );
});

test("verdict/validateReviewVerdict validates relates_to when present", () => {
  assert.equal(validateReviewVerdict(makeChangesRequestedVerdict({ relates_to: "prior finding" })).issues[0].relates_to, "prior finding");
  assert.throws(
    () => validateReviewVerdict(makeChangesRequestedVerdict({ relates_to: "" })),
    /issues\[0\]\.relates_to must be a non-empty string when present/
  );
});

test("verdict/parseReviewVerdict rejects invalid JSON", () => {
  assert.throws(() => parseReviewVerdict("{"), /must be valid JSON/i);
});

test("verdict/validateIssue preserves the malformed-field matrix", async (t) => {
  const cases = [
    {
      label: "non-object",
      issue: null,
      expected: /issues\[0\] must be an object/,
    },
    {
      label: "missing title",
      issue: makeIssue({ title: "   " }),
      expected: /issues\[0\]\.title is required/,
    },
    {
      label: "missing body",
      issue: makeIssue({ body: "" }),
      expected: /issues\[0\]\.body is required/,
    },
    {
      label: "missing file",
      issue: makeIssue({ file: "" }),
      expected: /issues\[0\]\.file is required/,
    },
    {
      label: "missing category",
      issue: makeIssue({ category: "" }),
      expected: /issues\[0\]\.category is required/,
    },
    {
      label: "missing severity",
      issue: makeIssue({ severity: "" }),
      expected: /issues\[0\]\.severity is required/,
    },
    {
      label: "line must be positive integer",
      issue: makeIssue({ line: 0 }),
      expected: /issues\[0\]\.line must be a positive integer/,
    },
  ];

  for (const { label, issue, expected } of cases) {
    await t.test(label, () => {
      assert.throws(() => validateIssue(issue, 0), expected);
    });
  }
});

test("verdict/validateRubricScore preserves the validation matrix", async (t) => {
  const cases = [
    {
      label: "non-object",
      score: null,
      expected: /rubric_scores\[0\] must be an object/,
    },
    {
      label: "missing factor",
      score: makeRubricScore({ factor: " " }),
      expected: /rubric_scores\[0\]\.factor is required/,
    },
    {
      label: "missing target",
      score: makeRubricScore({ target: "" }),
      expected: /rubric_scores\[0\]\.target is required/,
    },
    {
      label: "missing observed",
      score: makeRubricScore({ observed: "" }),
      expected: /rubric_scores\[0\]\.observed is required/,
    },
    {
      label: "missing notes",
      score: makeRubricScore({ notes: "" }),
      expected: /rubric_scores\[0\]\.notes is required/,
    },
    {
      label: "missing tier",
      score: makeRubricScore({ tier: "" }),
      expected: /rubric_scores\[0\]\.tier is required/,
    },
    {
      label: "invalid status",
      score: makeRubricScore({ status: "blocked" }),
      expected: /rubric_scores\[0\]\.status must be one of: pass, fail, not_run/,
    },
    {
      label: "invalid tier",
      score: makeRubricScore({ tier: "style" }),
      expected: /rubric_scores\[0\]\.tier must be one of: contract, quality/,
    },
  ];

  for (const { label, score, expected } of cases) {
    await t.test(label, () => {
      assert.throws(() => validateRubricScore(score, 0), expected);
    });
  }
});

test("verdict validation preserves pre-split tolerance for extra keys", () => {
  const issue = { ...makeIssue(), extra: true };
  const score = { ...makeRubricScore(), extra: true };
  const scopeDrift = {
    creep: [{ file: "a.js", reason: "extra work", stray: true }],
    missing: [{ criteria: "Ship feature", status: "verified", stray: true }],
    extra: true,
  };
  const verdict = validateReviewVerdict({
    ...makePassVerdict(),
    issues: [],
    rubric_scores: [score],
    scope_drift: scopeDrift,
    stray: true,
  });

  assert.equal(validateIssue(issue, 0), undefined);
  assert.equal(validateRubricScore(score, 0), undefined);
  assert.equal(validateScopeDrift(scopeDrift), undefined);
  assert.equal(verdict.stray, true);
  assert.equal(verdict.rubric_scores[0].extra, true);
  assert.equal(verdict.scope_drift.extra, true);
  assert.equal(verdict.scope_drift.creep[0].stray, true);
  assert.equal(verdict.scope_drift.missing[0].stray, true);
});

test("verdict/validateReviewVerdict rejects PASS with issues", () => {
  assert.throws(() => validateReviewVerdict(makePassVerdict({
    issues: [makeIssue()],
  })), /PASS verdict must not include issues/);
});

test("verdict/validateReviewVerdict rejects PASS with blocking scope drift", () => {
  assert.throws(() => validateReviewVerdict(makePassVerdict({
    scope_drift: { creep: [], missing: [{ criteria: "Ship feature", status: "not_done" }] },
  })), /scope_drift\.missing entries/i);
});

test("verdict/validateReviewVerdict rejects PASS when quality_review_status is not pass", () => {
  assert.throws(() => validateReviewVerdict(makePassVerdict({
    quality_review_status: "not_run",
  })), /PASS verdict failed: quality_review_status=not_run/);
});

test("verdict/validateReviewVerdict rejects PASS when quality_execution_status is missing", () => {
  assert.throws(() => validateReviewVerdict(makePassVerdict({
    quality_execution_status: "missing",
    quality_execution_reason: 'execution-evidence.json missing; if this is a pre-261 run, use finalize-run --force-finalize-nonready --reason "pre-261 run, no artifact"',
  })), /PASS verdict failed: quality_execution_status=missing/);
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
    issues: [makeIssue()],
  }), /escalated verdict must set next_action=escalated/);
});

test("verdict/validateScopeDrift rejects missing status entries", () => {
  assert.throws(() => validateScopeDrift({
    creep: [],
    missing: [{ criteria: "Ship feature" }],
  }), /scope_drift\.missing\[0\]\.status/i);
});

test("verdict/validateScopeDrift preserves legacy malformed nested-entry behavior", async (t) => {
  const cases = [
    {
      label: "creep null entry still throws native property access error",
      scopeDrift: { creep: [null], missing: [] },
      expected: /Cannot read properties of null \(reading 'file'\)/,
    },
    {
      label: "creep string entry still fails on missing file field",
      scopeDrift: { creep: ["extra"], missing: [] },
      expected: /scope_drift\.creep\[0\]\.file is required/,
    },
    {
      label: "creep array entry still fails on missing file field",
      scopeDrift: { creep: [[]], missing: [] },
      expected: /scope_drift\.creep\[0\]\.file is required/,
    },
    {
      label: "missing null entry still throws native property access error",
      scopeDrift: { creep: [], missing: [null] },
      expected: /Cannot read properties of null \(reading 'criteria'\)/,
    },
    {
      label: "missing string entry still fails on missing criteria field",
      scopeDrift: { creep: [], missing: ["extra"] },
      expected: /scope_drift\.missing\[0\]\.criteria is required/,
    },
    {
      label: "missing array entry still fails on missing criteria field",
      scopeDrift: { creep: [], missing: [[]] },
      expected: /scope_drift\.missing\[0\]\.criteria is required/,
    },
  ];

  for (const { label, scopeDrift, expected } of cases) {
    await t.test(label, () => {
      assert.throws(() => validateScopeDrift(scopeDrift), expected);
    });
  }
});
