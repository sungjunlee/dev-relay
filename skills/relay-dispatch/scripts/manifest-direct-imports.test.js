const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("relay-manifest facade stays a tiny re-export-only module", () => {
  const facadePath = path.join(__dirname, "relay-manifest.js");
  const facadeSource = fs.readFileSync(facadePath, "utf-8");
  const facadeLineCount = facadeSource.trimEnd().split("\n").length;
  const functionDeclarations = facadeSource.match(/^\s*(?:async\s+)?function\b/mg) || [];

  assert.ok(
    facadeLineCount <= 40,
    `relay-manifest.js must stay a tiny facade (expected <= 40 lines, got ${facadeLineCount})`
  );
  assert.deepEqual(
    functionDeclarations,
    [],
    "relay-manifest.js must not regain function declarations; keep logic in manifest/* slices"
  );
});

require("./manifest/paths.test");
require("./manifest/store.test");
require("./manifest/lifecycle.test");
require("./manifest/rubric.test");
require("./manifest/cleanup.test");
require("./manifest/attempts.test");
require("./manifest/environment.test");
