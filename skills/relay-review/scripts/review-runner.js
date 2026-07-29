#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { STATES } = require("../../relay-dispatch/scripts/manifest/lifecycle");
const { isHardenedReviewAssurance } = require("../../relay-dispatch/scripts/manifest/review-assurance");
const { ensureRunLayout, getRunDir } = require("../../relay-dispatch/scripts/manifest/paths");
const { buildReviewRunnerRubricGateFailure, loadRubricFromRunDir } = require("../../relay-dispatch/scripts/manifest/rubric");
const { git } = require("./review-runner/common");
const { getGhLogin, parseRemoteHost, resolveContext, resolveIssueNumber, resolveRemoteHost } = require("./review-runner/context");
const { buildPrompt, formatPriorVerdictSummary } = require("./review-runner/prompt");
const { parseReviewVerdict, validateReviewVerdict, validateScopeDrift } = require("./review-runner/verdict");
const { buildCommentBody, formatIssueList, formatScopeDrift, postComment } = require("./review-runner/comment");
const { applyQualityExecutionStatus, computeQualityExecutionStatus } = require("./review-runner/execution-evidence");
const { printFailureAndExit } = require("./review-runner/failure-output");
const { buildRedispatchPrompt, detectChurnGrowth } = require("./review-runner/redispatch");
const { applyVerdictToManifest } = require("./review-runner/manifest-apply");
const { enforceRoundCap } = require("./review-runner/round-cap");
const { passNextActionsFor, reviewPhaseFor, writeRoundArtifacts } = require("./review-runner/round-artifacts");
const { maybeBlockForBehindBasePreflight, maybeBlockForExecutionEvidencePreflight } = require("./review-runner/preflight");
const { preflightResolvedPrimaryReviewer } = require("./review-runner/entry-preflight");
const { buildPrimaryReviewerPreflight, loadReviewText, loadRunRoutePlan, resolveReviewerName, resolveReviewerScript } = require("./review-runner/reviewer-invoke");
const { maybeSwapReviewer } = require("./review-runner/reviewer-swap");
const { appendAdvisoryRunsForTrigger, resolveAdvisoryConfig } = require("./review-runner/advisory-orchestration");
const { settleAdvisoryGatesForRound } = require("./review-runner/advisory-gates");
const { printResult, printUsage } = require("./review-runner/output");
const { maybeWaitForChecks } = require("./review-runner/check-wait");
const { validateReviewerScoresForArtifact } = require("./review-runner/evaluation-channels");
const { finalizeRound } = require("./review-runner/finalize-round");
const { assertKnownReviewRunnerFlags, parseReviewRunnerCliArgs } = require("./review-runner/cli");
const { beginDetachSupervisorIfRequested, dispatchReviewEntry } = require("./review-runner/detach");
const { args, cliArgs, options } = parseReviewRunnerCliArgs(process.argv.slice(2));
if (require.main === module && (!args.length || cliArgs.hasFlag(["--help", "-h"]))) {
  printUsage();
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}
async function run() {
  assertKnownReviewRunnerFlags(args);
  const {
    advisoryGraceArg, advisoryProfileArg, advisoryReviewerArg, advisoryReviewerModel, allowBehindBase,
    advisoryTimeoutArg, branchArg, diffFile, doneCriteriaFile, independentReviewReason,
    jsonOut, manifestPathArg, manualReviewReason, noComment, prArg, prepareOnly, repoArg,
    repoPath, reviewFile, reviewerArg, reviewerModel, reviewerScriptArg, runIdArg, waitForChecksArg,
  } = options;
  if (manualReviewReason && !reviewFile) throw new Error("--manual-review-reason requires --review-file");
  const { branch, issueNumber, manifest, prNumber, reviewRepoPath, runRepoPath } = resolveContext(repoPath, repoArg, manifestPathArg, runIdArg, branchArg, prArg, doneCriteriaFile);
  const { body, manifestPath } = manifest;
  let { data } = manifest;
  data = maybeSwapReviewer(data, reviewerArg, body, manifestPath, runRepoPath, { independentReviewReason });

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
  const runRoutePlan = loadRunRoutePlan(runRepoPath, data.run_id).plan;
  const resolvedAdvisoryConfig = resolveAdvisoryConfig({
    advisoryGraceArg,
    advisoryProfileArg,
    advisoryReviewerArg,
    advisoryReviewerModel,
    advisoryTimeoutArg,
    data,
    routePlan: runRoutePlan,
  });
  const advisoryConfig = resolvedAdvisoryConfig;
  const hardenedAssurance = isHardenedReviewAssurance(data);

  let reviewedHeadSha = null;
  try {
    reviewedHeadSha = git(reviewRepoPath, "rev-parse", "HEAD").trim();
  } catch {}

  const reviewPhase = reviewPhaseFor(internalReview);
  const reviewBudget = enforceRoundCap({
    body,
    data,
    manifestPath,
    phase: reviewPhase,
    prNumber,
    reviewedHeadSha,
    round,
    runRepoPath,
  });

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

  const reviewerName = resolveReviewerName(data, reviewerArg, { routePlan: runRoutePlan });
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
    reviewAssurance: data.policy?.review_assurance || "standard",
    reviewBudget,
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
  let advisoryRuns = [], advisoryResults = [], gateResult = null;
  let primaryReviewerPreflight = null;

  if (prepareOnly) {
    printResult({ doneCriteriaPath, diffPath, jsonOut, manifestPath, originalState: data.state, prepareOnly, prNumber, promptPath, redispatchPath: null, result, updatedManifest: null, verdictPath: null });
    return;
  }
  if (maybeBlockForBehindBasePreflight({ allowBehindBase, data, jsonOut, result, reviewRepoPath, reviewedHeadSha, round, runRepoPath })) return;
  if (maybeBlockForExecutionEvidencePreflight({ data, jsonOut, result, reviewFile, runRepoPath, reviewedHeadSha, round, runDir, strict: hardenedAssurance })) return;
  if (hardenedAssurance && !(advisoryConfig.lanes || []).length) {
    throw new Error(
      "policy.review_assurance=hardened requires --advisory-reviewer <name>, route-plan advisory_review.reviewer, or manifest routing.selected.advisory_review.reviewer so the round produces advisory evidence. " +
      "Run with a configured advisory reviewer, configure routing, or lower the manifest policy before review."
    );
  }
  if (!reviewFile) {
    primaryReviewerPreflight = buildPrimaryReviewerPreflight({
      data,
      reviewerModel,
      reviewerName,
      reviewerScript,
      runRepoPath,
      routePlan: runRoutePlan,
    });
  }
  const advisoryStartOptions = {
    branch, config: advisoryConfig, data, diffText, doneCriteria, doneCriteriaSource,
    issueNumber, prNumber, reviewedHeadSha, reviewRepoPath, round, rubricLoad, runDir, runRepoPath,
  };
  if ((advisoryConfig.lanes || []).length) result.advisoryReviews = [];
  advisoryRuns = appendAdvisoryRunsForTrigger({ advisoryRuns, result, startOptions: advisoryStartOptions, trigger: "every_round" });
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
    routePlan: runRoutePlan,
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
  if (rubricLoad.state === "loaded") {
    validateReviewerScoresForArtifact(rubricLoad, verdict.rubric_scores);
  }
  const executionStatus = computeQualityExecutionStatus({
    runDir,
    reviewedHead: reviewedHeadSha,
    strict: hardenedAssurance,
    manifestData: data,
  });
  verdict = applyQualityExecutionStatus(verdict, executionStatus);
  const gateSettlement = await settleAdvisoryGatesForRound({
    advisoryConfig,
    advisoryRuns,
    currentState: data.state,
    executionStatus,
    hardenedAssurance,
    internalReview,
    laneDemotionCount: Number(data.review?.lane_demotions || 0),
    manualReviewReason,
    prSignalsPassBlockReason,
    result,
    reviewFile,
    startOptions: advisoryStartOptions,
    verdict,
  });
  ({ advisoryResults, advisoryRuns, gateResult, verdict } = gateSettlement);

  finalizeRound({
    advisoryConfig,
    advisoryResults,
    body,
    checkWait,
    churnGrowth,
    data,
    diffPath,
    doneCriteria,
    doneCriteriaPath,
    doneCriteriaSource,
    gateResult,
    hardenedAssurance,
    internalReview,
    jsonOut,
    manifestPath,
    manualReviewReason,
    noComment,
    prepareOnly,
    prNumber,
    promptPath,
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
