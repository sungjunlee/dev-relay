"use strict";

const assert = require("node:assert/strict");

// These tokens are forbidden only in receipt semantic fields and values. The receipt's
// documented `source` and `repo.root` fields are paths, so a worktree directory such as
// `/home/user/.codex/...` is not an engine/provider leak.
const FORBIDDEN_RECEIPT_TOKENS = Object.freeze([
  "codex",
  "claude",
  "gpt",
  "opus",
  "sonnet",
  "haiku",
  "gemini",
  "cursor",
  "cline",
  "grok",
  "glm",
  "opencode",
  "engine",
  "model",
  "reviewer",
  "executor",
  "provider",
]);

const PATH_BEARING_FIELDS = Object.freeze(new Set(["source", "repo.root"]));

function containsForbiddenToken(value) {
  const lowered = String(value).toLowerCase();
  return FORBIDDEN_RECEIPT_TOKENS.find((token) => lowered.includes(token)) || null;
}

function fieldPath(parent, key) {
  return parent ? `${parent}.${key}` : key;
}

function assertReceiptValueIsClean(value, currentPath) {
  if (typeof value === "string") {
    if (PATH_BEARING_FIELDS.has(currentPath)) return;
    const token = containsForbiddenToken(value);
    assert.equal(token, null, `receipt semantic value at ${currentPath} leaked ${token}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertReceiptValueIsClean(entry, `${currentPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;

  Object.entries(value).forEach(([key, nested]) => {
    const nestedPath = fieldPath(currentPath, key);
    if (!PATH_BEARING_FIELDS.has(nestedPath)) {
      const token = containsForbiddenToken(key);
      assert.equal(token, null, `receipt semantic field ${nestedPath} leaked ${token}`);
    }
    assertReceiptValueIsClean(nested, nestedPath);
  });
}

function assertReceiptEngineAgnostic(receipt) {
  assertReceiptValueIsClean(receipt, "");
}

module.exports = {
  FORBIDDEN_RECEIPT_TOKENS,
  PATH_BEARING_FIELDS,
  assertReceiptEngineAgnostic,
};
