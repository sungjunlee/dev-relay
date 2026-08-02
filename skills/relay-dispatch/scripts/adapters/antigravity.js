const { createNativeAdapter } = require("../adapter-contract");
const MAX_ARGV_BYTES = 256 * 1024;

function boundedArgv(args) {
  const bytes = args.reduce((total, value) => total + Buffer.byteLength(value, "utf8") + 1, 0);
  if (bytes >= MAX_ARGV_BYTES) {
    throw new Error("antigravity argv exceeds the conservative 256 KiB limit; its prompt transport is visible in the process list");
  }
  return args;
}

function validateDispatch({ sandbox, networkAccess }) {
  if (sandbox !== "workspace-write") return { ok: false, error: "antigravity executor supports only --sandbox workspace-write semantics; read-only dispatch is not safely representable" };
  void networkAccess; const warnings = [];
  return { ok: true, warnings };
}

function worktreePrompt(cwd, prompt) {
  return ["[RELAY WORKTREE BOUNDARY]", `Repository worktree: ${cwd}`, `Before doing anything, run: cd ${cwd}`, "Create and edit source files only in that repository worktree. You may inspect git status, but do not run git add, git commit, git push, or create a PR; canonical relay recovery owns Git metadata and publication.", "Do not create, edit, or report source files under ~/.gemini, scratch directories, or any path outside the repository worktree.", "If a tool starts elsewhere, first change directory to the repository worktree before touching files.", "", prompt].join("\n");
}

module.exports = createNativeAdapter({
  name: "antigravity",
  timeoutMs: 1800000,
  outputProtocol: (phase) => phase === "primary_review" ? "json_result" : "text_stdout",
  metadata: { cliBinary: "agy", cliBinaryEnv: "RELAY_ANTIGRAVITY_BIN", outputProtocol: "phase-specific", providerDefault: "google", providerFromModel: true, promptTransport: "argv_visible", processContainment: "inherited_scope_no_daemon", providerTransport: "remote_required", credentialTransport: "explicit_bundle", runtimeDependencies: { executableParent: null, interpreterParent: null }, promptTransportWarning: "prompt content is visible in the local process list; bounded to less than 256 KiB", credentials: { files: [
    { id: "oauth", targetRoot: "home", targetRel: ".gemini/oauth_creds.json", access: "read_write", recommendedSource: "~/.gemini/oauth_creds.json" },
    { id: "config", targetRoot: "home", targetRel: ".gemini/config/config.json", access: "read_write", recommendedSource: "~/.gemini/config/config.json" },
  ], envHints: [] } },
  phases: {
    // `agy --sandbox` does not provide a verifiable tool-network block.
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", cancellation: "process", structuredOutput: "json" },
  },
  validateDispatch,
  buildDispatch({ cwd, prompt, sandbox, timeoutSeconds }) {
    const args = ["--prompt", worktreePrompt(cwd, prompt), "--print-timeout", `${timeoutSeconds}s`, "--mode", "accept-edits", "--disable-slash-commands"];
    if (sandbox === "workspace-write") args.push("--sandbox");
    return { command: process.env.RELAY_ANTIGRAVITY_BIN || "agy", args: boundedArgv(args), cwd };
  },
  buildReview({ cwd, prompt, timeoutSeconds }) {
    return {
      command: process.env.RELAY_ANTIGRAVITY_BIN || "agy",
      args: boundedArgv([
        "--add-dir", cwd,
        "--prompt", prompt,
        "--print-timeout", `${timeoutSeconds}s`,
        "--output-format", "text",
        "--mode", "plan",
        "--disable-slash-commands",
        "--sandbox",
      ]),
      cwd,
    };
  },
});
