const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "invoke-planner-claude.js");

function writeExecutable(dir, name, body) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writePrompt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-claude-prompt-"));
  const promptPath = path.join(dir, "prompt.md");
  fs.writeFileSync(promptPath, "Return claude planner artifacts.\n", "utf-8");
  return promptPath;
}

test("claude planner adapter returns JSON and forwards non-interactive flags", () => {
  const promptPath = writePrompt();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-fake-claude-"));
  const logPath = path.join(fakeDir, "claude-log.json");
  const fakeClaude = writeExecutable(fakeDir, "fake-claude.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, cwd: process.cwd() }), "utf-8");
process.stdout.write(JSON.stringify({
  rubric_yaml: "rubric:\\n",
  dispatch_prompt_md: "# Dispatch\\n",
  planner_notes_md: "# Notes\\n",
}));
`);

  const stdout = execFileSync(process.execPath, [SCRIPT, "--prompt-file", promptPath, "--json"], {
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_CLAUDE_BIN: fakeClaude },
  });

  const result = JSON.parse(stdout);
  const log = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  assert.deepEqual(result, {
    rubric_yaml: "rubric:\n",
    dispatch_prompt_md: "# Dispatch\n",
    planner_notes_md: "# Notes\n",
  });
  assert.ok(log.args.includes("-p"));
  assert.ok(log.args.includes("--dangerously-skip-permissions"));
  assert.ok(log.args.includes("--no-session-persistence"));
  assert.deepEqual(log.args.slice(log.args.indexOf("--output-format"), log.args.indexOf("--output-format") + 2), ["--output-format", "text"]);
  assert.ok(log.args.includes("--json-schema"));
  assert.deepEqual(log.args.slice(log.args.indexOf("--tools"), log.args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.match(log.args.at(-1), /Return claude planner artifacts\./);
});

test("claude planner adapter propagates CLI failure without stdout", () => {
  const promptPath = writePrompt();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plan-fake-claude-fail-"));
  const fakeClaude = writeExecutable(fakeDir, "fake-claude.js", `#!/usr/bin/env node
process.stderr.write("claude failed hard\\n");
process.exit(5);
`);

  const result = spawnSync(process.execPath, [SCRIPT, "--prompt-file", promptPath, "--json"], {
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_CLAUDE_BIN: fakeClaude },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Claude planner failed/);
  assert.match(result.stderr, /claude failed hard/);
});
