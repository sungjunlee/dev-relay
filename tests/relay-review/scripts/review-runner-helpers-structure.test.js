"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const RUNNER_PATH = path.join(ROOT, "skills", "relay-review", "scripts", "review-runner.js");
const HELPERS_PATH = path.join(ROOT, "skills", "relay-review", "scripts", "review-runner-helpers.js");
const OWNED = Object.freeze([
  "canonicalRepository",
  "fail",
  "git",
  "gitRaw",
  "hasReviewInputBindingError",
  "immutableBytes",
  "normalizeExecutedRuntime",
  "normalizeVerdict",
  "productionServices",
  "readFrozenCriteria",
  "relayHome",
  "repoSlug",
  "requireReviewAction",
  "resolveRun",
  "reviewActionBindings",
  "reviewPrompt",
  "runRecordDigest",
  "secureDigest",
]);
const REEXPORTED = Object.freeze([
  "normalizeVerdict",
  "readFrozenCriteria",
  "requireReviewAction",
]);
const PUBLIC_EXPORTS = Object.freeze([
  "REVIEW_RESULT_SCHEMA",
  "main",
  "normalizeVerdict",
  "parseCli",
  "readFrozenCriteria",
  "requireReviewAction",
  "runReview",
]);

function declarationPattern(name) {
  return new RegExp(`(?:async )?function ${name}\\(`);
}

test("review-runner-helpers owns the review-subject helper declarations", () => {
  const helpersSrc = fs.readFileSync(HELPERS_PATH, "utf8");
  const runnerSrc = fs.readFileSync(RUNNER_PATH, "utf8");
  for (const name of OWNED) {
    assert.match(helpersSrc, declarationPattern(name), `${name} must be declared in review-runner-helpers.js`);
    assert.doesNotMatch(runnerSrc, declarationPattern(name), `${name} must not remain declared in review-runner.js`);
  }
  assert.match(runnerSrc, /require\(["']\.\/review-runner-helpers["']\)/);
  assert.match(runnerSrc, /(?:async )?function parseCli\(/);
  assert.match(runnerSrc, /(?:async )?function runReview\(/);
  assert.match(runnerSrc, /(?:async )?function main\(/);
});

test("review-runner re-exports helpers with the same function identity", () => {
  const runner = require(RUNNER_PATH);
  const helpers = require(HELPERS_PATH);
  for (const name of OWNED) {
    assert.equal(typeof helpers[name], "function", `${name} is exported from review-runner-helpers`);
  }
  for (const name of REEXPORTED) {
    assert.equal(typeof runner[name], "function", `${name} is re-exported from review-runner`);
    assert.equal(runner[name], helpers[name], `${name} re-export identity`);
  }
  assert.equal(runner.REVIEW_RESULT_SCHEMA, helpers.REVIEW_RESULT_SCHEMA);
  assert.deepEqual(Object.keys(runner).sort(), [...PUBLIC_EXPORTS].sort());
  assert.equal(typeof runner.runReview, "function");
  assert.equal(typeof runner.parseCli, "function");
  assert.equal(typeof runner.main, "function");
});
