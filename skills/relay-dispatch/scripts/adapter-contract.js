const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PHASES = Object.freeze(["dispatch", "primary_review"]);
const OUTPUT_PROTOCOLS = Object.freeze(["text_stdout", "json_result", "jsonl_run_result"]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const FILESYSTEM_ISOLATION = new Set(["native", "native_bash", "declaration_only", "not_requested", "none"]);
const NATIVE_FILESYSTEM_REQUESTS = new Set(["workspace-write", "read-only", "enabled"]);
// Supported CLIs must preserve the inherited scope marker and must not daemonize
// or clear it from descendants; host cleanup relies on that contract.
const PROCESS_CONTAINMENT = "inherited_scope_no_daemon";
const RUNTIME_PARENT_KEYS = ["executableParent", "interpreterParent"];

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value);
}

function normalizeRuntimeDependencies(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== RUNTIME_PARENT_KEYS.slice().sort().join(",")) throw new Error("adapter runtime dependency declaration is invalid");
  const normalized = {};
  for (const key of RUNTIME_PARENT_KEYS) {
    const depth = value[key]; if (depth !== null && (!Number.isInteger(depth) || depth < 0 || depth > 2)) throw new Error("adapter runtime dependency parent depth is invalid"); normalized[key] = depth;
  } return Object.freeze(normalized);
}

function normalizeProviderUnavailableSignals(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error("adapter providerUnavailableSignals must be an array of literal strings");
  const normalized = value.map((signal) => {
    if (typeof signal !== "string" || !signal.trim() || signal.length > 200 || /[\u0000-\u001f]/.test(signal)) {
      throw new Error("adapter providerUnavailableSignals must be non-empty literal strings without control characters");
    }
    return signal.trim().toLowerCase();
  });
  if (new Set(normalized).size !== normalized.length) throw new Error("adapter providerUnavailableSignals must not repeat a signal");
  return Object.freeze(normalized);
}

class AdapterCapabilityError extends Error {
  constructor(adapter, phase, reason) {
    super(`adapter '${adapter}' cannot run ${phase}: ${reason}`); this.name = "AdapterCapabilityError";
    this.adapter = adapter; this.phase = phase; this.reason = reason;
  }
}

function requireAbsolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`); return value;
}

function requireSafeOptionalValue(value, name) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.startsWith("-")) throw new Error(`${name} must be a non-flag string when supplied`); return value;
}

function decodeTrustedPrompt(promptBytes) {
  if (!Buffer.isBuffer(promptBytes)) throw new Error("promptBytes must be a Buffer");
  const prompt = promptBytes.toString("utf8");
  if (!Buffer.from(prompt, "utf8").equals(promptBytes)) throw new Error("promptBytes must contain valid canonical UTF-8");
  return Object.freeze({ prompt, sha256: require("crypto").createHash("sha256").update(promptBytes).digest("hex") });
}

function normalizeInvocationShape(invocation) {
  if (!invocation || typeof invocation !== "object") throw new Error("adapter invocation must be an object");
  if (Object.keys(invocation).some((key) => !["command", "args", "cwd", "stdinPath", "stdinSha256", "extensionBinding"].includes(key))) throw new Error("adapter invocation contains unsupported metadata");
  if (typeof invocation.command !== "string" || !invocation.command || invocation.command.includes("\n")) throw new Error("adapter invocation command must be one executable argv value");
  if (!Array.isArray(invocation.args) || invocation.args.some((value) => typeof value !== "string" || value.includes("\0"))) throw new Error("adapter invocation args must be an array of string argv values");
  requireAbsolutePath(invocation.cwd, "adapter invocation cwd");
  if (Boolean(invocation.stdinPath) !== Boolean(invocation.stdinSha256)) throw new Error("adapter invocation stdinPath and stdinSha256 must be supplied together");
  let extensionBinding = null;
  if (invocation.extensionBinding !== undefined) {
    const value = invocation.extensionBinding;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "entry,manifest,root,runtimeFiles"
      || typeof value.root !== "string" || !path.isAbsolute(value.root)) {
      throw new Error("adapter extension binding is invalid");
    }
    const normalizeBoundFile = (file, label) => {
      if (!file || typeof file !== "object" || Array.isArray(file)
        || Object.keys(file).sort().join(",") !== "dev,ino,path,sha256,size"
        || typeof file.path !== "string" || !path.isAbsolute(file.path)
        || !SHA256_RE.test(file.sha256 || "")
        || !Number.isInteger(file.dev) || file.dev < 0
        || !Number.isInteger(file.ino) || file.ino < 0
        || !Number.isInteger(file.size) || file.size < 0) {
        throw new Error(`${label} extension binding is invalid`);
      }
      return Object.freeze({ path: file.path, dev: file.dev, ino: file.ino, size: file.size, sha256: file.sha256 });
    };
    if (!Array.isArray(value.runtimeFiles) || value.runtimeFiles.length !== 2) {
      throw new Error("adapter extension runtime binding is invalid");
    }
    const manifest = normalizeBoundFile(value.manifest, "manifest");
    const entry = normalizeBoundFile(value.entry, "entry");
    const runtimeFiles = value.runtimeFiles.map((file, index) => normalizeBoundFile(file, `runtime file ${index}`));
    if (runtimeFiles[0].path !== manifest.path || runtimeFiles[1].path !== entry.path
      || runtimeFiles.some((file, index) => ["dev", "ino", "size", "sha256"].some((key) => file[key] !== [manifest, entry][index][key]))) {
      throw new Error("adapter extension runtime binding does not match its loader evidence");
    }
    extensionBinding = Object.freeze({
      root: value.root,
      manifest,
      entry,
      runtimeFiles: Object.freeze(runtimeFiles),
    });
  }
  return Object.freeze({
    command: invocation.command,
    args: Object.freeze([...invocation.args]),
    cwd: invocation.cwd,
    ...(invocation.stdinPath ? {
      stdinPath: requireAbsolutePath(invocation.stdinPath, "adapter invocation stdinPath"),
      stdinSha256: SHA256_RE.test(invocation.stdinSha256 || "")
        ? invocation.stdinSha256
        : (() => { throw new Error("adapter invocation stdinSha256 must bind stdinPath bytes"); })(),
    } : {}),
    ...(extensionBinding ? { extensionBinding } : {}),
  });
}

function readOutput(outputPath) { return !outputPath || !fs.existsSync(outputPath) ? "" : fs.readFileSync(outputPath, "utf8"); }

function parseJsonlRunResult(text) {
  let result = null;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`jsonl_run_result line ${index + 1} must be valid JSON: ${error.message}`);
    }
    if (event?.type === "run_result") result = event;
  }
  if (!result || typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("jsonl_run_result requires a non-empty run_result.text");
  }
  return { text: result.text, value: result.text };
}

function parseOutput(protocol, { stdoutPath, resultPath }) {
  const resultText = readOutput(resultPath);
  const stdoutText = readOutput(stdoutPath);
  const text = resultText || stdoutText;
  if (protocol === "text_stdout") return { text, value: text };
  if (protocol === "json_result") {
    if (!text.trim()) throw new Error("json_result output is empty");
    try {
      return { text, value: JSON.parse(text) };
    } catch (error) {
      throw new Error(`json_result is invalid JSON: ${error.message}`);
    }
  }
  if (protocol === "jsonl_run_result") return parseJsonlRunResult(text);
  throw new Error(`unknown output protocol '${protocol}'`);
}

function outcomeStatus({ exitCode, signal, timedOut, cancelled, text }) {
  if (timedOut) return "timed_out";
  if (cancelled || signal) return "cancelled";
  if (exitCode !== 0) return "failed";
  return text && text.trim() ? "succeeded" : "empty";
}

function makeParseOutcome(outputProtocol) {
  return function parseOutcome({ phase = "dispatch", exitCode = 0, signal = null, timedOut = false, cancelled = false, stdoutPath, stderrPath, resultPath }) {
    let parsed = { text: "", value: null };
    let parseError = null;
    if (exitCode === 0 && !signal && !timedOut && !cancelled) {
      try {
        const protocol = typeof outputProtocol === "function" ? outputProtocol(phase) : outputProtocol;
        parsed = parseOutput(protocol, { stdoutPath, resultPath });
        if (phase !== "dispatch" && protocol === "jsonl_run_result") {
          try {
            parsed = { text: parsed.text, value: JSON.parse(parsed.text) };
          } catch (error) {
            throw new Error(`jsonl_run_result.${phase} text is invalid JSON: ${error.message}`);
          }
        }
      } catch (error) {
        parseError = error;
      }
    }
    const status = parseError ? "failed" : outcomeStatus({ exitCode, signal, timedOut, cancelled, text: parsed.text });
    return Object.freeze({
      status,
      summary: parseError ? parseError.message : parsed.text.trim().slice(0, 500),
      resultPath: resultPath || stdoutPath || null,
      output: parsed.value,
      stderrPath: stderrPath || null,
    });
  };
}

function validateCapabilities(adapter, phase, request = {}) {
  if (!PHASES.includes(phase)) throw new AdapterCapabilityError(adapter.name, phase, "unknown phase");
  const capability = adapter.capabilities({ phase, request });
  if (!capability.supported) {
    const error = new AdapterCapabilityError(adapter.name, phase, capability.reason || "phase is unsupported");
    if (capability.errorCode) error.code = capability.errorCode;
    if (capability.diagnostic) error.diagnostic = capability.diagnostic;
    throw error;
  }
  if (phase === "primary_review" && request.readOnly === true && !capability.readOnly) {
    throw new AdapterCapabilityError(adapter.name, phase, "read-only execution is unsupported");
  }
  if (request.networkAccess === "disabled" && capability.networkControl !== "native") {
    throw new AdapterCapabilityError(adapter.name, phase, "model/tool network disable is not natively enforceable");
  }
  return capability;
}

// This is intentionally derived from a static adapter declaration. It is a
// foreground diagnostic, not a durable lifecycle fact or an admission check.
function filesystemIsolationDiagnostic(adapter, phase, request = {}) {
  const capability = validateCapabilities(adapter, phase, request);
  const effective = capability.filesystemIsolation || "none";
  let requested;
  let diagnostic;
  switch (effective) {
    case "native":
      requested = capability.filesystemIsolationRequest;
      diagnostic = null;
      break;
    case "native_bash":
      requested = "enabled";
      diagnostic = `${adapter.name} enables its native Bash sandbox; built-in file tools remain permission-bound rather than filesystem-sandboxed.`;
      break;
    case "declaration_only":
      requested = "enabled";
      diagnostic = `${adapter.name} declares a native sandbox, but Relay cannot verify filesystem enforcement; continuing on the trusted local host.`;
      break;
    case "not_requested":
      requested = "not_requested";
      diagnostic = `${adapter.name} native filesystem isolation is not requested for read-only primary review; continuing directly on the trusted local host.`;
      break;
    default:
      requested = "unavailable";
      diagnostic = `${adapter.name} has no native filesystem sandbox; continuing directly on the trusted local host.`;
  }
  return Object.freeze({ requested, effective, diagnostic });
}

function resolveAdapterProvider(adapter, model) {
  if (adapter.metadata.providerFromModel && typeof model === "string") {
    const separator = model.indexOf("/");
    if (separator > 0) return model.slice(0, separator);
  }
  return adapter.metadata.providerDefault || null;
}

function probeBinary(command, { env = process.env, timeoutMs = 5000, spawn = spawnSync } = {}) {
  const result = spawn(command, ["--version"], {
    encoding: "utf8",
    env,
    stdio: "pipe",
    timeout: timeoutMs,
  });
  if (result.error?.code === "ENOENT") {
    return Object.freeze({ status: "skipped", error: `${command} CLI not found`, raw: null });
  }
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || String(result.stderr || "").trim() || `exit ${result.status}`;
    return Object.freeze({ status: "failed", error: `${command} --version failed: ${reason}`, raw: null });
  }
  return Object.freeze({ status: "available", error: null, raw: String(result.stdout || "").trim() || null });
}

function formatAdapterPhase({ adapter, phase } = {}) {
  const adapterName = String(adapter || "").trim() || "unknown";
  const phaseName = String(phase || "").trim() || "unknown";
  return `adapter=${adapterName} phase=${phaseName}`;
}

function parseJsonObject(text, { adapter, phase, description = "result" } = {}) {
  const context = formatAdapterPhase({ adapter, phase });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${context} ${description} must be valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${context} ${description} must be a JSON object`);
  }
  return parsed;
}

function recoverExecStdout(error) {
  const stdout = String(error?.stdout || "").trim();
  return stdout || null;
}

function createNativeAdapter({
  name,
  timeoutMs,
  metadata,
  phases,
  outputProtocol,
  buildDispatch,
  buildReview = null,
  validateModel = null,
  validateDispatch = null,
  providerUnavailableSignals = null,
}) {
  const phaseMetadata = Object.freeze({ ...phases });
  const parseOutcomeForProtocol = makeParseOutcome(outputProtocol);
  const cliBinary = metadata.cliBinary;
  if (!name || typeof buildDispatch !== "function" || typeof cliBinary !== "string") throw new Error("native adapter requires name, metadata.cliBinary, and buildDispatch");
  if (metadata.processContainment !== PROCESS_CONTAINMENT) throw new Error(`native adapter must declare ${PROCESS_CONTAINMENT} process containment`);
  if (metadata.providerTransport !== "remote_required") throw new Error("native adapter must declare remote_required provider transport");
  for (const phase of PHASES) {
    const capability = phaseMetadata[phase];
    if (!capability?.supported) continue;
    if (!FILESYSTEM_ISOLATION.has(capability.filesystemIsolation)) {
      throw new Error(`native adapter ${phase} phase must declare a known filesystemIsolation`);
    }
    const hasRequest = Object.hasOwn(capability, "filesystemIsolationRequest");
    if (capability.filesystemIsolation === "native") {
      if (!NATIVE_FILESYSTEM_REQUESTS.has(capability.filesystemIsolationRequest)) {
        throw new Error(`native adapter ${phase} phase must declare a native filesystemIsolationRequest`);
      }
    } else if (hasRequest) {
      throw new Error(`native adapter ${phase} filesystemIsolationRequest is only valid with native filesystemIsolation`);
    }
  }
  const runtimeDependencies = normalizeRuntimeDependencies(metadata.runtimeDependencies);
  const providerUnavailable = normalizeProviderUnavailableSignals(providerUnavailableSignals);
  const bindInvocationPolicy = (invocation, toolNetworkAccess) => Object.freeze({ ...invocation, networkAccess: "enabled", toolNetworkAccess, runtimeDependencies });
  return Object.freeze({
    name,
    defaults: Object.freeze({ timeoutMs }),
    providerUnavailableSignals: providerUnavailable,
    metadata: deepFreeze({ ...metadata, runtimeDependencies }),
    probe({ env = process.env, timeoutMs: probeTimeoutMs = 5000, spawn = spawnSync } = {}) {
      const binary = env[metadata.cliBinaryEnv] || cliBinary;
      return probeBinary(binary, { env, timeoutMs: probeTimeoutMs, spawn });
    },
    capabilities({ phase, request = null }) {
      const value = phaseMetadata[phase];
      if (!value) return Object.freeze({ supported: false, reason: "unknown phase" });
      let capability = { ...value };
      const applyValidation = (validation) => {
        capability = {
          ...capability,
          supported: validation.ok,
          ...(validation.ok ? {} : {
            reason: validation.error,
            ...(validation.errorCode ? { errorCode: validation.errorCode } : {}),
            ...(validation.diagnostic ? { diagnostic: validation.diagnostic } : {}),
          }),
          warnings: validation.warnings || [],
        };
      };
      if (value.supported && request && validateModel) {
        applyValidation(validateModel({ phase, model: request.model || null }));
      }
      if (capability.supported && phase === "dispatch" && request && validateDispatch) {
        applyValidation(validateDispatch({ ...request, networkAccess: request.networkAccess || "disabled" }));
      }
      return Object.freeze(capability);
    },
    buildInvocation({ phase, cwd, promptPath, promptBytes, resultPath, schemaPath = null, model = null, timeoutMs: requestedTimeoutMs, networkAccess = "disabled", reasoning = null }) {
      validateCapabilities(this, phase, phase === "primary_review" ? { readOnly: true, networkAccess, model } : { networkAccess, model });
      for (const [value, label] of [[cwd, "cwd"], [promptPath, "promptPath"], [resultPath, "resultPath"], ...(schemaPath ? [[schemaPath, "schemaPath"]] : [])]) requireAbsolutePath(value, label);
      requireSafeOptionalValue(model, "model");
      const trustedPrompt = decodeTrustedPrompt(promptBytes);
      const builder = phase === "dispatch" ? buildDispatch : buildReview;
      if (!builder) throw new AdapterCapabilityError(name, phase, "no direct review invocation is registered");
      const common = {
        cwd, prompt: trustedPrompt.prompt, promptPath, promptSha256: trustedPrompt.sha256, resultPath, model,
        timeoutSeconds: Math.max(1, Math.floor((requestedTimeoutMs || timeoutMs) / 1000)),
      };
      const phaseOptions = phase === "dispatch" ? { networkAccess, reasoning } : { schemaPath };
      return bindInvocationPolicy(normalizeInvocationShape(builder({ ...common, ...phaseOptions })), networkAccess);
    },
    parseOutcome(input) {
      const outcome = parseOutcomeForProtocol(input);
      if (outcome.status === "failed" && metadata.resultErrorLabel && outcome.summary.startsWith("jsonl_run_result line ")) {
        return Object.freeze({ ...outcome, summary: outcome.summary.replace("jsonl_run_result line ", `${metadata.resultErrorLabel} line `) });
      }
      return outcome;
    },
  });
}

module.exports = {
  AdapterCapabilityError,
  OUTPUT_PROTOCOLS,
  PROCESS_CONTAINMENT,
  PHASES,
  assertInvocationShape: normalizeInvocationShape,
  createNativeAdapter,
  filesystemIsolationDiagnostic,
  decodeTrustedPrompt,
  formatAdapterPhase,
  makeParseOutcome,
  normalizeProviderUnavailableSignals,
  parseOutput,
  parseJsonObject,
  probeBinary,
  recoverExecStdout,
  requireAbsolutePath,
  requireSafeOptionalValue,
  resolveAdapterProvider,
  validateCapabilities,
};
