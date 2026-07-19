const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("review guidance defines reviewer-only scoring and the short default repair cycle", () => {
  const skill = read("skills/relay-review/SKILL.md");
  const criteria = read("skills/relay-review/references/evaluate-criteria.md");
  const runnerNotes = read("skills/relay-review/references/runner-notes.md");
  const architecture = read("references/architecture.md");
  const lifecycleDesign = read("docs/relay-lifecycle-manifest-design.md");

  assert.match(skill, /reviewer is the only scoring authority/i);
  assert.match(skill, /executor-authored scores.*not.*review evidence/is);
  assert.match(skill, /one independent review.*one targeted re-dispatch.*one review of the corrected result/is);
  assert.match(skill, /Outcome Contract.*Verification.*pass\/fail/is);
  assert.match(skill, /only persisted Earned Rubric factors/i);
  assert.doesNotMatch(skill, /Safety cap: 20 rounds/i);
  assert.doesNotMatch(skill, /executor\/reviewer divergence/i);
  assert.match(criteria, /standard\s+allows two review rounds/i);
  assert.match(criteria, /explicit extended policy/i);
  assert.match(runnerNotes, /compact defaults to `1`.*standard to `2`.*hardened to `3`/i);
  assert.match(architecture, /max_rounds: 2.*compact=1.*hardened=3/i);
  assert.match(lifecycleDesign, /max_rounds: 2.*compact=1.*hardened=3/i);
});
