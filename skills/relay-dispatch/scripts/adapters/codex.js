const path = require("path");
const { execGit } = require("../exec");
const { createNativeAdapter } = require("../adapter-contract");

function resolveCommonGitDir(worktreePath) {
  const adminDir = path.resolve(worktreePath, execGit(worktreePath, ["rev-parse", "--git-dir"]));
  const commonDir = path.resolve(worktreePath, execGit(worktreePath, ["rev-parse", "--git-common-dir"]));
  const worktreesDir = path.join(commonDir, "worktrees");
  const realAdminDir = require("fs").realpathSync(adminDir);
  if (realAdminDir === require("fs").realpathSync(commonDir)) return commonDir;
  const realWorktreesDir = require("fs").realpathSync(worktreesDir);
  if (!realAdminDir.startsWith(`${realWorktreesDir}${path.sep}`)) {
    throw new Error(`codex worktree git admin dir is outside ${worktreesDir}: ${adminDir}`);
  }
  return commonDir;
}

function validateDispatch({ sandbox, networkAccess }) {
  if (networkAccess === "enabled" && sandbox !== "workspace-write") {
    return { ok: false, error: "--network-access enabled requires --sandbox workspace-write" };
  }
  return { ok: true, warnings: [] };
}

module.exports = createNativeAdapter({
  name: "codex",
  timeoutMs: 2400000,
  outputProtocol: (phase) => phase === "primary_review" ? "json_result" : "text_stdout",
  metadata: {
    cliBinary: "codex",
    outputProtocol: "text_stdout",
    providerDefault: "openai",
    providerFromModel: true,
    promptTransport: "stdin_dash",
    processContainment: "inherited_scope_no_daemon",
    credentials: { files: [
      { id: "auth", targetRoot: "home", targetRel: ".codex/auth.json", access: "read_write", recommendedSource: "~/.codex/auth.json" },
      { id: "config", targetRoot: "home", targetRel: ".codex/config.toml", access: "read", recommendedSource: "~/.codex/config.toml" },
    ], envHints: ["OPENAI_API_KEY"] },
  },
  phases: {
    dispatch: { supported: true, write: true, readOnly: true, networkControl: "native", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "native", cancellation: "process", structuredOutput: "json" },
  },
  validateDispatch,
  buildDispatch({ cwd, promptPath, promptSha256, resultPath, model, sandbox, networkAccess, reasoning }) {
    const args = ["exec", "-C", cwd, "--color", "never", "-o", resultPath];
    if (reasoning) args.push("-c", `model_reasoning_effort=${reasoning}`);
    if (networkAccess === "enabled") args.push("-c", "sandbox_workspace_write.network_access=true");
    if (model) args.push("-m", model);
    args.push("--sandbox", sandbox);
    if (sandbox === "workspace-write") args.push("--add-dir", resolveCommonGitDir(cwd));
    args.push("-");
    return { command: "codex", args, cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
  buildReview({ cwd, promptPath, promptSha256, resultPath, schemaPath, model }) {
    if (!schemaPath) throw new Error("codex primary review requires a staged JSON schema");
    const args = ["exec", "-C", cwd, "--ephemeral", "--sandbox", "read-only", "--color", "never", "--output-schema", schemaPath, "-o", resultPath];
    if (model) args.push("-m", model);
    args.push("-");
    return { command: "codex", args, cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
});
