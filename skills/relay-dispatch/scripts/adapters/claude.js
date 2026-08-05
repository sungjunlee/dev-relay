const fs = require("fs");
const { createNativeAdapter } = require("../adapter-contract");

function validateDispatch({ sandbox, networkAccess }) {
  void networkAccess;
  const warnings = sandbox === "workspace-write" ? [] : [`--sandbox '${sandbox}' is not supported for Claude executor; using the relay's native tool allowlist`];
  return { ok: true, warnings };
}

module.exports = createNativeAdapter({
  name: "claude",
  timeoutMs: 1800000,
  outputProtocol: (phase) => phase === "primary_review" ? "json_result" : "text_stdout",
  metadata: {
    processContainment: "inherited_scope_no_daemon",
    providerTransport: "remote_required",
    credentialTransport: "explicit_bundle",
    runtimeDependencies: { executableParent: null, interpreterParent: null },
    cliBinary: "claude",
    outputProtocol: "text_stdout",
    providerDefault: "anthropic",
    providerFromModel: true,
    promptTransport: "stdin",
    credentials: { files: [
      { id: "auth", targetRoot: "home", targetRel: ".claude/.credentials.json", access: "read_write", recommendedSource: "~/.claude/.credentials.json" },
      { id: "settings", targetRoot: "home", targetRel: ".claude/settings.json", access: "read", recommendedSource: "~/.claude/settings.json" },
    ], envHints: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] },
  },
  phases: {
    // buildDispatch pins --disallowedTools Bash,...: no shell, no command execution.
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text", commandExecution: false },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", cancellation: "process", structuredOutput: "json" },
  },
  validateDispatch,
  buildDispatch({ cwd, promptPath, promptSha256, model }) {
    return { command: "claude", args: ["-p", "--safe-mode", "--output-format", "text", "--allowedTools", "Read,Write,Edit,Glob,Grep", "--disallowedTools", "Bash,WebFetch,WebSearch,Agent", ...(model ? ["--model", model] : [])], cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
  buildReview({ cwd, promptPath, promptSha256, schemaPath, model }) {
    if (!schemaPath) throw new Error("claude primary review requires a staged JSON schema");
    const schema = fs.readFileSync(schemaPath, "utf8").trim();
    return {
      command: "claude",
      args: ["-p", "--safe-mode", "--no-session-persistence", "--output-format", "text", "--json-schema", schema, "--allowedTools", "Read", "--disallowedTools", "Bash,Write,Edit,WebFetch,WebSearch,Agent", ...(model ? ["--model", model] : [])],
      cwd,
      stdinPath: promptPath,
      stdinSha256: promptSha256,
    };
  },
});
