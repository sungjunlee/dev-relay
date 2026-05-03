const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { getExecutor, listExecutors } = require("../../../skills/relay-dispatch/scripts/executors");

let TMP_ROOT, REPO, WT, COMMON_DIR;

before(() => {
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "executors-test-"));
  REPO = path.join(TMP_ROOT, "repo");
  fs.mkdirSync(REPO);
  execFileSync("git", ["-C", REPO, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", REPO, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", REPO, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(REPO, "README"), "x\n");
  execFileSync("git", ["-C", REPO, "add", "README"]);
  execFileSync("git", ["-C", REPO, "commit", "-q", "-m", "init"]);
  WT = path.join(TMP_ROOT, "wt");
  execFileSync("git", ["-C", REPO, "worktree", "add", "-q", "-b", "wb", WT]);
  const commonRaw = execFileSync("git", ["-C", WT, "rev-parse", "--git-common-dir"], {
    encoding: "utf-8",
  }).trim();
  COMMON_DIR = path.resolve(WT, commonRaw);
});

after(() => {
  if (TMP_ROOT) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

test("registry exposes codex and claude", () => {
  assert.deepEqual(listExecutors().sort(), ["claude", "codex"]);
  assert.throws(() => getExecutor("opencode"), /unknown executor/);
});

test("codex buildExecCommand: workspace-write + network disabled + no model - full argv lock", () => {
  const codex = getExecutor("codex");
  const result = codex.buildExecCommand({
    wtPath: WT,
    resultFile: "/tmp/result.txt",
    prompt: "P",
    model: null,
    sandbox: "workspace-write",
    networkAccess: "disabled",
    reasoning: "high",
  });
  assert.equal(result.cmd, "codex");
  assert.equal(result.cwd, undefined);
  assert.deepEqual(result.args, [
    "exec", "-C", WT, "--color", "never", "-o", "/tmp/result.txt",
    "-c", "model_reasoning_effort=high",
    "--sandbox", "workspace-write",
    "--add-dir", COMMON_DIR,
    "P",
  ]);
  assert.equal(result.codexGitCommonDir, COMMON_DIR);
});

test("codex buildExecCommand: network enabled inserts the network arg before --sandbox", () => {
  const codex = getExecutor("codex");
  const { args } = codex.buildExecCommand({
    wtPath: WT,
    resultFile: "/tmp/r",
    prompt: "P",
    model: null,
    sandbox: "workspace-write",
    networkAccess: "enabled",
    reasoning: "medium",
  });
  assert.deepEqual(args, [
    "exec", "-C", WT, "--color", "never", "-o", "/tmp/r",
    "-c", "model_reasoning_effort=medium",
    "-c", "sandbox_workspace_write.network_access=true",
    "--sandbox", "workspace-write",
    "--add-dir", COMMON_DIR,
    "P",
  ]);
});

test("codex buildExecCommand: model adds -m before --sandbox", () => {
  const codex = getExecutor("codex");
  const { args } = codex.buildExecCommand({
    wtPath: WT,
    resultFile: "/tmp/r",
    prompt: "P",
    model: "gpt-5",
    sandbox: "workspace-write",
    networkAccess: "disabled",
    reasoning: "high",
  });
  assert.deepEqual(args, [
    "exec", "-C", WT, "--color", "never", "-o", "/tmp/r",
    "-c", "model_reasoning_effort=high",
    "-m", "gpt-5",
    "--sandbox", "workspace-write",
    "--add-dir", COMMON_DIR,
    "P",
  ]);
});

test("codex buildExecCommand: read-only sandbox omits --add-dir entirely", () => {
  const codex = getExecutor("codex");
  const { args, codexGitCommonDir } = codex.buildExecCommand({
    wtPath: WT,
    resultFile: "/tmp/r",
    prompt: "P",
    model: null,
    sandbox: "read-only",
    networkAccess: "disabled",
    reasoning: "low",
  });
  assert.deepEqual(args, [
    "exec", "-C", WT, "--color", "never", "-o", "/tmp/r",
    "-c", "model_reasoning_effort=low",
    "--sandbox", "read-only",
    "P",
  ]);
  assert.equal(codexGitCommonDir, null);
});

test("codex buildExecCommand: workspace-write on non-worktree path throws", () => {
  const codex = getExecutor("codex");
  assert.throws(() => codex.buildExecCommand({
    wtPath: "/tmp",
    resultFile: "/tmp/r",
    prompt: "P",
    model: null,
    sandbox: "workspace-write",
    networkAccess: "disabled",
    reasoning: "high",
  }));
});

test("claude buildExecCommand: cwd via spawn opt, not flag", () => {
  const claude = getExecutor("claude");
  const { cmd, args, cwd } = claude.buildExecCommand({
    wtPath: "/tmp/wt",
    resultFile: "/tmp/r",
    prompt: "P",
    model: null,
    sandbox: "workspace-write",
    networkAccess: "disabled",
    reasoning: "high",
  });
  assert.equal(cmd, "claude");
  assert.equal(cwd, "/tmp/wt");
  assert.deepEqual(args, ["-p", "--dangerously-skip-permissions", "--output-format", "text", "P"]);
  assert.ok(!args.includes("--cwd"));
});

test("claude buildExecCommand: model is appended via --model", () => {
  const claude = getExecutor("claude");
  const { args } = claude.buildExecCommand({
    wtPath: "/tmp/wt",
    resultFile: "/tmp/r",
    prompt: "P",
    model: "claude-opus-4-7",
    sandbox: "workspace-write",
    networkAccess: "disabled",
    reasoning: "high",
  });
  const i = args.indexOf("--model");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], "claude-opus-4-7");
});

test("validateExecutionMode: codex rejects network without workspace-write", () => {
  const codex = getExecutor("codex");
  const result = codex.validateExecutionMode({ sandbox: "read-only", networkAccess: "enabled" });
  assert.equal(result.ok, false);
  assert.match(result.error, /workspace-write/);
});

test("validateExecutionMode: claude rejects networkAccess=enabled", () => {
  const claude = getExecutor("claude");
  const result = claude.validateExecutionMode({ sandbox: "workspace-write", networkAccess: "enabled" });
  assert.equal(result.ok, false);
  assert.match(result.error, /codex/);
});

test("validateExecutionMode: claude warns on non-workspace-write sandbox", () => {
  const claude = getExecutor("claude");
  const result = claude.validateExecutionMode({ sandbox: "read-only", networkAccess: "disabled" });
  assert.equal(result.ok, true);
  assert.ok(result.warnings && result.warnings.length > 0);
});

test("default timeouts match pre-refactor values", () => {
  assert.equal(getExecutor("codex").defaultTimeout, 2400);
  assert.equal(getExecutor("claude").defaultTimeout, 1800);
});
