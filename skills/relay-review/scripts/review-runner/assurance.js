function buildAssuranceIssue(title, body) {
  return {
    title,
    body,
    file: "policy.review_assurance",
    line: 1,
    category: "quality",
    severity: "high",
    lineage: "new",
  };
}

function failReviewAssurance(verdict, issue) {
  return {
    ...verdict,
    verdict: "changes_requested",
    summary: `review-runner fail-closed hardened review assurance: ${issue.title}.`,
    next_action: "changes_requested",
    issues: [issue],
  };
}

function applyReviewAssurancePolicy(verdict, {
  advisoryResult,
  hardenedAssurance,
  manualReviewReason,
  reviewFile,
}) {
  if (!hardenedAssurance || verdict.verdict !== "pass") return verdict;

  if (reviewFile && !String(manualReviewReason || "").trim()) {
    return failReviewAssurance(verdict, buildAssuranceIssue(
      "Manual review verdict requires an audit reason",
      "policy.review_assurance=hardened does not allow applying a passing --review-file verdict without --manual-review-reason."
    ));
  }

  if (!advisoryResult) {
    return failReviewAssurance(verdict, buildAssuranceIssue(
      "Missing hardened advisory review",
      "policy.review_assurance=hardened requires an advisory review artifact for the reviewed round."
    ));
  }

  if (advisoryResult.status !== "success") {
    return failReviewAssurance(verdict, buildAssuranceIssue(
      "Hardened advisory review did not complete successfully",
      `Advisory review status was ${advisoryResult.status}: ${advisoryResult.failureReason || "no failure reason recorded"}.`
    ));
  }

  if (Number(advisoryResult.required_count || 0) > 0) {
    return failReviewAssurance(verdict, buildAssuranceIssue(
      "Hardened advisory review reported required findings",
      `Advisory review reported ${advisoryResult.required_count} required finding(s). Resolve them before merging.`
    ));
  }

  return verdict;
}

module.exports = { applyReviewAssurancePolicy };
