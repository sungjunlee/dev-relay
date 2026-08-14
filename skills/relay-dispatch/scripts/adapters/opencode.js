const { createNativeAdapter } = require("../adapter-contract");

function validateDispatch({ sandbox, networkAccess }) {
  const warnings = [];
  if (sandbox !== "workspace-write") warnings.push(`opencode executor: --sandbox '${sandbox}' is not enforced by opencode (no native sandboxing); proceeding with workspace-write semantics.`);
  void networkAccess;
  warnings.push("opencode executor is experimental; an independent primary review remains required.");
  return { ok: true, warnings };
}

module.exports = createNativeAdapter({
  name: "opencode",
  timeoutMs: 1800000,
  outputProtocol: (phase) => phase === "primary_review" ? "json_result" : "text_stdout",
  providerUnavailableSignals: [
    "insufficient_quota",
    "quota exceeded",
    "quota_exceeded",
    "billing hard limit",
    "billing_hard_limit_reached",
  ],
  metadata: { cliBinary: "opencode", outputProtocol: "phase-specific", providerDefault: "opencode", providerFromModel: true, promptTransport: "stdin", processContainment: "inherited_scope_no_daemon", providerTransport: "remote_required", runtimeDependencies: { executableParent: null, interpreterParent: null } },
  phases: {
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "informational", filesystemIsolation: "none", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "informational", filesystemIsolation: "none", cancellation: "process", structuredOutput: "json" },
  },
  validateDispatch,
  buildDispatch({ cwd, promptPath, promptSha256, model }) {
    return { command: "opencode", args: ["run", "--auto", "--print-logs", "--log-level", "ERROR", "--pure", "--dir", cwd, ...(model ? ["-m", model] : [])], cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
  buildReview({ cwd, promptPath, promptSha256, model }) {
    return { command: process.env.RELAY_OPENCODE_BIN || "opencode", args: ["run", "--auto", "--print-logs", "--log-level", "ERROR", "--pure", ...(model ? ["-m", model] : [])], cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
});
