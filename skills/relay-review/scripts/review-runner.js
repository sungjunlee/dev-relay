#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { STATES } = require("../../relay-dispatch/scripts/manifest/lifecycle");
const { isHardenedReviewAssurance } = require("../../relay-dispatch/scripts/manifest/review-assurance");
const { ensureRunLayout, getRunDir } = require("../../relay-dispatch/scripts/manifest/paths");
const { buildReviewRunnerRubricGateFailure, loadRubricFromRunDir } = require("../../relay-dispatch/scripts/manifest/rubric");
const { writeManifest } = require("../../relay-dispatch/scripts/manifest/store");
const { appendIterationScore, appendRunEvent, appendScoreDivergence, EVENTS } = require("../../relay-dispatch/scripts/relay-events");
const { git, writeText } = require("./review-runner/common");
const { applyReviewerIdentity, getGhLogin, parseRemoteHost, resolveContext, resolveIssueNumber, resolveRemoteHost } = require("./review-runner/context");
const { buildPrompt, formatPriorVerdictSummary } = require("./review-runner/prompt");
const { parseReviewVerdict, validateReviewVerdict, validateScopeDrift } = require("./review-runner/verdict");
const { buildCommentBody, formatIssueList, formatScopeDrift, postComment } = require("./review-runner/comment");
const { buildScoreDivergenceAnalysis, loadPrBody, parseScoreLog, toIterationScoreEventEntry } = require("./review-runner/divergence");
const { applyQualityExecutionStatus, computeQualityExecutionStatus } = require("./review-runner/execution-evidence");
const { buildLaneCapEscalationDecision, getReviewAssuranceMetadata } = require("./review-runner/assurance");
const { printFailureAndExit } = require("./review-runner/failure-output");
const { buildRedispatchPrompt, buildRubricGateRedispatchPrompt, computeFactorStatusFlips, computeRepeatedIssueCount, decideFlipFlopEscalation, detectChurnGrowth, summarizeLineage, toEscalatedVerdict } = require("./review-runner/redispatch");
const { buildConvergenceSummary, formatConvergenceMarkdown } = require("./review-runner/convergence");
const { applyVerdictToManifest } = require("./review-runner/manifest-apply");
const { enforceRoundCap } = require("./review-runner/round-cap");
const { passNextActionsFor, writeRoundArtifacts } = require("./review-runner/round-artifacts");
const { maybeBlockForBehindBasePreflight, maybeBlockForExecutionEvidencePreflight } = require("./review-runner/preflight");
const { preflightResolvedPrimaryReviewer } = require("./review-runner/entry-preflight");
const { buildPrimaryReviewerPreflight, loadReviewText, loadRunRoutePlan, resolveReviewerName, resolveReviewerScript } = require("./review-runner/reviewer-invoke");
const { maybeSwapReviewer } = require("./review-runner/reviewer-swap");
const { appendAdvisoryRunsForTrigger, resolveAdvisoryConfig } = require("./review-runner/advisory-orchestration");
const { settleAdvisoryGatesForRound } = require("./review-runner/advisory-gates");
const { printResult, printUsage } = require("./review-runner/output");
const { applyPendingChecksMarker, maybeWaitForChecks } = require("./review-runner/check-wait");
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

  enforceRoundCap({ body, data, manifestPath, prNumber, reviewedHeadSha, round, runRepoPath });

  const checkWait = maybeWaitForChecks({ internalReview, prepareOnly, prNumber, round, runDir, runRepoPath, waitForChecksArg });

  const {
    diffPath,
    diffText,
    doneCriteria,
    doneCriteriaPath,
    doneCriteriaSource,
    prBodyPath,
    prBodySnapshot,
    prReviewSignals,
    promptPath,
    reviewPhase,
    rubricLoad,
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
  let advisoryRuns = [], advisoryResult = null, advisoryResults = [], gateResult = null, primaryReviewerPreflight = null;

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
  if (rubricLoad.state === "loaded" && (!Array.isArray(verdict.rubric_scores) || verdict.rubric_scores.length === 0)) {
    throw new Error(
      "Review verdict has empty rubric_scores but a rubric was provided. " +
      "The reviewer must score every rubric factor."
    );
  }
  const executionStatus = computeQualityExecutionStatus({ runDir, reviewedHead: reviewedHeadSha, strict: hardenedAssurance });
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
  ({ advisoryResult, advisoryResults, advisoryRuns, gateResult, verdict } = gateSettlement);

  const confidenceDowngrade = gateResult.confidenceDowngrade;
  const assuranceMetadata = getReviewAssuranceMetadata(verdict);
  if (assuranceMetadata) result.reviewAssuranceDecision = assuranceMetadata;
  const confidenceDowngradeApplied = confidenceDowngrade.applied && gateResult.passEquivalentVerdict.verdict === "pass";
  let analysisVerdict = confidenceDowngradeApplied ? gateResult.passEquivalentVerdict : verdict;
  const blockingChangesRequested = verdict.verdict === "changes_requested" && !confidenceDowngradeApplied;
  const repeatedIssueCount = blockingChangesRequested ? computeRepeatedIssueCount(runDir, round, analysisVerdict.issues) : 0;
  const lineageSummary = summarizeLineage(analysisVerdict.issues);
  let escalationDecision = { round, trigger: "none", factors: [], traces: [], lineage_summary: lineageSummary, decision: "continue", reason: "no_trigger" };
  if (assuranceMetadata?.laneCapEscalated) {
    escalationDecision = buildLaneCapEscalationDecision(round, lineageSummary, assuranceMetadata);
  }
  if (blockingChangesRequested && repeatedIssueCount >= 3) {
    verdict = toEscalatedVerdict(
      verdict,
      `Repeated identical review issues hit ${repeatedIssueCount} consecutive rounds.`
    );
    escalationDecision = { ...escalationDecision, trigger: "repeated_issues", decision: "escalate", reason: "repeated_issues" };
    analysisVerdict = verdict;
  }
  const factorFlips = computeFactorStatusFlips(runDir, round, analysisVerdict);
  if (factorFlips.length && escalationDecision.trigger === "none") {
    escalationDecision = { round, trigger: "flip_flop", ...decideFlipFlopEscalation({ verdict: analysisVerdict, factorFlips, repeatedIssueCount }) };
  }
  if (escalationDecision.decision === "escalate" && escalationDecision.trigger === "flip_flop") {
    verdict = toEscalatedVerdict(
      verdict,
      factorFlips.map(({ factor, trace }) => `Rubric factor '${factor}' status flipped across 3 rounds (trace: ${trace.join("→")}). Owner decision required — reviewer cannot converge autonomously.`).join("; ")
    );
    analysisVerdict = verdict;
  }
  const convergenceSummary = buildConvergenceSummary({ runDir, round, verdict: analysisVerdict, factorFlips, repeatedIssueCount });
  result.convergenceSummary = convergenceSummary;
  if (convergenceSummary) writeText(path.join(runDir, `review-round-${round}-convergence.md`), `${formatConvergenceMarkdown(convergenceSummary)}\n`);

  const rubricGateRedispatchPath = path.join(runDir, `review-round-${round}-redispatch.md`);
  const rubricGateFailure = verdict.verdict === "pass" || confidenceDowngradeApplied
    ? buildReviewRunnerRubricGateFailure(data.run_id, rubricGateRedispatchPath, rubricLoad)
    : null;
  const confidenceDowngradeAppliedAsFinalPass = confidenceDowngradeApplied && !rubricGateFailure;
  const verdictPath = path.join(runDir, `review-round-${round}-verdict.json`);
  const appliedVerdict = rubricGateFailure ? "changes_requested" : confidenceDowngradeAppliedAsFinalPass ? "pass" : verdict.verdict;
  const verdictRecord = rubricGateFailure
    ? {
      ...verdict,
      applied_verdict: appliedVerdict,
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
    : { ...verdict, applied_verdict: appliedVerdict };
  writeText(verdictPath, `${JSON.stringify(verdictRecord, null, 2)}\n`);

  let redispatchPath = null;
  if ((verdict.verdict === "changes_requested" && !confidenceDowngradeAppliedAsFinalPass) || rubricGateFailure) {
    redispatchPath = rubricGateFailure
      ? rubricGateRedispatchPath
      : path.join(runDir, `review-round-${round}-redispatch.md`);
    const redispatchPrompt = rubricGateFailure
      ? buildRubricGateRedispatchPrompt(rubricGateFailure, doneCriteria, doneCriteriaSource, convergenceSummary)
      : buildRedispatchPrompt(verdict, doneCriteria, runDir, round, churnGrowth, doneCriteriaSource, reviewedHeadSha, convergenceSummary, { advisoryResults, assuranceMetadata, hardenedAssurance });
    writeText(redispatchPath, `${redispatchPrompt}\n`);
  }

  const { eventPayload: divergencePayload, warnings: divergenceWarnings } = buildScoreDivergenceAnalysis(
    loadPrBody(runRepoPath, prNumber),
    verdict.rubric_scores
  );
  const commentBody = buildCommentBody(verdict, round, { gateFailure: rubricGateFailure, warnings: [...divergenceWarnings, ...(result.advisoryWarnings || [])] });
  if (!noComment && !internalReview) {
    postComment(runRepoPath, prNumber, commentBody);
    result.commentPosted = true;
  }

  let updatedManifest = applyVerdictToManifest(data, verdict, round, prNumber, reviewedHeadSha, repeatedIssueCount, { rubricGateFailure, escalationDecision, lineageSummary: escalationDecision.lineage_summary || lineageSummary });
  updatedManifest = {
    ...updatedManifest,
    review: {
      ...(updatedManifest.review || {}),
      last_reviewer: reviewerName,
      ...(manualReviewReason ? { manual_review_reason: manualReviewReason } : {}),
      ...(data.review?.lane_demotions !== undefined || assuranceMetadata?.laneDemotionIncrement
        ? { lane_demotions: Number(data.review?.lane_demotions || 0) + Number(assuranceMetadata?.laneDemotionIncrement || 0) }
        : {}),
    },
  };
  updatedManifest.review = applyPendingChecksMarker(updatedManifest.review, { appliedVerdict, checkWait, reviewedHeadSha, round });
  updatedManifest = applyReviewerIdentity(updatedManifest, noComment || internalReview, runRepoPath);
  writeManifest(manifestPath, updatedManifest, body);
  appendRunEvent(runRepoPath, data.run_id, { event: EVENTS.ESCALATION_DECISION, state_from: data.state, state_to: updatedManifest.state, head_sha: reviewedHeadSha, ...escalationDecision });
  const reportedConfidenceDowngrade = confidenceDowngrade.applied && !rubricGateFailure
    ? {
      originalVerdict: "changes_requested",
      appliedVerdict,
      lowConfidenceCount: confidenceDowngrade.lowConfidenceCount,
    }
    : null;
  const reviewApplyReason = confidenceDowngradeAppliedAsFinalPass ? "pass" : rubricGateFailure ? rubricGateFailure.status : verdict.verdict;
  appendRunEvent(runRepoPath, data.run_id, {
    event: EVENTS.REVIEW_APPLY,
    state_from: data.state,
    state_to: updatedManifest.state,
    head_sha: reviewedHeadSha,
    round,
    reviewer: reviewerName,
    reason: reviewApplyReason,
    lineage_summary: escalationDecision.lineage_summary || lineageSummary,
    ...(reportedConfidenceDowngrade ? {
      confidence_downgrade: true,
      low_confidence_count: reportedConfidenceDowngrade.lowConfidenceCount,
    } : {}),
    ...(assuranceMetadata?.laneDemotion || assuranceMetadata?.laneCapEscalated ? { lane_demotion_cap: assuranceMetadata.laneDemotionCap, lane_demotion_count: assuranceMetadata.laneDemotionCount } : {}),
  });

  if (Array.isArray(verdict.rubric_scores) && verdict.rubric_scores.length > 0) {
    appendIterationScore(runRepoPath, data.run_id, {
      round,
      scores: verdict.rubric_scores.map(toIterationScoreEventEntry),
    });
  }
  if (divergencePayload.length > 0) {
    appendScoreDivergence(runRepoPath, data.run_id, {
      round,
      divergences: divergencePayload,
    });
  }

  result.appliedVerdict = appliedVerdict;
  result.confidenceDowngrade = reportedConfidenceDowngrade;
  result.nextState = updatedManifest.state;
  result.redispatchPath = redispatchPath;
  result.repeatedIssueCount = repeatedIssueCount;
  result.lineageSummary = escalationDecision.lineage_summary || lineageSummary;
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
  dispatchReviewEntry({ options, args, entryPath: __filename, jsonOut: cliArgs.hasFlag("--json"), preflight: () => { assertKnownReviewRunnerFlags(args); preflightResolvedPrimaryReviewer(options); }, run, printFailureAndExit });
}
module.exports = { applyVerdictToManifest, buildCommentBody, buildPrompt, buildRedispatchPrompt, buildReviewRunnerRubricGateFailure, detectChurnGrowth, formatIssueList, formatPriorVerdictSummary, formatScopeDrift, getGhLogin, loadRubricFromRunDir, parseRemoteHost, parseReviewVerdict, parseScoreLog, resolveIssueNumber, resolveRemoteHost, validateReviewVerdict, validateScopeDrift };
