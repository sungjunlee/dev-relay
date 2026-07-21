"use strict";

// Pure trust-contract helpers for generic integration:<check> evidence (#1046).
// Filesystem reads stay in status.js; these helpers only validate injected values and
// derive collision-resistant names. The accepted program is the authority for the
// exact raw reference and the immutable verification binding.
const crypto = require("node:crypto");

const INTEGRATION_EVIDENCE_VERSION = 1;
const VERIFICATION_KEYS = Object.freeze(["binding_sha256", "input_sha256", "passed", "result_sha256"]);
const ARTIFACT_KEYS = Object.freeze(["check_ref", "evidence", "program_id", "runtime_id", "schema", "verification"]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_RAW_REF_LENGTH = 256;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function verificationBinding({ input_sha256, result_sha256, passed }) {
  const binding = { input_sha256, result_sha256, passed };
  return { ...binding, binding_sha256: sha256(canonicalJson(binding)) };
}

function rawRefError(ref) {
  if (typeof ref !== "string" || ref.length === 0) return "raw check ref must be a non-empty string";
  if (ref.length > MAX_RAW_REF_LENGTH) return `raw check ref exceeds ${MAX_RAW_REF_LENGTH} characters`;
  if (/[\u0000-\u001f\u007f]/.test(ref)) return "raw check ref contains a control character";
  if (ref.includes("\\")) return "raw check ref contains a backslash";
  if (ref.startsWith("/") || /^[A-Za-z]:[\\/]/.test(ref)) return "raw check ref must not be an absolute path";
  const segments = ref.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "raw check ref contains an unsafe path segment";
  }
  return null;
}

function isSafeRawRef(ref) {
  return rawRefError(ref) === null;
}

function sanitizeArtifactName(ref) {
  return String(ref == null ? "" : ref).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "gate";
}

// The readable prefix is not authority. The full raw-ref hash is always part of the
// filename, so refs such as a/b and a-b cannot address the same artifact.
function artifactFileName(ref) {
  return `${sanitizeArtifactName(ref)}-${crypto.createHash("sha256").update(ref).digest("hex")}.json`;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateVerification(verification) {
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
    return { valid: false, reason: "verification binding is missing or not an object" };
  }
  const keys = Object.keys(verification).sort();
  if (keys.length !== VERIFICATION_KEYS.length || keys.some((key, index) => key !== [...VERIFICATION_KEYS].sort()[index])) {
    return { valid: false, reason: `verification binding must contain exactly ${VERIFICATION_KEYS.join(", ")}` };
  }
  if (!SHA256.test(verification.input_sha256) || !SHA256.test(verification.result_sha256) || !SHA256.test(verification.binding_sha256)) {
    return { valid: false, reason: "verification input/result/binding must use sha256 digests" };
  }
  if (typeof verification.passed !== "boolean") return { valid: false, reason: "verification.passed must be boolean" };
  const expected = verificationBinding(verification);
  if (expected.binding_sha256 !== verification.binding_sha256) {
    return { valid: false, reason: "verification binding digest does not match its input/result" };
  }
  return { valid: true };
}

function validateDeclaration(declaration, { programId, runtimeId, checkRef, requireRuntime = true }) {
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    return { valid: false, reason: "integration evidence declaration is missing or not an object" };
  }
  const refError = rawRefError(declaration.check_ref);
  if (refError) return { valid: false, reason: refError };
  if (declaration.program_id !== programId) return { valid: false, reason: "program_id does not match the accepted program" };
  if (typeof declaration.runtime_id !== "string" || declaration.runtime_id.length === 0) {
    return { valid: false, reason: "runtime_id does not match the accepted runtime" };
  }
  if (requireRuntime && (typeof runtimeId !== "string" || runtimeId.length === 0 || declaration.runtime_id !== runtimeId)) {
    return { valid: false, reason: "runtime_id does not match the accepted runtime" };
  }
  if (declaration.check_ref !== checkRef) return { valid: false, reason: "check_ref does not match the exact raw gate reference" };
  const verification = validateVerification(declaration.verification);
  if (!verification.valid) return verification;
  return { valid: true };
}

// Index the accepted program's generic integration declarations. Every required raw ref
// gets one deterministic entry or one deterministic error; duplicates and unbound extras
// are never silently ignored.
function indexDeclarations({ programId, runtimeId, refs, version, declarations, requireRuntime = true }) {
  const requiredRefs = [...new Set(Array.isArray(refs) ? refs : [])];
  const byRef = new Map();
  const errors = new Map();
  if (requiredRefs.length === 0) return { byRef, errors };
  const setAll = (message) => requiredRefs.forEach((ref) => errors.set(ref, message));
  if (version !== INTEGRATION_EVIDENCE_VERSION) {
    setAll(`integration evidence contract version ${INTEGRATION_EVIDENCE_VERSION} is required`);
    return { byRef, errors };
  }
  if (!Array.isArray(declarations)) {
    setAll("accepted program has no integration_evidence declarations");
    return { byRef, errors };
  }

  const grouped = new Map();
  let invalidDeclaration = null;
  declarations.forEach((declaration) => {
    const ref = declaration && typeof declaration === "object" ? declaration.check_ref : null;
    if (typeof ref !== "string") {
      invalidDeclaration = invalidDeclaration || "integration evidence declaration has no check_ref";
      return;
    }
    const entries = grouped.get(ref) || [];
    entries.push(declaration);
    grouped.set(ref, entries);
  });
  if (invalidDeclaration) setAll(invalidDeclaration);

  requiredRefs.forEach((ref) => {
    const entries = grouped.get(ref) || [];
    if (entries.length === 0) {
      errors.set(ref, "accepted program has no identity declaration for this raw check ref");
    } else if (entries.length > 1) {
      errors.set(ref, "accepted program has duplicate/conflicting identity declarations for this raw check ref");
    } else {
      const check = validateDeclaration(entries[0], { programId, runtimeId, checkRef: ref, requireRuntime });
      if (!check.valid) errors.set(ref, check.reason);
      else byRef.set(ref, entries[0]);
    }
  });
  for (const [ref] of grouped) {
    if (!requiredRefs.includes(ref)) setAll(`accepted program declares unbound integration check ref "${ref}"`);
  }
  return { byRef, errors };
}

function validateArtifact(artifact, { declaration, programId, runtimeId, checkRef }) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return { valid: false, reason: "integration evidence artifact is not an object" };
  }
  if (artifact.schema !== INTEGRATION_EVIDENCE_VERSION) return { valid: false, reason: "integration evidence artifact schema is unsupported" };
  if (Object.keys(artifact).some((key) => !ARTIFACT_KEYS.includes(key))) {
    return { valid: false, reason: "integration evidence artifact contains an unsupported authority field" };
  }
  const identity = validateDeclaration(artifact, { programId, runtimeId, checkRef });
  if (!identity.valid) return { valid: false, reason: identity.reason };
  if (!declaration || !sameJson(artifact.verification, declaration.verification)) {
    return { valid: false, reason: "verification input/result binding does not match the accepted declaration" };
  }
  return {
    valid: true,
    passed: artifact.verification.passed === true,
    evidence: typeof artifact.evidence === "string" && artifact.evidence ? artifact.evidence : `check ${checkRef}`,
  };
}

module.exports = {
  ARTIFACT_KEYS,
  INTEGRATION_EVIDENCE_VERSION,
  MAX_RAW_REF_LENGTH,
  VERIFICATION_KEYS,
  artifactFileName,
  canonicalJson,
  indexDeclarations,
  isSafeRawRef,
  rawRefError,
  sanitizeArtifactName,
  sha256,
  validateArtifact,
  validateDeclaration,
  validateVerification,
  verificationBinding,
};
