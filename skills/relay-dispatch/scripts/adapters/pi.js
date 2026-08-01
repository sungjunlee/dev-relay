const { createNativeAdapter } = require("../adapter-contract");

function normalizeThinking(reasoning) {
  if (["low", "medium", "high"].includes(reasoning)) return reasoning;
  return reasoning === "xhigh" ? "high" : null;
}

function validateDispatch({ sandbox, networkAccess }) {
  const warnings = [];
  if (sandbox !== "workspace-write") warnings.push(`pi executor: --sandbox '${sandbox}' is not enforced by pi; proceeding with workspace-write semantics.`);
  if (networkAccess === "enabled") warnings.push("pi executor: --network-access 'enabled' is informational only; pi does not gate network access at the executor level.");
  return { ok: true, warnings };
}

module.exports = createNativeAdapter({
  name: "pi",
  timeoutMs: 1800000,
  outputProtocol: (phase) => phase === "primary_review" ? "json_result" : "text_stdout",
  metadata: { cliBinary: "pi", cliBinaryEnv: "RELAY_PI_BIN", outputProtocol: "phase-specific", providerDefault: "pi", providerFromModel: true, promptTransport: "stdin", processContainment: "inherited_scope_no_daemon",
    credentials: { files: [
      { id: "auth", targetRoot: "home", targetRel: ".pi/agent/auth.json", access: "read_write", recommendedSource: "~/.pi/agent/auth.json" },
      { id: "settings", targetRoot: "home", targetRel: ".pi/agent/settings.json", access: "read_write", recommendedSource: "~/.pi/agent/settings.json" },
      { id: "models", targetRoot: "home", targetRel: ".pi/agent/models.json", access: "read", recommendedSource: "~/.pi/agent/models.json" },
    ], envHints: [] } },
  phases: {
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", cancellation: "process", structuredOutput: "json" },
  },
  validateDispatch,
  buildDispatch({ cwd, promptPath, promptSha256, model, reasoning }) {
    const args = ["--no-session", ...(model ? ["--model", model] : [])];
    const thinking = normalizeThinking(reasoning);
    if (thinking) args.push("--thinking", thinking);
    args.push("--print");
    return { command: process.env.RELAY_PI_BIN || "pi", args, cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
  buildReview({ cwd, promptPath, promptSha256, model }) {
    const args = ["--no-session", "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--tools", "read,grep,find,ls"];
    if (model) args.push("--model", model);
    args.push("--print");
    return { command: process.env.RELAY_PI_BIN || "pi", args, cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
});
