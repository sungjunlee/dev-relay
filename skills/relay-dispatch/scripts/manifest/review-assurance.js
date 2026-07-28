const REVIEW_ASSURANCE = Object.freeze({
  COMPACT: "compact",
  STANDARD: "standard",
  HARDENED: "hardened",
});

const REVIEW_ASSURANCE_LEVELS = Object.freeze(Object.values(REVIEW_ASSURANCE));
const DEFAULT_REVIEW_ASSURANCE = REVIEW_ASSURANCE.STANDARD;
const REVIEW_ASSURANCE_SOURCES = Object.freeze(["rubric", "flag"]);

function normalizeReviewAssurance(value, { fallback = DEFAULT_REVIEW_ASSURANCE } = {}) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text) return fallback;
  if (REVIEW_ASSURANCE_LEVELS.includes(text)) return text;
  throw new Error(
    `invalid review assurance '${value}'; expected one of: ${REVIEW_ASSURANCE_LEVELS.join(", ")}`
  );
}

function normalizeReviewAssuranceSource(value, { fallback = "flag" } = {}) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text) return fallback;
  if (REVIEW_ASSURANCE_SOURCES.includes(text)) return text;
  throw new Error(
    `invalid review assurance source '${value}'; expected one of: ${REVIEW_ASSURANCE_SOURCES.join(", ")}`
  );
}

function stripYamlScalar(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/\s+#.*$/, "").trim();
  if (text.startsWith("\"") && text.endsWith("\"")) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function extractReviewAssuranceFromRubric(rubricText) {
  const lines = String(rubricText || "").replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const taskProfile = /^(\s*)task_profile:\s*(?:#.*)?$/.exec(lines[index]);
    if (!taskProfile) continue;

    const profileIndent = taskProfile[1].length;
    let childIndent = null;
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const line = lines[childIndex];
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      const indent = line.match(/^\s*/)[0].length;
      if (indent <= profileIndent) break;

      const keyValue = /^(\s*)([A-Za-z0-9_]+):(?:\s*(.*))?$/.exec(line);
      if (!keyValue) continue;
      if (childIndent === null) childIndent = keyValue[1].length;
      if (keyValue[1].length !== childIndent || keyValue[2] !== "review_assurance") continue;

      const value = stripYamlScalar(keyValue[3]);
      return value ? normalizeReviewAssurance(value) : null;
    }
  }
  return null;
}

function resolveReviewAssurance({
  rubricReviewAssurance = null,
  flagReviewAssurance = DEFAULT_REVIEW_ASSURANCE,
  flagWasExplicit = false,
} = {}) {
  const flag = normalizeReviewAssurance(flagReviewAssurance);
  if (!rubricReviewAssurance) {
    return {
      level: flag,
      source: "flag",
      overridden: null,
    };
  }

  const rubric = normalizeReviewAssurance(rubricReviewAssurance);
  return {
    level: rubric,
    source: "rubric",
    overridden: flagWasExplicit && flag !== rubric ? flag : null,
  };
}

function getReviewAssurance(data) {
  return normalizeReviewAssurance(data?.policy?.review_assurance);
}

function reviewAssuranceRank(value) {
  return REVIEW_ASSURANCE_LEVELS.indexOf(normalizeReviewAssurance(value));
}

function reviewRoundLimitForAssurance(value) {
  const assurance = normalizeReviewAssurance(value);
  if (assurance === REVIEW_ASSURANCE.COMPACT) return 1;
  if (assurance === REVIEW_ASSURANCE.HARDENED) return 3;
  return 2;
}

function isHardenedReviewAssurance(data) {
  return getReviewAssurance(data) === REVIEW_ASSURANCE.HARDENED;
}

module.exports = {
  DEFAULT_REVIEW_ASSURANCE,
  REVIEW_ASSURANCE,
  REVIEW_ASSURANCE_LEVELS,
  REVIEW_ASSURANCE_SOURCES,
  extractReviewAssuranceFromRubric,
  getReviewAssurance,
  isHardenedReviewAssurance,
  normalizeReviewAssurance,
  normalizeReviewAssuranceSource,
  resolveReviewAssurance,
  reviewAssuranceRank,
  reviewRoundLimitForAssurance,
};
