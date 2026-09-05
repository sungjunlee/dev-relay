"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const STATUS_PATH = path.join(ROOT, "skills", "relay", "scripts", "relay-status.js");
const HELPERS_PATH = path.join(ROOT, "skills", "relay", "scripts", "relay-status-helpers.js");
const OWNED = Object.freeze([
  "applyGcCandidate",
  "durableClassification",
  "readDurableRun",
  "scanAllRuns",
  "worktreeCandidates",
]);
const REEXPORTED = Object.freeze([
  "applyGcCandidate",
  "durableClassification",
  "scanAllRuns",
  "worktreeCandidates",
]);

function declarationPattern(name) {
  return new RegExp(`(?:async )?function ${name}\\(`);
}

test("relay-status-helpers owns the --all scan/GC helper declarations", () => {
  const helpersSrc = fs.readFileSync(HELPERS_PATH, "utf8");
  const statusSrc = fs.readFileSync(STATUS_PATH, "utf8");
  for (const name of OWNED) {
    assert.match(helpersSrc, declarationPattern(name), `${name} must be declared in relay-status-helpers.js`);
    assert.doesNotMatch(statusSrc, declarationPattern(name), `${name} must not remain declared in relay-status.js`);
  }
  assert.match(statusSrc, /require\(["']\.\/relay-status-helpers["']\)/);
  assert.match(statusSrc, /(?:async )?function main\(/);
  assert.match(statusSrc, /(?:async )?function statusRow\(/);
});

test("relay-status re-exports the same relay-status-helpers function identity", () => {
  const status = require(STATUS_PATH);
  const helpers = require(HELPERS_PATH);
  for (const name of REEXPORTED) {
    assert.equal(typeof helpers[name], "function", `${name} is exported from relay-status-helpers`);
    assert.equal(typeof status[name], "function", `${name} is re-exported from relay-status`);
    assert.equal(status[name], helpers[name], `${name} re-export identity`);
  }
});
