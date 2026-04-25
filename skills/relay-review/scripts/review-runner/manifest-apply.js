const { STATES, updateManifestState } = require("../../../relay-dispatch/scripts/manifest/lifecycle");

function refreshManifestWithoutStateChange(data, nextAction) {
  return {
    ...data,
    next_action: nextAction,
    timestamps: {
      ...(data.timestamps || {}),
      updated_at: new Date().toISOString(),
    },
  };
}

function buildReviewStatusFields(verdict) {
  const reviewStatus = {};
  if (typeof verdict.contract_status === "string") {
    reviewStatus.last_contract_status = verdict.contract_status;
  }
  if (typeof verdict.quality_review_status === "string") {
    reviewStatus.last_quality_review_status = verdict.quality_review_status;
  }
  if (typeof verdict.quality_execution_status === "string") {
    reviewStatus.last_quality_execution_status = verdict.quality_execution_status;
  }
  if (typeof verdict.quality_execution_reason === "string" || verdict.quality_execution_reason === null) {
    reviewStatus.last_quality_execution_reason = verdict.quality_execution_reason;
  }
  return reviewStatus;
}

function applyVerdictToManifest(data, verdict, round, prNumber, reviewedHeadSha, repeatedIssueCount, options = {}) {
  const rubricGateFailure = options.rubricGateFailure || null;
  const escalationDecision = options.escalationDecision || null;
  let nextState;
  let nextAction;
  let latestVerdict;

  if (verdict.verdict === "pass") {
    if (rubricGateFailure) {
      nextState = STATES.CHANGES_REQUESTED;
      nextAction = "repair_rubric_and_redispatch";
      latestVerdict = rubricGateFailure.status;
    } else {
      nextState = STATES.READY_TO_MERGE;
      nextAction = "await_explicit_merge";
      latestVerdict = "lgtm";
    }
  } else if (verdict.verdict === "changes_requested") {
    nextState = STATES.CHANGES_REQUESTED;
    nextAction = "re_dispatch_requested_changes";
    latestVerdict = "changes_requested";
  } else {
    nextState = STATES.ESCALATED;
    nextAction = "inspect_review_failure";
    latestVerdict = "escalated";
  }

  const updated = nextState === data.state
    ? refreshManifestWithoutStateChange(data, nextAction)
    : updateManifestState(data, nextState, nextAction);
  return {
    ...updated,
    git: {
      ...(updated.git || {}),
      ...(prNumber ? { pr_number: prNumber } : {}),
      head_sha: reviewedHeadSha || updated.git?.head_sha || null,
    },
    review: {
      ...(updated.review || {}),
      rounds: round,
      latest_verdict: latestVerdict,
      repeated_issue_count: verdict.verdict === "changes_requested" ? repeatedIssueCount : 0,
      last_reviewed_sha: reviewedHeadSha || null,
      ...buildReviewStatusFields(verdict),
      ...(escalationDecision ? { last_escalation_decision: escalationDecision } : {}),
      last_gate: rubricGateFailure ? {
        status: rubricGateFailure.status,
        layer: rubricGateFailure.layer,
        rubric_state: rubricGateFailure.rubricState,
        rubric_status: rubricGateFailure.rubricStatus,
        recovery_command: rubricGateFailure.recoveryCommand,
        recovery: rubricGateFailure.recovery,
        reason: rubricGateFailure.reason,
      } : null,
    },
  };
}

function applyPolicyViolationToManifest(data, round, prNumber, reviewedHeadSha, reason, options = {}) {
  const updated = updateManifestState(data, STATES.ESCALATED, "inspect_review_failure");
  return {
    ...updated,
    git: {
      ...(updated.git || {}),
      ...(prNumber ? { pr_number: prNumber } : {}),
      head_sha: reviewedHeadSha || updated.git?.head_sha || null,
    },
    review: {
      ...(updated.review || {}),
      rounds: round,
      latest_verdict: reason || "policy_violation",
      repeated_issue_count: 0,
      last_reviewed_sha: reviewedHeadSha || null,
      ...(options.escalationDecision ? { last_escalation_decision: options.escalationDecision } : {}),
    },
  };
}

module.exports = {
  applyPolicyViolationToManifest,
  applyVerdictToManifest,
  buildReviewStatusFields,
  refreshManifestWithoutStateChange,
};
