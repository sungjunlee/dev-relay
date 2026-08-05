// #1168 item 5: executors whose dispatch toolset has no command-execution tool (pi, claude) were
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
