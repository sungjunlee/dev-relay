const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

test("legacy cleanup records evidence, invariant owners, rollback, and operator flow", () => {
  const decision = read("docs/risk-adaptive-relay-cleanup.md");

  assert.match(decision, /Live observation status: insufficient evidence/i);
  assert.match(decision, /observation gate.*closed/i);
  assert.match(decision, /structural obsolescence proof/i);
  assert.match(
    decision,
    /structural obsolescence proof.*never authorizes\s+deletion of an active mechanism/is
  );
  assert.match(decision, /additional review rounds.*retain/is);
  assert.match(decision, /Earned Rubric.*retain/is);
  assert.match(decision, /adversarial.*retain/is);
  assert.match(decision, /lifecycle.*recovery.*retain/is);
  assert.match(decision, /historical.*manifest.*retain/is);
  assert.match(decision, /executor Score Log.*remove/is);
  assert.match(decision, /score divergence.*remove/is);
  assert.match(decision, /surviving invariant owner/i);
  assert.match(decision, /rollback trigger/i);
  assert.match(decision, /final operator flow/i);
});

test("current runtime has one reviewer-owned score path and no dead divergence tooling", () => {
  const publish = read("skills/relay-dispatch/scripts/dispatch-publish.js");
  const events = read("skills/relay-dispatch/scripts/relay-events.js");
  const report = read("skills/relay-dispatch/scripts/reliability-report.js");
  const runner = read("skills/relay-review/scripts/review-runner.js");
  const reviewComment = read(
    "skills/relay-review/scripts/review-runner/comment.js"
  );
  const tddFlavor = read("skills/relay-plan/scripts/tdd-flavor.js");
  const roundPersistence = read(
    "skills/relay-review/scripts/review-runner/round-persistence.js"
  );

  assert.match(publish, /## Dispatch Metadata/);
  assert.doesNotMatch(publish, /## Score Log/);
  assert.doesNotMatch(events, /SCORE_DIVERGENCE|appendScoreDivergence/);
  assert.doesNotMatch(report, /divergence_hotspots|executor_reviewer_divergence/);
  assert.doesNotMatch(runner, /parseScoreLog|review-runner\/divergence/);
  assert.doesNotMatch(reviewComment, /Score divergence warnings/);
  assert.match(reviewComment, /Advisory review warnings/);
  assert.doesNotMatch(tddFlavor, /self-review finds no stubs/);
  assert.match(roundPersistence, /review-runner\/score-utils|\.[/\\]score-utils/);
  assert.equal(
    fs.existsSync(
      path.join(
        ROOT,
        "skills/relay-review/scripts/review-runner/divergence.js"
      )
    ),
    false
  );
  assert.equal(
    fs.existsSync(
      path.join(ROOT, "skills/relay-merge/scripts/sprint-close-report.js")
    ),
    false
  );
});

test("cleanup preserves migration readers and durable safety boundaries", () => {
  const attempts = read("skills/relay-dispatch/scripts/manifest/attempts.js");
  const events = read("skills/relay-dispatch/scripts/relay-events.js");
  const mergeGate = read("skills/relay-merge/scripts/review-gate.js");

  assert.match(attempts, /score_log/);
  assert.match(attempts, /Legacy Score Log/);
  assert.match(events, /SAFETY_BOUNDARY_VIOLATION/);
  assert.match(events, /function readRunEvents/);
  assert.match(mergeGate, /last_reviewed_sha/);
  assert.match(mergeGate, /latestCommit !== reviewedSha/);
});

test("operator guidance no longer advertises the retired score workflow", () => {
  const relaySkill = read("skills/relay/SKILL.md");
  const mergeSkill = read("skills/relay-merge/SKILL.md");
  const planSkill = read("skills/relay-plan/SKILL.md");
  const taskProfile = read("skills/relay-plan/references/task-profile.md");
  const rubricGuide = read(
    "skills/relay-plan/references/rubric-design-guide.md"
  );
  const rubricStressTest = read(
    "skills/relay-plan/references/rubric-stress-test.md"
  );
  const adoptionGuide = read("docs/agentic-patterns-adoption.md");
  const currentPlanningGuidance = [
    planSkill,
    taskProfile,
    rubricGuide,
    rubricStressTest,
    adoptionGuide,
  ].join("\n");
  const externalTools = read("docs/external-tool-workflow.md");
  const installGraph = read("references/install-graph.md");

  assert.doesNotMatch(relaySkill, /Safety cap: 20 rounds/i);
  assert.match(relaySkill, /assurance/i);
  assert.doesNotMatch(
    currentPlanningGuidance,
    /score divergence|divergence hotspots|divergence_hotspots/i
  );
  assert.doesNotMatch(mergeSkill, /sprint-close-report/);
  assert.doesNotMatch(externalTools, /executor cites in its Score Log/i);
  assert.doesNotMatch(installGraph, /sprint-close-report/);
});

test("producer-less quality-card machinery is removed from the planning surface", () => {
  const rubricValidation = read(
    "skills/relay-plan/references/rubric-validation.md"
  );

  assert.equal(
    fs.existsSync(
      path.join(ROOT, "skills/relay-plan/scripts/quality-card.js")
    ),
    false
  );
  assert.equal(
    fs.existsSync(
      path.join(ROOT, "tests/relay-plan/scripts/quality-card.test.js")
    ),
    false
  );
  assert.doesNotMatch(rubricValidation, /quality-card\.js/i);
});
