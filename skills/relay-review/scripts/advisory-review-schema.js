const {
  formatAdapterPhase,
} = require("../../relay-dispatch/scripts/agent-adapters/transport");
const { parsePossiblyWrappedReviewerJsonObject } = require("./reviewer-helpers");

const ADVISORY_PROFILES = Object.freeze(["blindspot"]);
const ADVISORY_SEVERITIES = new Set(["P1", "P2", "P3"]);
const ADVISORY_CATEGORIES = new Set([
  "test-gap",
  "bypass",
  "edge-case",
  "integration",
  "docs",
  "other",
]);

function requireString(value, location) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value.trim();
}

function requireFinding(value, location) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  const severity = requireString(value.severity, `${location}.severity`);
  const category = requireString(value.category, `${location}.category`);
  const confidence = value.confidence;
  if (!ADVISORY_SEVERITIES.has(severity)) {
    throw new Error(`${location}.severity must be one of: P1, P2, P3`);
  }
  if (!ADVISORY_CATEGORIES.has(category)) {
    throw new Error(`${location}.category must be one of: ${[...ADVISORY_CATEGORIES].join(", ")}`);
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`${location}.confidence must be a number from 0 to 1`);
  }
  let line = null;
  if (value.line !== undefined && value.line !== null) {
    if (!Number.isInteger(value.line) || value.line <= 0) {
      throw new Error(`${location}.line must be a positive integer or null`);
    }
    line = value.line;
  }
  return {
    title: requireString(value.title, `${location}.title`),
    body: requireString(value.body, `${location}.body`),
    file: requireString(value.file, `${location}.file`),
    line,
    severity,
    category,
    confidence,
  };
}

function normalizeFindingArray(value, location) {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array`);
  }
  return value.map((finding, index) => requireFinding(finding, `${location}[${index}]`));
}

function validateAdvisoryProfile(profile) {
  const normalized = String(profile || "blindspot").trim();
  if (!ADVISORY_PROFILES.includes(normalized)) {
    throw new Error(`Unknown advisory profile '${profile}'. Supported profiles: ${ADVISORY_PROFILES.join(", ")}`);
  }
  return normalized;
}

function normalizeAdvisoryJsonText(text) {
  const raw = String(text);
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```[ \t]*json[ \t]*\r?\n([\s\S]*)\r?\n```[ \t]*$/i);
  return fenced ? fenced[1].trim() : raw;
}

function rethrowWithContext(error, context) {
  const message = error?.message || String(error);
  if (message.startsWith(`${context} `)) {
    throw error;
  }
  throw new Error(`${context} ${message}`);
}

function parseAdvisoryReview(text, {
  adapter = "advisory",
  phase = "advisory_review",
  profile = "blindspot",
} = {}) {
  const expectedProfile = validateAdvisoryProfile(profile);
  const context = formatAdapterPhase({ adapter, phase });
  try {
    const parsed = parsePossiblyWrappedReviewerJsonObject(normalizeAdvisoryJsonText(text), {
      adapter,
      phase,
      description: "advisory review",
    });
    const actualProfile = requireString(parsed.profile, "profile");
    if (actualProfile !== expectedProfile) {
      throw new Error(`profile must be '${expectedProfile}', got '${actualProfile}'`);
    }
    return {
      profile: actualProfile,
      summary: requireString(parsed.summary, "summary"),
      required_findings: normalizeFindingArray(parsed.required_findings, "required_findings"),
      advisory_findings: normalizeFindingArray(parsed.advisory_findings, "advisory_findings"),
      duplicate_or_low_confidence: normalizeFindingArray(parsed.duplicate_or_low_confidence, "duplicate_or_low_confidence"),
    };
  } catch (error) {
    rethrowWithContext(error, context);
  }
}

module.exports = {
  ADVISORY_PROFILES,
  normalizeAdvisoryJsonText,
  parseAdvisoryReview,
  validateAdvisoryProfile,
};
