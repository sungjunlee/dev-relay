const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("risk assurance guidance defines proportional paths and invariant boundaries", () => {
  const reference = read("skills/relay-plan/references/risk-assurance.md");
  const planSkill = read("skills/relay-plan/SKILL.md");
  const dispatchSkill = read("skills/relay-dispatch/SKILL.md");

  for (const property of [
    "authority",
    "reversibility",
    "blast radius",
    "trust boundaries",
  ]) {
    assert.match(reference, new RegExp(property, "i"));
  }
  assert.match(reference, /compact.*one post-publication independent review/is);
  assert.match(reference, /standard.*one bounded repair cycle/is);
  assert.match(reference, /hardened.*pre-publication.*adversarial/is);
  assert.match(reference, /model identity.*not.*risk/i);
  assert.match(reference, /permission.*sandbox.*network.*repository.*SHA.*audit.*publication.*merge/is);
  assert.match(planSkill, /references\/risk-assurance\.md/);
  assert.match(dispatchSkill, /compact \| standard \| hardened/);
});
