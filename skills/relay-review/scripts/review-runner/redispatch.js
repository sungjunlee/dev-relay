const fs = require("fs");
const path = require("path");
const { formatIssueList, formatScopeDrift } = require("./comment");
const { formatPriorVerdictSummary } = require("./prompt");

const FLIP_STATES = new Set(["pass", "fail"]);
const RUBRIC_PASS_THROUGH_STATES = new Set(["loaded"]);
const LINEAGE_VALUES = ["deepening", "repeat", "new", "newly_scoreable", "unknown"];

function buildRedispatchPrompt(verdict, doneCriteria, runDir, round, churnGrowth, doneCriteriaSource) {
  const sections = [
    `This is round ${round + 1}. Fix these review issues in the PR. Do not change anything else. Push to the same branch.`,
    "",
    "Issues to fix:",
    formatIssueList(verdict.issues),
  ];

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

function computeRepeatedIssueCount(runDir, round, issues) {
  if (!issues.length) return 0;

  let repeating = new Set(issues.map(fingerprintIssue));
  let count = 1;
  scanPriorVerdicts(runDir, round, (verdict) => {
    if (verdict.verdict !== "changes_requested" || !Array.isArray(verdict.issues) || verdict.issues.length === 0) {
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

function buildRubricRecoveryCommand(runId, redispatchPath) {
  return `node skills/relay-dispatch/scripts/dispatch.js . --run-id ${runId} --prompt-file ${redispatchPath} --rubric-file <fixed-rubric.yaml>`;
}

function buildRubricGateRedispatchPrompt(gateFailure, doneCriteria, doneCriteriaSource) {
  return [
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
  ].join("\n");
}

/**
 * Rubric fail-closed moves the run into `changes_requested` so the documented
 * `dispatch --run-id` recovery command remains executable without widening
 * dispatcher resume rules for arbitrary `review_pending` runs.
 * `next_action=repair_rubric_and_redispatch` tells the operator to fix the
 * anchored rubric state, re-dispatch the run, then rerun relay-review, and
 * `review.latest_verdict="rubric_state_failed_closed"` records that the raw
 * reviewer PASS was blocked by review-runner rubric enforcement.
 */
function buildReviewRunnerRubricGateFailure(runId, redispatchPath, rubricLoad) {
  if (!rubricLoad || RUBRIC_PASS_THROUGH_STATES.has(rubricLoad.state)) {
    return null;
  }

  const recoveryCommand = buildRubricRecoveryCommand(runId, redispatchPath);
  const rerunReviewStep = "After the re-dispatch completes, rerun relay-review.";
  let recovery;
  switch (rubricLoad.state) {
    case "not_set":
      recovery = `Persist a rubric for this run, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
    case "missing":
      recovery = `Restore or replace the missing rubric, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
    case "outside_run_dir":
      recovery = `Replace the escaped rubric anchor with a contained rubric, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
    case "empty":
      recovery = `Regenerate the empty rubric, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
    default:
      recovery = `Fix or replace the rubric anchor, then run \`${recoveryCommand}\`. ${rerunReviewStep}`;
      break;
  }

  return {
    status: "rubric_state_failed_closed",
    layer: "review-runner",
    rubricState: rubricLoad.state,
    rubricStatus: rubricLoad.status,
    reason: rubricLoad.error || "Rubric is not loaded.",
    recoveryCommand,
    recovery,
    summary: `review-runner fail-closed: rubricLoad.state='${rubricLoad.state}' blocked ready_to_merge despite reviewer PASS. ${recovery}`,
  };
}

module.exports = {
  buildRedispatchPrompt,
  buildReviewRunnerRubricGateFailure,
  buildRubricGateRedispatchPrompt,
  buildRubricRecoveryCommand,
  computeFactorStatusFlips,
  computeRepeatedIssueCount,
  decideFlipFlopEscalation,
  detectChurnGrowth,
  fingerprintIssue,
  normalizeFingerprintPart,
  readPriorVerdicts,
  scanPriorVerdicts,
  summarizeLineage,
  toEscalatedVerdict,
};
