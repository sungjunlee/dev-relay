"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const FACTS_PATH = path.join(ROOT, "skills", "relay-dispatch", "scripts", "facts.js");
const HELPERS_PATH = path.join(ROOT, "skills", "relay-dispatch", "scripts", "facts-helpers.js");
const OWNED = Object.freeze([
  "fail",
  "isPlainObject",
  "exactKeys",
  "string",
  "integer",
  "sha",
  "boolean",
  "validateOverride",
  "validatePayload",
  "validateFact",
]);
const REEXPORTED = Object.freeze([
  "validateFact",
]);

function declarationPattern(name) {
  return new RegExp(`(?:async )?function ${name}\\(`);
}

test("facts-helpers owns the validation helper function declarations", () => {
  const helpersSrc = fs.readFileSync(HELPERS_PATH, "utf8");
  const factsSrc = fs.readFileSync(FACTS_PATH, "utf8");
  for (const name of OWNED) {
    assert.match(helpersSrc, declarationPattern(name), `${name} must be declared in facts-helpers.js`);
    assert.doesNotMatch(factsSrc, declarationPattern(name), `${name} must not remain declared in facts.js`);
  }
  assert.match(factsSrc, /require\(["']\.\/facts-helpers["']\)/);
});

test("facts.js re-exports the same facts-helpers function identity", () => {
  const facts = require(FACTS_PATH);
  const helpers = require(HELPERS_PATH);
  for (const name of REEXPORTED) {
    assert.equal(typeof helpers[name], "function", `${name} is exported from facts-helpers`);
    assert.equal(typeof facts[name], "function", `${name} is re-exported from facts`);
    assert.equal(facts[name], helpers[name], `${name} re-export identity`);
  }
  assert.equal(facts.PAYLOAD_SCHEMAS, helpers.PAYLOAD_SCHEMAS);
  assert.equal(facts.ATTEMPT_TYPES, helpers.ATTEMPT_TYPES);
  assert.equal(facts.MAX_FACT_BYTES, helpers.MAX_FACT_BYTES);
});
