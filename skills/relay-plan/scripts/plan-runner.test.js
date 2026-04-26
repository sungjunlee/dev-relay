const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "plan-runner.js");
const { applyPlannerPostProcessing } = require("./plan-runner");

function writeExecutable(dir, name, body) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-runner-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Plan Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-plan@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "relay plan\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return repoRoot;
}

function writeFakeGh(dir, issueBody) {
  return writeExecutable(dir, "gh", `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "view" && args.includes("--json") && args.includes("-q")) {
  process.stdout.write(${JSON.stringify(issueBody)});
  process.exit(0);
}
process.stderr.write("unsupported gh invocation: " + args.join(" "));
process.exit(1);
`);
}

function writeFakeCodex(dir, { logPath, fail = false } = {}) {
  return writeExecutable(dir, "fake-codex.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, cwd: process.cwd() }), "utf-8");
if (${JSON.stringify(fail)}) {
  process.stderr.write("simulated planner failure\\n");
  process.exit(7);
}
const outIndex = args.indexOf("-o");
const resultPath = outIndex !== -1 ? args[outIndex + 1] : null;
if (!resultPath) process.exit(2);
fs.writeFileSync(resultPath, JSON.stringify({
  rubric_yaml: "rubric:\\n  factors:\\n    - name: CLI behavior\\n      tier: contract\\n",
  dispatch_prompt_md: "# Dispatch\\n\\nBuild the standalone planner.",
  planner_notes_md: "# Notes\\n\\nSimplified HOW into WHAT.",
}) + "\\n", "utf-8");
`);
}

function runPlanRunner({ repoRoot, outDir, fakeDir, fakeCodex, relayHome }) {
  return execFileSync(process.execPath, [
    SCRIPT,
    "--issue", "291",
    "--planner", "codex",
    "--repo", repoRoot,
    "--out-dir", outDir,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      PATH: `${fakeDir}${path.delimiter}${process.env.PATH}`,
      RELAY_CODEX_BIN: fakeCodex,
      RELAY_HOME: relayHome,
    },
  });
}

test("plan-runner writes all three artifacts on adapter success", () => {
  const repoRoot = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-runner-fakes-"));
  const outDir = path.join(repoRoot, "planner-out");
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-runner-home-"));
  const codexLogPath = path.join(fakeDir, "codex-log.json");
  writeFakeGh(fakeDir, [
    "## Decision: proceeding to build now",
    "",
    "## Scope for this PR",
    "",
    "Ship opt-in planner isolation.",
  ].join("\n"));
  const fakeCodex = writeFakeCodex(fakeDir, { logPath: codexLogPath });

  const stdout = runPlanRunner({ repoRoot, outDir, fakeDir, fakeCodex, relayHome });

  const result = JSON.parse(stdout);
  assert.equal(result.issue, 291);
  assert.equal(result.planner, "codex");
  assert.equal(fs.readFileSync(path.join(outDir, "rubric.yaml"), "utf-8"), "rubric:\n  factors:\n    - name: CLI behavior\n      tier: contract\n");
  assert.equal(fs.readFileSync(path.join(outDir, "dispatch-prompt.md"), "utf-8"), "# Dispatch\n\nBuild the standalone planner.\n");
  assert.equal(fs.readFileSync(path.join(outDir, "planner-notes.md"), "utf-8"), "# Notes\n\nSimplified HOW into WHAT.\n");
  assert.deepEqual(result.artifacts, {
    rubric_yaml: path.join(outDir, "rubric.yaml"),
    dispatch_prompt_md: path.join(outDir, "dispatch-prompt.md"),
    planner_notes_md: path.join(outDir, "planner-notes.md"),
  });

  const codexLog = JSON.parse(fs.readFileSync(codexLogPath, "utf-8"));
  const prompt = codexLog.args.at(-1);
  assert.match(prompt, /<task-content source="issue-body">/);
  assert.match(prompt, /Ship opt-in planner isolation\./);
  assert.match(prompt, /<task-content source="reliability-signal">/);
  assert.match(prompt, /<task-content source="probe-signal">/);
});

test("plan-runner fails clearly when --issue is missing and writes no artifacts", () => {
  const repoRoot = setupRepo();
  const outDir = path.join(repoRoot, "planner-out");

  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--planner", "codex",
    "--repo", repoRoot,
    "--out-dir", outDir,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--issue is required/);
  assert.equal(fs.existsSync(outDir), false);
});

test("plan-runner propagates adapter failure and writes no partial artifacts", () => {
  const repoRoot = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-runner-failing-fakes-"));
  const outDir = path.join(repoRoot, "planner-out");
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-runner-home-"));
  writeFakeGh(fakeDir, "## Decision: proceeding to build now\n\n## Scope for this PR\n\nBuild it.\n");
  const fakeCodex = writeFakeCodex(fakeDir, {
    logPath: path.join(fakeDir, "codex-log.json"),
    fail: true,
  });

  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--issue", "291",
    "--planner", "codex",
    "--repo", repoRoot,
    "--out-dir", outDir,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      PATH: `${fakeDir}${path.delimiter}${process.env.PATH}`,
      RELAY_CODEX_BIN: fakeCodex,
      RELAY_HOME: relayHome,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Planner adapter failed/);
  assert.match(result.stderr, /simulated planner failure/);
  assert.equal(fs.existsSync(path.join(outDir, "rubric.yaml")), false);
  assert.equal(fs.existsSync(path.join(outDir, "dispatch-prompt.md")), false);
  assert.equal(fs.existsSync(path.join(outDir, "planner-notes.md")), false);
});

test("planner post-processing emits Step 0a when rubric has tdd_anchor", () => {
  const processed = applyPlannerPostProcessing({
    rubric_yaml: [
      "rubric:",
      "  factors:",
      "    - name: Calculator adds numbers",
      "      tier: contract",
      "      type: automated",
      "      command: \"node --test tests/calculator.test.js\"",
      "      target: \"exit 0\"",
      "      tdd_anchor: \"tests/calculator.test.js\"",
    ].join("\n"),
    dispatch_prompt_md: [
      "# Dispatch",
      "",
      "LOOP (max 5 iterations):",
      "  0. PREREQUISITE GATE: Run all prerequisite checks.",
    ].join("\n"),
    planner_notes_md: "# Notes\n",
  }, JSON.stringify({ test_infra: [{ name: "node:test" }] }));

  assert.match(processed.dispatch_prompt_md, /0a\. TDD RED ANCHOR STEP/);
  assert.match(processed.dispatch_prompt_md, /`tests\/calculator\.test\.js` via `node:test`/);
  assert.ok(
    processed.dispatch_prompt_md.indexOf("0a. TDD RED ANCHOR STEP") <
    processed.dispatch_prompt_md.indexOf("  0. PREREQUISITE GATE")
  );
});
