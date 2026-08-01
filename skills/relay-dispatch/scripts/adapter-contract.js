const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PHASES = Object.freeze(["dispatch", "primary_review"]);
const OUTPUT_PROTOCOLS = Object.freeze(["text_stdout", "json_result", "jsonl_run_result"]);
const INVOCATION_IDENTITIES = new WeakMap();
const CONTROL_BOUND_INVOCATIONS = new WeakSet();

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

function normalizeInvocationShape(invocation, { nested = false, allowControlInvocation = false } = {}) {
  if (!invocation || typeof invocation !== "object") throw new Error("adapter invocation must be an object");
  if (typeof invocation.command !== "string" || !invocation.command || invocation.command.includes("\n")) {
    throw new Error("adapter invocation command must be one executable argv value");
  }
  if (!Array.isArray(invocation.args) || invocation.args.some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new Error("adapter invocation args must be an array of string argv values");
  }
  requireAbsolutePath(invocation.cwd, "adapter invocation cwd");
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
    ...(normalizedControl ? { controlInvocation: normalizedControl } : {}),
  });
  if (normalizedControl && allowControlInvocation) CONTROL_BOUND_INVOCATIONS.add(normalized);
  return normalized;
}

function assertInvocationShape(invocation) {
  return normalizeInvocationShape(invocation);
}

function executableIdentity(command) {
  const stat = fs.statSync(command);
  return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode });
}

function bindInvocationIdentity(invocation, identity) {
  INVOCATION_IDENTITIES.set(invocation, identity);
  return invocation;
}

function getInvocationAuditTarget(invocation) {
  if (!invocation?.controlInvocation) return invocation;
  if (!CONTROL_BOUND_INVOCATIONS.has(invocation)) {
    throw new Error("adapter control invocation metadata is not contract-bound");
  }
  return invocation.controlInvocation;
}

function assertInvocationIdentity(invocation) {
  const expected = INVOCATION_IDENTITIES.get(invocation);
  if (!expected) return invocation;
  let actual;
  try {
    actual = executableIdentity(invocation.command);
  } catch (error) {
    throw new Error(`adapter invocation executable identity cannot be revalidated: ${error.message}`);
  }
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.mode !== expected.mode) {
    throw new Error("adapter invocation executable identity changed after validation");
  }
  return invocation;
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

function makeLegacyCliAdapter({
  name,
  legacy,
  phases,
  outputProtocol,
  reviewScript = null,
  buildReviewControlInvocation = null,
  omitImplicitReasoning = false,
  metadata = {},
}) {
  if (!legacy || typeof legacy.buildExecCommand !== "function" || typeof legacy.probe !== "function") {
    throw new Error(`legacy bridge for '${name}' is incomplete`);
  }
  const phaseMetadata = Object.freeze({ ...phases });
  const parseOutcomeForProtocol = makeParseOutcome(outputProtocol);
  return Object.freeze({
    name,
    defaults: Object.freeze({ timeoutMs: Number(legacy.defaultTimeout || 1800) * 1000 }),
    metadata: Object.freeze({ cliBinary: legacy.cliBinary, outputProtocol: typeof outputProtocol === "string" ? outputProtocol : "phase-specific", ...metadata, reviewScript }),
    probe({ env = process.env, timeoutMs = 5000, spawn = spawnSync } = {}) {
      const binary = metadata.cliBinaryEnv && env[metadata.cliBinaryEnv]
        ? env[metadata.cliBinaryEnv]
        : legacy.cliBinary;
      return probeBinary(binary, { env, timeoutMs, spawn });
    },
    capabilities({ phase, request = null }) {
      const value = phaseMetadata[phase];
      if (!value) return Object.freeze({ supported: false, reason: "unknown phase" });
      if (value.supported && phase === "dispatch" && request && typeof legacy.validateExecutionMode === "function") {
        const validation = legacy.validateExecutionMode({
          sandbox: request.sandbox || (request.readOnly ? "read-only" : "workspace-write"),
          networkAccess: request.networkAccess || "disabled",
        });
        if (!validation.ok) return Object.freeze({ ...value, supported: false, reason: validation.error, warnings: validation.warnings || [] });
        return Object.freeze({ ...value, warnings: validation.warnings || [] });
      }
      return Object.freeze({ ...value });
    },
    buildInvocation({ phase, cwd, promptPath, resultPath, model = null, timeoutMs, sandbox = "workspace-write", networkAccess = "disabled", reasoning = null }) {
      validateCapabilities(this, phase, { readOnly: sandbox === "read-only", sandbox, networkAccess });
      requireAbsolutePath(cwd, "cwd");
      requireAbsolutePath(promptPath, "promptPath");
      requireAbsolutePath(resultPath, "resultPath");
      requireSafeOptionalValue(model, "model");
      if (phase !== "dispatch") {
        if (!reviewScript) throw new AdapterCapabilityError(name, phase, "no review invocation bridge is registered");
        const args = [reviewScript, "--repo", cwd, "--prompt-file", promptPath, "--json"];
        args.push("--phase", phase);
        if (model) args.push("--model", model);
        const controlInvocation = buildReviewControlInvocation
          ? buildReviewControlInvocation({ phase, cwd, promptPath, resultPath, model, timeoutMs })
          : null;
        return normalizeInvocationShape({
          command: process.execPath,
          args,
          cwd,
          ...(controlInvocation ? { controlInvocation } : {}),
        }, { allowControlInvocation: true });
      }
      const prompt = fs.readFileSync(promptPath, "utf8");
      const built = legacy.buildExecCommand({
        wtPath: cwd,
        resultFile: resultPath,
        prompt,
        model,
        sandbox,
        networkAccess,
        reasoning,
        timeoutSeconds: Math.max(1, Math.floor((timeoutMs || legacy.defaultTimeout * 1000) / 1000)),
      });
      const args = [...built.args];
      if (omitImplicitReasoning && !reasoning) {
        const reasoningIndex = args.findIndex((value, index) => (
          value === "-c"
          && /^model_reasoning_effort=/.test(String(args[index + 1] || ""))
        ));
        if (reasoningIndex >= 0) args.splice(reasoningIndex, 2);
      }
      return assertInvocationShape({ command: built.cmd, args, cwd: built.cwd || cwd });
    },
    parseOutcome(input) {
      const outcome = parseOutcomeForProtocol(input);
      if (
        outcome.status === "failed"
        && metadata.resultErrorLabel
        && outcome.summary.startsWith("jsonl_run_result line ")
      ) {
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
  PHASES,
  assertInvocationShape,
  assertInvocationIdentity,
  bindInvocationIdentity,
  executableIdentity,
  getInvocationAuditTarget,
  makeLegacyCliAdapter,
  makeParseOutcome,
  parseOutput,
  probeBinary,
  requireAbsolutePath,
  requireSafeOptionalValue,
  resolveAdapterProvider,
  validateCapabilities,
};
