const REVIEW_ASSURANCE = Object.freeze({
  STANDARD: "standard",
  HARDENED: "hardened",
});

const REVIEW_ASSURANCE_LEVELS = Object.freeze(Object.values(REVIEW_ASSURANCE));
const DEFAULT_REVIEW_ASSURANCE = REVIEW_ASSURANCE.STANDARD;

function normalizeReviewAssurance(value, { fallback = DEFAULT_REVIEW_ASSURANCE } = {}) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text) return fallback;
  if (REVIEW_ASSURANCE_LEVELS.includes(text)) return text;
  throw new Error(
    `invalid review assurance '${value}'; expected one of: ${REVIEW_ASSURANCE_LEVELS.join(", ")}`
  );
}

function getReviewAssurance(data) {
  return normalizeReviewAssurance(data?.policy?.review_assurance);
}

function isHardenedReviewAssurance(data) {
  return getReviewAssurance(data) === REVIEW_ASSURANCE.HARDENED;
}

module.exports = {
  DEFAULT_REVIEW_ASSURANCE,
  REVIEW_ASSURANCE,
  REVIEW_ASSURANCE_LEVELS,
  getReviewAssurance,
  isHardenedReviewAssurance,
  normalizeReviewAssurance,
};
