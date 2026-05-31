const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { execGit } = require("../exec");
const {
  copyStdoutToResultFile,
} = require("../agent-adapters/transport");

const PROBE_FLAGS = [
  "--prompt",
  "--print-timeout",
  "--sandbox",
  "--dangerously-skip-permissions",
  "--add-dir",
];

function realpathForContainment(targetPath) {
  return fs.realpathSync.native ? fs.realpathSync.native(targetPath) : fs.realpathSync(targetPath);
}

function resolveWorktreeCommonGitDir(worktreePath) {
  const adminDirRaw = execGit(worktreePath, ["rev-parse", "--git-dir"]);
  const commonDirRaw = execGit(worktreePath, ["rev-parse", "--git-common-dir"]);
  const adminDir = path.resolve(worktreePath, adminDirRaw);
  const commonDir = path.resolve(worktreePath, commonDirRaw);
  const worktreesDir = path.join(commonDir, "worktrees");

  const realAdminDir = realpathForContainment(adminDir);
  const realWorktreesDir = realpathForContainment(worktreesDir);
  if (!realAdminDir.startsWith(`${realWorktreesDir}${path.sep}`)) {
    throw new Error(
      `antigravity worktree git admin dir is outside ${worktreesDir}: ${adminDir}`
    );
  }
  return commonDir;
}

function formatPrintTimeout(timeoutSeconds) {
  const normalized = Number(timeoutSeconds);
  if (Number.isFinite(normalized) && normalized > 0) {
    return `${Math.ceil(normalized)}s`;
  }
  return "1800s";
}

function parseProvider(model) {
  if (typeof model !== "string" || !model) return null;
  const idx = model.indexOf("/");
  if (idx <= 0) return null;
  return model.slice(0, idx);
}

function buildWorktreeBoundaryPrompt(wtPath, prompt) {
  return [
    "[RELAY WORKTREE BOUNDARY]",
    `Repository worktree: ${wtPath}`,
    `Before doing anything, run: cd ${wtPath}`,
    "Create, edit, git add, git commit, and run git status only from that repository worktree.",
    "Do not create, edit, git add, git commit, or report source files under ~/.gemini, scratch directories, or any path outside the repository worktree.",
    "If a tool starts elsewhere, first change directory to the repository worktree before touching files.",
    "",
    prompt,
  ].join("\n");
}

function validateExecutionMode({ sandbox, networkAccess }) {
  const warnings = [];
  if (sandbox !== "workspace-write") {
    return {
      ok: false,
      error: "antigravity executor supports only --sandbox workspace-write semantics; read-only dispatch is not safely representable",
    };
  }
  if (networkAccess === "enabled") {
    warnings.push(
      "antigravity executor: --network-access 'enabled' is informational only; agy does not expose relay network gating."
    );
  }
  return { ok: true, warnings };
}

function buildExecCommand({ wtPath, prompt, sandbox, timeoutSeconds }) {
  const cmd = "agy";
  const args = ["--prompt", buildWorktreeBoundaryPrompt(wtPath, prompt), "--print-timeout", formatPrintTimeout(timeoutSeconds)];
  let codexGitCommonDir = null;
  if (sandbox === "workspace-write") {
    args.push("--sandbox");
    codexGitCommonDir = resolveWorktreeCommonGitDir(wtPath);
    args.push("--add-dir", codexGitCommonDir);
  }
  return { cmd, args, cwd: wtPath, codexGitCommonDir };
}

function finalizeResult({ stdoutLog, resultFile }) {
  return copyStdoutToResultFile({ adapter: "antigravity", phase: "dispatch", stdoutLog, resultFile });
}

function register() {
  return { threadId: null, raw: { provider: "antigravity", note: "no app registration surface" } };
}

function discoverCliPath() {
  try {
    const result = spawnSync("/bin/sh", ["-c", "command -v agy"], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    if (result.status === 0) return (result.stdout || "").trim() || null;
  } catch {}
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, process.platform === "win32" ? "agy.exe" : "agy");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function probe() {
  const cmd = "agy";
  let version;
  try {
    version = execFileSync(cmd, ["--version"], { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return { error: `${cmd} CLI not found`, raw: null };
  }

  let help = "";
  const warnings = [];
  try {
    help = execFileSync(cmd, ["--help"], { encoding: "utf-8", stdio: "pipe" });
  } catch (error) {
    warnings.push(`agy --help failed: ${error.message}`);
  }

  const supportedFlags = PROBE_FLAGS.filter((flag) => help.includes(flag));
  const missingFlags = PROBE_FLAGS.filter((flag) => !supportedFlags.includes(flag));
  if (missingFlags.length) {
    warnings.push(`agy --help does not mention expected flags: ${missingFlags.join(", ")}`);
  }

  return {
    error: null,
    raw: JSON.stringify({
      version,
      cli_path: discoverCliPath(),
      supported_flags: supportedFlags,
      missing_flags: missingFlags,
      warnings,
    }),
  };
}

module.exports = {
  cliBinary: "agy",
  providerDefault: "google",
  defaultTimeout: 1800,
  validateExecutionMode,
  buildExecCommand,
  finalizeResult,
  register,
  probe,
  parseProvider,
  buildWorktreeBoundaryPrompt,
  formatPrintTimeout,
};
