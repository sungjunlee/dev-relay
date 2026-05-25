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

test("registry exposes codex, claude, opencode, and pi", () => {
  assert.deepEqual(listExecutors(), ["codex", "claude", "opencode", "pi"]);
  assert.deepEqual(listExecutors().sort(), ["claude", "codex", "opencode", "pi"]);
  assert.throws(() => getExecutor("nonexistent"), /unknown executor/);
});

test("opencode adapter exposes the same 7 fields", () => {
  const o = getExecutor("opencode");
  for (const k of ["cliBinary", "defaultTimeout", "validateExecutionMode", "buildExecCommand", "finalizeResult", "register", "probe"]) {
    assert.ok(typeof o[k] !== "undefined", `missing field: ${k}`);
  }
  assert.equal(o.cliBinary, "opencode");
});

test("pi adapter exposes the same 7 fields", () => {
  const pi = getExecutor("pi");
  for (const k of ["cliBinary", "defaultTimeout", "validateExecutionMode", "buildExecCommand", "finalizeResult", "register", "probe"]) {
    assert.ok(typeof pi[k] !== "undefined", `missing field: ${k}`);
  }
  assert.equal(pi.cliBinary, "pi");
});

test("opencode validateExecutionMode accepts workspace-write+disabled with experimental warning", () => {
  const o = getExecutor("opencode");
  const r = o.validateExecutionMode({ sandbox: "workspace-write", networkAccess: "disabled" });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.warnings));
  assert.ok(r.warnings.some((w) => /experimental/i.test(w)));
});

test("opencode validateExecutionMode warns on non-workspace-write sandbox", () => {
  const o = getExecutor("opencode");
  const r = o.validateExecutionMode({ sandbox: "read-only", networkAccess: "disabled" });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /not enforced/i.test(w)));
});

test("opencode buildExecCommand: happy path", () => {
  const o = getExecutor("opencode");
  const r = o.buildExecCommand({
    wtPath: "/tmp/wt",
    resultFile: "/tmp/r",
    prompt: "P",
    model: null,
    sandbox: "workspace-write",
    networkAccess: "disabled",
    reasoning: "high",
  });
  assert.equal(r.cmd, "opencode");
  assert.deepEqual(r.args, ["run", "P"]);
  assert.equal(r.cwd, "/tmp/wt");
  assert.equal(r.codexGitCommonDir, null);
});

test("opencode buildExecCommand: model passthrough via -m", () => {
  const o = getExecutor("opencode");
  const r = o.buildExecCommand({
    wtPath: "/tmp/wt",
    resultFile: "/tmp/r",
    prompt: "P",
    model: "openai/gpt-5",
    sandbox: "workspace-write",
    networkAccess: "disabled",
    reasoning: "high",
  });
  assert.deepEqual(r.args, ["run", "-m", "openai/gpt-5", "P"]);
});

test("pi buildExecCommand: explicit non-interactive argv with thinking", () => {
  const pi = getExecutor("pi");
  const r = pi.buildExecCommand({
    wtPath: "/tmp/wt",
    resultFile: "/tmp/r",
    prompt: "P",
    model: null,
    sandbox: "workspace-write",
    networkAccess: "disabled",
    reasoning: "high",
  });
  assert.equal(r.cmd, "pi");
  assert.deepEqual(r.args, ["--no-session", "--thinking", "high", "--print", "P"]);
  assert.equal(r.cwd, "/tmp/wt");
  assert.equal(r.codexGitCommonDir, null);
});

test("pi buildExecCommand: model passthrough via --model", () => {
  const pi = getExecutor("pi");
  const r = pi.buildExecCommand({
    wtPath: "/tmp/wt",
    resultFile: "/tmp/r",
    prompt: "P",
    model: "openai/gpt-5",
    sandbox: "workspace-write",
    networkAccess: "disabled",
    reasoning: "xhigh",
  });
  assert.deepEqual(r.args, ["--no-session", "--model", "openai/gpt-5", "--thinking", "high", "--print", "P"]);
});

test("pi finalizeResult copies stdout into the relay result file", () => {
  const pi = getExecutor("pi");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pi-finalize-"));
  const stdoutLog = path.join(tmp, "stdout.log");
  const resultFile = path.join(tmp, "result.txt");
  fs.writeFileSync(stdoutLog, "pi result\n", "utf-8");
  const copied = pi.finalizeResult({ stdoutLog, resultFile });
  assert.deepEqual(copied, { copied: true, status: "copied", bytes: "pi result\n".length });
  assert.equal(fs.readFileSync(resultFile, "utf-8"), "pi result\n");
});

test("opencode register stub returns null thread id", () => {
  const o = getExecutor("opencode");
  const r = o.register({ wtPath: "/tmp/wt", repoPath: "/repo", branch: "b", title: "T" });
  assert.equal(r.threadId, null);
});

test("opencode parseProvider extracts provider from model", () => {
  const o = getExecutor("opencode");
  assert.equal(o.parseProvider("openai/gpt-5"), "openai");
  assert.equal(o.parseProvider("anthropic/claude-opus-4-7"), "anthropic");
  assert.equal(o.parseProvider("gpt-5"), null);
  assert.equal(o.parseProvider(""), null);
  assert.equal(o.parseProvider(null), null);
  assert.equal(o.parseProvider(undefined), null);
});

test("codex providerDefault is openai", () => {
  assert.equal(getExecutor("codex").providerDefault, "openai");
});

test("claude providerDefault is anthropic", () => {
  assert.equal(getExecutor("claude").providerDefault, "anthropic");
});

test("opencode finalizeResult is a safe no-op", () => {
  const o = getExecutor("opencode");
  // Should not throw with garbage input
  o.finalizeResult({ stdoutLog: "/nonexistent", resultFile: "/nonexistent" });
});

test("opencode probe returns {error: 'opencode CLI not found', raw: null} when binary missing", () => {
  // Isolate PATH to a directory without opencode so this test never depends on the
  // host machine having (or not having) opencode installed.
  const emptyBin = path.join(TMP_ROOT, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  const originalPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    const o = getExecutor("opencode");
    const result = o.probe({ timeout: 5 });
    assert.equal(result.raw, null);
    assert.match(result.error, /opencode CLI not found/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("pi probe returns {error: 'pi CLI not found', raw: null} when binary missing", () => {
  const emptyBin = path.join(TMP_ROOT, "empty-pi-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  const originalPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    const pi = getExecutor("pi");
    const result = pi.probe({ timeout: 5 });
    assert.equal(result.raw, null);
    assert.match(result.error, /pi CLI not found/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("pi probe payload exposes version and supported flags without live API call", () => {
  const fakeBin = path.join(TMP_ROOT, "fake-pi-bin");
  const fakePi = path.join(fakeBin, "pi");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(fakePi, `#!/bin/sh
case "$1" in
  --version) echo "pi 0.72.1" ;;
  --help) echo "Usage: pi --print --no-session --mode text|json|rpc --tools read,grep,find,ls --model --provider --thinking --no-context-files" ;;
  *) exit 2 ;;
esac
`);
  fs.chmodSync(fakePi, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ""}`;
  try {
    const pi = getExecutor("pi");
    const result = pi.probe({ timeout: 5 });
    assert.equal(result.error, null);
    const parsed = JSON.parse(result.raw);
    assert.equal(parsed.version, "pi 0.72.1");
    assert.deepEqual(parsed.supported_flags, [
      "--print",
      "--no-session",
      "--mode",
      "--tools",
      "--model",
      "--provider",
      "--thinking",
      "--no-context-files",
    ]);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("opencode probe payload exposes cli_path and discovery outputs", () => {
  const fakeBin = path.join(TMP_ROOT, "fake-bin");
  const fakeOpencode = path.join(fakeBin, "opencode");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(fakeOpencode, `#!/bin/sh
case "$1" in
  --version) echo "opencode 1.2.3" ;;
  --help) echo "Usage: opencode run auth models providers" ;;
  auth)
    if [ "$2" = "list" ]; then echo "github logged-in"; else exit 2; fi
    ;;
  models) echo "gpt-test" ;;
  providers) echo "openai" ;;
  run) echo '{"name":"tool","type":"built_in","description":"test"}' ;;
  *) exit 2 ;;
esac
`);
  fs.chmodSync(fakeOpencode, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath || ""}`;
  try {
    const o = getExecutor("opencode");
    const result = o.probe({ timeout: 5 });
    assert.equal(result.error, null);
    const parsed = JSON.parse(result.raw);
    assert.equal(parsed.version, "opencode 1.2.3");
    assert.equal(parsed.cli_path, fakeOpencode);
    assert.equal(parsed.auth_list, "github logged-in");
    assert.equal(parsed.models_output, "gpt-test");
    assert.equal(parsed.providers_output, "openai");
    assert.ok(Array.isArray(parsed.warnings), "raw payload must include warnings array");
  } finally {
    process.env.PATH = originalPath;
  }
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
  assert.equal(getExecutor("pi").defaultTimeout, 1800);
});
