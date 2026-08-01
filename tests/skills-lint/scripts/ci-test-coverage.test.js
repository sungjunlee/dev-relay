"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TESTS_DIR = path.join(REPO_ROOT, "tests");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "test.yml");

function discoverTestSuites(testsDir = TESTS_DIR) {
  if (!fs.existsSync(testsDir)) return [];
  return fs.readdirSync(testsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((suite) => {
      const scriptsDir = path.join(testsDir, suite, "scripts");
      return fs.existsSync(scriptsDir)
        && discoverTestsRecursively(scriptsDir).length > 0;
    })
    .sort();
}

function discoverTestsRecursively(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return discoverTestsRecursively(absolute);
    return entry.isFile() && entry.name.endsWith(".test.js") ? [absolute] : [];
  });
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

function extractSuiteMatrix(content) {
  const lines = content.split(/\r\n|\n|\r/);
  const matrixIndex = lines.findIndex((line) => line.trim() === "matrix:");
  assert.notEqual(matrixIndex, -1, "workflow must declare a matrix");
  const matrixIndent = indentation(lines[matrixIndex]);

  for (let suiteIndex = matrixIndex + 1; suiteIndex < lines.length; suiteIndex += 1) {
    const suiteLine = lines[suiteIndex];
    const trimmed = suiteLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (indentation(suiteLine) <= matrixIndent) break;
    if (trimmed === "include:") {
      const includeIndent = indentation(suiteLine);
      const suites = [];
      for (let entryIndex = suiteIndex + 1; entryIndex < lines.length; entryIndex += 1) {
        const entryLine = lines[entryIndex];
        const entry = entryLine.trim();
        if (entry === "" || entry.startsWith("#")) continue;
        if (indentation(entryLine) <= includeIndent) break;
        const match = entry.match(/^-\s+suite:\s+([a-z0-9]+(?:-[a-z0-9]+)*)$/);
        if (match) suites.push(match[1]);
      }
      return suites;
    }
    if (trimmed !== "suite:") continue;

    const suiteIndent = indentation(suiteLine);
    const suites = [];
    for (let entryIndex = suiteIndex + 1; entryIndex < lines.length; entryIndex += 1) {
      const entryLine = lines[entryIndex];
      const entry = entryLine.trim();
      if (entry === "" || entry.startsWith("#")) continue;
      if (indentation(entryLine) <= suiteIndent) break;

      const match = entry.match(/^-\s+([a-z0-9]+(?:-[a-z0-9]+)*)$/);
      assert.ok(match, `invalid suite matrix entry: ${entry}`);
      suites.push(match[1]);
    }
    return suites;
  }

  assert.fail("workflow must declare matrix.suite");
}

function assertMatrixRunsGuardedSuiteGlob(content) {
  assert.match(content, /files=\(\)/, "workflow must initialize a guarded files array");
  const runMatch = content.match(/Run test suites[\s\S]*$/);
  assert.ok(runMatch, "workflow must declare a 'Run test suites' step");
  assert.match(
    runMatch[0],
    /find "tests\/\$\{\{\s*matrix\.suite\s*\}\}\/scripts" -type f -name '\*\.test\.js'/,
    "portable file discovery must recursively resolve the current matrix.suite",
  );
  assert.match(runMatch[0], /while IFS= read -r file; do[\s\S]*files\+=\("\$file"\)/);
  assert.match(
    runMatch[0],
    /node --test --test-concurrency=1 "\$\{files\[@\]\}"/,
    "test command must run the guarded files array with internal serialization",
  );
}

function findTestSuitesMissingFromCi({ testsDir = TESTS_DIR, workflow } = {}) {
  const matrixSuites = extractSuiteMatrix(workflow);
  return discoverTestSuites(testsDir)
    .filter((suite) => !matrixSuites.includes(suite));
}

function assertTestSuitesWiredIntoCi(options = {}) {
  assertMatrixRunsGuardedSuiteGlob(options.workflow);
  const missing = findTestSuitesMissingFromCi(options);
  assert.deepEqual(
    missing,
    [],
    `test suites missing from matrix.suite:\n${missing.map((suite) => `- ${suite}`).join("\n")}`,
  );
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function buildFixture({ wired }) {
  const testsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-coverage-tests-"));
  writeFile(path.join(testsDir, "newskill", "scripts", "example.test.js"), "// fixture\n");
  writeFile(path.join(testsDir, "newskill", "scripts", "nested", "example.test.js"), "// fixture\n");
  const matrixEntry = wired ? "\n          - newskill" : "";
  const workflow = [
    "    strategy:",
    "      matrix:",
    "        suite:" + matrixEntry,
    "    steps:",
    "      - name: Run test suites (${{ matrix.suite }})",
    "        run: |",
    "          files=()",
    "          while IFS= read -r file; do",
    "            files+=(\"$file\")",
    "          done < <(find \"tests/${{ matrix.suite }}/scripts\" -type f -name '*.test.js' -print | LC_ALL=C sort)",
    "          node --test --test-concurrency=1 \"${files[@]}\"",
    "",
  ].join("\n");
  return { testsDir, workflow };
}

test("every tests/*/scripts suite is wired into the CI matrix", () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH), ".github/workflows/test.yml is missing");
  const workflow = fs.readFileSync(WORKFLOW_PATH, "utf-8");
  assertTestSuitesWiredIntoCi({ workflow });
});

test("coverage guard passes when a filesystem suite is present in the matrix", () => {
  const { testsDir, workflow } = buildFixture({ wired: true });
  try {
    assertTestSuitesWiredIntoCi({ testsDir, workflow });
  } finally {
    fs.rmSync(testsDir, { recursive: true, force: true });
  }
});

test("coverage guard flags a filesystem suite omitted from the matrix", () => {
  const { testsDir, workflow } = buildFixture({ wired: false });
  try {
    assert.throws(
      () => assertTestSuitesWiredIntoCi({ testsDir, workflow }),
      /newskill/,
    );
    assert.deepEqual(findTestSuitesMissingFromCi({ testsDir, workflow }), ["newskill"]);
  } finally {
    fs.rmSync(testsDir, { recursive: true, force: true });
  }
});

test("workflow recursively includes nested test files", () => {
  const { testsDir, workflow } = buildFixture({ wired: true });
  try {
    assertMatrixRunsGuardedSuiteGlob(workflow);
    const scriptsDir = path.join(testsDir, "newskill", "scripts");
    assert.equal(discoverTestsRecursively(scriptsDir).length, 2);
    assert.equal(discoverTestsRecursively(path.join(scriptsDir, "nested")).length, 1);
  } finally {
    fs.rmSync(testsDir, { recursive: true, force: true });
  }
});
