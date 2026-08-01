"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TESTS_DIR = path.join(REPO_ROOT, "tests");
const WORKFLOW_PATH = process.env.CI_MATRIX_WORKFLOW_PATH
  ? path.resolve(process.env.CI_MATRIX_WORKFLOW_PATH)
  : path.join(REPO_ROOT, ".github", "workflows", "test.yml");

function indentation(line) {
  return line.length - line.trimStart().length;
}

function extractSuiteMatrices(content) {
  const lines = content.split(/\r\n|\n|\r/);
  const matrices = [];

  lines.forEach((line, matrixIndex) => {
    if (line.trim() !== "matrix:") return;
    const matrixIndent = indentation(line);

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
        matrices.push(suites);
        break;
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
        assert.ok(match, `invalid suite matrix entry in ${WORKFLOW_PATH}: ${entry}`);
        suites.push(match[1]);
      }
      matrices.push(suites);
      break;
    }
  });

  return matrices;
}

function discoverTestSuites(testsDir = TESTS_DIR) {
  function containsTest(root) {
    if (!fs.existsSync(root)) return false;
    return fs.readdirSync(root, { withFileTypes: true }).some((entry) => {
      const absolute = path.join(root, entry.name);
      return entry.isDirectory()
        ? containsTest(absolute)
        : entry.isFile() && entry.name.endsWith(".test.js");
    });
  }
  return fs.readdirSync(testsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((suite) => {
      const scriptsDir = path.join(testsDir, suite, "scripts");
      return containsTest(scriptsDir);
    })
    .sort();
}

test("CI suite matrix exactly covers every filesystem test suite", () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH), `workflow file is missing: ${WORKFLOW_PATH}`);
  const workflow = fs.readFileSync(WORKFLOW_PATH, "utf-8");
  assert.match(workflow, /shopt -s (?:nullglob globstar|globstar nullglob)/);
  assert.match(workflow, /tests\/\$\{\{\s*matrix\.suite\s*\}\}\/scripts\/\*\*\/\*\.test\.js/);
  const matrices = extractSuiteMatrices(workflow);
  assert.equal(matrices.length, 1, "workflow must define exactly one matrix.suite list");

  const matrixSuites = matrices[0];
  const duplicateSuites = matrixSuites.filter((suite, index) => matrixSuites.indexOf(suite) !== index);
  assert.deepEqual(duplicateSuites, [], `matrix contains duplicate suites: ${duplicateSuites.join(", ")}`);

  const filesystemSuites = discoverTestSuites();
  const missingFromMatrix = filesystemSuites.filter((suite) => !matrixSuites.includes(suite));
  const missingFromFilesystem = matrixSuites.filter((suite) => !filesystemSuites.includes(suite));

  assert.deepEqual(
    { missingFromMatrix, missingFromFilesystem },
    { missingFromMatrix: [], missingFromFilesystem: [] },
    [
      "CI suite matrix diverges from tests/*/scripts/*.test.js:",
      `missing from matrix: ${missingFromMatrix.join(", ") || "(none)"}`,
      `missing from filesystem: ${missingFromFilesystem.join(", ") || "(none)"}`,
    ].join("\n"),
  );

  assert.match(workflow, /- suite: relay-dispatch\s+runner: macos-latest/);
  assert.match(workflow, /- suite: relay-merge\s+runner: macos-latest/);
});
