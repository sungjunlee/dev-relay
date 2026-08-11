const crypto = require("crypto");
const path = require("path");
const { readFacts, validateFact } = require("./facts");
const { readRunRecord } = require("./run-store");
const PASS_VERDICTS = new Set(["pass", "lgtm"]);
const SHA1_RE = /^[0-9a-f]{40}$/i;
function result(action, reason, base = {}) {
  const output = {
    phase: base.phase || "reviewable",
    action,
    reason,
    head_sha: base.head_sha || null,
    reviewed_sha: base.reviewed_sha || null,
    pr_number: base.pr_number || null,
    retry_of_event_id: base.retry_of_event_id || null,
    terminal_kind: base.terminal_kind || null,
    terminal: base.terminal === true || Boolean(base.terminal_kind),
    activeAttempt: base.activeAttempt || null,
    diagnostics: base.diagnostics || [],
  };
  for (const field of ["review_event_id", "verification_event_id"]) {
    if (Object.prototype.hasOwnProperty.call(base, field)) output[field] = base[field];
  }
  return output;
}
function none(reason, base = {}) { return result("none", reason, { ...base, activeAttempt: null }); }
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
function isLocalDelivery(gitFacts = {}) { return gitFacts.local_delivery === true; }
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
function verificationGate({
  facts,
  prHead,
  treeSha,
  doneCriteriaSha256,
}) {
  const latest = facts.filter((fact) => fact.type === "verification_recorded").at(-1) || null;
  if (!latest) {
    const applicableAttempt = facts
      .filter((fact) => (
        fact.type === "attempt_finished"
        && fact.payload.final_sha === prHead
        && fact.payload.verification_status !== "not_declared"
      ))
      .at(-1) || null;
    if (!applicableAttempt) {
      return {
        ready: false,
        reason: "verification_missing",
        diagnostic: { code: "verification_proof_missing" },
      };
    }
    const passed = applicableAttempt.payload.verification_status === "passed";
    return {
      ready: false,
      reason: passed ? "verification_missing" : "verification_not_passing",
      diagnostic: {
        code: passed ? "verification_proof_missing" : "attempt_verification_not_passing",
        attempt_id: applicableAttempt.attempt_id,
        verification_status: applicableAttempt.payload.verification_status,
      },
    };
  }
  if (!treeSha) {
    return {
      ready: false,
      reason: "verification_observation_incomplete",
      diagnostic: {
        code: "verification_tree_observation_incomplete",
        verification_event_id: latest.event_id,
      },
    };
  }
  if (
    latest.payload.head_sha !== prHead
    || latest.payload.tree_sha !== treeSha
    || latest.payload.done_criteria_sha256 !== doneCriteriaSha256
  ) {
    return {
      ready: false,
      reason: "verification_stale",
      diagnostic: {
        code: "verification_proof_stale",
        verification_event_id: latest.event_id,
        recorded_head_sha: latest.payload.head_sha,
        observed_head_sha: prHead,
        recorded_tree_sha: latest.payload.tree_sha,
        observed_tree_sha: treeSha,
        recorded_done_criteria_sha256: latest.payload.done_criteria_sha256,
        expected_done_criteria_sha256: doneCriteriaSha256,
      },
    };
  }
  if (latest.payload.status !== "passed" || latest.payload.exit_code !== 0) {
    return {
      ready: false,
      reason: "verification_not_passing",
      diagnostic: {
        code: "verification_proof_not_passing",
        verification_event_id: latest.event_id,
        status: latest.payload.status,
        exit_code: latest.payload.exit_code,
      },
    };
  }
  return { ready: true, latest };
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
    const terminalIndex = known.indexOf(terminal);
    const priorFacts = known.slice(0, terminalIndex);
    const reviewedResultTerminal = terminal.type === "run_closed"
      && terminal.payload.reason === "reviewed_result_ready";
    const priorReview = priorFacts.filter((fact) => fact.type === "review_recorded").at(-1) || null;
    const priorReviewIndex = priorReview ? known.indexOf(priorReview) : -1;
    const priorVerification = priorReview
      ? known.slice(0, priorReviewIndex).filter((fact) => fact.type === "verification_recorded").at(-1) || null
      : null;
    const reviewedResultEvidenceMatches = Boolean(
      reviewedResultTerminal
      && priorReview
      && priorVerification
      && PASS_VERDICTS.has(priorReview.payload.verdict)
      && priorReview.payload.reviewed_sha === terminal.payload.last_sha
      && priorReview.payload.reviewer === runRecord.roles?.reviewer
      && priorReview.payload.done_criteria_sha256 === runRecord.contract?.done_criteria_sha256
      && priorVerification.payload.status === "passed"
      && priorVerification.payload.exit_code === 0
      && priorVerification.payload.head_sha === terminal.payload.last_sha
      && SHA1_RE.test(String(priorVerification.payload.tree_sha || ""))
      && priorVerification.payload.done_criteria_sha256 === runRecord.contract?.done_criteria_sha256
    );
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
      : reviewedResultTerminal
        ? Boolean(
          terminal.payload.pr_number !== null
          || prFacts.length > 0
          || !SHA1_RE.test(String(terminal.payload.last_sha || ""))
          || !reviewedResultEvidenceMatches
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
    const laterFacts = known.slice(terminalIndex + 1);
    const laterActive = laterFacts
      .filter((fact) => fact.type === "attempt_started");
    if (laterActive.length) diagnostics.push({ code: "active_fact_after_terminal" });
    if (laterFacts.some((fact) => ["review_recorded", "verification_recorded", "pull_request_recorded"].includes(fact.type))) {
      diagnostics.push({ code: "evidence_fact_after_terminal" });
    }
    if (reviewedResultTerminal && gitFacts.head_sha && gitFacts.head_sha !== terminal.payload.last_sha) {
      diagnostics.push({ code: "terminal_live_head_diverged" });
    }
    if (reviewedResultTerminal && gitFacts.tree_sha && priorVerification
      && gitFacts.tree_sha !== priorVerification.payload.tree_sha) {
      diagnostics.push({ code: "terminal_live_tree_diverged" });
    }
    return none(
      terminal.type === "merge_recorded"
        ? "merged"
        : reviewedResultTerminal ? "reviewed_result_ready" : "closed",
      {
      phase: "terminal",
        terminal_kind: terminal.type === "merge_recorded" ? "merged" : "closed",
      head_sha: terminal.type === "run_closed"
        ? terminal.payload.last_sha
        : terminal.payload.result_target_sha,
      reviewed_sha: terminal.type === "merge_recorded" || reviewedResultTerminal
        ? terminal.type === "merge_recorded"
          ? terminal.payload.reviewed_source_sha
          : terminal.payload.last_sha
        : null,
      ...(reviewedResultTerminal ? {
        review_event_id: priorReview?.event_id || null,
        verification_event_id: priorVerification?.event_id || null,
      } : {}),
      pr_number: terminal.payload.pr_number,
      diagnostics,
      },
    );
  }
  const prNumber = prFact?.payload?.pr_number || null;
  const prHead = githubFacts.pr_head_sha || prFact?.payload?.head_sha || null;
  const finalAttempt = known.filter((fact) => fact.type === "attempt_finished").at(-1) || null;
  const interrupted = known.filter((fact) => fact.type === "attempt_interrupted").at(-1) || null;
  const reviews = known.filter((fact) => fact.type === "review_recorded");
  const latestReview = reviews.at(-1) || null;
  const headSha = gitFacts.head_sha || prHead || finalAttempt?.payload?.final_sha || interrupted?.payload?.last_known_sha || null;
  if (prFact && isLocalDelivery(gitFacts)) {
    return none("fact_conflict", {
      head_sha: headSha,
      pr_number: prNumber,
      diagnostics: [{ code: "local_delivery_pull_request_conflict" }],
    });
  }
  if (prFact && !completeRecordedPrObservation(githubFacts)) {
    return none("github_unavailable", {
      head_sha: headSha,
      reviewed_sha: latestReview?.payload?.reviewed_sha || null,
      pr_number: prNumber,
      diagnostics: [{ code: "github_pr_observation_incomplete" }],
    });
  }
  if (prFact && githubFacts.pr_state === "CLOSED") {
    return none("github_pr_closed_unmerged", {
      head_sha: headSha,
      reviewed_sha: latestReview?.payload?.reviewed_sha || null,
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
        reviewed_sha: latestReview?.payload?.reviewed_sha || null,
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
    const attempt = result(live === true ? "wait" : "recover", live === true ? "attempt_live" : "attempt_liveness_unknown", {
      phase: "running",
      head_sha: headSha || latestStart.payload.start_sha,
      pr_number: prNumber,
      activeAttempt: latestStart.attempt_id,
      diagnostics,
    });
    return live === true || isLocalDelivery(gitFacts)
      ? attempt
      : withGithubAvailability(attempt, githubFacts);
  }
  if (terminalForAttempt?.type === "attempt_interrupted") {
    if (!hasReviewableWork(gitFacts, terminalForAttempt)) {
      return result("redispatch", "interrupted_no_work", {
        head_sha: headSha,
        pr_number: prNumber,
        diagnostics,
      });
    }
  }
  const localDelivery = !prFact && isLocalDelivery(gitFacts);
  let localVerification = null;
  let localReviewReady = false;
  if (localDelivery && headSha && hasReviewableWork(gitFacts, terminalForAttempt)) {
    if (gitFacts.reviewable_dirty === true) {
      return result("recover", "publication_incomplete", {
        head_sha: headSha,
        diagnostics,
      });
    }
    const currentReviewIsAuthoritative = Boolean(
      latestReview
      && latestReview.payload.reviewed_sha === headSha
      && latestReview.payload.done_criteria_sha256 === runRecord.contract?.done_criteria_sha256
      && latestReview.payload.reviewer === runRecord.roles?.reviewer
    );
    const reviewIndex = currentReviewIsAuthoritative ? known.indexOf(latestReview) : known.length;
    const candidateFacts = known.slice(0, reviewIndex);
    const verification = verificationGate({
      facts: candidateFacts,
      prHead: headSha,
      treeSha: gitFacts.head_sha === headSha ? gitFacts.tree_sha : null,
      doneCriteriaSha256: runRecord.contract?.done_criteria_sha256 || null,
    });
    localVerification = verification;
    if (!verification.ready) {
      return result("recover", verification.reason, {
        head_sha: headSha,
        diagnostics: [...diagnostics, verification.diagnostic],
      });
    }
    localReviewReady = true;
  }
  if (headSha && hasReviewableWork(gitFacts, terminalForAttempt) && !prFact && !localDelivery) {
    return withGithubAvailability(result("recover", "publication_incomplete", {
      head_sha: headSha,
      diagnostics,
    }), githubFacts);
  }
  const criteriaHash = runRecord.contract?.done_criteria_sha256 || null;
  // One review state machine serves both deliveries.  GitHub supplies the
  // exact live PR head; local delivery supplies the fresh Git HEAD.
  const reviewHead = localReviewReady ? headSha : prHead;
  const currentTreeSha = gitFacts.head_sha === reviewHead ? gitFacts.tree_sha : null;
  const reviewBindingMatches = Boolean(
    latestReview
    && latestReview.payload.reviewed_sha === reviewHead
    && latestReview.payload.done_criteria_sha256 === criteriaHash
    && latestReview.payload.reviewer === runRecord.roles?.reviewer,
  );
  const subjectReviews = latestReview
    ? reviews.filter((fact) => (
      fact.payload.reviewed_sha === latestReview.payload.reviewed_sha
      && fact.payload.done_criteria_sha256 === latestReview.payload.done_criteria_sha256
    ))
    : [];
  const firstRuntimeFailure = subjectReviews.find((fact) => (
    fact.payload.verdict === "escalated"
    && fact.payload.escalation_kind === "runtime_failure"
    && fact.payload.retry_of_event_id === undefined
  )) || null;
  const retryReviews = subjectReviews.filter((fact) => fact.payload.retry_of_event_id !== undefined);
  const retryLineageValid = retryReviews.length === 0 || Boolean(
    firstRuntimeFailure
    && retryReviews.length === 1
    && retryReviews[0].payload.retry_of_event_id === firstRuntimeFailure.event_id
    && subjectReviews[subjectReviews.indexOf(firstRuntimeFailure) + 1] === retryReviews[0]
  );
  if (
    reviewBindingMatches
    && (
      !retryLineageValid
      || (
        firstRuntimeFailure
        && latestReview.event_id !== firstRuntimeFailure.event_id
        && latestReview.payload.retry_of_event_id !== firstRuntimeFailure.event_id
      )
    )
  ) {
    return none("review_retry_binding_invalid", {
      head_sha: headSha,
      reviewed_sha: latestReview.payload.reviewed_sha,
      pr_number: prNumber,
      diagnostics: [...diagnostics, { code: "review_retry_binding_invalid", event_id: latestReview.event_id }],
    });
  }
  if (
    latestReview
    && latestReview.payload.verdict === "changes_requested"
    && reviewBindingMatches
  ) {
    // A completed review correction must return to recover, the sole commit/push owner;
    // redispatch here would strand corrected bytes. #1191 worktree-base validation is untouched.
    const latestPostReviewTerminal = known
      .slice(known.indexOf(latestReview) + 1)
      .filter((fact) => fact.type === "attempt_finished" || fact.type === "attempt_interrupted")
      .at(-1) || null;
    if (!localReviewReady && (
      latestPostReviewTerminal?.type === "attempt_finished"
      && latestPostReviewTerminal.payload.status === "completed"
      && hasReviewableWork(gitFacts)
    )) {
      return withGithubAvailability(result("recover", "publication_incomplete", {
        head_sha: headSha,
        reviewed_sha: latestReview.payload.reviewed_sha,
        pr_number: prNumber,
        diagnostics,
      }), githubFacts);
    }
    const correction = result("redispatch", "changes_requested", {
      head_sha: headSha,
      reviewed_sha: latestReview.payload.reviewed_sha,
      pr_number: prNumber,
      diagnostics,
    });
    return localReviewReady ? correction : withGithubAvailability(correction, githubFacts);
  }
  if (prFact) {
    const verification = verificationGate({
      facts: known,
      prHead,
      treeSha: currentTreeSha,
      doneCriteriaSha256: criteriaHash,
    });
    if (!verification.ready) {
      return withGithubAvailability(result("recover", verification.reason, {
        head_sha: headSha,
        reviewed_sha: latestReview?.payload?.reviewed_sha || null,
        pr_number: prNumber,
        diagnostics: [...diagnostics, verification.diagnostic],
      }), githubFacts);
    }
  }
  if (prFact && latestReview && !reviewBindingMatches) {
    return withGithubAvailability(result("review", "review_stale", {
      head_sha: headSha,
      reviewed_sha: latestReview.payload.reviewed_sha,
      pr_number: prNumber,
      diagnostics,
    }), githubFacts);
  }
  if (localReviewReady && latestReview && !reviewBindingMatches) {
    return result("review", "review_stale", {
      head_sha: headSha,
      reviewed_sha: latestReview.payload.reviewed_sha,
      diagnostics,
    });
  }
  if (latestReview && PASS_VERDICTS.has(latestReview.payload.verdict) && reviewBindingMatches) {
    if (localReviewReady) {
      return result("recover", "reviewed_result_ready", {
        head_sha: headSha,
        reviewed_sha: latestReview.payload.reviewed_sha,
        review_event_id: latestReview.event_id,
        verification_event_id: localVerification?.latest?.event_id || null,
        diagnostics,
      });
    }
    return withGithubAvailability(result("merge", "ready_to_merge", {
      head_sha: headSha,
      reviewed_sha: latestReview.payload.reviewed_sha,
      pr_number: prNumber,
      diagnostics,
    }), githubFacts);
  }
  if (latestReview?.payload?.verdict === "escalated") {
    const isRetryFailure = Boolean(
      firstRuntimeFailure
      && latestReview.event_id !== firstRuntimeFailure.event_id
      && latestReview.payload.retry_of_event_id === firstRuntimeFailure.event_id
      && latestReview.payload.escalation_kind === "runtime_failure",
    );
    if (
      reviewBindingMatches
      && latestReview.payload.escalation_kind === "runtime_failure"
      && firstRuntimeFailure
      && latestReview.event_id === firstRuntimeFailure.event_id
    ) {
      const retry = result("review", "review_retryable_escalation", {
        head_sha: headSha,
        reviewed_sha: latestReview.payload.reviewed_sha,
        pr_number: prNumber,
        retry_of_event_id: latestReview.event_id,
        diagnostics,
      });
      return localReviewReady ? retry : withGithubAvailability(retry, githubFacts);
    }
    if (isRetryFailure) {
      return none("review_escalated_retry_exhausted", {
        head_sha: headSha,
        reviewed_sha: latestReview.payload.reviewed_sha,
        pr_number: prNumber,
        diagnostics: [...diagnostics, { code: "review_retry_exhausted", event_id: latestReview.event_id }],
      });
    }
    return none("review_escalated", {
      head_sha: headSha,
      reviewed_sha: latestReview.payload.reviewed_sha,
      pr_number: prNumber,
      diagnostics,
    });
  }
  if (prFact) {
    return withGithubAvailability(result("review", "review_missing", {
      head_sha: headSha,
      pr_number: prNumber,
      diagnostics,
    }), githubFacts);
  }
  if (localReviewReady) {
    return result("review", "review_missing", {
      head_sha: headSha,
      diagnostics,
    });
  }
  if (finalAttempt?.payload?.status === "failed" && !hasReviewableWork(gitFacts)) {
    return result("redispatch", "attempt_failed_no_work", {
      head_sha: headSha,
      diagnostics,
    });
  }
  return result("redispatch", "no_attempt", {
    head_sha: headSha,
    diagnostics,
  });
}
const VOLATILE_ACTION_KEYS = new Set(["at", "duration_ms", "error", "nonce", "observed_at", "request_nonce"]);
function stable(value, omitVolatile = false) {
  if (Array.isArray(value)) return value.map((entry) => stable(entry, omitVolatile));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).filter((key) => !omitVolatile || !VOLATILE_ACTION_KEYS.has(key))
    .sort().map((key) => [key, stable(value[key], omitVolatile)]));
}
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function actionKey(value) { return digest(JSON.stringify(stable(value, true))); }
function defaultSnapshot(runDir) {
  const runRecord = readRunRecord({ runDir });
  const journal = readFacts({ eventsPath: path.join(runDir, "events.jsonl") });
  return { runDir, runRecord, facts: journal.facts, snapshot: {
    run_sha256: digest(JSON.stringify(runRecord)),
    facts_sha256: digest(JSON.stringify(journal.facts)), fact_count: journal.facts.length,
    last_event_id: journal.facts.at(-1)?.event_id || null,
    tail_status: journal.tailIncomplete ? "incomplete" : "complete",
  } };
}
function observations(raw = {}) {
  return { git: raw.git || raw.gitFacts || {}, github: raw.github || raw.githubFacts || {},
    host: raw.host || raw.hostFacts || {}, verification: raw.verification || {}, blockers: raw.blockers || [] };
}
function blocker(code, message, retryable = false, details = {}) { return { code, message, retryable, details }; }
function matchingRecordedPr(facts, github) {
  const fact = facts.filter((item) => item.type === "pull_request_recorded").at(-1);
  return fact && fact.payload.pr_number === github.pr_number && fact.payload.repo === github.repo
    && fact.payload.head_ref === github.head_ref && fact.payload.base_ref === github.base_ref
    && fact.payload.head_sha === github.pr_head_sha ? fact : null;
}
function recoverySteps(derived, seen, facts = []) {
  if (isLocalDelivery(seen.git)) {
    if (derived.reason === "attempt_liveness_unknown") {
      return seen.host.live === false ? ["close_dead_attempt"] : [];
    }
    if (seen.git.reviewable_dirty === true) return ["commit_work"];
    if (String(derived.reason || "").startsWith("verification_")) return ["record_verification"];
    if (derived.reason === "reviewed_result_ready") return ["close_reviewed_result"];
    return [];
  }
  if (derived.reason === "merged_pr_unrecorded" && matchingRecordedPr(facts, seen.github)) return ["record_external_merge"];
  if (derived.reason === "attempt_liveness_unknown") return seen.host.live === false ? ["close_dead_attempt"] : [];
  const steps = [], head = seen.git.head_sha || derived.head_sha;
  const prior = facts.filter((fact) => fact.type === "pull_request_recorded").at(-1);
  const reusable = seen.github.pr_state === "OPEN" && Number(seen.github.matching_pr_count) === 1;
  const publish = derived.reason === "publication_incomplete" || seen.git.reviewable_dirty === true
    || (reusable && seen.github.pr_head_sha !== head)
    || (reusable && (!prior || prior.payload.head_sha !== seen.github.pr_head_sha));
  if (publish) {
    if (seen.git.reviewable_dirty === true) steps.push("commit_work");
    if (seen.git.reviewable_dirty === true || seen.git.remote_head_sha !== head) steps.push("push_branch");
    steps.push("record_or_create_pr");
  }
  if (String(derived.reason || "").startsWith("verification_")) steps.push("record_verification");
  return [...new Set(steps)];
}
function deriveBlockers(snapshot, facts, seen, derived) {
  const out = snapshot.tail_status === "complete" ? [] : [blocker("event_tail_incomplete", "facts journal has an incomplete tail", true)];
  for (const item of seen.blockers) out.push(blocker(item.code || "observation_blocked", item.message || "external observation is incomplete", item.retryable === true, item.details || {}));
  if (seen.github.lookup_complete === false) out.push(blocker("github_pr_lookup_incomplete", "GitHub PR lookup is incomplete", true));
  if (Number(seen.github.matching_pr_count) > 1) out.push(blocker("ambiguous_pr", "multiple PRs match the immutable run identity"));
  if (["ahead_local", "diverged"].includes(seen.git.remote_relation)) out.push(blocker("remote_branch_conflict", "remote branch cannot be advanced safely"));
  if (seen.github.pr_state === "MERGED" && !matchingRecordedPr(facts, seen.github)) out.push(blocker("unrecorded_merged_pr", "a merged branch PR is not bound to the durable run PR identity"));
  if (derived.reason === "github_pr_closed_unmerged") out.push(blocker("github_pr_closed_unmerged", "the durable run PR is closed without a merge"));
  if (derived.reason === "fact_conflict") out.push(blocker("fact_conflict", "durable facts or external identity conflict"));
  return out;
}
function recommendedAction(snapshot, facts, seen, derived, blockers) {
  let kind = derived.action, steps = kind === "recover" ? recoverySteps(derived, seen, facts) : [];
  if (blockers.length || (kind === "recover" && !steps.length)) { kind = "operator_attention"; steps = []; }
  const action = { kind, reason: blockers[0]?.code || derived.reason, steps,
    required_inputs: steps.includes("record_verification") ? ["verification_file"] : [] };
  return { ...action, key: actionKey({ run_sha256: snapshot.run_sha256,
    observations: { git: seen.git, github: seen.github, host: { live: seen.host.live }, verification: seen.verification }, derived, action }) };
}
async function inspectRun({ runDir, observer, readSnapshot = defaultSnapshot } = {}) {
  if (typeof observer !== "function") throw new Error("inspectRun requires an observer function");
  const before = await readSnapshot(runDir);
  const seen = observations(await observer({ operation: "inspect", phase: "observe", runDir: before.runDir, runRecord: before.runRecord, facts: before.facts }));
  const derived = foldRunFacts({ runRecord: before.runRecord, facts: before.facts,
    gitFacts: seen.git, githubFacts: seen.github, hostFacts: seen.host });
  const after = await readSnapshot(runDir);
  const blockers = deriveBlockers(before.snapshot, before.facts, seen, derived);
  if (before.snapshot.run_sha256 !== after.snapshot.run_sha256 || before.snapshot.facts_sha256 !== after.snapshot.facts_sha256) {
    blockers.unshift(blocker("snapshot_changed", "run facts changed during read-only inspection; retry from a fresh snapshot", true));
  }
  return { schema_version: 1, operation: "inspect", run_id: before.runRecord.run_id, snapshot: before.snapshot,
    facts: before.facts, observations: { git: seen.git, github: seen.github, host: seen.host, verification: seen.verification },
    derived, blockers, recommended_action: recommendedAction(before.snapshot, before.facts, seen, derived, blockers) };
}
module.exports = {
  actionKey,
  defaultSnapshot,
  foldRunFacts,
  inspectRun,
  matchingRecordedPr,
  recoverySteps,
  stable,
};
