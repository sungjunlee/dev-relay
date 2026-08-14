const { createNativeAdapter } = require("../adapter-contract");

const ISOLATED_CATALOG_CODE = "PI_ISOLATED_CATALOG_MISMATCH";

// Ordinary `pi --list-models` discovers pi-alibaba-models from the ambient
// extension directory. Relay deliberately passes --no-extensions, so that
// catalog entry is absent; the extension bytes are not a bound runtime input.
function isolatedCatalogDiagnostic(model) {
  const diagnostic = {
    code: ISOLATED_CATALOG_CODE,
    kind: "isolated_catalog_mismatch",
    stage: "pre-provider",
    provider: "alibaba-plan",
    model,
    extension: "pi-alibaba-models",
    isolatedInvocation: "--no-extensions",
    reason: "the extension is discovered by ordinary Pi catalog listing but its executable bytes are not bound by Relay's runtime contract",
  };
  return Object.freeze(diagnostic);
}

function isolatedCatalogReason(model) {
  return `isolated Pi catalog cannot resolve explicit model '${model}': Relay disables extension discovery with --no-extensions, while pi-alibaba-models is not a bound runtime dependency`;
}

function normalizeThinking(reasoning) {
  if (["low", "medium", "high"].includes(reasoning)) return reasoning;
  return reasoning === "xhigh" ? "high" : null;
}

function validateModel({ model }) {
  if (typeof model !== "string" || !model.startsWith("alibaba-plan/")) return { ok: true, warnings: [] };
  const diagnostic = isolatedCatalogDiagnostic(model);
  return { ok: false, error: isolatedCatalogReason(model), errorCode: diagnostic.code, diagnostic, warnings: [] };
}

function validateDispatch({ networkAccess }) {
  void networkAccess;
  return { ok: true, warnings: [] };
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
  validateModel,
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
