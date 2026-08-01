const { createNativeAdapter } = require("../adapter-contract");

function validateDispatch({ sandbox, networkAccess }) {
  const warnings = [];
  if (sandbox !== "workspace-write") warnings.push(`opencode executor: --sandbox '${sandbox}' is not enforced by opencode (no native sandboxing); proceeding with workspace-write semantics.`);
  if (networkAccess === "enabled") warnings.push("opencode executor: --network-access 'enabled' is informational only; opencode does not gate network access at the executor level.");
  warnings.push("opencode executor is experimental; an independent primary review remains required.");
  return { ok: true, warnings };
}

module.exports = createNativeAdapter({
  name: "opencode",
  timeoutMs: 1800000,
  outputProtocol: (phase) => phase === "primary_review" ? "json_result" : "text_stdout",
  metadata: { cliBinary: "opencode", outputProtocol: "phase-specific", providerDefault: "opencode", providerFromModel: true, promptTransport: "stdin", processContainment: "inherited_scope_no_daemon",
    credentials: { files: [
      { id: "auth", targetRoot: "xdg_data", targetRel: "opencode/auth.json", access: "read_write", recommendedSource: "~/.local/share/opencode/auth.json" },
      { id: "config_json", targetRoot: "xdg_config", targetRel: "opencode/opencode.json", access: "read", recommendedSource: "~/.config/opencode/opencode.json" },
      { id: "config_jsonc", targetRoot: "xdg_config", targetRel: "opencode/opencode.jsonc", access: "read", recommendedSource: "~/.config/opencode/opencode.jsonc" },
    ], envHints: [] } },
  phases: {
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", cancellation: "process", structuredOutput: "json" },
  },
  validateDispatch,
  buildDispatch({ cwd, promptPath, promptSha256, model }) {
    return { command: "opencode", args: ["run", "--dir", cwd, ...(model ? ["-m", model] : [])], cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
  buildReview({ cwd, promptPath, promptSha256, model }) {
    return { command: process.env.RELAY_OPENCODE_BIN || "opencode", args: ["run", ...(model ? ["-m", model] : [])], cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
});
