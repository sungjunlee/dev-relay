const LANE_DEMOTION_CAP = 2;

function buildAssuranceIssue(title, body) {
  return {
    title,
    body,
    file: "policy.review_assurance",
    line: 1,
    category: "quality",
    confidence: "high",
    severity: "high",
    confidence: "high",
    lineage: "new",
  };
}

function withAssuranceMetadata(verdict, metadata) {
  Object.defineProperty(verdict, "__reviewAssurance", {
    configurable: true,
    enumerable: false,
    value: metadata,
  });
  return verdict;
}

function getReviewAssuranceMetadata(verdict) {
  return verdict?.__reviewAssurance || null;
}

function buildLaneCapEscalationDecision(round, lineageSummary, metadata) {
  return {
    round,
    trigger: "lane_demotion_cap",
    factors: [],
    traces: [],
    lineage_summary: lineageSummary,
    decision: "escalate",
    reason: "lane_demotion_cap",
    lane_demotion_cap: metadata.laneDemotionCap,
    lane_demotion_count: metadata.laneDemotionCount,
  };
}

function failReviewAssurance(verdict, issue, metadata = {}) {
  const next = {
    ...verdict,
    verdict: "changes_requested",
    summary: `review-runner fail-closed hardened review assurance: ${issue.title}.`,
    next_action: "changes_requested",
    issues: [issue],
  };
  return withAssuranceMetadata(next, metadata);
}

function escalateReviewAssurance(verdict, issue, metadata = {}) {
  const next = {
    ...verdict,
    verdict: "escalated",
    summary: `review-runner escalated review assurance: ${issue.title}.`,
    next_action: "escalated",
    issues: [issue],
  };
  return withAssuranceMetadata(next, metadata);
}

function resultList(advisoryResult, advisoryResults) {
  if (Array.isArray(advisoryResults)) return advisoryResults.filter(Boolean);
  return advisoryResult ? [advisoryResult] : [];
}

function laneLabel(result) {
  const parts = [
    result?.reviewer || "unknown-reviewer",
    result?.profile ? `profile=${result.profile}` : null,
    result?.trigger ? `trigger=${result.trigger}` : null,
  ].filter(Boolean);
  return parts.join(" ");
}

function buildRequiredFindingsIssue(result, hardenedAssurance) {
  const count = Number(result?.required_count || 0);
  const title = hardenedAssurance
    ? "Hardened advisory review reported required findings"
    : "Gating advisory lane reported required findings";
  const artifact = result?.artifactPath ? ` Artifact: ${result.artifactPath}.` : "";
  return buildAssuranceIssue(
    title,
    `Advisory lane ${laneLabel(result)} reported ${count} required finding(s). Resolve them before merging.${artifact}`
  );
}

function applyLaneDrivenDemotion(verdict, issue, {
  capBody,
  laneDemotionCount = 0,
  reason,
}) {
  const nextCount = Number(laneDemotionCount || 0) + 1;
  if (Number(laneDemotionCount || 0) >= LANE_DEMOTION_CAP) {
    return escalateReviewAssurance(
      verdict,
      buildAssuranceIssue(
        "Review lane demotion cap reached",
        `${capBody || issue.body} Lane-driven demotion reason: ${issue.title}. Lane-driven demotion is capped at at most ${LANE_DEMOTION_CAP} time(s) per run. Owner decision required.`
      ),
      {
        laneCapEscalated: true,
        laneDemotion: false,
        laneDemotionCap: LANE_DEMOTION_CAP,
        laneDemotionCount,
        laneDemotionReason: reason,
        reason: "lane_demotion_cap",
      }
    );
  }
  return failReviewAssurance(verdict, issue, {
    laneDemotion: true,
    laneDemotionCap: LANE_DEMOTION_CAP,
    laneDemotionCount: nextCount,
    laneDemotionIncrement: 1,
    reason,
  });
}

function applyLaneRequiredFindingDemotion(verdict, result, {
  hardenedAssurance,
  laneDemotionCount = 0,
}) {
  const issue = buildRequiredFindingsIssue(result, hardenedAssurance);
  return applyLaneDrivenDemotion(verdict, issue, {
    capBody: `Advisory lane ${laneLabel(result)} would demote this pass because it reported required findings.`,
    laneDemotionCount,
    reason: "lane_required_findings",
  });
}

function applyReviewAssurancePolicy(verdict, {
  advisoryResult,
  advisoryResults,
  expectedAdvisoryCount = null,
  hardenedAssurance,
  laneDemotionCount = 0,
  manualReviewReason,
  reviewFile,
}) {
  if (verdict.verdict !== "pass") return verdict;

  if (hardenedAssurance && reviewFile && !String(manualReviewReason || "").trim()) {
    return failReviewAssurance(verdict, buildAssuranceIssue(
      "Manual review verdict requires an audit reason",
      "policy.review_assurance=hardened does not allow applying a passing --review-file verdict without --manual-review-reason."
    ));
  }

  const results = resultList(advisoryResult, advisoryResults);
  const requiredAdvisoryCount = Number.isFinite(expectedAdvisoryCount)
    ? Math.max(0, Number(expectedAdvisoryCount))
    : hardenedAssurance ? 1 : 0;

  if (hardenedAssurance && results.length < requiredAdvisoryCount) {
    const issue = buildAssuranceIssue(
      "Missing hardened advisory review",
      "policy.review_assurance=hardened requires an advisory review artifact for the reviewed round."
    );
    return applyLaneDrivenDemotion(verdict, issue, {
      capBody: "A required hardened advisory lane would demote this pass because its advisory evidence is missing.",
      laneDemotionCount,
      reason: "lane_missing_evidence",
    });
  }

  for (const result of results) {
    const effectiveGating = result?.gating === true || hardenedAssurance;
    if (!effectiveGating) continue;

    if (result.status !== "success") {
      if (!hardenedAssurance) continue;
      const issue = buildAssuranceIssue(
        "Hardened advisory review did not complete successfully",
        `Advisory lane ${laneLabel(result)} status was ${result.status}: ${result.failureReason || "no failure reason recorded"}.`
      );
      return applyLaneDrivenDemotion(verdict, issue, {
        capBody: `Advisory lane ${laneLabel(result)} would demote this pass because it did not complete successfully.`,
        laneDemotionCount,
        reason: "lane_run_failure",
      });
    }

    if (Number(result.required_count || 0) > 0) {
      return applyLaneRequiredFindingDemotion(verdict, result, {
        hardenedAssurance,
        laneDemotionCount,
      });
    }
  }

  return verdict;
}

module.exports = {
  LANE_DEMOTION_CAP,
  applyReviewAssurancePolicy,
  buildLaneCapEscalationDecision,
  getReviewAssuranceMetadata,
};
