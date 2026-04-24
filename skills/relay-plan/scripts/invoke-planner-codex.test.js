const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "invoke-planner-codex.js");

function writeExecutable(dir, name, body) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writePrompt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-codex-prompt-"));
  const promptPath = path.join(dir, "prompt.md");
  fs.writeFileSync(promptPath, "Return planner artifacts.\n", "utf-8");
  return promptPath;
}

test("codex planner adapter writes schema-constrained JSON from the result file", () => {
  const promptPath = writePrompt();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-fake-codex-"));
  const logPath = path.join(fakeDir, "codex-log.json");
  const schemaCapturePath = path.join(fakeDir, "planner-schema.json");
  const fakeCodex = writeExecutable(fakeDir, "fake-codex.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, cwd: process.cwd() }), "utf-8");
const schemaIndex = args.indexOf("--output-schema");
if (schemaIndex !== -1) fs.copyFileSync(args[schemaIndex + 1], ${JSON.stringify(schemaCapturePath)});
const outIndex = args.indexOf("-o");
const resultPath = outIndex !== -1 ? args[outIndex + 1] : null;
if (!resultPath) process.exit(2);
fs.writeFileSync(resultPath, JSON.stringify({
  rubric_yaml: "rubric:\\n",
  dispatch_prompt_md: "# Dispatch\\n",
  planner_notes_md: "# Notes\\n",
}) + "\\n", "utf-8");
`);

  const stdout = execFileSync(process.execPath, [SCRIPT, "--prompt-file", promptPath, "--json"], {
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_CODEX_BIN: fakeCodex },
  });

  const result = JSON.parse(stdout);
  const log = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  const schema = JSON.parse(fs.readFileSync(schemaCapturePath, "utf-8"));
  assert.deepEqual(result, {
    rubric_yaml: "rubric:\n",
    dispatch_prompt_md: "# Dispatch\n",
    planner_notes_md: "# Notes\n",
  });
  assert.ok(log.args.includes("exec"));
  assert.ok(log.args.includes("--skip-git-repo-check"));
  assert.ok(log.args.includes("--ephemeral"));
  assert.ok(log.args.includes("--full-auto"));
  assert.deepEqual(log.args.slice(log.args.indexOf("--sandbox"), log.args.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"]);
  assert.deepEqual(log.args.slice(log.args.indexOf("--color"), log.args.indexOf("--color") + 2), ["--color", "never"]);
  assert.match(log.args.at(-1), /Return planner artifacts\./);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["rubric_yaml", "dispatch_prompt_md", "planner_notes_md"]);
});

test("codex planner adapter propagates CLI failure when no result file is produced", () => {
  const promptPath = writePrompt();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-fake-codex-fail-"));
  const fakeCodex = writeExecutable(fakeDir, "fake-codex.js", `#!/usr/bin/env node
process.stderr.write("codex failed hard\\n");
process.exit(9);
`);

  const result = spawnSync(process.execPath, [SCRIPT, "--prompt-file", promptPath, "--json"], {
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_CODEX_BIN: fakeCodex },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Codex planner failed/);
  assert.match(result.stderr, /codex failed hard/);
});
