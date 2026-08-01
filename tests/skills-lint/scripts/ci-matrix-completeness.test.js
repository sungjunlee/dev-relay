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

function extractSuiteRunnerEntries(content) {
  const lines = content.split(/\r\n|\n|\r/);
  const includeIndex = lines.findIndex((line) => line.trim() === "include:");
  assert.notEqual(includeIndex, -1, "workflow matrix must use explicit include entries");
  const includeIndent = indentation(lines[includeIndex]);
  const entries = [];
  for (let index = includeIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (indentation(line) <= includeIndent) break;
    const suiteMatch = trimmed.match(/^-\s+suite:\s+([a-z0-9]+(?:-[a-z0-9]+)*)$/);
    if (!suiteMatch) continue;
    const entryIndent = indentation(line);
    const runners = [];
    for (let fieldIndex = index + 1; fieldIndex < lines.length; fieldIndex += 1) {
      const fieldLine = lines[fieldIndex];
      const field = fieldLine.trim();
      if (field === "" || field.startsWith("#")) continue;
      if (indentation(fieldLine) <= entryIndent) break;
      const runnerMatch = field.match(/^runner:\s+([a-z0-9-]+)$/);
      if (runnerMatch) runners.push(runnerMatch[1]);
    }
    assert.equal(runners.length, 1, `${suiteMatch[1]} must declare exactly one runner`);
    entries.push({ suite: suiteMatch[1], runner: runners[0] });
  }
  return entries;
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
  assert.match(workflow, /find "tests\/\$\{\{\s*matrix\.suite\s*\}\}\/scripts" -type f -name '\*\.test\.js'/);
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

  assert.deepEqual(extractSuiteRunnerEntries(workflow), [
    { suite: "relay-ready", runner: "ubuntu-latest" },
    { suite: "relay-plan", runner: "ubuntu-latest" },
    { suite: "relay-dispatch", runner: "macos-latest" },
    { suite: "relay-review", runner: "ubuntu-latest" },
    { suite: "relay-merge", runner: "macos-latest" },
    { suite: "relay", runner: "ubuntu-latest" },
    { suite: "relay-config", runner: "ubuntu-latest" },
    { suite: "relay-fleet", runner: "ubuntu-latest" },
    { suite: "skills-lint", runner: "ubuntu-latest" },
  ]);
});
