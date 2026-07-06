"use strict";

const ROUTE_REGISTRATION_REASONS = new Set([
  "denied_model_route",
  "unknown_model_route",
]);

const DEFAULT_MODEL_REASONS = new Set([
  "missing_model_route",
  "provider_model_route_required",
]);

const KNOWN_CLI_BINARIES = [
  "opencode",
  "pi",
  "agy",
  "agent",
  "cline",
  "codex",
  "claude",
];

function hintForPolicyDecision(decision) {
  const reason = decision?.reason;
  if (DEFAULT_MODEL_REASONS.has(reason)) {
    return "run relay-config to set a default model for this route";
  }
  if (ROUTE_REGISTRATION_REASONS.has(reason)) {
    return "run relay-config to register this route";
  }
  return null;
}

function hintForCliBinary(binary) {
  const normalized = typeof binary === "string" ? binary.trim() : "";
  if (!normalized) return null;
  return `install the ${normalized} CLI and ensure it is on PATH`;
}

function textFromError(error) {
  return [error?.message, error?.stdout, error?.stderr]
    .map((part) => {
      if (Buffer.isBuffer(part)) return part.toString("utf-8");
      return typeof part === "string" ? part : "";
    })
    .filter(Boolean)
    .join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function hintForCliFailure(error, { binary = null } = {}) {
  if (binary) return hintForCliBinary(binary);
  const text = textFromError(error);
  if (!text) return null;

  for (const candidate of KNOWN_CLI_BINARIES) {
    const escaped = escapeRegExp(candidate);
    const cliNotFound = new RegExp(`\\b${escaped}\\b CLI not found`, "i");
    const enoentAfterBinary = new RegExp(`\\b${escaped}\\b[^\\n]*\\bENOENT\\b`, "i");
    const binaryAfterEnoent = new RegExp(`\\bENOENT\\b[^\\n]*\\b${escaped}\\b`, "i");
    const commandNotFound = new RegExp(`\\b${escaped}\\b[^\\n]*(?:command not found|not found)`, "i");
    if (
      cliNotFound.test(text) ||
      enoentAfterBinary.test(text) ||
      binaryAfterEnoent.test(text) ||
      commandNotFound.test(text)
    ) {
      return hintForCliBinary(candidate);
    }
  }
  return null;
}

function withHint(envelope, hint) {
  return hint ? { ...envelope, hint } : envelope;
}

module.exports = {
  hintForCliBinary,
  hintForCliFailure,
  hintForPolicyDecision,
  withHint,
};
