"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const PREFLIGHT_PATH = path.join(ROOT, "skills", "relay", "scripts", "run-preflight.js");
const HELPERS_PATH = path.join(ROOT, "skills", "relay", "scripts", "run-preflight-helpers.js");
const OWNED = Object.freeze([
  "checkInflightRuns",
  "checkPullRequest",
  "execGhJson",
  "requireSupportedSource",
  "routeFromInflight",
  "scanInflightRuns",
  "summarizeExecError",
]);
const REEXPORTED = Object.freeze([
  "checkInflightRuns",
  "checkPullRequest",
  "routeFromInflight",
]);
const PUBLIC_EXPORTS = Object.freeze([
  "checkInflightRuns",
  "checkPullRequest",
  "compareReviewSnapshot",
  "main",
  "routeFromInflight",
  "snapshotReview",
]);

function declarationPattern(name) {
  return new RegExp(`(?:async )?function ${name}\\(`);
}

test("run-preflight-helpers owns the inflight route helper declarations", () => {
  const helpersSrc = fs.readFileSync(HELPERS_PATH, "utf8");
  const preflightSrc = fs.readFileSync(PREFLIGHT_PATH, "utf8");
  for (const name of OWNED) {
    assert.match(helpersSrc, declarationPattern(name), `${name} must be declared in run-preflight-helpers.js`);
    assert.doesNotMatch(preflightSrc, declarationPattern(name), `${name} must not remain declared in run-preflight.js`);
  }
  assert.match(preflightSrc, /require\(["']\.\/run-preflight-helpers["']\)/);
  assert.match(preflightSrc, /(?:async )?function main\(/);
  assert.match(preflightSrc, /(?:async )?function runRouteStage\(/);
  assert.match(preflightSrc, /(?:async )?function runReviewStage\(/);
});

test("run-preflight re-exports the same run-preflight-helpers function identity", () => {
  const preflight = require(PREFLIGHT_PATH);
  const helpers = require(HELPERS_PATH);
  for (const name of OWNED) {
    assert.equal(typeof helpers[name], "function", `${name} is exported from run-preflight-helpers`);
  }
  for (const name of REEXPORTED) {
    assert.equal(typeof preflight[name], "function", `${name} is re-exported from run-preflight`);
    assert.equal(preflight[name], helpers[name], `${name} re-export identity`);
  }
  assert.deepEqual(Object.keys(preflight).sort(), [...PUBLIC_EXPORTS].sort());
  assert.equal(typeof preflight.main, "function");
  assert.equal(Object.hasOwn(preflight, "main"), true);
});
