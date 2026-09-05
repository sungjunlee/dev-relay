"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const GATE_PATH = path.join(ROOT, "skills", "relay-merge", "scripts", "run-full-gate.js");
const HELPERS_PATH = path.join(ROOT, "skills", "relay-merge", "scripts", "run-full-gate-helpers.js");
const OWNED = Object.freeze([
  "acquireLock",
  "atomicWriteJson",
  "createLockAtomically",
  "isProcessAlive",
  "readJson",
  "releaseLock",
  "sameOwner",
  "sleep",
  "updateStatus",
]);
const REEXPORTED = Object.freeze([
  "isProcessAlive",
]);
const PUBLIC_ENTRY = Object.freeze([
  "main",
  "waitForDetached",
]);

function declarationPattern(name) {
  return new RegExp(`(?:async )?function ${name}\\(`);
}

test("run-full-gate-helpers owns the lock/status helper declarations", () => {
  const helpersSrc = fs.readFileSync(HELPERS_PATH, "utf8");
  const gateSrc = fs.readFileSync(GATE_PATH, "utf8");
  for (const name of OWNED) {
    assert.match(helpersSrc, declarationPattern(name), `${name} must be declared in run-full-gate-helpers.js`);
    assert.doesNotMatch(gateSrc, declarationPattern(name), `${name} must not remain declared in run-full-gate.js`);
  }
  assert.match(gateSrc, /require\(["']\.\/run-full-gate-helpers["']\)/);
  for (const name of PUBLIC_ENTRY) {
    assert.match(gateSrc, declarationPattern(name), `${name} must remain the public full-gate entry in run-full-gate.js`);
  }
});

test("run-full-gate re-exports the same run-full-gate-helpers function identity", () => {
  const gate = require(GATE_PATH);
  const helpers = require(HELPERS_PATH);
  for (const name of REEXPORTED) {
    assert.equal(typeof helpers[name], "function", `${name} is exported from run-full-gate-helpers`);
    assert.equal(typeof gate[name], "function", `${name} is re-exported from run-full-gate`);
    assert.equal(gate[name], helpers[name], `${name} re-export identity`);
  }
  assert.deepEqual(Object.keys(gate).sort(), [
    "DEFAULT_SUITES",
    "expandSuites",
    "globToRegExp",
    "isProcessAlive",
    "waitForDetached",
  ]);
});
