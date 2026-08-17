const fs = require("fs");
const os = require("os");
const path = require("path");
const { createNativeAdapter } = require("../adapter-contract");
const host = require("../host");

const EXTENSION_BINDING_CODE = "PI_EXTENSION_BINDING_INVALID";
const EXTENSION_PACKAGE = "pi-alibaba-models";
const EXTENSION_ENTRY = "extensions/alibaba.ts";

class PiExtensionBindingError extends Error {
  constructor(message, code = EXTENSION_BINDING_CODE) {
    super(message); this.name = "PiExtensionBindingError"; this.code = code;
  }
}

function extensionFailure(model, error) {
  return {
    ok: false,
    error: "installed pi-alibaba-models extension binding is unavailable",
    errorCode: error.code || EXTENSION_BINDING_CODE,
    diagnostic: Object.freeze({
      code: error.code || EXTENSION_BINDING_CODE,
      kind: "extension_binding",
      stage: "pre-provider",
      provider: "alibaba-plan",
      model,
      extension: EXTENSION_PACKAGE,
      reason: "the manifest-declared Alibaba extension entry is not a trusted regular file",
    }),
    warnings: [],
  };
}

function extensionPackageCandidates() {
  const configuredHome = path.resolve(process.env.HOME || os.homedir());
  let home;
  try { home = fs.realpathSync(configuredHome); }
  catch (error) {
    if (error.code === "ENOENT") home = configuredHome;
    else throw new PiExtensionBindingError("installed extension home is unavailable");
  }
  return [path.join(home, ".pi", "agent", "npm", "node_modules", EXTENSION_PACKAGE)];
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function trustedPackageRoot(candidate) {
  const root = path.resolve(candidate);
  let stat;
  try { stat = fs.lstatSync(root); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new PiExtensionBindingError("extension package root is unavailable");
  }
  let canonical;
  try { canonical = fs.realpathSync(root); }
  catch { throw new PiExtensionBindingError("extension package root is unavailable"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== root) {
    throw new PiExtensionBindingError("extension package root is not canonical");
  }
  return root;
}

function bindExtensionFile(filePath, label) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { throw new PiExtensionBindingError("extension evidence is unavailable"); }
  let canonical;
  try { canonical = fs.realpathSync(filePath); }
  catch { throw new PiExtensionBindingError("extension evidence is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || canonical !== filePath) {
    throw new PiExtensionBindingError(`${label} extension evidence is not canonical`);
  }
  try {
    return Object.freeze(host.hostInvocation.bindRegularFile(filePath, label));
  } catch {
    throw new PiExtensionBindingError(`${label} extension evidence is not trusted`);
  }
}

function bindingEvidence({ bytes, ...binding }) {
  void bytes;
  return Object.freeze(binding);
}

function resolveAlibabaExtension() {
  let packageRoot = null;
  for (const candidate of extensionPackageCandidates()) {
    packageRoot = trustedPackageRoot(candidate);
    if (packageRoot) break;
  }
  if (!packageRoot) throw new PiExtensionBindingError("installed extension package is missing", "PI_EXTENSION_BINDING_MISSING");
  const manifestPath = path.join(packageRoot, "package.json");
  const manifestBinding = bindExtensionFile(manifestPath, "extension manifest");
  let manifest;
  try { manifest = JSON.parse(manifestBinding.bytes.toString("utf8")); }
  catch { throw new PiExtensionBindingError("extension manifest is malformed"); }
  const entries = manifest && !Array.isArray(manifest) && manifest.name === EXTENSION_PACKAGE
    && manifest.pi && Array.isArray(manifest.pi.extensions) ? manifest.pi.extensions : null;
  if (!entries || !entries.length || entries.some((entry) => typeof entry !== "string" || !entry || entry.includes("\0") || entry.includes("\\") || path.isAbsolute(entry))) {
    throw new PiExtensionBindingError("extension manifest entries are malformed");
  }
  const entryNames = entries.map((entry) => path.posix.normalize(entry));
  if (entries.some((entry, index) => entryNames[index] !== entry)
    || entryNames.some((entry) => entry === "." || entry.startsWith("../") || entry.includes("/../") || entry.startsWith("/"))) {
    throw new PiExtensionBindingError("extension manifest entry escapes its package");
  }
  if (entries.length !== 1 || entryNames[0] !== EXTENSION_ENTRY) {
    throw new PiExtensionBindingError("manifest-declared Alibaba extension entry is missing");
  }
  const entryPath = path.resolve(packageRoot, entryNames[0]);
  if (!contained(packageRoot, entryPath)) throw new PiExtensionBindingError("extension entry escapes its package");
  const entryBinding = bindExtensionFile(entryPath, "extension entry");
  return Object.freeze({
    root: packageRoot,
    manifest: bindingEvidence(manifestBinding),
    entry: bindingEvidence(entryBinding),
    entryPath,
  });
}

// Primary review disables ambient extension discovery and opts into only the
// exact manifest-declared Alibaba entry when that model family is selected.
function normalizeThinking(reasoning) {
  if (["low", "medium", "high"].includes(reasoning)) return reasoning;
  return reasoning === "xhigh" ? "high" : null;
}

function validateModel({ phase, model }) {
  if (phase !== "primary_review" || typeof model !== "string" || !model.startsWith("alibaba-plan/")) return { ok: true, warnings: [] };
  try {
    resolveAlibabaExtension();
    return { ok: true, warnings: [] };
  } catch (error) {
    return extensionFailure(model, error);
  }
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
    dispatch: { supported: true, write: true, readOnly: false, networkControl: "native", filesystemIsolation: "none", loopbackListen: "available", cancellation: "process", structuredOutput: "text" },
    primary_review: { supported: true, write: false, readOnly: true, networkControl: "native", filesystemIsolation: "none", loopbackListen: "available", cancellation: "process", structuredOutput: "json" },
  },
  validateModel,
  validateDispatch,
  buildDispatch({ cwd, promptPath, promptSha256, model, reasoning }) {
    const args = ["--no-session", "--no-context-files", "--no-skills", "--tools", "read,grep,find,ls,write,edit", ...(model ? ["--model", model] : [])];
    const thinking = normalizeThinking(reasoning);
    if (thinking) args.push("--thinking", thinking);
    args.push("--print");
    return { command: process.env.RELAY_PI_BIN || "pi", args, cwd, stdinPath: promptPath, stdinSha256: promptSha256 };
  },
  buildReview({ cwd, promptPath, promptSha256, model }) {
    const args = ["--no-session", "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--tools", "read,grep,find,ls"];
    let extensionBinding;
    if (typeof model === "string" && model.startsWith("alibaba-plan/")) {
      try {
        const extension = resolveAlibabaExtension();
        extensionBinding = {
          root: extension.root,
          manifest: extension.manifest,
          entry: extension.entry,
          runtimeFiles: [extension.manifest, extension.entry],
        };
        args.push("--extension", extension.entryPath);
      } catch (error) {
        throw Object.assign(new Error("installed pi-alibaba-models extension binding is unavailable"), {
          code: error.code || EXTENSION_BINDING_CODE,
          diagnostic: extensionFailure(model, error).diagnostic,
        });
      }
    }
    if (model) args.push("--model", model);
    args.push("--print");
    return { command: process.env.RELAY_PI_BIN || "pi", args, cwd, stdinPath: promptPath, stdinSha256: promptSha256, ...(extensionBinding ? { extensionBinding } : {}) };
  },
});
