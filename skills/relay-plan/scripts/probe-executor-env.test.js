const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { deriveTestInfra, scanProjectTools, probeAgent } = require("./probe-executor-env");

const SCRIPT = path.join(__dirname, "probe-executor-env.js");

// ---------------------------------------------------------------------------
// scanProjectTools
// ---------------------------------------------------------------------------

test("scanProjectTools extracts scripts and frameworks from package.json", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-pkg-"));
  fs.writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({
    scripts: { test: "jest", lint: "eslint .", build: "tsc" },
    devDependencies: { jest: "^29.0.0", eslint: "^8.0.0", playwright: "^1.40.0" },
  }), "utf-8");

  const result = scanProjectTools(repoRoot);

  assert.equal(result.scripts.length, 3);
  assert.ok(result.scripts.some((s) => s.name === "npm run test"));
  assert.ok(result.scripts.some((s) => s.name === "npm run lint"));

  assert.ok(result.frameworks.some((f) => f.name === "jest"));
  assert.ok(result.frameworks.some((f) => f.name === "eslint"));
  assert.ok(result.frameworks.some((f) => f.name === "playwright"));
});

test("scanProjectTools extracts Makefile targets", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-make-"));
  fs.writeFileSync(path.join(repoRoot, "Makefile"), [
    "test:",
    "\tpytest",
    "lint:",
    "\truff check .",
    "build: test lint",
    "\tdocker build .",
  ].join("\n"), "utf-8");

  const result = scanProjectTools(repoRoot);
  assert.ok(result.scripts.some((s) => s.name === "make test"));
  assert.ok(result.scripts.some((s) => s.name === "make lint"));
  assert.ok(result.scripts.some((s) => s.name === "make build"));
});

test("scanProjectTools extracts pyproject.toml tools", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-py-"));
  fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), [
    "[tool.pytest.ini_options]",
    "testpaths = [\"tests\"]",
    "",
    "[tool.mypy]",
    "strict = true",
    "",
    "[tool.ruff]",
    "line-length = 88",
  ].join("\n"), "utf-8");

  const result = scanProjectTools(repoRoot);
  assert.ok(result.frameworks.some((f) => f.name === "pytest"));
  assert.ok(result.frameworks.some((f) => f.name === "mypy"));
  assert.ok(result.frameworks.some((f) => f.name === "ruff"));
});

test("scanProjectTools detects GitHub Actions workflows", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-ci-"));
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(path.join(workflowsDir, "ci.yml"), "name: CI\n", "utf-8");
  fs.writeFileSync(path.join(workflowsDir, "nightly.yaml"), "name: Nightly\n", "utf-8");

  const result = scanProjectTools(repoRoot);
  assert.deepEqual(result.ci, [
    { name: "ci.yml", source: ".github/workflows" },
    { name: "nightly.yaml", source: ".github/workflows" },
  ]);
});

test("scanProjectTools handles missing files gracefully", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-empty-"));
  const result = scanProjectTools(repoRoot);
  assert.deepEqual(result.scripts, []);
  assert.deepEqual(result.frameworks, []);
  assert.deepEqual(result.ci, []);
});

test("scanProjectTools handles malformed package.json gracefully", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-bad-"));
  fs.writeFileSync(path.join(repoRoot, "package.json"), "{broken", "utf-8");
  const result = scanProjectTools(repoRoot);
  assert.deepEqual(result.scripts, []);
  assert.deepEqual(result.frameworks, []);
  assert.deepEqual(result.ci, []);
});

test("scanProjectTools merges results from package.json + Makefile + pyproject.toml", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-multi-"));
  fs.writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({
    scripts: { test: "jest" },
    devDependencies: { jest: "^29.0.0" },
  }), "utf-8");
  fs.writeFileSync(path.join(repoRoot, "Makefile"), "lint:\n\truff check .\n", "utf-8");
  fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[tool.pytest.ini_options]\n", "utf-8");

  const result = scanProjectTools(repoRoot);
  assert.ok(result.scripts.some((s) => s.name === "npm run test" && s.source === "package.json"));
  assert.ok(result.scripts.some((s) => s.name === "make lint" && s.source === "Makefile"));
  assert.ok(result.frameworks.some((f) => f.name === "jest" && f.source === "package.json"));
  assert.ok(result.frameworks.some((f) => f.name === "pytest" && f.source === "pyproject.toml"));
  assert.deepEqual(result.ci, []);
});

test("deriveTestInfra exposes runner candidates for TDD fallback", () => {
  const projectTools = {
    scripts: [{ name: "npm run test", command: "node --test tests/*.test.js", source: "package.json" }],
    frameworks: [{ name: "jest", source: "package.json" }, { name: "eslint", source: "package.json" }],
    ci: [],
  };

  assert.deepEqual(deriveTestInfra(projectTools), [
    { name: "jest", source: "package.json" },
    { name: "npm run test", command: "node --test tests/*.test.js", source: "package.json" },
  ]);
});

// ---------------------------------------------------------------------------
// probeAgent (raw text pass-through, no parsing)
// ---------------------------------------------------------------------------

test("probeAgent returns raw text from a fake codex executor", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-fakecodex-"));
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("codex-fake\\n"); process.exit(0); }
process.stdout.write('[{"name":"/browse","type":"skill","description":"Headless browser"}]\\n');
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
  try {
    const result = probeAgent("codex", 10);
    assert.equal(result.error, null);
    assert.ok(result.raw);
    assert.match(result.raw, /\/browse/);
    assert.match(result.raw, /skill/);
  } finally {
    process.env.PATH = origPath;
  }
});

test("probeAgent returns error for unknown executor", () => {
  const result = probeAgent("unknown-executor", 5);
  assert.ok(result.error);
  assert.match(result.error, /unknown executor/);
  assert.equal(result.raw, null);
});

// ---------------------------------------------------------------------------
// CLI integration
// ---------------------------------------------------------------------------

test("CLI --project-only works without executor", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-cli-"));
  fs.writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({
    scripts: { test: "jest" },
    devDependencies: { jest: "^29.0.0" },
  }), "utf-8");

  const result = spawnSync("node", [SCRIPT, repoRoot, "--project-only", "--json"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.executor, null);
  assert.ok(output.test_infra.some((entry) => entry.name === "jest"));
  assert.ok(output.test_infra.some((entry) => entry.name === "npm run test"));
  assert.ok(output.project_tools.scripts.some((s) => s.name === "npm run test"));
  assert.ok(output.project_tools.frameworks.some((f) => f.name === "jest"));
  assert.deepEqual(output.project_tools.ci, []);
});

test("CLI requires --executor when not --project-only", () => {
  const result = spawnSync("node", [SCRIPT, "."], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--executor is required/);
});

test("CLI rejects invalid timeout", () => {
  const result = spawnSync("node", [SCRIPT, ".", "-e", "codex", "--timeout", "abc"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--timeout must be a positive integer/);
});

test("CLI handles missing executor gracefully", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-noexec-"));
  const nodeBin = path.dirname(process.execPath);
  const result = spawnSync("node", [SCRIPT, repoRoot, "-e", "codex", "--json"], {
    encoding: "utf-8",
    stdio: "pipe",
    env: { HOME: os.homedir(), PATH: nodeBin },
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.ok(output.agent_probe_error);
  assert.equal(output.agent_tools_raw, null);
});
