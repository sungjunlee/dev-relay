"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("util");
const factsModule = require("./facts");
const host = require("./host");
const { cleanupWorktree } = require("./cleanup-worktree");
const { execGh, execGit } = require("./exec");
const { readRunRecord } = require("./run-store");
const runStore = require("./run-store");
const inspect = require("./inspect");
const { foldRunFacts } = inspect;
const { readFacts } = factsModule;

let defaultSnapshot,
  observeProduction,
  assertCleanVerificationObservation,
  readVerificationPayload,
  inspectRun,
  assertReviewedCloseEvidence,
  stageReviewableWork,
  commitVerifiedStaging,
  observeGithub,
  originBranchExists,
  reobservePublishedPr,
  blocker,
  externalMergeObserver,
  gitBytes,
  unsafeWorktreeEntries,
  assertTrustedRecoveryWorktree,
  inspectProductionRun,
  recoverRun,
  productionRecoveryIo,
  sha256,
  stable;

function bindRecoverProduction(deps) {
  ({
    defaultSnapshot,
    observeProduction,
    assertCleanVerificationObservation,
    readVerificationPayload,
    inspectRun,
    assertReviewedCloseEvidence,
    stageReviewableWork,
    commitVerifiedStaging,
    observeGithub,
    originBranchExists,
    reobservePublishedPr,
    blocker,
    externalMergeObserver,
    gitBytes,
    unsafeWorktreeEntries,
    assertTrustedRecoveryWorktree,
    inspectProductionRun,
    recoverRun,
    productionRecoveryIo,
    sha256,
    stable,
  } = deps);
}

function createProductionEffects({ verificationFile = null, getLockContext = () => null } = {}) {
  return {
    async validateCompletedFact(step, context, fact) {
      if (step !== "record_verification" || !verificationFile) return;
      const snapshot = defaultSnapshot(context.runDir);
      const observed = await observeProduction({
        runDir: context.runDir,
        runRecord: snapshot.runRecord,
        facts: snapshot.facts,
        verificationFile,
        activeRecoveryLock: getLockContext(),
      });
      if (observed.blockers.length) {
        throw new Error(`recovery observation blocked: ${observed.blockers[0].code}`);
      }
      assertCleanVerificationObservation(observed);
      const payload = readVerificationPayload(verificationFile, {
        record: snapshot.runRecord,
        observed,
        actor: context.actor,
      });
      if (!isDeepStrictEqual(fact.payload, payload)) {
        throw new Error(`duplicate event_id: ${fact.event_id}`);
      }
    },
    async converge(step, context) {
      const snapshot = defaultSnapshot(context.runDir);
      const record = snapshot.runRecord;
      const worktree = record.git.worktree;
      const observed = await observeProduction({
        runDir: context.runDir,
        runRecord: record,
        facts: snapshot.facts,
        verificationFile,
        activeRecoveryLock: getLockContext(),
      });
      if (observed.blockers.length) {
        throw new Error(`recovery observation blocked: ${observed.blockers[0].code}`);
      }
      if (step === "close_dead_attempt") {
        if (observed.host.live !== false) throw new Error("attempt liveness is not proven dead");
        const start = snapshot.facts.filter((fact) => fact.type === "attempt_started").at(-1);
        if (!start) return { converged: true, applied: false };
        const terminal = snapshot.facts.some((fact) => (
          fact.attempt_id === start.attempt_id
          && new Set(["attempt_finished", "attempt_interrupted"]).has(fact.type)
        ));
        if (terminal) return { converged: true, applied: false };
        return {
          converged: true,
          applied: true,
          fact: {
            attempt_id: start.attempt_id,
            type: "attempt_interrupted",
            at: context.intent.created_at,
            actor: context.actor,
            payload: {
              last_known_sha: observed.git.head_sha,
              reason: context.reason,
              host_liveness: "dead",
              reviewable_work: observed.git.reviewable_work,
            },
          },
        };
      }
      if (step === "close_reviewed_result") {
        if (observed.git.local_delivery !== true) {
          throw new Error("reviewed result close requires proven local Git delivery");
        }
        if (observed.git.reviewable_dirty !== false) {
          throw new Error("reviewed result close requires a clean local worktree");
        }
        const lockedInspection = await inspectRun({
          runDir: context.runDir,
          observer: (request) => observeProduction({
            ...request,
            activeRecoveryLock: getLockContext(),
          }),
        });
        if (
          lockedInspection.blockers.length
          || lockedInspection.recommended_action.kind !== "recover"
          || lockedInspection.recommended_action.reason !== "reviewed_result_ready"
          || lockedInspection.recommended_action.steps.length !== 1
          || lockedInspection.recommended_action.steps[0] !== "close_reviewed_result"
          || lockedInspection.recommended_action.key !== context.actionKey
          || lockedInspection.observations.git.local_delivery !== true
          || lockedInspection.observations.git.reviewable_dirty !== false
          || lockedInspection.observations.github?.pr_number != null
          || lockedInspection.observations.github?.pr_head_sha != null
          || lockedInspection.facts.some((fact) => fact.type === "pull_request_recorded")
        ) {
          throw new Error("reviewed result close binding changed under the run lock");
        }
        const head = lockedInspection.observations.git.head_sha;
        const tree = lockedInspection.observations.git.tree_sha;
        const review = lockedInspection.facts.find((fact) => (
          fact.event_id === lockedInspection.derived.review_event_id
        ));
        const verification = lockedInspection.facts.find((fact) => (
          fact.event_id === lockedInspection.derived.verification_event_id
        ));
        if (
          !/^[0-9a-f]{40}$/i.test(String(head || ""))
          || !/^[0-9a-f]{40}$/i.test(String(tree || ""))
          || lockedInspection.derived.head_sha !== head
          || lockedInspection.derived.reviewed_sha !== head
          || !review
          || !["pass", "lgtm"].includes(review.payload.verdict)
          || review.payload.reviewed_sha !== head
          || review.payload.reviewer !== record.roles.reviewer
          || review.payload.done_criteria_sha256 !== record.contract.done_criteria_sha256
          || !verification
          || verification.payload.status !== "passed"
          || verification.payload.exit_code !== 0
          || verification.payload.head_sha !== head
          || verification.payload.tree_sha !== tree
          || verification.payload.done_criteria_sha256 !== record.contract.done_criteria_sha256
        ) {
          throw new Error("reviewed result close requires exact local review and verification lineage");
        }
        assertReviewedCloseEvidence({
          runDir: context.runDir,
          record,
          inspection: lockedInspection,
          review,
          verification,
        });
        return {
          converged: true,
          applied: true,
          fact: {
            type: "run_closed",
            at: context.intent.created_at,
            actor: context.actor,
            payload: {
              reason: "reviewed_result_ready",
              operator: context.actor,
              last_sha: context.intent.before_sha,
              pr_number: null,
            },
          },
        };
      }
      if (step === "commit_work") {
        if (!observed.git.reviewable_dirty) return { converged: true, applied: false };
        const staged = stageReviewableWork(worktree, observed.git.status);
        commitVerifiedStaging(worktree, staged, {
          runId: context.runId,
          reason: context.reason,
          expectedHead: observed.git.head_sha,
        });
        return { converged: true, applied: true };
      }
      if (step === "push_branch") {
        if (observed.git.remote_head_sha === observed.git.head_sha) {
          return { converged: true, applied: false };
        }
        if (observed.git.remote_relation !== "behind_local") {
          throw new Error(`refusing push from remote relation ${observed.git.remote_relation}`);
        }
        execGit(worktree, ["push", "-u", observed.git.remote_name, record.git.branch]);
        const after = await observeProduction({
          runDir: context.runDir, runRecord: record, facts: snapshot.facts,
          activeRecoveryLock: getLockContext(),
        });
        if (after.git.remote_head_sha !== after.git.head_sha) {
          throw new Error("remote branch does not contain the exact recovery HEAD after push");
        }
        return { converged: true, applied: true };
      }
      if (step === "record_verification") {
        assertCleanVerificationObservation(observed);
        const payload = readVerificationPayload(verificationFile, {
          record,
          observed,
          actor: context.actor,
        });
        const existing = snapshot.facts.find((fact) => (
          fact.type === "verification_recorded"
          && isDeepStrictEqual(fact.payload, payload)
        ));
        if (existing) {
          // Preserve the exact durable fact identity in the applied ledger so
          // a crash after fact append yields the same receipt shape as a crash
          // before append. A non-equal pass/fail payload is not deduplicated.
          return { converged: true, applied: false, fact_event_id: existing.event_id };
        }
        return {
          converged: true,
          applied: true,
          fact: {
            type: "verification_recorded",
            at: context.intent.created_at,
            actor: context.actor,
            payload,
          },
        };
      }
      if (step === "record_or_create_pr") {
        if (observed.git.remote_head_sha !== observed.git.head_sha) {
          throw new Error("refusing PR publication before remote branch equals local HEAD");
        }
        let github = observed.github;
        let created = false;
        const marker = `<!-- relay-recovery-operation:${context.operationId} -->`;
        if (github.matching_pr_count === 0) {
          if (!originBranchExists(worktree, record.git.base_branch)) {
            return {
              converged: false,
              blockers: [blocker(
                "stale_base_branch",
                `recorded base is gone: ${record.git.base_branch}`,
                false,
                { recorded_base: record.git.base_branch },
              )],
            };
          }
          const title = execGit(worktree, ["log", "-1", "--format=%s", "HEAD"])
            || `Recover ${record.git.branch}`;
          try {
            execGh(worktree, [
              "pr", "create", "--repo", record.repo.remote,
              "--base", record.git.base_branch, "--head", record.git.branch,
              "--title", title,
              "--body", [
                "## Recovery Summary", "", marker, "",
                `- Run: ${record.run_id}`, `- Reason: ${context.reason}`,
              ].join("\n"),
            ], { timeout: 30_000 });
            created = true;
          } catch (createError) {
            // A concurrent publisher may have won after the zero-match
            // observation. Re-observe once and converge only if the exact
            // immutable repo/head/SHA identity now exists.
            github = observeGithub(record, { localHeadSha: observed.git.head_sha });
            if (github.matching_pr_count !== 1) throw createError;
          }
          if (created) github = await reobservePublishedPr(record, observed.git.head_sha);
        }
        if (
          github.available !== true
          || github.matching_pr_count !== 1
          || !Number.isInteger(github.pr_number)
          || github.head_ref !== record.git.branch
          || github.pr_head_sha !== observed.git.head_sha
        ) {
          throw new Error("PR publication did not re-observe one exact repo/head/SHA match");
        }
        if (github.pr_state !== "OPEN") {
          return {
            converged: false,
            blockers: [blocker(
              github.pr_state === "CLOSED" ? "github_pr_closed_unmerged" : "active_intent_observation_changed",
              `exact recovery PR is ${github.pr_state || "not open"}; recovery will not publish or overwrite it`,
              false,
            )],
          };
        }
        const existing = snapshot.facts.find((fact) => (
          fact.type === "pull_request_recorded"
          && fact.payload.pr_number === github.pr_number
          && fact.payload.head_sha === github.pr_head_sha
        ));
        if (existing) return { converged: true, applied: false };
        const priorIdentity = snapshot.facts.filter((fact) => (
          fact.type === "pull_request_recorded"
          && fact.payload.pr_number === github.pr_number
          && fact.payload.repo === record.repo.remote
          && fact.payload.head_ref === record.git.branch
        )).at(-1) || null;
        return {
          converged: true,
          applied: created,
          fact: {
            type: "pull_request_recorded",
            at: context.intent.created_at,
            actor: context.actor,
            payload: {
              pr_number: github.pr_number,
              repo: record.repo.remote,
              head_ref: record.git.branch,
              base_ref: github.base_ref,
              head_sha: github.pr_head_sha,
              created_by_relay: created
                || priorIdentity?.payload.created_by_relay === true
                || String(github.body || "").includes(marker),
            },
          },
        };
      }
      if (step === "record_external_merge") {
        const lockContext = getLockContext();
        if (!lockContext) throw new Error("external merge provenance requires the active run lock");
        const descriptor = externalMergeObserver(record);
        const request = {
          ...descriptor.request,
          pr_number: observed.github.pr_number,
          expected_pr_head_sha: observed.github.pr_head_sha,
          expected_result_target_sha: observed.github.merge_sha,
        };
        const fresh = await factsModule.revalidateExternalFacts({
          runDir: context.runDir,
          lockContext,
          observer: descriptor,
          request,
          authorize: (live) => {
            if (
              live.pr_number !== observed.github.pr_number
              || live.pr_state !== "MERGED"
              || live.pr_head_sha !== observed.github.pr_head_sha
              || live.head_ref !== record.git.branch
              || live.base_ref !== observed.github.base_ref
              || live.merge_sha !== observed.github.merge_sha
            ) throw new Error("fresh external merge observation changed identity");
            return { authorized: true };
          },
        });
        const authorizationPath = path.join(
          context.runDir,
          `merge-authorization-${context.operationId}.json`,
        );
        const authorization = fs.existsSync(authorizationPath)
          ? factsModule.resumeOperatorMerge({
              runDir: context.runDir,
              lockContext,
              operationId: context.operationId,
              freshObservation: fresh.observationCapability,
            })
          : factsModule.planOperatorMerge({
              runDir: context.runDir,
              lockContext,
              freshObservation: fresh.observationCapability,
              operatorAction: {
                actor: context.actor,
                method: "external",
                overrideReason: context.reason,
                operationId: context.operationId,
              },
              currentHead: observed.github.pr_head_sha,
              currentDoneCriteriaSha256: record.contract.done_criteria_sha256,
              verdict: null,
              prNumber: observed.github.pr_number,
            });
        await factsModule.recordMerge({
          eventsPath: path.join(context.runDir, "events.jsonl"),
          at: context.intent.created_at,
          provenance: {
            pr_number: observed.github.pr_number,
            reviewed_source_sha: observed.github.pr_head_sha,
            pr_head_sha: observed.github.pr_head_sha,
            result_target_sha: observed.github.merge_sha,
            method: "external",
            operator: context.actor,
            override_reason: context.reason,
          },
          authorization,
          lockContext,
          observer: descriptor,
        });
        return { converged: true, applied: true };
      }
      throw new Error(`recovery step ${step} has no safe production implementation`);
    },
  };
}
async function withProductionRecoveryLock({
  runDir,
  runId,
  worktree,
  reason,
  breakLock = false,
}, callback) {
  const eventsPath = path.join(runDir, "events.jsonl");
  const audit = (fragment, capability) => {
    const eventId = `host-${fragment.audit_key}`;
    const existing = factsModule.readFacts({ eventsPath }).facts.find((fact) => fact.event_id === eventId);
    const fact = factsModule.factFromHostAudit({
      runId,
      eventId,
      at: existing?.at || new Date().toISOString(),
      actor: "relay-host",
      audit: fragment,
    });
    if (existing && JSON.stringify(existing) !== JSON.stringify(fact)) throw Object.assign(
      new Error(`canonical host audit ${eventId} conflicts with its durable replay`),
      { code: "DUPLICATE_EVENT_ID" },
    );
    factsModule.appendFact({ eventsPath, lockContext: capability, fact });
    return { durable: true, idempotent: true, audit_key: fragment.audit_key };
  };
  const options = {
    runDir,
    attemptId: `recover-${crypto.randomBytes(8).toString("hex")}`,
    operation: "recover",
    hostKind: "local_supervisor",
    hostHandle: `recover:${process.pid}`,
    worktreeDir: worktree,
    audit,
  };
  let callbackStarted = false;
  const invoke = (capability) => { callbackStarted = true; return callback(capability); };
  try {
    return await host.withRunLock(options, invoke);
  } catch (error) {
    if (error?.code !== "LOCK_HELD" || callbackStarted) throw error;
  }
  if (!breakLock) throw Object.assign(
    new Error("run lock is held; explicit --break-lock is required for stale-owner recovery"),
    { code: "LOCK_HELD" },
  );
  const status = gitBytes(worktree, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const unsafeEntries = unsafeWorktreeEntries(worktree, status);
  if (unsafeEntries.length) throw Object.assign(new Error(
    `unsafe_worktree_entry: unsupported special entries prevent lock recovery: ${unsafeEntries.join(", ")}`,
  ), { code: "UNSAFE_WORKTREE_ENTRY", paths: unsafeEntries });
  const inspection = host.inspectOwnership({ runDir });
  if (!["stale", "unknown"].includes(inspection.status)) throw Object.assign(
    new Error(`existing run owner is ${inspection.status}; recovery will not break it`),
    { code: "LOCK_HELD" },
  );
  const terminalResultPath = path.join(runDir, `attempt-${inspection.owner.attempt_id}.result.json`);
  const resultPath = fs.existsSync(terminalResultPath) ? terminalResultPath : undefined;
  await host.breakStaleRunLock({
    inspection,
    reason: `Recovery ownership reclaim: ${reason}`,
    resultPath,
    audit,
  });
  return host.withRunLock(options, invoke);
}
async function recoverProductionRun({
  runDir,
  actor,
  reason,
  closeIntent = null,
  resolutionIntent = null,
  expectedActionKey = null,
  verificationFile = null,
  breakLock = false,
  activeCheckout = null,
  relayWorktreeBase = null,
} = {}) {
  const canonicalRunDir = fs.realpathSync(runDir);
  const record = readRunRecord({ runDir: canonicalRunDir });
  let mergedWorktreeAlreadyAbsent = false;
  if (!fs.existsSync(record.git.worktree)) {
    const initialFacts = readFacts({ eventsPath: path.join(canonicalRunDir, "events.jsonl") }).facts;
    const initialDurable = foldRunFacts({
      runRecord: record,
      facts: initialFacts,
      gitFacts: {},
      githubFacts: {},
      hostFacts: {},
    });
    mergedWorktreeAlreadyAbsent = initialDurable.terminal === true
      && initialDurable.reason === "merged";
  }
  const trustedWorktree = mergedWorktreeAlreadyAbsent
    ? fs.realpathSync(record.repo.root)
    : assertTrustedRecoveryWorktree({
      repoRoot: record.repo.root,
      activeCheckout: activeCheckout || process.cwd(),
      relayWorktreeBase: relayWorktreeBase || runStore.relayWorktreeBase(),
      worktree: record.git.worktree,
    });
  if (closeIntent !== null && resolutionIntent !== null) {
    throw new Error("closeIntent and resolutionIntent are mutually exclusive");
  }
  if (closeIntent !== null) {
    if (!closeIntent || typeof closeIntent !== "object" || Array.isArray(closeIntent)
      || Object.keys(closeIntent).sort().join(",") !== "operator,reason"
      || typeof closeIntent.operator !== "string" || !closeIntent.operator.trim()
      || typeof closeIntent.reason !== "string" || !closeIntent.reason.trim()) {
      throw new Error("closeIntent must contain exactly non-empty operator and reason strings");
    }
    if (closeIntent.reason.trim() === "reviewed_result_ready") {
      throw Object.assign(
        new Error("reviewed_result_ready is reserved for canonical review-bound recovery"),
        { code: "RESERVED_CLOSE_REASON" },
      );
    }
    return withProductionRecoveryLock({
      runDir: canonicalRunDir, runId: record.run_id, worktree: trustedWorktree,
      reason: closeIntent.reason, breakLock,
    }, async (capability) => {
      const before = await inspectProductionRun({ runDir: canonicalRunDir, activeRunLock: capability });
      const closes = before.facts.filter((fact) => fact.type === "run_closed");
      const merges = before.facts.filter((fact) => fact.type === "merge_recorded");
      if (closes.length > 1 || merges.length > 1 || (closes.length && merges.length)
        || before.derived?.reason === "fact_conflict") {
        throw Object.assign(new Error("conflicting terminal merge/close facts require operator attention"), { code: "TERMINAL_FACT_CONFLICT" });
      }
      if (merges.length) throw Object.assign(new Error("a merged run cannot accept a close intent"), { code: "TERMINAL_FACT_CONFLICT" });
      if (closes.length) {
        const prior = closes[0].payload;
        if (prior.operator !== closeIntent.operator.trim() || prior.reason !== closeIntent.reason.trim()) {
          throw Object.assign(new Error("close intent conflicts with the immutable terminal fact"), { code: "TERMINAL_FACT_CONFLICT" });
        }
        return { before, after: before, closed: false, idempotent: true };
      }
      if (before.blockers?.some((item) => item.code === "snapshot_changed")) {
        throw Object.assign(new Error("run changed during close inspection; retry"), { code: "SNAPSHOT_CHANGED" });
      }
      const lastSha = before.derived?.head_sha || before.observations?.git?.head_sha || record.git.start_sha;
      const prNumber = before.derived?.pr_number || before.observations?.github?.pr_number || null;
      const payload = { reason: closeIntent.reason.trim(), operator: closeIntent.operator.trim(), last_sha: lastSha,
        pr_number: Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null };
      const eventId = `close-${sha256(JSON.stringify(stable({ run_id: record.run_id, payload }))).slice(0, 32)}`;
      factsModule.appendFact({ eventsPath: path.join(canonicalRunDir, "events.jsonl"), lockContext: capability,
        fact: { event_id: eventId, run_id: record.run_id, type: "run_closed", at: new Date().toISOString(), actor: payload.operator, payload } });
      const after = await inspectProductionRun({ runDir: canonicalRunDir, activeRunLock: capability });
      if (after.derived?.reason !== "closed" || after.derived?.terminal !== true) throw new Error("run close fact did not converge");
      return { before, after, closed: true, idempotent: false };
    });
  }
  if (resolutionIntent !== null) {
    if (!resolutionIntent || typeof resolutionIntent !== "object" || Array.isArray(resolutionIntent)
      || Object.keys(resolutionIntent).sort().join(",") !== "disposition,escalatedReviewEventId,operator,reason"
      || !new Set(["re_review", "redispatch"]).has(resolutionIntent.disposition)
      || typeof resolutionIntent.escalatedReviewEventId !== "string" || !resolutionIntent.escalatedReviewEventId.trim()
      || typeof resolutionIntent.operator !== "string" || !resolutionIntent.operator.trim()
      || typeof resolutionIntent.reason !== "string" || !resolutionIntent.reason.trim()) {
      throw new Error("resolutionIntent must contain an operator, reason, escalatedReviewEventId, and valid disposition");
    }
    const initial = await inspectProductionRun({ runDir: canonicalRunDir });
    return withProductionRecoveryLock({
      runDir: canonicalRunDir, runId: record.run_id, worktree: trustedWorktree,
      reason: resolutionIntent.reason, breakLock,
    }, async (capability) => {
      const before = await inspectProductionRun({ runDir: canonicalRunDir, activeRunLock: capability });
      const targetId = resolutionIntent.escalatedReviewEventId.trim();
      const existing = before.facts.filter((fact) => fact.type === "review_escalation_resolved"
        && fact.payload.escalated_review_event_id === targetId);
      if (existing.length) {
        const payload = existing[0].payload;
        if (existing.length !== 1 || payload.actor !== resolutionIntent.operator.trim()
          || payload.reason !== resolutionIntent.reason.trim()
          || payload.disposition !== resolutionIntent.disposition) {
          throw Object.assign(new Error("review escalation already has a conflicting resolution"), { code: "REVIEW_RESOLUTION_CONFLICT" });
        }
        return { before, after: before, resolved: false, idempotent: true };
      }
      if (initial.recommended_action.key !== before.recommended_action.key
        || (expectedActionKey && expectedActionKey !== before.recommended_action.key)) {
        throw Object.assign(new Error("review escalation changed before adjudication"), { code: "SNAPSHOT_CHANGED" });
      }
      const latestReview = before.facts.filter((fact) => fact.type === "review_recorded").at(-1);
      if (before.derived?.reason !== "review_escalated" || latestReview?.event_id !== targetId
        || latestReview.payload.escalation_kind !== "reviewer") {
        throw Object.assign(new Error("resolution target is not the latest reviewer escalation"), { code: "REVIEW_RESOLUTION_TARGET_INVALID" });
      }
      const payload = { actor: resolutionIntent.operator.trim(), reason: resolutionIntent.reason.trim(),
        disposition: resolutionIntent.disposition, escalated_review_event_id: targetId };
      const eventId = `review-resolution-${sha256(JSON.stringify(stable({ run_id: record.run_id, payload }))).slice(0, 32)}`;
      factsModule.appendFact({ eventsPath: path.join(canonicalRunDir, "events.jsonl"), lockContext: capability,
        fact: { event_id: eventId, run_id: record.run_id, type: "review_escalation_resolved",
          at: new Date().toISOString(), actor: payload.actor, payload } });
      const after = await inspectProductionRun({ runDir: canonicalRunDir, activeRunLock: capability });
      const expected = resolutionIntent.disposition === "re_review" ? "review" : "redispatch";
      if (after.derived?.action !== expected) throw new Error("review resolution fact did not converge");
      return { before, after, resolved: true, idempotent: false };
    });
  }
  let lockContext = null;
  const io = productionRecoveryIo(canonicalRunDir);
  const observer = (request) => observeProduction({
    ...request,
    verificationFile,
    activeRecoveryLock: lockContext,
  });
  return recoverRun({
    runDir: canonicalRunDir,
    observer,
    actor,
    reason,
    expectedActionKey,
    effects: createProductionEffects({ verificationFile, getLockContext: () => lockContext }),
    cleanupMerged: async (inspection) => {
      const mergeFact = inspection.facts.filter((fact) => fact.type === "merge_recorded").at(-1);
      if (!mergeFact) throw new Error("terminal merged run is missing merge provenance");
      return cleanupWorktree(record, mergeFact);
    },
    ...io,
    withLock: (callback) => withProductionRecoveryLock({
      runDir: canonicalRunDir,
      runId: record.run_id,
      worktree: trustedWorktree,
      reason,
      breakLock,
    }, async (capability) => {
      lockContext = capability;
      try {
        return await callback();
      } finally {
        lockContext = null;
      }
    }),
    appendFact: async (fact) => {
      if (!lockContext) throw new Error("recovery fact append requires the active run lock capability");
      return factsModule.appendFact({
        eventsPath: path.join(canonicalRunDir, "events.jsonl"),
        fact,
        lockContext,
      });
    },
  });
}
module.exports = {
  bindRecoverProduction,
  createProductionEffects,
  recoverProductionRun,
  withProductionRecoveryLock,
};
