"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePlan, BraidPlanError } = require("../../../skills/braid/scripts/lib/plan");

const valid = {
  braid: {
    id: "goal-1",
    root: {
      id: "root",
      children: [
        { id: "a", leaf: { issue: 1 } },
        { id: "b", leaf: { task: "do the thing", run_id: "run-b" }, depends_on: ["a"] },
      ],
    },
  },
};

test("accepts a well-formed plan (wrapped or bare)", () => {
  assert.equal(validatePlan(valid).id, "goal-1");
  assert.equal(validatePlan(valid.braid).id, "goal-1");
});

test("rejects a node that is both leaf and internal", () => {
  const bad = { id: "g", root: { id: "root", leaf: { issue: 1 }, children: [{ id: "c", leaf: { issue: 2 } }] } };
  assert.throws(() => validatePlan(bad), /both a leaf and an internal/);
});

test("rejects a node that is neither leaf nor internal", () => {
  const bad = { id: "g", root: { id: "root" } };
  assert.throws(() => validatePlan(bad), /neither a leaf .* nor internal/);
});

test("rejects duplicate ids", () => {
  const bad = { id: "g", root: { id: "root", children: [{ id: "x", leaf: { issue: 1 } }, { id: "x", leaf: { issue: 2 } }] } };
  assert.throws(() => validatePlan(bad), /duplicate node id "x"/);
});

test("rejects a leaf without issue or task", () => {
  const bad = { id: "g", root: { id: "root", children: [{ id: "a", leaf: {} }] } };
  assert.throws(() => validatePlan(bad), /must carry an integer `issue` or a non-empty `task`/);
});

test("rejects depends_on referencing an unknown id", () => {
  const bad = { id: "g", root: { id: "root", children: [{ id: "a", leaf: { issue: 1 }, depends_on: ["ghost"] }] } };
  assert.throws(() => validatePlan(bad), /depends on unknown id "ghost"/);
});

test("rejects a dependency cycle", () => {
  const bad = {
    id: "g",
    root: {
      id: "root",
      children: [
        { id: "a", leaf: { issue: 1 }, depends_on: ["b"] },
        { id: "b", leaf: { issue: 2 }, depends_on: ["a"] },
      ],
    },
  };
  assert.throws(() => validatePlan(bad), /dependency cycle/);
});

test("accepts a valid diamond/shared dependency (not a cycle)", () => {
  const diamond = {
    id: "g",
    root: {
      id: "root",
      children: [
        { id: "base", leaf: { issue: 1 } },
        { id: "left", leaf: { issue: 2 }, depends_on: ["base"] },
        { id: "right", leaf: { issue: 3 }, depends_on: ["base"] },
        { id: "join", leaf: { issue: 4 }, depends_on: ["left", "right"] },
      ],
    },
  };
  assert.equal(validatePlan(diamond).id, "g"); // shared 'base' dep must not read as a cycle
});

test("rejects self-dependency", () => {
  const bad = { id: "g", root: { id: "root", children: [{ id: "a", leaf: { issue: 1 }, depends_on: ["a"] }] } };
  assert.throws(() => validatePlan(bad), /depends on itself/);
});

test("error type is BraidPlanError", () => {
  try {
    validatePlan({});
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof BraidPlanError);
  }
});
