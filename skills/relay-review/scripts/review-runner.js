#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { STATES } = require("../../relay-dispatch/scripts/manifest/lifecycle");
const { ensureRunLayout, getRunDir } = require("../../relay-dispatch/scripts/manifest/paths");
const { writeManifest } = require("../../relay-dispatch/scripts/manifest/store");
const { appendIterationScore, appendRunEvent, appendScoreDivergence, EVENTS } = require("../../relay-dispatch/scripts/relay-events");
const { git, writeText } = require("./review-runner/common");
const {
  applyReviewerIdentity,
  getGhLogin,
  loadDiff,
  loadDoneCriteria,
  loadRubricFromRunDir,
  parseRemoteHost,
  resolveContext,
  resolveIssueNumber,
  resolveRemoteHost,
} = require("./review-runner/context");
const { buildPrompt, formatPriorVerdictSummary } = require("./review-runner/prompt");
const { ALLOWED_SCORE_TIERS, parseReviewVerdict, validateReviewVerdict, validateScopeDrift } = require("./review-runner/verdict");
const { buildCommentBody, formatIssueList, formatScopeDrift, postComment } = require("./review-runner/comment");
const { buildScoreDivergenceAnalysis, loadPrBody, parseScoreLog } = require("./review-runner/divergence");
const { applyQualityExecutionStatus, buildExecutionEvidenceFailureVerdict, buildMissingExecutionEvidenceVerdict, computeQualityExecutionStatus } = require("./review-runner/execution-evidence");
const {
  buildRedispatchPrompt,
  buildReviewRunnerRubricGateFailure,
  buildRubricGateRedispatchPrompt,
  computeFactorStatusFlips,
  computeRepeatedIssueCount,
  decideFlipFlopEscalation,
  detectChurnGrowth,
  summarizeLineage,
  toEscalatedVerdict,
} = require("./review-runner/redispatch");
const { applyPolicyViolationToManifest, applyVerdictToManifest } = require("./review-runner/manifest-apply");
const { writePrBodySnapshot } = require("./review-runner/pr-body-snapshot");
const { loadReviewText, resolveReviewerName, resolveReviewerScript } = require("./review-runner/reviewer-invoke");
const { maybeSwapReviewer } = require("./review-runner/reviewer-swap");
const {
  getArg: sharedGetArg,
  hasFlag: sharedHasFlag,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--run-id", "--branch", "--pr", "--manifest", "--done-criteria-file", "--diff-file", "--review-file", "--reviewer", "--reviewer-script", "--reviewer-model", "--prepare-only", "--no-comment", "--json", "--help", "-h"];
const CLI_ARG_OPTIONS = { commandName: "review-runner", reservedFlags: KNOWN_FLAGS };
const getArg = (flag, fallback) => sharedGetArg(args, flag, fallback, CLI_ARG_OPTIONS);
const hasFlag = (flag) => sharedHasFlag(args, flag, CLI_ARG_OPTIONS);

if (require.main === module && (!args.length || hasFlag(["--help", "-h"]))) {
  console.log("Usage: review-runner.js --repo <path> (--run-id <id> | --branch <name> | --pr <number>) [options]");
  console.log("\nPrepare or apply a structured relay review round.");
  console.log("\nOptions:");
  console.log(`  --repo <path>                ${modeLabel("--repo")} Repository root (default: .)`);
  console.log(`  --run-id <id>                ${modeLabel("--run-id")} Relay run identifier`);
  console.log(`  --branch <name>              ${modeLabel("--branch")} Working branch`);
  console.log(`  --pr <number>                ${modeLabel("--pr")} PR number`);
  console.log(`  --manifest <path>            ${modeLabel("--manifest")} Explicit manifest path`);
  console.log(`  --done-criteria-file <path>  ${modeLabel("--done-criteria-file")} Use fixture file instead of gh issue fetch`);
  console.log(`  --diff-file <path>           ${modeLabel("--diff-file")} Use fixture file instead of gh pr diff`);
  console.log(`  --review-file <path>         ${modeLabel("--review-file")} Structured reviewer JSON verdict to apply`);
  console.log(`  --reviewer <name>            ${modeLabel("--reviewer")} Reviewer adapter to invoke (codex|claude|...)`);
  console.log(`  --reviewer-script <path>     ${modeLabel("--reviewer-script")} Override adapter script path`);
  console.log(`  --reviewer-model <name>      ${modeLabel("--reviewer-model")} Reviewer model override`);
  console.log(`  --prepare-only               ${modeLabel("--prepare-only")} Emit prompt bundle only; do not apply verdict`);
  console.log(`  --no-comment                 ${modeLabel("--no-comment")} Do not post a PR comment`);
  console.log(`  --json                       ${modeLabel("--json")} Output JSON`);
  process.exit(hasFlag(["--help", "-h"]) ? 0 : 1);
}

function printResult({ doneCriteriaPath, diffPath, jsonOut, manifestPath, originalState, prepareOnly, prNumber, promptPath, redispatchPath, result, updatedManifest, verdictPath }) {
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (prepareOnly) {
    console.log(`Prepared relay review round ${result.round}`);
    console.log(`  Manifest:      ${manifestPath}`);
    console.log(`  Prompt:        ${promptPath}`);
    console.log(`  Done criteria: ${doneCriteriaPath}`);
    console.log(`  Diff:          ${diffPath}`);
    return;
  }

  console.log(`Applied relay review round ${result.round}`);
  console.log(`  Manifest: ${manifestPath}`);
  console.log(`  State:    ${originalState} -> ${updatedManifest.state}`);
  console.log(`  Prompt:   ${promptPath}`);
  console.log(`  Verdict:  ${verdictPath}`);
  if (redispatchPath) console.log(`  Re-dispatch: ${redispatchPath}`);
  if (result.commentPosted) console.log(`  PR comment posted to #${prNumber}`);
}

function run() {
  const repoPath = path.resolve(getArg("--repo") || ".");
  const manifestPathArg = getArg("--manifest");
  const runIdArg = getArg("--run-id");
  const branchArg = getArg("--branch");
  const prArg = getArg("--pr");
  const doneCriteriaFile = getArg("--done-criteria-file");
  const diffFile = getArg("--diff-file");
  const reviewFile = getArg("--review-file");
  const reviewerArg = getArg("--reviewer");
  const reviewerScriptArg = getArg("--reviewer-script");
  const reviewerModel = getArg("--reviewer-model");
  const prepareOnly = hasFlag("--prepare-only");
  const noComment = hasFlag("--no-comment");
  const jsonOut = hasFlag("--json");

  const { branch, issueNumber, manifest, prNumber, reviewRepoPath, runRepoPath } = resolveContext(
    repoPath,
    manifestPathArg,
    runIdArg,
    branchArg,
    prArg
  );
  const { body, manifestPath } = manifest;
  let { data } = manifest;

  data = maybeSwapReviewer(data, reviewerArg, body, manifestPath, runRepoPath);

  if (data.state !== STATES.REVIEW_PENDING) {
    throw new Error(`Review runner requires state=review_pending, got '${data.state}'`);
  }
  if (!fs.existsSync(reviewRepoPath)) {
    throw new Error(`Retained review checkout does not exist: ${reviewRepoPath}`);
  }

  const round = Number(data.review?.rounds || 0) + 1;
  const maxRounds = Number(data.review?.max_rounds || 20);
  const runDir = getRunDir(runRepoPath, data.run_id);
  ensureRunLayout(runRepoPath, data.run_id);
  let reviewedHeadSha = null;
  try {
    reviewedHeadSha = git(reviewRepoPath, "rev-parse", "HEAD").trim();
  } catch {}

  if (round > maxRounds) {
    const escalationDecision = {
      round: Number(data.review?.rounds || 0), trigger: "max_rounds", factors: [], traces: [],
      lineage_summary: summarizeLineage([]), decision: "escalate", reason: "max_rounds_exceeded",
    };
    const escalatedManifest = applyPolicyViolationToManifest(data, Number(data.review?.rounds || 0), prNumber, reviewedHeadSha, "max_rounds_exceeded", { escalationDecision });
    writeManifest(manifestPath, escalatedManifest, body);
    appendRunEvent(runRepoPath, data.run_id, { event: EVENTS.ESCALATION_DECISION, state_from: data.state, state_to: STATES.ESCALATED, head_sha: reviewedHeadSha, ...escalationDecision });
    appendRunEvent(runRepoPath, data.run_id, {
      event: EVENTS.REVIEW_APPLY,
      state_from: data.state,
      state_to: STATES.ESCALATED,
      head_sha: reviewedHeadSha,
      round: Number(data.review?.rounds || 0),
      reason: "max_rounds_exceeded",
      // No reviewer round executed here; mark the system-forced transition explicitly.
      origin: "system",
    });
    throw new Error(`Review round cap exceeded: next round ${round} would exceed max_rounds=${maxRounds}`);
  }

  const { source: doneCriteriaSource, text: doneCriteria } = loadDoneCriteria(
    runRepoPath,
    issueNumber,
    prNumber,
    doneCriteriaFile,
    data
  );
  const diffText = loadDiff(runRepoPath, prNumber, diffFile);
  const rubricLoad = loadRubricFromRunDir(runDir, data);

  const doneCriteriaPath = path.join(runDir, `review-round-${round}-done-criteria.md`);
  const diffPath = path.join(runDir, `review-round-${round}-diff.patch`);
  const prBodyPath = path.join(runDir, `review-round-${round}-pr-body.md`);
  const promptPath = path.join(runDir, `review-round-${round}-prompt.md`);
  const prBodySnapshot = writePrBodySnapshot({ repoPath: runRepoPath, runId: data.run_id, round, prNumber, prBodyPath });
  const promptText = buildPrompt({ round, prNumber, branch, issueNumber, doneCriteria, doneCriteriaSource, diffText, reviewRepoPath, runDir, rubricLoad, prBodyPath, prBodySnapshot });
  writeText(doneCriteriaPath, `${doneCriteria}\n`);
  writeText(diffPath, `${diffText}\n`);
  writeText(promptPath, `${promptText}\n`);

  const churnGrowth = detectChurnGrowth(runDir, round);
  if (churnGrowth && !jsonOut) {
    const growth = Math.round(((churnGrowth.curLines - churnGrowth.prevPrevLines) / churnGrowth.prevPrevLines) * 100);
    console.log(`  Warning: diff growing without convergence (${churnGrowth.prevPrevLines} → ${churnGrowth.prevLines} → ${churnGrowth.curLines} lines, +${growth}%)`);
  }

  const reviewerName = resolveReviewerName(data, reviewerArg);
  const reviewerScript = reviewFile ? null : resolveReviewerScript(reviewerName, reviewerScriptArg);
  const result = {
    branch,
    commentPosted: false,
    diffPath,
    doneCriteriaPath,
    issueNumber,
    manifestPath,
    nextState: null,
    prBodyPath,
    prBodySnapshot,
    prNumber,
    prepareOnly,
    promptPath,
    rawResponsePath: null,
    redispatchPath: null,
    reviewFile: reviewFile || null,
    reviewHeadSha: reviewedHeadSha,
    reviewRepoPath,
    reviewer: reviewerName,
    reviewerScript,
    round,
    rubricLoaded: rubricLoad.state,
    rubricStatus: rubricLoad.status,
    rubricWarning: rubricLoad.warning || null,
    runId: data.run_id,
    state: data.state,
    verdictPath: null,
  };

  if (prepareOnly) {
    printResult({ doneCriteriaPath, diffPath, jsonOut, manifestPath, originalState: data.state, prepareOnly, prNumber, promptPath, redispatchPath: null, result, updatedManifest: null, verdictPath: null });
    return;
  }

  const { rawResponsePath, reviewText } = loadReviewText({
    body,
    data,
    manifestPath,
    prNumber,
    promptPath,
    reviewFile,
    reviewRepoPath,
    reviewedHeadSha,
    reviewerModel,
    reviewerName,
    reviewerScript,
    round,
    runDir,
    runRepoPath,
  });
  result.rawResponsePath = rawResponsePath;

  let verdict = parseReviewVerdict(reviewText, { requireExecutionStatus: false });
  if (rubricLoad.state === "loaded" && (!Array.isArray(verdict.rubric_scores) || verdict.rubric_scores.length === 0)) {
    throw new Error(
      "Review verdict has empty rubric_scores but a rubric was provided. " +
      "The reviewer must score every rubric factor."
    );
  }
  const executionStatus = computeQualityExecutionStatus({ runDir, reviewedHead: reviewedHeadSha });
  verdict = applyQualityExecutionStatus(verdict, executionStatus);
  if (verdict.verdict === "pass" && executionStatus.status !== "pass") {
    verdict = executionStatus.status === "missing"
      ? buildMissingExecutionEvidenceVerdict(verdict)
      : buildExecutionEvidenceFailureVerdict(verdict);
  }
  validateReviewVerdict(verdict);

  const repeatedIssueCount = verdict.verdict === "changes_requested"
    ? computeRepeatedIssueCount(runDir, round, verdict.issues)
    : 0;
  let escalationDecision = { round, trigger: "none", factors: [], traces: [], lineage_summary: summarizeLineage(verdict.issues), decision: "continue", reason: "no_trigger" };
  if (verdict.verdict === "changes_requested" && repeatedIssueCount >= 3) {
    verdict = toEscalatedVerdict(
      verdict,
      `Repeated identical review issues hit ${repeatedIssueCount} consecutive rounds.`
    );
    escalationDecision = { ...escalationDecision, trigger: "repeated_issues", decision: "escalate", reason: "repeated_issues" };
  }
  const factorFlips = computeFactorStatusFlips(runDir, round, verdict);
  if (factorFlips.length && escalationDecision.trigger !== "repeated_issues") {
    escalationDecision = { round, trigger: "flip_flop", ...decideFlipFlopEscalation({ verdict, factorFlips, repeatedIssueCount }) };
  }
  if (escalationDecision.decision === "escalate" && escalationDecision.trigger === "flip_flop") {
    verdict = toEscalatedVerdict(
      verdict,
      factorFlips.map(({ factor, trace }) => `Rubric factor '${factor}' status flipped across 3 rounds (trace: ${trace.join("→")}). Owner decision required — reviewer cannot converge autonomously.`).join("; ")
    );
  }

  const rubricGateRedispatchPath = path.join(runDir, `review-round-${round}-redispatch.md`);
  const rubricGateFailure = verdict.verdict === "pass"
    ? buildReviewRunnerRubricGateFailure(data.run_id, rubricGateRedispatchPath, rubricLoad)
    : null;
  const verdictPath = path.join(runDir, `review-round-${round}-verdict.json`);
  const verdictRecord = rubricGateFailure
    ? {
      ...verdict,
      relay_gate: {
        status: rubricGateFailure.status,
        layer: rubricGateFailure.layer,
        rubric_state: rubricGateFailure.rubricState,
        rubric_status: rubricGateFailure.rubricStatus,
        reason: rubricGateFailure.reason,
        recovery_command: rubricGateFailure.recoveryCommand,
        recovery: rubricGateFailure.recovery,
      },
    }
    : verdict;
  writeText(verdictPath, `${JSON.stringify(verdictRecord, null, 2)}\n`);

  let redispatchPath = null;
  if (verdict.verdict === "changes_requested" || rubricGateFailure) {
    redispatchPath = rubricGateFailure
      ? rubricGateRedispatchPath
      : path.join(runDir, `review-round-${round}-redispatch.md`);
    const redispatchPrompt = rubricGateFailure
      ? buildRubricGateRedispatchPrompt(rubricGateFailure, doneCriteria, doneCriteriaSource)
      : buildRedispatchPrompt(verdict, doneCriteria, runDir, round, churnGrowth, doneCriteriaSource);
    writeText(redispatchPath, `${redispatchPrompt}\n`);
  }

  const { eventPayload: divergencePayload, warnings: divergenceWarnings } = buildScoreDivergenceAnalysis(
    loadPrBody(runRepoPath, prNumber),
    verdict.rubric_scores
  );
  const commentBody = buildCommentBody(verdict, round, {
    gateFailure: rubricGateFailure,
    warnings: divergenceWarnings,
  });
  if (!noComment) {
    postComment(runRepoPath, prNumber, commentBody);
    result.commentPosted = true;
  }

  let updatedManifest = applyVerdictToManifest(data, verdict, round, prNumber, reviewedHeadSha, repeatedIssueCount, { rubricGateFailure, escalationDecision });
  updatedManifest = {
    ...updatedManifest,
    review: {
      ...(updatedManifest.review || {}),
      last_reviewer: reviewerName,
    },
  };
  updatedManifest = applyReviewerIdentity(updatedManifest, noComment, runRepoPath);
  writeManifest(manifestPath, updatedManifest, body);
  appendRunEvent(runRepoPath, data.run_id, { event: EVENTS.ESCALATION_DECISION, state_from: data.state, state_to: updatedManifest.state, head_sha: reviewedHeadSha, ...escalationDecision });
  appendRunEvent(runRepoPath, data.run_id, {
    event: EVENTS.REVIEW_APPLY,
    state_from: data.state,
    state_to: updatedManifest.state,
    head_sha: reviewedHeadSha,
    round,
    reviewer: reviewerName,
    reason: rubricGateFailure ? rubricGateFailure.status : verdict.verdict,
  });

  if (Array.isArray(verdict.rubric_scores) && verdict.rubric_scores.length > 0) {
    appendIterationScore(runRepoPath, data.run_id, {
      round,
      scores: verdict.rubric_scores.map((score) => ({
        factor: score.factor,
        target: score.target,
        observed: score.observed,
        met: score.status === "pass",
        status: score.status,
        ...(ALLOWED_SCORE_TIERS.has(score.tier) ? { tier: score.tier } : {}),
      })),
    });
  }
  if (divergencePayload.length > 0) {
    appendScoreDivergence(runRepoPath, data.run_id, {
      round,
      divergences: divergencePayload,
    });
  }

  result.appliedVerdict = rubricGateFailure ? "changes_requested" : verdict.verdict;
  result.nextState = updatedManifest.state;
  result.redispatchPath = redispatchPath;
  result.repeatedIssueCount = repeatedIssueCount;
  result.reviewGate = rubricGateFailure ? {
    layer: rubricGateFailure.layer,
    reason: rubricGateFailure.reason,
    recovery: rubricGateFailure.recovery,
    recoveryCommand: rubricGateFailure.recoveryCommand,
    rubricState: rubricGateFailure.rubricState,
    rubricStatus: rubricGateFailure.rubricStatus,
    status: rubricGateFailure.status,
  } : null;
  result.state = updatedManifest.state;
  result.verdictPath = verdictPath;

  printResult({ doneCriteriaPath, diffPath, jsonOut, manifestPath, originalState: data.state, prepareOnly, prNumber, promptPath, redispatchPath, result, updatedManifest, verdictPath });
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  applyVerdictToManifest,
  buildCommentBody,
  buildPrompt,
  buildRedispatchPrompt,
  buildReviewRunnerRubricGateFailure,
  detectChurnGrowth,
  formatIssueList,
  formatPriorVerdictSummary,
  formatScopeDrift,
  getGhLogin,
  loadRubricFromRunDir,
  parseRemoteHost,
  parseReviewVerdict,
  parseScoreLog,
  resolveIssueNumber,
  resolveRemoteHost,
  validateReviewVerdict,
  validateScopeDrift,
};
