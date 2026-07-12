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

// Bound a single diagnostic-`ids` value (#945 D7). Every string is passed through
// boundedExcerpt so a wedged/adversarial CLI cannot inflate or line-inject a value
// that reaches the report inside `ids` (not only inside `message`). Numbers, nulls,
// and booleans are inherently bounded stable identifiers and pass through; arrays are
// bounded element-wise (e.g. the `outcomes` id list on DUPLICATE_MAPPING).
function boundIdValue(value) {
  if (typeof value === "string") return boundedExcerpt(value);
  if (Array.isArray(value)) return value.map(boundIdValue);
  return value;
}

// Bound EVERY value of a diagnostic `ids` object. Diagnostic ids must be normalized
// stable identifiers; any subprocess-derived value routed through here can never
// exceed the ≤256-char excerpt limit (marker included).
function boundedIds(ids) {
  const out = {};
  for (const [key, value] of Object.entries(ids || {})) out[key] = boundIdValue(value);
  return out;
}

module.exports = { EXCERPT_LIMIT, boundedExcerpt, parseJson, isNonEmptyString, boundIdValue, boundedIds };
