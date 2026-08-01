const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { validateFact } = require("./facts");

const PASS_VERDICTS = new Set(["pass", "lgtm"]);
const COMPARABLE_LEGACY_STATES = new Set([
  "draft",
  "dispatched",
  "publish_pending",
  "review_pending",
  "changes_requested",
  "ready_to_merge",
  "merged",
  "closed",
]);

function none(reason, base = {}) {
  return {
    phase: base.phase || "reviewable",
    action: "none",
    reason,
    head_sha: base.head_sha || null,
    reviewed_sha: base.reviewed_sha || null,
    pr_number: base.pr_number || null,
    terminal_kind: base.terminal_kind || null,
    terminal: base.terminal === true || Boolean(base.terminal_kind),
    activeAttempt: null,
    diagnostics: base.diagnostics || [],
  };
}

function hasReviewableWork(gitFacts, interrupted = null) {
  return interrupted?.payload?.reviewable_work === true
    || gitFacts.reviewable_work === true
    || gitFacts.tree_differs_from_start === true
    || gitFacts.branch_commit_exists === true
    || gitFacts.result_artifact_regular === true;
}

function hostIsLive(hostFacts, attempt) {
  if (typeof hostFacts.live === "boolean") return hostFacts.live;
  const handle = attempt?.payload?.host_handle;
  if (handle && hostFacts.by_handle && typeof hostFacts.by_handle[handle] === "boolean") {
    return hostFacts.by_handle[handle];
  }
  return null;
}

function requiresGithub(action) {
  return action === "merge" || action === "review" || action === "recover";
}

function completeRecordedPrObservation(githubFacts) {
  const sha = /^[0-9a-f]{40}$/i;
  return githubFacts.available === true
    && Number.isInteger(githubFacts.pr_number)
    && githubFacts.pr_number > 0
    && typeof githubFacts.repo === "string"
    && githubFacts.repo.length > 0
    && typeof githubFacts.pr_head_sha === "string"
    && sha.test(githubFacts.pr_head_sha)
    && typeof githubFacts.head_ref === "string"
    && githubFacts.head_ref.length > 0
    && typeof githubFacts.base_ref === "string"
    && githubFacts.base_ref.length > 0
    && new Set(["OPEN", "CLOSED", "MERGED"]).has(githubFacts.pr_state);
}

function withGithubAvailability(result, githubFacts) {
  if (!requiresGithub(result.action)) return result;
  if (githubFacts.available !== true) {
    return none("github_unavailable", { ...result, phase: result.phase });
  }
  if (result.reason === "publication_incomplete" && githubFacts.pr_lookup_complete !== true) {
    return none("github_unavailable", {
      ...result,
      phase: result.phase,
      diagnostics: [
        ...(result.diagnostics || []),
        { code: "github_pr_lookup_incomplete" },
      ],
    });
  }
  return result;
}

function foldRunFacts({
  runRecord,
  facts = [],
  gitFacts = {},
  githubFacts = {},
  hostFacts = {},
}) {
  if (!runRecord || typeof runRecord.run_id !== "string") {
    throw new Error("runRecord.run_id is required");
  }
  const diagnostics = [];
  const ids = new Set();
  const known = [];
  for (const fact of facts) {
    if (typeof fact?.event_id === "string") {
      if (ids.has(fact.event_id)) {
        return none("fact_conflict", {
          diagnostics: [{ code: "duplicate_event_id", event_id: fact.event_id }],
        });
      }
      ids.add(fact.event_id);
    }
    const validated = validateFact(fact, {
      allowUnknown: true,
      allowFutureFields: true,
    });
    if (!validated.known) {
      diagnostics.push({ code: "unknown_historical_fact", event_id: fact?.event_id || null });
      continue;
    }
    if (fact.run_id !== runRecord.run_id) {
      return none("fact_conflict", { diagnostics: [{ code: "run_id_mismatch", event_id: fact.event_id }] });
    }
    known.push(fact);
  }

  const prFacts = known.filter((fact) => fact.type === "pull_request_recorded");
  const prFact = prFacts.at(-1) || null;
  const prIdentities = new Set(prFacts.map((entry) => JSON.stringify({
    pr_number: entry.payload.pr_number,
    repo: entry.payload.repo,
    head_ref: entry.payload.head_ref,
    base_ref: entry.payload.base_ref,
  })));
  if (prIdentities.size > 1) {
    return none("fact_conflict", {
      diagnostics: [{ code: "conflicting_pull_request_facts" }],
    });
  }
  const branchConflict = Boolean(
    (gitFacts.branch && gitFacts.branch !== runRecord.git?.branch)
    || (gitFacts.base_branch && gitFacts.base_branch !== runRecord.git?.base_branch)
    || (prFact && prFact.payload.repo !== runRecord.repo?.remote)
    || (prFact && prFact.payload.head_ref !== runRecord.git?.branch)
    || (prFact && prFact.payload.base_ref !== runRecord.git?.base_branch)
    || (githubFacts.repo && githubFacts.repo !== runRecord.repo?.remote)
    || (githubFacts.head_ref && githubFacts.head_ref !== runRecord.git?.branch)
    || (githubFacts.base_ref && githubFacts.base_ref !== runRecord.git?.base_branch)
    || (prFact && githubFacts.pr_number && githubFacts.pr_number !== prFact.payload.pr_number)
  );
  if (branchConflict) {
    return none("fact_conflict", {
      diagnostics: [{ code: "external_identity_mismatch" }],
    });
  }

  const closes = known.filter((fact) => fact.type === "run_closed");
  const merges = known.filter((fact) => fact.type === "merge_recorded");
  if (closes.length > 1 || merges.length > 1 || (closes.length && merges.length)) {
    return none("fact_conflict", {
      phase: "terminal",
      terminal: true,
      diagnostics: [{ code: "conflicting_terminal_facts" }],
    });
  }
  const terminal = closes.at(-1) || merges.at(-1) || null;
  if (terminal) {
    const terminalConflict = terminal.type === "merge_recorded"
      ? Boolean(
        terminal.payload.reviewed_source_sha !== terminal.payload.pr_head_sha
        || (prFact && terminal.payload.pr_number !== prFact.payload.pr_number)
        || (prFact && terminal.payload.pr_head_sha !== prFact.payload.head_sha)
        || (githubFacts.pr_number && githubFacts.pr_number !== terminal.payload.pr_number)
        || (githubFacts.pr_head_sha && githubFacts.pr_head_sha !== terminal.payload.pr_head_sha)
        || (githubFacts.pr_state && githubFacts.pr_state !== "MERGED")
        || (githubFacts.merge_sha && githubFacts.merge_sha !== terminal.payload.result_target_sha)
      )
      : Boolean(
        terminal.payload.pr_number !== null
        && prFact
        && terminal.payload.pr_number !== prFact.payload.pr_number
      );
    if (terminalConflict) {
      return none("fact_conflict", {
        phase: "terminal",
        terminal_kind: terminal.type === "merge_recorded" ? "merged" : "closed",
        diagnostics: [{ code: "terminal_identity_mismatch" }],
      });
    }
    const laterActive = known.slice(known.indexOf(terminal) + 1)
      .filter((fact) => fact.type === "attempt_started");
    if (laterActive.length) diagnostics.push({ code: "active_fact_after_terminal" });
    return none(terminal.type === "run_closed" ? "closed" : "merged", {
      phase: "terminal",
      terminal_kind: terminal.type === "run_closed" ? "closed" : "merged",
      head_sha: terminal.type === "run_closed"
        ? terminal.payload.last_sha
        : terminal.payload.result_target_sha,
      reviewed_sha: terminal.type === "merge_recorded"
        ? terminal.payload.reviewed_source_sha
        : null,
      pr_number: terminal.payload.pr_number,
      diagnostics,
    });
  }

  const prNumber = prFact?.payload?.pr_number || null;
  const prHead = githubFacts.pr_head_sha || prFact?.payload?.head_sha || null;
  const finalAttempt = known.filter((fact) => fact.type === "attempt_finished").at(-1) || null;
  const interrupted = known.filter((fact) => fact.type === "attempt_interrupted").at(-1) || null;
  const headSha = gitFacts.head_sha || prHead || finalAttempt?.payload?.final_sha || interrupted?.payload?.last_known_sha || null;

  if (prFact && !completeRecordedPrObservation(githubFacts)) {
    return none("github_unavailable", {
      head_sha: headSha,
      pr_number: prNumber,
      diagnostics: [{ code: "github_pr_observation_incomplete" }],
    });
  }
  if (prFact && githubFacts.pr_state === "CLOSED") {
    return none("fact_conflict", {
      head_sha: headSha,
      pr_number: prNumber,
      diagnostics: [{ code: "github_pr_closed_unmerged" }],
    });
  }

  if (githubFacts.pr_state === "MERGED" && prFact) {
    if (
      typeof githubFacts.merge_sha !== "string"
      || !/^[0-9a-f]{40}$/i.test(githubFacts.merge_sha)
    ) {
      return none("github_unavailable", {
        head_sha: headSha,
        pr_number: prNumber,
        diagnostics: [{ code: "github_merge_observation_incomplete" }],
      });
    }
    return withGithubAvailability({
      phase: "reviewable",
      action: "recover",
      reason: "merged_pr_unrecorded",
      head_sha: headSha,
      reviewed_sha: null,
      pr_number: prNumber,
      terminal_kind: null,
      terminal: false,
      activeAttempt: null,
      diagnostics,
    }, githubFacts);
  }

  const starts = known.filter((fact) => fact.type === "attempt_started");
  const attemptIds = new Set();
  for (const start of starts) {
    if (attemptIds.has(start.attempt_id)) {
      return none("fact_conflict", {
        diagnostics: [{ code: "duplicate_attempt_start", attempt_id: start.attempt_id }],
      });
    }
    attemptIds.add(start.attempt_id);
  }
  for (const attemptId of attemptIds) {
    const terminalCount = known.filter((fact) => (
      (fact.type === "attempt_finished" || fact.type === "attempt_interrupted")
      && fact.attempt_id === attemptId
    )).length;
    if (terminalCount > 1) {
      return none("fact_conflict", {
        diagnostics: [{ code: "conflicting_attempt_terminal", attempt_id: attemptId }],
      });
    }
  }
  const latestStart = starts.at(-1) || null;
  const latestStartIndex = latestStart ? known.indexOf(latestStart) : -1;
  const terminalForAttempt = latestStart
    ? known.slice(latestStartIndex + 1).find((fact) => (
      (fact.type === "attempt_finished" || fact.type === "attempt_interrupted")
      && fact.attempt_id === latestStart.attempt_id
    ))
    : null;
  if (latestStart && !terminalForAttempt) {
    const live = hostIsLive(hostFacts, latestStart);
    const result = {
      phase: "running",
      action: live === true ? "wait" : "recover",
      reason: live === true ? "attempt_live" : "attempt_liveness_unknown",
      head_sha: headSha || latestStart.payload.start_sha,
      reviewed_sha: null,
      pr_number: prNumber,
      terminal_kind: null,
      terminal: false,
      activeAttempt: latestStart.attempt_id,
      diagnostics,
    };
    return live === true ? result : withGithubAvailability(result, githubFacts);
  }

  if (terminalForAttempt?.type === "attempt_interrupted") {
    if (!hasReviewableWork(gitFacts, terminalForAttempt)) {
      return {
        phase: "reviewable",
        action: "redispatch",
        reason: "interrupted_no_work",
        head_sha: headSha,
        reviewed_sha: null,
        pr_number: prNumber,
        terminal_kind: null,
        terminal: false,
        activeAttempt: null,
        diagnostics,
      };
    }
  }

  if (headSha && hasReviewableWork(gitFacts, terminalForAttempt) && !prFact) {
    return withGithubAvailability({
      phase: "reviewable",
      action: "recover",
      reason: "publication_incomplete",
      head_sha: headSha,
      reviewed_sha: null,
      pr_number: null,
      terminal_kind: null,
      terminal: false,
      activeAttempt: null,
      diagnostics,
    }, githubFacts);
  }

  const reviews = known.filter((fact) => fact.type === "review_recorded");
  const latestReview = reviews.at(-1) || null;
  const criteriaHash = runRecord.contract?.done_criteria_sha256 || null;
  const reviewBindingMatches = Boolean(
    latestReview
    && latestReview.payload.reviewed_sha === prHead
    && latestReview.payload.done_criteria_sha256 === criteriaHash,
  );
  if (
    latestReview
    && latestReview.payload.verdict === "changes_requested"
    && reviewBindingMatches
  ) {
    return {
      phase: "reviewable",
      action: "redispatch",
      reason: "changes_requested",
      head_sha: headSha,
      reviewed_sha: latestReview.payload.reviewed_sha,
      pr_number: prNumber,
      terminal_kind: null,
      terminal: false,
      activeAttempt: null,
      diagnostics,
    };
  }
  if (prFact && latestReview && !reviewBindingMatches) {
    return withGithubAvailability({
      phase: "reviewable",
      action: "review",
      reason: "review_stale",
      head_sha: headSha,
      reviewed_sha: latestReview.payload.reviewed_sha,
      pr_number: prNumber,
      terminal_kind: null,
      terminal: false,
      activeAttempt: null,
      diagnostics,
    }, githubFacts);
  }
  if (latestReview && PASS_VERDICTS.has(latestReview.payload.verdict) && reviewBindingMatches) {
    return withGithubAvailability({
      phase: "reviewable",
      action: "merge",
      reason: "ready_to_merge",
      head_sha: headSha,
      reviewed_sha: latestReview.payload.reviewed_sha,
      pr_number: prNumber,
      terminal_kind: null,
      terminal: false,
      activeAttempt: null,
      diagnostics,
    }, githubFacts);
  }
  if (latestReview?.payload?.verdict === "escalated") {
    return none("review_escalated", {
      head_sha: headSha,
      reviewed_sha: latestReview.payload.reviewed_sha,
      pr_number: prNumber,
      diagnostics,
    });
  }
  if (prFact) {
    return withGithubAvailability({
      phase: "reviewable",
      action: "review",
      reason: "review_missing",
      head_sha: headSha,
      reviewed_sha: null,
      pr_number: prNumber,
      terminal_kind: null,
      terminal: false,
      activeAttempt: null,
      diagnostics,
    }, githubFacts);
  }
  if (finalAttempt?.payload?.status === "failed" && !hasReviewableWork(gitFacts)) {
    return {
      phase: "reviewable",
      action: "redispatch",
      reason: "attempt_failed_no_work",
      head_sha: headSha,
      reviewed_sha: null,
      pr_number: null,
      terminal_kind: null,
      terminal: false,
      activeAttempt: null,
      diagnostics,
    };
  }
  return {
    phase: "reviewable",
    action: "redispatch",
    reason: "no_attempt",
    head_sha: headSha,
    reviewed_sha: null,
    pr_number: null,
    terminal_kind: null,
    terminal: false,
    activeAttempt: null,
    diagnostics,
  };
}

function validSha(value, fallback) {
  return /^[0-9a-f]{40}$/i.test(String(value || "")) ? value : fallback;
}

function validHash(value, fallback) {
  return /^[0-9a-f]{64}$/i.test(String(value || "")) ? value : fallback;
}

function projectLegacyRun({ manifest, events = [], observations = {} }) {
  const fallbackSha = "0".repeat(40);
  const fallbackHash = "0".repeat(64);
  const runId = manifest.run_id;
  const head = validSha(
    observations.gitFacts?.head_sha || manifest.git?.head_sha,
    fallbackSha,
  );
  const criteriaHash = validHash(
    observations.doneCriteriaSha256 || manifest.anchor?.done_criteria_sha256,
    fallbackHash,
  );
  const projectionDiagnostics = [];
  if (!validHash(observations.doneCriteriaSha256 || manifest.anchor?.done_criteria_sha256, null)) {
    projectionDiagnostics.push("done_criteria_hash_unavailable");
  }
  if (!observations.remote) projectionDiagnostics.push("remote_identity_unavailable");
  if (!validSha(observations.gitFacts?.head_sha || manifest.git?.head_sha, null)) {
    projectionDiagnostics.push("head_sha_unavailable");
  }
  const runRecord = {
    version: 3,
    run_id: runId,
    repo: {
      root: manifest.paths?.repo_root || observations.repoRoot || "/unknown",
      remote: observations.remote || "unknown/unknown",
    },
    git: {
      branch: manifest.git?.working_branch || "unknown",
      base_branch: manifest.git?.base_branch || "main",
      worktree: manifest.paths?.worktree || "/unknown",
      start_sha: validSha(observations.startSha, head),
    },
    contract: {
      done_criteria_path: manifest.anchor?.done_criteria_path || "/unknown/done-criteria.md",
      done_criteria_sha256: criteriaHash,
    },
    roles: {
      orchestrator: manifest.roles?.orchestrator || "unknown",
      executor: manifest.roles?.executor || "unknown",
      reviewer: manifest.roles?.reviewer || "unknown",
    },
    parent: manifest.fleet_id ? { kind: "fleet", id: manifest.fleet_id } : null,
    ownership_digest: manifest.ownership_digest || null,
    created_at: manifest.timestamps?.created_at || new Date(0).toISOString(),
  };

  const facts = [];
  const add = (type, payload, source, extra = {}) => {
    facts.push({
      event_id: `legacy-${facts.length + 1}-${source}`,
      run_id: runId,
      ...(extra.attempt_id ? { attempt_id: extra.attempt_id } : {}),
      type,
      at: extra.at || new Date(facts.length * 1000).toISOString(),
      actor: extra.actor || "legacy",
      payload,
    });
  };
  let attempt = 0;
  for (const event of events) {
    if (event.event === "dispatch_start") {
      attempt += 1;
      add("attempt_started", {
        executor: event.executor || manifest.roles?.executor || "unknown",
        model: event.model || null,
        start_sha: validSha(event.head_sha, head),
        host_kind: "legacy",
        host_handle: `legacy-attempt-${attempt}`,
        stdout_path: manifest.paths?.dispatch_stdout || "/unknown/stdout.log",
        stderr_path: manifest.paths?.dispatch_stderr || "/unknown/stderr.log",
        result_path: manifest.paths?.dispatch_result || "/unknown/result.txt",
        timeout_ms: Number.isInteger(event.timeout_ms) && event.timeout_ms > 0
          ? event.timeout_ms
          : 1,
      }, "dispatch-start", { attempt_id: `legacy-attempt-${attempt}`, at: event.ts, actor: event.actor });
    } else if (event.event === "dispatch_result" && attempt > 0) {
      add("attempt_finished", {
        status: event.status === "completed" || event.status === "success" ? "completed" : "failed",
        start_sha: validSha(event.start_sha, head),
        final_sha: validSha(event.head_sha, head),
        tree_sha: validSha(event.tree_sha, validSha(event.head_sha, head)),
        result_path: event.result_path || manifest.paths?.dispatch_result || "/unknown/result.txt",
        exit_code: Number.isInteger(event.exit_code) ? event.exit_code : (event.status === "completed" ? 0 : 1),
        verification_status: event.verification_status || "not_declared",
      }, "dispatch-result", { attempt_id: `legacy-attempt-${attempt}`, at: event.ts, actor: event.actor });
    } else if (event.event === "dispatch_interrupted" && attempt > 0) {
      add("attempt_interrupted", {
        last_known_sha: validSha(event.head_sha, head),
        reason: event.reason || "legacy_interruption",
        host_liveness: event.host_liveness || "unknown",
        reviewable_work: event.reviewable_work === true,
      }, "dispatch-interrupted", { attempt_id: `legacy-attempt-${attempt}`, at: event.ts, actor: event.actor });
    }
  }

  const prNumber = Number(manifest.git?.pr_number || observations.githubFacts?.pr_number);
  if (Number.isInteger(prNumber) && prNumber > 0) {
    add("pull_request_recorded", {
      pr_number: prNumber,
      repo: runRecord.repo.remote,
      head_ref: runRecord.git.branch,
      base_ref: runRecord.git.base_branch,
      head_sha: validSha(observations.githubFacts?.pr_head_sha, head),
      created_by_relay: true,
    }, "manifest-pr");
  }
  const reviewedSha = validSha(manifest.review?.last_reviewed_sha, null);
  if (reviewedSha) {
    const verdict = manifest.review?.latest_verdict;
    add("review_recorded", {
      round: Math.max(1, Number(manifest.review?.rounds || 1)),
      verdict: verdict === "lgtm" || verdict === "internal_lgtm"
        ? "lgtm"
        : verdict === "changes_requested"
          ? "changes_requested"
          : "escalated",
      reviewed_sha: reviewedSha,
      done_criteria_sha256: validHash(
        manifest.review?.last_done_criteria_sha256,
        criteriaHash,
      ),
      reviewer: manifest.review?.last_reviewer || runRecord.roles.reviewer,
      review_artifact: manifest.review?.last_artifact || "/unknown/review.json",
      override: null,
    }, "manifest-review");
  }
  if (manifest.state === "merged" && Number.isInteger(prNumber) && prNumber > 0) {
    add("merge_recorded", {
      pr_number: prNumber,
      reviewed_source_sha: reviewedSha || head,
      pr_head_sha: validSha(observations.githubFacts?.pr_head_sha, reviewedSha || head),
      result_target_sha: validSha(observations.githubFacts?.merge_sha, head),
      method: observations.mergeMethod || "squash",
      operator: observations.operator || "legacy",
      override_reason: null,
      operation_id: `legacy-merge-${runId}`,
      authorization_id: `legacy-authorization-${runId}`,
      observation_nonce: `legacy-observation-${runId}`,
      done_criteria_sha256: criteriaHash,
    }, "manifest-merged");
  } else if (manifest.state === "merged") {
    projectionDiagnostics.push("merged_pr_identity_unavailable");
  } else if (manifest.state === "closed") {
    add("run_closed", {
      reason: "legacy_closed",
      operator: observations.operator || "legacy",
      last_sha: head,
      pr_number: Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null,
    }, "manifest-closed");
  }
  return { runRecord, facts, projectionDiagnostics };
}

function normalizeLegacyAction(legacyDecision = {}) {
  const state = legacyDecision.state;
  if (state === "merged" || state === "closed") return "none";
  if (state === "ready_to_merge") return "merge";
  if (state === "changes_requested" || state === "draft") return "redispatch";
  if (state === "review_pending" || state === "internal_review_pending") return "review";
  if (state === "publish_pending") return "recover";
  if (state === "dispatched") {
    if (legacyDecision.host_live === true) return "wait";
    return legacyDecision.reviewable_work === true ? "recover" : "redispatch";
  }
  return "none";
}

function appendShadowTelemetry(telemetryPath, record, { fsModule = fs, fault = null } = {}) {
  const line = `${JSON.stringify(record)}\n`;
  fsModule.mkdirSync(path.dirname(telemetryPath), { recursive: true });
  const existed = fsModule.existsSync(telemetryPath);
  try {
    const stat = fsModule.lstatSync(telemetryPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("shadow telemetry must be a regular non-symlink file");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const fd = fsModule.openSync(
    telemetryPath,
    fs.constants.O_APPEND
      | fs.constants.O_CREAT
      | fs.constants.O_WRONLY
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    const bytes = Buffer.from(line);
    fault?.("open");
    const written = fsModule.writeSync(fd, bytes, 0, bytes.length);
    if (written !== bytes.length) throw new Error("short shadow telemetry write");
    fault?.("write");
    fsModule.fsyncSync(fd);
    fault?.("fsync");
  } finally {
    fsModule.closeSync(fd);
  }
  if (!existed) {
    const dirFd = fsModule.openSync(path.dirname(telemetryPath), fs.constants.O_RDONLY);
    try {
      fsModule.fsyncSync(dirFd);
      fault?.("dir_fsync");
    } finally {
      fsModule.closeSync(dirFd);
    }
  }
}

function compareShadow({
  legacyDecision,
  runRecord,
  facts,
  gitFacts = {},
  githubFacts = {},
  hostFacts = {},
  projectionDiagnostics = [],
  telemetryPath = null,
  at = new Date().toISOString(),
  provenance = null,
  expectedDiscrepancy = null,
  telemetryIo = null,
}) {
  const legacyAction = normalizeLegacyAction(legacyDecision);
  let vnext;
  let evaluationError = null;
  try {
    vnext = foldRunFacts({ runRecord, facts, gitFacts, githubFacts, hostFacts });
  } catch (error) {
    evaluationError = error.message;
    vnext = {
      phase: "reviewable",
      action: "none",
      reason: "shadow_evaluation_failed",
    };
  }
  const comparable = COMPARABLE_LEGACY_STATES.has(legacyDecision.state)
    && projectionDiagnostics.length === 0
    && !evaluationError;
  const agree = comparable && legacyAction === vnext.action;
  const digest = crypto.createHash("sha256").update(JSON.stringify({
    run_id: runRecord.run_id,
    event_ids: facts.map((fact) => fact.event_id),
    legacy_state: legacyDecision.state,
    legacy_action: legacyAction,
    vnext_action: vnext.action,
    vnext_reason: vnext.reason,
  })).digest("hex");
  const record = {
    schema_version: 1,
    at,
    run_id: runRecord.run_id,
    comparable,
    agree,
    mismatch_code: comparable && !agree
      ? `legacy_${legacyAction}_vnext_${vnext.action}`
      : (comparable ? null : `legacy_state_${legacyDecision.state}_not_comparable`),
    legacy: { state: legacyDecision.state, action: legacyAction },
    vnext: { phase: vnext.phase, action: vnext.action, reason: vnext.reason },
    input_digest: digest,
    projection_diagnostics: [...projectionDiagnostics],
    evaluation_error: evaluationError,
    provenance,
    expected_discrepancy: expectedDiscrepancy,
  };
  if (telemetryPath) {
    try {
      appendShadowTelemetry(telemetryPath, record, telemetryIo || {});
    } catch (error) {
      return { ...record, telemetry_error: error.message };
    }
  }
  return record;
}

module.exports = {
  COMPARABLE_LEGACY_STATES,
  compareShadow,
  foldRunFacts,
  normalizeLegacyAction,
  projectLegacyRun,
};
