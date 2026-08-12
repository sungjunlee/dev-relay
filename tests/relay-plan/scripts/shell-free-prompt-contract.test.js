// #1168 item 5: an executor whose dispatch toolset has no command-execution tool (Pi today) was
// override-only under the #1158 toolset gate, because the base prompt template demands verification
// the executor cannot perform. The shell-free contract moves verification to the orchestrator.
// These assertions bind the contract's substance, not only the detector literals it avoids.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { detectCommandExecutionDemand } = require("../../../skills/relay-dispatch/scripts/dispatch");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const BASE_TEMPLATE_PATH = path.join(REPO_ROOT, "skills", "relay", "references", "prompt-template.md");
const SHELL_FREE_TEMPLATE_PATH = path.join(REPO_ROOT, "skills", "relay", "references", "prompt-template-shell-free.md");
const ASSEMBLED_SHELL_FREE_PATH = path.join(__dirname, "..", "fixtures", "dispatch-prompt-baseline", "shell-free.md");
const SKILL_PATH = path.join(REPO_ROOT, "skills", "relay-plan", "SKILL.md");
const ITERATION_PROTOCOL_PATH = path.join(REPO_ROOT, "skills", "relay-plan", "references", "iteration-protocol.md");
// The detector is deliberately literal, so a reworded demand ("execute the project's verification
// suite in full") clears it. This binds the class the detector cannot: an execution verb aimed at a
// suite, check, or build. It is a bound and not a proof — arbitrary paraphrase stays undecidable,
// which is why the frozen Done Criteria and independent review remain the durable guard.
const EXECUTION_DEMAND = /\b(?:execute|executes|run|runs|re-?run|invoke|invokes)\b[^.\n]{0,80}\b(?:suite|suites|test|tests|check|checks|verification|build|lint|type-check|command|commands)\b/i;
const TEMPLATE_SECTIONS = [
  "## Outcome Contract (Done Criteria)",
  "## Evaluation Channels",
  "## Completion Responsibilities",
];

function read(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}

// Both templates carry operator-facing prose outside one fenced body; only the body reaches the
// executor, so the contract assertions below are scoped to it.
function promptBody(text, label) {
  const opener = "```markdown\n";
  const start = text.indexOf(opener);
  assert.notEqual(start, -1, `${label} has no fenced prompt body`);
  const end = text.lastIndexOf("\n```\n");
  assert.ok(end > start, `${label} has an unterminated prompt body`);
  return text.slice(start + opener.length, end);
}

function assertSectionOrder(label, text) {
  let previousIndex = -1;
  for (const section of TEMPLATE_SECTIONS) {
    const index = text.indexOf(section);
    assert.notEqual(index, -1, `${label} is missing ${section}`);
    assert.ok(index > previousIndex, `${label} reorders ${section}`);
    previousIndex = index;
  }
}

// DC2: the gate is the real exported detector, not a restatement of its pattern list.
test("the shell-free contract clears the real dispatch toolset gate that the base template trips", () => {
  const baseDemand = detectCommandExecutionDemand(read(BASE_TEMPLATE_PATH));
  assert.notEqual(baseDemand, null, "base template must still demand command execution");
  assert.equal(baseDemand.pattern, "npm_test");

  assert.equal(detectCommandExecutionDemand(read(SHELL_FREE_TEMPLATE_PATH)), null,
    "shell-free contract must not demand command execution");
  assert.equal(detectCommandExecutionDemand(read(ASSEMBLED_SHELL_FREE_PATH)), null,
    "an assembled shell-free dispatch prompt must not demand command execution");
  assert.equal(detectCommandExecutionDemand(Buffer.from(read(ASSEMBLED_SHELL_FREE_PATH), "utf8")), null,
    "dispatch reads a prompt file as bytes; the byte form must clear the gate too");
});

// DC1 + DC5-b: substance, not literal avoidance. Deleting `npm test` from the base template would
// pass the detector assertion above while leaving these markers unsatisfied.
test("the shell-free contract moves verification to the orchestrator instead of demanding it", () => {
  const text = promptBody(read(SHELL_FREE_TEMPLATE_PATH), "prompt-template-shell-free.md");

  assert.doesNotMatch(text, /PREREQUISITE GATE/i);
  assert.doesNotMatch(text, /Run relevant verification/i);
  assert.doesNotMatch(text, /\bre-?run\b/i);
  assert.doesNotMatch(text, /fix failures/i);
  assert.doesNotMatch(text, /## Test-run Discipline/);

  assert.match(text, /## Returned Verification/);
  assert.match(text, /Verification in this dispatch belongs to the orchestrator, not to you/);
  assert.match(text, /return the target it applies to — file, directory, or test path — plus the observable pass condition/);
  assert.match(text, /never a command line, and never a result/);
  assert.match(text, /Do not claim, imply, or summarize any test, build, lint, type-check, or other check result/);
  assert.match(text, /reviewable edits plus that stated verification, explicitly without any executed-test claim/);
  assert.match(text, /Outcome Contract is the pass\/fail authority/);
  assert.match(text, /Leave Git administration to the orchestrator: do not stage, publish, open a pull request/);
  assert.match(text, /branch history, objects, refs, config, or hooks in the linked worktree/);
});

// The assembled fixture is the evidence for "as it would be assembled into a dispatch prompt", so
// it must carry the template's contract verbatim rather than a friendlier paraphrase of it.
test("the assembled shell-free prompt carries the template contract verbatim", () => {
  const marker = "Outcome Contract is the pass/fail authority";
  const template = promptBody(read(SHELL_FREE_TEMPLATE_PATH), "prompt-template-shell-free.md");
  const assembled = read(ASSEMBLED_SHELL_FREE_PATH);

  assert.ok(template.includes(marker) && assembled.includes(marker));
  assert.equal(
    assembled.slice(assembled.indexOf(marker)).trim(),
    template.slice(template.indexOf(marker)).trim(),
    "assembled prompt drifted from the shell-free contract",
  );
});

// DC4: the base contract is untouched, and both forms carry the same anchors in the same order.
test("both prompt contracts keep the base section anchors in order", () => {
  const base = read(BASE_TEMPLATE_PATH);
  assertSectionOrder("prompt-template.md", base);
  assertSectionOrder("prompt-template-shell-free.md", read(SHELL_FREE_TEMPLATE_PATH));
  assertSectionOrder("assembled shell-free prompt", read(ASSEMBLED_SHELL_FREE_PATH));

  assert.match(base, /0\. PREREQUISITE GATE:/);
  assert.match(base, /Run relevant verification and fix failures found/);
  assert.match(base, /Do not run `git add`, `git commit`, `git push`/);
});

// The absence set in the substance test is lifted from the base template, so it proves "not the base
// template" rather than "demands no execution": a reworded demand passed all of it. This binds the
// class instead of the phrasing, with both contracts a shell-free prompt must never carry as the
// positive controls.
test("no contract reaching a shell-free executor asks it to execute anything", () => {
  assert.doesNotMatch(promptBody(read(SHELL_FREE_TEMPLATE_PATH), "prompt-template-shell-free.md"), EXECUTION_DEMAND,
    "the shell-free contract must not ask an executor with no terminal to execute anything");
  assert.doesNotMatch(read(ASSEMBLED_SHELL_FREE_PATH), EXECUTION_DEMAND,
    "the assembled shell-free prompt must not ask an executor with no terminal to execute anything");

  const base = read(BASE_TEMPLATE_PATH);
  assert.match(base.slice(base.indexOf("## Test-run Discipline")), EXECUTION_DEMAND,
    "base completion contract must still demand execution, or this check proves nothing");
  const compact = read(ITERATION_PROTOCOL_PATH);
  assert.match(compact.slice(compact.indexOf("## Completion Responsibilities")), EXECUTION_DEMAND,
    "the compact executor contract must still demand execution, or its exclusion below proves nothing");
});

// A planner reaches the compact contract from the same step 8 that selects the template, and its
// Completion Responsibilities clear the detector while still demanding a gate, self-verification,
// and an executor-side commit. Appending it to a shell-free prompt rebuilds the silent no-op.
test("the compact executor contract excludes itself from a shell-free dispatch", () => {
  const text = read(ITERATION_PROTOCOL_PATH);

  assert.match(text, /every dispatch prompt to a shell-capable executor must include/);
  assert.match(text, /`capability\.commandExecution: false`/);
  assert.match(text, /prompt-template-shell-free\.md` supplies the whole completion contract/);
  assert.match(text, /nothing here is appended to it/);
});

// DC3 + DC5-c: the selection rule is discoverable from the step that assembles the prompt.
test("relay-plan selects the shell-free contract from the resolved dispatch toolset", () => {
  const skill = read(SKILL_PATH);

  assert.match(skill, /relay-config check --executor <name> --phase dispatch --json/);
  assert.match(skill, /`capability\.commandExecution` is `false`/);
  assert.match(skill, /\.\.\/relay\/references\/prompt-template-shell-free\.md/);
  assert.match(skill, /Otherwise keep the base contract verbatim/);
  assert.ok(skill.split("\n").filter((line, index, lines) => index < lines.length - 1 || line !== "").length <= 150,
    "relay-plan/SKILL.md must stay at or under 150 lines");
});
