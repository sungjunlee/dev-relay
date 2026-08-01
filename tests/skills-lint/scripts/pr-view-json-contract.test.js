const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  comparePrViewCallSites,
  extractPrViewCallSites,
  extractPrViewCallSitesFromDirectory,
} = require("./pr-view-json-contract");
const { PR_VIEW_JSON_REGISTRY } = require("../../relay-review/fixtures/fake-gh");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const FIXTURE_PATH = path.join(REPO_ROOT, "tests", "relay-review", "fixtures", "fake-gh.js");

test("every production gh pr view JSON field list is accepted by fake-gh", () => {
  const callSites = extractPrViewCallSitesFromDirectory(SKILLS_DIR);
  const errors = comparePrViewCallSites(callSites, PR_VIEW_JSON_REGISTRY, FIXTURE_PATH);
  assert.ok(callSites.length > 0, "expected to find production gh pr view call sites");
  assert.deepEqual(errors, [], errors.join("\n"));
});

test("reports non-literal JSON field values at pr view call sites", () => {
  const callSites = extractPrViewCallSites(
    'execGh(repo, ["pr", "view", "1", "--json", fields]);',
    "skills/example.js",
  );
  const errors = comparePrViewCallSites(callSites, PR_VIEW_JSON_REGISTRY, FIXTURE_PATH);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /skills\/example\.js:1 has a non-literal/);
  assert.match(errors[0], /fake-gh\.js/);
});

test("reports non-literal JSON fields after bracket-valued argv strings", () => {
  for (const bracket of ["]", "["]) {
    const callSites = extractPrViewCallSites(
      `execGh(repo, ["pr", "view", ${JSON.stringify(bracket)}, "--json", fields]);`,
      "skills/example.js",
    );
    const errors = comparePrViewCallSites(callSites, PR_VIEW_JSON_REGISTRY, FIXTURE_PATH);
    assert.equal(callSites.length, 1, bracket);
    assert.equal(errors.length, 1, bracket);
    assert.match(errors[0], /skills\/example\.js:1 has a non-literal/, bracket);
  }
});

test("reports literal-looking compound JSON field expressions as non-literal", () => {
  for (const expression of [
    '"body" + suffix',
    '"body" ? preferred : fallback',
    '"body".trim()',
  ]) {
    const callSites = extractPrViewCallSites(
      `execGh(repo, ["pr", "view", "1", "--json", ${expression}]);`,
      "skills/example.js",
    );
    const errors = comparePrViewCallSites(callSites, PR_VIEW_JSON_REGISTRY, FIXTURE_PATH);
    assert.equal(errors.length, 1, expression);
    assert.match(errors[0], /skills\/example\.js:1 has a non-literal/, expression);
    assert.match(errors[0], /compound expression/, expression);
  }
});

test("enumerates pr view fields from an argv variable assembled separately", () => {
  const callSites = extractPrViewCallSites(
    `const args = [
      "pr", "view", String(prNumber),
      "--json", "number,headRefName,headRefOid",
    ];
    execGhJson(repoRoot, args);`,
    "skills/example.js",
  );
  assert.deepEqual(callSites, [{
    file: "skills/example.js",
    line: 2,
    fields: "number,headRefName,headRefOid",
    valueDescription: 'string "number,headRefName,headRefOid"',
  }]);
});

test("vNext regression: missing exact merge-observation fields names finalize-run", () => {
  const finalizeFields = "number,state,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner,mergeCommit,autoMergeRequest,mergeStateStatus";
  const registryWithoutFinalizeFields = Object.fromEntries(
    Object.entries(PR_VIEW_JSON_REGISTRY).filter(([fields]) => fields !== finalizeFields),
  );
  const callSites = extractPrViewCallSitesFromDirectory(SKILLS_DIR);
  const errors = comparePrViewCallSites(callSites, registryWithoutFinalizeFields, FIXTURE_PATH);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /skills\/relay-merge\/scripts\/finalize-run\.js:\d+/);
  assert.match(errors[0], new RegExp(finalizeFields));
  assert.match(errors[0], /tests\/relay-review\/fixtures\/fake-gh\.js/);
});
