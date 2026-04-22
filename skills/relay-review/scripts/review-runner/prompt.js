const path = require("path");
const { REVIEWER_VERDICT_JSON_SCHEMA } = require("../review-schema");
const { readText } = require("./common");
const { formatPriorRoundContext, loadProjectConventions } = require("./context");

const REVIEWER_PROMPT_PATH = path.join(__dirname, "..", "..", "references", "reviewer-prompt.md");

function renderProjectConventions(template, conventions) {
  if (conventions) return template.replace("[PASTE PROJECT CONVENTIONS HERE]", conventions);
  return template.replace(/\n## Project Conventions[\s\S]*?<\/task-content>\n(?=\n## PR Diff)/, "\n");
}

function buildPrompt({ round, prNumber, branch, issueNumber, doneCriteria, doneCriteriaSource, diffText, reviewRepoPath, runDir, rubricLoad }) {
  const template = renderProjectConventions(readText(REVIEWER_PROMPT_PATH)
    .replace("source=\"done-criteria\"", `source="${doneCriteriaSource || "done-criteria"}"`)
    .replace("[PASTE DONE CRITERIA HERE]", doneCriteria)
    .replace("[PASTE PR DIFF OR FILE PATH HERE]", diffText), reviewRepoPath ? loadProjectConventions(reviewRepoPath) : "");

  const sections = [
    `# Relay Review Round ${round}`,
    "",
    `PR: #${prNumber || "unknown"}`,
    `Branch: ${branch || "unknown"}`,
    `Issue: ${issueNumber || "unknown"}`,
    "",
    template,
  ];

  if (rubricLoad.warning) {
    sections.push(
      "",
      "## Scoring Rubric",
      rubricLoad.warning
    );
  } else if (rubricLoad.content) {
    sections.push(
      "",
      "## Scoring Rubric",
      "A rubric was provided during planning. You MUST score EVERY factor below.",
      "For each factor, populate a `rubric_scores` entry with `factor`, `target`, `observed`, `status`, `tier`, and `notes`.",
      "Do NOT leave `rubric_scores` empty when a rubric is provided.",
      "",
      rubricLoad.content
    );
  }

  const priorContext = formatPriorRoundContext(runDir, round);
  if (priorContext) {
    sections.push("", priorContext);
  }

  sections.push(
    "",
    "## Structured Output",
    "Return ONLY valid JSON. Do not wrap it in markdown fences.",
    "",
    JSON.stringify(REVIEWER_VERDICT_JSON_SCHEMA, null, 2),
    "",
    "Validation rules:",
    "- If `verdict` is `pass`, then `issues` must be `[]` and `next_action` must be `ready_to_merge`.",
    "- If `verdict` is `pass`, set both `contract_status` and `quality_review_status` to `pass`.",
    "- Set ONLY `quality_review_status`. Do NOT set `quality_execution_status`; the review runner computes it from execution-evidence.json.",
    "- If `verdict` is `changes_requested`, include actionable issues with `file` and `line`, and set `next_action` to `changes_requested`.",
    "- If `verdict` is `escalated`, include the blocking issues or reason that automation should stop, and set `next_action` to `escalated`.",
    rubricLoad.content
      ? "- `rubric_scores` is REQUIRED — score every factor from the rubric. Each entry must include `factor`, `target`, `observed`, `status`, `tier`, and `notes`."
      : "- If no Score Log is available, set `rubric_scores` to `[]`.",
    "- When `rubric_scores` is not empty, each entry must include `factor`, `target`, `observed`, `status`, `tier`, and `notes`.",
    "- `scope_drift` is always required. Set `scope_drift.creep` to `[]` if no out-of-scope changes. Set `scope_drift.missing` to list each Done Criteria item with status `verified`, `partial`, `not_done`, or `changed`.",
    "- If `scope_drift.missing` contains any `not_done`, `changed`, or `partial` entries, verdict cannot be `pass`."
  );

  return sections.join("\n");
}

function formatPriorVerdictSummary(verdicts) {
  if (!verdicts.length) return "";
  const lines = verdicts.map((verdict, index) => {
    const roundNum = verdicts.length - index;
    const issueCount = Array.isArray(verdict.issues) ? verdict.issues.length : 0;
    const rubricSummary = Array.isArray(verdict.rubric_scores) && verdict.rubric_scores.length
      ? verdict.rubric_scores.map((score) => `${score.factor}: ${score.observed} (target ${score.target}, ${score.status})`).join("; ")
      : "no rubric scores";
    return `- Round ${roundNum}: ${verdict.verdict} — ${verdict.summary} [${issueCount} issue(s), ${rubricSummary}]`;
  });
  return ["Prior review rounds:", ...lines].join("\n");
}

module.exports = {
  buildPrompt,
  formatPriorVerdictSummary,
};
