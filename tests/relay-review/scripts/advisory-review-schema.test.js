const test = require("node:test");
const assert = require("node:assert/strict");
const { ADVISORY_PROFILES, parseAdvisoryReview, validateAdvisoryProfile } = require("../../../skills/relay-review/scripts/advisory-review-schema");

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

test("advisory schema normalizes omitted low-confidence severity without promoting the finding", () => {
  const parsed = parseAdvisoryReview(JSON.stringify(advisoryPayload({
    advisory_findings: [],
    duplicate_or_low_confidence: [{
      title: "Possible duplicate timeout concern",
      body: "This may duplicate existing timeout coverage and is intentionally non-required.",
      file: "skills/relay-review/scripts/review-runner.js",
      line: 42,
      category: "test-gap",
      confidence: 0.35,
    }],
  })), { profile: "blindspot" });

  assert.deepEqual(parsed.required_findings, []);
  assert.deepEqual(parsed.advisory_findings, []);
  assert.equal(parsed.duplicate_or_low_confidence.length, 1);
  assert.equal(parsed.duplicate_or_low_confidence[0].severity, "P3");
});

test("advisory schema still requires severity for actionable findings", () => {
  for (const bucket of ["required_findings", "advisory_findings"]) {
    assert.throws(
      () => parseAdvisoryReview(JSON.stringify(advisoryPayload({
        advisory_findings: [],
        [bucket]: [{
          title: "Actionable finding without severity",
          body: "Actionable buckets must remain fail-closed.",
          file: "README.md",
          line: 1,
          category: "other",
          confidence: 0.9,
        }],
      }))),
      new RegExp(`${bucket}\\[0\\]\\.severity must be a non-empty string`)
    );
  }
});

test("advisory schema treats explicit null low-confidence severity as invalid, not omitted", () => {
  assert.throws(
    () => parseAdvisoryReview(JSON.stringify(advisoryPayload({
      advisory_findings: [],
      duplicate_or_low_confidence: [{
        title: "Explicitly malformed duplicate",
        body: "Only an omitted severity is normalized; an explicit invalid value remains fail-closed.",
        file: "README.md",
        line: null,
        severity: null,
        category: "other",
        confidence: 0.3,
      }],
    }))),
    /duplicate_or_low_confidence\[0\]\.severity must be a non-empty string/
  );
});

test("advisory schema defaults missing and empty profile echoes to the lane profile", () => {
  for (const profile of [undefined, null, "", "  \t\n"]) {
    const parsed = parseAdvisoryReview(JSON.stringify(advisoryPayload({ profile })), {
      profile: "blindspot",
    });
    assert.equal(parsed.profile, "blindspot");
  }

  const payloadWithoutProfile = advisoryPayload();
  delete payloadWithoutProfile.profile;
  assert.equal(
    parseAdvisoryReview(JSON.stringify(payloadWithoutProfile), { profile: "adversarial" }).profile,
    "adversarial"
  );
});

test("advisory schema rejects present non-string profile values", () => {
  for (const profile of [42, false, {}, []]) {
    assert.throws(
      () => parseAdvisoryReview(JSON.stringify(advisoryPayload({ profile })), { profile: "blindspot" }),
      /profile must be a non-empty string/
    );
  }
});

test("advisory schema exposes the supported profile list without changing finding shape", () => {
  assert.deepEqual(ADVISORY_PROFILES, ["blindspot", "adversarial"]);
  const parsed = parseAdvisoryReview(JSON.stringify(advisoryPayload({ profile: "adversarial" })), { profile: "adversarial" });
  assert.deepEqual(Object.keys(parsed).sort(), [
    "advisory_findings",
    "duplicate_or_low_confidence",
    "profile",
    "required_findings",
    "summary",
  ]);
  assert.equal(validateAdvisoryProfile("adversarial"), "adversarial");
});

test("advisory schema accepts a single json fenced payload with surrounding whitespace", () => {
  const text = `\n\n  \`\`\`json\n${JSON.stringify(advisoryPayload())}\n\`\`\`\n\n`;

  const parsed = parseAdvisoryReview(text, {
    adapter: "opencode",
    phase: "advisory_review",
    profile: "blindspot",
  });

  assert.equal(parsed.profile, "blindspot");
  assert.equal(parsed.advisory_findings[0].title, "Exercise timeout path");
});

test("advisory schema parses pure, fenced, and prose-wrapped advisory objects identically", () => {
  const payload = JSON.stringify(advisoryPayload());
  const context = {
    adapter: "opencode",
    phase: "advisory_review",
    profile: "blindspot",
  };
  const expected = parseAdvisoryReview(payload, context);

  assert.deepEqual(
    parseAdvisoryReview(`\`\`\`json\n${payload}\n\`\`\``, context),
    expected
  );
  assert.deepEqual(
    parseAdvisoryReview(`Here is the advisory result:\n\n${payload}\n\nNo further notes.`, context),
    expected
  );
});

test("advisory schema fails closed for ambiguous object or array wrappers", () => {
  const payload = JSON.stringify(advisoryPayload());
  const context = {
    adapter: "opencode",
    phase: "advisory_review",
    profile: "blindspot",
  };

  for (const text of [
    `${payload}\n${payload}`,
    `[${payload}]`,
    `\`\`\`json\n${payload}\n\`\`\`\n\n\`\`\`json\n${payload}\n\`\`\``,
  ]) {
    assert.throws(
      () => parseAdvisoryReview(text, context),
      /adapter=opencode phase=advisory_review advisory review must be/
    );
  }
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
