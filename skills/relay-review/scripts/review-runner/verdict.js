const { REVIEW_VERDICT_JSON_SCHEMA } = require("../review-schema");
const { parseJsonObject } = require("../../../relay-dispatch/scripts/agent-adapters/transport");
const {
  getRubricScoreNumber,
  getRubricTargetNumber,
  parseNumericScore,
  parseTargetScore,
} = require("./score-utils");

const ALLOWED_VERDICTS = new Set(["pass", "changes_requested", "escalated"]);
const ALLOWED_NEXT_ACTIONS = new Set(["publish_pending", "ready_to_merge", "changes_requested", "escalated"]);
const ALLOWED_REVIEW_STATUSES = new Set(["pass", "fail", "not_run"]);
const ALLOWED_EXECUTION_STATUSES = new Set(["pass", "fail", "not_run", "missing"]);
const ALLOWED_SCORE_TIERS = new Set(["contract", "quality"]);
const ALLOWED_LINEAGE_VALUES = new Set(["new", "deepening", "repeat", "stale", "newly_scoreable", "unknown"]);
const OPTIONAL_ISSUE_REJECTION_METADATA = ["factor", "attempted_approach", "fix_direction"];
const ALLOWED_DRIFT_STATUSES = new Set(
  REVIEW_VERDICT_JSON_SCHEMA.properties.scope_drift.properties.missing.items.properties.status.enum
);

function parseReviewVerdict(text, options = {}) {
  let parsed;
  if (options.adapter || options.phase) {
    parsed = parseJsonObject(text, {
      adapter: options.adapter,
      phase: options.phase,
      description: "review verdict",
    });
  } else {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Review verdict must be valid JSON: ${error.message}`);
    }
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
  for (const key of OPTIONAL_ISSUE_REJECTION_METADATA) {
    if (issue[key] !== undefined && issue[key] !== null && !String(issue[key] || "").trim()) {
      throw new Error(`${location}.${key} must be a non-empty string, null, or absent`);
    }
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
  for (const key of ["score", "target_score"]) {
    if (score[key] !== undefined && score[key] !== null && (typeof score[key] !== "number" || !Number.isFinite(score[key]))) {
      throw new Error(`${location}.${key} must be a finite number or null`);
    }
    if (typeof score[key] === "number" && (score[key] < 0 || score[key] > 10)) {
      throw new Error(`${location}.${key} must be between 0 and 10`);
    }
  }
  const numericScore = getRubricScoreNumber(score);
  const targetScore = getRubricTargetNumber(score);
  const parsedObserved = parseNumericScore(score.observed);
  const parsedTarget = parseTargetScore(score.target);
  if (
    score.tier === "quality"
    && (score.score === null || score.target_score === null)
    && parsedObserved !== null
    && parsedTarget !== null
  ) {
    throw new Error(`${location}.score and target_score are required for numeric quality factors`);
  }
  if (score.tier === "quality" && score.status === "pass" && numericScore !== null && targetScore !== null && numericScore < targetScore) {
    throw new Error(`${location}.status=pass conflicts with score ${numericScore} below target_score ${targetScore}`);
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
  const passNextActions = new Set(options.passNextActions || ["ready_to_merge"]);
  const disallowPassReason = typeof options.disallowPassReason === "string" && options.disallowPassReason.trim()
    ? options.disallowPassReason.trim()
    : null;
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
    if (disallowPassReason) {
      throw new Error(`PASS verdict is not allowed: ${disallowPassReason}`);
    }
    if (!passNextActions.has(data.next_action)) {
      throw new Error(`PASS verdict must set next_action=${Array.from(passNextActions).join(" or ")}`);
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
