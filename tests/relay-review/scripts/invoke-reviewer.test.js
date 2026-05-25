const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CODEX_SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "invoke-reviewer-codex.js");
const CLAUDE_SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "invoke-reviewer-claude.js");
const OPENCODE_SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "invoke-reviewer-opencode.js");
const PI_SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "invoke-reviewer-pi.js");
const ANTIGRAVITY_SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "invoke-reviewer-antigravity.js");

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
  assert.equal(schema.properties.quality_execution_status, undefined);
  assert.equal(schema.required.includes("quality_execution_status"), false);
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    [...schema.required].sort(),
    "codex response_format requires every property key to be in required"
  );
  assert.deepEqual(schema.properties.rubric_scores.items.required, [
    "factor",
    "target",
    "observed",
    "score",
    "target_score",
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

test("claude adapter can recover from a non-zero exit when stdout contains JSON", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-claude-recover-"));
  const fakeClaude = writeExecutable(fakeDir, "fake-claude.js", `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("ping")) {
  process.stdout.write("pong\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  verdict: "pass",
  summary: "Recovered stdout.",
  contract_status: "pass",
  quality_review_status: "pass",
  next_action: "ready_to_merge",
  issues: [],
  rubric_scores: [],
  scope_drift: { creep: [], missing: [] },
}) + "\\n");
process.stderr.write("simulated late failure\\n");
process.exit(1);
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
  assert.equal(result.summary, "Recovered stdout.");
});

test("claude adapter reports adapter and phase when recovered stdout is invalid JSON", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-claude-invalid-"));
  const fakeClaude = writeExecutable(fakeDir, "fake-claude.js", `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("ping")) {
  process.stdout.write("pong\\n");
  process.exit(0);
}
process.stdout.write("not-json\\n");
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
  assert.match(stderr, /adapter=claude phase=primary_review/);
  assert.match(stderr, /review verdict must be valid JSON/);
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

test("opencode adapter forwards model and preserves advisory prompt as one run argument", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-opencode-"));
  const logPath = path.join(fakeDir, "opencode-args.log");
  const fakeOpencode = writeExecutable(fakeDir, "fake-opencode.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, args.join("\\n") + "\\n", "utf-8");
process.stdout.write(JSON.stringify({
  profile: "blindspot",
  summary: "No blocking blind spots.",
  required_findings: [],
  advisory_findings: [],
  duplicate_or_low_confidence: [],
}));
`);

  const stdout = execFileSync("node", [
    OPENCODE_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--model", "opencode-go/deepseek-v4-pro",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_OPENCODE_BIN: fakeOpencode },
  });

  const result = JSON.parse(stdout);
  const loggedArgs = fs.readFileSync(logPath, "utf-8");
  assert.equal(result.profile, "blindspot");
  assert.match(loggedArgs, /^run\n-m\nopencode-go\/deepseek-v4-pro\n/);
  assert.match(loggedArgs, /NON-INTERACTIVE ADVISORY REVIEW/);
  assert.match(loggedArgs, /Return a passing review\./);
});

test("opencode adapter accepts live-style json fenced advisory output", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-opencode-fenced-"));
  const fakeOpencode = writeExecutable(fakeDir, "fake-opencode.js", `#!/usr/bin/env node
process.stdout.write("\`\`\`json\\n" + JSON.stringify({
  profile: "blindspot",
  summary: "No blocking blind spots.",
  required_findings: [],
  advisory_findings: [],
  duplicate_or_low_confidence: [],
}) + "\\n\`\`\`\\n");
`);

  const stdout = execFileSync("node", [
    OPENCODE_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_OPENCODE_BIN: fakeOpencode },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.profile, "blindspot");
  assert.equal(result.summary, "No blocking blind spots.");
});

test("pi adapter forwards read-only tools, model, and preserves primary review prompt", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-pi-"));
  const logPath = path.join(fakeDir, "pi-args.log");
  const fakePi = writeExecutable(fakeDir, "fake-pi.js", `#!/usr/bin/env node
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
    PI_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--model", "openai/gpt-5",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_PI_BIN: fakePi },
  });

  const result = JSON.parse(stdout);
  const loggedArgs = fs.readFileSync(logPath, "utf-8");
  assert.equal(result.verdict, "pass");
  assert.match(loggedArgs, /^--no-session\n--tools\nread,grep,find,ls\n--model\nopenai\/gpt-5\n--print\n/);
  assert.match(loggedArgs, /NON-INTERACTIVE REVIEW/);
  assert.match(loggedArgs, /Return a passing review\./);
});

test("pi adapter reports adapter and phase when stdout is invalid JSON", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-pi-invalid-"));
  const fakePi = writeExecutable(fakeDir, "fake-pi.js", `#!/usr/bin/env node
process.stdout.write("not-json\\n");
`);

  let error;
  try {
    execFileSync("node", [
      PI_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, RELAY_PI_BIN: fakePi },
    });
    assert.fail("expected invoke-reviewer-pi.js to fail");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.notEqual(error.status, 0);
  const stderr = String(error.stderr || "");
  assert.match(stderr, /adapter=pi phase=primary_review/);
  assert.match(stderr, /review verdict must be valid JSON/);
});

test("antigravity adapter forwards sandbox, print timeout, and preserves primary review prompt", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-antigravity-"));
  const logPath = path.join(fakeDir, "agy-args.log");
  const fakeAgy = writeExecutable(fakeDir, "fake-agy.js", `#!/usr/bin/env node
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
    ANTIGRAVITY_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--model", "google/antigravity-cli",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_ANTIGRAVITY_BIN: fakeAgy, RELAY_ANTIGRAVITY_REVIEW_TIMEOUT: "45s" },
  });

  const result = JSON.parse(stdout);
  const loggedArgs = fs.readFileSync(logPath, "utf-8");
  assert.equal(result.verdict, "pass");
  assert.match(loggedArgs, /^--print\n--print-timeout\n45s\n--sandbox\n/);
  assert.match(loggedArgs, /NON-INTERACTIVE REVIEW/);
  assert.match(loggedArgs, /Return a passing review\./);
});

test("antigravity adapter reports adapter and phase when stdout is invalid JSON", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-antigravity-invalid-"));
  const fakeAgy = writeExecutable(fakeDir, "fake-agy.js", `#!/usr/bin/env node
process.stdout.write("not-json\\n");
`);

  let error;
  try {
    execFileSync("node", [
      ANTIGRAVITY_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, RELAY_ANTIGRAVITY_BIN: fakeAgy },
    });
    assert.fail("expected invoke-reviewer-antigravity.js to fail");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.notEqual(error.status, 0);
  const stderr = String(error.stderr || "");
  assert.match(stderr, /adapter=antigravity phase=primary_review/);
  assert.match(stderr, /review verdict must be valid JSON/);
});
