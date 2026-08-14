const { createNativeAdapter } = require("../adapter-contract");

function validateDispatch({ sandbox, networkAccess }) {
  void sandbox; void networkAccess;
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
    providerTransport: "remote_required",
    runtimeDependencies: { executableParent: null, interpreterParent: null },
  },
  phases: {
    // Codex has no fail-closed tool-network switch; provider transport remains enabled.
    dispatch: { supported: true, write: true, readOnly: true, networkControl: "informational", filesystemIsolation: "native", filesystemIsolationRequest: "workspace-write", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", filesystemIsolation: "native", filesystemIsolationRequest: "read-only", cancellation: "process", structuredOutput: "json" },
  },
  validateDispatch,
  buildDispatch({ cwd, promptPath, promptSha256, resultPath, model, sandbox, networkAccess, reasoning }) {
    const args = ["exec", "-C", cwd, "--color", "never", "-o", resultPath];
    if (reasoning) args.push("-c", `model_reasoning_effort=${reasoning}`);
    void networkAccess;
    if (model) args.push("-m", model);
    args.push("--sandbox", sandbox);
    args.push("-");
    return { command: "codex", args, cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
  buildReview({ cwd, promptPath, promptSha256, resultPath, schemaPath, model }) {
    if (!schemaPath) throw new Error("codex primary review requires a staged JSON schema");
    const args = ["exec", "-C", cwd, "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "--output-schema", schemaPath, "-o", resultPath];
    if (model) args.push("-m", model);
    args.push("-");
    return { command: "codex", args, cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
});
