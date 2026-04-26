const { REVIEW_VERDICT_JSON_SCHEMA } = require("../review-schema");

const ALLOWED_VERDICTS = new Set(["pass", "changes_requested", "escalated"]);
const ALLOWED_NEXT_ACTIONS = new Set(["ready_to_merge", "changes_requested", "escalated"]);
const ALLOWED_REVIEW_STATUSES = new Set(["pass", "fail", "not_run"]);
const ALLOWED_EXECUTION_STATUSES = new Set(["pass", "fail", "not_run", "missing"]);
const ALLOWED_SCORE_TIERS = new Set(["contract", "quality"]);
const ALLOWED_LINEAGE_VALUES = new Set(["new", "deepening", "repeat", "newly_scoreable", "unknown"]);
const ALLOWED_DRIFT_STATUSES = new Set(
  REVIEW_VERDICT_JSON_SCHEMA.properties.scope_drift.properties.missing.items.properties.status.enum
);

function parseReviewVerdict(text, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Review verdict must be valid JSON: ${error.message}`);
  }
  return validateReviewVerdict(parsed, options);
}

function validateIssue(issue, index) {
  const location = `issues[${index}]`;
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
    throw new Error(`${location} must be an object`);
  }
  for (const key of ["title", "body", "file", "category", "severity"]) {
    if (!String(issue[key] || "").trim()) {
      throw new Error(`${location}.${key} is required`);
    }
  }
  if (!Number.isInteger(issue.line) || issue.line <= 0) {
    throw new Error(`${location}.line must be a positive integer`);
  }
  if (issue.lineage !== undefined && !ALLOWED_LINEAGE_VALUES.has(issue.lineage)) {
    throw new Error(`${location}.lineage must be one of: ${Array.from(ALLOWED_LINEAGE_VALUES).join(", ")}`);
  }
  if (issue.relates_to !== undefined && issue.relates_to !== null && (typeof issue.relates_to !== "string" || !issue.relates_to.trim())) {
    throw new Error(`${location}.relates_to must be a non-empty string or null when present`);
  }
}

function validateRubricScore(score, index) {
  const location = `rubric_scores[${index}]`;
  if (!score || typeof score !== "object" || Array.isArray(score)) {
    throw new Error(`${location} must be an object`);
  }
  for (const key of ["factor", "target", "observed", "notes"]) {
    if (!String(score[key] || "").trim()) {
      throw new Error(`${location}.${key} is required`);
    }
  }
  if (!String(score.tier || "").trim()) {
    throw new Error(`${location}.tier is required`);
  }
  if (!ALLOWED_REVIEW_STATUSES.has(score.status)) {
    throw new Error(`${location}.status must be one of: ${Array.from(ALLOWED_REVIEW_STATUSES).join(", ")}`);
  }
  if (!ALLOWED_SCORE_TIERS.has(score.tier)) {
    throw new Error(`${location}.tier must be one of: ${Array.from(ALLOWED_SCORE_TIERS).join(", ")}`);
  }
}

function validateScopeDrift(scopeDrift) {
  if (!scopeDrift || typeof scopeDrift !== "object" || Array.isArray(scopeDrift)) {
    throw new Error("scope_drift must be an object with creep and missing arrays");
  }
  if (!Array.isArray(scopeDrift.creep)) {
    throw new Error("scope_drift.creep must be an array");
  }
  if (!Array.isArray(scopeDrift.missing)) {
    throw new Error("scope_drift.missing must be an array");
  }
  scopeDrift.creep.forEach((entry, index) => {
    if (!String(entry.file || "").trim()) throw new Error(`scope_drift.creep[${index}].file is required`);
    if (!String(entry.reason || "").trim()) throw new Error(`scope_drift.creep[${index}].reason is required`);
  });
  scopeDrift.missing.forEach((entry, index) => {
    if (!String(entry.criteria || "").trim()) throw new Error(`scope_drift.missing[${index}].criteria is required`);
    if (!ALLOWED_DRIFT_STATUSES.has(entry.status)) {
      throw new Error(`scope_drift.missing[${index}].status must be one of: ${Array.from(ALLOWED_DRIFT_STATUSES).join(", ")}`);
    }
  });
}

function formatPassRequirementFailures(data) {
  const failures = [];
  if (data.contract_status !== "pass") {
    failures.push(`contract_status=${data.contract_status}`);
  }
  if (data.quality_review_status !== "pass") {
    failures.push(`quality_review_status=${data.quality_review_status}`);
  }
  if (data.quality_execution_status !== "pass") {
    const reason = String(data.quality_execution_reason || "").trim();
    failures.push(reason
      ? `quality_execution_status=${data.quality_execution_status} (${reason})`
      : `quality_execution_status=${data.quality_execution_status}`);
  }
  return failures;
}

function validateReviewVerdict(data, options = {}) {
  const requireExecutionStatus = options.requireExecutionStatus !== false;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Review verdict must be a JSON object");
  }

  if (!ALLOWED_VERDICTS.has(data.verdict)) {
    throw new Error(`Invalid review verdict: ${data.verdict}`);
  }
  if (!String(data.summary || "").trim()) {
    throw new Error("Review verdict summary is required");
  }
  if (!ALLOWED_REVIEW_STATUSES.has(data.contract_status)) {
    throw new Error(`Invalid contract_status: ${data.contract_status}`);
  }
  if (!ALLOWED_REVIEW_STATUSES.has(data.quality_review_status)) {
    throw new Error(`Invalid quality_review_status: ${data.quality_review_status}`);
  }
  if (requireExecutionStatus) {
    if (!ALLOWED_EXECUTION_STATUSES.has(data.quality_execution_status)) {
      throw new Error(`Invalid quality_execution_status: ${data.quality_execution_status}`);
    }
  } else if (data.quality_execution_status !== undefined && !ALLOWED_EXECUTION_STATUSES.has(data.quality_execution_status)) {
    throw new Error(`Invalid quality_execution_status: ${data.quality_execution_status}`);
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
    const failures = requireExecutionStatus
      ? formatPassRequirementFailures(data)
      : formatPassRequirementFailures({ ...data, quality_execution_status: "pass" });
    if (failures.length > 0) {
      throw new Error(`PASS verdict failed: ${failures.join(", ")}`);
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
  ALLOWED_EXECUTION_STATUSES,
  ALLOWED_LINEAGE_VALUES,
  ALLOWED_SCORE_TIERS,
  ALLOWED_REVIEW_STATUSES,
  parseReviewVerdict,
  validateIssue,
  validateReviewVerdict,
  validateRubricScore,
  validateScopeDrift,
};
