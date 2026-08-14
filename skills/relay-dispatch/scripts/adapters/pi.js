const { createNativeAdapter } = require("../adapter-contract");

function normalizeThinking(reasoning) {
  if (["low", "medium", "high"].includes(reasoning)) return reasoning;
  return reasoning === "xhigh" ? "high" : null;
}

function validateDispatch({ sandbox, networkAccess }) {
  const warnings = [];
  if (sandbox !== "workspace-write") warnings.push(`pi executor: --sandbox '${sandbox}' is not enforced by pi; proceeding with workspace-write semantics.`);
  void networkAccess;
  return { ok: true, warnings };
}

module.exports = createNativeAdapter({
  name: "pi",
  timeoutMs: 1800000,
  outputProtocol: (phase) => phase === "primary_review" ? "json_result" : "text_stdout",
  metadata: { cliBinary: "pi", cliBinaryEnv: "RELAY_PI_BIN", outputProtocol: "phase-specific", providerDefault: "pi", providerFromModel: true, promptTransport: "stdin", processContainment: "inherited_scope_no_daemon", providerTransport: "remote_required", runtimeDependencies: { executableParent: 1, interpreterParent: null } },
  phases: {
    // buildDispatch pins Pi's actual read, search, and edit tools; no shell is requested.
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "native", filesystemIsolation: "none", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "native", filesystemIsolation: "none", cancellation: "process", structuredOutput: "json" },
  },
  validateDispatch,
  buildDispatch({ cwd, promptPath, promptSha256, model, reasoning }) {
    const args = ["--no-session", "--no-context-files", "--no-extensions", "--no-skills", "--tools", "read,grep,find,ls,write,edit", ...(model ? ["--model", model] : [])];
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
