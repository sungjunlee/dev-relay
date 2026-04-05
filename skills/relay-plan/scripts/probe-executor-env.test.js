const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { scanProjectTools, parseProbeOutput, probeAgent } = require("./probe-executor-env");

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

test("scanProjectTools handles missing files gracefully", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-empty-"));
  const result = scanProjectTools(repoRoot);
  assert.deepEqual(result.scripts, []);
  assert.deepEqual(result.frameworks, []);
});

test("scanProjectTools handles malformed package.json gracefully", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-bad-"));
  fs.writeFileSync(path.join(repoRoot, "package.json"), "{broken", "utf-8");
  const result = scanProjectTools(repoRoot);
  assert.deepEqual(result.scripts, []);
  assert.deepEqual(result.frameworks, []);
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
});

// ---------------------------------------------------------------------------
// parseProbeOutput
// ---------------------------------------------------------------------------

test("parseProbeOutput extracts valid JSON array", () => {
  const output = JSON.stringify([
    { name: "/browse", type: "skill", description: "Browser automation" },
    { name: "mcp:playwright", type: "mcp_tool", description: "Playwright testing" },
  ]);
  const result = parseProbeOutput(output);
  assert.equal(result.error, null);
  assert.equal(result.tools.length, 2);
  assert.equal(result.tools[0].name, "/browse");
  assert.equal(result.tools[1].type, "mcp_tool");
});

test("parseProbeOutput handles noisy output with embedded JSON", () => {
  const output = 'Here are the tools:\n[{"name":"tool1","type":"skill","description":"desc"}]\nDone.';
  const result = parseProbeOutput(output);
  assert.equal(result.error, null);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, "tool1");
});

test("parseProbeOutput filters entries with empty names", () => {
  const output = JSON.stringify([
    { name: "valid", type: "skill", description: "ok" },
    { name: "", type: "skill", description: "empty" },
    { type: "skill", description: "missing name" },
  ]);
  const result = parseProbeOutput(output);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, "valid");
});

test("parseProbeOutput returns error for non-JSON output", () => {
  const result = parseProbeOutput("I don't have any tools to list.");
  assert.ok(result.error);
  assert.equal(result.tools.length, 0);
});

test("parseProbeOutput handles object-wrapped JSON by extracting inner array", () => {
  // '{"tools": []}' contains '[]' which is a valid array — returns empty tools, no error
  const result = parseProbeOutput('{"tools": []}');
  assert.equal(result.error, null);
  assert.equal(result.tools.length, 0);
});

test("parseProbeOutput returns error for plain object with no array", () => {
  const result = parseProbeOutput('{"name": "tool"}');
  assert.ok(result.error);
  assert.equal(result.tools.length, 0);
});

test("parseProbeOutput handles noise before the JSON array", () => {
  const output = 'Here are the available tools:\n[{"name":"a","type":"skill","description":"d"}]\nEnd.';
  const result = parseProbeOutput(output);
  assert.equal(result.error, null);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, "a");
});

test("parseProbeOutput handles brackets inside JSON string values", () => {
  const output = JSON.stringify([
    { name: "tool[1]", type: "skill", description: "has ] bracket" },
  ]);
  const result = parseProbeOutput(output);
  assert.equal(result.error, null);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, "tool[1]");
});

// ---------------------------------------------------------------------------
// probeAgent
// ---------------------------------------------------------------------------

test("probeAgent returns tools from a fake codex executor", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-fakecodex-"));
  const codexPath = path.join(binDir, "codex");
  const toolsJson = JSON.stringify([
    { name: "/browse", type: "skill", description: "Headless browser" },
    { name: "mcp:sequential-thinking", type: "mcp_tool", description: "Step-by-step reasoning" },
  ]);
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("codex-fake\\n"); process.exit(0); }
process.stdout.write(${JSON.stringify(toolsJson)} + "\\n");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
  try {
    const result = probeAgent("codex", 10);
    assert.equal(result.error, null);
    assert.equal(result.tools.length, 2);
    assert.equal(result.tools[0].name, "/browse");
    assert.equal(result.tools[1].type, "mcp_tool");
  } finally {
    process.env.PATH = origPath;
  }
});

test("probeAgent returns error for unknown executor", () => {
  const result = probeAgent("unknown-executor", 5);
  assert.ok(result.error);
  assert.match(result.error, /unknown executor/);
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
  assert.ok(output.project_tools.scripts.some((s) => s.name === "npm run test"));
  assert.ok(output.project_tools.frameworks.some((f) => f.name === "jest"));
});

test("CLI requires --executor when not --project-only", () => {
  const result = spawnSync("node", [SCRIPT, "."], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--executor is required/);
});

test("CLI handles missing executor gracefully", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-noexec-"));
  // Minimal PATH so node works but codex doesn't exist
  const nodeBin = path.dirname(process.execPath);
  const result = spawnSync("node", [SCRIPT, repoRoot, "-e", "codex", "--json"], {
    encoding: "utf-8",
    stdio: "pipe",
    env: { HOME: os.homedir(), PATH: nodeBin },
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.ok(output.agent_probe_error);
  assert.equal(output.agent_tools.length, 0);
});
