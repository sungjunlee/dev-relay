const { createNativeAdapter } = require("../adapter-contract");

function binary() { return process.env.RELAY_CURSOR_AGENT_BIN || "agent"; }

function validateDispatch({ sandbox, networkAccess }) { void sandbox; void networkAccess; return { ok: true, warnings: [] }; }

module.exports = createNativeAdapter({
  name: "cursor",
  timeoutMs: 1800000,
  outputProtocol: (phase) => phase === "primary_review" ? "json_result" : "text_stdout",
  metadata: {
    processContainment: "inherited_scope_no_daemon",
    providerTransport: "remote_required",
    runtimeDependencies: { executableParent: 0, interpreterParent: null },
    cliBinary: "agent",
    cliBinaryEnv: "RELAY_CURSOR_AGENT_BIN",
    outputProtocol: "text_stdout",
    providerDefault: "cursor",
    providerFromModel: true,
    promptTransport: "stdin",
  },
  phases: {
    dispatch: { supported: true, write: true, readOnly: true, networkControl: "informational", filesystemIsolation: "native", filesystemIsolationRequest: "enabled", cancellation: "process", structuredOutput: "text", commandExecution: true },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", filesystemIsolation: "native", filesystemIsolationRequest: "enabled", cancellation: "process", structuredOutput: "json" },
  },
  validateDispatch,
  buildDispatch({ cwd, promptPath, promptSha256, model, sandbox }) {
    const args = ["--print", "--trust", "--auto-review", "--workspace", cwd, "--output-format", "text", "--sandbox", "enabled"];
    void sandbox;
    if (model) args.push("--model", model);
    return { command: binary(), args, cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
  buildReview({ cwd, promptPath, promptSha256, model }) {
    const args = ["--print", "--trust", "--mode", "ask", "--workspace", cwd, "--output-format", "text", "--sandbox", "enabled"];
    if (model) args.push("--model", model);
    return { command: binary(), args, cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
});
