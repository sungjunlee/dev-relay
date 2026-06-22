const { extractAllFactors } = require("./tdd-flavor");

const SUBSTANTIVE_TIERS = new Set(["contract", "quality"]);
const REPO_HYGIENE_COMMAND = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|lint|typecheck|check)\b|\btsc\s+--noEmit\b|\beslint\b|\bprettier\b|\bnode\s+--test\s+(?:tests(?:\s|$)|tests\/\S*\*)/i;
const OVER_ENGINEERING_TEXT = /\b(?:unsupported\s+)?(?:helper|dependency|config|configuration|abstraction)\b/i;

function normalizeTaskProfile(taskProfile = {}) {
  return {
    planning_profile: taskProfile.planning_profile || taskProfile.route_decision || taskProfile.routeDecision || "standard",
    size: String(taskProfile.size || "M").toUpperCase(),
    risk_rationale: String(taskProfile.risk_rationale || taskProfile.riskRationale || ""),
    design_rationale: String(taskProfile.design_rationale || taskProfile.designRationale || ""),
    risk_tags: Array.isArray(taskProfile.risk_tags) ? taskProfile.risk_tags.map(String) : [],
  };
}

function isReadyLightProfile(taskProfile) {
  const profile = normalizeTaskProfile(taskProfile);
  return profile.planning_profile === "ready_light";
}

function hasExplicitRiskOrDesignRationale(taskProfile) {
  const profile = normalizeTaskProfile(taskProfile);
  return Boolean(
    profile.risk_rationale.trim() ||
    profile.design_rationale.trim() ||
    profile.risk_tags.includes("design-bearing") ||
    profile.risk_tags.includes("risk-bearing")
  );
}

function isSubstantiveFactor(factor) {
  return SUBSTANTIVE_TIERS.has(String(factor.tier || "").toLowerCase());
}

function factorText(factor) {
  return [factor.name, factor.command, factor.criteria, factor.target].filter(Boolean).join("\n");
}

function isRepoHygieneFactor(factor) {
  return REPO_HYGIENE_COMMAND.test(String(factor.command || ""));
}

function isOverEngineeringRisk(factor) {
  return OVER_ENGINEERING_TEXT.test(factorText(factor));
}

function issue(code, message) {
  return { code, message };
}

function validateReadyLightRubric({ rubricYaml, taskProfile = {} } = {}) {
  const factors = extractAllFactors(rubricYaml);
  const substantiveFactors = factors.filter(isSubstantiveFactor);
  const errors = [];
  const warnings = [];

  if (!isReadyLightProfile(taskProfile)) {
    return {
      action: "allow",
      substantive_total: substantiveFactors.length,
      errors,
      warnings,
    };
  }

  const hygieneFactors = substantiveFactors.filter(isRepoHygieneFactor);
  if (hygieneFactors.length > 0) {
    errors.push(issue(
      "repo_hygiene_in_factor",
      "Repo-wide lint, typecheck, or test commands belong in prerequisites, not ready-light factors."
    ));
  }

  if (substantiveFactors.some(isOverEngineeringRisk)) {
    warnings.push(issue(
      "over_engineering_risk",
      "Unsupported helper, dependency, config, or abstraction requirements are over-engineering risk for ready-light rubrics."
    ));
  }

  if (substantiveFactors.length > 2) {
    const countIssue = issue(
      "ready_light_factor_count",
      "Ready-light S rubrics default to 1-2 substantive factors; more requires explicit risk or design-bearing rationale."
    );
    if (hasExplicitRiskOrDesignRationale(taskProfile)) {
      warnings.push(countIssue);
    } else {
      errors.push(countIssue);
    }
  }

  return {
    action: errors.length > 0 ? "block" : "allow",
    substantive_total: substantiveFactors.length,
    errors,
    warnings,
  };
}

module.exports = {
  validateReadyLightRubric,
};
