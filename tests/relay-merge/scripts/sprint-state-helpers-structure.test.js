"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const STATE_PATH = path.join(ROOT, "skills", "relay-merge", "scripts", "sprint-state.js");
const HELPERS_PATH = path.join(ROOT, "skills", "relay-merge", "scripts", "sprint-state-helpers.js");
const OWNED = Object.freeze([
  "discoverSprintStateBin",
  "listSprintStateCandidates",
  "normalizeRepoSprintPath",
  "parseComponents",
  "probeSprintStateBinary",
  "validateSprintStatePayload",
]);
const REEXPORTED = Object.freeze([
  "discoverSprintStateBin",
  "listSprintStateCandidates",
  "normalizeRepoSprintPath",
  "parseComponents",
  "probeSprintStateBinary",
  "validateSprintStatePayload",
]);
const PUBLIC_ENTRY = Object.freeze([
  "invokeSprintState",
]);
const PUBLIC_EXPORTS = Object.freeze([
  "MIN_SCHEMA_VERSION",
  "discoverSprintStateBin",
  "invokeSprintState",
  "listSprintStateCandidates",
  "normalizeRepoSprintPath",
  "parseComponents",
  "probeSprintStateBinary",
  "validateSprintStatePayload",
]);

function declarationPattern(name) {
  return new RegExp(`(?:async )?function ${name}\\(`);
}

test("sprint-state-helpers owns the discovery and validation helper declarations", () => {
  const helpersSrc = fs.readFileSync(HELPERS_PATH, "utf8");
  const stateSrc = fs.readFileSync(STATE_PATH, "utf8");
  for (const name of OWNED) {
    assert.match(helpersSrc, declarationPattern(name), `${name} must be declared in sprint-state-helpers.js`);
    assert.doesNotMatch(stateSrc, declarationPattern(name), `${name} must not remain declared in sprint-state.js`);
  }
  assert.match(stateSrc, /require\(["']\.\/sprint-state-helpers["']\)/);
  for (const name of PUBLIC_ENTRY) {
    assert.match(stateSrc, declarationPattern(name), `${name} must remain the public sprint-state entry in sprint-state.js`);
  }
});

test("sprint-state re-exports the same sprint-state-helpers function identity", () => {
  const state = require(STATE_PATH);
  const helpers = require(HELPERS_PATH);
  for (const name of OWNED) {
    assert.equal(typeof helpers[name], "function", `${name} is exported from sprint-state-helpers`);
  }
  for (const name of REEXPORTED) {
    assert.equal(typeof state[name], "function", `${name} is re-exported from sprint-state`);
    assert.equal(state[name], helpers[name], `${name} re-export identity`);
  }
  assert.equal(state.MIN_SCHEMA_VERSION, helpers.MIN_SCHEMA_VERSION, "MIN_SCHEMA_VERSION re-export identity");
  assert.deepEqual(Object.keys(state).sort(), [...PUBLIC_EXPORTS].sort());
  assert.equal(typeof state.invokeSprintState, "function");
  assert.equal(Object.hasOwn(state, "invokeSprintState"), true);
});
