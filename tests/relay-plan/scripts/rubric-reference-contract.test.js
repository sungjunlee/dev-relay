const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const REFERENCES_DIR = path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "references");
const SKILL_PATH = path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "SKILL.md");
const RELAY_SKILL_PATH = path.join(__dirname, "..", "..", "..", "skills", "relay", "SKILL.md");
const RELAY_REFERENCES_DIR = path.join(__dirname, "..", "..", "..", "skills", "relay", "references");

function readReference(name) {
  return fs.readFileSync(path.join(REFERENCES_DIR, name), "utf-8");
}

function readSkill() {
  return fs.readFileSync(SKILL_PATH, "utf-8");
}

function readRelaySkill() {
  return fs.readFileSync(RELAY_SKILL_PATH, "utf-8");
}

function readRelayReference(name) {
  return fs.readFileSync(path.join(RELAY_REFERENCES_DIR, name), "utf-8");
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
  assert.match(text, /Reviewer verdicts record numeric quality scores separately from pass\/fail state/);
  assert.match(text, /score: 7\.5, target_score: 8/);
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

  assert.match(text, /complex, ambiguous, or risk-bearing tasks/);
  assert.match(text, /ambiguity\/risk signal/);
  assert.match(text, /## Stress-Test \(when triggered\)/);
  assert.match(text, /Do not launch this for direct all-automated rubrics or simple tasks/);
  assert.match(text, /S\/M tasks with no ambiguity\/risk signal/);
  assert.match(text, /Task Brief \/ Done Criteria/);
  assert.match(text, /stress-test when ambiguity\/risk signal exists/);
  assert.match(text, /uncovered Done Criteria/);
  assert.match(text, /Step 6 \(Validate\) → Step 9 \(Rubric Review\) → Step 10 \(Generate dispatch prompt\)/);
  assert.match(text, /low ambiguity\/risk/);
  assert.match(skill, /ambiguity or risk can opt any size into stress-test/);
  assert.doesNotMatch(text, /uncovered AC/);
  assert.doesNotMatch(text, /L and XL when triggered/);
  assert.doesNotMatch(text, /simple L tasks/);
  assert.doesNotMatch(skill, /triggered L\/XL tasks/);
  assert.doesNotMatch(skill, /L does one stress-test round/);
});

test("relay-plan frames AC as one input signal, not the whole rubric source", () => {
  const skill = readSkill();

  assert.match(skill, /Synthesize task intent, explicit AC when present, repo signals, and task risk/);
  assert.match(skill, /### 4\. Recover Done Criteria/);
  assert.match(skill, /explicit AC as high-priority evidence, not the only source/);
  assert.match(skill, /If the final review anchor is planner-authored or differs from the task source, persist it/);
  assert.match(skill, /AC-missing inputs, user-provided descriptions/);
  assert.match(skill, /not raw issue AC count/);
  assert.doesNotMatch(skill, /Convert task acceptance criteria into a scored rubric/);
  assert.doesNotMatch(skill, /Build a scoring rubric from task Acceptance Criteria/);
});

test("rubric validation gates Done Criteria quality before dispatch", () => {
  const text = readReference("rubric-validation.md");

  assert.match(text, /## Validate Done Criteria \(full checklist\)/);
  assert.match(text, /Observable outcomes/);
  assert.match(text, /Scope boundary/);
  assert.match(text, /Reviewability/);
  assert.match(text, /Risk coverage/);
  assert.match(text, /Verification path/);
  assert.match(text, /weak_done_criteria/);
});

test("iteration protocol treats quality scores as optimization signals", () => {
  const text = readReference("iteration-protocol.md");

  assert.match(text, /Use 0-10 numbers for quality factors with numeric targets/);
  assert.match(text, /optimize the lowest reviewer score/);
  assert.match(text, /first-class event data/);
  assert.match(text, /quality factors can converge from `6\/10 → 7\.5\/10 → 8\/10`/);
  assert.match(text, /without adding new manifest states/);
});

test("relay dispatch template and wrapper use Done Criteria outcome language", () => {
  const template = readRelayReference("prompt-template.md");
  const relaySkill = readRelaySkill();

  assert.match(template, /specific Done Criteria outcome is implemented/);
  assert.match(template, /\[specific Done Criteria outcome\]/);
  assert.match(template, /## Completion Audit/);
  assert.match(template, /proxy signal/i);
  assert.doesNotMatch(template, /specific AC (item|implemented)/i);

  assert.match(relaySkill, /Task evidence/);
  assert.match(relaySkill, /recover Done Criteria/);
  assert.match(relaySkill, /Done Criteria fully implemented/);
  assert.doesNotMatch(relaySkill, /Steps 1-10 only/);
  assert.doesNotMatch(relaySkill, /Issue AC fully implemented/);
});
