"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const RECOVER_PATH = path.join(ROOT, "skills", "relay-dispatch", "scripts", "recover.js");
const PRODUCTION_PATH = path.join(ROOT, "skills", "relay-dispatch", "scripts", "recover-production.js");
const OWNED = Object.freeze([
  "createProductionEffects",
  "recoverProductionRun",
  "withProductionRecoveryLock",
]);

function declarationPattern(name) {
  return new RegExp(`(?:async )?function ${name}\\(`);
}

test("recover-production owns the production recovery function declarations", () => {
  const productionSrc = fs.readFileSync(PRODUCTION_PATH, "utf8");
  const recoverSrc = fs.readFileSync(RECOVER_PATH, "utf8");
  for (const name of OWNED) {
    assert.match(productionSrc, declarationPattern(name), `${name} must be declared in recover-production.js`);
    assert.doesNotMatch(recoverSrc, declarationPattern(name), `${name} must not remain declared in recover.js`);
  }
  assert.match(recoverSrc, /require\(["']\.\/recover-production["']\)/);
});

test("recover re-exports the same recover-production function identity", () => {
  const recover = require(RECOVER_PATH);
  const production = require(PRODUCTION_PATH);
  for (const name of OWNED) {
    assert.equal(typeof production[name], "function", `${name} is exported from recover-production`);
    assert.equal(typeof recover[name], "function", `${name} is re-exported from recover`);
    assert.equal(recover[name], production[name], `${name} re-export identity`);
  }
});
