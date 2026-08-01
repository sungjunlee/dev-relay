const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
test("evaluation policy modules stay deleted instead of moving layers", () => {
  for (const relativePath of [
    "skills/relay-dispatch/scripts/evaluation-contract.js",
    "skills/relay-review/scripts/review-runner/evaluation-channels.js",
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), false, relativePath);
  }
});
