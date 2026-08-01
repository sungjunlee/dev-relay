const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  TDD_COMMIT_PREFIX,
  applyTddFlavorToDispatchPrompt,
  extractAllFactors,
  extractTddFactors,
  hasTddAnchor,
  renderIterationProtocolForRubric,
  resolveTddFactors,
} = require("../../../skills/relay-plan/scripts/tdd-flavor");
const BASELINE_PROMPT_PATH = path.join(__dirname, "..", "fixtures", "dispatch-prompt-baseline", "non-tdd.md");

const NON_TDD_RUBRIC = [
  "rubric:",
  "  factors:",
  "    - name: Documentation completeness",
  "      tier: contract",
  "      type: evaluated",
  "      target: \">= 8/10\"",
].join("\n");

const TDD_RUBRIC = [
  "rubric:",
  "  prerequisites:",
  "    - command: \"node --test\"",
  "      target: \"exit 0\"",
  "  factors:",
  "    - name: Parser rejects invalid input",
  "      tier: contract",
  "      type: automated",
  "      command: \"node --test tests/parser.test.js\"",
  "      target: \"exit 0\"",
  "      weight: required",
  "      tdd_anchor: \"tests/parser.test.js\"",
  "      tdd_runner: \"node:test\"",
  "    - name: Error copy is actionable",
  "      tier: quality",
  "      type: evaluated",
  "      target: \">= 8/10\"",
].join("\n");

const PROBE_WITH_TEST_INFRA = JSON.stringify({
  test_infra: [{ name: "node:test" }],
  project_tools: { frameworks: [{ name: "jest", source: "package.json" }] },
});

test("non-TDD rubric leaves dispatch prompt byte-identical to baseline", () => {
  const baseline = fs.readFileSync(BASELINE_PROMPT_PATH, "utf-8");

  const rendered = applyTddFlavorToDispatchPrompt({
    dispatchPrompt: baseline,
    rubricYaml: NON_TDD_RUBRIC,
    probeSignal: PROBE_WITH_TEST_INFRA,
  });

  assert.equal(rendered, baseline);
});

test("non-TDD baseline delegates the repair process while requiring evidence and a commit", () => {
  const baseline = fs.readFileSync(BASELINE_PROMPT_PATH, "utf-8");

  assert.match(baseline, /## Completion Responsibilities/);
  assert.match(baseline, /Capture concise verification evidence/);
  assert.match(baseline, /final work is committed/);
  assert.doesNotMatch(baseline, /Score Log/);
  assert.doesNotMatch(baseline, /self-(?:evaluate|review)/i);
  assert.doesNotMatch(baseline, /weakest (?:required )?factor/i);
  assert.doesNotMatch(baseline, /max \d+ iterations/i);
  assert.doesNotMatch(baseline, /REGRESSION CHECK/);
  assert.doesNotMatch(baseline, /Oscillation/);
});

test("TDD rubric inserts Step 0a before the final prerequisite gate without restoring executor ceremony", () => {
  const baseline = fs.readFileSync(BASELINE_PROMPT_PATH, "utf-8");

  const rendered = applyTddFlavorToDispatchPrompt({
    dispatchPrompt: baseline,
    rubricYaml: TDD_RUBRIC,
    probeSignal: PROBE_WITH_TEST_INFRA,
  });

  assert.match(rendered, /0a\. TDD RED ANCHOR STEP/);
  assert.match(rendered, new RegExp(TDD_COMMIT_PREFIX));
  assert.match(rendered, /tests\/parser\.test\.js/);
  assert.match(rendered, /Do not modify `rubric\.factors\[\]\.command`/);
  assert.ok(rendered.indexOf("0a. TDD RED ANCHOR STEP") < rendered.indexOf("  0. PREREQUISITE GATE"));
  assert.match(rendered, /  0\. PREREQUISITE GATE/);
  assert.doesNotMatch(rendered, /Score Log/);
  assert.doesNotMatch(rendered, /self-(?:evaluate|review)/i);
  assert.doesNotMatch(rendered, /max \d+ iterations/i);
});

test("empty tdd_anchor values do not activate Step 0a", () => {
  const baseline = fs.readFileSync(BASELINE_PROMPT_PATH, "utf-8");
  const emptyAnchorRubric = [
    "rubric:",
    "  factors:",
    "    - name: Empty double-quoted anchor",
    "      tdd_anchor: \"\"",
    "      tdd_runner: \"node:test\"",
    "    - name: Empty single-quoted anchor",
    "      tdd_anchor: ''",
    "      tdd_runner: \"node:test\"",
  ].join("\n");

  const rendered = applyTddFlavorToDispatchPrompt({
    dispatchPrompt: baseline,
    rubricYaml: emptyAnchorRubric,
    probeSignal: PROBE_WITH_TEST_INFRA,
  });

  assert.equal(hasTddAnchor(emptyAnchorRubric), false);
  assert.deepEqual(resolveTddFactors({
    rubricYaml: emptyAnchorRubric,
    probeSignal: PROBE_WITH_TEST_INFRA,
  }), []);
  assert.equal(rendered, baseline);
});

test("extractAllFactors returns every factor regardless of tdd_anchor presence", () => {
  const rubric = [
    "rubric:",
    "  factors:",
    "    - command: \"node --test tests/parser.test.js\"",
    "      tier: contract",
    "      type: automated",
    "      name: Parser rejects invalid input",
    "      tdd_anchor: \"tests/parser.test.js\"",
    "      tdd_runner: \"node:test\"",
    "    - type: evaluated",
    "      name: Error copy is actionable",
    "      tier: quality",
  ].join("\n");
  const factors = extractAllFactors(rubric);

  assert.deepEqual(factors.map((factor) => ({
    name: factor.name,
    tier: factor.tier,
    type: factor.type,
    tdd_anchor: factor.tdd_anchor,
    tdd_runner: factor.tdd_runner,
  })), [
    {
      name: "Parser rejects invalid input",
      tier: "contract",
      type: "automated",
      tdd_anchor: "tests/parser.test.js",
      tdd_runner: "node:test",
    },
    {
      name: "Error copy is actionable",
      tier: "quality",
      type: "evaluated",
      tdd_anchor: null,
      tdd_runner: null,
    },
  ]);
});

test("extractAllFactors carries fix_hint additively without changing TDD projections", () => {
  const rubric = [
    "rubric:",
    "  factors:",
    "    - name: Parser rejects invalid input",
    "      tier: contract",
    "      type: automated",
    "      tdd_anchor: \"tests/parser.test.js\"",
    "      tdd_runner: \"node:test\"",
    "      fix_hint: \"Add focused parser rejection coverage\" # executor hint",
    "    - name: Error copy is actionable",
    "      tier: quality",
    "      type: evaluated",
  ].join("\n");

  const factors = extractAllFactors(rubric);

  assert.deepEqual(factors.map((factor) => ({
    name: factor.name,
    fix_hint: factor.fix_hint,
  })), [
    {
      name: "Parser rejects invalid input",
      fix_hint: "Add focused parser rejection coverage",
    },
    {
      name: "Error copy is actionable",
      fix_hint: null,
    },
  ]);
  assert.deepEqual(extractTddFactors(rubric), [
    {
      name: "Parser rejects invalid input",
      tdd_anchor: "tests/parser.test.js",
      tdd_runner: "node:test",
    },
  ]);
});

test("extractAllFactors normalizes common indentation in literal block scalars", () => {
  const rubric = [
    "rubric:",
    "  factors:",
    "    - name: Multiline criteria",
    "      tier: quality",
    "      type: evaluated",
    "      criteria: |",
    "        Verify:",
    "          - nested detail remains indented",
    "        Done.",
  ].join("\n");

  const [factor] = extractAllFactors(rubric);

  assert.equal(factor.criteria, [
    "Verify:",
    "  - nested detail remains indented",
    "Done.",
  ].join("\n"));
});

test("tdd_runner falls back to first probe test_infra entry", () => {
  const rubric = TDD_RUBRIC.replace("      tdd_runner: \"node:test\"\n", "");

  const factors = resolveTddFactors({
    rubricYaml: rubric,
    probeSignal: PROBE_WITH_TEST_INFRA,
  });

  assert.deepEqual(factors.map((factor) => factor.tdd_runner), ["node:test"]);
});

test("missing tdd_runner with no test infra fails loud before Step 0a", () => {
  const rubric = TDD_RUBRIC.replace("      tdd_runner: \"node:test\"\n", "");

  assert.throws(
    () => resolveTddFactors({
      rubricYaml: rubric,
      probeSignal: JSON.stringify({ test_infra: [], project_tools: { frameworks: [] } }),
    }),
    /omits tdd_runner.*zero test_infra/
  );
});

test("iteration protocol reference renders Step 0a only for TDD rubrics", () => {
  const protocolPath = path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "references", "iteration-protocol.md");
  const protocol = fs.readFileSync(protocolPath, "utf-8");

  const nonTdd = renderIterationProtocolForRubric({
    iterationProtocolText: protocol,
    rubricYaml: NON_TDD_RUBRIC,
    probeSignal: PROBE_WITH_TEST_INFRA,
  });
  const tdd = renderIterationProtocolForRubric({
    iterationProtocolText: protocol,
    rubricYaml: TDD_RUBRIC,
    probeSignal: PROBE_WITH_TEST_INFRA,
  });

  assert.equal(nonTdd, protocol);
  assert.equal(hasTddAnchor(TDD_RUBRIC), true);
  assert.match(tdd, /0a\. TDD RED ANCHOR STEP/);
});

test("reference docs document the exact two-cell TDD state matrix and avoid top-level tdd_mode", () => {
  const iterationProtocol = fs.readFileSync(path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "references", "iteration-protocol.md"), "utf-8");
  const rubricGuide = fs.readFileSync(path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "references", "rubric-design-guide.md"), "utf-8");
  const matrix = [
    "| any factor has `tdd_anchor` | Behavior |",
    "|------|----------|",
    "| Yes  | Step 0a active for every anchor; reviewer TDD section active; prerequisite exclusion active for those paths |",
    "| No   | Compact default completion contract; reviewer prompt unchanged |",
  ].join("\n");

  assert.match(rubricGuide, /tdd_anchor: <path-string>/);
  assert.match(rubricGuide, /tdd_runner: <jest\|pytest\|mocha\|vitest\|\.\.\.>/);
  assert.ok(iterationProtocol.replace(/\r\n/g, "\n").includes(matrix));
  assert.match(iterationProtocol, /Do not add a top-level `tdd_mode` field/);
});
