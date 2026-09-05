"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const DISPATCH_PATH = path.join(ROOT, "skills", "relay-dispatch", "scripts", "dispatch.js");
const HELPERS_PATH = path.join(ROOT, "skills", "relay-dispatch", "scripts", "dispatch-helpers.js");
const OWNED = Object.freeze([
  "canonicalCheckout",
  "createRetainedWorktree",
  "createWorktreeBase",
  "removeUnpublishedRun",
  "repositoryIdentity",
  "resolvePublicationBase",
]);
const REEXPORTED = Object.freeze([
  "repositoryIdentity",
  "resolvePublicationBase",
]);

function declarationPattern(name) {
  return new RegExp(`(?:async )?function ${name}\\(`);
}

test("dispatch-helpers owns the worktree/publication helper declarations", () => {
  const helpersSrc = fs.readFileSync(HELPERS_PATH, "utf8");
  const dispatchSrc = fs.readFileSync(DISPATCH_PATH, "utf8");
  for (const name of OWNED) {
    assert.match(helpersSrc, declarationPattern(name), `${name} must be declared in dispatch-helpers.js`);
    assert.doesNotMatch(dispatchSrc, declarationPattern(name), `${name} must not remain declared in dispatch.js`);
  }
  assert.match(dispatchSrc, /require\(["']\.\/dispatch-helpers["']\)/);
});

test("dispatch re-exports the same dispatch-helpers function identity", () => {
  const dispatch = require(DISPATCH_PATH);
  const helpers = require(HELPERS_PATH);
  for (const name of REEXPORTED) {
    assert.equal(typeof helpers[name], "function", `${name} is exported from dispatch-helpers`);
    assert.equal(typeof dispatch[name], "function", `${name} is re-exported from dispatch`);
    assert.equal(dispatch[name], helpers[name], `${name} re-export identity`);
  }
});
