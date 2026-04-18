#!/usr/bin/env node
/**
 * Manifest-aware relay janitor for stale worktrees.
 *
 * Usage: ./cleanup-worktrees.js [options]
 *
 * Options:
 *   --repo <path>          Repository root (default: .)
 *   --older-than <hours>   Only consider runs older than N hours (default: 24)
 *   --all                  Ignore age threshold
 *   --dry-run              Show what would be cleaned without writing
 *   --json                 Output as JSON
 */

const path = require("path");
const { isTerminalState } = require("./manifest/lifecycle");
const {
  CLEANUP_STATUSES,
  runCleanup,
} = require("./manifest/cleanup");
const { listManifestPaths, validateManifestPaths } = require("./manifest/paths");
const {
  readManifest,
  writeManifest,
} = require("./manifest/store");
const { getArg, hasFlag } = require("./cli-args");
const { appendRunEvent } = require("./relay-events");
const { safeFormatRunId } = require("./relay-resolver");

const args = process.argv.slice(2);

function parseHours(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

if (hasFlag(args, ["--help", "-h"])) {
  console.log("Usage: cleanup-worktrees.js [options]");
  console.log("\nManifest-aware relay janitor for stale worktrees.");
  console.log("\nOptions:");
  console.log("  --repo <path>          Repository root (default: .)");
  console.log("  --older-than <hours>   Only consider runs older than N hours (default: 24)");
  console.log("  --all                  Ignore age threshold");
  console.log("  --dry-run              Show what would be cleaned without writing");
  console.log("  --json                 Output as JSON");
  process.exit(0);
}

function run() {
  const repoRoot = path.resolve(getArg(args, "--repo", "."));
  const dryRun = hasFlag(args, "--dry-run");
  const all = hasFlag(args, "--all");
  const jsonOut = hasFlag(args, "--json");
  const gitBin = process.env.RELAY_GIT_BIN || "git";
  const olderThanHours = all ? 0 : parseHours(getArg(args, "--older-than", "24"), "--older-than");
  const now = Date.now();
  const cutoff = now - olderThanHours * 60 * 60 * 1000;

  const result = {
    repoRoot,
    olderThanHours,
    dryRun,
    all,
    cleaned: [],
    failed: [],
    staleOpen: [],
    skipped: [],
  };

  const manifestPaths = listManifestPaths(repoRoot);
  for (const manifestPath of manifestPaths) {
    const { data, body } = readManifest(manifestPath);
    const updatedAt = Date.parse(data.timestamps?.updated_at || data.timestamps?.created_at || 0);
    const ageHours = updatedAt ? Math.round((now - updatedAt) / (60 * 60 * 1000)) : null;
    const cleanupStatus = data.cleanup?.status || CLEANUP_STATUSES.PENDING;
    // safeFormatRunId falls back to the manifest basename on tampered run_id so cleanup still
    // enumerates stale runs defensively; JSON.stringify keeps the closeCommand shell-safe.
    const runId = safeFormatRunId({ manifestPath, data });
    const baseInfo = {
      manifestPath,
      runId,
      state: data.state,
      branch: data.git?.working_branch || null,
      worktree: data.paths?.worktree || null,
      ageHours,
      cleanupStatus,
      closeCommand: `node skills/relay-dispatch/scripts/close-run.js --repo ${JSON.stringify(repoRoot)} --run-id ${JSON.stringify(runId)} --reason ${JSON.stringify("stale_non_terminal_run")}`,
    };

    let normalizedData = data;
    try {
      const validatedPaths = validateManifestPaths(data.paths, {
        expectedRepoRoot: repoRoot,
        manifestPath,
        runId: data.run_id,
        caller: "cleanup-worktrees",
      });
      normalizedData = {
        ...data,
        paths: {
          ...(data.paths || {}),
          repo_root: validatedPaths.repoRoot,
          worktree: validatedPaths.worktree,
        },
      };
    } catch (error) {
      const sanitizedError = /run_id must be a single path segment/.test(String(error.message || ""))
        ? `cleanup-worktrees: manifest ${JSON.stringify(path.basename(manifestPath))} has an invalid stored run_id; inspect the manifest before retrying.`
        : error.message;
      result.failed.push({
        ...baseInfo,
        nextAction: "inspect_manifest_paths",
        worktreeRemoved: false,
        branchDeleted: false,
        pruneRan: false,
        error: sanitizedError,
      });
      continue;
    }

    if (!all && updatedAt && updatedAt > cutoff) {
      result.skipped.push({ ...baseInfo, reason: "recent" });
      continue;
    }

    if (!isTerminalState(normalizedData.state)) {
      result.staleOpen.push({ ...baseInfo, reason: "non-terminal" });
      continue;
    }

    if (cleanupStatus === CLEANUP_STATUSES.SUCCEEDED) {
      result.skipped.push({ ...baseInfo, reason: "already_cleaned" });
      continue;
    }

    const cleanupResult = runCleanup({
      repoRoot,
      data: normalizedData,
      gitBin,
      dryRun,
      deleteMergedBranch: normalizedData.state === "merged",
    });

    const item = {
      ...baseInfo,
      cleanupStatus: cleanupResult.summary.cleanupStatus,
      nextAction: cleanupResult.summary.nextAction,
      worktreeRemoved: cleanupResult.summary.worktreeRemoved,
      branchDeleted: cleanupResult.summary.branchDeleted,
      pruneRan: cleanupResult.summary.pruneRan,
      error: cleanupResult.summary.error,
    };

    if (!dryRun) {
      writeManifest(manifestPath, cleanupResult.updatedData, body);
      appendRunEvent(repoRoot, cleanupResult.updatedData.run_id, {
        event: "cleanup_result",
        state_from: cleanupResult.updatedData.state,
        state_to: cleanupResult.updatedData.state,
        head_sha: cleanupResult.updatedData.git?.head_sha || null,
        round: cleanupResult.updatedData.review?.rounds || null,
        reason: cleanupResult.summary.cleanupStatus === CLEANUP_STATUSES.SUCCEEDED
          ? "cleanup_succeeded"
          : cleanupResult.summary.error,
      });
    }

    if (cleanupResult.summary.cleanupStatus === CLEANUP_STATUSES.SUCCEEDED) {
      result.cleaned.push(item);
    } else {
      result.failed.push(item);
    }
  }

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Relay janitor: ${repoRoot}`);
    console.log(`  cleaned:    ${result.cleaned.length}`);
    console.log(`  failed:     ${result.failed.length}`);
    console.log(`  stale open: ${result.staleOpen.length}`);
    console.log(`  skipped:    ${result.skipped.length}`);
    if (result.failed.length) {
      console.log("  failures:");
      result.failed.forEach((entry) => console.log(`    ${entry.runId}: ${entry.error}`));
    }
    if (result.staleOpen.length) {
      console.log("  stale open runs:");
      result.staleOpen.forEach((entry) => console.log(`    ${entry.runId} (${entry.state}, ${entry.ageHours ?? "?"}h old) -> ${entry.closeCommand}`));
    }
    if (dryRun) {
      console.log("  dry-run: no changes written");
    }
  }
}

try {
  run();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
