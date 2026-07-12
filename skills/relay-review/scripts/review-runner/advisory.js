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
const { writeAdvisoryLaneLease } = require("../../../relay-dispatch/scripts/run-runtime-state");
const { parseAdvisoryReview, validateAdvisoryProfile } = require("../advisory-review-schema");
const { captureGitStatus, resolveReviewerScript } = require("./reviewer-invoke");
const { writeText } = require("./common");

const DEFAULT_ADVISORY_TIMEOUT_SECONDS = 900;
const DEFAULT_ADVISORY_GRACE_SECONDS = 10;
/** Floor for a second advisory attempt when the adapter is not cline. */
const MIN_ADVISORY_RETRY_TIMEOUT_SECONDS = 1;
/**
 * Cline's adapter refuses parent budgets below 120s (see invoke-reviewer-cline.js).
 * A retry with less remaining budget cannot succeed, so skip it.
 */
const CLINE_MIN_ADVISORY_RETRY_TIMEOUT_SECONDS = 120;
/** Stable adapter-side signal: output obtained, no advisory candidate validated. */
const ADAPTER_PARSE_FAILURE_SIGNAL_RE =
  /failed to parse any of \d+ advisory candidate/i;

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
  // detached: true → child is its own process-group leader (pgid == pid).
  // Persist a lane lease distinct from the round lease (lease.json / #951).
  if (Number.isInteger(child.pid) && child.pid > 0) {
    writeAdvisoryLaneLease(runDir, {
      pid: child.pid,
      pgid: child.pid,
      round,
      reviewer: artifactName,
    });
  }

  return {
    ...request,
    child,
  };
}

function writeRawResponse(runDir, round, reviewerName, stdout, stderr, { attempt = null } = {}) {
  const suffix = Number.isInteger(attempt) && attempt > 0
    ? `-raw-response-attempt-${attempt}.txt`
    : "-raw-response.txt";
  const rawResponsePath = path.join(runDir, `review-round-${round}-advisory-${reviewerName}${suffix}`);
  const text = stderr.trim()
    ? [stdout.trim(), "", "stderr:", stderr.trim()].filter(Boolean).join("\n")
    : stdout.trim();
  writeText(rawResponsePath, `${text}\n`);
  return rawResponsePath;
}

function promoteRawResponseToAttempt(rawResponsePath, attemptNumber) {
  const attemptPath = rawResponsePath.replace(
    /-raw-response\.txt$/,
    `-raw-response-attempt-${attemptNumber}.txt`
  );
  if (attemptPath === rawResponsePath) {
    throw new Error(`cannot promote raw response path to attempt artifact: ${rawResponsePath}`);
  }
  fs.renameSync(rawResponsePath, attemptPath);
  return attemptPath;
}

function minAdvisoryRetryTimeoutSeconds(reviewerName) {
  return reviewerName === "cline"
    ? CLINE_MIN_ADVISORY_RETRY_TIMEOUT_SECONDS
    : MIN_ADVISORY_RETRY_TIMEOUT_SECONDS;
}

function isAdapterParseFailureSignal({ stdout, stderr, outcome }) {
  const hasOutput = Boolean(String(stdout || "").trim() || String(stderr || "").trim());
  if (!hasOutput) return false;
  const haystack = [stderr, stdout, outcome?.error?.message].filter(Boolean).join("\n");
  return ADAPTER_PARSE_FAILURE_SIGNAL_RE.test(haystack);
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

/**
 * Build the adapter child env for an advisory lane spawn.
 * For cline, the lane budget always wins over any inherited
 * RELAY_CLINE_REVIEW_TIMEOUT so one number governs both the parent
 * execFileSync kill and the adapter's internal --timeout derivation.
 * Direct (non-advisory) cline invocations keep the env contract unchanged.
 * Callers may pass timeoutSeconds to reflect a remaining retry budget.
 */
function buildAdvisoryAdapterEnv(request, { timeoutSeconds } = {}) {
  const env = { ...process.env };
  if (request.reviewerName === "cline") {
    const seconds = parsePositiveSeconds(
      timeoutSeconds !== undefined ? timeoutSeconds : request.timeoutSeconds
    );
    env.RELAY_CLINE_REVIEW_TIMEOUT = `${seconds}s`;
  }
  return env;
}

function executeAdvisoryRequest(request) {
  let artifactPath = null;
  let failureReason = null;
  let rawResponsePath = null;
  let rawResponsePaths = [];
  let attemptCount = 0;
  let status = "success";
  let counts = { required_count: 0, advisory_count: 0, duplicate_low_confidence_count: 0 };
  let advisoryRepoPath = null;

  try {
    const advisoryProfile = (
      typeof request.profile === "string" && request.profile.trim()
        ? validateAdvisoryProfile(request.profile)
        : null
    );
    const laneBudgetMs = parsePositiveSeconds(request.timeoutSeconds) * 1000;
    const laneStartedAt = Date.now();
    const artifactName = request.artifactReviewerName || request.reviewerName;
    advisoryRepoPath = createAdvisoryWorktree(request.reviewRepoPath, request.runDir, artifactName);
    const statusBefore = captureGitStatus(advisoryRepoPath);
    const execArgs = [
      request.reviewerScript,
      "--repo", advisoryRepoPath,
      "--prompt-file", request.promptPath,
      "--json",
      "--phase", ADAPTER_PHASES.ADVISORY_REVIEW,
    ];
    if (request.reviewerModel) execArgs.push("--model", request.reviewerModel);
    if (advisoryProfile) execArgs.push("--profile", advisoryProfile);

    function runAdapterAttempt(timeoutMs) {
      attemptCount += 1;
      let stdout = "";
      let stderr = "";
      let outcome = { code: 0 };
      try {
        const execOptions = {
          cwd: advisoryRepoPath,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          stdio: "pipe",
          timeout: timeoutMs,
        };
        if (request.reviewerName === "cline") {
          execOptions.env = buildAdvisoryAdapterEnv(request, {
            timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
          });
        }
        stdout = execFileSync(process.execPath, execArgs, execOptions).trim();
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
      const attemptRawPath = writeRawResponse(
        request.runDir,
        request.round,
        artifactName,
        stdout,
        stderr
      );
      rawResponsePaths.push(attemptRawPath);
      rawResponsePath = attemptRawPath;
      return { stdout, stderr, outcome, rawResponsePath: attemptRawPath };
    }

    function applyPolicyViolation(statusAfter) {
      status = "policy_violation";
      failureReason = "advisory_reviewer_modified_worktree";
      artifactPath = path.join(
        request.runDir,
        `review-round-${request.round}-advisory-${artifactName}-policy-violation.txt`
      );
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
    }

    function applySuccess(parsed) {
      status = "success";
      failureReason = null;
      artifactPath = path.join(
        request.runDir,
        `review-round-${request.round}-advisory-${artifactName}.json`
      );
      writeText(artifactPath, `${JSON.stringify(parsed, null, 2)}\n`);
      counts = {
        required_count: parsed.required_findings.length,
        advisory_count: parsed.advisory_findings.length,
        duplicate_low_confidence_count: parsed.duplicate_or_low_confidence.length,
      };
    }

    /**
     * Classify one adapter attempt.
     * Returns { kind: "success"|"policy_violation"|"timeout"|"failed"|"parse_failure", ... }.
     * parse_failure is the only retryable class (model-output variance).
     */
    function classifyAttempt({ stdout, stderr, outcome, rawResponsePath }) {
      const statusAfter = captureGitStatus(advisoryRepoPath);
      if (statusBefore !== statusAfter) {
        return { kind: "policy_violation", statusAfter };
      }
      if (outcome.timeout) {
        return {
          kind: "timeout",
          failureReason: (
            `${request.reviewerName} reviewer advisory_review timed out after ${laneBudgetMs / 1000}s; ` +
            `model=${request.reviewerModel || "default"}; raw_response=${rawResponsePath}`
          ),
        };
      }
      if (outcome.error || outcome.code !== 0) {
        const execFailureReason = outcome.error
          ? outcome.error.message
          : `advisory reviewer exited with code ${outcome.code}`;
        if (isAdapterParseFailureSignal({ stdout, stderr, outcome })) {
          return { kind: "parse_failure", failureReason: execFailureReason };
        }
        return { kind: "failed", failureReason: execFailureReason };
      }
      try {
        const parsed = parseAdvisoryReview(stdout, {
          adapter: request.reviewerName,
          phase: "advisory_review",
          profile: request.profile,
        });
        return { kind: "success", parsed };
      } catch (error) {
        // Exit 0 with no stdout is closer to no-output than variance — do not retry.
        if (!String(stdout || "").trim()) {
          return { kind: "failed", failureReason: error.message };
        }
        return { kind: "parse_failure", failureReason: error.message };
      }
    }

    function settleClassification(classification) {
      if (classification.kind === "success") {
        applySuccess(classification.parsed);
        return;
      }
      if (classification.kind === "policy_violation") {
        applyPolicyViolation(classification.statusAfter);
        return;
      }
      status = classification.kind === "timeout" ? "timeout" : "failed";
      failureReason = classification.failureReason;
    }

    let classification = classifyAttempt(runAdapterAttempt(laneBudgetMs));
    if (classification.kind === "parse_failure") {
      const remainingMs = laneBudgetMs - (Date.now() - laneStartedAt);
      const minRetryMs = minAdvisoryRetryTimeoutSeconds(request.reviewerName) * 1000;
      if (remainingMs >= minRetryMs) {
        rawResponsePaths[0] = promoteRawResponseToAttempt(rawResponsePaths[0], 1);
        classification = classifyAttempt(runAdapterAttempt(remainingMs));
        if (classification.kind === "parse_failure") {
          // Retry exhausted — surface as a normal failed result.
          classification = {
            kind: "failed",
            failureReason: classification.failureReason,
          };
        }
      } else {
        const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));
        classification = {
          kind: "failed",
          failureReason: (
            `${classification.failureReason}; retry skipped: remaining lane budget ` +
            `${remainingSeconds}s below viable adapter minimum ${minRetryMs / 1000}s`
          ),
        };
      }
    }
    settleClassification(classification);
  } catch (error) {
    status = "failed";
    failureReason = error.message;
  }

  const artifactHash = artifactPath ? hashFileSha256(artifactPath) : null;
  const result = {
    artifactHash,
    artifactPath,
    attemptCount,
    completed_at: new Date().toISOString(),
    failureReason,
    gating: request.gating === true,
    lane_index: request.laneIndex || 1,
    model: request.reviewerModel || null,
    profile: request.profile,
    rawResponsePath,
    rawResponsePaths: rawResponsePaths.slice(),
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
      raw_response_paths: rawResponsePaths.slice(),
      attempt_count: attemptCount,
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
  buildAdvisoryAdapterEnv,
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
