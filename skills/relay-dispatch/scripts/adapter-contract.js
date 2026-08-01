const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PHASES = Object.freeze(["dispatch", "primary_review"]);
const OUTPUT_PROTOCOLS = Object.freeze(["text_stdout", "json_result", "jsonl_run_result"]);
const CONTROL_BOUND_INVOCATIONS = new WeakSet();
const SHA256_RE = /^[0-9a-f]{64}$/;
const CREDENTIAL_ROOTS = new Set(["home", "xdg_config", "xdg_data"]);
const CREDENTIAL_ACCESS = new Set(["read", "read_write"]);
// sandbox-exec cannot forbid setsid(2): supported CLIs must preserve the inherited
// scope marker and must not daemonize or clear it from descendants.
const PROCESS_CONTAINMENT = "inherited_scope_no_daemon";
const CREDENTIAL_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_CREDENTIAL_ENV = /^(?:HOME|PATH|TMPDIR|TMP|TEMP|XDG_CONFIG_HOME|XDG_DATA_HOME|RELAY_PROCESS_SCOPE)$|^RELAY_/;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeCredentialMetadata(credentials = {}) {
  const files = credentials.files || [], envHints = credentials.envHints || [];
  if (!Array.isArray(files) || !Array.isArray(envHints) || envHints.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error("adapter credential metadata must contain files and environment-name hints");
  }
  const ids = new Set(), targets = new Set();
  for (const file of files) {
    const keys = Object.keys(file || {}).sort().join(",");
    if (keys !== "access,id,recommendedSource,targetRel,targetRoot" || !/^[a-z][a-z0-9_-]*$/.test(file.id || "")
      || !CREDENTIAL_ROOTS.has(file.targetRoot) || !CREDENTIAL_ACCESS.has(file.access)
      || typeof file.recommendedSource !== "string" || typeof file.targetRel !== "string" || path.isAbsolute(file.targetRel)
      || !file.targetRel || file.targetRel.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
      throw new Error("adapter credential file metadata is invalid");
    }
    const target = `${file.targetRoot}:${file.targetRel}`;
    if (ids.has(file.id) || targets.has(target)) throw new Error("adapter credential metadata contains an id or target collision");
    ids.add(file.id); targets.add(target);
  }
  return deepFreeze({ files: files.map((file) => ({ ...file })), envHints: [...envHints] });
}

// This is deliberately value-free: callers use it before a dry run or before
// opening any credential source.  The host/reviewer own the later byte trust
// boundary, while both phases share one catalog and argv grammar.
function credentialRequest(metadata = {}, { envNames = [], fileSpecs = [] } = {}) {
  const credentials = normalizeCredentialMetadata(metadata);
  if (!Array.isArray(envNames) || !Array.isArray(fileSpecs)) throw new Error("credential options must be arrays");
  const files = new Map(credentials.files.map((item) => [item.id, item]));
  const seenEnv = new Set(), seenIds = new Set(), seenTargets = new Set(), ids = [];
  for (const name of envNames) {
    if (typeof name !== "string" || !CREDENTIAL_ENV_RE.test(name) || RESERVED_CREDENTIAL_ENV.test(name) || seenEnv.has(name)) {
      throw new Error("credential environment name is unsafe, reserved, or duplicated");
    }
    seenEnv.add(name);
  }
  for (const spec of fileSpecs) {
    const equals = typeof spec === "string" ? spec.indexOf("=") : -1;
    const id = equals > 0 ? spec.slice(0, equals) : "", source = equals > 0 ? spec.slice(equals + 1) : "", item = files.get(id);
    if (!item || !path.isAbsolute(source) || path.resolve(source) !== source) {
      throw new Error("credential file must be a declared ID=/absolute/source");
    }
    const target = `${item.targetRoot}:${item.targetRel}`;
    if (seenIds.has(id) || seenTargets.has(target)) throw new Error("credential file contains an id or target collision");
    seenIds.add(id); seenTargets.add(target); ids.push(id);
  }
  return Object.freeze({ metadata: credentials, envNames: Object.freeze([...seenEnv]), fileSpecs: Object.freeze([...fileSpecs]),
    summary: Object.freeze({ env_names: Object.freeze([...seenEnv]), file_ids: Object.freeze(ids) }) });
}

class AdapterCapabilityError extends Error {
  constructor(adapter, phase, reason) {
    super(`adapter '${adapter}' cannot run ${phase}: ${reason}`);
    this.name = "AdapterCapabilityError";
    this.adapter = adapter;
    this.phase = phase;
    this.reason = reason;
  }
}

function requireAbsolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function requireSafeOptionalValue(value, name) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.startsWith("-")) {
    throw new Error(`${name} must be a non-flag string when supplied`);
  }
  return value;
}

function decodeTrustedPrompt(promptBytes) {
  if (!Buffer.isBuffer(promptBytes)) throw new Error("promptBytes must be a Buffer");
  const prompt = promptBytes.toString("utf8");
  if (!Buffer.from(prompt, "utf8").equals(promptBytes)) {
    throw new Error("promptBytes must contain valid canonical UTF-8");
  }
  return Object.freeze({
    prompt,
    sha256: require("crypto").createHash("sha256").update(promptBytes).digest("hex"),
  });
}

function normalizeInvocationShape(invocation, { nested = false, allowControlInvocation = false } = {}) {
  if (!invocation || typeof invocation !== "object") throw new Error("adapter invocation must be an object");
  if (typeof invocation.command !== "string" || !invocation.command || invocation.command.includes("\n")) {
    throw new Error("adapter invocation command must be one executable argv value");
  }
  if (!Array.isArray(invocation.args) || invocation.args.some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new Error("adapter invocation args must be an array of string argv values");
  }
  requireAbsolutePath(invocation.cwd, "adapter invocation cwd");
  if (Boolean(invocation.stdinPath) !== Boolean(invocation.stdinSha256)) {
    throw new Error("adapter invocation stdinPath and stdinSha256 must be supplied together");
  }
  const controlInvocation = invocation.controlInvocation;
  if (controlInvocation && !allowControlInvocation) {
    throw new Error("adapter control invocation metadata must be bound by the adapter contract");
  }
  if (nested && controlInvocation) {
    throw new Error("adapter control invocation cannot contain another control invocation");
  }
  const normalizedControl = controlInvocation
    ? normalizeInvocationShape(controlInvocation, { nested: true })
    : null;
  if (normalizedControl && normalizedControl.cwd !== invocation.cwd) {
    throw new Error("adapter control invocation cwd must match wrapper invocation cwd");
  }
  const normalized = Object.freeze({
    command: invocation.command,
    args: Object.freeze([...invocation.args]),
    cwd: invocation.cwd,
    ...(invocation.stdinPath ? {
      stdinPath: requireAbsolutePath(invocation.stdinPath, "adapter invocation stdinPath"),
      stdinSha256: SHA256_RE.test(invocation.stdinSha256 || "")
        ? invocation.stdinSha256
        : (() => { throw new Error("adapter invocation stdinSha256 must bind stdinPath bytes"); })(),
    } : {}),
    ...(normalizedControl ? { controlInvocation: normalizedControl } : {}),
  });
  if (normalizedControl && allowControlInvocation) CONTROL_BOUND_INVOCATIONS.add(normalized);
  return normalized;
}

function assertInvocationShape(invocation) {
  return normalizeInvocationShape(invocation);
}

function getInvocationAuditTarget(invocation) {
  if (!invocation?.controlInvocation) return invocation;
  if (!CONTROL_BOUND_INVOCATIONS.has(invocation)) {
    throw new Error("adapter control invocation metadata is not contract-bound");
  }
  return invocation.controlInvocation;
}

function readOutput(outputPath) {
  if (!outputPath || !fs.existsSync(outputPath)) return "";
  return fs.readFileSync(outputPath, "utf8");
}

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
  if (!capability.supported) throw new AdapterCapabilityError(adapter.name, phase, capability.reason || "phase is unsupported");
  if (request.readOnly === true && !capability.readOnly) {
    throw new AdapterCapabilityError(adapter.name, phase, "read-only execution is unsupported");
  }
  if (request.networkAccess === "enabled" && capability.networkControl === "unsupported") {
    throw new AdapterCapabilityError(adapter.name, phase, "network control is unsupported");
  }
  return capability;
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
  validateDispatch = null,
}) {
  const phaseMetadata = Object.freeze({ ...phases });
  const parseOutcomeForProtocol = makeParseOutcome(outputProtocol);
  const cliBinary = metadata.cliBinary;
  if (!name || typeof buildDispatch !== "function" || typeof cliBinary !== "string") {
    throw new Error("native adapter requires name, metadata.cliBinary, and buildDispatch");
  }
  if (metadata.processContainment !== PROCESS_CONTAINMENT) throw new Error(`native adapter must declare ${PROCESS_CONTAINMENT} process containment`);
  return Object.freeze({
    name,
    defaults: Object.freeze({ timeoutMs }),
    metadata: deepFreeze({ ...metadata, credentials: normalizeCredentialMetadata(metadata.credentials) }),
    probe({ env = process.env, timeoutMs: probeTimeoutMs = 5000, spawn = spawnSync } = {}) {
      const binary = metadata.cliBinaryEnv && env[metadata.cliBinaryEnv]
        ? env[metadata.cliBinaryEnv]
        : cliBinary;
      return probeBinary(binary, { env, timeoutMs: probeTimeoutMs, spawn });
    },
    capabilities({ phase, request = null }) {
      const value = phaseMetadata[phase];
      if (!value) return Object.freeze({ supported: false, reason: "unknown phase" });
      if (value.supported && phase === "dispatch" && request && validateDispatch) {
        const validation = validateDispatch({
          sandbox: request.sandbox || (request.readOnly ? "read-only" : "workspace-write"),
          networkAccess: request.networkAccess || "disabled",
        });
        if (!validation.ok) return Object.freeze({ ...value, supported: false, reason: validation.error, warnings: validation.warnings || [] });
        return Object.freeze({ ...value, warnings: validation.warnings || [] });
      }
      return Object.freeze({ ...value });
    },
    buildInvocation({ phase, cwd, promptPath, promptBytes, resultPath, schemaPath = null, model = null, timeoutMs: requestedTimeoutMs, sandbox = "workspace-write", networkAccess = "disabled", reasoning = null }) {
      validateCapabilities(this, phase, { readOnly: sandbox === "read-only", sandbox, networkAccess });
      requireAbsolutePath(cwd, "cwd");
      requireAbsolutePath(promptPath, "promptPath");
      requireAbsolutePath(resultPath, "resultPath");
      if (schemaPath) requireAbsolutePath(schemaPath, "schemaPath");
      requireSafeOptionalValue(model, "model");
      const trustedPrompt = decodeTrustedPrompt(promptBytes);
      const prompt = trustedPrompt.prompt;
      if (phase !== "dispatch") {
        if (!buildReview) throw new AdapterCapabilityError(name, phase, "no direct review invocation is registered");
        return assertInvocationShape(buildReview({
          cwd,
          prompt,
          promptPath,
          promptSha256: trustedPrompt.sha256,
          resultPath,
          schemaPath,
          model,
          timeoutSeconds: Math.max(1, Math.floor((requestedTimeoutMs || timeoutMs) / 1000)),
        }));
      }
      const invocation = buildDispatch({
        cwd,
        prompt,
        promptPath,
        promptSha256: trustedPrompt.sha256,
        resultPath,
        model,
        sandbox,
        networkAccess,
        reasoning,
        timeoutSeconds: Math.max(1, Math.floor((requestedTimeoutMs || timeoutMs) / 1000)),
      });
      return assertInvocationShape(invocation);
    },
    parseOutcome(input) {
      const outcome = parseOutcomeForProtocol(input);
      if (outcome.status === "failed" && metadata.resultErrorLabel && outcome.summary.startsWith("jsonl_run_result line ")) {
        return Object.freeze({
          ...outcome,
          summary: outcome.summary.replace("jsonl_run_result line ", `${metadata.resultErrorLabel} line `),
        });
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
  assertInvocationShape,
  getInvocationAuditTarget,
  createNativeAdapter,
  credentialRequest,
  decodeTrustedPrompt,
  formatAdapterPhase,
  makeParseOutcome,
  parseOutput,
  parseJsonObject,
  probeBinary,
  recoverExecStdout,
  requireAbsolutePath,
  requireSafeOptionalValue,
  resolveAdapterProvider,
  validateCapabilities,
};
