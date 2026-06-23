const { extractAllFactors } = require("./tdd-flavor");

const SUBSTANTIVE_TIERS = new Set(["contract", "quality"]);
// Ready-light factors should prove the narrow task contract; broad repo hygiene belongs in prerequisites.
const PACKAGE_HYGIENE_COMMAND = /^\s*(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|lint|typecheck|check)(?:\s+-{1,2}\S+)*\s*$/i;
const SIMPLE_HYGIENE_COMMAND = /^\s*(?:tsc\s+--noEmit|eslint|prettier)\s*$/i;
// Only warn on explicitly unsupported extra structure, not ordinary mentions of helpers/config.
const OVER_ENGINEERING_TEXT = /\bunsupported\s+(?:helper|dependency|config|configuration|abstraction)\b/i;
const NODE_TEST_OPTIONS_WITH_VALUE = new Set([
  "--test-concurrency",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-timeout",
]);
const PYTEST_OPTIONS_WITH_VALUE = new Set([
  "--capture",
  "--confcutdir",
  "--cov",
  "--cov-report",
  "--import-mode",
  "--junit-xml",
  "--junitxml",
  "--maxfail",
  "--rootdir",
  "--tb",
]);
const PYTEST_SHORT_OPTIONS_WITH_VALUE = new Set(["-c", "-k", "-m", "-o", "-p", "-W"]);
const TSC_OPTIONS_WITH_VALUE = new Set(["--build", "--module", "--outDir", "--pretty", "--project", "--target"]);
const TSC_SHORT_OPTIONS_WITH_VALUE = new Set(["-b", "-m", "-p", "-t"]);
const ESLINT_OPTIONS_WITH_VALUE = new Set([
  "--config",
  "--ext",
  "--format",
  "--ignore-pattern",
  "--max-warnings",
  "--parser",
  "--parser-options",
]);
const ESLINT_SHORT_OPTIONS_WITH_VALUE = new Set(["-c", "-f"]);
const PRETTIER_OPTIONS_WITH_VALUE = new Set([
  "--config",
  "--ignore-path",
  "--parser",
  "--plugin",
]);

function commandTokens(command) {
  return String(command || "").trim().split(/\s+/).filter(Boolean);
}

function isRepoWideTarget(token) {
  const normalized = String(token || "").replace(/\/+$/, "");
  return normalized === "." || normalized === "tests" || normalized.includes("*");
}

function positionalTargets(tokens, {
  longOptionsWithValue = new Set(),
  shortOptionsWithValue = new Set(),
} = {}) {
  const targets = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      const [optionName] = token.split("=", 1);
      if (!token.includes("=") && longOptionsWithValue.has(optionName)) {
        index += 1;
      }
      continue;
    }
    if (/^-[A-Za-z]+$/.test(token)) {
      if (shortOptionsWithValue.has(token)) {
        index += 1;
      }
      continue;
    }
    targets.push(token);
  }
  return targets;
}

function isRepoWideNodeTest(command) {
  const tokens = commandTokens(command);
  const testIndex = tokens.findIndex((token, index) => token === "--test" && index > 0 && tokens[index - 1] === "node");
  if (testIndex === -1) return false;
  const targets = positionalTargets(tokens.slice(testIndex + 1), {
    longOptionsWithValue: NODE_TEST_OPTIONS_WITH_VALUE,
  });
  return targets.length === 0 || targets.some(isRepoWideTarget);
}

function isRepoWidePytest(command) {
  const tokens = commandTokens(command);
  const pytestIndex = tokens[0] === "pytest"
    ? 0
    : (tokens[0] === "python" && tokens[1] === "-m" && tokens[2] === "pytest" ? 2 : -1);
  if (pytestIndex === -1) return false;
  const targets = positionalTargets(tokens.slice(pytestIndex + 1), {
    longOptionsWithValue: PYTEST_OPTIONS_WITH_VALUE,
    shortOptionsWithValue: PYTEST_SHORT_OPTIONS_WITH_VALUE,
  });
  return targets.length === 0 || targets.some(isRepoWideTarget);
}

function isRepoWideGoTest(command) {
  const tokens = commandTokens(command);
  if (tokens[0] !== "go" || tokens[1] !== "test") return false;
  const targets = positionalTargets(tokens.slice(2));
  return targets.length === 0 || targets.some((target) => target === "./..." || isRepoWideTarget(target));
}

function isRepoWideTypecheck(command) {
  const tokens = commandTokens(command);
  if (tokens[0] !== "tsc" || !tokens.some((token) => token === "--noEmit" || token.startsWith("--noEmit="))) return false;
  const targets = positionalTargets(tokens.slice(1), {
    longOptionsWithValue: TSC_OPTIONS_WITH_VALUE,
    shortOptionsWithValue: TSC_SHORT_OPTIONS_WITH_VALUE,
  });
  return targets.length === 0 || targets.some(isRepoWideTarget);
}

function isRepoWideEslint(command) {
  const tokens = commandTokens(command);
  if (tokens[0] !== "eslint") return false;
  const targets = positionalTargets(tokens.slice(1), {
    longOptionsWithValue: ESLINT_OPTIONS_WITH_VALUE,
    shortOptionsWithValue: ESLINT_SHORT_OPTIONS_WITH_VALUE,
  });
  return targets.length === 0 || targets.some(isRepoWideTarget);
}

function isRepoWidePrettier(command) {
  const tokens = commandTokens(command);
  if (tokens[0] !== "prettier") return false;
  const targets = positionalTargets(tokens.slice(1), {
    longOptionsWithValue: PRETTIER_OPTIONS_WITH_VALUE,
  });
  return targets.length === 0 || targets.some(isRepoWideTarget);
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
    || isRepoWideTypecheck(command)
    || isRepoWideEslint(command)
    || isRepoWidePrettier(command)
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
