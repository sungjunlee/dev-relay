const { createNativeAdapter } = require("../adapter-contract");

function binary() { return process.env.RELAY_CURSOR_AGENT_BIN || "agent"; }

function validateDispatch({ sandbox, networkAccess }) {
  if (sandbox === "read-only") return { ok: false, error: "cursor executor does not expose a relay read-only dispatch mode; use workspace-write or choose another executor" };
  const warnings = [];
  if (sandbox !== "workspace-write") warnings.push(`cursor executor: --sandbox '${sandbox}' is not enforced by agent; proceeding with workspace-write semantics.`);
  if (networkAccess === "enabled") warnings.push("cursor executor: --network-access 'enabled' is informational only; agent does not expose relay network gating.");
  warnings.push("cursor executor is optional experimental harness; relay uses --workspace and never agent --worktree.");
  return { ok: true, warnings };
}

module.exports = createNativeAdapter({
  name: "cursor",
  timeoutMs: 1800000,
  outputProtocol: (phase) => phase === "primary_review" ? "json_result" : "text_stdout",
  metadata: {
    processContainment: "inherited_scope_no_daemon",
    cliBinary: "agent",
    cliBinaryEnv: "RELAY_CURSOR_AGENT_BIN",
    outputProtocol: "text_stdout",
    providerDefault: "cursor",
    providerFromModel: true,
    promptTransport: "stdin",
    credentials: { files: [], envHints: ["CURSOR_API_KEY"] },
  },
  phases: {
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", cancellation: "process", structuredOutput: "json" },
  },
  validateDispatch,
  buildDispatch({ cwd, promptPath, promptSha256, model, sandbox }) {
    const args = ["--print", "--trust", "--force", "--workspace", cwd, "--output-format", "text"];
    if (sandbox === "workspace-write") args.push("--sandbox", "enabled");
    if (model) args.push("--model", model);
    return { command: binary(), args, cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
  buildReview({ cwd, promptPath, promptSha256, model }) {
    const args = ["--print", "--trust", "--force", "--mode", "ask", "--workspace", cwd, "--output-format", "text"];
    if (model) args.push("--model", model);
    return { command: binary(), args, cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
});
