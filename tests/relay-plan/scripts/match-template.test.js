const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  bestMatch,
  loadCatalog,
} = require("../../../skills/relay-plan/scripts/match-template");

const MATCHER_SCRIPT = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "skills",
  "relay-plan",
  "scripts",
  "match-template.js"
);
const TEMPLATE_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "skills",
  "relay-plan",
  "references",
  "rubric-templates"
);

function runMatcher(args, input) {
  return spawnSync(process.execPath, [MATCHER_SCRIPT, ...args], {
    encoding: "utf-8",
    input,
    stdio: "pipe",
  });
}

function parseMatcher(args, input) {
  const result = runMatcher(args, input);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("matches jest-tsc-strict from synthesized probe signals", () => {
  const result = bestMatch({
    test_infra: ["jest"],
    type_check: ["typescript"],
    lint_format: [],
  }, loadCatalog());

  assert.equal(result.matched_template, "jest-tsc-strict.yaml");
  assert.ok(result.score > 0);
});

test("matches raw project-only probe file shape", () => {
  const probeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-raw-probe-")), "probe.json");
  fs.writeFileSync(probeFile, JSON.stringify({
    executor: null,
    repo: "/tmp/example",
    agent_tools_raw: null,
    agent_probe_error: null,
    test_infra: [{ name: "jest", source: "package.json" }],
    project_tools: {
      frameworks: [
        { name: "typescript", source: "package.json" },
        { name: "eslint", source: "package.json" },
      ],
      scripts: [
        { name: "npm run test", command: "jest", source: "package.json" },
        { name: "npm run typecheck", command: "tsc --noEmit", source: "package.json" },
      ],
      ci: [],
    },
  }), "utf-8");

  const result = parseMatcher(["--probe-file", probeFile, "--json"]);

  assert.equal(result.matched_template, "jest-tsc-strict.yaml");
  assert.ok(result.score > 0);
});

test("matches pytest-mypy-strict from synthesized probe signals", () => {
  const result = bestMatch({
    test_infra: ["pytest"],
    type_check: ["mypy"],
    lint_format: [],
  }, loadCatalog());

  assert.equal(result.matched_template, "pytest-mypy-strict.yaml");
  assert.ok(result.score > 0);
});

test("matches go-test from empty probe when repo contains go.mod", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-go-template-"));
  fs.writeFileSync(path.join(repoRoot, "go.mod"), "module example.test/repo\n", "utf-8");

  const result = parseMatcher([
    "--probe-json",
    JSON.stringify({ test_infra: [], type_check: [], lint_format: [] }),
    "--repo",
    repoRoot,
    "--json",
  ]);

  assert.equal(result.matched_template, "go-test.yaml");
  assert.ok(result.score > 0);
});

test("returns null when no template has a positive score", () => {
  const result = bestMatch({
    test_infra: ["junit"],
    type_check: [],
    lint_format: [],
  }, loadCatalog());

  assert.equal(result.matched_template, null);
  assert.equal(result.score, 0);
  assert.equal(result.reason, "no clear match");
});

test("uses _index.json order to break tied scores deterministically", () => {
  const result = bestMatch({
    test_infra: ["jest", "pytest"],
    type_check: [],
    lint_format: [],
  }, loadCatalog());

  assert.equal(result.matched_template, "jest-tsc-strict.yaml");
  assert.equal(result.score, 1);
});

test("template files exist and carry scaffold sentinels", () => {
  for (const file of ["jest-tsc-strict.yaml", "pytest-mypy-strict.yaml", "go-test.yaml"]) {
    const body = fs.readFileSync(path.join(TEMPLATE_DIR, file), "utf-8");
    assert.match(body, /prerequisites:/);
    assert.match(body, /factors:/);
    assert.ok((body.match(/\[fill in:/g) || []).length >= 3, `${file} needs fill-in sentinels`);
  }
});

test("_index.json parses and names existing template files", () => {
  const catalog = loadCatalog();
  assert.ok(catalog.length >= 3);

  for (const entry of catalog) {
    assert.equal(typeof entry.file, "string");
    assert.equal(typeof entry.description, "string");
    assert.equal(typeof entry.signals, "object");
    assert.ok(fs.existsSync(path.join(TEMPLATE_DIR, entry.file)), `${entry.file} should exist`);
  }
});

test("--help exits 0 and prints every supported flag", () => {
  const result = runMatcher(["--help"]);
  assert.equal(result.status, 0, result.stderr);

  for (const flag of ["--probe-file", "--probe-json", "--repo", "--help", "-h", "--json"]) {
    assert.match(result.stdout, new RegExp(flag.replace("-", "\\-")));
  }
});

test("stdin input mode returns the same result as --probe-json", () => {
  const probeJson = JSON.stringify({
    test_infra: ["jest"],
    type_check: ["typescript"],
    lint_format: [],
  });
  const probeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-probe-file-")), "probe.json");
  fs.writeFileSync(probeFile, probeJson, "utf-8");

  const fromArg = parseMatcher(["--probe-json", probeJson, "--json"]);
  const fromFile = parseMatcher(["--probe-file", probeFile, "--json"]);
  const fromStdin = parseMatcher(["--json"], probeJson);

  assert.deepEqual(fromFile, fromArg);
  assert.deepEqual(fromStdin, fromArg);
});
