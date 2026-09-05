"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const CONTRACT_PATH = path.join(ROOT, "skills", "relay-dispatch", "scripts", "adapter-contract.js");
const HELPERS_PATH = path.join(ROOT, "skills", "relay-dispatch", "scripts", "adapter-contract-helpers.js");
const OWNED = Object.freeze([
  "makeParseOutcome",
  "outcomeStatus",
  "parseJsonlRunResult",
  "parseOutput",
  "readOutput",
]);
const REEXPORTED = Object.freeze([
  "makeParseOutcome",
  "parseOutput",
]);
const PUBLIC_ENTRY = Object.freeze([
  "createNativeAdapter",
]);
const PUBLIC_EXPORTS = Object.freeze([
  "AdapterCapabilityError",
  "OUTPUT_PROTOCOLS",
  "PHASES",
  "PROCESS_CONTAINMENT",
  "assertInvocationShape",
  "createNativeAdapter",
  "decodeTrustedPrompt",
  "filesystemIsolationDiagnostic",
  "formatAdapterPhase",
  "loopbackListenDiagnostic",
  "makeParseOutcome",
  "normalizeCompletionSignal",
  "normalizeProviderUnavailableSignals",
  "parseJsonObject",
  "parseOutput",
  "probeBinary",
  "recoverExecStdout",
  "requireAbsolutePath",
  "requireSafeOptionalValue",
  "resolveAdapterProvider",
  "validateCapabilities",
]);

function declarationPattern(name) {
  return new RegExp(`(?:async )?function ${name}\\(`);
}

test("adapter-contract-helpers owns the outcome-parse helper declarations", () => {
  const helpersSrc = fs.readFileSync(HELPERS_PATH, "utf8");
  const contractSrc = fs.readFileSync(CONTRACT_PATH, "utf8");
  for (const name of OWNED) {
    assert.match(helpersSrc, declarationPattern(name), `${name} must be declared in adapter-contract-helpers.js`);
    assert.doesNotMatch(contractSrc, declarationPattern(name), `${name} must not remain declared in adapter-contract.js`);
  }
  assert.match(contractSrc, /require\(["']\.\/adapter-contract-helpers["']\)/);
  for (const name of PUBLIC_ENTRY) {
    assert.match(contractSrc, declarationPattern(name), `${name} must remain the public contract entry in adapter-contract.js`);
  }
});

test("adapter-contract re-exports the same adapter-contract-helpers function identity", () => {
  const contract = require(CONTRACT_PATH);
  const helpers = require(HELPERS_PATH);
  for (const name of OWNED) {
    assert.equal(typeof helpers[name], "function", `${name} is exported from adapter-contract-helpers`);
  }
  for (const name of REEXPORTED) {
    assert.equal(typeof contract[name], "function", `${name} is re-exported from adapter-contract`);
    assert.equal(contract[name], helpers[name], `${name} re-export identity`);
  }
  assert.deepEqual(Object.keys(contract).sort(), [...PUBLIC_EXPORTS].sort());
  assert.equal(typeof contract.createNativeAdapter, "function");
  assert.equal(Object.hasOwn(contract, "createNativeAdapter"), true);
});
