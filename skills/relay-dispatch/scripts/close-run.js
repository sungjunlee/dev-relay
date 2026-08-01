#!/usr/bin/env node
// Operator recovery path for stale escalated runs (#165): close the stale run here,
// then retry resolution or re-dispatch with an explicit selector.

const path = require("path");
const { CLEANUP_STATUSES, runCleanup, updateManifestCleanup } = require("./manifest/cleanup");
const { execGit } = require("./exec");
const { STATES, updateManifestState } = require("./manifest/lifecycle");
const {
  getEventsPath,
  nowIso,
  summarizeFailure,
  validateManifestPaths,
} = require("./manifest/paths");
const { getActorName, writeManifest } = require("./manifest/store");
const { findUnknownFlags, modeLabel: formatCliModeLabel, readArg, schemaHasFlag } = require("./cli-args");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendEventLineToPath, appendRunEvent, EVENTS } = require("./relay-events");
const { assertNoLiveRunLease, corruptRunLeaseReportFields } = require("./run-runtime-state");

const args = process.argv.slice(2);
const CLI_ARG_OPTIONS = {
  reservedFlags: ["--repo", "--run-id", "--reason", "--force", "--dry-run", "--json", "--help", "-h"],
  booleanFlags: ["--force", "--dry-run", "--json", "--help", "-h"],
  verbatimValueFlags: ["--repo", "--reason"],
};
const hasCliFlag = (flag) => schemaHasFlag(args, flag, CLI_ARG_OPTIONS);

if (!args.length || hasCliFlag(["--help", "-h"])) {
  console.log("Usage: close-run.js --repo <path> --run-id <id> --reason <text> [--force] [--dry-run] [--json]");
  console.log("\nOptions:");
  console.log(`  --repo <path>    ${formatCliModeLabel("--repo", CLI_ARG_OPTIONS)} Repository root`);
  console.log(`  --run-id <id>    ${formatCliModeLabel("--run-id", CLI_ARG_OPTIONS)} Relay run identifier`);
  console.log(`  --reason <text>  ${formatCliModeLabel("--reason", CLI_ARG_OPTIONS)} Audit reason`);
  console.log(`  --force          ${formatCliModeLabel("--force", CLI_ARG_OPTIONS)} Override a live or unverifiable run lease`);
  console.log(`  --dry-run        ${formatCliModeLabel("--dry-run", CLI_ARG_OPTIONS)} Print result without writing`);
  console.log(`  --json           ${formatCliModeLabel("--json", CLI_ARG_OPTIONS)} Output JSON`);
  process.exit(hasCliFlag(["--help", "-h"]) ? 0 : 1);
}

function buildSkippedCleanupSummary(data, dryRun) {
  return {
    state: data.state,
    cleanupStatus: CLEANUP_STATUSES.SKIPPED,
    nextAction: "done",
    attemptedAt: null,
    dryRun,
    worktreePath: data.paths?.worktree || null,
    worktreeExistsBefore: null,
    worktreeRemoved: false,
    worktreeDirty: false,
    worktreeStatus: null,
    branch: data.git?.working_branch || null,
    branchExistedBefore: false,
    branchDeleted: false,
    pruneRan: false,
    deleteMergedBranch: false,
    error: null,
  };
}

function buildMissingWorktreeCleanupResult(repoRoot, data, dryRun) {
  const attemptedAt = nowIso();
  // The vanished directory can still be REGISTERED as a git worktree (external
  // rm -rf leaves the registration and keeps the branch marked checked out
  // there); prune clears the stale registration. A prune failure must surface
  // with runCleanup-style failure semantics, not be swallowed as success.
  let pruneRan = false;
  let pruneError = null;
  if (!dryRun) {
    try {
      execGit(repoRoot, ["worktree", "prune"]);
      pruneRan = true;
    } catch (error) {
      pruneError = `worktree prune failed for missing worktree: ${summarizeFailure(error)}`;
    }
  }
  const cleanupStatus = pruneError ? CLEANUP_STATUSES.FAILED : CLEANUP_STATUSES.SUCCEEDED;
  const nextAction = pruneError ? "manual_cleanup_required" : "done";
  const updatedData = updateManifestCleanup(data, {
    status: cleanupStatus,
    last_attempted_at: attemptedAt,
    cleaned_at: pruneError ? (data.cleanup?.cleaned_at || null) : attemptedAt,
    worktree_removed: true,
    branch_deleted: true,
    prune_ran: pruneRan,
    error: pruneError,
  }, nextAction);
  return {
    updatedData,
    summary: {
      state: data.state,
      cleanupStatus,
      nextAction,
      attemptedAt,
      dryRun,
      worktreePath: data.paths?.worktree || null,
      worktreeExistsBefore: false,
      worktreeRemoved: true,
      worktreeDirty: false,
      worktreeStatus: null,
      branch: data.git?.working_branch || null,
      branchExistedBefore: false,
      branchDeleted: true,
      pruneRan,
      deleteMergedBranch: false,
      error: pruneError,
    },
  };
}

function appendCloseEvent(repoRoot, runId, eventData) {
  if (eventData.worktree_missing !== true) {
    return appendRunEvent(repoRoot, runId, eventData);
  }
  return appendEventLineToPath(getEventsPath(repoRoot, runId), {
    ts: eventData.ts || new Date().toISOString(),
    event: eventData.event,
    actor: getActorName(repoRoot),
    run_id: runId,
    state_from: eventData.state_from ?? null,
    state_to: eventData.state_to ?? null,
    head_sha: eventData.head_sha ?? null,
    round: eventData.round ?? null,
    reason: eventData.reason ?? null,
    worktree_missing: true,
  });
}

function main() {
  const unknownFlags = findUnknownFlags(args, CLI_ARG_OPTIONS);
  if (unknownFlags.length) {
    throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  }

  const repoRoot = path.resolve(readArg(args, "--repo", undefined, CLI_ARG_OPTIONS) || ".");
  const runId = readArg(args, "--run-id", undefined, CLI_ARG_OPTIONS);
  const reason = readArg(args, "--reason", undefined, CLI_ARG_OPTIONS);
  const dryRun = hasCliFlag("--dry-run");
  const jsonOut = hasCliFlag("--json");
  const force = hasCliFlag("--force");

  if (!runId) {
    throw new Error("--run-id is required");
  }
  if (!reason) {
    throw new Error("--reason is required");
  }

  const { manifestPath, data, body } = resolveManifestRecord({ repoRoot, runId });
  const validatedPaths = validateManifestPaths(data.paths, {
    expectedRepoRoot: repoRoot,
    manifestPath,
    runId: data.run_id,
    allowMissingWorktree: true,
    caller: "close-run",
  });
  const safeData = {
    ...data,
    paths: {
      ...(data.paths || {}),
      repo_root: validatedPaths.repoRoot,
      worktree: validatedPaths.worktree,
    },
  };
  if (safeData.state === STATES.MERGED || safeData.state === STATES.CLOSED) {
    throw new Error(`close-run only supports active runs, got '${safeData.state}'`);
  }
  const leaseStatus = assertNoLiveRunLease({
    repoRoot,
    runId: safeData.run_id,
    force,
    caller: "close-run",
  });

  let updated = updateManifestState(safeData, STATES.CLOSED, "manual_cleanup_required");
  let cleanupResult = null;
  if ((updated.policy?.cleanup || "on_close") === "on_close") {
    cleanupResult = validatedPaths.worktreeMissing
      ? buildMissingWorktreeCleanupResult(repoRoot, updated, dryRun)
      : runCleanup({
          repoRoot,
          data: updated,
          dryRun,
          deleteMergedBranch: false,
        });
    updated = cleanupResult.updatedData;
  } else {
    updated = updateManifestCleanup(updated, { status: CLEANUP_STATUSES.SKIPPED }, "done");
    cleanupResult = {
      updatedData: updated,
      summary: buildSkippedCleanupSummary(updated, dryRun),
    };
  }

  if (!dryRun) {
    writeManifest(manifestPath, updated, body);
    appendCloseEvent(repoRoot, updated.run_id, {
      event: EVENTS.CLOSE,
      state_from: safeData.state,
      state_to: STATES.CLOSED,
      head_sha: updated.git?.head_sha || null,
      round: updated.review?.rounds || null,
      reason,
      ...(validatedPaths.worktreeMissing ? { worktree_missing: true } : {}),
    });
    appendRunEvent(repoRoot, updated.run_id, {
      event: EVENTS.CLEANUP_RESULT,
      state_from: updated.state,
      state_to: updated.state,
      head_sha: updated.git?.head_sha || null,
      round: updated.review?.rounds || null,
      reason: cleanupResult.summary.cleanupStatus === CLEANUP_STATUSES.SUCCEEDED
        ? "cleanup_succeeded"
        : cleanupResult.summary.error || cleanupResult.summary.cleanupStatus,
    });
  }

  const result = {
    manifestPath,
    runId: updated.run_id,
    previousState: safeData.state,
    state: updated.state,
    nextAction: updated.next_action,
    reason,
    cleanup: cleanupResult.summary,
    dryRun,
    force,
    ...corruptRunLeaseReportFields(leaseStatus),
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Closed relay run: ${manifestPath}`);
    console.log(`  State:        ${safeData.state} -> ${updated.state}`);
    console.log(`  Next action:  ${updated.next_action}`);
    console.log(`  Reason:       ${reason}`);
    console.log(`  Cleanup:      ${cleanupResult.summary.cleanupStatus}`);
    if (cleanupResult.summary.error) console.log(`  Cleanup note: ${cleanupResult.summary.error}`);
    if (dryRun) console.log("  dry-run:      no changes written");
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
