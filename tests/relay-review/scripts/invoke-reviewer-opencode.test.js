const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const OPENCODE_SCRIPT = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "skills",
  "relay-review",
  "scripts",
  "invoke-reviewer-opencode.js"
);

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-opencode-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review Test"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "ok\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const promptPath = path.join(repoRoot, "prompt.md");
  fs.writeFileSync(promptPath, "Return a passing advisory review.\n", "utf-8");
  return { repoRoot, promptPath };
}

function writeExecutable(dir, name, body) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

const ADVISORY_JSON = JSON.stringify({
  profile: "blindspot",
  summary: "Retry recovered empty stdout.",
  required_findings: [],
  advisory_findings: [],
  duplicate_or_low_confidence: [],
});

test("opencode adapter retries once with nudge when first call yields empty stdout", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-opencode-retry-"));
  const logPath = path.join(fakeDir, "calls.jsonl");
  const fakeOpencode = writeExecutable(
    fakeDir,
    "fake-opencode.js",
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const prompt = args[args.length - 1] || "";
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ prompt }) + "\\n", "utf-8");
const callIndex = fs.readFileSync(${JSON.stringify(logPath)}, "utf-8").trim().split("\\n").length;
if (callIndex === 1) {
  process.exit(0);
}
if (!prompt.includes("[EMPTY-STDOUT RETRY NUDGE]")) {
  process.stderr.write("expected retry nudge in prompt\\n");
  process.exit(2);
}
process.stdout.write(${JSON.stringify(ADVISORY_JSON)});
`
  );

  const stdout = execFileSync(
    "node",
    [
      OPENCODE_SCRIPT,
      "--repo",
      repoRoot,
      "--prompt-file",
      promptPath,
      "--model",
      "example/opencode-model-fast",
      "--phase",
      "advisory_review",
      "--json",
    ],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, RELAY_OPENCODE_BIN: fakeOpencode },
    }
  );

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.profile, "blindspot");
  assert.match(parsed.summary, /Retry recovered empty stdout/);

  const calls = fs
    .readFileSync(logPath, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 2, "exactly one retry after empty stdout");
  assert.equal(calls[0].prompt.includes("[EMPTY-STDOUT RETRY NUDGE]"), false);
  assert.equal(calls[1].prompt.includes("[EMPTY-STDOUT RETRY NUDGE]"), true);
  assert.match(calls[1].prompt, /Do not call tools/);
});

test("opencode adapter still raises existing empty-stdout diagnostic when both calls are empty", () => {
  const { repoRoot, promptPath } = setupRepo();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-fake-opencode-both-empty-"));
  const logPath = path.join(fakeDir, "calls.jsonl");
  const fakeOpencode = writeExecutable(
    fakeDir,
    "fake-opencode.js",
    `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(logPath)}, "empty\\n", "utf-8");
process.exit(0);
`
  );

  let error;
  try {
    execFileSync(
      "node",
      [
        OPENCODE_SCRIPT,
        "--repo",
        repoRoot,
        "--prompt-file",
        promptPath,
        "--model",
        "example/opencode-model-fast",
        "--json",
      ],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
        env: { ...process.env, RELAY_OPENCODE_BIN: fakeOpencode },
      }
    );
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, "expected both-empty path to fail closed");
  const stderr = String(error.stderr || "");
  assert.match(stderr, /opencode advisory_review reviewer produced empty stdout/);
  assert.match(stderr, /cannot treat this as healthy review evidence/);
  assert.match(stderr, /verify OpenCode non-interactive model\/provider output/);
  assert.match(stderr, /OpenCode CLI\/provider non-interactive blocker/);

  const callLines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
  assert.equal(callLines.length, 2, "exactly one retry before failing closed");
});
