"use strict";

// Decision + authorization record shaping and validation (#947 D4/D5). Pure: no I/O.
// The records live in the receipt (additive `decisions` / `authorizations` fields) and
// are WRITTEN only from an explicit run/resume operator flag — this module only shapes
// and validates them; the atomic receipt write lives in the top-level scripts.

// The SIX verbatim provenance keys a `decision:` gate resolves against (D4). A record
// missing ANY of these keys is invalid → the gate is `unevaluable` (fail closed), never
// passed. `options` must be an array; `downstream_wave` must be an integer OR null.
const DECISION_KEYS = Object.freeze(["question", "options", "resolution", "resolver", "resolved_at", "downstream_wave"]);

// Validate a decision record's provenance. Returns { valid, missingKey }. The first
// missing/ill-typed key is named so the diagnostic can point at it (D4). A structurally
// valid record may still be UNRESOLVED (empty resolution) — that is a separate state the
// evaluator maps to awaiting_decision, not an invalidity.
function validateDecisionRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return { valid: false, missingKey: "question" };
  for (const key of DECISION_KEYS) {
    if (!(key in record)) return { valid: false, missingKey: key };
  }
  if (!Array.isArray(record.options)) return { valid: false, missingKey: "options" };
  if (!(record.downstream_wave === null || Number.isInteger(record.downstream_wave))) {
    return { valid: false, missingKey: "downstream_wave" };
  }
  if (typeof record.question !== "string" || typeof record.resolution !== "string" || typeof record.resolver !== "string") {
    return { valid: false, missingKey: typeof record.question !== "string" ? "question" : (typeof record.resolution !== "string" ? "resolution" : "resolver") };
  }
  if (typeof record.resolved_at !== "string") return { valid: false, missingKey: "resolved_at" };
  return { valid: true, missingKey: null };
}

// A structurally valid record is RESOLVED only when its resolution is a non-empty string.
function isResolved(record) {
  const check = validateDecisionRecord(record);
  return check.valid && record.resolution.trim() !== "";
}

// Build a full 6-key decision record from an operator flag trio + the program's declared
// decision-gate definition (which supplies the question/options/downstream_wave
// provenance) + a caller-supplied resolved_at timestamp. When the program does not
// declare the gate, the provenance defaults are conservative (empty question/options),
// which keeps the record structurally valid but auditable. NOT a write — the caller
// persists it.
function buildDecisionRecord({ id, resolution, resolver, resolvedAt, gateDef }) {
  const def = gateDef && typeof gateDef === "object" ? gateDef : {};
  const question = typeof def.question === "string" ? def.question : (typeof def.description === "string" ? def.description : "");
  const options = Array.isArray(def.options) ? def.options.slice() : [];
  const downstreamWave = Number.isInteger(def.downstream_wave) ? def.downstream_wave : null;
  return {
    id,
    question,
    options,
    resolution: typeof resolution === "string" ? resolution : "",
    resolver: typeof resolver === "string" ? resolver : "",
    resolved_at: typeof resolvedAt === "string" ? resolvedAt : "",
    downstream_wave: downstreamWave,
  };
}

// Build an authorization record (D5). Simpler than a decision: an explicit id plus the
// authorizing handle. Presence of a matching record is what an `authorization:` gate
// requires; absence is never a pass.
function buildAuthorizationRecord({ id, authorizer }) {
  return { id, authorizer: typeof authorizer === "string" ? authorizer : "" };
}

// Find a record by id in an additive receipt array (decisions/authorizations).
function findById(records, id) {
  if (!Array.isArray(records)) return null;
  return records.find((record) => record && record.id === id) || null;
}

module.exports = {
  DECISION_KEYS,
  validateDecisionRecord,
  isResolved,
  buildDecisionRecord,
  buildAuthorizationRecord,
  findById,
};
