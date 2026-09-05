"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const storePath = path.resolve(__dirname, "../../../skills/relay-dispatch/scripts/run-store.js");
const helpersPath = path.resolve(__dirname, "../../../skills/relay-dispatch/scripts/run-store-helpers.js");
const store = require(storePath);
const helpers = require(helpersPath);

const OWNED_NAMES = Object.freeze([
  "invokeIndependentReviewer",
  "invokeExternalObserver",
  "runHosted",
  "observableHostedProcess",
]);

const REEXPORTED = Object.freeze([
  "invokeIndependentReviewer",
  "invokeExternalObserver",
  "fsyncDirectory",
]);

function source(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function definitionPattern(name) {
  return new RegExp(String.raw`^(?:async )?function ${name}\(`, "m");
}

test("hosted review/observer helpers are defined only in run-store-helpers.js", () => {
  const storeSrc = source(storePath);
  const helpersSrc = source(helpersPath);
  for (const name of OWNED_NAMES) {
    assert.match(helpersSrc, definitionPattern(name), `${name} must be defined in run-store-helpers.js`);
    assert.doesNotMatch(storeSrc, definitionPattern(name), `${name} must not be defined in run-store.js`);
  }
  assert.match(storeSrc, /require\(["']\.\/run-store-helpers["']\)/);
  for (const name of REEXPORTED) {
    assert.match(storeSrc, new RegExp(`\\b${name}\\b`), `${name} must remain reachable from run-store.js`);
  }
});

test("run-store.js re-exports helper functions with identical function identity", () => {
  for (const name of REEXPORTED) {
    assert.equal(typeof helpers[name], "function", `${name} is exported from run-store-helpers`);
    assert.equal(typeof store[name], "function", `${name} is re-exported from run-store`);
    assert.equal(store[name], helpers[name], `${name} re-export identity`);
  }
  assert.equal(typeof helpers.runHosted, "function");
  assert.equal(typeof helpers.observableHostedProcess, "function");
});
