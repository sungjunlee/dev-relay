const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const REFERENCES_DIR = path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "references");
const SKILL_PATH = path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "SKILL.md");

function readReference(name) {
  return fs.readFileSync(path.join(REFERENCES_DIR, name), "utf-8");
}

function readSkill() {
  return fs.readFileSync(SKILL_PATH, "utf-8");
}

test("domain rubric references declare candidate-axis usage", () => {
  const domainFiles = [
    "rubric-backend.md",
    "rubric-design.md",
    "rubric-documentation.md",
    "rubric-frontend.md",
    "rubric-refactoring.md",
    "rubric-security.md",
  ];

  for (const file of domainFiles) {
    const text = readReference(file);
    assert.match(text, /## Candidate Axis Library/, file);
    assert.match(text, /not as a template to paste wholesale/i, file);
    assert.match(text, /S-size mechanical/i, file);
  }
});

test("rubric design guide states the reference use contract", () => {
  const text = readReference("rubric-design-guide.md");

  assert.match(text, /## Reference Use Contract/);
  assert.match(text, /candidate axis libraries/);
  assert.match(text, /Do not copy a whole domain reference into a dispatch prompt/);
  assert.match(text, /Acceptance Criteria \(AC\) are high-priority evidence, not the only source/);
  assert.match(text, /inferred Done Criteria/);
  assert.match(text, /fix_hint.*historical plateaus or non-obvious score transitions/);
});

test("rubric validation preserves the S mechanical quality-card example", () => {
  const text = readReference("rubric-validation.md");

  assert.match(text, /S mechanical example/);
  assert.match(text, /Quality factors: 0/);
  assert.match(text, /Quality ratio: N\/A \(mechanical S-size task\)/);
  assert.match(text, /Rationale: Recovered Done Criteria require one observable behavior change/);
});

test("rubric stress-test is gated by ambiguity or risk signal", () => {
  const text = readReference("rubric-stress-test.md");
  const skill = readSkill();

  assert.match(text, /complex, design-bearing tasks/);
  assert.match(text, /ambiguity\/risk signal/);
  assert.match(text, /Do not launch this for direct all-automated rubrics or simple L tasks/);
  assert.match(text, /L tasks with no ambiguity\/risk signal/);
  assert.match(text, /Task Brief \/ Done Criteria/);
  assert.match(text, /narrow scope, low ambiguity\/risk/);
  assert.match(skill, /Run stress-test only for L\/XL rubrics with evaluated factors and an ambiguity\/risk signal/);
  assert.doesNotMatch(skill, /L does one stress-test round/);
});

test("relay-plan frames AC as one input signal, not the whole rubric source", () => {
  const skill = readSkill();

  assert.match(skill, /Synthesize task intent, explicit AC when present, repo signals, and task risk/);
  assert.match(skill, /### 4\. Recover Done Criteria/);
  assert.match(skill, /explicit AC as high-priority evidence, not the only source/);
  assert.match(skill, /not raw issue AC count/);
  assert.doesNotMatch(skill, /Convert task acceptance criteria into a scored rubric/);
  assert.doesNotMatch(skill, /Build a scoring rubric from task Acceptance Criteria/);
});
