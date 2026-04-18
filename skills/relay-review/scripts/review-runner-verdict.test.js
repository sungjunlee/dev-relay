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
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [makeRubricScore()],
    scope_drift: { creep: [], missing: [] },
    ...overrides,
  };
}

test("verdict/parseReviewVerdict preserves a valid payload shape", () => {
  const payload = makePassVerdict();
  const encoded = JSON.stringify(payload);
  const parsed = parseReviewVerdict(encoded);

  assert.deepEqual(parsed, payload);
  assert.equal(JSON.stringify(parsed), encoded);
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
    {
      label: "unexpected key",
      issue: { ...makeIssue(), extra: true },
      expected: /issues\[0\] has unexpected keys: extra/,
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
    {
      label: "unexpected key",
      score: { ...makeRubricScore(), extra: true },
      expected: /rubric_scores\[0\] has unexpected keys: extra/,
    },
  ];

  for (const { label, score, expected } of cases) {
    await t.test(label, () => {
      assert.throws(() => validateRubricScore(score, 0), expected);
    });
  }
});

test("verdict/validateReviewVerdict rejects stray top-level keys", () => {
  assert.throws(
    () => validateReviewVerdict({ ...makePassVerdict(), stray: true }),
    /Review verdict has unexpected keys: stray/
  );
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

test("verdict/validateScopeDrift rejects stray keys on nested entries", async (t) => {
  await t.test("scope_drift root", () => {
    assert.throws(() => validateScopeDrift({
      creep: [],
      missing: [],
      stray: true,
    }), /scope_drift has unexpected keys: stray/);
  });

  await t.test("scope_drift creep entry", () => {
    assert.throws(() => validateScopeDrift({
      creep: [{ file: "a.js", reason: "extra work", stray: true }],
      missing: [],
    }), /scope_drift\.creep\[0\] has unexpected keys: stray/);
  });

  await t.test("scope_drift missing entry", () => {
    assert.throws(() => validateScopeDrift({
      creep: [],
      missing: [{ criteria: "Ship feature", status: "verified", stray: true }],
    }), /scope_drift\.missing\[0\] has unexpected keys: stray/);
  });
});
