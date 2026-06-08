const { buildExecutionEvidencePreflight } = require("./execution-evidence");
const { appendRunEvent, EVENTS } = require("../../../relay-dispatch/scripts/relay-events");

function maybeBlockForExecutionEvidencePreflight({
  data,
  jsonOut,
  result,
  reviewFile,
  runRepoPath,
  reviewedHeadSha,
  round,
  runDir,
  strict,
}) {
  result.executionEvidencePreflight = buildExecutionEvidencePreflight({
    runDir,
    reviewedHead: reviewedHeadSha,
    strict,
  });
  if (reviewFile || result.executionEvidencePreflight.status === "pass") {
    return false;
  }

  result.nextState = data.state;
  appendRunEvent(runRepoPath || data.paths?.repo_root || ".", data.run_id, {
    event: EVENTS.REVIEW_PREFLIGHT_FAILED,
    state_from: data.state,
    state_to: data.state,
    head_sha: reviewedHeadSha,
    round,
    reason: result.executionEvidencePreflight.reason,
    preflight_type: `execution_evidence_${result.executionEvidencePreflight.qualityExecutionStatus}`,
    failure_class: result.executionEvidencePreflight.qualityExecutionStatus,
    quality_execution_status: result.executionEvidencePreflight.qualityExecutionStatus,
    reviewer_rounds_avoided: 1,
    evidence_head_sha: result.executionEvidencePreflight.evidenceHeadSha,
    execution_evidence_path: result.executionEvidencePreflight.artifactPath,
  });
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Review preflight blocked round ${round}: ${result.executionEvidencePreflight.reason}`);
    console.log(`  Next action: ${result.executionEvidencePreflight.nextAction}`);
  }
  process.exitCode = 2;
  return true;
}

module.exports = {
  maybeBlockForExecutionEvidencePreflight,
};
