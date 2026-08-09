"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const gate = require("../../../skills/relay-merge/scripts/gate-check");

test("gate-check CLI is closed over the vNext run selector", () => {
  const parsed = gate.parseCli(["--repo", "/tmp/repo", "--run-id", "run-1", "--json"]);
  assert.equal(parsed.values["run-id"], "run-1");
  assert.equal(parsed.values.json, true);
  assert.throws(() => gate.parseCli(["--run-id", "run-1", "--skip", "hotfix"]), /unknown flag/);
  assert.throws(() => gate.parseCli(["--run-id", "run-1", "--dry-run"]), /unknown flag/);
});

test("gate-check help describes a read-only exact-SHA gate", () => {
  assert.match(gate.usage(), /read-only/i);
  assert.match(gate.usage(), /exact-SHA/i);
  assert.match(gate.usage(), /not part of the Relay merge contract/i);
});
