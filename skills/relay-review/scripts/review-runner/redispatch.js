const fs = require("fs");
const path = require("path");
const { formatIssueList, formatScopeDrift } = require("./comment");
const { formatPriorVerdictSummary } = require("./prompt");
const { getRubricScoreNumber, getRubricTargetNumber } = require("./score-utils");
const { getAppliedVerdict } = require("./verdict");

const FLIP_STATES = new Set(["pass", "fail"]);
const LINEAGE_VALUES = ["deepening", "repeat", "stale", "new", "newly_scoreable", "unknown"];

function buildRedispatchPrompt(verdict, doneCriteria, runDir, round, churnGrowth, doneCriteriaSource, currentHeadSha, convergenceSummary) {
  const sections = [
    `This is round ${round + 1}. Fix these review issues in the PR. Do not change anything else. Push to the same branch.`,
    "",
    "Issues to fix:",
    formatIssueList(verdict.issues),
  ];
  const lineageSection = formatRedispatchLineageSection(verdict?.issues || []);
  if (lineageSection) sections.push("", lineageSection);
  const staleCandidateSection = formatSameHeadStaleCandidateSection(runDir, round, currentHeadSha);
  if (staleCandidateSection) sections.push("", staleCandidateSection);

  const driftText = formatScopeDrift(verdict.scope_drift);
  if (driftText) {
    sections.push("", driftText);
  }

  if (runDir && round > 1) {
    const priorVerdicts = readPriorVerdicts(runDir, round);
    const priorSummary = formatPriorVerdictSummary(priorVerdicts);
    if (priorSummary) {
      sections.push("", priorSummary);
    }
    const factorFlips = listPriorFactorStatusFlips(runDir, round);
    if (factorFlips.length) {
      sections.push(
        "",
        "Prior-round factor flips (reviewer cannot converge on these — do NOT re-flag as blocker; owner decision needed):",
        ...factorFlips.map(({ factor, trace }) => `- ${factor}: ${trace.join("→")}`)
      );
    }
  }

  const scoreTarget = buildScoreOptimizationTarget(verdict, runDir, round);
  if (scoreTarget) {
    sections.push("", scoreTarget);
  }

  appendConvergenceContext(sections, convergenceSummary);

  if (churnGrowth) {
    sections.push(
      "",
      `WARNING: Diff has grown for 3+ consecutive rounds (${churnGrowth.prevPrevLines} → ${churnGrowth.prevLines} → ${churnGrowth.curLines} lines).`,
      "Apply minimal, targeted fixes only. Do not refactor, reorganize, or add code beyond what the issues require."
    );
  }

  sections.push(
    "",
    "Original Done Criteria (scope anchor):",
    `<task-content source="${doneCriteriaSource || "done-criteria"}">`,
    doneCriteria,
    "</task-content>"
  );

  return sections.join("\n");
}

function formatScoreValue(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function qualityScoreGap(score) {
  if (score?.tier !== "quality") return null;
  const numericScore = getRubricScoreNumber(score);
  const targetScore = getRubricTargetNumber(score);
  if (numericScore === null || targetScore === null || numericScore >= targetScore) return null;
  return {
    factor: score.factor,
    score: numericScore,
    target_score: targetScore,
    gap: Number((targetScore - numericScore).toFixed(4)),
    notes: String(score.notes || "").trim(),
  };
}

function findWeakestBelowTargetQualityScore(verdict) {
  const candidates = (Array.isArray(verdict?.rubric_scores) ? verdict.rubric_scores : [])
    .map(qualityScoreGap)
    .filter(Boolean);
  if (candidates.length === 0) return null;
  return candidates.sort((left, right) => {
    if (right.gap !== left.gap) return right.gap - left.gap;
    return left.score - right.score;
  })[0];
}

function buildScoreTrend(runDir, round, factor, currentScore) {
  const entries = [];
  if (runDir && round > 1) {
    const priorEntries = [];
    scanPriorVerdicts(runDir, round, (prior, priorRound) => priorEntries.push({ verdict: prior, round: priorRound }));
    priorEntries.reverse().forEach(({ verdict: prior, round: priorRound }) => {
      const match = (Array.isArray(prior?.rubric_scores) ? prior.rubric_scores : [])
        .find((score) => normalizeFingerprintPart(score.factor) === normalizeFingerprintPart(factor));
      const numericScore = getRubricScoreNumber(match);
      if (numericScore !== null) {
        entries.push({ round: priorRound, score: numericScore });
      }
    });
  }
  entries.push({ round, score: currentScore });
  return entries;
}

function isFlatScoreTrend(trend) {
  if (!Array.isArray(trend) || trend.length < 3) return false;
  const recent = trend.slice(-3).map((entry) => entry.score);
  return Math.max(...recent) - Math.min(...recent) <= 0.5;
}

function buildScoreOptimizationTarget(verdict, runDir, round) {
  const weakest = findWeakestBelowTargetQualityScore(verdict);
  if (!weakest) return "";
  const trend = buildScoreTrend(runDir, round, weakest.factor, weakest.score);
  const lines = [
    "Score optimization target:",
    `- Weakest below-target quality factor: ${weakest.factor}`,
    `- Reviewer score: ${formatScoreValue(weakest.score)}/10 (target ${formatScoreValue(weakest.target_score)}/10, gap ${formatScoreValue(weakest.gap)})`,
  ];
  if (trend.length > 1) {
    lines.push(`- Score trend: ${trend.map((entry) => `round ${entry.round}: ${formatScoreValue(entry.score)}`).join(" → ")}`);
  }
  if (weakest.notes) {
    lines.push(`- Reviewer notes: ${weakest.notes}`);
  }
  if (isFlatScoreTrend(trend)) {
    lines.push("- Stagnation signal: score has moved by <= 0.5 over the last 3 rounds. Refine the approach if the fix is obvious; otherwise pivot the implementation approach without expanding scope.");
  }
  lines.push("- Improve this factor without regressing already passing contract or quality factors.");
  return lines.join("\n");
}

function detectChurnGrowth(runDir, round) {
  if (!runDir || round < 3) return null;
  const countLines = (filePath) => {
    let count = 0;
    const buffer = fs.readFileSync(filePath);
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] === 0x0a) count += 1;
    }
    return count;
  };

  // Current round's diff was just written by the caller - must exist; let errors propagate.
  const curLines = countLines(path.join(runDir, `review-round-${round}-diff.patch`));
  try {
    const prevLines = countLines(path.join(runDir, `review-round-${round - 1}-diff.patch`));
    const prevPrevLines = countLines(path.join(runDir, `review-round-${round - 2}-diff.patch`));
    if (curLines > prevLines && prevLines > prevPrevLines && prevPrevLines > 0) {
      return { prevPrevLines, prevLines, curLines };
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return null;
}

function normalizeFingerprintPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Excludes `line` so the same semantic issue still repeats when reviewers restate
 * it at a different location across rounds.
 */
function fingerprintIssue(issue) {
  return [
    normalizeFingerprintPart(issue.file),
    normalizeFingerprintPart(issue.category),
    normalizeFingerprintPart(issue.title),
  ].join("|");
}

function readPriorVerdicts(runDir, currentRound) {
  const verdicts = [];
  for (let round = currentRound - 1; round >= 1; round -= 1) {
    const verdictPath = path.join(runDir, `review-round-${round}-verdict.json`);
    if (!fs.existsSync(verdictPath)) continue;
    verdicts.push(JSON.parse(fs.readFileSync(verdictPath, "utf-8")));
  }
  return verdicts;
}

/**
 * Calls `onVerdict(verdict, roundNum)` for each prior verdict from newest round
 * to oldest. Return `false` to stop iteration early; any other return continues.
 */
function scanPriorVerdicts(runDir, currentRound, onVerdict) {
  const verdicts = readPriorVerdicts(runDir, currentRound);
  for (let round = currentRound - 1, index = 0; round >= 1 && index < verdicts.length; round -= 1) {
    if (!fs.existsSync(path.join(runDir, `review-round-${round}-verdict.json`))) continue;
    if (onVerdict(verdicts[index], round) === false) return;
    index += 1;
  }
}

function readReviewApplyEvents(runDir) {
  if (!runDir) return [];
  const eventsPath = path.join(runDir, "events.jsonl");
  try {
    const events = [];
    for (const line of fs.readFileSync(eventsPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.event === "review_apply") events.push(event);
      } catch {
        // Best-effort stale-candidate metadata must not block re-dispatch.
      }
    }
    return events;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function computeRepeatedIssueCount(runDir, round, issues) {
  if (!issues.length) return 0;

  let repeating = new Set(issues.map(fingerprintIssue));
  let count = 1;
  scanPriorVerdicts(runDir, round, (verdict) => {
    if (getAppliedVerdict(verdict) !== "changes_requested" || !Array.isArray(verdict.issues) || verdict.issues.length === 0) {
      return false;
    }
    const prior = new Set(verdict.issues.map(fingerprintIssue));
    repeating = new Set([...repeating].filter((entry) => prior.has(entry)));
    if (repeating.size === 0) return false;
    count += 1;
  });
  return count;
}

function mapRubricStatuses(verdict) {
  return new Map((Array.isArray(verdict?.rubric_scores) ? verdict.rubric_scores : [])
    .map((score) => [normalizeFingerprintPart(score.factor), { factor: score.factor, status: score.status }]));
}

function isFlipTrace(trace) {
  return trace.length === 3
    && trace.every((status) => FLIP_STATES.has(status))
    && trace[0] === trace[2]
    && trace[0] !== trace[1];
}

function collectFactorStatusFlips(verdicts) {
  const [first, second, third] = verdicts.map(mapRubricStatuses);
  return [...third.entries()].flatMap(([key, current]) => {
    const trace = [first.get(key)?.status, second.get(key)?.status, current.status];
    return isFlipTrace(trace) ? [{ factor: current.factor, trace }] : [];
  });
}

function computeFactorStatusFlips(runDir, round, currentVerdict) {
  const priorVerdicts = [];
  scanPriorVerdicts(runDir, round, (verdict, verdictRound) => {
    if (verdictRound < round - 2) return false;
    priorVerdicts.push(verdict);
  });
  return priorVerdicts.length < 2 ? [] : collectFactorStatusFlips([priorVerdicts[1], priorVerdicts[0], currentVerdict]);
}

function summarizeLineage(issues = []) {
  const summary = Object.fromEntries(LINEAGE_VALUES.map((value) => [value, 0]));
  for (const issue of Array.isArray(issues) ? issues : []) {
    const lineage = LINEAGE_VALUES.includes(issue?.lineage) ? issue.lineage : "unknown";
    summary[lineage] += 1;
  }
  return summary;
}

function formatLineageCounts(summary) {
  return LINEAGE_VALUES.map((value) => `${value}=${Number(summary?.[value] || 0)}`).join(", ");
}

function formatRedispatchLineageSection(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return "";
  const lines = [
    `Current review lineage: ${formatLineageCounts(summarizeLineage(issues))}`,
    "Current issue lineage labels:",
  ];
  for (const issue of issues) {
    const lineage = LINEAGE_VALUES.includes(issue?.lineage) ? issue.lineage : "unknown";
    const relation = issue?.relates_to ? `, relates_to=${issue.relates_to}` : "";
    lines.push(`- ${issue.file}:${issue.line} — ${issue.title}: lineage=${lineage}${relation}`);
  }
  return lines.join("\n");
}

function findPriorSameHeadReview(runDir, round, currentHeadSha) {
  const current = String(currentHeadSha || "").trim();
  if (!current) return null;
  return readReviewApplyEvents(runDir)
    .filter((event) => Number(event.round) < round && String(event.head_sha || "").trim() === current)
    .sort((left, right) => Number(right.round || 0) - Number(left.round || 0))[0] || null;
}

function formatSameHeadStaleCandidateSection(runDir, round, currentHeadSha) {
  const prior = findPriorSameHeadReview(runDir, round, currentHeadSha);
  if (!prior) return "";
  return [
    "Same-HEAD stale candidates:",
    `- Current reviewed HEAD matches prior review round ${prior.round} (${currentHeadSha}).`,
    "- Deterministic signal only: the runner did not infer semantic stale lineage.",
    "- Treat reviewer-labeled `repeat` or `stale` issues as stale candidates until the branch advances; inspect `deepening`, `new`, and `newly_scoreable` findings against the diff.",
  ].join("\n");
}

function issueMatchesFactor(issue, factor) {
  const needle = normalizeFingerprintPart(factor);
  return Boolean(needle) && ["category", "title"].some((key) => normalizeFingerprintPart(issue?.[key]).includes(needle));
}

function allFlippedFactorIssuesDeepen(issues, factorFlips) {
  if (!Array.isArray(issues) || issues.length === 0) return false;
  const tiedIssues = issues.filter((issue) => factorFlips.some(({ factor }) => issueMatchesFactor(issue, factor)));
  return tiedIssues.length > 0 && tiedIssues.every((issue) => issue.lineage === "deepening");
}

function isCleanPassVerdict(verdict) {
  return verdict?.verdict === "pass" && (!Array.isArray(verdict.issues) || verdict.issues.length === 0);
}

function decideFlipFlopEscalation({ verdict, factorFlips, repeatedIssueCount }) {
  const factors = factorFlips.map(({ factor }) => factor);
  const traces = factorFlips.map(({ factor, trace }) => ({ factor, trace }));
  const lineage_summary = summarizeLineage(verdict?.issues || []);
  if (!factorFlips.length) return { decision: "continue", reason: "no_trigger", factors: [], traces: [], lineage_summary };
  if (repeatedIssueCount === 0 && (isCleanPassVerdict(verdict) || allFlippedFactorIssuesDeepen(verdict?.issues, factorFlips))) {
    return { decision: "continue", reason: "progressive_deepening", factors, traces, lineage_summary };
  }
  return { decision: "escalate", reason: "flip_flop_thrash", factors, traces, lineage_summary };
}

function hasConsecutiveRounds(entries, index) {
  return index >= 2
    && entries[index - 2].round + 1 === entries[index - 1].round
    && entries[index - 1].round + 1 === entries[index].round;
}

function listPriorFactorStatusFlips(runDir, round) {
  const priorVerdicts = [];
  scanPriorVerdicts(runDir, round, (verdict, verdictRound) => priorVerdicts.push({ round: verdictRound, verdict }));
  priorVerdicts.reverse();
  const flips = priorVerdicts.reduce((memo, _entry, index, entries) => {
    if (!hasConsecutiveRounds(entries, index)) return memo;
    for (const flip of collectFactorStatusFlips(entries.slice(index - 2, index + 1).map((entry) => entry.verdict))) memo.set(normalizeFingerprintPart(flip.factor), flip);
    return memo;
  }, new Map());
  return [...flips.values()];
}

function toEscalatedVerdict(baseVerdict, summary) {
  return {
    ...baseVerdict,
    verdict: "escalated",
    next_action: "escalated",
    summary,
  };
}

function appendConvergenceContext(sections, convergenceSummary) {
  if (!convergenceSummary) return;
  const { formatConvergenceMarkdown } = require("./convergence");
  const convergenceMarkdown = formatConvergenceMarkdown(convergenceSummary);
  if (convergenceMarkdown) sections.push("", convergenceMarkdown);
}

function buildRubricGateRedispatchPrompt(gateFailure, doneCriteria, doneCriteriaSource, convergenceSummary) {
  const sections = [
    "Rubric recovery re-dispatch",
    "",
    "relay-review failed closed on the rubric anchor, not on the code diff.",
    "",
    `Gate status: ${gateFailure.status}`,
    `Rubric state: ${gateFailure.rubricState} (anchor status: ${gateFailure.rubricStatus})`,
    `Reason: ${gateFailure.reason}`,
    `Recovery command: ${gateFailure.recoveryCommand}`,
    "",
    "Instructions:",
    "- Fix the rubric anchor or supply a replacement rubric with --rubric-file.",
    "- Keep the accepted task scope unchanged while re-dispatching.",
    "- After the re-dispatch completes, rerun relay-review on the same run.",
    "",
    `Done Criteria source: ${doneCriteriaSource}`,
    "Done Criteria:",
    doneCriteria,
  ];
  appendConvergenceContext(sections, convergenceSummary);
  return sections.join("\n");
}

module.exports = {
  buildRedispatchPrompt,
  buildScoreOptimizationTarget,
  buildRubricGateRedispatchPrompt,
  computeFactorStatusFlips,
  computeRepeatedIssueCount,
  decideFlipFlopEscalation,
  detectChurnGrowth,
  fingerprintIssue,
  findWeakestBelowTargetQualityScore,
  issueMatchesFactor,
  normalizeFingerprintPart,
  readPriorVerdicts,
  scanPriorVerdicts,
  summarizeLineage,
  toEscalatedVerdict,
};
