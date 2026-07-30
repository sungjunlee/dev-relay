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
const {
  CLINE_FILE_REFERENCE_REASON,
  assertControlSafeArgv,
} = require("../../../skills/relay-review/scripts/reviewer-prompt-transport");

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

function clineCliPromptResolver({ promptPathCapture, promptCapturePath = null }) {
  return `
const path = require("path");
const reference = process.argv.at(-1);
const mentions = Array.from(reference.matchAll(/(^|[\\s])@([^\\s]+)/g))
  .map((match) => (match[2] || "").trim())
  .map((mention) => mention.replace(/^[('"\\x60]+/, "").replace(/[),.:;!?\\x60'"]+$/, ""))
  .filter((mention) => mention && !mention.includes("@"));
if (mentions.length !== 1) process.exit(2);
const resolvedPromptPath = path.resolve(process.cwd(), mentions[0].replace(/\\\\/g, "/"));
const relativePromptPath = path.relative(process.cwd(), resolvedPromptPath);
if (
  relativePromptPath.startsWith("..")
  || path.isAbsolute(relativePromptPath)
  || !fs.existsSync(resolvedPromptPath)
) process.exit(2);
fs.writeFileSync(${JSON.stringify(promptPathCapture)}, resolvedPromptPath, "utf-8");
${promptCapturePath
    ? `fs.copyFileSync(resolvedPromptPath, ${JSON.stringify(promptCapturePath)});`
    : ""}
`;
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

function advisoryPayload(profile = "blindspot") {
  return {
    profile,
    summary: `${profile} advisory result.`,
    required_findings: [],
    advisory_findings: [],
    duplicate_or_low_confidence: [],
  };
}

const ADVISORY_ADAPTERS = [
  {
    name: "opencode",
    script: OPENCODE_SCRIPT,
    envKey: "RELAY_OPENCODE_BIN",
    fakeName: "fake-opencode.js",
    extraEnv: {},
    fakeBody: (payload, markerPath) => `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(markerPath)}, "spawned\\n", "utf-8");
process.stdout.write(JSON.stringify(${JSON.stringify(payload)}));
`,
  },
  {
    name: "pi",
    script: PI_SCRIPT,
    envKey: "RELAY_PI_BIN",
    fakeName: "fake-pi.js",
    extraEnv: {},
    fakeBody: (payload, markerPath) => `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(markerPath)}, "spawned\\n", "utf-8");
process.stdout.write(JSON.stringify(${JSON.stringify(payload)}));
`,
  },
  {
    name: "antigravity",
    script: ANTIGRAVITY_SCRIPT,
    envKey: "RELAY_ANTIGRAVITY_BIN",
    fakeName: "fake-agy.js",
    extraEnv: { RELAY_ANTIGRAVITY_REVIEW_TIMEOUT: "45s" },
    fakeBody: (payload, markerPath) => `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(markerPath)}, "spawned\\n", "utf-8");
process.stdout.write(JSON.stringify(${JSON.stringify(payload)}));
`,
  },
  {
    name: "cline",
    script: CLINE_SCRIPT,
    envKey: "RELAY_CLINE_BIN",
    fakeName: "fake-cline.js",
    extraEnv: { RELAY_CLINE_REVIEW_TIMEOUT: "120s" },
    extraArgs: ["--model", "cline-pass/z-ai/glm-5.2"],
    fakeBody: (payload, markerPath) => `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(markerPath)}, "spawned\\n", "utf-8");
process.stdout.write(JSON.stringify({
  type: "run_result",
  finishReason: "completed",
  text: JSON.stringify(${JSON.stringify(payload)}),
}) + "\\n");
`,
  },
];

function runAdvisoryAdapter(adapter, {
  payload = null,
  profileArg = null,
  payloadProfile = "blindspot",
} = {}) {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), `relay-review-fake-${adapter.name}-profile-`));
  const markerPath = path.join(fakeDir, "spawned.txt");
  const fakeBin = writeExecutable(
    fakeDir,
    adapter.fakeName,
    adapter.fakeBody(payload || advisoryPayload(payloadProfile), markerPath)
  );
  const args = [
    adapter.script,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--phase", "advisory_review",
    ...(adapter.extraArgs || []),
  ];
  if (profileArg) args.push("--profile", profileArg);
  args.push("--json");
  const stdout = execFileSync("node", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, ...adapter.extraEnv, [adapter.envKey]: fakeBin },
  });
  return { stdout, markerPath };
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

test("prompt transport guard names the reviewed diff and stdin-or-file remedy", () => {
  const promptPath = path.join(
    os.tmpdir(),
    "relay-review-guard",
    "review-round-3-prompt.md"
  );
  assert.throws(
    () => assertControlSafeArgv(["run", "unsafe\0prompt"], {
      adapter: "example",
      promptFile: promptPath,
    }),
    (error) => {
      assert.match(error.message, /review-round-3-diff\.patch/);
      assert.match(error.message, /Remedy: keep the complete review prompt on stdin or in a prompt file/);
      assert.doesNotMatch(error.message, /args\[\d+\] must be a string without null bytes/);
      return true;
    }
  );
});

test("codex adapter uses result file output and forwards isolation flags", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-codex-"));
  const logPath = path.join(fakeDir, "codex-args.log");
  const stdinPath = path.join(fakeDir, "codex-stdin.txt");
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
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinPath)}, Buffer.concat(chunks));
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
});
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
  assert.match(loggedArgs, /\n-\n$/);
  assert.doesNotMatch(loggedArgs, /Return a passing review\./);
  assert.match(fs.readFileSync(stdinPath, "utf-8"), /Return a passing review\./);
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

test("codex adapter classifies usage-limit stderr as codex_quota_exhausted", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-codex-quota-"));
  const usageLimitLine =
    "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:33 AM.";
  const fakeCodex = writeExecutable(fakeDir, "fake-codex.js", `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(usageLimitLine + "\n")});
process.exit(1);
`);

  let error;
  try {
    execFileSync("node", [
      CODEX_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--model", "codex-quota-model",
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, RELAY_CODEX_BIN: fakeCodex },
    });
    assert.fail("expected invoke-reviewer-codex.js to fail on usage limit");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.notEqual(error.status, 0);
  const stderr = String(error.stderr || "");
  assert.match(stderr, /codex_quota_exhausted/);
  assert.match(stderr, /try again at 4:33 AM/);
  assert.match(stderr, /You've hit your usage limit/);
  assert.match(stderr, /model=codex-quota-model/);
  assert.doesNotMatch(stderr, /Codex reviewer primary_review timed out/);
});

test("codex adapter ignores usage-limit text embedded in echoed output", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-codex-quota-echo-"));
  const fakeCodex = writeExecutable(fakeDir, "fake-codex.js", `#!/usr/bin/env node
process.stdout.write("Echoed prompt: ERROR: You've hit your usage limit. Please preserve this fixture text.\\n");
process.exit(1);
`);

  let error;
  try {
    execFileSync("node", [
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
    assert.fail("expected invoke-reviewer-codex.js to fail");
  } catch (caught) {
    error = caught;
  }

  const stderr = String(error.stderr || "");
  assert.doesNotMatch(stderr, /codex_quota_exhausted/);
  assert.match(
    stderr,
    /^Error: Codex reviewer primary_review failed; model=default; raw_response=.+; Echoed prompt: ERROR: You've hit your usage limit\. Please preserve this fixture text\.\n$/
  );
});

test("codex adapter prefers quota classification when quota output overlaps timeout", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-codex-quota-timeout-"));
  const usageLimitLine =
    "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:47 PM.";
  const fakeCodex = writeExecutable(fakeDir, "fake-codex.js", `#!/usr/bin/env node
const fs = require("fs");
fs.writeSync(2, ${JSON.stringify(usageLimitLine + "\n")});
setTimeout(() => {}, 10000);
`);

  let error;
  try {
    execFileSync("node", [
      CODEX_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 20000,
      env: { ...process.env, RELAY_CODEX_BIN: fakeCodex, RELAY_CODEX_REVIEW_TIMEOUT: "2s" },
    });
    assert.fail("expected invoke-reviewer-codex.js to fail on usage limit");
  } catch (caught) {
    error = caught;
  }

  const stderr = String(error.stderr || "");
  assert.match(stderr, /codex_quota_exhausted/);
  assert.match(stderr, /try again at 5:47 PM/);
  assert.doesNotMatch(stderr, /Codex reviewer primary_review timed out/);
});

test("codex adapter keeps generic failure message unchanged for non-quota errors", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-codex-generic-"));
  const fakeCodex = writeExecutable(fakeDir, "fake-codex.js", `#!/usr/bin/env node
process.stderr.write("some generic failure\\n");
process.exit(1);
`);

  let error;
  try {
    execFileSync("node", [
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
    assert.fail("expected invoke-reviewer-codex.js to fail");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.notEqual(error.status, 0);
  const stderr = String(error.stderr || "");
  assert.doesNotMatch(stderr, /codex_quota_exhausted/);
  assert.match(
    stderr,
    /^Error: Codex reviewer primary_review failed; model=default; raw_response=.+; some generic failure\n$/
  );
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

test("claude adapter keeps the stdin prompt separate from allowed tools and argv", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-claude-"));
  const logPath = path.join(fakeDir, "claude-args.log");
  const stdinPath = path.join(fakeDir, "claude-stdin.txt");
  const fakeClaude = writeExecutable(fakeDir, "fake-claude.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, args.join("\\n") + "\\n", "utf-8");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinPath)}, Buffer.concat(chunks));
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
});
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
  assert.doesNotMatch(loggedArgs, /Return a passing review\./);
  assert.match(fs.readFileSync(stdinPath, "utf-8"), /Return a passing review\./);
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

test("opencode adapter forwards model and preserves advisory prompt on stdin", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-opencode-"));
  const logPath = path.join(fakeDir, "opencode-args.log");
  const stdinPath = path.join(fakeDir, "opencode-stdin.txt");
  const fakeOpencode = writeExecutable(fakeDir, "fake-opencode.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, args.join("\\n") + "\\n", "utf-8");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinPath)}, Buffer.concat(chunks));
  process.stdout.write(JSON.stringify({
    profile: "blindspot",
    summary: "No blocking blind spots.",
    required_findings: [],
    advisory_findings: [],
    duplicate_or_low_confidence: [],
  }));
});
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
  assert.equal(loggedArgs, "run\n-m\nexample/opencode-model-fast\n");
  const stdin = fs.readFileSync(stdinPath, "utf-8");
  assert.match(stdin, /NON-INTERACTIVE ADVISORY REVIEW/);
  assert.match(stdin, /Return a passing review\./);
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

for (const adapter of ADVISORY_ADAPTERS) {
  test(`${adapter.name} advisory adapter keeps omitted low-confidence severity non-required`, () => {
    const payload = advisoryPayload();
    payload.duplicate_or_low_confidence = [{
      title: "Speculative duplicate",
      body: "This remains in the non-required bucket.",
      file: "README.md",
      line: 1,
      category: "other",
      confidence: 0.3,
    }];
    const { stdout } = runAdvisoryAdapter(adapter, { payload });
    const result = JSON.parse(stdout);

    assert.deepEqual(result.required_findings, []);
    assert.equal(result.duplicate_or_low_confidence[0].severity, "P3");
  });

  test(`${adapter.name} advisory adapter accepts matching --profile adversarial payload`, () => {
    const { stdout } = runAdvisoryAdapter(adapter, {
      profileArg: "adversarial",
      payloadProfile: "adversarial",
    });

    const result = JSON.parse(stdout);
    assert.equal(result.profile, "adversarial");
  });

  test(`${adapter.name} advisory adapter keeps blindspot default and rejects adversarial payload without --profile`, () => {
    let error;
    try {
      runAdvisoryAdapter(adapter, { payloadProfile: "adversarial" });
      assert.fail(`expected ${adapter.name} adapter to reject adversarial payload on default blindspot profile`);
    } catch (caught) {
      error = caught;
    }

    assert.ok(error);
    assert.notEqual(error.status, 0);
    assert.match(String(error.stderr || ""), /profile must be 'blindspot', got 'adversarial'/);
  });

  test(`${adapter.name} advisory adapter rejects blindspot payload on adversarial lane`, () => {
    let error;
    try {
      runAdvisoryAdapter(adapter, {
        profileArg: "adversarial",
        payloadProfile: "blindspot",
      });
      assert.fail(`expected ${adapter.name} adapter to reject blindspot payload on adversarial profile`);
    } catch (caught) {
      error = caught;
    }

    assert.ok(error);
    assert.notEqual(error.status, 0);
    assert.match(String(error.stderr || ""), /profile must be 'adversarial', got 'blindspot'/);
  });

  test(`${adapter.name} advisory adapter rejects unknown --profile before invoking provider`, () => {
    const { repoRoot, promptPath } = setupRepo();
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), `relay-review-fake-${adapter.name}-bad-profile-`));
    const markerPath = path.join(fakeDir, "spawned.txt");
    const fakeBin = writeExecutable(fakeDir, adapter.fakeName, adapter.fakeBody(advisoryPayload("blindspot"), markerPath));
    const args = [
      adapter.script,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--phase", "advisory_review",
      ...(adapter.extraArgs || []),
      "--profile", "not-a-profile",
      "--json",
    ];

    let error;
    try {
      execFileSync("node", args, {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
        env: { ...process.env, ...adapter.extraEnv, [adapter.envKey]: fakeBin },
      });
      assert.fail(`expected ${adapter.name} adapter to reject unknown profile`);
    } catch (caught) {
      error = caught;
    }

    assert.ok(error);
    assert.notEqual(error.status, 0);
    assert.match(String(error.stderr || ""), /Unknown advisory profile/);
    assert.equal(fs.existsSync(markerPath), false);
  });
}

// Cline has a separate raw-envelope preservation contract because it must
// extract candidates from run_result/content_end output first. These direct
// JSON adapters share writeAdvisorySchemaFailure and must stay in lockstep.
for (const adapter of ADVISORY_ADAPTERS.filter(({ name }) => name !== "cline")) {
  test(`${adapter.name} adapter emits the pre-validation model response on advisory schema failure`, () => {
    const rawPayload = {
      ...advisoryPayload(),
      summary: `raw-schema-failure-marker-${adapter.name}`,
      required_findings: [{
        title: "Required finding without severity",
        body: "This malformed actionable finding must fail closed.",
        file: "README.md",
        line: 1,
        category: "other",
        confidence: 0.95,
      }],
    };

    assert.throws(
      () => runAdvisoryAdapter(adapter, { payload: rawPayload }),
      (error) => {
        const stderr = String(error.stderr || "");
        assert.match(stderr, /advisory_schema_validation_failed/);
        assert.match(stderr, /Raw advisory response before validation:/);
        assert.match(stderr, new RegExp(`raw-schema-failure-marker-${adapter.name}`));
        assert.match(stderr, /required_findings\[0\]\.severity/);
        return true;
      }
    );
  });
}

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
  const stdinPath = path.join(fakeDir, "opencode-stdin.txt");
  const fakeOpencode = writeExecutable(fakeDir, "fake-opencode.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, args.join("\\n") + "\\n", "utf-8");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinPath)}, Buffer.concat(chunks));
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
});
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
  assert.equal(loggedArgs, "run\n-m\nexample/opencode-model-fast\n");
  const stdin = fs.readFileSync(stdinPath, "utf-8");
  assert.match(stdin, /NON-INTERACTIVE REVIEW/);
  assert.doesNotMatch(stdin, /NON-INTERACTIVE ADVISORY REVIEW/);
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

test("pi adapter forwards read-only tools and model while preserving the primary review prompt on stdin", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-pi-"));
  const logPath = path.join(fakeDir, "pi-args.log");
  const stdinPath = path.join(fakeDir, "pi-stdin.txt");
  const fakePi = writeExecutable(fakeDir, "fake-pi.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, args.join("\\n") + "\\n", "utf-8");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinPath)}, Buffer.concat(chunks));
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
});
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
  assert.equal(loggedArgs, "--no-session\n--no-context-files\n--no-extensions\n--no-skills\n--no-prompt-templates\n--no-themes\n--tools\nread,grep,find,ls\n--model\nopenai/gpt-5\n--print\n");
  const stdin = fs.readFileSync(stdinPath, "utf-8");
  assert.match(stdin, /NON-INTERACTIVE REVIEW/);
  assert.match(stdin, /Return a passing review\./);
});

test("pi adapter can load one explicitly trusted provider extension while discovery stays disabled", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-pi-provider-"));
  const logPath = path.join(fakeDir, "pi-args.log");
  const providerExtension = path.join(fakeDir, "provider.ts");
  fs.writeFileSync(providerExtension, "export default function provider() {}\n", "utf-8");
  const fakePi = writeExecutable(fakeDir, "fake-pi.js", `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join("\\n") + "\\n", "utf-8");
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

  execFileSync("node", [
    PI_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
    "--model", "example/review-model",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      RELAY_PI_BIN: fakePi,
      RELAY_PI_REVIEW_PROVIDER_EXTENSION: providerExtension,
    },
  });

  const loggedArgs = fs.readFileSync(logPath, "utf-8").split("\n");
  assert.deepEqual(loggedArgs.slice(0, 5), [
    "--no-session",
    "--no-context-files",
    "--no-extensions",
    "--extension",
    providerExtension,
  ]);
});

test("pi adapter rejects non-absolute provider extension paths before invoking Pi", () => {
  const { repoRoot, promptPath } = setupRepo();
  assert.throws(
    () => execFileSync("node", [
      PI_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: {
        ...process.env,
        RELAY_PI_BIN: path.join(repoRoot, "must-not-run"),
        RELAY_PI_REVIEW_PROVIDER_EXTENSION: "./provider.ts",
      },
    }),
    (error) => {
      assert.match(
        String(error.stderr || ""),
        /RELAY_PI_REVIEW_PROVIDER_EXTENSION must be an absolute path/
      );
      return true;
    }
  );
});

test("pi adapter supports advisory review JSON when phase is advisory_review", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-pi-advisory-"));
  const logPath = path.join(fakeDir, "pi-args.log");
  const stdinPath = path.join(fakeDir, "pi-stdin.txt");
  const fakePi = writeExecutable(fakeDir, "fake-pi.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, args.join("\\n") + "\\n", "utf-8");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinPath)}, Buffer.concat(chunks));
  process.stdout.write(JSON.stringify({
    profile: "blindspot",
    summary: "No blocking blind spots.",
    required_findings: [],
    advisory_findings: [],
    duplicate_or_low_confidence: [],
  }));
});
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
  assert.equal(loggedArgs, "--no-session\n--no-context-files\n--no-extensions\n--no-skills\n--no-prompt-templates\n--no-themes\n--tools\nread,grep,find,ls\n--model\nopenai/gpt-5\n--print\n");
  assert.match(fs.readFileSync(stdinPath, "utf-8"), /NON-INTERACTIVE ADVISORY REVIEW/);
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

test("antigravity adapter automatically uses an evidence-recorded prompt-file reference fallback", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-antigravity-"));
  const logPath = path.join(fakeDir, "agy-args.log");
  const promptCapturePath = path.join(fakeDir, "agy-prompt.txt");
  const transportEvidencePath = path.join(fakeDir, "prompt-transport.json");
  const fakeAgy = writeExecutable(fakeDir, "fake-agy.js", `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args), "utf-8");
const addDirIndex = args.indexOf("--add-dir");
fs.copyFileSync(path.join(args[addDirIndex + 1], "review-prompt.md"), ${JSON.stringify(promptCapturePath)});
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
    env: {
      ...process.env,
      RELAY_ANTIGRAVITY_BIN: fakeAgy,
      RELAY_ANTIGRAVITY_REVIEW_TIMEOUT: "45s",
      RELAY_REVIEW_PROMPT_TRANSPORT_EVIDENCE_PATH: transportEvidencePath,
    },
  });

  const result = JSON.parse(stdout);
  const loggedArgs = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  assert.equal(result.verdict, "pass");
  assert.equal(loggedArgs[0], "--add-dir");
  assert.equal(loggedArgs[2], "--prompt");
  assert.deepEqual(loggedArgs.slice(4), ["--print-timeout", "45s", "--sandbox"]);
  assert.match(loggedArgs[3], /review-prompt\.md/);
  assert.doesNotMatch(loggedArgs[3], /Return a passing review\./);
  const capturedPrompt = fs.readFileSync(promptCapturePath, "utf-8");
  assert.match(capturedPrompt, /NON-INTERACTIVE REVIEW/);
  assert.match(capturedPrompt, /Return a passing review\./);
  assert.equal(loggedArgs.includes("--print"), false);
  const transportEvidence = JSON.parse(fs.readFileSync(transportEvidencePath, "utf-8"));
  assert.equal(transportEvidence.mode, "prompt_file_reference");
  assert.equal(transportEvidence.compatibility_fallback, true);
  assert.equal(transportEvidence.automatic, true);
  assert.equal(transportEvidence.prompt_text_in_argv, false);
});

test("antigravity adapter supports advisory review JSON when phase is advisory_review", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-antigravity-advisory-"));
  const logPath = path.join(fakeDir, "agy-args.log");
  const promptCapturePath = path.join(fakeDir, "agy-prompt.txt");
  const fakeAgy = writeExecutable(fakeDir, "fake-agy.js", `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args), "utf-8");
const addDirIndex = args.indexOf("--add-dir");
fs.copyFileSync(path.join(args[addDirIndex + 1], "review-prompt.md"), ${JSON.stringify(promptCapturePath)});
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
  assert.equal(loggedArgs[0], "--add-dir");
  assert.equal(loggedArgs[2], "--prompt");
  assert.deepEqual(loggedArgs.slice(4), ["--print-timeout", "45s", "--sandbox"]);
  assert.match(fs.readFileSync(promptCapturePath, "utf-8"), /NON-INTERACTIVE ADVISORY REVIEW/);
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

test("cursor adapter forwards ask mode and workspace while preserving the primary review prompt on stdin", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cursor-"));
  const logPath = path.join(fakeDir, "agent-args.log");
  const stdinPath = path.join(fakeDir, "agent-stdin.txt");
  const verdict = reviewerVerdict();
  const fakeAgent = writeExecutable(fakeDir, "fake-agent.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "status") {
  process.stdout.write("Logged in as test@example.com\\n");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args), "utf-8");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinPath)}, Buffer.concat(chunks));
  process.stdout.write(JSON.stringify({
    result: JSON.stringify(${JSON.stringify(verdict)}),
  }));
});
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
  assert.equal(loggedArgs.length, 11);
  const stdin = fs.readFileSync(stdinPath, "utf-8");
  assert.match(stdin, /NON-INTERACTIVE REVIEW/);
  assert.match(stdin, /Return a passing review\./);
});

test("cursor adapter accepts an internal-review PASS with next_action=publish_pending", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cursor-publish-pending-"));
  const verdict = reviewerVerdict({ next_action: "publish_pending" });
  const fakeAgent = writeExecutable(fakeDir, "fake-agent.js", `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "status") {
  process.stdout.write("Logged in as test@example.com\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  result: JSON.stringify(${JSON.stringify(verdict)}),
}));
`);

  const stdout = execFileSync("node", [
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

  assert.deepEqual(JSON.parse(stdout), verdict);
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

test("cline adapter uses a cleaned evidence-recorded prompt-file reference and parses run_result.text", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-"));
  const logPath = path.join(fakeDir, "cline-args.log");
  const promptCapturePath = path.join(fakeDir, "cline-prompt.txt");
  const promptPathCapture = path.join(fakeDir, "cline-prompt-path.txt");
  const transportEvidencePath = path.join(fakeDir, "prompt-transport.json");
  const sourcePrompt = "Return a passing review.\0Preserve the complete prompt bytes.";
  fs.writeFileSync(promptPath, `${sourcePrompt}\n`, "utf-8");
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args), "utf-8");
${clineCliPromptResolver({ promptPathCapture, promptCapturePath })}
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
    "--model", "cline-pass/z-ai/glm-5.2",
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
      RELAY_REVIEW_PROMPT_TRANSPORT_EVIDENCE_PATH: transportEvidencePath,
    },
  });

  const result = JSON.parse(stdout);
  const loggedArgs = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  assert.equal(result.profile, "blindspot");
  assert.deepEqual(loggedArgs.slice(0, 10), [
    "--json",
    "--yolo",
    "-P", "cline-pass",
    "-m", "z-ai/glm-5.2",
    "--cwd", repoRoot,
    "--timeout", "60",
  ]);
  assert.equal(loggedArgs.length, 11);
  assert.match(
    loggedArgs[10],
    /^Read and follow the complete review instructions in @\.relay-review-cline-prompt-[^/\s]+\/review-prompt\.md\./
  );
  assert.equal(loggedArgs.some((entry) => entry.includes(sourcePrompt)), false);
  assert.equal(loggedArgs.some((entry) => entry.includes("\0")), false);
  const expectedPrompt = [
    "[NON-INTERACTIVE ADVISORY REVIEW]",
    "Return only JSON matching the advisory review shape in the prompt.",
    "Do not wrap the response in markdown fences.",
    "Do not modify files, create commits, or write comments. Treat the checkout as read-only.",
    "Relay will check git status after this process and escalate any worktree mutation as a policy violation.",
    "Do not use cline --worktree; relay already selected the review checkout with --cwd.",
    "",
    sourcePrompt,
  ].join("\n");
  assert.equal(fs.readFileSync(promptCapturePath, "utf-8"), expectedPrompt);
  const temporaryPromptPath = fs.readFileSync(promptPathCapture, "utf-8");
  assert.equal(fs.existsSync(temporaryPromptPath), false);
  const transportEvidence = JSON.parse(fs.readFileSync(transportEvidencePath, "utf-8"));
  assert.equal(transportEvidence.adapter, "cline");
  assert.equal(transportEvidence.mode, "prompt_file_reference");
  assert.equal(transportEvidence.compatibility_fallback, true);
  assert.equal(transportEvidence.prompt_text_in_argv, false);
  assert.equal(transportEvidence.prompt_contains_nul, true);
  assert.equal(transportEvidence.reason, CLINE_FILE_REFERENCE_REASON);
  assert.equal(loggedArgs.includes("--worktree"), false);
});

test("cline adapter cleans its prompt-file reference on provider failure and preserves the provider error", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-provider-fail-"));
  const promptPathCapture = path.join(fakeDir, "cline-prompt-path.txt");
  const transportEvidencePath = path.join(fakeDir, "prompt-transport.json");
  const providerError = "Provider error: insufficient balance for z-ai/glm-5.2";
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
const fs = require("fs");
${clineCliPromptResolver({ promptPathCapture })}
process.stderr.write(${JSON.stringify(`${providerError}\n`)});
process.exit(1);
`);

  let error;
  try {
    execFileSync("node", [
      CLINE_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--model", "cline-pass/z-ai/glm-5.2",
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: {
        ...process.env,
        RELAY_CLINE_BIN: fakeCline,
        RELAY_CLINE_REVIEW_TIMEOUT: "120s",
        RELAY_REVIEW_PROMPT_TRANSPORT_EVIDENCE_PATH: transportEvidencePath,
      },
    });
    assert.fail("expected invoke-reviewer-cline.js to fail");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  const temporaryPromptPath = fs.readFileSync(promptPathCapture, "utf-8");
  assert.equal(fs.existsSync(temporaryPromptPath), false);
  assert.match(String(error.stderr || ""), new RegExp(providerError.replaceAll(".", "\\.")));
  assert.match(String(error.stderr || ""), /Cline stderr:/);
  assert.doesNotMatch(String(error.stderr || ""), /stdin transport|interactive mode is unsupported/i);
  const transportEvidence = JSON.parse(fs.readFileSync(transportEvidencePath, "utf-8"));
  assert.equal(transportEvidence.adapter, "cline");
  assert.equal(transportEvidence.mode, "prompt_file_reference");
  assert.equal(transportEvidence.reason, CLINE_FILE_REFERENCE_REASON);
});

test("cline adapter normalizes omitted duplicate severity through the shared advisory schema", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-duplicate-severity-"));
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "run_result",
  finishReason: "completed",
  text: JSON.stringify({
    profile: "blindspot",
    summary: "Duplicate only.",
    required_findings: [],
    advisory_findings: [],
    duplicate_or_low_confidence: [{
      title: "Already covered",
      body: "The primary review already verified this path.",
      file: "skills/relay-review/scripts/advisory-review-schema.js",
      category: "other",
      confidence: 0.4,
    }],
  }),
}) + "\\n");
`);

  const stdout = execFileSync("node", [
    CLINE_SCRIPT,
    "--repo", repoRoot,
    "--prompt-file", promptPath,
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
  assert.equal(result.required_findings.length, 0);
  assert.equal(result.duplicate_or_low_confidence[0].severity, "P3");
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
  assert.match(String(error.stderr || ""), /cline-pass\/modelType\/model/);
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

test("cline adapter derives internal timeout 1740s from adversarial default 1800s env", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-1800-"));
  const logPath = path.join(fakeDir, "cline-args.log");
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)), "utf-8");
process.stdout.write(JSON.stringify({
  type: "run_result",
  finishReason: "completed",
  text: JSON.stringify({
    profile: "adversarial",
    summary: "Default budget.",
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
    "--profile", "adversarial",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_CLINE_BIN: fakeCline, RELAY_CLINE_REVIEW_TIMEOUT: "1800s" },
  });

  const loggedArgs = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  assert.equal(loggedArgs[loggedArgs.indexOf("--timeout") + 1], "1740");
});

test("cline adapter derives internal timeout 3540s from 3600s advisory override env", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-3600-"));
  const logPath = path.join(fakeDir, "cline-args.log");
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)), "utf-8");
process.stdout.write(JSON.stringify({
  type: "run_result",
  finishReason: "completed",
  text: JSON.stringify({
    profile: "adversarial",
    summary: "Override budget.",
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
    "--profile", "adversarial",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_CLINE_BIN: fakeCline, RELAY_CLINE_REVIEW_TIMEOUT: "3600s" },
  });

  const loggedArgs = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  assert.equal(loggedArgs[loggedArgs.indexOf("--timeout") + 1], "3540");
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
  const promptPathCapture = path.join(fakeDir, "cline-prompt-path.txt");
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
const fs = require("fs");
${clineCliPromptResolver({ promptPathCapture })}
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
  const temporaryPromptPath = fs.readFileSync(promptPathCapture, "utf-8");
  assert.equal(fs.existsSync(temporaryPromptPath), false);
  const stderr = String(error.stderr || "");
  assert.match(stderr, /adapter=cline phase=advisory_review/);
  assert.match(stderr, /advisory review must be valid JSON/);
});

test("cline adapter cleans its prompt-file reference after parent timeout", { timeout: 135000 }, () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-cline-parent-timeout-"));
  const promptPathCapture = path.join(fakeDir, "cline-prompt-path.txt");
  const fakeCline = writeExecutable(fakeDir, "fake-cline.js", `#!/usr/bin/env node
const fs = require("fs");
${clineCliPromptResolver({ promptPathCapture })}
setInterval(() => {}, 1000);
`);

  let error;
  try {
    execFileSync("node", [
      CLINE_SCRIPT,
      "--repo", repoRoot,
      "--prompt-file", promptPath,
      "--model", "cline-pass/z-ai/glm-5.2",
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 130000,
      env: {
        ...process.env,
        RELAY_CLINE_BIN: fakeCline,
        RELAY_CLINE_REVIEW_TIMEOUT: "120s",
      },
    });
    assert.fail("expected invoke-reviewer-cline.js to time out");
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  const temporaryPromptPath = fs.readFileSync(promptPathCapture, "utf-8");
  assert.equal(fs.existsSync(temporaryPromptPath), false);
  assert.match(String(error.stderr || ""), /timed out after 120s/);
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
      "--model", "cline-pass/z-ai/glm-5.2",
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
      "--model", "cline-pass/z-ai/glm-5.2",
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
