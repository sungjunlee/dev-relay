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
const { applyQualityExecutionStatus, buildExecutionEvidenceFailureVerdict, buildMissingExecutionEvidenceVerdict, computeQualityExecutionStatus } = require("./review-runner/execution-evidence");
const { applyReviewAssurancePolicy } = require("./review-runner/assurance");
const { printFailureAndExit } = require("./review-runner/failure-output");
const { buildRedispatchPrompt, buildRubricGateRedispatchPrompt, computeFactorStatusFlips, computeRepeatedIssueCount, decideFlipFlopEscalation, detectChurnGrowth, summarizeLineage, toEscalatedVerdict } = require("./review-runner/redispatch");
const { buildConvergenceSummary, formatConvergenceMarkdown } = require("./review-runner/convergence");
const { applyVerdictToManifest } = require("./review-runner/manifest-apply");
const { enforceRoundCap } = require("./review-runner/round-cap");
const { passNextActionsFor, writeRoundArtifacts } = require("./review-runner/round-artifacts");
const { maybeBlockForExecutionEvidencePreflight } = require("./review-runner/preflight");
const { buildPrimaryReviewerPreflight, loadReviewText, loadRunRoutePlan, resolveReviewerName, resolveReviewerScript } = require("./review-runner/reviewer-invoke");
const { maybeSwapReviewer } = require("./review-runner/reviewer-swap");
const { resolveAdvisoryConfig, settleAdvisoryForVerdict, startConfiguredAdvisory } = require("./review-runner/advisory-orchestration");
const { printResult, printUsage } = require("./review-runner/output");
const { assertKnownReviewRunnerFlags, parseReviewRunnerCliArgs } = require("./review-runner/cli");
const { args, cliArgs, options } = parseReviewRunnerCliArgs(process.argv.slice(2));
if (require.main === module && (!args.length || cliArgs.hasFlag(["--help", "-h"]))) {
  printUsage();
  process.exit(cliArgs.hasFlag(["--help", "-h"]) ? 0 : 1);
}
async function run() {
  assertKnownReviewRunnerFlags(args);
  const {
    advisoryGraceArg, advisoryProfileArg, advisoryReviewerArg, advisoryReviewerModel,
    advisoryTimeoutArg, branchArg, diffFile, doneCriteriaFile, independentReviewReason,
    jsonOut, manifestPathArg, manualReviewReason, noComment, prArg, prepareOnly, repoArg,
    repoPath, reviewFile, reviewerArg, reviewerModel, reviewerScriptArg, runIdArg,
  } = options;
  if (manualReviewReason && !reviewFile) throw new Error("--manual-review-reason requires --review-file");

  const { branch, issueNumber, manifest, prNumber, reviewRepoPath, runRepoPath } = resolveContext(
    repoPath,
    repoArg,
    manifestPathArg,
    runIdArg,
    branchArg,
    prArg,
    doneCriteriaFile
  );
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
  let advisoryRun = null;
  let advisoryResult = null;
  let primaryReviewerPreflight = null;

  if (prepareOnly) {
    printResult({ doneCriteriaPath, diffPath, jsonOut, manifestPath, originalState: data.state, prepareOnly, prNumber, promptPath, redispatchPath: null, result, updatedManifest: null, verdictPath: null });
    return;
  }
  if (maybeBlockForExecutionEvidencePreflight({ data, jsonOut, result, reviewFile, runRepoPath, reviewedHeadSha, round, runDir, strict: hardenedAssurance })) return;
  if (hardenedAssurance && !advisoryConfig.reviewer) {
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
  ({ advisoryRun, resultAdvisory: result.advisoryReview } = startConfiguredAdvisory({
    branch, config: advisoryConfig, data, diffText, doneCriteria, doneCriteriaSource,
    issueNumber, prNumber, reviewedHeadSha, reviewRepoPath, round, rubricLoad, runDir, runRepoPath,
  }));
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
  const executionStatus = computeQualityExecutionStatus({
    runDir,
    reviewedHead: reviewedHeadSha,
    strict: hardenedAssurance,
  });
  verdict = applyQualityExecutionStatus(verdict, executionStatus);
  ({ advisoryResult, resultAdvisory: result.advisoryReview } = await settleAdvisoryForVerdict({
    advisoryRun,
    config: advisoryConfig,
    currentState: data.state,
    hardenedAssurance,
    verdict,
  }));
  verdict = applyReviewAssurancePolicy(verdict, {
    advisoryResult,
    hardenedAssurance,
    manualReviewReason,
    reviewFile,
  });
  if (verdict.verdict === "pass" && executionStatus.status !== "pass") {
    verdict = executionStatus.status === "missing"
      ? buildMissingExecutionEvidenceVerdict(verdict)
      : buildExecutionEvidenceFailureVerdict(verdict);
  }
  validateReviewVerdict(verdict, {
    passNextActions: passNextActionsFor(internalReview),
    disallowPassReason: prSignalsPassBlockReason,
  });

  const repeatedIssueCount = verdict.verdict === "changes_requested" ? computeRepeatedIssueCount(runDir, round, verdict.issues) : 0;
  const lineageSummary = summarizeLineage(verdict.issues);
  let escalationDecision = { round, trigger: "none", factors: [], traces: [], lineage_summary: lineageSummary, decision: "continue", reason: "no_trigger" };
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
  const convergenceSummary = buildConvergenceSummary({ runDir, round, verdict, factorFlips, repeatedIssueCount });
  result.convergenceSummary = convergenceSummary;
  if (convergenceSummary) writeText(path.join(runDir, `review-round-${round}-convergence.md`), `${formatConvergenceMarkdown(convergenceSummary)}\n`);

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
      ? buildRubricGateRedispatchPrompt(rubricGateFailure, doneCriteria, doneCriteriaSource, convergenceSummary)
      : buildRedispatchPrompt(verdict, doneCriteria, runDir, round, churnGrowth, doneCriteriaSource, reviewedHeadSha, convergenceSummary);
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
    },
  };
  updatedManifest = applyReviewerIdentity(updatedManifest, noComment || internalReview, runRepoPath);
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
    lineage_summary: escalationDecision.lineage_summary || lineageSummary,
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

  result.appliedVerdict = rubricGateFailure ? "changes_requested" : verdict.verdict;
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
  Promise.resolve(run()).catch((error) => {
    printFailureAndExit(error, { jsonOut: cliArgs.hasFlag("--json") });
  });
}
module.exports = { applyVerdictToManifest, buildCommentBody, buildPrompt, buildRedispatchPrompt, buildReviewRunnerRubricGateFailure, detectChurnGrowth, formatIssueList, formatPriorVerdictSummary, formatScopeDrift, getGhLogin, loadRubricFromRunDir, parseRemoteHost, parseReviewVerdict, parseScoreLog, resolveIssueNumber, resolveRemoteHost, validateReviewVerdict, validateScopeDrift };
