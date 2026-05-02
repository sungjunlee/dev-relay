// Command-addressable entrypoint for the dispatch-prompt emission contract.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { applyTaskProfileToDispatchPrompt } = require("../../../skills/relay-plan/scripts/task-profile");
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

test("no guidance packs leave the dispatch prompt byte-identical", () => {
  const baseline = baselinePrompt();
  const rendered = applyTaskProfileToDispatchPrompt({
    dispatchPrompt: baseline,
    taskProfile: {
      size: "M",
      change_type: "prompt",
      domains: ["relay-plan"],
      risk_tags: [],
      execution_mode: "standard",
      guidance_packs: [],
    },
  });

  assert.equal(rendered, baseline);
  assert.doesNotMatch(rendered, /## Task Profile/);
  assert.doesNotMatch(rendered, /## Working Guidance/);
});

test("single selected guidance pack renders compact Working Guidance", () => {
  const rendered = applyTaskProfileToDispatchPrompt({
    dispatchPrompt: baselinePrompt(),
    taskProfile: {
      size: "S",
      change_type: "docs",
      domains: ["docs"],
      risk_tags: [],
      execution_mode: "quick",
      guidance_packs: ["docs-reader-success"],
    },
  });

  assert.match(rendered, /## Task Profile/);
  assert.match(rendered, /## Working Guidance/);
  assert.match(rendered, /These instructions guide execution style\. They do not override Done Criteria, rubric commands, or scope boundaries\./);
  assert.match(rendered, /### docs-reader-success/);
  assert.match(rendered, /- Verify referenced files, flags, commands, and issue numbers when practical\./);
  assert.doesNotMatch(rendered, /### surgical-change/);
  assert.ok(rendered.indexOf("## Task Profile") < rendered.indexOf("## Working Guidance"));
  assert.ok(rendered.indexOf("## Working Guidance") < rendered.indexOf("## Scoring Rubric"));
});

test("multiple selected guidance packs render in task profile order", () => {
  const rendered = applyTaskProfileToDispatchPrompt({
    dispatchPrompt: baselinePrompt(),
    taskProfile: {
      size: "M",
      change_type: "prompt",
      domains: ["relay-plan", "prompt", "tests"],
      risk_tags: ["backward-compatibility", "prompt-contract"],
      execution_mode: "standard",
      guidance_packs: ["surgical-change", "verification-evidence", "simplify-pass"],
    },
  });

  assert.match(rendered, /### surgical-change/);
  assert.match(rendered, /### verification-evidence/);
  assert.match(rendered, /### simplify-pass/);
  assert.match(rendered, /- Keep the diff narrow and trace each changed line/);
  assert.match(rendered, /- Record changed artifacts, exact checks run, pass\/fail results, and known blockers before completion\./);
  assert.match(rendered, /- After green checks, review only files changed by this task\./);
  assert.ok(rendered.indexOf("### surgical-change") < rendered.indexOf("### verification-evidence"));
  assert.ok(rendered.indexOf("### verification-evidence") < rendered.indexOf("### simplify-pass"));
});

test("TDD Step 0a remains factor-scoped when Working Guidance is rendered", () => {
  const withGuidance = applyTaskProfileToDispatchPrompt({
    dispatchPrompt: baselinePrompt(),
    taskProfile: {
      size: "M",
      change_type: "prompt",
      domains: ["relay-plan", "prompt", "tests"],
      risk_tags: ["prompt-contract"],
      execution_mode: "standard",
      guidance_packs: ["surgical-change"],
    },
  });
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
  assert.ok(rendered.indexOf("## Working Guidance") < rendered.indexOf("## Scoring Rubric"));
  assert.ok(rendered.indexOf("0a. TDD RED ANCHOR STEP") > rendered.indexOf("## Iteration Protocol"));
});

require("./tdd-flavor.test");
