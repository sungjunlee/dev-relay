const { REVIEW_VERDICT_JSON_SCHEMA } = require("../review-schema");

const ALLOWED_VERDICTS = new Set(["pass", "changes_requested", "escalated"]);
const ALLOWED_NEXT_ACTIONS = new Set(["ready_to_merge", "changes_requested", "escalated"]);
const ALLOWED_STATUSES = new Set(["pass", "fail", "not_run"]);
const ALLOWED_SCORE_TIERS = new Set(["contract", "quality"]);
const ALLOWED_DRIFT_STATUSES = new Set(
  REVIEW_VERDICT_JSON_SCHEMA.properties.scope_drift.properties.missing.items.properties.status.enum
);
const REVIEW_VERDICT_KEYS = Object.keys(REVIEW_VERDICT_JSON_SCHEMA.properties);
const ISSUE_KEYS = Object.keys(REVIEW_VERDICT_JSON_SCHEMA.properties.issues.items.properties);
const RUBRIC_SCORE_KEYS = Object.keys(REVIEW_VERDICT_JSON_SCHEMA.properties.rubric_scores.items.properties);
const SCOPE_DRIFT_KEYS = Object.keys(REVIEW_VERDICT_JSON_SCHEMA.properties.scope_drift.properties);
const SCOPE_CREEP_KEYS = Object.keys(
  REVIEW_VERDICT_JSON_SCHEMA.properties.scope_drift.properties.creep.items.properties
);
const SCOPE_MISSING_KEYS = Object.keys(
  REVIEW_VERDICT_JSON_SCHEMA.properties.scope_drift.properties.missing.items.properties
);

function validateNoUnexpectedKeys(value, location, allowedKeys) {
  const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`${location} has unexpected keys: ${unexpectedKeys.join(", ")}`);
  }
}

function parseReviewVerdict(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Review verdict must be valid JSON: ${error.message}`);
  }
  return validateReviewVerdict(parsed);
}

function validateIssue(issue, index) {
  const location = `issues[${index}]`;
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
    throw new Error(`${location} must be an object`);
  }
  validateNoUnexpectedKeys(issue, location, ISSUE_KEYS);
  for (const key of ["title", "body", "file", "category", "severity"]) {
    if (!String(issue[key] || "").trim()) {
      throw new Error(`${location}.${key} is required`);
    }
  }
  if (!Number.isInteger(issue.line) || issue.line <= 0) {
    throw new Error(`${location}.line must be a positive integer`);
  }
}

function validateRubricScore(score, index) {
  const location = `rubric_scores[${index}]`;
  if (!score || typeof score !== "object" || Array.isArray(score)) {
    throw new Error(`${location} must be an object`);
  }
  validateNoUnexpectedKeys(score, location, RUBRIC_SCORE_KEYS);
  for (const key of ["factor", "target", "observed", "notes"]) {
    if (!String(score[key] || "").trim()) {
      throw new Error(`${location}.${key} is required`);
    }
  }
  if (!String(score.tier || "").trim()) {
    throw new Error(`${location}.tier is required`);
  }
  if (!ALLOWED_STATUSES.has(score.status)) {
    throw new Error(`${location}.status must be one of: ${Array.from(ALLOWED_STATUSES).join(", ")}`);
  }
  if (!ALLOWED_SCORE_TIERS.has(score.tier)) {
    throw new Error(`${location}.tier must be one of: ${Array.from(ALLOWED_SCORE_TIERS).join(", ")}`);
  }
}

function validateScopeDrift(scopeDrift) {
  if (!scopeDrift || typeof scopeDrift !== "object" || Array.isArray(scopeDrift)) {
    throw new Error("scope_drift must be an object with creep and missing arrays");
  }
  validateNoUnexpectedKeys(scopeDrift, "scope_drift", SCOPE_DRIFT_KEYS);
  if (!Array.isArray(scopeDrift.creep)) {
    throw new Error("scope_drift.creep must be an array");
  }
  if (!Array.isArray(scopeDrift.missing)) {
    throw new Error("scope_drift.missing must be an array");
  }
  scopeDrift.creep.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`scope_drift.creep[${index}] must be an object`);
    }
    validateNoUnexpectedKeys(entry, `scope_drift.creep[${index}]`, SCOPE_CREEP_KEYS);
    if (!String(entry.file || "").trim()) throw new Error(`scope_drift.creep[${index}].file is required`);
    if (!String(entry.reason || "").trim()) throw new Error(`scope_drift.creep[${index}].reason is required`);
  });
  scopeDrift.missing.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`scope_drift.missing[${index}] must be an object`);
    }
    validateNoUnexpectedKeys(entry, `scope_drift.missing[${index}]`, SCOPE_MISSING_KEYS);
    if (!String(entry.criteria || "").trim()) throw new Error(`scope_drift.missing[${index}].criteria is required`);
    if (!ALLOWED_DRIFT_STATUSES.has(entry.status)) {
      throw new Error(`scope_drift.missing[${index}].status must be one of: ${Array.from(ALLOWED_DRIFT_STATUSES).join(", ")}`);
    }
  });
}

function validateReviewVerdict(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Review verdict must be a JSON object");
  }
  validateNoUnexpectedKeys(data, "Review verdict", REVIEW_VERDICT_KEYS);

  if (!ALLOWED_VERDICTS.has(data.verdict)) {
    throw new Error(`Invalid review verdict: ${data.verdict}`);
  }
  if (!String(data.summary || "").trim()) {
    throw new Error("Review verdict summary is required");
  }
  if (!ALLOWED_STATUSES.has(data.contract_status)) {
    throw new Error(`Invalid contract_status: ${data.contract_status}`);
  }
  if (!ALLOWED_STATUSES.has(data.quality_status)) {
    throw new Error(`Invalid quality_status: ${data.quality_status}`);
  }
  if (!ALLOWED_NEXT_ACTIONS.has(data.next_action)) {
    throw new Error(`Invalid next_action: ${data.next_action}`);
  }
  if (!Array.isArray(data.issues)) {
    throw new Error("Review verdict issues must be an array");
  }
  if (!Array.isArray(data.rubric_scores)) {
    throw new Error("Review verdict rubric_scores must be an array");
  }
  data.issues.forEach(validateIssue);
  data.rubric_scores.forEach(validateRubricScore);
  validateScopeDrift(data.scope_drift);

  if (data.verdict === "pass") {
    if (data.next_action !== "ready_to_merge") {
      throw new Error("PASS verdict must set next_action=ready_to_merge");
    }
    if (data.contract_status !== "pass" || data.quality_status !== "pass") {
      throw new Error("PASS verdict requires contract_status=pass and quality_status=pass");
    }
    if (data.issues.length !== 0) {
      throw new Error("PASS verdict must not include issues");
    }
    const blockingDrift = (data.scope_drift?.missing || []).filter(
      (entry) => entry.status === "not_done" || entry.status === "changed" || entry.status === "partial"
    );
    if (blockingDrift.length > 0) {
      throw new Error(
        `PASS verdict cannot have scope_drift.missing entries with status not_done, changed, or partial: ${blockingDrift.map((entry) => entry.criteria).join(", ")}`
      );
    }
  } else if (data.verdict === "changes_requested") {
    if (data.next_action !== "changes_requested") {
      throw new Error("changes_requested verdict must set next_action=changes_requested");
    }
    if (data.issues.length === 0) {
      throw new Error("changes_requested verdict must include at least one issue");
    }
  } else if (data.verdict === "escalated") {
    if (data.next_action !== "escalated") {
      throw new Error("escalated verdict must set next_action=escalated");
    }
    if (data.issues.length === 0) {
      throw new Error("escalated verdict must include at least one issue");
    }
  }

  return data;
}

module.exports = {
  ALLOWED_SCORE_TIERS,
  parseReviewVerdict,
  validateIssue,
  validateReviewVerdict,
  validateRubricScore,
  validateScopeDrift,
};
