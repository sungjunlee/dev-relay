const { extractAllFactors } = require("./tdd-flavor");

const SUBSTANTIVE_TIERS = new Set(["contract", "quality"]);
// Ready-light factors should prove the narrow task contract; broad repo hygiene belongs in prerequisites.
const PACKAGE_HYGIENE_COMMAND = /^\s*(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|lint|typecheck|check)(?:\s+-{1,2}\S+)*\s*$/i;
const SIMPLE_HYGIENE_COMMAND = /^\s*(?:tsc\s+--noEmit|eslint|prettier)\s*$/i;
// Only warn on explicitly unsupported extra structure, not ordinary mentions of helpers/config.
const OVER_ENGINEERING_TEXT = /\bunsupported\s+(?:helper|dependency|config|configuration|abstraction)\b/i;

function commandTokens(command) {
  return String(command || "").trim().split(/\s+/).filter(Boolean);
}

function isRepoWideTarget(token) {
  const normalized = String(token || "").replace(/\/+$/, "");
  return normalized === "tests" || normalized.includes("*");
}

function isRepoWideNodeTest(command) {
  const tokens = commandTokens(command);
  const testIndex = tokens.findIndex((token, index) => token === "--test" && index > 0 && tokens[index - 1] === "node");
  if (testIndex === -1) return false;
  const targets = tokens.slice(testIndex + 1).filter((token) => !token.startsWith("-"));
  return targets.length === 0 || targets.some(isRepoWideTarget);
}

function isRepoWidePytest(command) {
  const tokens = commandTokens(command);
  const pytestIndex = tokens[0] === "pytest"
    ? 0
    : (tokens[0] === "python" && tokens[1] === "-m" && tokens[2] === "pytest" ? 2 : -1);
  if (pytestIndex === -1) return false;
  const targets = tokens.slice(pytestIndex + 1).filter((token) => !token.startsWith("-"));
  return targets.length === 0 || targets.some(isRepoWideTarget);
}

function isRepoWideGoTest(command) {
  const tokens = commandTokens(command);
  return tokens[0] === "go" && tokens[1] === "test" && tokens[2] === "./...";
}

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
  const command = String(factor.command || "");
  return PACKAGE_HYGIENE_COMMAND.test(command)
    || SIMPLE_HYGIENE_COMMAND.test(command)
    || isRepoWideNodeTest(command)
    || isRepoWidePytest(command)
    || isRepoWideGoTest(command);
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

  // A compact ready-light rubric needs at least one reviewable contract and should stay at two by default.
  if (substantiveFactors.length < 1 || substantiveFactors.length > 2) {
    const countIssue = issue(
      "ready_light_factor_count",
      "Ready-light S rubrics require 1-2 substantive factors by default; more requires explicit risk or design-bearing rationale."
    );
    if (substantiveFactors.length > 2 && hasExplicitRiskOrDesignRationale(taskProfile)) {
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
