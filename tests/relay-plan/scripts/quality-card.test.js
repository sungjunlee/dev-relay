const test = require("node:test");
const assert = require("node:assert/strict");

const { buildQualityCardSummary } = require("../../../skills/relay-plan/scripts/quality-card");

const PROBE_WITH_JEST = JSON.stringify({
  test_infra: [{ name: "jest" }],
  project_tools: { frameworks: [] },
});

const PROBE_WITHOUT_TEST_INFRA = JSON.stringify({
  test_infra: [],
  project_tools: { frameworks: [] },
});

function rubricWithFactors(factors, { prerequisites = [] } = {}) {
  return [
    "rubric:",
    ...(prerequisites.length
      ? [
        "  prerequisites:",
        ...prerequisites.flatMap((prereq) => [
          `    - command: "${prereq.command}"`,
          `      target: "${prereq.target || "exit 0"}"`,
        ]),
      ]
      : []),
    "  factors:",
    ...factors.flatMap((factor) => [
      `    - name: ${factor.name}`,
      `      tier: ${factor.tier || "contract"}`,
      `      type: ${factor.type || "automated"}`,
      ...(factor.command ? [`      command: "${factor.command}"`] : []),
      ...(factor.criteria ? [`      criteria: "${factor.criteria}"`] : []),
      `      target: "${factor.target || "exit 0"}"`,
      ...(factor.tdd_anchor ? [`      tdd_anchor: "${factor.tdd_anchor}"`] : []),
      ...(factor.tdd_runner ? [`      tdd_runner: "${factor.tdd_runner}"`] : []),
    ]),
  ].join("\n");
}

test("flags a repo-wide hygiene command placed in a factor", () => {
  const result = buildQualityCardSummary({
    rubricYaml: rubricWithFactors([
      {
        name: "Repo suite remains green",
        command: "node --test tests/*/scripts/*.test.js",
      },
    ]),
  });

  assert.deepEqual(result.hygiene_in_factor_violations, ["Repo suite remains green"]);
  assert.ok(result.warnings.some((warning) => warning.code === "repo_hygiene_in_factor"));
});

test("does not flag a task-specific command as hygiene", () => {
  const result = buildQualityCardSummary({
    rubricYaml: rubricWithFactors([
      {
        name: "Parser rejects invalid input",
        command: "node --test tests/parser.test.js",
      },
    ]),
  });

  assert.deepEqual(result.hygiene_in_factor_violations, []);
  assert.ok(!result.warnings.some((warning) => warning.code === "repo_hygiene_in_factor"));
});

test("warns all_contract for a design-bearing task with zero quality factors and no waiver", () => {
  const result = buildQualityCardSummary({
    rubricYaml: rubricWithFactors([
      { name: "Route decision is preserved", tier: "contract" },
    ]),
    taskProfile: { risk_tags: ["design-bearing"] },
  });

  assert.equal(result.quality_factors, 0);
  assert.ok(result.warnings.some((warning) => warning.code === "all_contract"));
  assert.equal(result.quality_waiver, "");
});

test("suppresses all_contract warning and echoes the waiver when one is provided", () => {
  const result = buildQualityCardSummary({
    rubricYaml: rubricWithFactors([
      { name: "Route decision is preserved", tier: "contract" },
    ]),
    taskProfile: { risk_tags: ["design-bearing"] },
    qualityWaiver: "Mechanical route swap; no user-visible copy changed.",
  });

  assert.equal(result.quality_factors, 0);
  assert.ok(!result.warnings.some((warning) => warning.code === "all_contract"));
  assert.equal(result.quality_waiver, "Mechanical route swap; no user-visible copy changed.");
});

test("reports TDD anchors applied with their runner and null skip_reason", () => {
  const result = buildQualityCardSummary({
    rubricYaml: rubricWithFactors([
      {
        name: "Parser rejects invalid input",
        tier: "contract",
        type: "automated",
        command: "node --test tests/parser.test.js",
        tdd_anchor: "tests/parser.test.js",
        tdd_runner: "node:test",
      },
    ]),
  });

  assert.equal(result.tdd.eligible_count, 1);
  assert.equal(result.tdd.applied_count, 1);
  assert.deepEqual(result.tdd.anchors, [
    { factor: "Parser rejects invalid input", tdd_anchor: "tests/parser.test.js", tdd_runner: "node:test" },
  ]);
  assert.equal(result.tdd.skip_reason, null);
});

test("accepts an explicit standardized skip reason when no anchors are applied", () => {
  const result = buildQualityCardSummary({
    rubricYaml: rubricWithFactors([
      { name: "README documents the new flag", tier: "contract", type: "evaluated", target: ">= 8/10" },
    ]),
    tddSkipReason: "docs_only",
  });

  assert.equal(result.tdd.applied_count, 0);
  assert.equal(result.tdd.skip_reason, "docs_only");
});

test("throws on an unknown tddSkipReason instead of silently coercing it", () => {
  assert.throws(() => buildQualityCardSummary({
    rubricYaml: rubricWithFactors([
      { name: "README documents the new flag", tier: "contract", type: "evaluated", target: ">= 8/10" },
    ]),
    tddSkipReason: "because-reasons",
  }));
});

test("auto-derives no_runner when no anchors are applied and the probe reports no test infra", () => {
  const result = buildQualityCardSummary({
    rubricYaml: rubricWithFactors([
      {
        name: "Parser rejects invalid input",
        tier: "contract",
        type: "automated",
        command: "node --test tests/parser.test.js",
      },
    ]),
    probeSignal: PROBE_WITHOUT_TEST_INFRA,
  });

  assert.equal(result.tdd.applied_count, 0);
  assert.equal(result.tdd.skip_reason, "no_runner");
});

test("leaves skip_reason null when test infra exists but the planner declared nothing", () => {
  const result = buildQualityCardSummary({
    rubricYaml: rubricWithFactors([
      {
        name: "Parser rejects invalid input",
        tier: "contract",
        type: "automated",
        command: "node --test tests/parser.test.js",
      },
    ]),
    probeSignal: PROBE_WITH_JEST,
  });

  assert.equal(result.tdd.applied_count, 0);
  assert.equal(result.tdd.skip_reason, null);
});

test("counts prerequisites at whatever list indentation the rubric uses, excluding nested sequences", () => {
  const fourSpaceItems = [
    "rubric:",
    "  prerequisites:",
    "      - command: \"npm test\"",
    "        target: \"exit 0\"",
    "      - command: \"tsc --noEmit\"",
    "        target: \"exit 0\"",
    "  factors:",
    "    - name: X",
    "      tier: contract",
    "      target: \"exit 0\"",
  ].join("\n");
  assert.equal(buildQualityCardSummary({ rubricYaml: fourSpaceItems }).prerequisites_count, 2);

  const sameIndentItems = [
    "rubric:",
    "  prerequisites:",
    "  - command: \"npm test\"",
    "    target: \"exit 0\"",
    "  factors:",
    "    - name: X",
    "      tier: contract",
    "      target: \"exit 0\"",
  ].join("\n");
  assert.equal(buildQualityCardSummary({ rubricYaml: sameIndentItems }).prerequisites_count, 1);

  const nestedSequence = [
    "rubric:",
    "  prerequisites:",
    "    - command: \"npm test\"",
    "      args:",
    "        - \"--verbose\"",
    "        - \"--bail\"",
    "  factors:",
    "    - name: X",
    "      tier: contract",
    "      target: \"exit 0\"",
  ].join("\n");
  assert.equal(buildQualityCardSummary({ rubricYaml: nestedSequence }).prerequisites_count, 1);
});

test("counts prerequisites, contract, and quality factors on a mixed rubric", () => {
  const result = buildQualityCardSummary({
    rubricYaml: rubricWithFactors(
      [
        { name: "Parser rejects invalid input", tier: "contract" },
        { name: "CLI renders new field", tier: "contract" },
        {
          name: "Error copy remains actionable",
          tier: "quality",
          type: "evaluated",
          criteria: "Inspect CLI error paths for clear next actions.",
          target: ">= 8/10",
        },
      ],
      {
        prerequisites: [
          { command: "npm test" },
          { command: "tsc --noEmit" },
        ],
      }
    ),
  });

  assert.equal(result.prerequisites_count, 2);
  assert.equal(result.contract_factors, 2);
  assert.equal(result.quality_factors, 1);
});
