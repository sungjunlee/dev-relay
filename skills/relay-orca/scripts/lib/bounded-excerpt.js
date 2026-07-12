"use strict";

// Shared bounded-rendering + JSON-parse helpers for the read-only `status` adapters
// (#945 D7). Every subprocess-derived value embedded in a diagnostic message passes
// through boundedExcerpt so a wedged or adversarial CLI cannot inflate or line-inject
// the status report — the SAME ≤256-char rule the probe uses. Pure: no subprocess, no
// fs mutation.
const EXCERPT_LIMIT = 256;

function boundedExcerpt(value) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= EXCERPT_LIMIT) return text;
  return `${text.slice(0, EXCERPT_LIMIT - 1)}…`;
}

function parseJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { ok: false, error: "empty stdout" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error.message, excerpt: boundedExcerpt(text) };
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

module.exports = { EXCERPT_LIMIT, boundedExcerpt, parseJson, isNonEmptyString };
