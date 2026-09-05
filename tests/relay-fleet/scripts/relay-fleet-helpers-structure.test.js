"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const FLEET_PATH = path.join(ROOT, "skills", "relay-fleet", "scripts", "relay-fleet.js");
const HELPERS_PATH = path.join(ROOT, "skills", "relay-fleet", "scripts", "relay-fleet-helpers.js");
const OWNED = Object.freeze([
  "actionView",
  "deriveFleet",
  "getFleetLeavesStorePath",
  "loadLeavesFile",
  "normalizeLeaf",
  "readCohort",
  "repositoryIdentity",
  "scanChildren",
  "trustedDirectory",
  "validateLeaves",
  "verifyLeafArtifacts",
  "writeCohortExclusive",
]);
const REEXPORTED = Object.freeze([
  "deriveFleet",
  "getFleetLeavesStorePath",
  "loadLeavesFile",
  "readCohort",
  "scanChildren",
  "writeCohortExclusive",
]);
const PUBLIC_ENTRY = Object.freeze([
  "buildDispatchArgs",
  "buildFinalizeArgs",
  "buildReviewArgs",
  "main",
  "parseArgs",
  "runFleet",
]);
const PUBLIC_EXPORTS = Object.freeze([
  "FleetInputError",
  "buildDispatchArgs",
  "buildFinalizeArgs",
  "buildReviewArgs",
  "deriveFleet",
  "getFleetLeavesStorePath",
  "loadLeavesFile",
  "main",
  "parseArgs",
  "readCohort",
  "runFleet",
  "scanChildren",
  "writeCohortExclusive",
]);

function declarationPattern(name) {
  return new RegExp(`(?:async )?function ${name}\\(`);
}

test("relay-fleet-helpers owns the cohort/derived-view helper declarations", () => {
  const helpersSrc = fs.readFileSync(HELPERS_PATH, "utf8");
  const fleetSrc = fs.readFileSync(FLEET_PATH, "utf8");
  for (const name of OWNED) {
    assert.match(helpersSrc, declarationPattern(name), `${name} must be declared in relay-fleet-helpers.js`);
    assert.doesNotMatch(fleetSrc, declarationPattern(name), `${name} must not remain declared in relay-fleet.js`);
  }
  assert.match(fleetSrc, /require\(["']\.\/relay-fleet-helpers["']\)/);
  for (const name of PUBLIC_ENTRY) {
    assert.match(fleetSrc, declarationPattern(name), `${name} must remain the public fleet entry in relay-fleet.js`);
  }
});

test("relay-fleet re-exports the same relay-fleet-helpers function identity", () => {
  const fleet = require(FLEET_PATH);
  const helpers = require(HELPERS_PATH);
  for (const name of OWNED) {
    assert.equal(typeof helpers[name], "function", `${name} is exported from relay-fleet-helpers`);
  }
  for (const name of REEXPORTED) {
    assert.equal(typeof fleet[name], "function", `${name} is re-exported from relay-fleet`);
    assert.equal(fleet[name], helpers[name], `${name} re-export identity`);
  }
  assert.equal(fleet.FleetInputError, helpers.FleetInputError, "FleetInputError re-export identity");
  assert.deepEqual(Object.keys(fleet).sort(), [...PUBLIC_EXPORTS].sort());
  assert.equal(typeof fleet.runFleet, "function");
  assert.equal(typeof fleet.parseArgs, "function");
  assert.equal(typeof fleet.main, "function");
});
