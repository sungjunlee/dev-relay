const {
  classifyEvaluationArtifact,
} = require("../../../relay-dispatch/scripts/evaluation-contract");

function evaluationArtifactMeta(rubricLoad = {}) {
  if (!rubricLoad.content) {
    return { ...classifyEvaluationArtifact(""), has_scored_factors: false };
  }
  const classification = classifyEvaluationArtifact(rubricLoad.content);
  return {
    ...classification,
    has_scored_factors: classification.kind === "legacy"
      || classification.earned_factor_count > 0,
  };
}

function blockEnd(lines, start, indent, limit = lines.length) {
  for (let index = start + 1; index < limit; index += 1) {
    if (/^\s*(?:#.*)?$/.test(lines[index])) continue;
    if (lines[index].match(/^\s*/)[0].length <= indent) return index;
  }
  return limit;
}

function structuredEarnedFactorNames(content) {
  const lines = String(content || "").split(/\r?\n/);
  const earnedIndex = lines.findIndex((line) => /^\s*earned_rubric:\s*$/.test(line));
  if (earnedIndex < 0) return [];
  const earnedIndent = lines[earnedIndex].match(/^\s*/)[0].length;
  const earnedEnd = blockEnd(lines, earnedIndex, earnedIndent);
  const factorsIndex = lines.findIndex((line, index) => (
    index > earnedIndex
    && index < earnedEnd
    && /^\s*factors:\s*(?:\[\s*\])?\s*$/.test(line)
  ));
  if (factorsIndex < 0 || /\[\s*\]/.test(lines[factorsIndex])) return [];
  const factorsIndent = lines[factorsIndex].match(/^\s*/)[0].length;
  const factorsEnd = blockEnd(lines, factorsIndex, factorsIndent, earnedEnd);
  const starts = [];
  let itemIndent = null;
  for (let index = factorsIndex + 1; index < factorsEnd; index += 1) {
    const item = lines[index].match(/^(\s*)-\s+/);
    if (!item) continue;
    const indent = item[1].length;
    if (itemIndent === null) itemIndent = indent;
    if (indent === itemIndent) starts.push(index);
  }
  return starts.map((start, position) => {
    const end = starts[position + 1] || factorsEnd;
    for (let index = start; index < end; index += 1) {
      const name = lines[index].match(/^\s*(?:-\s*)?name:\s*(.*?)\s*$/);
      if (name) return name[1].replace(/^["']|["']$/g, "").trim();
    }
    return "";
  }).filter(Boolean);
}

function normalizeFactorName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function validateReviewerScoresForArtifact(rubricLoad = {}, rubricScores = []) {
  const scores = Array.isArray(rubricScores) ? rubricScores : [];
  const meta = evaluationArtifactMeta(rubricLoad);
  if (meta.kind === "legacy") {
    if (scores.length === 0) {
      throw new Error("A legacy rubric was provided; the reviewer must score every factor.");
    }
    return;
  }
  if (meta.kind !== "structured") return;

  const expected = structuredEarnedFactorNames(rubricLoad.content);
  if (expected.length === 0) {
    if (scores.length > 0) {
      throw new Error("No Earned Rubric factors were persisted; the reviewer must not invent scores.");
    }
    return;
  }

  const expectedKeys = new Set(expected.map(normalizeFactorName));
  const actualNames = scores.map((score) => String(score?.factor || "").trim()).filter(Boolean);
  const actualKeys = new Set(actualNames.map(normalizeFactorName));
  const missing = expected.filter((name) => !actualKeys.has(normalizeFactorName(name)));
  const unexpected = actualNames.filter((name) => !expectedKeys.has(normalizeFactorName(name)));
  if (missing.length || unexpected.length || actualNames.length !== expected.length) {
    throw new Error(
      `Reviewer scores must exactly match persisted Earned Rubric factors; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}.`
    );
  }
  if (scores.some((score) => score?.tier !== "quality")) {
    throw new Error("Structured Earned Rubric reviewer scores must use tier=quality.");
  }
}

function buildEvaluationSections(rubricLoad = {}) {
  if (rubricLoad.warning) {
    return ["", "## Scoring Rubric", rubricLoad.warning];
  }
  if (!rubricLoad.content) return [];

  const meta = evaluationArtifactMeta(rubricLoad);
  if (meta.kind !== "structured") {
    return [
      "",
      "## Scoring Rubric",
      "A legacy rubric was provided during planning. You MUST score EVERY factor below.",
      "For each factor, populate a `rubric_scores` entry with `factor`, `target`, `observed`, `score`, `target_score`, `status`, `tier`, and `notes`.",
      "Always include `score` and `target_score`: use numbers on the 0-10 scale for numeric quality factors, otherwise use null.",
      "Do NOT leave `rubric_scores` empty when a legacy rubric is provided.",
      "",
      rubricLoad.content,
    ];
  }

  const instructions = [
    "",
    "## Evaluation Channels",
    "The Outcome Contract authority is the frozen Done Criteria above; assess it pass/fail.",
    "Verification checks are runner-consumed evidence requirements, not scored quality factors.",
  ];
  if (meta.has_scored_factors) {
    instructions.push(
      "Earned Rubric factors are the only scored channel. Independently score every Earned Rubric factor below and report its tier as `quality`.",
      "Use the observation context to inspect the declared artifact and user surface; do not substitute code-only inference or invent evidence outside the listed surfaces."
    );
  } else {
    instructions.push(
      "No Earned Rubric factors were declared. Do not invent scores; set `rubric_scores` to `[]`."
    );
  }
  instructions.push("", rubricLoad.content);
  return instructions;
}

function buildRubricScoreValidationRule(rubricLoad = {}) {
  const meta = evaluationArtifactMeta(rubricLoad);
  if (meta.kind === "structured" && !meta.has_scored_factors) {
    return "- No Earned Rubric factors were declared; set `rubric_scores` to `[]`.";
  }
  if (meta.kind === "structured") {
    return "- `rubric_scores` is REQUIRED for every Earned Rubric factor and MUST exclude Outcome Contract and Verification entries.";
  }
  if (rubricLoad.content) {
    return "- `rubric_scores` is REQUIRED — score every factor from the legacy rubric. Use `score:null` and `target_score:null` when numeric scoring does not apply.";
  }
  return "- If no scored rubric is available, set `rubric_scores` to `[]`.";
}

module.exports = {
  buildEvaluationSections,
  buildRubricScoreValidationRule,
  evaluationArtifactMeta,
  structuredEarnedFactorNames,
  validateReviewerScoresForArtifact,
};
