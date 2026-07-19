const {
  REVIEW_ASSURANCE,
  normalizeReviewAssurance,
  reviewAssuranceRank,
  reviewRoundLimitForAssurance,
} = require("./review-assurance");

const REQUIRED_PROPERTIES = Object.freeze([
  "authority",
  "reversibility",
  "blast_radius",
  "trust_boundaries",
]);
const AUTHORITY = new Set([
  "read-only",
  "workspace",
  "external-write",
  "privileged",
]);
const REVERSIBILITY = new Set([
  "easy",
  "bounded",
  "difficult",
  "irreversible",
]);
const BLAST_RADIUS = new Set([
  "isolated",
  "repository",
  "multi-system",
  "broad",
]);
const ASSURANCE_FLOOR = Object.freeze({
  low: REVIEW_ASSURANCE.COMPACT,
  medium: REVIEW_ASSURANCE.STANDARD,
  high: REVIEW_ASSURANCE.HARDENED,
});

function normalizedProperty(profile, field, allowed) {
  const value = String(profile[field] || "").trim().toLowerCase();
  if (!allowed.has(value)) {
    throw new Error(
      `invalid ${field} '${profile[field]}'; expected one of: ${[...allowed].join(", ")}`
    );
  }
  return value;
}

function normalizeTrustBoundaries(value) {
  if (!Array.isArray(value)) {
    throw new Error("trust_boundaries must be an array");
  }
  return [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function assurancePlan(reviewAssurance) {
  const assurance = normalizeReviewAssurance(reviewAssurance);
  return {
    max_review_rounds: reviewRoundLimitForAssurance(assurance),
    publish_policy: assurance === REVIEW_ASSURANCE.HARDENED
      ? "after-internal-review"
      : "immediate",
    review_timing: assurance === REVIEW_ASSURANCE.HARDENED
      ? "pre-and-post-publication"
      : "post-publication",
    adversarial_review: assurance === REVIEW_ASSURANCE.HARDENED
      ? "required"
      : "optional",
  };
}

function deriveRiskAssurance(profile = {}) {
  const present = REQUIRED_PROPERTIES.filter((field) => (
    Object.prototype.hasOwnProperty.call(profile, field)
  ));
  if (present.length === 0) return null;
  const missing = REQUIRED_PROPERTIES.filter((field) => !present.includes(field));
  if (missing.length > 0) {
    throw new Error(
      "risk-aware task_profile requires authority, reversibility, blast_radius, "
      + `and trust_boundaries; missing: ${missing.join(", ")}`
    );
  }

  const authority = normalizedProperty(profile, "authority", AUTHORITY);
  const reversibility = normalizedProperty(profile, "reversibility", REVERSIBILITY);
  const blastRadius = normalizedProperty(profile, "blast_radius", BLAST_RADIUS);
  const trustBoundaries = normalizeTrustBoundaries(profile.trust_boundaries);
  const highReasons = [];
  const mediumReasons = [];

  if (["external-write", "privileged"].includes(authority)) {
    highReasons.push(`authority=${authority}`);
  }
  if (["difficult", "irreversible"].includes(reversibility)) {
    highReasons.push(`reversibility=${reversibility}`);
  } else if (reversibility === "bounded") {
    mediumReasons.push("reversibility=bounded");
  }
  if (["multi-system", "broad"].includes(blastRadius)) {
    highReasons.push(`blast_radius=${blastRadius}`);
  } else if (blastRadius === "repository") {
    mediumReasons.push("blast_radius=repository");
  }
  for (const boundary of trustBoundaries) {
    highReasons.push(`trust_boundary=${boundary}`);
  }

  const riskLevel = highReasons.length > 0
    ? "high"
    : mediumReasons.length > 0
      ? "medium"
      : "low";
  const minimumReviewAssurance = ASSURANCE_FLOOR[riskLevel];
  const selectedReviewAssurance = profile.review_assurance
    ? normalizeReviewAssurance(profile.review_assurance)
    : minimumReviewAssurance;
  if (
    reviewAssuranceRank(selectedReviewAssurance)
    < reviewAssuranceRank(minimumReviewAssurance)
  ) {
    throw new Error(
      `review_assurance=${selectedReviewAssurance} is below the `
      + `${minimumReviewAssurance} risk floor for risk_level=${riskLevel}`
    );
  }

  return {
    authority,
    reversibility,
    blast_radius: blastRadius,
    trust_boundaries: trustBoundaries,
    risk_level: riskLevel,
    minimum_review_assurance: minimumReviewAssurance,
    review_assurance: selectedReviewAssurance,
    reasons: highReasons.length > 0
      ? highReasons
      : mediumReasons.length > 0
        ? mediumReasons
        : ["authority and impact remain isolated and reversible"],
    ...assurancePlan(selectedReviewAssurance),
  };
}

module.exports = {
  ASSURANCE_FLOOR,
  assurancePlan,
  deriveRiskAssurance,
  REQUIRED_PROPERTIES,
};
