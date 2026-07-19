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
      "Earned Rubric factors are the only scored channel. Independently score every Earned Rubric factor below and report its tier as `quality`."
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
};
