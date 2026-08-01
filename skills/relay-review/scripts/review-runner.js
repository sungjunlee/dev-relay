#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { STATES } = require("../../relay-dispatch/scripts/manifest/lifecycle");
const { ensureRunLayout, getRunDir } = require("../../relay-dispatch/scripts/manifest/paths");
const { buildReviewRunnerRubricGateFailure, loadRubricFromRunDir } = require("../../relay-dispatch/scripts/manifest/rubric");
const { git } = require("./review-runner/common");
const { getGhLogin, parseRemoteHost, resolveContext, resolveIssueNumber, resolveRemoteHost } = require("./review-runner/context");
const { buildPrompt, formatPriorVerdictSummary } = require("./review-runner/prompt");
const { parseReviewVerdict, validateReviewVerdict, validateScopeDrift } = require("./review-runner/verdict");
const { buildCommentBody, formatIssueList, formatScopeDrift, postComment } = require("./review-runner/comment");
const {
  applyQualityExecutionStatus,
  buildExecutionEvidenceFailureVerdict,
  buildMissingExecutionEvidenceVerdict,
  computeQualityExecutionStatus,
} = require("./review-runner/execution-evidence");
const { printFailureAndExit } = require("./review-runner/failure-output");
const { buildRedispatchPrompt, detectChurnGrowth } = require("./review-runner/redispatch");
const { applyVerdictToManifest } = require("./review-runner/manifest-apply");
const { passNextActionsFor, reviewPhaseFor, writeRoundArtifacts } = require("./review-runner/round-artifacts");
const { maybeBlockForBehindBasePreflight, maybeBlockForExecutionEvidencePreflight } = require("./review-runner/preflight");
const { preflightResolvedPrimaryReviewer } = require("./review-runner/entry-preflight");
const { buildPrimaryReviewerPreflight, loadReviewText, resolveReviewerName, resolveReviewerScript } = require("./review-runner/reviewer-invoke");
const { printResult, printUsage } = require("./review-runner/output");
const { maybeWaitForChecks } = require("./review-runner/check-wait");
const { finalizeRound } = require("./review-runner/finalize-round");
const { CLI_ARG_OPTIONS, assertKnownReviewRunnerFlags, parseReviewRunnerCliArgs } = require("./review-runner/cli");
const { beginDetachSupervisorIfRequested, dispatchReviewEntry } = require("./review-runner/detach");
const { args, cliArgs, options } = parseReviewRunnerCliArgs(process.argv.slice(2));
if (require.main === module && (!args.length || cliArgs.hasFlag(["--help", "-h"]))) {
  printUsage(CLI_ARG_OPTIONS);
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}
async function run() {
  assertKnownReviewRunnerFlags(args);
  const {
    allowBehindBase, branchArg, diffFile, doneCriteriaFile,
    jsonOut, manifestPathArg, manualReviewReason, noComment, prArg, prepareOnly, repoArg,
    repoPath, reviewFile, reviewerArg, reviewerModel, reviewerScriptArg, runIdArg, waitForChecksArg,
  } = options;
  if (manualReviewReason && !reviewFile) throw new Error("--manual-review-reason requires --review-file");
  const { branch, issueNumber, manifest, prNumber, reviewRepoPath, runRepoPath } = resolveContext(repoPath, repoArg, manifestPathArg, runIdArg, branchArg, prArg, doneCriteriaFile);
  const { body, manifestPath } = manifest;
  const { data } = manifest;

  const internalReview = data.state === STATES.INTERNAL_REVIEW_PENDING;
  if (![STATES.INTERNAL_REVIEW_PENDING, STATES.REVIEW_PENDING].includes(data.state)) {
    throw new Error(`Review runner requires state=internal_review_pending or review_pending, got '${data.state}'`);
  }
  if (data.next_action === "recover_commit_before_internal_review") throw new Error("Review runner requires recover-commit before internal review because the retained worktree has uncommitted reviewable changes.");
  if (!fs.existsSync(reviewRepoPath)) {
    throw new Error(`Retained review checkout does not exist: ${reviewRepoPath}`);
  }

  const round = Number(data.review?.rounds || 0) + 1;
  const runDir = getRunDir(runRepoPath, data.run_id);
  ensureRunLayout(runRepoPath, data.run_id);
  // Detached child only (no-op in the foreground): write the run-dir lease + receipt
  // before the long-running reviewer invocation so the parent can return and the round
  // survives the invoker's death.
  beginDetachSupervisorIfRequested({ runRepoPath, runId: data.run_id, round, runDir, manifestPath });
  let reviewedHeadSha = null;
  try {
    reviewedHeadSha = git(reviewRepoPath, "rev-parse", "HEAD").trim();
  } catch {}

  const reviewPhase = reviewPhaseFor(internalReview);
  const checkWait = maybeWaitForChecks({ internalReview, prepareOnly, prNumber, round, runDir, runRepoPath, waitForChecksArg });

  const {
    diffPath, diffText, doneCriteria, doneCriteriaPath,
    doneCriteriaSource, prBodyPath, prBodySnapshot, prReviewSignals,
    promptPath, rubricLoad,
  } = writeRoundArtifacts({
    branch,
    data,
    diffFile,
    doneCriteriaFile,
    internalReview,
    issueNumber,
    prNumber,
    reviewRepoPath,
    round,
    runDir,
    runRepoPath,
  });

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
    reviewPhase,
    prReviewSignals,
    manualReviewReason: manualReviewReason || null,
    reviewer: reviewerName,
    reviewerScript,
    round,
    rubricLoaded: rubricLoad.state,
    rubricStatus: rubricLoad.status,
    rubricWarning: rubricLoad.warning || null,
    runId: data.run_id,
    state: data.state, convergenceSummary: null, verdictPath: null,
  };
  if (checkWait) result.checkWait = checkWait.summary;
  let primaryReviewerPreflight = null;

  if (prepareOnly) {
    printResult({ doneCriteriaPath, diffPath, jsonOut, manifestPath, originalState: data.state, prepareOnly, prNumber, promptPath, redispatchPath: null, result, updatedManifest: null, verdictPath: null });
    return;
  }
  if (maybeBlockForBehindBasePreflight({ allowBehindBase, data, jsonOut, result, reviewRepoPath, reviewedHeadSha, round, runRepoPath })) return;
  if (maybeBlockForExecutionEvidencePreflight({ data, jsonOut, result, reviewFile, runRepoPath, reviewedHeadSha, round, runDir, strict: false })) return;
  if (!reviewFile) {
    primaryReviewerPreflight = buildPrimaryReviewerPreflight({
      data,
      reviewerModel,
      reviewerName,
      reviewerScript,
      runRepoPath,
    });
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
    reviewerPreflight: primaryReviewerPreflight,
  });
  result.rawResponsePath = rawResponsePath;
  const prSignalsPassBlockReason = !internalReview && prReviewSignals?.status === "failed"
    ? `GitHub PR signals failed to load: ${prReviewSignals.reason || "unknown error"}`
    : null;

  let verdict = parseReviewVerdict(reviewText, {
    adapter: reviewerName,
    phase: "primary_review",
    passNextActions: passNextActionsFor(internalReview),
    requireExecutionStatus: false,
    disallowPassReason: prSignalsPassBlockReason,
  });
  const executionStatus = computeQualityExecutionStatus({
    runDir,
    reviewedHead: reviewedHeadSha,
    strict: false,
    manifestData: data,
  });
  verdict = applyQualityExecutionStatus(verdict, executionStatus);
  if (verdict.verdict === "pass" && executionStatus.status !== "pass") {
    verdict = executionStatus.status === "missing"
      ? buildMissingExecutionEvidenceVerdict(verdict)
      : buildExecutionEvidenceFailureVerdict(verdict);
  }
  validateReviewVerdict(verdict, {
    passNextActions: passNextActionsFor(internalReview),
    disallowPassReason: prSignalsPassBlockReason,
  });

  finalizeRound({
    body,
    checkWait,
    churnGrowth,
    data,
    diffPath,
    doneCriteria,
    doneCriteriaPath,
    doneCriteriaSource,
    internalReview,
    jsonOut,
    manifestPath,
    manualReviewReason,
    noComment,
    prepareOnly,
    prNumber,
    promptPath,
    primaryReviewerVerdict: verdict,
    result,
    reviewedHeadSha,
    reviewerName,
    round,
    rubricLoad,
    runDir,
    runRepoPath,
    verdict,
  });
}

if (require.main === module) {
  dispatchReviewEntry({ options, args, entryPath: __filename, jsonOut: cliArgs.hasFlag("--json"), preflight: () => { assertKnownReviewRunnerFlags(args); preflightResolvedPrimaryReviewer(options); }, run, printFailureAndExit });
}
module.exports = { applyVerdictToManifest, buildCommentBody, buildPrompt, buildRedispatchPrompt, buildReviewRunnerRubricGateFailure, detectChurnGrowth, formatIssueList, formatPriorVerdictSummary, formatScopeDrift, getGhLogin, loadRubricFromRunDir, parseRemoteHost, parseReviewVerdict, resolveIssueNumber, resolveRemoteHost, validateReviewVerdict, validateScopeDrift };
