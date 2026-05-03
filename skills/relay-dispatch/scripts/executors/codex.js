const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { execGit } = require("../exec");
const { registerCodexApp } = require("../codex-app-register");

const PROBE_PROMPT =
  "List ALL your available tools, MCP servers, and installed skills. " +
  "Output a JSON array of objects with {name, type, description} fields. " +
  "type is one of: skill, mcp_tool, built_in.";

function realpathForContainment(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function resolveCodexCommonGitDir(worktreePath) {
  const real = realpathForContainment(worktreePath);
  try {
    const out = execGit(real, ["rev-parse", "--git-common-dir"]);
    const trimmed = out.trim();
    if (path.isAbsolute(trimmed)) return trimmed;
    return path.resolve(real, trimmed);
  } catch {
    return path.resolve(real, ".git");
  }
}

function validateExecutionMode({ sandbox, networkAccess }) {
  const warnings = [];
  if (networkAccess === "enabled" && sandbox !== "workspace-write") {
    return { ok: false, error: "--network-access enabled requires --sandbox workspace-write" };
  }
  return { ok: true, warnings };
}

function buildExecCommand({ wtPath, resultFile, prompt, model, sandbox, networkAccess, reasoning }) {
  const cmd = "codex";
  const args = ["exec", "-C", wtPath, "--color", "never", "-o", resultFile];
  args.push("-c", `model_reasoning_effort=${reasoning}`);
  if (networkAccess === "enabled") {
    args.push("-c", "sandbox_workspace_write.network_access=true");
  }
  if (model) args.push("-m", model);
  args.push("--sandbox", sandbox);
  let codexGitCommonDir = null;
  if (sandbox === "workspace-write") {
    codexGitCommonDir = resolveCodexCommonGitDir(wtPath);
    args.push("--add-dir", codexGitCommonDir);
  }
  args.push(prompt);
  return { cmd, args, cwd: undefined, codexGitCommonDir };
}

function finalizeResult() {
  // codex writes to resultFile via -o flag; nothing to do
}

function register({ wtPath, repoPath, branch, title, pin = false }) {
  const reg = registerCodexApp({ wtPath, repoPath, branch, title, pin });
  return { threadId: reg.threadId || null, raw: reg };
}

function probe({ timeout }) {
  const cmd = "codex";
  const cmdArgs = ["exec", "--sandbox", "read-only", "--color", "never", PROBE_PROMPT];
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
  defaultTimeout: 2400,
  validateExecutionMode,
  buildExecCommand,
  finalizeResult,
  register,
  probe,
};
