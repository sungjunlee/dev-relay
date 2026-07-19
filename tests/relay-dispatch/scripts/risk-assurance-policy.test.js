const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveRiskAssurance,
} = require("../../../skills/relay-dispatch/scripts/manifest/risk-assurance");

function profile(overrides = {}) {
  return {
    authority: "workspace",
    reversibility: "easy",
    blast_radius: "isolated",
    trust_boundaries: [],
    ...overrides,
  };
}

test("risk assurance derives compact, standard, and hardened from task properties", () => {
  const low = deriveRiskAssurance(profile());
  assert.deepEqual({
    risk: low.risk_level,
    assurance: low.review_assurance,
    path: low.behavior_path,
    rounds: low.max_review_rounds,
    publication: low.publish_policy,
  }, {
    risk: "low",
    assurance: "compact",
    path: "lightweight",
    rounds: 1,
    publication: "immediate",
  });

  const medium = deriveRiskAssurance(profile({
    reversibility: "bounded",
    blast_radius: "repository",
  }));
  assert.deepEqual({
    risk: medium.risk_level,
    assurance: medium.review_assurance,
    path: medium.behavior_path,
    rounds: medium.max_review_rounds,
    publication: medium.publish_policy,
  }, {
    risk: "medium",
    assurance: "standard",
    path: "full",
    rounds: 2,
    publication: "immediate",
  });

  const high = deriveRiskAssurance(profile({
    authority: "external-write",
    reversibility: "difficult",
    blast_radius: "multi-system",
    trust_boundaries: ["deployment", "persistent-data"],
  }));
  assert.deepEqual({
    risk: high.risk_level,
    assurance: high.review_assurance,
    path: high.behavior_path,
    rounds: high.max_review_rounds,
    publication: high.publish_policy,
  }, {
    risk: "high",
    assurance: "hardened",
    path: "full",
    rounds: 3,
    publication: "after-internal-review",
  });
});

test("model identity cannot lower or raise task-derived assurance", () => {
  const properties = profile({ blast_radius: "repository" });
  const first = deriveRiskAssurance({ ...properties, model: "frontier-a" });
  const second = deriveRiskAssurance({ ...properties, model: "frontier-b" });

  assert.equal(first.risk_level, "medium");
  assert.equal(second.risk_level, "medium");
  assert.equal(first.review_assurance, second.review_assurance);
  assert.ok(!first.reasons.some((reason) => /model/i.test(reason)));
});

test("an explicit assurance may strengthen but cannot undercut the derived floor", () => {
  const strengthened = deriveRiskAssurance(profile({
    review_assurance: "standard",
  }));
  assert.equal(strengthened.risk_level, "low");
  assert.equal(strengthened.minimum_review_assurance, "compact");
  assert.equal(strengthened.review_assurance, "standard");
  assert.equal(strengthened.max_review_rounds, 2);

  assert.throws(
    () => deriveRiskAssurance(profile({
      blast_radius: "broad",
      review_assurance: "standard",
    })),
    /below.*hardened.*risk floor/i
  );
});

test("partial or unknown risk properties fail closed", () => {
  assert.throws(
    () => deriveRiskAssurance({ authority: "workspace" }),
    /requires authority, reversibility, blast_radius, and trust_boundaries/i
  );
  assert.throws(
    () => deriveRiskAssurance(profile({ reversibility: "sometimes" })),
    /invalid reversibility/i
  );
});
