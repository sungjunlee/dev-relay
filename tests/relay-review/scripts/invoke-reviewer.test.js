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
    "--model", "opencode-go/deepseek-v4-pro",
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
  assert.match(loggedArgs, /^run\n-m\nopencode-go\/deepseek-v4-pro\n/);
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
  assert.match(loggedArgs, /^--no-session\n--tools\nread,grep,find,ls\n--model\nopenai\/gpt-5\n--print\n/);
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
  assert.match(loggedArgs, /^--no-session\n--tools\nread,grep,find,ls\n--model\nopenai\/gpt-5\n--print\n/);
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
  assert.ok(elapsedMs < 2000, `expected adapter timeout before fake pi completed, elapsed=${elapsedMs}ms`);
  const stderr = String(error.stderr || "");
  assert.match(stderr, /Pi reviewer primary_review timed out after 1s/);
  assert.match(stderr, /RELAY_PI_REVIEW_TIMEOUT/);
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
  assert.ok(elapsedMs < 2000, `expected adapter timeout before fake agy completed, elapsed=${elapsedMs}ms`);
  const stderr = String(error.stderr || "");
  assert.match(stderr, /Antigravity reviewer primary_review timed out after 1s/);
  assert.match(stderr, /RELAY_ANTIGRAVITY_REVIEW_TIMEOUT/);
  assert.match(stderr, /agy --prompt invocation/);
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
