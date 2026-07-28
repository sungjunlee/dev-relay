const { buildExecutionEvidencePreflight } = require("./execution-evidence");
const { appendRunEvent, EVENTS } = require("../../../relay-dispatch/scripts/relay-events");
const { git } = require("./common");

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function buildBehindBaseRecoveryCommand(runId, baseBranch, repoRoot) {
  return (
    `node skills/relay-dispatch/scripts/rebrand-evidence.js --repo ${shellQuote(repoRoot)} ` +
    `--run-id ${runId} --rebase-onto-base --reason "rebase onto origin/${baseBranch} after base advance"`
  );
}

function buildBehindBasePreflight({ data, reviewRepoPath, reviewedHeadSha, runRepoPath }) {
  const baseBranch = data?.git?.base_branch || "main";
  const candidates = [`origin/${baseBranch}`, baseBranch];
  let base = null;
  for (const candidate of candidates) {
    try {
      git(reviewRepoPath, "merge-base", reviewedHeadSha, candidate);
      base = candidate;
      break;
    } catch {}
  }
  if (!base) {
    return { status: "not_available", base: null, behindCount: 0 };
  }

  const behindCount = Number(git(reviewRepoPath, "rev-list", "--count", `${reviewedHeadSha}..${base}`).trim());
  const blocked = behindCount > 0;
  const repoRoot = runRepoPath || data?.paths?.repo_root || null;
  return {
    status: blocked ? "blocked" : "pass",
    base,
    behindCount,
    reason: blocked
      ? `branch is ${behindCount} ${behindCount === 1 ? "commit" : "commits"} behind ${base}; rebase and re-run`
      : null,
    nextAction: blocked ? "rebase_and_rerun" : null,
    recoveryCommand: blocked && data?.run_id && repoRoot
      ? buildBehindBaseRecoveryCommand(data.run_id, baseBranch, repoRoot)
      : null,
  };
}

function maybeBlockForBehindBasePreflight({
  allowBehindBase,
  data,
  jsonOut,
  result,
  reviewRepoPath,
  reviewedHeadSha,
  round,
  runRepoPath,
}) {
  result.behindBasePreflight = buildBehindBasePreflight({ data, reviewRepoPath, reviewedHeadSha, runRepoPath });
  const preflight = result.behindBasePreflight;
  if (preflight.status !== "blocked") return false;

  if (allowBehindBase) {
    preflight.status = "overridden";
    console.error(`Warning: ${preflight.reason}; proceeding because --allow-behind-base was provided.`);
    return false;
  }

  result.nextState = data.state;
  appendRunEvent(runRepoPath || data.paths?.repo_root || ".", data.run_id, {
    event: EVENTS.REVIEW_PREFLIGHT_FAILED,
    state_from: data.state,
    state_to: data.state,
    head_sha: reviewedHeadSha,
    round,
    reason: preflight.reason,
    preflight_type: "behind_base",
    failure_class: "behind_base",
    reviewer_rounds_avoided: 1,
    next_action: preflight.nextAction,
  });
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Review preflight blocked round ${round}: ${preflight.reason}`);
    console.log(`  Next action: ${preflight.nextAction}`);
    if (preflight.recoveryCommand) {
      console.log(`  Recovery command: ${preflight.recoveryCommand}`);
    }
  }
  process.exitCode = 2;
  return true;
}

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
    manifestData: data,
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
    next_action: result.executionEvidencePreflight.nextAction,
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
  buildBehindBasePreflight,
  buildBehindBaseRecoveryCommand,
  maybeBlockForBehindBasePreflight,
  maybeBlockForExecutionEvidencePreflight,
};
