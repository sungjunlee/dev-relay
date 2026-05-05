const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const { registerClaudeApp } = require("../claude-app-register");

const PROBE_PROMPT =
  "List ALL your available tools, MCP servers, and installed skills. " +
  "Output a JSON array of objects with {name, type, description} fields. " +
  "type is one of: skill, mcp_tool, built_in.";

function validateExecutionMode({ sandbox, networkAccess }) {
  if (networkAccess === "enabled") {
    return { ok: false, error: "--network-access enabled is only supported for codex executor" };
  }
  const warnings = [];
  if (sandbox !== "workspace-write") {
    warnings.push(`--sandbox '${sandbox}' is not supported for Claude executor; using --dangerously-skip-permissions`);
  }
  return { ok: true, warnings };
}

function buildExecCommand({ wtPath, prompt, model }) {
  const cmd = "claude";
  const args = ["-p", "--dangerously-skip-permissions", "--output-format", "text"];
  if (model) args.push("--model", model);
  args.push(prompt);
  return { cmd, args, cwd: wtPath, codexGitCommonDir: null };
}

function finalizeResult({ stdoutLog, resultFile }) {
  // claude writes its result to stdout; copy to resultFile so downstream collection works.
  if (fs.existsSync(stdoutLog)) {
    try { fs.copyFileSync(stdoutLog, resultFile); } catch {}
  }
}

function register({ wtPath, repoPath, branch, title }) {
  const reg = registerClaudeApp({ wtPath, repoPath, branch, title });
  return { threadId: reg.sessionId || null, raw: reg };
}

function probe({ timeout }) {
  const cmd = "claude";
  const cmdArgs = ["-p", "--output-format", "text", PROBE_PROMPT];
  try {
    execFileSync(cmd, ["--version"], { encoding: "utf-8", stdio: "pipe" });
  } catch {
    return { error: `${cmd} CLI not found`, raw: null };
  }
  const result = spawnSync(cmd, cmdArgs, {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: timeout * 1000,
  });
  if (result.error) {
    const msg = result.error.code === "ETIMEDOUT" ? `probe timed out after ${timeout}s` : result.error.message;
    return { error: msg, raw: null };
  }
  if (result.status !== 0) return { error: `executor exited with code ${result.status}`, raw: null };
  return { error: null, raw: (result.stdout || "").trim() || null };
}

module.exports = {
  cliBinary: "claude",
  providerDefault: "anthropic",
  defaultTimeout: 1800,
  validateExecutionMode,
  buildExecCommand,
  finalizeResult,
  register,
  probe,
};
