"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const INSPECT_PATH = path.join(ROOT, "skills", "relay-dispatch", "scripts", "inspect.js");
const HELPERS_PATH = path.join(ROOT, "skills", "relay-dispatch", "scripts", "inspect-helpers.js");
const OWNED = Object.freeze([
  "completedFailedVerificationRetry",
  "completeRecordedPrObservation",
  "foldRunFacts",
  "hasReviewableWork",
  "hasUnpublishedRetryWork",
  "hostIsLive",
  "isLocalDelivery",
  "none",
  "requiresGithub",
  "result",
  "reviewResolutionLineage",
  "sameReviewSubject",
  "verificationGate",
  "withGithubAvailability",
]);
const PUBLIC_EXPORTS = Object.freeze([
  "actionKey",
  "defaultSnapshot",
  "foldRunFacts",
  "inspectRun",
  "matchingRecordedPr",
  "recoverySteps",
  "stable",
]);

function declarationPattern(name) {
  return new RegExp(`(?:async )?function ${name}\\(`);
}

test("inspect-helpers owns the fold helper function declarations", () => {
  const helpersSrc = fs.readFileSync(HELPERS_PATH, "utf8");
  const inspectSrc = fs.readFileSync(INSPECT_PATH, "utf8");
  for (const name of OWNED) {
    assert.match(helpersSrc, declarationPattern(name), `${name} must be declared in inspect-helpers.js`);
    assert.doesNotMatch(inspectSrc, declarationPattern(name), `${name} must not remain declared in inspect.js`);
  }
  assert.match(inspectSrc, /require\(["']\.\/inspect-helpers["']\)/);
  assert.match(inspectSrc, /(?:async )?function inspectRun\(/);
});

test("inspect re-exports fold helpers with the same function identity", () => {
  const inspect = require(INSPECT_PATH);
  const helpers = require(HELPERS_PATH);
  for (const name of OWNED) {
    assert.equal(typeof helpers[name], "function", `${name} is exported from inspect-helpers`);
  }
  assert.equal(inspect.foldRunFacts, helpers.foldRunFacts, "foldRunFacts re-export identity");
  assert.deepEqual(Object.keys(inspect).sort(), [...PUBLIC_EXPORTS].sort());
  assert.equal(typeof inspect.inspectRun, "function");
  assert.equal(Object.hasOwn(inspect, "inspectRun"), true);
});
