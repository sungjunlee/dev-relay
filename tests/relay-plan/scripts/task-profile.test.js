const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  applyTaskProfileToDispatchPrompt,
  deriveTaskProfile,
} = require("../../../skills/relay-plan/scripts/task-profile");

const BASELINE_PROMPT_PATH = path.join(__dirname, "..", "fixtures", "dispatch-prompt-baseline", "non-tdd.md");
const SKILL_PATH = path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "SKILL.md");
const PROFILE_REFERENCE_PATH = path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "references", "task-profile.md");
const REVIEW_SCHEMA_PATH = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "review-schema.js");

const PROBE_SIGNAL = JSON.stringify({
  test_infra: [{ name: "node:test" }],
  project_tools: {
    ci: [{ path: ".github/workflows/test.yml" }],
    scripts: [{ name: "test", command: "node --test tests/relay-plan/scripts/*.test.js" }],
  },
});

const HISTORICAL_SIGNAL = JSON.stringify({
  metrics: { median_rounds_to_ready: 2 },
  rubric_insights: {
    tier_effectiveness: {
      contract: { avg_rounds_to_met: 1.4 },
      quality: { avg_rounds_to_met: 2.8 },
    },
  },
});

test("code task profile selects source-code guidance and records derivation inputs", () => {
  const profile = deriveTaskProfile({
    doneCriteria: [
      "Add a relay-plan script API for generated dispatch artifacts.",
      "Cover the behavior with tests under tests/relay-plan/scripts/.",
    ].join("\n"),
    probeSignal: PROBE_SIGNAL,
    historicalSignal: HISTORICAL_SIGNAL,
    taskRisk: { risk_tags: ["public-api", "backward-compatibility"] },
    size: "M",
  });

  assert.equal(profile.change_type, "feature");
  assert.equal(profile.execution_mode, "standard");
  assert.ok(profile.domains.includes("relay-plan"));
  assert.ok(profile.domains.includes("tests"));
  assert.ok(profile.domains.includes("ci"));
  assert.ok(profile.risk_tags.includes("public-api"));
  assert.ok(profile.risk_tags.includes("backward-compatibility"));
  assert.ok(profile.guidance_packs.includes("surgical-change"));
  assert.ok(profile.guidance_packs.includes("verification-evidence"));
  assert.ok(profile.guidance_packs.includes("simplify-pass"));
  assert.deepEqual(profile.derivation_inputs, [
    "done_criteria",
    "probe_signal",
    "historical_signal",
    "task_risk",
  ]);
});

test("docs task profile selects docs reader-success guidance", () => {
  const profile = deriveTaskProfile({
    doneCriteria: "Update docs/operator-guide.md and README examples so a reader can run the command.",
    probeSignal: PROBE_SIGNAL,
    historicalSignal: HISTORICAL_SIGNAL,
    taskRisk: {},
    size: "S",
  });

  assert.equal(profile.change_type, "docs");
  assert.ok(profile.domains.includes("docs"));
  assert.ok(profile.guidance_packs.includes("docs-reader-success"));
});

test("generic validate wording does not imply trust-boundary guidance", () => {
  const profile = deriveTaskProfile({
    doneCriteria: "Validate docs/operator-guide.md examples so a reader can run the command.",
    probeSignal: PROBE_SIGNAL,
    historicalSignal: HISTORICAL_SIGNAL,
    taskRisk: {},
    size: "S",
  });

  assert.equal(profile.change_type, "docs");
  assert.equal(profile.execution_mode, "quick");
  assert.ok(!profile.risk_tags.includes("trust-boundary"));
  assert.ok(!profile.guidance_packs.includes("trust-boundary"));
});

test("refactor task profile selects simplify guidance", () => {
  const profile = deriveTaskProfile({
    doneCriteria: "Refactor skills/relay-plan/scripts/probe-executor-env.js without behavior changes.",
    probeSignal: PROBE_SIGNAL,
    historicalSignal: HISTORICAL_SIGNAL,
    taskRisk: {},
    size: "M",
  });

  assert.equal(profile.change_type, "refactor");
  assert.ok(profile.guidance_packs.includes("simplify-pass"));
});

test("trust-boundary task profile selects trust-boundary guidance", () => {
  const profile = deriveTaskProfile({
    doneCriteria: [
      "Harden validateManifest before gate-check reads a run manifest.",
      "Forged state-transition metadata must fail closed.",
    ].join("\n"),
    probeSignal: PROBE_SIGNAL,
    historicalSignal: HISTORICAL_SIGNAL,
    taskRisk: { risk_tags: ["state-machine"] },
    size: "L",
  });

  assert.ok(profile.risk_tags.includes("trust-boundary"));
  assert.ok(profile.risk_tags.includes("state-machine"));
  assert.equal(profile.execution_mode, "fresh-context");
  assert.ok(profile.guidance_packs.includes("trust-boundary"));
});

test("validate manifest wording selects trust-boundary guidance", () => {
  const profile = deriveTaskProfile({
    doneCriteria: "Validate manifest state before applying review gate decisions.",
    probeSignal: PROBE_SIGNAL,
    historicalSignal: HISTORICAL_SIGNAL,
    taskRisk: {},
    size: "M",
  });

  assert.ok(profile.risk_tags.includes("trust-boundary"));
  assert.ok(profile.risk_tags.includes("state-machine"));
  assert.equal(profile.execution_mode, "fresh-context");
});

test("selected task_profile renders metadata and working guidance in dispatch prompts", () => {
  const baseline = fs.readFileSync(BASELINE_PROMPT_PATH, "utf-8");
  const profile = deriveTaskProfile({
    doneCriteria: "Add code in skills/relay-plan/scripts/task-profile.js with tests.",
    probeSignal: PROBE_SIGNAL,
    historicalSignal: HISTORICAL_SIGNAL,
    taskRisk: {},
    size: "M",
  });

  const rendered = applyTaskProfileToDispatchPrompt({ dispatchPrompt: baseline, taskProfile: profile });

  assert.match(rendered, /## Task Profile/);
  assert.match(rendered, /task_profile:/);
  assert.match(rendered, /change_type: feature/);
  assert.match(rendered, /guidance_packs:/);
  assert.match(rendered, /surgical-change/);
  assert.match(rendered, /derivation_inputs:/);
  assert.match(rendered, /advisory planner metadata/);
  assert.match(rendered, /## Working Guidance/);
  assert.match(rendered, /These instructions guide execution style\. They do not override Done Criteria, rubric commands, or scope boundaries\./);
  assert.match(rendered, /### surgical-change/);
  assert.doesNotMatch(fs.readFileSync(REVIEW_SCHEMA_PATH, "utf-8"), /task_profile|guidance_packs|execution_mode/);
});

test("empty guidance_packs leaves existing non-guidance prompt byte-identical", () => {
  const baseline = fs.readFileSync(BASELINE_PROMPT_PATH, "utf-8");
  const rendered = applyTaskProfileToDispatchPrompt({
    dispatchPrompt: baseline,
    taskProfile: {
      change_type: "feature",
      domains: ["relay-plan"],
      risk_tags: [],
      execution_mode: "standard",
      guidance_packs: [],
    },
  });

  assert.equal(rendered, baseline);
});

test("relay-plan documents task_profile shape, derivation, and planner-only boundary", () => {
  const skill = fs.readFileSync(SKILL_PATH, "utf-8");
  const reference = fs.readFileSync(PROFILE_REFERENCE_PATH, "utf-8");

  assert.match(skill, /task_profile/);
  assert.match(skill, /references\/task-profile\.md/);
  assert.match(reference, /change_type/);
  assert.match(reference, /domains/);
  assert.match(reference, /risk_tags/);
  assert.match(reference, /execution_mode/);
  assert.match(reference, /guidance_packs/);
  assert.match(reference, /Done Criteria/);
  assert.match(reference, /probe signal/);
  assert.match(reference, /historical signal/);
  assert.match(reference, /task risk/);
  assert.match(reference, /planner metadata/);
  assert.match(reference, /not a reviewer verdict field/);
});
