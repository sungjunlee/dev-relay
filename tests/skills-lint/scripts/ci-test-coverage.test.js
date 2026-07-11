"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const TESTS_DIR = path.join(REPO_ROOT, "tests");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "test.yml");

function listSkillDirs(skillsDir = SKILLS_DIR) {
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function hasTestSuite(skill, testsDir = TESTS_DIR) {
  const scriptsDir = path.join(testsDir, skill, "scripts");
  if (!fs.existsSync(scriptsDir)) return false;
  return fs.readdirSync(scriptsDir).some((file) => file.endsWith(".test.js"));
}

// The workflow guards CI with two skill-glob lists: the empty-glob guard array
// (files=( ... )) and the `node --test` run command. A skill's test glob must
// appear in BOTH — omission from either lets a newly installed skill's tests be
// silently skipped by CI.
function workflowGlobRegions(content) {
  const guardMatch = content.match(/files=\(([\s\S]*?)\)/);
  assert.ok(guardMatch, "workflow must declare an empty-glob guard: files=( ... )");
  const runMatch = content.match(/Run test suites[\s\S]*$/);
  assert.ok(runMatch, "workflow must declare a 'Run test suites' step");
  return { guard: guardMatch[1], run: runMatch[0] };
}

function findSkillSuitesMissingFromCi({ skillsDir = SKILLS_DIR, testsDir = TESTS_DIR, workflow } = {}) {
  const { guard, run } = workflowGlobRegions(workflow);
  const missing = [];
  listSkillDirs(skillsDir).forEach((skill) => {
    if (!hasTestSuite(skill, testsDir)) return;
    const glob = `tests/${skill}/scripts/*.test.js`;
    if (!guard.includes(glob)) missing.push(`${glob} (missing from empty-glob guard)`);
    if (!run.includes(glob)) missing.push(`${glob} (missing from run command)`);
  });
  return missing.sort();
}

function assertSkillSuitesWiredIntoCi(options = {}) {
  const missing = findSkillSuitesMissingFromCi(options);
  assert.deepEqual(
    missing,
    [],
    `skill test suites not referenced in .github/workflows/test.yml:\n${missing.map((entry) => `- ${entry}`).join("\n")}`,
  );
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function buildFixture({ wired }) {
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-coverage-skills-"));
  const testsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-coverage-tests-"));
  writeFile(path.join(skillsDir, "newskill", "SKILL.md"), "fixture\n");
  writeFile(path.join(testsDir, "newskill", "scripts", "example.test.js"), "// fixture\n");
  const suiteGlob = wired ? "\n            tests/newskill/scripts/*.test.js" : "";
  const runGlob = wired ? "\n          tests/newskill/scripts/*.test.js" : "";
  const workflow = [
    "      - name: Guard against empty test globs",
    "        run: |",
    "          files=(",
    "            tests/skills-lint/scripts/*.test.js" + suiteGlob,
    "          )",
    "      - name: Run test suites",
    "        run: >",
    "          node --test --test-concurrency=1",
    "          tests/skills-lint/scripts/*.test.js" + runGlob,
    "",
  ].join("\n");
  return { skillsDir, testsDir, workflow };
}

test("every skill with a tests/<skill>/scripts suite is wired into the CI workflow (both lists)", () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH), ".github/workflows/test.yml is missing");
  const workflow = fs.readFileSync(WORKFLOW_PATH, "utf-8");
  assertSkillSuitesWiredIntoCi({ workflow });
});

test("guard passes when a skill's suite is present in both workflow lists", () => {
  const { skillsDir, testsDir, workflow } = buildFixture({ wired: true });
  try {
    assertSkillSuitesWiredIntoCi({ skillsDir, testsDir, workflow });
  } finally {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    fs.rmSync(testsDir, { recursive: true, force: true });
  }
});

test("guard flags a skill whose test suite is omitted from the workflow", () => {
  const { skillsDir, testsDir, workflow } = buildFixture({ wired: false });
  try {
    assert.throws(
      () => assertSkillSuitesWiredIntoCi({ skillsDir, testsDir, workflow }),
      /tests\/newskill\/scripts\/\*\.test\.js/,
    );
    const missing = findSkillSuitesMissingFromCi({ skillsDir, testsDir, workflow });
    assert.deepEqual(missing, [
      "tests/newskill/scripts/*.test.js (missing from empty-glob guard)",
      "tests/newskill/scripts/*.test.js (missing from run command)",
    ]);
  } finally {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    fs.rmSync(testsDir, { recursive: true, force: true });
  }
});
