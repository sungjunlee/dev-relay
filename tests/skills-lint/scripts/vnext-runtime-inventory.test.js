"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  readInventory,
  stableReport,
  validateInventory,
} = require("./vnext-runtime-inventory");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const INVENTORY_PATH = path.join(REPO_ROOT, "docs", "contracts", "relay-runtime-inventory.v1.json");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function fixtureInventory() {
  return {
    schemaVersion: 1,
    artifactGroups: [
      {
        disposition: "retain",
        artifacts: [{
          path: "skills/relay-dispatch/scripts/shared.js",
          roles: { detected: [], reviewedSemantic: [] },
        }],
      },
      {
        disposition: "migrate",
        artifacts: [
          {
            path: "skills/relay/scripts/entry.js",
            roles: { detected: ["cli-entry"], reviewedSemantic: [] },
          },
          {
            path: "skills/relay-dispatch/scripts/worker.js",
            roles: { detected: [], reviewedSemantic: [] },
          },
        ],
      },
      {
        disposition: "remove",
        artifacts: [{
          path: "skills/relay/scripts/obsolete.js",
          roles: { detected: [], reviewedSemantic: [] },
        }],
      },
      {
        disposition: "historical-reader-only",
        artifacts: [{
          path: "skills/relay/scripts/archive-reader.js",
          roles: { detected: [], reviewedSemantic: [] },
        }],
      },
    ],
    crossSkillStaticImports: [{
      from: "skills/relay/scripts/entry.js",
      to: "skills/relay-dispatch/scripts/shared.js",
    }],
    dynamicInvocationEdges: [{
      from: "skills/relay/scripts/entry.js",
      to: "skills/relay-dispatch/scripts/worker.js",
    }],
  };
}

function buildFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vnext-runtime-inventory-"));
  writeFile(
    path.join(repoRoot, "skills", "relay", "scripts", "entry.js"),
    [
      "const path = require(\"node:path\");",
      'require("../../relay-dispatch/scripts/shared");',
      "const args = process.argv.slice(2);",
      'const workerPath = path.join(__dirname, "..", "..", "relay-dispatch", "scripts", "worker.js");',
      'require("node:child_process").spawnSync(process.execPath, [workerPath, ...args]);',
      "",
    ].join("\n"),
  );
  writeFile(path.join(repoRoot, "skills", "relay", "scripts", "obsolete.js"), "module.exports = {};\n");
  writeFile(path.join(repoRoot, "skills", "relay", "scripts", "archive-reader.js"), "module.exports = {};\n");
  writeFile(path.join(repoRoot, "skills", "relay-dispatch", "scripts", "shared.js"), "module.exports = {};\n");
  writeFile(path.join(repoRoot, "skills", "relay-dispatch", "scripts", "worker.js"), "module.exports = {};\n");
  return repoRoot;
}

test("checked-in runtime inventory covers every shipped relay script and edge", () => {
  assert.doesNotThrow(() => validateInventory({
    repoRoot: REPO_ROOT,
    inventory: readInventory(INVENTORY_PATH),
  }));
});

test("retired runtime table and deletion plan map the same absent production scripts", () => {
  const inventory = readInventory(INVENTORY_PATH);
  const retired = inventory.retiredArtifacts.map((entry) => entry.path).sort();
  const plan = fs.readFileSync(path.join(
    REPO_ROOT,
    "docs/plans/relay-runtime-core-reset-vnext/06-delete-runtime-accretion.md",
  ), "utf8");
  const mapped = [...plan.matchAll(/\| `([^`]+\.js)` \|/g)]
    .map((match) => `skills/${match[1]}`)
    .sort();
  assert.ok(retired.length > 0);
  assert.equal(new Set(retired).size, retired.length);
  assert.deepEqual(mapped, retired);
  retired.forEach((script) => assert.equal(fs.existsSync(path.join(REPO_ROOT, script)), false, script));
});

test("runtime inventory report is byte-deterministic", () => {
  const inventory = readInventory(INVENTORY_PATH);
  const first = stableReport(validateInventory({ repoRoot: REPO_ROOT, inventory }));
  const second = stableReport(validateInventory({ repoRoot: REPO_ROOT, inventory }));
  assert.equal(first, second);
});

test("runtime inventory distinguishes static imports from dynamic invocations", () => {
  const repoRoot = buildFixture();
  const result = validateInventory({ repoRoot, inventory: fixtureInventory() });

  assert.deepEqual(result.staticImports, [{
    from: "skills/relay/scripts/entry.js",
    to: "skills/relay-dispatch/scripts/shared.js",
    kind: "static-import",
  }]);
  assert.deepEqual(result.dynamicInvocations, [{
    from: "skills/relay/scripts/entry.js",
    to: "skills/relay-dispatch/scripts/worker.js",
    kind: "dynamic-invocation",
  }]);
});

test("runtime inventory fails for a planted unknown script", () => {
  const repoRoot = buildFixture();
  writeFile(path.join(repoRoot, "skills", "relay", "scripts", "zz-unknown.js"), "module.exports = {};\n");

  assert.throws(
    () => validateInventory({ repoRoot, inventory: fixtureInventory() }),
    /unknown runtime script: skills\/relay\/scripts\/zz-unknown\.js/,
  );
});

test("runtime inventory fails for a planted unaccounted cross-skill import", () => {
  const repoRoot = buildFixture();
  writeFile(
    path.join(repoRoot, "skills", "relay", "scripts", "entry.js"),
    [
      "const path = require(\"node:path\");",
      'require("../../relay-dispatch/scripts/shared");',
      'require("../../relay-dispatch/scripts/worker");',
      "const args = process.argv.slice(2);",
      'const workerPath = path.join(__dirname, "..", "..", "relay-dispatch", "scripts", "worker.js");',
      'require("node:child_process").spawnSync(process.execPath, [workerPath, ...args]);',
      "",
    ].join("\n"),
  );

  assert.throws(
    () => validateInventory({ repoRoot, inventory: fixtureInventory() }),
    /unaccounted cross-skill static import: skills\/relay\/scripts\/entry\.js -> skills\/relay-dispatch\/scripts\/worker\.js/,
  );
});

test("runtime inventory rejects duplicate declarations", () => {
  const repoRoot = buildFixture();
  const inventory = fixtureInventory();
  inventory.artifactGroups[1].artifacts.push({
    path: "skills/relay/scripts/entry.js",
    roles: { detected: ["cli-entry"], reviewedSemantic: [] },
  });

  assert.throws(
    () => validateInventory({ repoRoot, inventory }),
    /duplicate runtime inventory item: skills\/relay\/scripts\/entry\.js/,
  );
});

test("runtime inventory fails when a directly detected access role is missing", () => {
  const repoRoot = buildFixture();
  const inventory = fixtureInventory();
  inventory.artifactGroups[1].artifacts[0].roles.detected = [];

  assert.throws(
    () => validateInventory({ repoRoot, inventory }),
    /missing detected runtime role for skills\/relay\/scripts\/entry\.js: cli-entry/,
  );
});
