const fs = require("fs");
const { createNativeAdapter } = require("../adapter-contract");

function validateDispatch({ sandbox, networkAccess }) {
  if (networkAccess === "enabled") return { ok: false, error: "--network-access enabled is only supported for codex executor" };
  const warnings = sandbox === "workspace-write" ? [] : [`--sandbox '${sandbox}' is not supported for Claude executor; using --dangerously-skip-permissions`];
  return { ok: true, warnings };
}

module.exports = createNativeAdapter({
  name: "claude",
  timeoutMs: 1800000,
  outputProtocol: (phase) => phase === "primary_review" ? "json_result" : "text_stdout",
  metadata: {
    processContainment: "inherited_scope_no_daemon",
    cliBinary: "claude",
    outputProtocol: "text_stdout",
    providerDefault: "anthropic",
    providerFromModel: true,
    promptTransport: "stdin",
    credentials: { files: [
      { id: "auth", targetRoot: "home", targetRel: ".claude/.credentials.json", access: "read_write", recommendedSource: "~/.claude/.credentials.json" },
      { id: "settings", targetRoot: "home", targetRel: ".claude/settings.json", access: "read", recommendedSource: "~/.claude/settings.json" },
    ], envHints: ["ANTHROPIC_API_KEY"] },
  },
  phases: {
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", cancellation: "process", structuredOutput: "json" },
  },
  validateDispatch,
  buildDispatch({ cwd, promptPath, promptSha256, model }) {
    return { command: "claude", args: ["-p", "--dangerously-skip-permissions", "--output-format", "text", ...(model ? ["--model", model] : [])], cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
  buildReview({ cwd, promptPath, promptSha256, schemaPath, model }) {
    if (!schemaPath) throw new Error("claude primary review requires a staged JSON schema");
    const schema = fs.readFileSync(schemaPath, "utf8").trim();
    return {
      command: "claude",
      args: ["-p", "--bare", "--no-session-persistence", "--output-format", "text", "--json-schema", schema, "--allowedTools=Read", ...(model ? ["--model", model] : [])],
      cwd,
      stdinPath: promptPath,
      stdinSha256: promptSha256,
    };
  },
});
