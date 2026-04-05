const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  captureAttempt,
  getEventsPath,
  getRunDir,
  listManifestPaths,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");

const SCRIPT = path.join(__dirname, "dispatch.js");

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Dispatch Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-dispatch@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return { repoRoot, relayHome };
}

function writeFakeClaude(binDir) {
  const claudePath = path.join(binDir, "claude");
  fs.writeFileSync(claudePath, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("claude-fake\\n");
  process.exit(0);
}
if (args[0] !== "-p") {
  process.stderr.write("unsupported fake claude invocation");
  process.exit(1);
}
// CWD is set via spawn options, not --cwd flag
const cwd = process.cwd();
const fileName = fs.existsSync(cwd + "/first.txt") ? "resume.txt" : "first.txt";
fs.writeFileSync(cwd + "/" + fileName, fileName + "\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", fileName], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake " + fileName], { stdio: "pipe" });
process.stdout.write("ok\\n");
`, "utf-8");
  fs.chmodSync(claudePath, 0o755);
  return claudePath;
}

function writeFakeCodex(binDir) {
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
if (args[0] !== "exec") {
  process.stderr.write("unsupported fake codex invocation");
  process.exit(1);
}
const cwd = args[args.indexOf("-C") + 1];
const output = args[args.indexOf("-o") + 1];
const fileName = fs.existsSync(cwd + "/first.txt") ? "resume.txt" : "first.txt";
fs.writeFileSync(cwd + "/" + fileName, fileName + "\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", fileName], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake " + fileName], { stdio: "pipe" });
fs.writeFileSync(output, "ok\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  return codexPath;
}

function runDispatch(repoRoot, args, env) {
  return execFileSync("node", [SCRIPT, repoRoot, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env,
  });
}

test("dispatch reuses the same run and worktree on resume", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-42",
    "--prompt", "first pass",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);

  const manifestPath = first.manifestPath;
  const runId = first.runId;
  const worktree = first.worktree;

  const record = readManifest(manifestPath);
  let updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(manifestPath, updated, record.body);

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", runId,
    "--prompt", "resume pass",
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  assert.equal(second.runId, runId);
  assert.equal(second.worktree, worktree);
  assert.equal(second.runState, STATES.REVIEW_PENDING);
  assert.equal(listManifestPaths(repoRoot).length, 1);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.ok(manifest.git.head_sha);

  const events = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8");
  assert.match(events, /"event":"dispatch_start"/);
  assert.match(events, /"reason":"same_run_resume"/);
  assert.match(events, /"reason":"same_run_resume:completed"/);
});

test("dispatch resume fails loudly when the retained worktree is missing", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-42",
    "--prompt", "first pass",
    "--json",
  ], env));
  const manifestPath = first.manifestPath;
  const runId = first.runId;

  const record = readManifest(manifestPath);
  let updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(manifestPath, updated, record.body);
  execFileSync("git", ["worktree", "remove", "--force", first.worktree], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const result = spawnSync("node", [SCRIPT, repoRoot, "--run-id", runId, "--prompt", "resume", "--json"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /retained worktree is missing/);
  assert.equal(listManifestPaths(repoRoot).length, 1);
});

test("dispatch with --executor claude creates worktree and collects result", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-bin-"));
  writeFakeClaude(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "claude-test",
    "-e", "claude",
    "--prompt", "test task",
    "--json",
  ], env));

  assert.equal(result.status, "completed");
  assert.equal(result.executor, "claude");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.ok(result.commits);
  assert.ok(fs.existsSync(result.resultFile));
  const resultText = fs.readFileSync(result.resultFile, "utf-8");
  assert.match(resultText, /ok/);
});

test("dispatch artifacts are persisted in the run directory", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-artifact",
    "--prompt", "artifact test task",
    "--json",
  ], env));
  assert.equal(result.status, "completed");

  assert.ok(fs.existsSync(path.join(result.runDir, "dispatch-prompt.md")));
  const promptText = fs.readFileSync(path.join(result.runDir, "dispatch-prompt.md"), "utf-8");
  assert.match(promptText, /artifact test task/);

  assert.ok(fs.existsSync(path.join(result.runDir, "dispatch-result.txt")));
  const resultText = fs.readFileSync(path.join(result.runDir, "dispatch-result.txt"), "utf-8");
  assert.match(resultText, /ok/);
});

test("dispatch with --executor claude supports resume", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-bin-"));
  writeFakeClaude(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-99",
    "-e", "claude",
    "--prompt", "first pass",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);

  const record = readManifest(first.manifestPath);
  let updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(first.manifestPath, updated, record.body);

  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", first.runId,
    "-e", "claude",
    "--prompt", "resume pass",
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  assert.equal(second.runId, first.runId);
  assert.equal(second.worktree, first.worktree);
  assert.equal(second.executor, "claude");
  assert.equal(second.runState, STATES.REVIEW_PENDING);
});

test("timeout with commits produces completed-with-warning", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  // Fake codex that commits a file then sleeps forever (killed by timeout)
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("codex-fake\\n"); process.exit(0); }
const cwd = args[args.indexOf("-C") + 1];
const output = args[args.indexOf("-o") + 1];
fs.writeFileSync(cwd + "/timeout-work.txt", "partial\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", "timeout-work.txt"], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "partial work"], { stdio: "pipe" });
fs.writeFileSync(output, "partial result\\n", "utf-8");
setTimeout(() => {}, 60000);
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const result = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-timeout-work",
    "--prompt", "slow task",
    "--timeout", "1",
    "--json",
  ], env));

  assert.equal(result.status, "completed-with-warning");
  assert.equal(result.runState, STATES.REVIEW_PENDING);
  assert.match(result.error, /timed out/);
});

test("timeout without commits produces failed", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  // Fake codex that does nothing but sleep
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("codex-fake\\n"); process.exit(0); }
setTimeout(() => {}, 60000);
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  // dispatch exits non-zero on failure but still writes JSON to stdout
  const proc = spawnSync("node", [SCRIPT, repoRoot,
    "-b", "issue-timeout-empty",
    "--prompt", "idle task",
    "--timeout", "1",
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", env });

  assert.notEqual(proc.status, 0);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.runState, STATES.ESCALATED);
  assert.match(result.error, /timed out/);
});

test("re-dispatch prompt includes previous iteration history", () => {
  const { repoRoot, relayHome } = setupRepo();
  process.env.RELAY_HOME = relayHome;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bin-"));
  writeFakeCodex(binDir);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = JSON.parse(runDispatch(repoRoot, [
    "-b", "issue-77",
    "--prompt", "first pass",
    "--json",
  ], env));
  assert.equal(first.runState, STATES.REVIEW_PENDING);

  const runId = first.runId;
  const manifestPath = first.manifestPath;

  // Simulate: reviewer captures attempt data, then transitions to changes_requested
  captureAttempt(repoRoot, runId, {
    score_log: "| Factor | Target | Final |\n| Perf | < 0.2s | 0.35s |",
    reviewer_feedback: "Timeout middleware missing on /api/orders endpoint",
    failed_approaches: ["Fixed-delay retry"],
  });

  const record = readManifest(manifestPath);
  let updated = updateManifestState(record.data, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  writeManifest(manifestPath, updated, record.body);

  // Re-dispatch — should include history in prompt
  const second = JSON.parse(runDispatch(repoRoot, [
    "--run-id", runId,
    "--prompt", "fix the issues",
    "--json",
  ], env));

  assert.equal(second.mode, "resume");
  assert.equal(second.runState, STATES.REVIEW_PENDING);

  // Verify the persisted dispatch prompt includes the history section
  const dispatchPrompt = fs.readFileSync(path.join(second.runDir, "dispatch-prompt.md"), "utf-8");
  assert.match(dispatchPrompt, /Previous Attempt \(dispatch #1\)/);
  assert.match(dispatchPrompt, /Score Log/);
  assert.match(dispatchPrompt, /0\.35s/);
  assert.match(dispatchPrompt, /Timeout middleware missing/);
  assert.match(dispatchPrompt, /Do NOT Repeat/);
  assert.match(dispatchPrompt, /Fixed-delay retry/);
  assert.match(dispatchPrompt, /fix the issues/);
});
