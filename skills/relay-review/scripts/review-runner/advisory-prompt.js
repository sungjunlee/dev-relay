function formatRubricSummary(rubricLoad) {
  if (!rubricLoad || rubricLoad.state !== "loaded") {
    return "No rubric was loaded for this review round.";
  }
  return [
    `Rubric status: ${rubricLoad.status || "unknown"}`,
    "",
    String(rubricLoad.content || "").trim(),
  ].join("\n");
}

function buildAdvisoryPrompt({
  branch,
  diffText,
  doneCriteria,
  doneCriteriaSource,
  issueNumber,
  prNumber,
  profile,
  round,
  rubricLoad,
}) {
  return [
    "# Relay Advisory Blind-Spot Review",
    "",
    "You are an advisory reviewer, not the trusted merge-gating reviewer.",
    "Return only JSON. Do not wrap the response in markdown fences.",
    "Do not modify files, run fix commands, create commits, or write comments.",
    "",
    "Your job is to find important blind spots the primary reviewer may miss while checking the same PR.",
    "Prioritize areas that are easy to under-review during a logic-focused pass: missing tests, bypass paths, edge cases, integration boundaries, stale docs, and operational failure modes.",
    "Separate high-confidence findings from speculative or duplicate observations. Do not issue an LGTM or merge verdict.",
    "",
    "## Required JSON Shape",
    "",
    JSON.stringify({
      profile,
      summary: "One sentence summary of advisory risk.",
      required_findings: [{
        title: "Required fix title",
        body: "Why this must be fixed before merge.",
        file: "path/to/file",
        line: 1,
        severity: "P1|P2|P3",
        category: "test-gap|bypass|edge-case|integration|docs|other",
        confidence: 0.9,
      }],
      advisory_findings: [{
        title: "Useful non-blocking observation",
        body: "Why this is worth considering.",
        file: "path/to/file",
        line: 1,
        severity: "P2|P3",
        category: "test-gap|bypass|edge-case|integration|docs|other",
        confidence: 0.75,
      }],
      duplicate_or_low_confidence: [],
    }, null, 2),
    "",
    "Use empty arrays when there are no findings in a bucket.",
    "",
    "## Review Context",
    "",
    `Profile: ${profile}`,
    `Round: ${round}`,
    `Branch: ${branch || "(unknown)"}`,
    `PR: ${prNumber || "(unknown)"}`,
    `Issue: ${issueNumber || "(none)"}`,
    `Done Criteria source: ${doneCriteriaSource || "(unknown)"}`,
    "",
    "## Done Criteria",
    "",
    doneCriteria,
    "",
    "## Rubric",
    "",
    formatRubricSummary(rubricLoad),
    "",
    "## Diff",
    "",
    diffText,
  ].join("\n");
}

module.exports = {
  buildAdvisoryPrompt,
};
