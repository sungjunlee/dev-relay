"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ORIGINAL = path.resolve(__dirname, "../../../skills/relay-merge/scripts/finalize-run.js");
const TERMINAL = path.resolve(__dirname, "../../../skills/relay-merge/scripts/finalize-run-terminal.js");

const TERMINAL_OWNED = [
  "assertBaseIntegrity",
  "finishTerminal",
  "mergeObserver",
  "productionServices",
  "readRegularJson",
];

function declaredFunctions(source) {
  const names = new Set();
  const patterns = [
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\(|\([^)]*\)\s*=>)/gm,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) names.add(match[1]);
  }
  return names;
}

test("terminal/integrity helpers are defined only in finalize-run-terminal.js", () => {
  const originalNames = declaredFunctions(fs.readFileSync(ORIGINAL, "utf8"));
  const terminalNames = declaredFunctions(fs.readFileSync(TERMINAL, "utf8"));

  for (const name of TERMINAL_OWNED) {
    assert.equal(terminalNames.has(name), true, `${name} must be declared in finalize-run-terminal.js`);
    assert.equal(originalNames.has(name), false, `${name} must not be declared in finalize-run.js`);
  }
});

test("finalize-run re-exports terminal/integrity helpers by identity", () => {
  const original = require("../../../skills/relay-merge/scripts/finalize-run");
  const terminal = require("../../../skills/relay-merge/scripts/finalize-run-terminal");

  for (const name of TERMINAL_OWNED) {
    assert.equal(typeof terminal[name], "function", `${name} must be exported from finalize-run-terminal.js`);
    assert.equal(original[name], terminal[name], `${name} must be the same function on finalize-run.js`);
  }
});
