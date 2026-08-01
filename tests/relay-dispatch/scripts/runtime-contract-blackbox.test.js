const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const contract = require("../../../docs/contracts/relay-runtime-contracts.v1.json");

test("runtime contract manifest resolves every invariant to a current named vNext test", () => {
  assert.equal(contract.contract_version, 1);
  assert.equal(contract.invariants.length, 12);
  assert.equal(new Set(contract.invariants.map((entry) => entry.id)).size, 12);

  for (const invariant of contract.invariants) {
    assert.equal(invariant.status, "vnext_gate", `${invariant.id} must use the current vNext gate`);
    assert.deepEqual(invariant.evidence || [], [], `${invariant.id} must not claim deleted legacy evidence`);
    assert.equal(typeof invariant.vnext_test_path, "string", `${invariant.id} needs a named vNext gate`);

    const separator = invariant.vnext_test_path.indexOf("#");
    assert.ok(separator > 0, `${invariant.id} vNext gate must name a test after #`);
    const relativeFile = invariant.vnext_test_path.slice(0, separator);
    const testName = invariant.vnext_test_path.slice(separator + 1);
    const absoluteFile = path.join(__dirname, "..", "..", "..", relativeFile);
    assert.equal(fs.existsSync(absoluteFile), true, `${invariant.id} missing ${relativeFile}`);
    const source = fs.readFileSync(absoluteFile, "utf8");
    const escapedName = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(source, new RegExp(`test\\([\"']${escapedName}`));
  }
});
