// Command-addressable entrypoint for the dispatch-prompt emission contract.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const BASELINE_PROMPT_PATH = path.join(__dirname, "..", "fixtures", "dispatch-prompt-baseline", "non-tdd.md");
const PROMPT_TEMPLATE_PATH = path.join(
  __dirname, "..", "..", "..", "skills", "relay", "references", "prompt-template.md",
);
const PLAN_SKILL_PATH = path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "SKILL.md");
const TEMPLATE_SECTIONS = [
  "## Outcome Contract (Done Criteria)",
  "## Evaluation Channels",
  "## Completion Responsibilities",
];

function baselinePrompt() {
  return fs.readFileSync(BASELINE_PROMPT_PATH, "utf-8");
}

// The planner composes the optional Working Guidance section inline per
// references/task-profile.md + references/guidance-packs.md (#788 removed the
// unwired rendering helper). This mirrors that inline composition.
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

test("emitted dispatch prompt keeps the template section order", () => {
  const template = fs.readFileSync(PROMPT_TEMPLATE_PATH, "utf-8");
  const prompt = baselinePrompt();

  let previousPromptIndex = -1;
  let previousTemplateIndex = -1;
  for (const section of TEMPLATE_SECTIONS) {
    const promptIndex = prompt.indexOf(section);
    const templateIndex = template.indexOf(section);
    assert.notEqual(promptIndex, -1, `emitted prompt is missing ${section}`);
    assert.notEqual(templateIndex, -1, `prompt template is missing ${section}`);
    assert.ok(promptIndex > previousPromptIndex, `emitted prompt reorders ${section}`);
    assert.ok(templateIndex > previousTemplateIndex, `prompt template reorders ${section}`);
    previousPromptIndex = promptIndex;
    previousTemplateIndex = templateIndex;
  }
});

test("inline Working Guidance lands between the Outcome Contract and Evaluation Channels", () => {
  const rendered = withInlineWorkingGuidance(baselinePrompt());

  assert.match(rendered, /## Working Guidance/);
  assert.ok(rendered.indexOf("## Outcome Contract (Done Criteria)") < rendered.indexOf("## Working Guidance"));
  assert.ok(rendered.indexOf("## Working Guidance") < rendered.indexOf("## Evaluation Channels"));
  assert.ok(rendered.indexOf("## Evaluation Channels") < rendered.indexOf("## Completion Responsibilities"));
  assert.doesNotMatch(rendered, /tdd_mode/);
});

test("every emitted prompt uses one honest verification contract", () => {
  const template = fs.readFileSync(PROMPT_TEMPLATE_PATH, "utf-8");
  const prompt = baselinePrompt();
  for (const [name, text] of [["template", template], ["baseline", prompt]]) {
    assert.doesNotMatch(text, /prompt-template-shell-free|commandExecution|toolset.?mismatch/i, name);
    assert.match(text, /Report only checks actually executed as evidence/i, name);
    assert.match(text, /unavailable or proposed/i, name);
  }
  assert.doesNotMatch(
    fs.readFileSync(PLAN_SKILL_PATH, "utf-8"),
    /prompt-template-shell-free|commandExecution|toolset.?mismatch/i,
  );
  assert.equal(fs.existsSync(path.join(path.dirname(PROMPT_TEMPLATE_PATH), "prompt-template-shell-free.md")), false);
});
