const ALLOWED_SCORE_TIERS = new Set(["contract", "quality"]);

function isMissingScoreCell(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "—" || normalized === "–" || normalized === "-" || normalized === "n/a" || normalized === "na";
}

function normalizeFactorKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseNumericScore(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  if (isMissingScoreCell(text)) return null;
  const match = text.match(/^(-?\d+(?:\.\d+)?)(?:\s*\/\s*10(?:\.0+)?)?$/);
  if (!match) return null;
  return Number(match[1]);
}

function parseTargetScore(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  if (isMissingScoreCell(text)) return null;
  const match = text.match(/^(?:>=|=>|>|=)?\s*(-?\d+(?:\.\d+)?)(?:\s*\/\s*10(?:\.0+)?)?$/);
  if (!match) return null;
  return Number(match[1]);
}

function getRubricScoreNumber(score) {
  if (typeof score?.score === "number" && Number.isFinite(score.score)) return score.score;
  return parseNumericScore(score?.observed);
}

function getRubricTargetNumber(score) {
  if (typeof score?.target_score === "number" && Number.isFinite(score.target_score)) return score.target_score;
  return parseTargetScore(score?.target);
}

function toIterationScoreEventEntry(score) {
  const numericScore = getRubricScoreNumber(score);
  const targetScore = getRubricTargetNumber(score);
  return {
    factor: score.factor,
    target: score.target,
    observed: score.observed,
    ...(numericScore !== null ? { score: numericScore } : {}),
    ...(targetScore !== null ? { target_score: targetScore } : {}),
    met: score.status === "pass",
    status: score.status,
    ...(ALLOWED_SCORE_TIERS.has(score.tier) ? { tier: score.tier } : {}),
  };
}

module.exports = {
  ALLOWED_SCORE_TIERS,
  getRubricScoreNumber,
  getRubricTargetNumber,
  isMissingScoreCell,
  normalizeFactorKey,
  parseNumericScore,
  parseTargetScore,
  toIterationScoreEventEntry,
};
