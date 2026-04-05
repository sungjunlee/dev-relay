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
const {
  CLEANUP_STATUSES,
  isTerminalState,
  listManifestPaths,
  readManifest,
  runCleanup,
  writeManifest,
} = require("./relay-manifest");
const { appendRunEvent } = require("./relay-events");

const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(flag);
}

function getArg(flag, fallback) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return fallback;
  const value = args[index + 1];
  return value.startsWith("--") ? fallback : value;
}

function parseHours(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

if (hasFlag("--help") || hasFlag("-h")) {
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
  const repoRoot = path.resolve(getArg("--repo", "."));
  const dryRun = hasFlag("--dry-run");
  const all = hasFlag("--all");
  const jsonOut = hasFlag("--json");
  const gitBin = process.env.RELAY_GIT_BIN || "git";
  const olderThanHours = all ? 0 : parseHours(getArg("--older-than", "24"), "--older-than");
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
    const baseInfo = {
      manifestPath,
      runId: data.run_id || path.basename(manifestPath, ".md"),
      state: data.state,
      branch: data.git?.working_branch || null,
      worktree: data.paths?.worktree || null,
      ageHours,
      cleanupStatus,
      closeCommand: `node skills/relay-dispatch/scripts/close-run.js --repo ${JSON.stringify(repoRoot)} --run-id ${JSON.stringify(data.run_id || path.basename(manifestPath, ".md"))} --reason ${JSON.stringify("stale_non_terminal_run")}`,
    };

    if (!all && updatedAt && updatedAt > cutoff) {
      result.skipped.push({ ...baseInfo, reason: "recent" });
      continue;
    }

    if (!isTerminalState(data.state)) {
      result.staleOpen.push({ ...baseInfo, reason: "non-terminal" });
      continue;
    }

    if (cleanupStatus === CLEANUP_STATUSES.SUCCEEDED) {
      result.skipped.push({ ...baseInfo, reason: "already_cleaned" });
      continue;
    }

    const cleanupResult = runCleanup({
      repoRoot,
      data,
      gitBin,
      dryRun,
      deleteMergedBranch: data.state === "merged",
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
