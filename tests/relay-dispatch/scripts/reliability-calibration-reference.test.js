const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("calibration reference defines class-local promotion and evidence boundaries", () => {
  const reference = read(
    "skills/relay-dispatch/references/risk-calibration.md"
  );
  const operatorUtilities = read(
    "skills/relay-dispatch/references/operator-utilities.md"
  );

  for (const taskClass of [
    "code",
    "design",
    "documentation",
    "operations_security",
    "data_change",
  ]) {
    assert.match(reference, new RegExp(taskClass));
  }
  assert.match(reference, /Verification.*not.*rubric value/is);
  assert.match(reference, /three.*each path/is);
  assert.match(reference, /safety boundary violation.*immediate rollback/is);
  assert.match(reference, /unique material defects.*friction/is);
  assert.match(reference, /does not.*auto.*promot/is);
  assert.match(operatorUtilities, /risk-calibration\.md/);
});
