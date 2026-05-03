const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getExecutor, listExecutors } = require("../../../skills/relay-dispatch/scripts/executors");

test("registry exposes codex and claude", () => {
  assert.deepEqual(listExecutors().sort(), ["claude", "codex"]);
  assert.throws(() => getExecutor("opencode"), /unknown executor/);
});

test("codex buildExecCommand: workspace-write + network disabled + no model", () => {
  const codex = getExecutor("codex");
  const { cmd, args, cwd } = codex.buildExecCommand({
    wtPath: "/tmp/wt",
    resultFile: "/tmp/result.txt",
    prompt: "P",
    model: null,
    sandbox: "workspace-write",
    networkAccess: "disabled",
    reasoning: "high",
  });
  assert.equal(cmd, "codex");
  assert.equal(cwd, undefined);
  assert.deepEqual(args.slice(0, 9), ["exec", "-C", "/tmp/wt", "--color", "never", "-o", "/tmp/result.txt", "-c", "model_reasoning_effort=high"]);
  assert.ok(args.includes("--sandbox"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(args.includes("--add-dir"));
  assert.ok(!args.includes("-m"));
  assert.ok(!args.some((a) => a === "sandbox_workspace_write.network_access=true"));
  assert.equal(args[args.length - 1], "P");
});

test("codex buildExecCommand: network enabled adds network flag", () => {
  const codex = getExecutor("codex");
  const { args } = codex.buildExecCommand({
    wtPath: "/tmp/wt",
    resultFile: "/tmp/r",
    prompt: "P",
    model: null,
    sandbox: "workspace-write",
    networkAccess: "enabled",
    reasoning: "medium",
  });
  assert.ok(args.includes("sandbox_workspace_write.network_access=true"));
});

test("codex buildExecCommand: model is appended via -m", () => {
  const codex = getExecutor("codex");
  const { args } = codex.buildExecCommand({
    wtPath: "/tmp/wt",
    resultFile: "/tmp/r",
    prompt: "P",
    model: "gpt-5",
    sandbox: "workspace-write",
    networkAccess: "disabled",
    reasoning: "high",
  });
  const i = args.indexOf("-m");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], "gpt-5");
});

test("codex buildExecCommand: read-only sandbox omits --add-dir", () => {
  const codex = getExecutor("codex");
  const { args } = codex.buildExecCommand({
    wtPath: "/tmp/wt",
    resultFile: "/tmp/r",
    prompt: "P",
    model: null,
    sandbox: "read-only",
    networkAccess: "disabled",
    reasoning: "low",
  });
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(!args.includes("--add-dir"));
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
