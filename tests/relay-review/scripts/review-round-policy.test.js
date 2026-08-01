const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");

test("review round cap helper stays deleted instead of being relocated", () => {
  const removedHelper = path.join(
    ROOT,
    "skills",
    "relay-review",
    "scripts",
    "review-runner",
    "round-cap.js",
  );
  assert.equal(fs.existsSync(removedHelper), false);
});
