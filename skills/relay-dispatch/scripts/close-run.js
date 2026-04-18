#!/usr/bin/env node
// Operator recovery path for stale escalated runs (#165): close the stale run here,
// then retry resolution or re-dispatch with an explicit selector.

const path = require("path");
const { CLEANUP_STATUSES, runCleanup, updateManifestCleanup } = require("./manifest/cleanup");
const { STATES, updateManifestState } = require("./manifest/lifecycle");
const {
  validateManifestPaths,
} = require("./manifest/paths");
const { writeManifest } = require("./manifest/store");
const { getArg, hasFlag } = require("./cli-args");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent } = require("./relay-events");

const args = process.argv.slice(2);
const RESERVED = { reservedFlags: ["-h"] };

if (!args.length || hasFlag(args, ["--help", "-h"])) {
  console.log("Usage: close-run.js --repo <path> --run-id <id> --reason <text> [--dry-run] [--json]");
  process.exit(hasFlag(args, ["--help", "-h"]) ? 0 : 1);
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

function main() {
  const repoRoot = path.resolve(getArg(args, "--repo", undefined, RESERVED) || ".");
  const runId = getArg(args, "--run-id", undefined, RESERVED);
  const reason = getArg(args, "--reason", undefined, RESERVED);
  const dryRun = hasFlag(args, "--dry-run");
  const jsonOut = hasFlag(args, "--json");
  const gitBin = process.env.RELAY_GIT_BIN || "git";

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

  let updated = updateManifestState(safeData, STATES.CLOSED, "manual_cleanup_required");
  let cleanupResult = null;
  if ((updated.policy?.cleanup || "on_close") === "on_close") {
    cleanupResult = runCleanup({
      repoRoot,
      data: updated,
      gitBin,
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
    appendRunEvent(repoRoot, updated.run_id, {
      event: "close",
      state_from: safeData.state,
      state_to: STATES.CLOSED,
      head_sha: updated.git?.head_sha || null,
      round: updated.review?.rounds || null,
      reason,
    });
    appendRunEvent(repoRoot, updated.run_id, {
      event: "cleanup_result",
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
