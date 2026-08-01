const path = require("path");
const fs = require("fs");
const {
  OUTPUT_PROTOCOLS,
  bindInvocationIdentity,
  executableIdentity,
  assertInvocationShape,
  makeParseOutcome,
  probeBinary,
  requireAbsolutePath,
  requireSafeOptionalValue,
  validateCapabilities,
} = require("../adapter-contract");

const PLACEHOLDERS = new Set(["{cwd}", "{promptPath}", "{resultPath}", "{model}", "{timeoutMs}"]);
const SCHEMA_KEYS = new Set(["name", "command", "args", "cwd", "output_protocol", "capabilities"]);
const CAPABILITY_KEYS = Object.freeze(["write", "readOnly", "networkControl", "cancellation", "structuredOutput"]);
const CAPABILITY_ENUMS = Object.freeze({
  networkControl: ["native", "informational", "unsupported"],
  cancellation: ["native", "process", "unsupported"],
  structuredOutput: ["json", "jsonl", "text"],
});

function validateTemplateValue(value) {
  if (typeof value !== "string" || !PLACEHOLDERS.has(value)) {
    if (typeof value === "string" && value.includes("{")) {
      throw new Error(`generic adapter template placeholder must occupy a whole argv item: ${value}`);
    }
    return;
  }
}

function validateSchema(schema, { approvedAdapterDir = null } = {}) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("generic adapter schema must be an object");
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.has(key)) throw new Error(`generic adapter schema has unknown key '${key}'`);
  if (!/^[a-z0-9-]+$/.test(schema.name || "")) throw new Error("generic adapter schema name must be lowercase kebab-case");
  if (typeof schema.command !== "string" || !schema.command || /[\n\0]/.test(schema.command) || (!path.isAbsolute(schema.command) && /\s/.test(schema.command))) throw new Error("generic adapter command must be one executable value");
  let canonicalCommand = schema.command;
  let commandIdentity = null;
  if (schema.command.includes(path.sep)) {
    if (!path.isAbsolute(schema.command) || !approvedAdapterDir) throw new Error("generic adapter command path must be absolute inside approvedAdapterDir");
    let realApproved;
    let realCommand;
    try {
      realApproved = fs.realpathSync(approvedAdapterDir);
      realCommand = fs.realpathSync(schema.command);
    } catch (error) {
      throw new Error(`generic adapter command containment could not be resolved: ${error.message}`);
    }
    const relative = path.relative(realApproved, realCommand);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("generic adapter command path escapes approvedAdapterDir");
    }
    canonicalCommand = realCommand;
    commandIdentity = executableIdentity(realCommand);
  }
  if (!Array.isArray(schema.args) || schema.args.some((value) => typeof value !== "string")) throw new Error("generic adapter args must be string argv template values");
  schema.args.forEach(validateTemplateValue);
  if (schema.cwd !== "{cwd}") throw new Error("generic adapter cwd must be {cwd}");
  if (!OUTPUT_PROTOCOLS.includes(schema.output_protocol)) throw new Error(`generic adapter output_protocol must be one of ${OUTPUT_PROTOCOLS.join(", ")}`);
  if (!schema.capabilities || typeof schema.capabilities !== "object" || Array.isArray(schema.capabilities)) throw new Error("generic adapter requires capabilities");
  const capabilityKeys = Object.keys(schema.capabilities).sort();
  assertExactKeys(capabilityKeys, [...CAPABILITY_KEYS].sort(), "generic adapter capabilities");
  if (typeof schema.capabilities.write !== "boolean" || typeof schema.capabilities.readOnly !== "boolean") {
    throw new Error("generic adapter capabilities write and readOnly must be booleans");
  }
  for (const [key, allowed] of Object.entries(CAPABILITY_ENUMS)) {
    if (!allowed.includes(schema.capabilities[key])) throw new Error(`generic adapter capability ${key} must be one of ${allowed.join(", ")}`);
  }
  return Object.freeze({ canonicalCommand, commandIdentity });
}

function assertExactKeys(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function renderArgs(template, values) {
  const rendered = [];
  for (let index = 0; index < template.length; index += 1) {
    const item = template[index];
    if (item === "{model}" && !values["{model}"]) {
      if (rendered.length && /^--?[a-z][a-z0-9-]*$/i.test(rendered[rendered.length - 1])) rendered.pop();
      continue;
    }
    const value = Object.prototype.hasOwnProperty.call(values, item) ? values[item] : item;
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`generic adapter could not render ${item}`);
    rendered.push(value);
  }
  return rendered;
}

function createGenericAdapter(schema, options = {}) {
  const validated = validateSchema(schema, options);
  const capability = Object.freeze({ supported: true, ...schema.capabilities });
  const parseOutcome = makeParseOutcome(schema.output_protocol);
  return Object.freeze({
    name: schema.name,
    defaults: Object.freeze({ timeoutMs: 1800000 }),
    metadata: Object.freeze({ outputProtocol: schema.output_protocol, generic: true }),
    probe(options = {}) { return probeBinary(validated.canonicalCommand, options); },
    capabilities({ phase }) { return Object.freeze(phase === "dispatch" ? { ...capability } : { supported: false, reason: "generic adapters support dispatch only" }); },
    buildInvocation({ phase, cwd, promptPath, resultPath, model = null, timeoutMs = 1800000, sandbox = "workspace-write", networkAccess = "disabled" }) {
      validateCapabilities(this, phase, { readOnly: sandbox === "read-only", networkAccess });
      requireAbsolutePath(cwd, "cwd");
      requireAbsolutePath(promptPath, "promptPath");
      requireAbsolutePath(resultPath, "resultPath");
      requireSafeOptionalValue(model, "model");
      const invocation = assertInvocationShape({
        command: validated.canonicalCommand,
        args: renderArgs(schema.args, { "{cwd}": cwd, "{promptPath}": promptPath, "{resultPath}": resultPath, "{model}": model, "{timeoutMs}": String(timeoutMs) }),
        cwd,
      });
      return validated.commandIdentity
        ? bindInvocationIdentity(invocation, validated.commandIdentity)
        : invocation;
    },
    parseOutcome,
  });
}

module.exports = { createGenericAdapter, validateSchema };
