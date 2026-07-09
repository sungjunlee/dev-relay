const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { buildArtifactTimingFields } = require("../../../relay-dispatch/scripts/advisory-timing");
const {
  ADAPTER_PHASES,
  getAgentAdapterDescriptor,
} = require("../../../relay-dispatch/scripts/agent-adapters");
const {
  assertPolicyRepresentable,
  buildAgentPolicyAudit,
} = require("../../../relay-dispatch/scripts/agent-adapters/policy");
const { resolveExecutorDefaultModel } = require("../../../relay-dispatch/scripts/executor-model-config");
const { hashFileSha256 } = require("../../../relay-dispatch/scripts/execution-evidence");
const { appendRunEvent, appendUnregisteredRouteUsedEvent, EVENTS, readRunEvents } = require("../../../relay-dispatch/scripts/relay-events");
const { parseAdvisoryReview, validateAdvisoryProfile } = require("../advisory-review-schema");
const { captureGitStatus, resolveReviewerScript } = require("./reviewer-invoke");
const { writeText } = require("./common");

const DEFAULT_ADVISORY_TIMEOUT_SECONDS = 900;
const DEFAULT_ADVISORY_GRACE_SECONDS = 10;

function parsePositiveSeconds(value, fallback = DEFAULT_ADVISORY_TIMEOUT_SECONDS) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--advisory-timeout must be a positive integer number of seconds");
  }
  return parsed;
}

function parseNonNegativeSeconds(value, fallback = DEFAULT_ADVISORY_GRACE_SECONDS) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--advisory-grace must be a non-negative number of seconds");
  }
  return parsed;
}

function resolveAdvisoryModel(data, reviewerName, explicitModel, { repoRoot = null } = {}) {
  if (explicitModel) return explicitModel;
  const hinted = data?.model_hints?.advisory_review;
  if (typeof hinted === "string" && hinted.trim()) return hinted.trim();
  return resolveExecutorDefaultModel(reviewerName, { relayHome: process.env.RELAY_HOME, repoRoot });
}

function createAdvisoryWorktree(reviewRepoPath, runDir, reviewerName) {
  const parent = path.join(runDir, "advisory-worktrees");
  fs.mkdirSync(parent, { recursive: true });
  const worktreePath = path.join(parent, `${reviewerName}-${process.pid}-${Date.now()}`);
  execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
    cwd: reviewRepoPath,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return worktreePath;
}

function cleanupAdvisoryWorktree(baseRepoPath, worktreePath) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: baseRepoPath,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {}
}

function advisoryFileBase(runDir, round, reviewerName) {
  return path.join(runDir, `review-round-${round}-advisory-${reviewerName}`);
}

function advisoryPaths(runDir, round, reviewerName) {
  const base = advisoryFileBase(runDir, round, reviewerName);
  return {
    decisionPath: `${base}-decision.json`,
    promptPath: `${base}-prompt.md`,
    requestPath: `${base}-request.json`,
    resultPath: `${base}-result.json`,
  };
}

function buildAdvisoryReviewerPolicy(reviewerName) {
  let descriptor;
  try {
    descriptor = getAgentAdapterDescriptor(reviewerName);
  } catch {
    return null;
  }
  return assertPolicyRepresentable(buildAgentPolicyAudit({
    descriptor,
    phase: ADAPTER_PHASES.ADVISORY_REVIEW,
    requested: {
      sandbox: "read-only",
      networkAccess: "ambient",
      readOnly: true,
    },
  }));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function readJsonIfExistsBefore(filePath, latestMtimeMs = null) {
  const result = readJsonIfExists(filePath);
  if (!result || !Number.isFinite(latestMtimeMs)) return result;
  // The worker rewrites the result file after appending the ADVISORY_REVIEW
  // event, so file mtime lies about when the result actually arrived. Trust
  // the content stamp written at first completion; mtime is only a fallback
  // for artifacts produced before completed_at existed.
  const completedAtMs = Date.parse(result.completed_at || "");
  if (Number.isFinite(completedAtMs)) {
    return completedAtMs <= latestMtimeMs ? result : null;
  }
  const stat = fs.statSync(filePath);
  return stat.mtimeMs <= latestMtimeMs ? result : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startAdvisoryReview({
  artifactReviewerName = null,
  gating = false,
  headSha,
  laneIndex = 1,
  profile,
  promptText,
  policyDecision = null,
  modelResolution = null,
  reviewerModel,
  reviewerName,
  reviewerPolicy = null,
  reviewerScript = null,
  reviewRepoPath,
  round,
  runDir,
  runId,
  runRepoPath,
  source = null,
  state,
  timeoutSeconds,
  trigger = "every_round",
}) {
  const artifactName = artifactReviewerName || reviewerName;
  const paths = advisoryPaths(runDir, round, artifactName);
  const promptPath = paths.promptPath;
  const effectiveReviewerScript = reviewerScript || resolveReviewerScript(reviewerName, null, { phase: ADAPTER_PHASES.ADVISORY_REVIEW });
  writeText(promptPath, `${promptText}\n`);
  const startedAt = Date.now();
  const effectiveReviewerPolicy = reviewerPolicy || buildAdvisoryReviewerPolicy(reviewerName);
  const request = {
    artifactReviewerName: artifactName,
    decisionPath: paths.decisionPath,
    gating: gating === true,
    headSha,
    laneIndex,
    profile,
    promptPath,
    requestPath: paths.requestPath,
    resultPath: paths.resultPath,
    reviewerModel,
    reviewerName,
    reviewerPolicy: effectiveReviewerPolicy,
    policyDecision,
    modelResolution,
    reviewerScript: effectiveReviewerScript,
    reviewRepoPath,
    round,
    runDir,
    runId,
    runRepoPath,
    source,
    startedAt,
    state,
    timeoutSeconds: parsePositiveSeconds(timeoutSeconds),
    trigger,
  };
  writeJson(paths.requestPath, request);

  const workerPath = path.join(__dirname, "..", "advisory-worker.js");
  const child = require("child_process").spawn(process.execPath, [workerPath, paths.requestPath], {
    cwd: reviewRepoPath,
    detached: true,
    env: { ...process.env },
    stdio: "ignore",
  });
  child.unref();

  return {
    ...request,
    child,
  };
}

function writeRawResponse(runDir, round, reviewerName, stdout, stderr) {
  const rawResponsePath = path.join(runDir, `review-round-${round}-advisory-${reviewerName}-raw-response.txt`);
  const text = stderr.trim()
    ? [stdout.trim(), "", "stderr:", stderr.trim()].filter(Boolean).join("\n")
    : stdout.trim();
  writeText(rawResponsePath, `${text}\n`);
  return rawResponsePath;
}

function buildDeferredResult(advisoryRun, { criticalPathWaitMs = 0, consumedByPhase = "metrics" } = {}) {
  return {
    artifactHash: null,
    artifactPath: null,
    advisory_count: 0,
    consumedByPhase,
    criticalPathWaitMs,
    duplicate_low_confidence_count: 0,
    elapsedMs: Date.now() - advisoryRun.startedAt,
    failureReason: null,
    gating: advisoryRun.gating === true,
    lane_index: advisoryRun.laneIndex || 1,
    model: advisoryRun.reviewerModel || null,
    phaseDecisionWaited: criticalPathWaitMs > 0,
    profile: advisoryRun.profile,
    rawResponsePath: null,
    required_count: 0,
    reviewer: advisoryRun.reviewerName,
    source: advisoryRun.source || null,
    status: "deferred",
    trigger: advisoryRun.trigger || "every_round",
  };
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function advisorySuccessBindingFailure(advisoryRun, result) {
  if (!result.artifactPath || !result.artifactHash) {
    return "successful advisory result is missing artifact path or hash provenance";
  }
  const artifactHash = hashFileSha256(result.artifactPath);
  if (artifactHash !== result.artifactHash) {
    return "successful advisory result artifact hash does not match the current artifact";
  }

  let events;
  try {
    events = readRunEvents(advisoryRun.runRepoPath, advisoryRun.runId);
  } catch (error) {
    return `successful advisory result cannot be bound to events.jsonl: ${error.message}`;
  }

  const hasBoundEvent = events.some((event) => (
    event.event === EVENTS.ADVISORY_REVIEW &&
    event.status === "success" &&
    Number(event.round || 0) === Number(advisoryRun.round || 0) &&
    event.head_sha === advisoryRun.headSha &&
    event.reviewer === advisoryRun.reviewerName &&
    samePath(event.artifact_path, result.artifactPath) &&
    event.advisory_artifact_hash === result.artifactHash &&
    Number(event.required_count || 0) === Number(result.required_count || 0) &&
    Number(event.advisory_count || 0) === Number(result.advisory_count || 0) &&
    Number(event.duplicate_low_confidence_count || 0) === Number(result.duplicate_low_confidence_count || 0)
  ));
  return hasBoundEvent
    ? null
    : "successful advisory result is not bound to a successful advisory_review event for the reviewed HEAD";
}

function buildUnboundSuccessResult(advisoryRun, result, failureReason, {
  consumedByPhase = "review",
  criticalPathWaitMs = 0,
} = {}) {
  return {
    ...result,
    consumedByPhase,
    criticalPathWaitMs,
    elapsedMs: Date.now() - advisoryRun.startedAt,
    failureReason,
    phaseDecisionWaited: criticalPathWaitMs > 0,
    status: "failed",
  };
}

async function finishAdvisoryReview({
  advisoryRun,
  criticalPathWaitMs = 0,
  requireEventBoundSuccess = false,
  resultDeadlineMs = null,
  waitMs,
  consumedByPhase = "review",
}) {
  const deadline = Date.now() + Math.max(0, Number(waitMs || 0));
  let unboundSuccess = null;
  while (Date.now() <= deadline) {
    const result = readJsonIfExistsBefore(advisoryRun.resultPath, resultDeadlineMs);
    if (result) {
      if (!requireEventBoundSuccess || result.status !== "success") return result;
      const failureReason = advisorySuccessBindingFailure(advisoryRun, result);
      if (!failureReason) return result;
      unboundSuccess = { result, failureReason };
    }
    if (Date.now() === deadline) break;
    await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  const result = readJsonIfExistsBefore(advisoryRun.resultPath, resultDeadlineMs);
  if (result) {
    if (!requireEventBoundSuccess || result.status !== "success") return result;
    const failureReason = advisorySuccessBindingFailure(advisoryRun, result);
    if (!failureReason) return result;
    return buildUnboundSuccessResult(advisoryRun, result, failureReason, { criticalPathWaitMs, consumedByPhase });
  }
  if (unboundSuccess) {
    const failureReason = advisorySuccessBindingFailure(advisoryRun, unboundSuccess.result);
    if (!failureReason) return unboundSuccess.result;
    return buildUnboundSuccessResult(advisoryRun, unboundSuccess.result, failureReason, { criticalPathWaitMs, consumedByPhase });
  }
  return buildDeferredResult(advisoryRun, { criticalPathWaitMs, consumedByPhase });
}

function writeAdvisoryDecision(advisoryRun, {
  consumedByPhase,
  criticalPathWaitMs = 0,
  frontierStepReplaced = false,
  nextState,
  phaseDecisionWaited = false,
} = {}) {
  writeJson(advisoryRun.decisionPath, {
    consumed_by_phase: consumedByPhase,
    critical_path_wait_ms: Math.max(0, Math.round(Number(criticalPathWaitMs || 0))),
    frontier_step_replaced: frontierStepReplaced === true,
    next_state: nextState || null,
    phase_decision_waited: phaseDecisionWaited === true,
    recorded_at: new Date().toISOString(),
  });
}

function readDecisionTiming(request) {
  const decision = readJsonIfExists(request.decisionPath);
  if (!decision) {
    return buildArtifactTimingFields({
      elapsedMs: Date.now() - request.startedAt,
      criticalPathWaitMs: 0,
      consumedByPhase: "review",
      phaseDecisionWaited: false,
      frontierStepReplaced: false,
    });
  }
  return buildArtifactTimingFields({
    elapsedMs: Date.now() - request.startedAt,
    criticalPathWaitMs: decision.critical_path_wait_ms || 0,
    consumedByPhase: decision.consumed_by_phase || "metrics",
    phaseDecisionWaited: decision.phase_decision_waited === true,
    frontierStepReplaced: decision.frontier_step_replaced === true,
  });
}

function waitForDecisionTiming(request, waitMs = 300) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(request.decisionPath)) break;
    sleepSync(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return readDecisionTiming(request);
}

function executeAdvisoryRequest(request) {
  let artifactPath = null;
  let failureReason = null;
  let rawResponsePath = null;
  let status = "success";
  let counts = { required_count: 0, advisory_count: 0, duplicate_low_confidence_count: 0 };
  let advisoryRepoPath = null;

  try {
    const timeoutMs = parsePositiveSeconds(request.timeoutSeconds) * 1000;
    advisoryRepoPath = createAdvisoryWorktree(request.reviewRepoPath, request.runDir, request.artifactReviewerName || request.reviewerName);
    const statusBefore = captureGitStatus(advisoryRepoPath);
    const execArgs = [
      request.reviewerScript,
      "--repo", advisoryRepoPath,
      "--prompt-file", request.promptPath,
      "--json",
      "--phase", ADAPTER_PHASES.ADVISORY_REVIEW,
    ];
    if (request.reviewerModel) execArgs.push("--model", request.reviewerModel);

    let stdout = "";
    let stderr = "";
    let outcome = { code: 0 };
    try {
      stdout = execFileSync(process.execPath, execArgs, {
        cwd: advisoryRepoPath,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        stdio: "pipe",
        timeout: timeoutMs,
      }).trim();
    } catch (error) {
      stdout = String(error.stdout || "").trim();
      stderr = String(error.stderr || "").trim();
      outcome = {
        code: Number.isInteger(error.status) ? error.status : null,
        error,
        signal: error.signal,
        timeout: error.code === "ETIMEDOUT" || error.signal === "SIGTERM",
      };
    }

    rawResponsePath = writeRawResponse(request.runDir, request.round, request.artifactReviewerName || request.reviewerName, stdout, stderr);
    const statusAfter = captureGitStatus(advisoryRepoPath);
    if (statusBefore !== statusAfter) {
      status = "policy_violation";
      failureReason = "advisory_reviewer_modified_worktree";
      artifactPath = path.join(request.runDir, `review-round-${request.round}-advisory-${request.artifactReviewerName || request.reviewerName}-policy-violation.txt`);
      writeText(artifactPath, [
        "Advisory reviewer write policy violation detected.",
        "",
        `Reviewer: ${request.reviewerName}`,
        `Script: ${request.reviewerScript}`,
        "",
        "Status before advisory reviewer:",
        statusBefore || "(clean)",
        "",
        "Status after advisory reviewer:",
        statusAfter || "(clean)",
      ].join("\n") + "\n");
    } else if (outcome.timeout) {
      status = "timeout";
      failureReason = (
        `${request.reviewerName} reviewer advisory_review timed out after ${timeoutMs / 1000}s; ` +
        `model=${request.reviewerModel || "default"}; raw_response=${rawResponsePath}`
      );
    } else if (outcome.error || outcome.code !== 0) {
      status = "failed";
      failureReason = outcome.error ? outcome.error.message : `advisory reviewer exited with code ${outcome.code}`;
    } else {
      const parsed = parseAdvisoryReview(stdout, {
        adapter: request.reviewerName,
        phase: "advisory_review",
        profile: request.profile,
      });
      artifactPath = path.join(request.runDir, `review-round-${request.round}-advisory-${request.artifactReviewerName || request.reviewerName}.json`);
      writeText(artifactPath, `${JSON.stringify(parsed, null, 2)}\n`);
      counts = {
        required_count: parsed.required_findings.length,
        advisory_count: parsed.advisory_findings.length,
        duplicate_low_confidence_count: parsed.duplicate_or_low_confidence.length,
      };
    }
  } catch (error) {
    status = "failed";
    failureReason = error.message;
  }

  const artifactHash = artifactPath ? hashFileSha256(artifactPath) : null;
  const result = {
    artifactHash,
    artifactPath,
    completed_at: new Date().toISOString(),
    failureReason,
    gating: request.gating === true,
    lane_index: request.laneIndex || 1,
    model: request.reviewerModel || null,
    profile: request.profile,
    rawResponsePath,
    reviewer: request.reviewerName,
    source: request.source || null,
    status,
    trigger: request.trigger || "every_round",
    ...counts,
  };
  writeJson(request.resultPath, result);
  const timingFields = waitForDecisionTiming(request);
  Object.assign(result, {
    consumedByPhase: timingFields.consumed_by_phase,
    criticalPathWaitMs: timingFields.critical_path_wait_ms,
    elapsedMs: timingFields.elapsed_ms,
    phaseDecisionWaited: timingFields.phase_decision_waited,
  });
  try {
    appendRunEvent(request.runRepoPath, request.runId, {
      event: EVENTS.ADVISORY_REVIEW,
      state_from: request.state,
      state_to: request.state,
      head_sha: request.headSha,
      round: request.round,
      lane_index: request.laneIndex || 1,
      reviewer: request.reviewerName,
      model: request.reviewerModel,
      reviewer_policy: request.reviewerPolicy,
      policy_decision: request.policyDecision,
      profile: request.profile,
      trigger: request.trigger || "every_round",
      gating: request.gating === true,
      status,
      artifact_path: artifactPath,
      advisory_artifact_hash: artifactHash,
      raw_response_path: rawResponsePath,
      failure_reason: failureReason,
      ...counts,
      ...timingFields,
    });
    appendUnregisteredRouteUsedEvent(request.runRepoPath, request.runId, {
      state: request.state,
      headSha: request.headSha,
      round: request.round,
      policyDecision: request.policyDecision,
      modelResolution: request.modelResolution || null,
    });
  } catch (error) {
    status = "failed";
    result.status = "failed";
    result.failureReason = `advisory event write failed: ${error.message}`;
  } finally {
    if (advisoryRepoPath) {
      cleanupAdvisoryWorktree(request.reviewRepoPath, advisoryRepoPath);
    }
  }
  writeJson(request.resultPath, result);
  return result;
}

module.exports = {
  DEFAULT_ADVISORY_GRACE_SECONDS,
  executeAdvisoryRequest,
  finishAdvisoryReview,
  buildAdvisoryReviewerPolicy,
  parseNonNegativeSeconds,
  parsePositiveSeconds,
  resolveAdvisoryModel,
  startAdvisoryReview,
  validateAdvisoryProfile,
  writeAdvisoryDecision,
};
