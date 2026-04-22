const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CODEX_SCRIPT = path.join(__dirname, "invoke-reviewer-codex.js");
const CLAUDE_SCRIPT = path.join(__dirname, "invoke-reviewer-claude.js");

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-adapter-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "ok\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const promptPath = path.join(repoRoot, "prompt.md");
  fs.writeFileSync(promptPath, "Return a passing review.\n", "utf-8");
  return { repoRoot, promptPath };
}

function writeExecutable(dir, name, body) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

test("codex adapter uses result file output and forwards isolation flags", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-codex-"));
  const logPath = path.join(fakeDir, "codex-args.log");
  const schemaCapturePath = path.join(fakeDir, "review-schema.json");
  const fakeCodex = writeExecutable(fakeDir, "fake-codex.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, args.join("\\n") + "\\n", "utf-8");
const schemaIndex = args.indexOf("--output-schema");
const schemaPath = schemaIndex !== -1 ? args[schemaIndex + 1] : null;
if (schemaPath) {
  fs.copyFileSync(schemaPath, ${JSON.stringify(schemaCapturePath)});
}
const outIndex = args.indexOf("-o");
const resultPath = outIndex !== -1 ? args[outIndex + 1] : null;
if (!resultPath) process.exit(2);
fs.writeFileSync(resultPath, JSON.stringify({
  verdict: "pass",
  summary: "Looks good.",
  contract_status: "pass",
  quality_review_status: "pass",
  next_action: "ready_to_merge",
  issues: [],
  rubric_scores: [],
  scope_drift: { creep: [], missing: [] },
}) + "\\n", "utf-8");
`);

  const stdout = execFileSync("node", [
    CODEX_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_CODEX_BIN: fakeCodex },
  });

  const result = JSON.parse(stdout);
  const loggedArgs = fs.readFileSync(logPath, "utf-8");
  const schema = JSON.parse(fs.readFileSync(schemaCapturePath, "utf-8"));
  assert.equal(result.verdict, "pass");
  assert.match(loggedArgs, /--ephemeral/);
  assert.match(loggedArgs, /--sandbox\nread-only/);
  assert.match(loggedArgs, /--output-schema/);
  assert.equal(schema.properties.quality_execution_status.enum.includes("missing"), true);
  assert.equal(schema.required.includes("quality_execution_status"), false);
  assert.deepEqual(schema.properties.rubric_scores.items.required, [
    "factor",
    "target",
    "observed",
    "status",
    "tier",
    "notes",
  ]);
});

test("codex adapter can recover from a non-zero exit when result file is present", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-codex-fail-"));
  const fakeCodex = writeExecutable(fakeDir, "fake-codex.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const outIndex = args.indexOf("-o");
const resultPath = outIndex !== -1 ? args[outIndex + 1] : null;
fs.writeFileSync(resultPath, JSON.stringify({
  verdict: "pass",
  summary: "Recovered.",
  contract_status: "pass",
  quality_review_status: "pass",
  next_action: "ready_to_merge",
  issues: [],
  rubric_scores: [],
  scope_drift: { creep: [], missing: [] },
}) + "\\n", "utf-8");
process.stderr.write("simulated failure\\n");
process.exit(1);
`);

  const stdout = execFileSync("node", [
    CODEX_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_CODEX_BIN: fakeCodex },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.summary, "Recovered.");
});

test("claude adapter keeps the prompt separate from allowed tools", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-claude-"));
  const logPath = path.join(fakeDir, "claude-args.log");
  const fakeClaude = writeExecutable(fakeDir, "fake-claude.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, args.join("\\n") + "\\n", "utf-8");
process.stdout.write(JSON.stringify({
  verdict: "pass",
  summary: "Looks good.",
  contract_status: "pass",
  quality_review_status: "pass",
  next_action: "ready_to_merge",
  issues: [],
  rubric_scores: [],
  scope_drift: { creep: [], missing: [] },
}));
`);

  const stdout = execFileSync("node", [
    CLAUDE_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_CLAUDE_BIN: fakeClaude },
  });

  const result = JSON.parse(stdout);
  const loggedArgs = fs.readFileSync(logPath, "utf-8");
  assert.equal(result.verdict, "pass");
  assert.match(loggedArgs, /--bare/);
  assert.match(loggedArgs, /--no-session-persistence/);
  assert.match(loggedArgs, /--allowedTools=Read/);
  assert.match(loggedArgs, /Return a passing review\./);
});

test("claude adapter fails fast with an auth setup error before JSON parsing", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-claude-auth-"));
  const fakeClaude = writeExecutable(fakeDir, "fake-claude.js", `#!/usr/bin/env node
process.stdout.write("Not logged in · Please run /login\\n");
process.exit(1);
`);

  let error;
  try {
    execFileSync("node", [
      CLAUDE_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, RELAY_CLAUDE_BIN: fakeClaude },
    });
    assert.fail("expected invoke-reviewer-claude.js to fail");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.notEqual(error.status, 0);
  const stderr = String(error.stderr || "");
  assert.match(stderr, /not authenticated/i);
  assert.match(stderr, /ANTHROPIC_API_KEY|claude login --api-key/);
  assert.doesNotMatch(stderr, /did not return valid JSON/);
});
