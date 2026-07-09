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
const CURSOR_SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "invoke-reviewer-cursor.js");
const CLINE_SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "invoke-reviewer-cline.js");

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

function reviewerVerdict(overrides = {}) {
  return {
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_review_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
    ...overrides,
  };
}

function runPiAdapterWithStdout(stdoutText) {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-pi-output-"));
  const fakePi = writeExecutable(fakeDir, "fake-pi.js", `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(stdoutText)});
`);

  return execFileSync("node", [
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

test("codex adapter timeout reports model and raw response path", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-codex-timeout-"));
  const fakeCodex = writeExecutable(fakeDir, "fake-codex.js", `#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write("late output\\n");
}, 1000);
`);

  let error;
  try {
    execFileSync("node", [
      CODEX_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--model", "codex-test-model",
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5000,
      env: { ...process.env, RELAY_CODEX_BIN: fakeCodex, RELAY_CODEX_REVIEW_TIMEOUT: "10ms" },
    });
    assert.fail("expected invoke-reviewer-codex.js to time out");
  } catch (caught) {
    error = caught;
  }

  const stderr = String(error.stderr || "");
  assert.match(stderr, /Codex reviewer primary_review timed out after 10ms/);
  assert.match(stderr, /RELAY_CODEX_REVIEW_TIMEOUT/);
  assert.match(stderr, /model=codex-test-model/);
  assert.match(stderr, /raw_response=/);
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
    "--model", "example/opencode-model-fast",
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
  assert.match(loggedArgs, /^run\n-m\nexample\/opencode-model-fast\n/);
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

test("opencode adapter accepts prose-wrapped advisory JSON through shared advisory parsing", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-opencode-prose-"));
  const fakeOpencode = writeExecutable(fakeDir, "fake-opencode.js", `#!/usr/bin/env node
process.stdout.write("Sure, here is the advisory result:\\n" + JSON.stringify({
  profile: "blindspot",
  summary: "Recovered from verbose live output.",
  required_findings: [],
  advisory_findings: [],
  duplicate_or_low_confidence: [],
}) + "\\n");
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
  assert.equal(result.summary, "Recovered from verbose live output.");
});

test("opencode adapter reports actionable diagnostics for empty stdout", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-opencode-empty-"));
  const fakeOpencode = writeExecutable(fakeDir, "fake-opencode.js", `#!/usr/bin/env node
process.exit(0);
`);

  let error;
  try {
    execFileSync("node", [
      OPENCODE_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--model", "example/opencode-model-fast",
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, RELAY_OPENCODE_BIN: fakeOpencode },
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, "expected empty stdout to fail closed");
  const stderr = String(error.stderr || "");
  assert.match(stderr, /opencode advisory_review reviewer produced empty stdout/);
  assert.match(stderr, /cannot treat this as healthy review evidence/);
  assert.match(stderr, /verify OpenCode non-interactive model\/provider output/);
  assert.match(stderr, /OpenCode CLI\/provider non-interactive blocker/);
});

test("opencode adapter enforces parent timeout and reports timeout context", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-opencode-timeout-"));
  const fakeOpencode = writeExecutable(fakeDir, "fake-opencode.js", `#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    profile: "blindspot",
    summary: "Too late.",
    required_findings: [],
    advisory_findings: [],
    duplicate_or_low_confidence: [],
  }));
}, 2500);
`);

  let error;
  try {
    execFileSync("node", [
      OPENCODE_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5000,
      env: { ...process.env, RELAY_OPENCODE_BIN: fakeOpencode, RELAY_OPENCODE_REVIEW_TIMEOUT: "1s" },
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, "expected invoke-reviewer-opencode.js to fail on parent timeout");
  const stderr = String(error.stderr || "");
  assert.match(stderr, /opencode advisory_review reviewer timed out after 1s/);
  assert.match(stderr, /RELAY_OPENCODE_REVIEW_TIMEOUT/);
  assert.match(stderr, /cannot treat this as healthy review evidence/);
  assert.doesNotMatch(String(error.stdout || ""), /Too late/);
});

test("opencode adapter supports primary review verdict parsing when phase is primary_review", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-opencode-primary-"));
  const logPath = path.join(fakeDir, "opencode-args.log");
  const fakeOpencode = writeExecutable(fakeDir, "fake-opencode.js", `#!/usr/bin/env node
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
    OPENCODE_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--model", "example/opencode-model-fast",
    "--phase", "primary_review",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_OPENCODE_BIN: fakeOpencode },
  });

  const result = JSON.parse(stdout);
  const loggedArgs = fs.readFileSync(logPath, "utf-8");
  assert.equal(result.verdict, "pass");
  assert.match(loggedArgs, /^run\n-m\nexample\/opencode-model-fast\n/);
  assert.match(loggedArgs, /NON-INTERACTIVE REVIEW/);
  assert.doesNotMatch(loggedArgs, /NON-INTERACTIVE ADVISORY REVIEW/);
});

test("opencode primary review rejects advisory-shaped JSON", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-opencode-primary-invalid-"));
  const fakeOpencode = writeExecutable(fakeDir, "fake-opencode.js", `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  profile: "blindspot",
  summary: "Wrong schema.",
  required_findings: [],
  advisory_findings: [],
  duplicate_or_low_confidence: [],
}));
`);

  assert.throws(
    () => execFileSync("node", [
      OPENCODE_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--phase", "primary_review",
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, RELAY_OPENCODE_BIN: fakeOpencode },
    }),
    (error) => {
      const stderr = String(error.stderr || "");
      assert.match(stderr, /adapter=opencode phase=primary_review/);
      assert.match(stderr, /Invalid review verdict: undefined/);
      return true;
    }
  );
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
  assert.match(loggedArgs, /^--no-session\n--no-context-files\n--no-extensions\n--no-skills\n--no-prompt-templates\n--no-themes\n--tools\nread,grep,find,ls\n--model\nopenai\/gpt-5\n--print\n/);
  assert.match(loggedArgs, /NON-INTERACTIVE REVIEW/);
  assert.match(loggedArgs, /Return a passing review\./);
});

test("pi adapter supports advisory review JSON when phase is advisory_review", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-pi-advisory-"));
  const logPath = path.join(fakeDir, "pi-args.log");
  const fakePi = writeExecutable(fakeDir, "fake-pi.js", `#!/usr/bin/env node
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
    PI_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--model", "openai/gpt-5",
    "--phase", "advisory_review",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_PI_BIN: fakePi },
  });

  const result = JSON.parse(stdout);
  const loggedArgs = fs.readFileSync(logPath, "utf-8");
  assert.equal(result.profile, "blindspot");
  assert.match(loggedArgs, /^--no-session\n--no-context-files\n--no-extensions\n--no-skills\n--no-prompt-templates\n--no-themes\n--tools\nread,grep,find,ls\n--model\nopenai\/gpt-5\n--print\n/);
  assert.match(loggedArgs, /NON-INTERACTIVE ADVISORY REVIEW/);
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

test("pi adapter accepts prose-wrapped output with one valid verdict object", () => {
  const payload = JSON.stringify(reviewerVerdict({
    summary: "Recovered from wrapped Pi output.",
  }));

  const stdout = runPiAdapterWithStdout(`Now I have reviewed the changes.\n\n${payload}\n`);

  const result = JSON.parse(stdout);
  assert.equal(result.verdict, "pass");
  assert.equal(result.summary, "Recovered from wrapped Pi output.");
});

test("pi adapter rejects ambiguous output with multiple JSON objects", () => {
  const payload = JSON.stringify(reviewerVerdict());
  const cases = [
    `Now I have reviewed the changes.\n${payload}\n${payload}\n`,
    `Now I have reviewed the changes.\n${JSON.stringify({ note: "analysis wrapper" })}\n${payload}\n`,
  ];

  for (const output of cases) {
    assert.throws(
      () => runPiAdapterWithStdout(output),
      (error) => {
        const stderr = String(error.stderr || "");
        assert.match(stderr, /adapter=pi phase=primary_review/);
        assert.match(stderr, /review verdict must be valid JSON/);
        assert.match(stderr, /multiple JSON objects/);
        return true;
      }
    );
  }
});

test("pi adapter validates recovered verdict objects", () => {
  const invalidVerdict = reviewerVerdict();
  delete invalidVerdict.summary;

  assert.throws(
    () => runPiAdapterWithStdout(`Here is the verdict:\n${JSON.stringify(invalidVerdict)}\n`),
    (error) => {
      const stderr = String(error.stderr || "");
      assert.match(stderr, /adapter=pi phase=primary_review/);
      assert.match(stderr, /Review verdict summary is required/);
      return true;
    }
  );
});

test("pi adapter enforces parent timeout and reports timeout context", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-pi-timeout-"));
  const fakePi = writeExecutable(fakeDir, "fake-pi.js", `#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    verdict: "pass",
    summary: "Too late.",
    contract_status: "pass",
    quality_review_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  }));
}, 2500);
`);

  const started = Date.now();
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
      timeout: 5000,
      env: { ...process.env, RELAY_PI_BIN: fakePi, RELAY_PI_REVIEW_TIMEOUT: "1s" },
    });
  } catch (caught) {
    error = caught;
  }
  const elapsedMs = Date.now() - started;

  assert.ok(error, "expected invoke-reviewer-pi.js to fail on parent timeout");
  assert.notEqual(error.status, 0);
  const stderr = String(error.stderr || "");
  assert.match(stderr, /Pi reviewer primary_review timed out after 1s/);
  assert.match(stderr, /RELAY_PI_REVIEW_TIMEOUT/);
  assert.doesNotMatch(String(error.stdout || ""), /Too late/);
  assert.match(stderr, /cannot treat this as healthy review evidence/);
  assert.match(stderr, /verify Pi non-interactive auth\/provider health/);
  assert.match(stderr, /--no-context-files --no-tools --no-extensions --no-skills --no-prompt-templates --no-themes --print/);
  assert.match(stderr, /Pi CLI\/provider non-interactive blocker/);
  assert.ok(elapsedMs < 5000, `expected adapter to fail before the outer test timeout, elapsed=${elapsedMs}ms`);
});

test("pi adapter rejects invalid review timeout without invoking pi", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-pi-bad-timeout-"));
  const logPath = path.join(fakeDir, "pi-args.log");
  const fakePi = writeExecutable(fakeDir, "fake-pi.js", `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(logPath)}, "invoked\\n", "utf-8");
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
      env: { ...process.env, RELAY_PI_BIN: fakePi, RELAY_PI_REVIEW_TIMEOUT: "soon" },
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, "expected invalid timeout to fail closed");
  assert.notEqual(error.status, 0);
  assert.equal(fs.existsSync(logPath), false);
  assert.match(String(error.stderr || ""), /RELAY_PI_REVIEW_TIMEOUT must be a positive duration like 120s/);
});

test("pi adapter recovers valid stdout from non-timeout failures", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-pi-recover-"));
  const fakePi = writeExecutable(fakeDir, "fake-pi.js", `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  verdict: "pass",
  summary: "Recovered stdout.",
  contract_status: "pass",
  quality_review_status: "pass",
  next_action: "ready_to_merge",
  issues: [],
  rubric_scores: [],
  scope_drift: { creep: [], missing: [] },
}));
process.stderr.write("simulated late failure\\n");
process.exit(1);
`);

  const stdout = execFileSync("node", [
    PI_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_PI_BIN: fakePi, RELAY_PI_REVIEW_TIMEOUT: "5s" },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.summary, "Recovered stdout.");
});

test("antigravity adapter forwards prompt, print timeout, sandbox, and preserves primary review prompt", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-antigravity-"));
  const logPath = path.join(fakeDir, "agy-args.log");
  const fakeAgy = writeExecutable(fakeDir, "fake-agy.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args), "utf-8");
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
  const loggedArgs = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  assert.equal(result.verdict, "pass");
  assert.equal(loggedArgs[0], "--prompt");
  assert.deepEqual(loggedArgs.slice(2), ["--print-timeout", "45s", "--sandbox"]);
  assert.match(loggedArgs[1], /NON-INTERACTIVE REVIEW/);
  assert.match(loggedArgs[1], /Return a passing review\./);
  assert.equal(loggedArgs.includes("--print"), false);
});

test("antigravity adapter supports advisory review JSON when phase is advisory_review", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-antigravity-advisory-"));
  const logPath = path.join(fakeDir, "agy-args.log");
  const fakeAgy = writeExecutable(fakeDir, "fake-agy.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args), "utf-8");
process.stdout.write(JSON.stringify({
  profile: "blindspot",
  summary: "No blocking blind spots.",
  required_findings: [],
  advisory_findings: [],
  duplicate_or_low_confidence: [],
}));
`);

  const stdout = execFileSync("node", [
    ANTIGRAVITY_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--model", "google/antigravity-cli",
    "--phase", "advisory_review",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_ANTIGRAVITY_BIN: fakeAgy, RELAY_ANTIGRAVITY_REVIEW_TIMEOUT: "45s" },
  });

  const result = JSON.parse(stdout);
  const loggedArgs = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  assert.equal(result.profile, "blindspot");
  assert.equal(loggedArgs[0], "--prompt");
  assert.deepEqual(loggedArgs.slice(2), ["--print-timeout", "45s", "--sandbox"]);
  assert.match(loggedArgs[1], /NON-INTERACTIVE ADVISORY REVIEW/);
  assert.equal(loggedArgs.includes("--print"), false);
});

test("antigravity adapter fails closed when review mutates the worktree", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-antigravity-mutate-"));
  const fakeAgy = writeExecutable(fakeDir, "fake-agy.js", `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const stateDir = path.join(process.cwd(), ".antigravitycli");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "session.json"), JSON.stringify({ allowWrite: true }), "utf-8");
process.stdout.write(JSON.stringify({
  profile: "blindspot",
  summary: "No blocking blind spots.",
  required_findings: [],
  advisory_findings: [],
  duplicate_or_low_confidence: [],
}));
`);

  let error;
  try {
    execFileSync("node", [
      ANTIGRAVITY_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--model", "google/antigravity-cli",
      "--phase", "advisory_review",
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, RELAY_ANTIGRAVITY_BIN: fakeAgy, RELAY_ANTIGRAVITY_REVIEW_TIMEOUT: "45s" },
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, "expected worktree mutation to fail closed");
  const stderr = String(error.stderr || "");
  assert.match(stderr, /Antigravity reviewer advisory_review mutated the worktree/);
  assert.match(stderr, /read-only review mode/);
  assert.match(stderr, /\.antigravitycli/);
});

test("antigravity adapter enforces parent timeout and reports timeout context", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-antigravity-timeout-"));
  const fakeAgy = writeExecutable(fakeDir, "fake-agy.js", `#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    verdict: "pass",
    summary: "Too late.",
    contract_status: "pass",
    quality_review_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  }));
}, 2500);
`);

  const started = Date.now();
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
      timeout: 5000,
      env: { ...process.env, RELAY_ANTIGRAVITY_BIN: fakeAgy, RELAY_ANTIGRAVITY_REVIEW_TIMEOUT: "1s" },
    });
  } catch (caught) {
    error = caught;
  }
  const elapsedMs = Date.now() - started;

  assert.ok(error, "expected invoke-reviewer-antigravity.js to fail on parent timeout");
  assert.notEqual(error.status, 0);
  const stderr = String(error.stderr || "");
  assert.match(stderr, /Antigravity reviewer primary_review timed out after 1s/);
  assert.match(stderr, /RELAY_ANTIGRAVITY_REVIEW_TIMEOUT/);
  assert.match(stderr, /agy --prompt invocation/);
  assert.doesNotMatch(String(error.stdout || ""), /Too late/);
  assert.ok(elapsedMs < 5000, `expected adapter to fail before the outer test timeout, elapsed=${elapsedMs}ms`);
});

test("antigravity adapter rejects invalid review timeout without invoking agy", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-antigravity-bad-timeout-"));
  const logPath = path.join(fakeDir, "agy-args.log");
  const fakeAgy = writeExecutable(fakeDir, "fake-agy.js", `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(logPath)}, "invoked\\n", "utf-8");
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
      env: { ...process.env, RELAY_ANTIGRAVITY_BIN: fakeAgy, RELAY_ANTIGRAVITY_REVIEW_TIMEOUT: "soon" },
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, "expected invalid timeout to fail closed");
  assert.notEqual(error.status, 0);
  assert.equal(fs.existsSync(logPath), false);
  assert.match(String(error.stderr || ""), /RELAY_ANTIGRAVITY_REVIEW_TIMEOUT must be a positive duration like 120s/);
});

test("antigravity adapter recovers valid stdout from non-timeout failures", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-antigravity-recover-"));
  const fakeAgy = writeExecutable(fakeDir, "fake-agy.js", `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  verdict: "pass",
  summary: "Recovered stdout.",
  contract_status: "pass",
  quality_review_status: "pass",
  next_action: "ready_to_merge",
  issues: [],
  rubric_scores: [],
  scope_drift: { creep: [], missing: [] },
}));
process.stderr.write("simulated late failure\\n");
process.exit(1);
`);

  const stdout = execFileSync("node", [
    ANTIGRAVITY_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_ANTIGRAVITY_BIN: fakeAgy, RELAY_ANTIGRAVITY_REVIEW_TIMEOUT: "5s" },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.summary, "Recovered stdout.");
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

test("cursor adapter forwards ask mode, workspace, json wrapper parsing, and preserves primary review prompt", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cursor-"));
  const logPath = path.join(fakeDir, "agent-args.log");
  const verdict = reviewerVerdict();
  const fakeAgent = writeExecutable(fakeDir, "fake-agent.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "status") {
  process.stdout.write("Logged in as test@example.com\\n");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args), "utf-8");
process.stdout.write(JSON.stringify({
  result: JSON.stringify(${JSON.stringify(verdict)}),
}));
`);

  const stdout = execFileSync("node", [
    CURSOR_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--model", "composer-2.5",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      RELAY_CURSOR_AGENT_BIN: fakeAgent,
      RELAY_CURSOR_REVIEW_TIMEOUT: "45s",
      CURSOR_API_KEY: "",
    },
  });

  const result = JSON.parse(stdout);
  const loggedArgs = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  assert.equal(result.verdict, "pass");
  assert.deepEqual(loggedArgs.slice(0, 9), [
    "--print",
    "--trust",
    "--force",
    "--mode", "ask",
    "--workspace", repoRoot,
    "--output-format", "json",
  ]);
  assert.equal(loggedArgs[9], "--model");
  assert.equal(loggedArgs[10], "composer-2.5");
  assert.match(loggedArgs[11], /NON-INTERACTIVE REVIEW/);
  assert.match(loggedArgs[11], /Return a passing review\./);
});

test("cursor adapter rejects advisory review phase", () => {
  const { repoRoot, promptPath } = setupRepo();
  let error;
  try {
    execFileSync("node", [
      CURSOR_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--phase", "advisory_review",
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, CURSOR_API_KEY: "test-key" },
    });
    assert.fail("expected invoke-reviewer-cursor.js to fail");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.match(String(error.stderr || ""), /primary_review only/);
});

test("cline adapter forwards json provider, cwd, timeout, model, and parses run_result.text advisory JSON", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-"));
  const logPath = path.join(fakeDir, "cline-args.log");
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args), "utf-8");
process.stdout.write(JSON.stringify({ type: "agent_event", event: { type: "content_start", text: "ignored" } }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "run_result",
  finishReason: "completed",
  text: JSON.stringify({
    profile: "blindspot",
    summary: "No blocking blind spots.",
    required_findings: [],
    advisory_findings: [],
    duplicate_or_low_confidence: [],
  }),
}) + "\\n");
`);

  const stdout = execFileSync("node", [
    CLINE_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--model", "cline-pass/glm-5.2",
    "--phase", "advisory_review",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      RELAY_CLINE_BIN: fakeCline,
      RELAY_CLINE_REVIEW_TIMEOUT: "120s",
    },
  });

  const result = JSON.parse(stdout);
  const loggedArgs = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  assert.equal(result.profile, "blindspot");
  assert.deepEqual(loggedArgs.slice(0, 10), [
    "--json",
    "--yolo",
    "-P", "cline-pass",
    "-m", "cline-pass/glm-5.2",
    "--cwd", repoRoot,
    "--timeout", "60",
  ]);
  assert.match(loggedArgs[10], /NON-INTERACTIVE ADVISORY REVIEW/);
  assert.match(loggedArgs[10], /Return a passing review\./);
  assert.match(loggedArgs[10], /Do not use cline --worktree; relay already selected the review checkout with --cwd\./);
  assert.equal(loggedArgs.includes("--worktree"), false);
});

test("cline adapter parses yolo content_end candidate when run_result text is a paraphrase", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-yolo-content-"));
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "agent_event",
  event: { type: "content_end", contentType: "reasoning", text: "skip reasoning" },
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "agent_event",
  event: {
    type: "content_end",
    contentType: "text",
    text: JSON.stringify({
      profile: "blindspot",
      summary: "Recovered from final content_end.",
      required_findings: [],
      advisory_findings: [],
      duplicate_or_low_confidence: [],
    }),
  },
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "run_result",
  finishReason: "completed",
  text: "Submission recorded (verified): Output the requested JSON object verbatim ...",
}) + "\\n");
`);

  const stdout = execFileSync("node", [
    CLINE_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_CLINE_BIN: fakeCline },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.summary, "Recovered from final content_end.");
});

test("cline adapter reports candidate count and first parse failure when all advisory candidates fail", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-candidate-fail-"));
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "agent_event",
  event: { type: "content_end", contentType: "text", text: "also-not-json" },
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "run_result",
  finishReason: "completed",
  text: "not-json",
}) + "\\n");
`);

  let error;
  try {
    execFileSync("node", [
      CLINE_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, RELAY_CLINE_BIN: fakeCline },
    });
    assert.fail("expected invoke-reviewer-cline.js to fail");
  } catch (caught) {
    error = caught;
  }

  const stderr = String(error.stderr || "");
  assert.match(stderr, /failed to parse any of 2 advisory candidate/);
  assert.match(stderr, /first failure: adapter=cline phase=advisory_review advisory review must be valid JSON/);
});

test("cline adapter rejects slash-less model before executing cline", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-model-guard-"));
  const logPath = path.join(fakeDir, "cline-args.log");
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(logPath)}, "invoked\\n", "utf-8");
`);

  let error;
  try {
    execFileSync("node", [
      CLINE_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--model", "glm-5.2",
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, RELAY_CLINE_BIN: fakeCline },
    });
    assert.fail("expected invoke-reviewer-cline.js to fail");
  } catch (caught) {
    error = caught;
  }

  assert.equal(fs.existsSync(logPath), false);
  assert.match(String(error.stderr || ""), /modelType\/model/);
  assert.match(String(error.stderr || ""), /cline-pass\/glm-5\.2/);
});

test("cline adapter omits -m when model is absent and keeps default provider path", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-no-model-"));
  const logPath = path.join(fakeDir, "cline-args.log");
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args), "utf-8");
process.stdout.write(JSON.stringify({
  type: "run_result",
  finishReason: "completed",
  text: JSON.stringify({
    profile: "blindspot",
    summary: "No model flag.",
    required_findings: [],
    advisory_findings: [],
    duplicate_or_low_confidence: [],
  }),
}) + "\\n");
`);

  const stdout = execFileSync("node", [
    CLINE_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_CLINE_BIN: fakeCline },
  });

  const result = JSON.parse(stdout);
  const loggedArgs = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  assert.equal(result.summary, "No model flag.");
  assert.equal(loggedArgs.includes("-m"), false);
  assert.deepEqual(loggedArgs.slice(0, 4), ["--json", "--yolo", "-P", "cline-pass"]);
});

test("cline adapter gives cline timeout 60 seconds of parent headroom", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-headroom-"));
  const logPath = path.join(fakeDir, "cline-args.log");
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args), "utf-8");
process.stdout.write(JSON.stringify({
  type: "run_result",
  finishReason: "completed",
  text: JSON.stringify({
    profile: "blindspot",
    summary: "Headroom.",
    required_findings: [],
    advisory_findings: [],
    duplicate_or_low_confidence: [],
  }),
}) + "\\n");
`);

  execFileSync("node", [
    CLINE_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_CLINE_BIN: fakeCline, RELAY_CLINE_REVIEW_TIMEOUT: "180s" },
  });

  const loggedArgs = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  assert.equal(loggedArgs[loggedArgs.indexOf("--timeout") + 1], "120");
});

test("cline adapter rejects primary review phase until canary promotion", () => {
  const { repoRoot, promptPath } = setupRepo();
  let error;
  try {
    execFileSync("node", [
      CLINE_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--phase", "primary_review",
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, RELAY_CLINE_BIN: path.join(repoRoot, "missing-cline") },
    });
    assert.fail("expected invoke-reviewer-cline.js to fail");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.match(String(error.stderr || ""), /advisory_review only in the MVP/);
  assert.match(String(error.stderr || ""), /Primary review requires separate live canary promotion/);
});

test("cline adapter reports adapter and phase when run_result.text is invalid advisory JSON", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-invalid-json-"));
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "run_result", finishReason: "completed", text: "not-json" }) + "\\n");
`);

  let error;
  try {
    execFileSync("node", [
      CLINE_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, RELAY_CLINE_BIN: fakeCline },
    });
    assert.fail("expected invoke-reviewer-cline.js to fail");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  const stderr = String(error.stderr || "");
  assert.match(stderr, /adapter=cline phase=advisory_review/);
  assert.match(stderr, /advisory review must be valid JSON/);
});

test("cline adapter reports actionable diagnostics for empty JSONL output", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-empty-"));
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
process.exit(0);
`);

  let error;
  try {
    execFileSync("node", [
      CLINE_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--model", "cline-pass/glm-5.2",
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, RELAY_CLINE_BIN: fakeCline },
    });
    assert.fail("expected invoke-reviewer-cline.js to fail");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  const stderr = String(error.stderr || "");
  assert.match(stderr, /Cline JSONL output is empty/);
  assert.match(stderr, /cannot treat this as healthy advisory evidence/);
});

test("cline adapter rejects review timeouts without Cline headroom before executing cline", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-timeout-"));
  const logPath = path.join(fakeDir, "cline-args.log");
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(logPath)}, "invoked\\n", "utf-8");
`);

  let error;
  try {
    execFileSync("node", [
      CLINE_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--model", "cline-pass/glm-5.2",
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5000,
      env: { ...process.env, RELAY_CLINE_BIN: fakeCline, RELAY_CLINE_REVIEW_TIMEOUT: "90s" },
    });
    assert.fail("expected invoke-reviewer-cline.js to fail");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, "expected invoke-reviewer-cline.js to fail before invoking cline");
  assert.equal(fs.existsSync(logPath), false);
  const stderr = String(error.stderr || "");
  assert.match(stderr, /RELAY_CLINE_REVIEW_TIMEOUT/);
  assert.match(stderr, /at least 120s/);
});

test("cursor adapter fails closed when auth probe reports not logged in", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cursor-auth-"));
  const fakeAgent = writeExecutable(fakeDir, "fake-agent.js", `#!/usr/bin/env node
if (process.argv[2] === "status") {
  process.stdout.write("Not logged in. Please run \`agent login\`.\\n");
  process.exit(1);
}
process.stdout.write("{}");
`);

  let error;
  try {
    execFileSync("node", [
      CURSOR_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: {
        ...process.env,
        RELAY_CURSOR_AGENT_BIN: fakeAgent,
        CURSOR_API_KEY: "",
      },
    });
    assert.fail("expected invoke-reviewer-cursor.js to fail");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.match(String(error.stderr || ""), /not authenticated/i);
});
