const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyChangedFiles,
  collectRoutingTagSources,
  normalizeTags,
  resolveRoutingDecision,
  validateRoutingRules,
} = require("../../../skills/relay-dispatch/scripts/relay-routing");

function policy(routingRules = []) {
  return {
    defaults: {
      review: { reviewer: "codex" },
      advisory_review: null,
      sidecar: null,
    },
    routing_rules: routingRules,
  };
}

test("routing normalizes tags from CSV and arrays deterministically", () => {
  assert.deepEqual(
    normalizeTags([" Docs ", "docs", "TEST-GAP", "", null, "test-gap"]),
    ["docs", "test-gap"]
  );
  assert.deepEqual(normalizeTags(" Docs, 'test-gap' ,, \"SECURITY\" "), ["docs", "test-gap", "security"]);
});

test("routing CLI tags override inferred labels, profile, rubric, and file tags", () => {
  const decision = resolveRoutingDecision({
    policy: policy([
      {
        name: "docs",
        match: { tags: ["docs-only"] },
        sidecar: { kind: "docs-sync", executor: "opencode" },
      },
      {
        name: "security",
        match: { tags: ["security"] },
        advisory_review: { reviewer: "claude", profile: "blindspot" },
      },
    ]),
    cliTags: "security",
    issueLabels: ["docs-only"],
    taskProfile: { risk_tags: ["docs-only"], domains: ["docs"] },
    rubric: { tags: ["docs-only"] },
    changedFiles: ["README.md"],
  });

  assert.equal(decision.effective_source, "cli");
  assert.deepEqual(decision.effective_tags, ["security"]);
  assert.equal(decision.matched, true);
  assert.equal(decision.matched_rule.name, "security");
  assert.deepEqual(decision.selected.advisory_review, { reviewer: "claude", profile: "blindspot" });
  assert.equal(decision.selected.sidecar, null);
});

test("routing collects label, task_profile, rubric, and test-command tags when CLI tags are absent", () => {
  const sources = collectRoutingTagSources({
    issueLabels: ["needs-review", "Docs"],
    taskProfile: {
      domains: ["relay-dispatch"],
      risk_tags: ["trust-boundary"],
      guidance_packs: ["verification-evidence"],
    },
    rubric: {
      tags: ["rubric-tag"],
      task_profile: { risk_tags: ["profile-rubric"] },
    },
    testCommands: ["node --test tests/relay-dispatch/scripts/relay-routing.test.js"],
  });

  assert.deepEqual(sources.effective_tags, [
    "needs-review",
    "docs",
    "relay-dispatch",
    "trust-boundary",
    "verification-evidence",
    "rubric-tag",
    "profile-rubric",
    "test-gap",
  ]);
  assert.equal(sources.effective_source, "inferred");
});

test("routing changed-file classifier recognizes docs-only and test-gap candidates", () => {
  assert.deepEqual(
    classifyChangedFiles(["README.md", "docs/usage.md", "skills/relay/SKILL.md"]),
    ["docs", "docs-only"]
  );
  assert.deepEqual(classifyChangedFiles(["tests/relay-dispatch/scripts/relay-routing.test.js"]), [
    "tests",
    "test-gap",
  ]);
  assert.deepEqual(classifyChangedFiles(["skills/relay-dispatch/scripts/dispatch.js"]), []);
});

test("routing first matching rule selects advisory and sidecar defaults only", () => {
  const originalPolicy = policy([
    {
      name: "first",
      match: { tags: ["docs"] },
      review: { reviewer: "opencode" },
      advisory_review: { reviewer: "claude", profile: "blindspot" },
      sidecar: { kind: "docs-sync", executor: "opencode" },
    },
    {
      name: "second",
      match: { tags: ["docs"] },
      advisory_review: { reviewer: "opencode" },
    },
  ]);

  const decision = resolveRoutingDecision({
    policy: originalPolicy,
    issueLabels: ["docs"],
  });

  assert.equal(decision.matched, true);
  assert.equal(decision.matched_rule.name, "first");
  assert.deepEqual(decision.selected, {
    advisory_review: { reviewer: "claude", profile: "blindspot" },
    sidecar: { kind: "docs-sync", executor: "opencode" },
  });
  assert.deepEqual(originalPolicy.defaults.review, { reviewer: "codex" });
  assert.deepEqual(decision.ignored_primary_review, { reviewer: "opencode" });
});

test("routing reports no match with null advisory and sidecar selections", () => {
  const decision = resolveRoutingDecision({
    policy: policy([
      {
        name: "docs",
        match: { tags: ["docs"] },
        sidecar: { kind: "docs-sync" },
      },
    ]),
    issueLabels: ["security"],
  });

  assert.equal(decision.matched, false);
  assert.equal(decision.matched_rule, null);
  assert.deepEqual(decision.selected, { advisory_review: null, sidecar: null });
  assert.equal(decision.no_match_reason, "no_routing_rule_matched");
});

test("routing duplicate rule names warn but preserve first-match order", () => {
  const rules = [
    {
      name: "dup",
      match: { tags: ["docs"] },
      sidecar: { kind: "docs-sync" },
    },
    {
      name: "dup",
      match: { tags: ["docs"] },
      sidecar: { kind: "test-gap" },
    },
  ];

  assert.deepEqual(validateRoutingRules(rules).warnings, [
    {
      code: "duplicate_rule_name",
      name: "dup",
      first_index: 0,
      duplicate_index: 1,
    },
  ]);

  const decision = resolveRoutingDecision({ policy: policy(rules), issueLabels: ["docs"] });
  assert.equal(decision.matched_rule.name, "dup");
  assert.equal(decision.matched_rule.index, 0);
  assert.deepEqual(decision.selected.sidecar, { kind: "docs-sync" });
  assert.deepEqual(decision.warnings, [
    {
      code: "duplicate_rule_name",
      name: "dup",
      first_index: 0,
      duplicate_index: 1,
    },
  ]);
});
