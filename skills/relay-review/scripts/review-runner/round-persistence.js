const {
  readManifest,
  withManifestTransaction,
  writeManifestUnlocked,
} = require("../../../relay-dispatch/scripts/manifest/store");
const {
  appendIterationScore,
  appendRunEvent,
  EVENTS,
} = require("../../../relay-dispatch/scripts/relay-events");
const { applyReviewerIdentity } = require("./context");
const { buildCommentBody, postComment } = require("./comment");
const { toIterationScoreEventEntry } = require("./score-utils");
const { applyVerdictToManifest } = require("./manifest-apply");
const { applyPendingChecksMarker } = require("./check-wait");
const {
  buildAdvisoryRoundEvidence,
  mergeAdvisoryRoundEvidence,
} = require("../advisory-review-schema");

function advisoryOutcomesForRound(advisoryConfig, advisoryResults) {
  const lanes = advisoryConfig?.lanes || [];
  const results = advisoryResults || [];
  return lanes.map((lane, index) => {
    const laneIndex = Number(lane.index || index + 1);
    const matching = results.find((result) => (
      Number(result?.lane_index || result?.laneIndex || 0) === laneIndex
      && (result?.trigger || "every_round") === (lane.trigger || "every_round")
    ));
    return matching || {
      advisory_count: 0,
      duplicate_low_confidence_count: 0,
      failureReason: null,
      gating: lane.gating === true,
      lane_index: laneIndex,
      model: lane.model || null,
      profile: lane.profile || "blindspot",
      required_count: 0,
      reviewer: lane.reviewer,
      status: "not_run",
      trigger: lane.trigger || "every_round",
    };
  });
}

function persistManifestWithAdvisoryEvidence(manifestPath, updatedManifest, body, advisoryEvidence) {
  let persistedManifest = updatedManifest;
  withManifestTransaction(manifestPath, () => {
    const current = readManifest(manifestPath);
    persistedManifest = {
      ...updatedManifest,
      review: {
        ...(updatedManifest.review || {}),
        last_advisory: mergeAdvisoryRoundEvidence(
          current.data.review?.last_advisory || null,
          advisoryEvidence,
        ),
      },
    };
    writeManifestUnlocked(manifestPath, persistedManifest, body);
  });
  return persistedManifest;
}

function persistManifestAndEvents(context, analysis, artifacts) {
  const {
    advisoryConfig,
    advisoryResults,
    body,
    checkWait,
    data,
    manifestPath,
    manualReviewReason,
    noComment,
    prNumber,
    result,
    reviewedHeadSha,
    reviewerName,
    round,
    runRepoPath,
    internalReview,
  } = context;
  const {
    assuranceMetadata,
    confidenceDowngrade,
    escalationDecision,
    lineageSummary,
    repeatedIssueCount,
    verdict,
  } = analysis;
  const {
    appliedVerdict,
    confidenceDowngradeAppliedAsFinalPass,
    rubricGateFailure,
  } = artifacts;

  const advisoryEvidence = buildAdvisoryRoundEvidence({
    configuredCount: advisoryConfig?.lanes?.length || 0,
    headSha: reviewedHeadSha,
    outcomes: advisoryOutcomesForRound(advisoryConfig, advisoryResults),
    round,
  });
  result.advisorySummary = advisoryEvidence;

  const commentBody = buildCommentBody(verdict, round, {
    advisorySummary: advisoryEvidence,
    gateFailure: rubricGateFailure,
    warnings: result.advisoryWarnings || [],
  });
  if (!noComment && !internalReview) {
    postComment(runRepoPath, prNumber, commentBody);
    result.commentPosted = true;
  }

  let updatedManifest = applyVerdictToManifest(
    data,
    verdict,
    round,
    prNumber,
    reviewedHeadSha,
    repeatedIssueCount,
    {
      rubricGateFailure,
      escalationDecision,
      lineageSummary: escalationDecision.lineage_summary || lineageSummary,
    }
  );
  updatedManifest = {
    ...updatedManifest,
    review: {
      ...(updatedManifest.review || {}),
      last_reviewer: reviewerName,
      ...(manualReviewReason ? { manual_review_reason: manualReviewReason } : {}),
      ...(
        data.review?.lane_demotions !== undefined
        || assuranceMetadata?.laneDemotionIncrement
          ? {
            lane_demotions: Number(data.review?.lane_demotions || 0)
              + Number(assuranceMetadata?.laneDemotionIncrement || 0),
          }
          : {}
      ),
    },
  };
  updatedManifest.review = applyPendingChecksMarker(updatedManifest.review, {
    appliedVerdict,
    checkWait,
    reviewedHeadSha,
    round,
  });
  updatedManifest = applyReviewerIdentity(
    updatedManifest,
    noComment || internalReview,
    runRepoPath
  );
  updatedManifest = persistManifestWithAdvisoryEvidence(
    manifestPath,
    updatedManifest,
    body,
    advisoryEvidence,
  );
  appendRunEvent(runRepoPath, data.run_id, {
    event: EVENTS.ESCALATION_DECISION,
    state_from: data.state,
    state_to: updatedManifest.state,
    head_sha: reviewedHeadSha,
    ...escalationDecision,
  });

  const reportedConfidenceDowngrade = (
    confidenceDowngrade.applied
    && !rubricGateFailure
  )
    ? {
      originalVerdict: "changes_requested",
      appliedVerdict,
      lowConfidenceCount: confidenceDowngrade.lowConfidenceCount,
    }
    : null;
  const reviewApplyReason = confidenceDowngradeAppliedAsFinalPass
    ? "pass"
    : rubricGateFailure
      ? rubricGateFailure.status
      : verdict.verdict;
  appendRunEvent(runRepoPath, data.run_id, {
    event: EVENTS.REVIEW_APPLY,
    state_from: data.state,
    state_to: updatedManifest.state,
    head_sha: reviewedHeadSha,
    round,
    reviewer: reviewerName,
    reason: reviewApplyReason,
    lineage_summary: escalationDecision.lineage_summary || lineageSummary,
    ...(reportedConfidenceDowngrade
      ? {
        confidence_downgrade: true,
        low_confidence_count: reportedConfidenceDowngrade.lowConfidenceCount,
      }
      : {}),
    ...(
      assuranceMetadata?.laneDemotion
      || assuranceMetadata?.laneCapEscalated
        ? {
          lane_demotion_cap: assuranceMetadata.laneDemotionCap,
          lane_demotion_count: assuranceMetadata.laneDemotionCount,
        }
        : {}
    ),
  });
  if (Array.isArray(verdict.rubric_scores) && verdict.rubric_scores.length > 0) {
    appendIterationScore(runRepoPath, data.run_id, {
      round,
      scores: verdict.rubric_scores.map(toIterationScoreEventEntry),
    });
  }
  return { reportedConfidenceDowngrade, updatedManifest };
}

module.exports = { persistManifestAndEvents };
