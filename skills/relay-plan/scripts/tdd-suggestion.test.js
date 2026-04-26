const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateTddSuggestion } = require("./tdd-suggestion");

const PROBE_WITH_JEST = JSON.stringify({
  test_infra: [{ name: "jest" }],
  project_tools: { frameworks: [] },
});

const PROBE_WITHOUT_TEST_INFRA = JSON.stringify({
  test_infra: [],
  project_tools: { frameworks: [] },
});

function rubricWithFactors(factors) {
  return [
    "rubric:",
    "  factors:",
    ...factors.flatMap((factor) => [
      `    - name: ${factor.name}`,
      `      tier: ${factor.tier}`,
      `      type: ${factor.type}`,
      ...(factor.command ? [`      command: "${factor.command}"`] : []),
      ...(factor.target ? [`      target: "${factor.target}"`] : []),
      ...(factor.tdd_anchor ? [`      tdd_anchor: "${factor.tdd_anchor}"`] : []),
    ]),
  ].join("\n");
}

test("suggests TDD when test infra, contract automated factor, and no tdd_anchor are present", () => {
  const rubricYaml = rubricWithFactors([
    {
      name: "Parser rejects invalid input",
      tier: "contract",
      type: "automated",
      command: "node --test tests/parser.test.js",
      target: "exit 0",
    },
    {
      name: "Error copy is clear",
      tier: "quality",
      type: "evaluated",
      target: ">= 8/10",
    },
  ]);

  const result = evaluateTddSuggestion({
    rubricYaml,
    probeSignal: PROBE_WITH_JEST,
  });

  assert.equal(result.suggest, true);
  assert.equal(result.runner, "jest");
  assert.deepEqual(result.candidates, ["Parser rejects invalid input"]);
  assert.ok(result.candidates.includes("Parser rejects invalid input"));
});

test("does not suggest TDD when test infra is empty or missing", () => {
  const rubricYaml = rubricWithFactors([
    {
      name: "Parser rejects invalid input",
      tier: "contract",
      type: "automated",
      command: "node --test tests/parser.test.js",
      target: "exit 0",
    },
  ]);

  assert.deepEqual(
    evaluateTddSuggestion({
      rubricYaml,
      probeSignal: PROBE_WITHOUT_TEST_INFRA,
    }),
    { suggest: false, reason: "no_test_infra" }
  );
});

test("does not suggest TDD when no contract automated factors exist", () => {
  const rubricYaml = rubricWithFactors([
    {
      name: "Documentation clarity",
      tier: "contract",
      type: "evaluated",
      target: ">= 8/10",
    },
    {
      name: "Lint stays green",
      tier: "hygiene",
      type: "automated",
      command: "npm run lint",
      target: "exit 0",
    },
  ]);

  assert.deepEqual(
    evaluateTddSuggestion({
      rubricYaml,
      probeSignal: PROBE_WITH_JEST,
    }),
    { suggest: false, reason: "no_automated_contract_factor" }
  );
});

test("does not suggest TDD when any factor already has a tdd_anchor", () => {
  const rubricYaml = rubricWithFactors([
    {
      name: "Parser rejects invalid input",
      tier: "contract",
      type: "automated",
      command: "node --test tests/parser.test.js",
      target: "exit 0",
      tdd_anchor: "tests/parser.test.js",
    },
    {
      name: "Serializer handles nulls",
      tier: "contract",
      type: "automated",
      command: "node --test tests/serializer.test.js",
      target: "exit 0",
    },
  ]);

  assert.deepEqual(
    evaluateTddSuggestion({
      rubricYaml,
      probeSignal: PROBE_WITH_JEST,
    }),
    { suggest: false, reason: "tdd_already_opted_in" }
  );
});

test("throws invalid YAML parse failures at the function boundary", () => {
  assert.throws(() => evaluateTddSuggestion({
    rubricYaml: "factors: [unterminated",
    probeSignal: PROBE_WITH_JEST,
  }));
});
