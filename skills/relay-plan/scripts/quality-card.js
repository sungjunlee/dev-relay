const { extractAllFactors, firstProbeTestInfra } = require("./tdd-flavor");
const { isRepoHygieneFactor } = require("./rubric-validation");

const SUBSTANTIVE_TIERS = new Set(["contract", "quality"]);
const TDD_SKIP_REASONS = new Set([
  "no_runner",
  "docs_only",
  "broad_ui_judgment",
  "exploratory_task",
  "non_crisp_behavior",
]);

// Mirrors extractAllFactors's section-detection line-scan (tdd-flavor.js), but
// counts list entries under `rubric.prerequisites` instead of parsing `factors`
// into structured objects. There is no YAML library in this repo by design.
function countPrerequisites(rubricYaml) {
  let inSection = false;
  let sectionIndent = null;
  let count = 0;

  for (const line of String(rubricYaml || "").split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;

    const section = line.match(/^(\s*)([A-Za-z_][\w.-]*):\s*(.*?)\s*$/);
    if (section && section[2] === "prerequisites") {
      inSection = !section[3];
      sectionIndent = inSection ? section[1].length : null;
      continue;
    }

    if (!inSection) continue;

    const indent = line.match(/^\s*/)[0].length;
    if (section && indent <= sectionIndent) {
      inSection = false;
      continue;
    }

    const listItemStart = line.match(/^(\s*)-\s*/);
    if (listItemStart && listItemStart[1].length === sectionIndent + 2) {
      count += 1;
    }
  }

  return count;
}

// Reuses the existing design-bearing signal vocabulary (rubric-validation.md §
// Risk signals: `all_contract`): risk_tags containing "design-bearing", or a
// non-empty design_rationale. Intentionally narrower than
// hasExplicitRiskOrDesignRationale in rubric-validation.js, which also folds
// in risk_rationale and the "risk-bearing" tag for a different purpose
// (ready-light factor-count leniency).
function isDesignBearing(taskProfile) {
  const riskTags = Array.isArray(taskProfile.risk_tags) ? taskProfile.risk_tags : [];
  const designRationale = String(taskProfile.design_rationale || "").trim();
  return riskTags.includes("design-bearing") || designRationale !== "";
}

function tierOf(factor) {
  return String(factor.tier || "").toLowerCase();
}

function isSubstantiveFactor(factor) {
  return SUBSTANTIVE_TIERS.has(tierOf(factor));
}

function isContractFactor(factor) {
  return tierOf(factor) === "contract";
}

function isQualityFactor(factor) {
  return tierOf(factor) === "quality";
}

function isAutomatedContractFactor(factor) {
  return isContractFactor(factor) && String(factor.type || "").toLowerCase() === "automated";
}

function hasNonEmptyTddAnchor(factor) {
  return Boolean(factor.tdd_anchor && String(factor.tdd_anchor).trim() !== "");
}

// TDD accountability is opt-in (see issue #730 non-goals: no mandatory TDD,
// no top-level tdd_mode). skip_reason only records *why* nothing was applied;
// it never blocks dispatch on its own.
function resolveTddSkipReason({ appliedCount, tddSkipReason, probeSignal }) {
  if (appliedCount > 0) return null;

  const explicitReason = tddSkipReason == null ? "" : String(tddSkipReason).trim();
  if (explicitReason !== "") {
    if (!TDD_SKIP_REASONS.has(explicitReason)) {
      throw new Error(
        `Invalid tddSkipReason "${explicitReason}"; must be one of: ${[...TDD_SKIP_REASONS].join(", ")}`
      );
    }
    return explicitReason;
  }

  if (!firstProbeTestInfra(probeSignal)) {
    return "no_runner";
  }

  return null;
}

function buildQualityCardSummary({
  rubricYaml,
  taskProfile = {},
  probeSignal = null,
  tddSkipReason = null,
  qualityWaiver = "",
} = {}) {
  const factors = extractAllFactors(rubricYaml);
  const substantiveFactors = factors.filter(isSubstantiveFactor);
  const contractFactors = factors.filter(isContractFactor);
  const qualityFactors = factors.filter(isQualityFactor);

  const hygieneViolations = substantiveFactors
    .filter(isRepoHygieneFactor)
    .map((factor) => factor.name);

  const waiver = String(qualityWaiver || "").trim();
  const warnings = [];

  if (isDesignBearing(taskProfile) && qualityFactors.length === 0 && !waiver) {
    warnings.push({
      code: "all_contract",
      message: "Design-bearing task has zero quality-tier factors and no quality waiver.",
    });
  }

  if (hygieneViolations.length > 0) {
    warnings.push({
      code: "repo_hygiene_in_factor",
      message: "Repo-wide lint, typecheck, or test commands are placed in factors instead of prerequisites.",
    });
  }

  const eligibleFactors = factors.filter(isAutomatedContractFactor);
  const appliedFactors = factors.filter(hasNonEmptyTddAnchor);
  const anchors = appliedFactors.map((factor) => ({
    factor: factor.name,
    tdd_anchor: factor.tdd_anchor,
    tdd_runner: factor.tdd_runner || null,
  }));

  const skipReason = resolveTddSkipReason({
    appliedCount: appliedFactors.length,
    tddSkipReason,
    probeSignal,
  });

  return {
    prerequisites_count: countPrerequisites(rubricYaml),
    contract_factors: contractFactors.length,
    quality_factors: qualityFactors.length,
    hygiene_in_factor_violations: hygieneViolations,
    quality_waiver: waiver,
    warnings,
    tdd: {
      eligible_count: eligibleFactors.length,
      applied_count: appliedFactors.length,
      anchors,
      skip_reason: skipReason,
    },
  };
}

module.exports = {
  buildQualityCardSummary,
};
