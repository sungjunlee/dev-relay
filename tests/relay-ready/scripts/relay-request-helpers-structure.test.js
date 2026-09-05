"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const REQUEST_PATH = path.join(ROOT, "skills", "relay-ready", "scripts", "relay-request.js");
const HELPERS_PATH = path.join(ROOT, "skills", "relay-ready", "scripts", "relay-request-helpers.js");
const OWNED = Object.freeze([
  "assertSafeId",
  "canonicalRepoRoot",
  "createRequestId",
  "ensurePrivateDirectory",
  "fsyncDirectory",
  "getRequestsDir",
  "publishAtomicExclusive",
  "readRegular",
  "trustedRequestsBase",
  "writeExclusive",
]);
const REEXPORTED = Object.freeze([
  "createRequestId",
]);
const PUBLIC_ENTRY = Object.freeze([
  "persistRequestContract",
  "readRequestArtifact",
]);

function declarationPattern(name) {
  return new RegExp(`(?:async )?function ${name}\\(`);
}

test("relay-request-helpers owns the trusted-storage helper declarations", () => {
  const helpersSrc = fs.readFileSync(HELPERS_PATH, "utf8");
  const requestSrc = fs.readFileSync(REQUEST_PATH, "utf8");
  for (const name of OWNED) {
    assert.match(helpersSrc, declarationPattern(name), `${name} must be declared in relay-request-helpers.js`);
    assert.doesNotMatch(requestSrc, declarationPattern(name), `${name} must not remain declared in relay-request.js`);
  }
  assert.match(requestSrc, /require\(["']\.\/relay-request-helpers["']\)/);
  for (const name of PUBLIC_ENTRY) {
    assert.match(requestSrc, declarationPattern(name), `${name} must remain the public request entry in relay-request.js`);
  }
});

test("relay-request re-exports the same relay-request-helpers function identity", () => {
  const request = require(REQUEST_PATH);
  const helpers = require(HELPERS_PATH);
  for (const name of REEXPORTED) {
    assert.equal(typeof helpers[name], "function", `${name} is exported from relay-request-helpers`);
    assert.equal(typeof request[name], "function", `${name} is re-exported from relay-request`);
    assert.equal(request[name], helpers[name], `${name} re-export identity`);
  }
  assert.deepEqual(Object.keys(request).sort(), [
    "createRequestId",
    "normalizeSingleLeafContract",
    "persistRequestContract",
    "readRequestArtifact",
  ]);
});
