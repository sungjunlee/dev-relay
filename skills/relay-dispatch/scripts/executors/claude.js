const { execFileSync, spawnSync } = require("child_process");
const { registerClaudeApp } = require("../claude-app-register");
const {
  copyStdoutToResultFile,
  summarizeSpawnResult,
} = require("../agent-adapters/transport");

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
  copyStdoutToResultFile({ adapter: "claude", phase: "dispatch", stdoutLog, resultFile });
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
  const probeError = summarizeSpawnResult(result, {
    adapter: "claude",
    phase: "dispatch_probe",
    timeoutSeconds: timeout,
  });
  if (probeError) return { error: probeError, raw: null };
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
