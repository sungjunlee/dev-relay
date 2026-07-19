// Command-addressable entrypoint for the dispatch-prompt emission contract.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { applyTddFlavorToDispatchPrompt } = require("../../../skills/relay-plan/scripts/tdd-flavor");

const BASELINE_PROMPT_PATH = path.join(__dirname, "..", "fixtures", "dispatch-prompt-baseline", "non-tdd.md");

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
].join("\n");

function baselinePrompt() {
  return fs.readFileSync(BASELINE_PROMPT_PATH, "utf-8");
}

// The planner composes the optional Working Guidance section inline per
// references/task-profile.md + references/guidance-packs.md (#788 removed the
// unwired rendering helper). This mirrors that inline composition so the
// tdd-flavor interaction contract below stays anchored to a realistic prompt.
function withInlineWorkingGuidance(prompt) {
  const guidanceBlock = [
    "## Task Profile",
    "",
    "- size: M | change_type: prompt | execution_mode: standard",
    "- domains: relay-plan, prompt, tests",
    "- risk_tags: prompt-contract",
    "- guidance_packs: surgical-change",
    "",
    "## Working Guidance",
    "",
    "These instructions guide execution style. They do not override Done Criteria, rubric commands, or scope boundaries.",
    "",
    "### surgical-change",
    "",
    "- Keep the diff narrow and trace each changed line to a Done Criteria item.",
    "",
    "",
  ].join("\n");
  assert.match(prompt, /## Evaluation Channels/);
  return prompt.replace("## Evaluation Channels", `${guidanceBlock}## Evaluation Channels`);
}

test("TDD Step 0a remains factor-scoped when Working Guidance is rendered", () => {
  const withGuidance = withInlineWorkingGuidance(baselinePrompt());
  const rendered = applyTddFlavorToDispatchPrompt({
    dispatchPrompt: withGuidance,
    rubricYaml: TDD_RUBRIC,
    probeSignal: JSON.stringify({ test_infra: [{ name: "node:test" }] }),
  });

  assert.match(rendered, /## Working Guidance/);
  assert.match(rendered, /0a\. TDD RED ANCHOR STEP/);
  assert.match(rendered, /tests\/parser\.test\.js/);
  assert.doesNotMatch(rendered, /tdd_mode/);
  assert.doesNotMatch(rendered, /## TDD/i);
  assert.ok(rendered.indexOf("## Working Guidance") < rendered.indexOf("## Evaluation Channels"));
  assert.ok(rendered.indexOf("0a. TDD RED ANCHOR STEP") > rendered.indexOf("## Completion Responsibilities"));
});

require("./tdd-flavor.test");
