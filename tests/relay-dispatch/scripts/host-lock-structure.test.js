"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const hostPath = path.resolve(__dirname, "../../../skills/relay-dispatch/scripts/host.js");
const lockPath = path.resolve(__dirname, "../../../skills/relay-dispatch/scripts/host-lock.js");
const host = require(hostPath);
const lock = require(lockPath);

const OWNED_NAMES = [
  "linuxProcessRows",
  "acquireRunLock",
  "breakStaleRunLock",
  "removeBoundDirectory",
  "cleanupObligation",
  "probeOwner",
];

function source(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function definitionPattern(name) {
  return new RegExp(String.raw`^(?:async )?function ${name}\(`, "m");
}

test("lock/process helpers are defined only in host-lock.js", () => {
  const hostSrc = source(hostPath);
  const lockSrc = source(lockPath);
  for (const name of OWNED_NAMES) {
    assert.match(lockSrc, definitionPattern(name), `${name} must be defined in host-lock.js`);
    assert.doesNotMatch(hostSrc, definitionPattern(name), `${name} must not be defined in host.js`);
    assert.match(hostSrc, new RegExp(`\\b${name}\\b`), `${name} must remain reachable from host.js`);
  }
  assert.match(hostSrc, /require\(["']\.\/host-lock["']\)/);
});

test("host.js re-exports lock helpers with identical function identity", () => {
  assert.equal(host.acquireRunLock, lock.acquireRunLock);
  assert.equal(host.breakStaleRunLock, lock.breakStaleRunLock);
  assert.equal(host.hostInvocation.removeBoundDirectory, lock.removeBoundDirectory);
  assert.equal(typeof lock.linuxProcessRows, "function");
  assert.equal(typeof lock.cleanupObligation, "function");
  assert.equal(typeof lock.probeOwner, "function");
});
