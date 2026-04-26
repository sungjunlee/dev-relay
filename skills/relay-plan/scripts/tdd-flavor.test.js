const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  TDD_COMMIT_PREFIX,
  applyTddFlavorToDispatchPrompt,
  hasTddAnchor,
  renderIterationProtocolForRubric,
  resolveTddFactors,
} = require("./tdd-flavor");

const BASELINE_PROMPT_PATH = path.join(__dirname, "..", "__fixtures__", "dispatch-prompt-baseline", "non-tdd.md");

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

test("TDD rubric inserts Step 0a, preserves existing Step 0 numbering, and scopes Step 4 relaxation", () => {
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
  assert.match(rendered, /this relaxation applies only to factors carrying `tdd_anchor`; other factors in the same rubric are reviewed under the existing rule/);
  assert.ok(rendered.indexOf("0a. TDD RED ANCHOR STEP") < rendered.indexOf("  0. PREREQUISITE GATE"));
  assert.match(rendered, /  0\. PREREQUISITE GATE/);
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
  const protocolPath = path.join(__dirname, "..", "references", "iteration-protocol.md");
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
  const iterationProtocol = fs.readFileSync(path.join(__dirname, "..", "references", "iteration-protocol.md"), "utf-8");
  const rubricGuide = fs.readFileSync(path.join(__dirname, "..", "references", "rubric-design-guide.md"), "utf-8");
  const reviewSchema = fs.readFileSync(path.join(__dirname, "..", "..", "relay-review", "scripts", "review-schema.js"), "utf-8");
  const matrix = [
    "| any factor has `tdd_anchor` | Behavior |",
    "|------|----------|",
    "| Yes  | Step 0a active for every anchor; reviewer TDD section active; prereq exclusion active for those paths; Step 4(a) relaxed for `tdd_anchor` factors only |",
    "| No   | Pre-#142 baseline; byte-identical prompts; reviewer prompt unchanged |",
  ].join("\n");

  assert.match(rubricGuide, /tdd_anchor: <path-string>/);
  assert.match(rubricGuide, /tdd_runner: <jest\|pytest\|mocha\|vitest\|\.\.\.>/);
  assert.ok(iterationProtocol.includes(matrix));
  assert.match(iterationProtocol, /Do not add a top-level `tdd_mode` field/);
  assert.doesNotMatch(reviewSchema, /tdd_anchor|tdd_runner|tdd_mode/);
});
