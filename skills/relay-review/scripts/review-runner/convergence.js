const {
  computeFactorStatusFlips,
  fingerprintIssue,
  issueMatchesFactor,
  normalizeFingerprintPart,
  scanPriorVerdicts,
  summarizeLineage,
} = require("./redispatch");
const { getRubricScoreNumber } = require("./score-utils");

const LINEAGE_ORDER = ["deepening", "repeat", "stale", "new", "newly_scoreable", "unknown"];
const SUMMARY_VERDICTS = new Set(["pass", "changes_requested", "escalated"]);

function statusForRoundVerdict(round, verdict) {
  if (round < 3 || !SUMMARY_VERDICTS.has(verdict?.verdict)) return null;
  if (verdict.verdict === "pass") return "converged";
  if (round >= 5) return "decision_recommended";
  return "watch";
}

function getRubricScores(verdict) {
  return Array.isArray(verdict?.rubric_scores) ? verdict.rubric_scores : [];
}

function collectPriorVerdicts(runDir, round) {
  const entries = [];
  if (!runDir || round <= 1) return entries;
  scanPriorVerdicts(runDir, round, (verdict, verdictRound) => {
    entries.push({ round: verdictRound, verdict });
  });
  entries.reverse();
  return entries;
}

function buildScoreTrends(runDir, round, verdict) {
  const scoreEntries = getRubricScores(verdict);
  const trends = {};
  const priorEntries = collectPriorVerdicts(runDir, round);

  for (const scoreEntry of scoreEntries) {
    const factor = scoreEntry.factor;
    const factorKey = normalizeFingerprintPart(factor);
    const trend = [];
    for (const { verdict: priorVerdict } of priorEntries) {
      const priorScore = getRubricScores(priorVerdict)
        .find((entry) => normalizeFingerprintPart(entry.factor) === factorKey);
      const numericScore = getRubricScoreNumber(priorScore);
      if (numericScore !== null) trend.push(numericScore);
    }
    const currentScore = getRubricScoreNumber(scoreEntry);
    if (currentScore !== null) trend.push(currentScore);
    trends[factor] = trend;
  }

  return trends;
}

function findImmediatePriorChangesRequested(runDir, round) {
  if (!runDir || round <= 1) return null;
  let prior = null;
  scanPriorVerdicts(runDir, round, (verdict) => {
    prior = verdict;
    return false;
  });
  return prior?.verdict === "changes_requested" && Array.isArray(prior.issues) ? prior : null;
}

function currentIssueFactors(issue, verdict) {
  const factors = [];
  for (const scoreEntry of getRubricScores(verdict)) {
    if (issueMatchesFactor(issue, scoreEntry.factor)) factors.push(scoreEntry.factor);
  }
  if (factors.length) return factors;
  if (issue?.factor) return [String(issue.factor)];
  if (issue?.category) return [String(issue.category)];
  return [];
}

function computeRepeatedFactors(runDir, round, verdict) {
  const currentIssues = Array.isArray(verdict?.issues) ? verdict.issues : [];
  if (!currentIssues.length) return [];
  const prior = findImmediatePriorChangesRequested(runDir, round);
  if (!prior) return [];

  const priorFingerprints = new Set(prior.issues.map(fingerprintIssue));
  const repeated = new Set();
  for (const issue of currentIssues) {
    if (!priorFingerprints.has(fingerprintIssue(issue))) continue;
    for (const factor of currentIssueFactors(issue, verdict)) repeated.add(factor);
  }
  return [...repeated];
}

function tiedIssuesForFactor(issues, factor) {
  return (Array.isArray(issues) ? issues : []).filter((issue) => issueMatchesFactor(issue, factor));
}

function isAllLineage(issues, lineage) {
  return issues.length > 0 && issues.every((issue) => issue?.lineage === lineage);
}

function describeInstabilityReason(tiedIssues) {
  if (!tiedIssues.length) return "Flipped factor has no current tied issues to explain the status change.";
  const lineageCounts = summarizeLineage(tiedIssues);
  const active = LINEAGE_ORDER
    .filter((lineage) => lineageCounts[lineage] > 0)
    .map((lineage) => `${lineage}=${lineageCounts[lineage]}`)
    .join(", ");
  return `Flipped factor has tied issues outside progressive deepening or newly scoreable lineage (${active}).`;
}

function computeSemanticInstability(verdict, factorFlips) {
  const issues = Array.isArray(verdict?.issues) ? verdict.issues : [];
  return (Array.isArray(factorFlips) ? factorFlips : []).flatMap(({ factor, trace }) => {
    const tiedIssues = tiedIssuesForFactor(issues, factor);
    if (isAllLineage(tiedIssues, "deepening") || isAllLineage(tiedIssues, "newly_scoreable")) return [];
    if (verdict?.verdict === "pass" && tiedIssues.length === 0) return [];
    return [{
      factor,
      trace,
      reason: describeInstabilityReason(tiedIssues),
    }];
  });
}

function countFailingFactors(verdict) {
  return getRubricScores(verdict).filter((entry) => entry.status === "fail").length;
}

function addRecommendation(summary, verdict, repeatedIssueCount) {
  if (summary.status !== "decision_recommended") return summary;
  if (summary.semantic_instability.length) {
    return {
      ...summary,
      recommendation: "decide_semantics",
      recommendation_reason: "semantic_instability non-empty",
    };
  }
  if (repeatedIssueCount >= 2) {
    return {
      ...summary,
      recommendation: "manual_pairing",
      recommendation_reason: "repeatedIssueCount >= 2",
    };
  }
  if (countFailingFactors(verdict) >= 3) {
    return {
      ...summary,
      recommendation: "narrow_rubric",
      recommendation_reason: "current verdict has at least 3 failing rubric factors",
    };
  }
  if (summary.lineage_counts.new >= 2) {
    return {
      ...summary,
      recommendation: "split_issue",
      recommendation_reason: "lineage_counts.new >= 2",
    };
  }
  return {
    ...summary,
    recommendation: "defer_follow_up",
    recommendation_reason: "no earlier convergence-budget condition matched",
  };
}

function buildConvergenceSummary({ runDir, round, verdict, factorFlips, repeatedIssueCount = 0 }) {
  const status = statusForRoundVerdict(round, verdict);
  if (!status) return null;

  const flips = Array.isArray(factorFlips)
    ? factorFlips
    : computeFactorStatusFlips(runDir, round, verdict);
  const summary = {
    round,
    status,
    repeated_factors: computeRepeatedFactors(runDir, round, verdict),
    lineage_counts: summarizeLineage(verdict?.issues || []),
    score_trends: buildScoreTrends(runDir, round, verdict),
    flip_candidates: flips,
    semantic_instability: computeSemanticInstability(verdict, flips),
  };

  return addRecommendation(summary, verdict, repeatedIssueCount);
}

function formatScoreTrends(scoreTrends) {
  const entries = Object.entries(scoreTrends || {});
  if (!entries.length) return ["- Score trends: none"];
  return [
    "- Score trends:",
    ...entries.map(([factor, trend]) => `  - ${factor}: ${Array.isArray(trend) && trend.length ? trend.join(" -> ") : "none"}`),
  ];
}

function formatLineageCounts(lineageCounts) {
  return LINEAGE_ORDER.map((lineage) => `${lineage}=${Number(lineageCounts?.[lineage] || 0)}`).join(", ");
}

function formatFactorTraces(label, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [`- ${label}: none`];
  return [
    `- ${label}:`,
    ...entries.map((entry) => `  - ${entry.factor}: ${(entry.trace || []).join(" -> ")}${entry.reason ? ` (${entry.reason})` : ""}`),
  ];
}

function formatConvergenceMarkdown(summary) {
  if (!summary) return "";
  const lines = [
    "## Convergence context",
    "",
    `- Round: ${summary.round}`,
    `- Status: ${summary.status}`,
    `- Repeated factors: ${summary.repeated_factors.length ? summary.repeated_factors.join(", ") : "none"}`,
    `- Lineage counts: ${formatLineageCounts(summary.lineage_counts)}`,
    ...formatScoreTrends(summary.score_trends),
    ...formatFactorTraces("Flip candidates", summary.flip_candidates),
    ...formatFactorTraces("Semantic instability", summary.semantic_instability),
  ];
  if (summary.recommendation) {
    lines.push(`- Recommendation: ${summary.recommendation}`);
    lines.push(`- Recommendation reason: ${summary.recommendation_reason}`);
  }
  return lines.join("\n");
}

module.exports = {
  buildConvergenceSummary,
  formatConvergenceMarkdown,
};
