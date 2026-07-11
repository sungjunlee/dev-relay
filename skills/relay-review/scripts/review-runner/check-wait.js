"use strict";

// Pre-review check-wait for review-runner `--wait-for-checks <seconds>` (#950).
//
// Two rounds in the 2026-07-11 arc were spent purely on pending post-publication
// CI checks with every Done Criterion already verified. This helper lets a review
// round WAIT for checks to leave the `pending` bucket before the primary reviewer
// is invoked (and before the check states are baked into the reviewer prompt),
// proceeding anyway once the budget is exhausted (proceeding-with-pending is the
// legal floor — never a hard block).
//
// When such a round proceeds with checks still pending AND its applied verdict is
// `changes_requested`, it stamps a machine-readable pending-checks marker anchored
// to the reviewed head into the manifest `review` section. Its sole consumer is
// recover-state's same-head checks-green re-entry route (Half 2). Without the flag
// this module is never engaged, so review output stays byte-identical to today.

const path = require("path");
const { classifyChecks, fetchChecks } = require("../../../relay-dispatch/scripts/wait-for-check");
const { writeText } = require("./common");

const DEFAULT_POLL_INTERVAL_MS = 12000;
const MAX_GH_RETRIES = 3;
const PENDING_CHECKS_MARKER_KEY = "pending_checks_marker";

function resolvePollIntervalMs() {
  const raw = Number(process.env.RELAY_REVIEW_CHECK_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_POLL_INTERVAL_MS;
}

// Returns null when the flag is absent; the parsed seconds otherwise. Throws on a
// malformed value so the round fails loudly rather than silently skipping the wait.
function parseWaitForChecksSeconds(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  const seconds = Number(rawValue);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("--wait-for-checks requires a non-negative number of seconds");
  }
  return seconds;
}

function blockingSleep(ms) {
  if (ms <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

// Poll a PR's checks until none are pending, or the budget is exhausted. Transient
// gh failures are tolerated (never abort the round); a persistent gh failure past
// the retry budget just proceeds with the checks state unknown.
function pollChecksUntilSettled({ repoPath, prNumber, budgetSeconds, intervalMs }, deps = {}) {
  const now = deps.now || Date.now;
  const wait = deps.sleep || blockingSleep;
  const getChecks = deps.fetchChecks || fetchChecks;
  const start = now();
  const deadline = start + Math.max(0, budgetSeconds) * 1000;
  let checks = [];
  let ghErrors = 0;
  let polls = 0;
  let settled = false;
  while (true) {
    polls += 1;
    let fetchError = null;
    try {
      checks = getChecks(repoPath, prNumber);
    } catch (error) {
      fetchError = error;
      ghErrors += 1;
    }
    if (!fetchError && classifyChecks(checks).pendingChecks.length === 0) {
      settled = true;
      break;
    }
    if (now() >= deadline || (fetchError && ghErrors > MAX_GH_RETRIES)) break;
    wait(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  const pendingChecks = classifyChecks(checks).pendingChecks;
  return {
    checks,
    pendingCheckNames: pendingChecks.map((check) => check.name),
    pending: !settled,
    budgetSeconds: Math.max(0, budgetSeconds),
    budgetExhausted: !settled && now() >= deadline,
    waitedMs: Math.max(0, now() - start),
    polls,
    ghErrors,
  };
}

function toResultSummary(outcome) {
  return {
    budget_seconds: outcome.budgetSeconds,
    waited_ms: outcome.waitedMs,
    waited_seconds: Math.round(outcome.waitedMs / 1000),
    budget_exhausted: outcome.budgetExhausted,
    proceeded_with_pending: outcome.pending,
    polls: outcome.polls,
    gh_errors: outcome.ghErrors,
    checks: outcome.checks,
    pending_checks: outcome.pendingCheckNames,
  };
}

// Runs the pre-review check wait when `--wait-for-checks` was supplied and a PR is
// available (post-publication rounds only). Returns null — a byte-identical no-op —
// otherwise. On engagement it records a round artifact and returns { outcome, summary }.
function maybeWaitForChecks({ internalReview, prepareOnly, prNumber, round, runDir, runRepoPath, waitForChecksArg }, deps = {}) {
  const budgetSeconds = parseWaitForChecksSeconds(waitForChecksArg);
  if (budgetSeconds === null) return null;
  if (prepareOnly || internalReview || !prNumber) return null;

  const outcome = pollChecksUntilSettled({
    repoPath: runRepoPath,
    prNumber,
    budgetSeconds,
    intervalMs: resolvePollIntervalMs(),
  }, deps);
  const summary = toResultSummary(outcome);
  writeText(
    path.join(runDir, `review-round-${round}-check-wait.json`),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  return { outcome, summary };
}

// Set or clear the pending-checks marker on a manifest `review` section. When the
// flag is inactive (checkWait === null) the section is returned untouched, keeping
// flagless behavior byte-identical. When active, the marker is a fresh per-round
// signal: present only while checks were still pending AND the applied verdict is
// changes_requested, cleared otherwise so the same-head route cannot be replayed.
function applyPendingChecksMarker(reviewSection, { appliedVerdict, checkWait, reviewedHeadSha, round }) {
  if (!checkWait) return reviewSection;
  const next = { ...(reviewSection || {}) };
  const shouldMark = checkWait.outcome.pending
    && appliedVerdict === "changes_requested"
    && Boolean(reviewedHeadSha);
  if (shouldMark) {
    next[PENDING_CHECKS_MARKER_KEY] = {
      head_sha: reviewedHeadSha,
      round,
      pending_checks: checkWait.outcome.pendingCheckNames,
      budget_seconds: checkWait.outcome.budgetSeconds,
      budget_exhausted: checkWait.outcome.budgetExhausted,
    };
  } else {
    delete next[PENDING_CHECKS_MARKER_KEY];
  }
  return next;
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  MAX_GH_RETRIES,
  PENDING_CHECKS_MARKER_KEY,
  applyPendingChecksMarker,
  maybeWaitForChecks,
  parseWaitForChecksSeconds,
  pollChecksUntilSettled,
  toResultSummary,
};
