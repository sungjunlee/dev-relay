const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const REFERENCES_DIR = path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "references");
const SKILL_PATH = path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "SKILL.md");
const RELAY_SKILL_PATH = path.join(__dirname, "..", "..", "..", "skills", "relay", "SKILL.md");
const RELAY_REFERENCES_DIR = path.join(__dirname, "..", "..", "..", "skills", "relay", "references");
const GUIDANCE_PACK_REFERENCE = "guidance-packs.md";
const REQUIRED_GUIDANCE_PACKS = [
  "surgical-change",
  "verification-evidence",
  "user-replay-evidence",
  "simplify-pass",
  "docs-reader-success",
  "trust-boundary",
];

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

function extractGuidancePackSections(text) {
  const sections = new Map();
  const packHeadingPattern = /^### `([^`]+)`\n([\s\S]*?)(?=^### `|(?![\s\S]))/gm;
  for (const match of text.matchAll(packHeadingPattern)) {
    sections.set(match[1], match[2].trim());
  }
  return sections;
}

test("domain rubric references declare candidate-axis usage", () => {
  const text = readReference("rubric-domain-axes.md");
  const domainSections = [
    "Rubric — Backend",
    "Rubric — Design & UX",
    "Rubric — Documentation",
    "Rubric — Frontend",
    "Rubric — Refactoring",
    "Rubric — Security",
  ];

  for (const section of domainSections) {
    assert.match(text, new RegExp(`^## ${section}$`, "m"), section);
  }
  assert.equal((text.match(/^## /gm) || []).length, 6);
  assert.equal((text.match(/^### Candidate Axis Library$/gm) || []).length, 6);
  assert.equal((text.match(/not as a template to paste wholesale/gi) || []).length, 6);
  assert.equal((text.match(/S-size mechanical/g) || []).length, 6);
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

test("rubric validation documents the ready-light compact rubric boundary", () => {
  const text = readReference("rubric-validation.md");

  assert.match(text, /Ready-light S mechanical compact example/);
  assert.match(text, /Planning profile: ready_light/);
  assert.match(text, /Contract factors: 1/);
  assert.match(text, /Quality factors: 0/);
  assert.match(text, /Ready-light S mechanical rubrics default to 1-2 substantive factors/);
  assert.match(text, /Repo-wide lint, typecheck, and test commands stay in prerequisites/);
  assert.match(text, /Unsupported helper, dependency, config, or abstraction requirements are over-engineering risk/);
  assert.match(text, /Action: dispatch allowed/);
});

test("rubric validation documents the ready-light design-bearing exception", () => {
  const text = readReference("rubric-validation.md");

  assert.match(text, /Ready-light S design-bearing example/);
  assert.match(text, /Planning profile: ready_light/);
  assert.match(text, /Contract factors: 1/);
  assert.match(text, /Quality factors: 1/);
  assert.match(text, /Substantive total: 2/);
  assert.match(text, /Design-bearing rationale:/);
  assert.match(text, /Action: dispatch allowed/);
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

test("planner input signals document harness context as weak planning context", () => {
  const skill = readSkill();
  const signals = readReference("signals.md");

  assert.match(skill, /task-relevant local harness context as weak inputs only/);
  assert.match(skill, /authority hierarchy/);
  assert.match(signals, /## Signal authority hierarchy/);
  assert.match(signals, /Project harness context, probe signal, historical signal, and optional subsystem scout notes/);
  assert.match(signals, /weak planning context/);
  assert.match(signals, /AGENTS\.md/);
  assert.match(signals, /CLAUDE\.md/);
  assert.match(signals, /CHARTER\.md/);
  assert.match(signals, /spec\/capabilities\.md/);
  assert.match(signals, /GitHub issues or relay-ready artifacts remain the source of truth/);
  assert.match(signals, /cannot add product requirements, narrow explicit AC, or replace Done Criteria/);
});

test("optional subsystem scout is a relay-plan add-on, not a lifecycle step", () => {
  const skill = readSkill();
  const scout = readReference("subsystem-scout.md");

  assert.match(skill, /references\/subsystem-scout\.md/);
  assert.match(skill, /skip for S\/M tasks with clear scope/);
  assert.match(scout, /belongs in `relay-plan` as a risk-triggered add-on/);
  assert.match(scout, /must not create a new lifecycle state/);
  assert.match(scout, /## Trigger criteria/);
  assert.match(scout, /## Consumption boundary/);
  assert.match(scout, /weak planning signal/);
  assert.match(scout, /Do not write scout artifacts into `~\/\.relay\/runs\/` before dispatch allocates a run/);
  assert.match(scout, /test both the skip path and artifact path/);
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

test("default executor contract delegates iteration while preserving verification evidence", () => {
  const text = readReference("iteration-protocol.md");

  assert.match(text, /## Completion Responsibilities/);
  assert.match(text, /Capture concise verification evidence/);
  assert.match(text, /final work is committed/);
  assert.match(text, /choose the implementation, exploration, test, and repair sequence/i);
  assert.doesNotMatch(text, /Score Log/);
  assert.doesNotMatch(text, /self-(?:evaluate|review)/i);
  assert.doesNotMatch(text, /weakest (?:required )?factor/i);
  assert.doesNotMatch(text, /max \d+ iterations/i);
});

test("relay dispatch template and wrapper use Done Criteria outcome language", () => {
  const template = readRelayReference("prompt-template.md");
  const relaySkill = readRelaySkill();

  assert.match(template, /specific Done Criteria outcome is implemented/);
  assert.match(template, /\[specific Done Criteria outcome\]/);
  assert.match(template, /## Completion Responsibilities/);
  assert.match(template, /Capture concise verification evidence/);
  assert.match(template, /proxy signal/i);
  assert.doesNotMatch(template, /## After Implementation/);
  assert.doesNotMatch(template, /## Completion Audit/);
  assert.doesNotMatch(template, /Score Log/);
  assert.doesNotMatch(template, /self-(?:evaluate|review)/i);
  assert.doesNotMatch(template, /weakest (?:required )?factor/i);
  assert.doesNotMatch(template, /specific AC (item|implemented)/i);

  assert.match(relaySkill, /Task evidence/);
  assert.match(relaySkill, /recover Done Criteria/);
  assert.match(relaySkill, /Done Criteria fully implemented/);
  assert.doesNotMatch(relaySkill, /Steps 1-10 only/);
  assert.doesNotMatch(relaySkill, /Issue AC fully implemented/);
});

test("guidance pack reference declares the expected pack library", () => {
  const text = readReference(GUIDANCE_PACK_REFERENCE);
  const skill = readSkill();
  const taskProfile = readReference("task-profile.md");
  const sections = extractGuidancePackSections(text);

  assert.deepEqual([...sections.keys()], REQUIRED_GUIDANCE_PACKS);
  assert.match(skill, /references\/guidance-packs\.md/);
  assert.match(taskProfile, /references\/guidance-packs\.md/);
});

test("each guidance pack states use, non-use, and rubric boundary", () => {
  const text = readReference(GUIDANCE_PACK_REFERENCE);
  const sections = extractGuidancePackSections(text);

  for (const pack of REQUIRED_GUIDANCE_PACKS) {
    const section = sections.get(pack);
    assert.ok(section, pack);
    assert.match(section, /^#### Use when$/m, pack);
    assert.match(section, /^#### Do not use when$/m, pack);
    assert.match(section, /^#### Guidance$/m, pack);
    assert.match(section, /^#### Rubric still carries$/m, pack);
    assert.match(section, /advisory|does not override|must remain/i, pack);
    assert.match(section, /Done Criteria|rubric factor|rubric factors/i, pack);
  }
});

test("guidance packs stay compact and executor-agnostic", () => {
  const text = readReference(GUIDANCE_PACK_REFERENCE);
  const sections = extractGuidancePackSections(text);
  const forbiddenProviderTerms = [
    /\bCodex\b/,
    /\bClaude\b/,
    /\bGPT\b/,
    /\bOpenAI\b/,
    /\bAnthropic\b/,
    /\bCLAUDE_SKILL_DIR\b/,
    /\bgh\s+/,
    /\bnpm\s+/,
    /\bnode --test\b/,
    /\bapply_patch\b/,
  ];

  for (const pack of REQUIRED_GUIDANCE_PACKS) {
    const section = sections.get(pack);
    const words = section.split(/\s+/).filter(Boolean);
    assert.ok(words.length <= 170, `${pack} has ${words.length} words`);
    assert.ok(section.split("\n").length <= 24, `${pack} is too long`);
    for (const pattern of forbiddenProviderTerms) {
      assert.doesNotMatch(section, pattern, pack);
    }
  }
});
