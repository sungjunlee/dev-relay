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
 *   --inspect              Health inventory only (no cleanup or shell sweep)
 *   --reconcile-merged     Reconcile merged drift for eligible non-terminal runs
 *   --force-terminal      Remove unverifiable terminal worktrees contained under the relay base
 *   --stale-days <days>    Stale classification threshold (default: 14)
 */

const path = require("path");
const fs = require("fs");
const { forceUpdateManifestState, isTerminalState } = require("./manifest/lifecycle");
const {
  CLEANUP_STATUSES,
  runCleanup,
} = require("./manifest/cleanup");
const { execGit } = require("./exec");
const {
  getRelayWorktreeBase,
  isPathContainedWithin,
  listManifestPaths,
  validateManifestPaths,
} = require("./manifest/paths");
const {
  readManifest,
  writeManifest,
} = require("./manifest/store");
const { findUnknownFlags, modeLabel: formatCliModeLabel, readArg, schemaHasFlag } = require("./cli-args");
const { appendRunEvent, EVENTS } = require("./relay-events");
const { safeFormatRunId } = require("./relay-resolver");
const { assertNoLiveRunLease, corruptRunLeaseReportFields } = require("./run-runtime-state");
const {
  DEFAULT_STALE_DAYS,
  assessRunWorktreeHealth,
} = require("./worktree-health");

const args = process.argv.slice(2);
const CLI_ARG_OPTIONS = {
  reservedFlags: [
    "--repo", "--older-than", "--all", "--dry-run", "--json", "--inspect",
    "--reconcile-merged", "--stale-days", "--force", "--force-terminal", "--help", "-h",
  ],
  booleanFlags: ["--all", "--dry-run", "--json", "--inspect", "--reconcile-merged", "--force", "--force-terminal", "--help", "-h"],
  verbatimValueFlags: ["--repo"],
};
const hasCliFlag = (flag) => schemaHasFlag(args, flag, CLI_ARG_OPTIONS);
const OS_DETRITUS = new Set([".DS_Store", "Thumbs.db"]);

const VALIDATE_MANIFEST_CLEANUP_OPTS = {
  acceptPrunedRelayOwned: true,
  acceptVanishedRepoRootForCleanup: true,
  caller: "cleanup-worktrees",
};

function parseHours(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

function parsePositiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

function relayWorktreeChildPath(base, name) {
  const candidate = path.join(base, name);
  if (!isPathContainedWithin(base, candidate)) {
    throw new Error(`refusing to sweep outside relay worktree base: ${candidate}`);
  }
  return candidate;
}

function inspectShellContents(shellPath) {
  return fs.readdirSync(shellPath).map((name) => {
    const childPath = path.join(shellPath, name);
    const stat = fs.lstatSync(childPath);
    return { name, childPath, removable: OS_DETRITUS.has(name) && stat.isFile() };
  });
}

function reapShell(shellPath, removableEntries, { dryRun }) {
  if (dryRun) {
    console.warn(`cleanup-worktrees: dry-run would reap orphaned worktree shell ${shellPath}`);
    return true;
  }
  for (const entry of removableEntries) {
    fs.unlinkSync(entry.childPath);
  }
  fs.rmdirSync(shellPath);
  return !fs.existsSync(shellPath);
}

function sweepOrphanedWorktreeShells({ dryRun }) {
  const relayWorktreeBase = getRelayWorktreeBase();
  const result = { reaped: [], skipped: [] };
  if (!fs.existsSync(relayWorktreeBase)) return result;

  for (const name of fs.readdirSync(relayWorktreeBase)) {
    const shellPath = relayWorktreeChildPath(relayWorktreeBase, name);
    const shellStat = fs.lstatSync(shellPath);
    if (!shellStat.isDirectory()) continue;

    const contents = inspectShellContents(shellPath);
    const stray = contents.filter((entry) => !entry.removable);
    if (stray.length) {
      console.warn(`cleanup-worktrees: preserving ${shellPath}; contains ${stray.map((entry) => entry.name).join(", ")}`);
      result.skipped.push({ path: shellPath, reason: "non_detritus", entries: stray.map((entry) => entry.name) });
      continue;
    }

    if (reapShell(shellPath, contents, { dryRun })) {
      result.reaped.push({ path: shellPath, dryRun });
    }
  }
  return result;
}

if (hasCliFlag(["--help", "-h"])) {
  console.log("Usage: cleanup-worktrees.js [options]");
  console.log("\nManifest-aware relay janitor for stale worktrees.");
  console.log("\nOptions:");
  console.log(`  --repo <path>          ${formatCliModeLabel("--repo", CLI_ARG_OPTIONS)} Repository root (default: .)`);
  console.log(`  --older-than <hours>   ${formatCliModeLabel("--older-than", CLI_ARG_OPTIONS)} Only consider runs older than N hours (default: 24)`);
  console.log(`  --all                  ${formatCliModeLabel("--all", CLI_ARG_OPTIONS)} Ignore age threshold`);
  console.log(`  --dry-run              ${formatCliModeLabel("--dry-run", CLI_ARG_OPTIONS)} Show what would be cleaned without writing`);
  console.log(`  --json                 ${formatCliModeLabel("--json", CLI_ARG_OPTIONS)} Output as JSON`);
  console.log(`  --inspect              ${formatCliModeLabel("--inspect", CLI_ARG_OPTIONS)} Health inventory only (no cleanup or shell sweep)`);
  console.log(`  --reconcile-merged     ${formatCliModeLabel("--reconcile-merged", CLI_ARG_OPTIONS)} Reconcile merged drift for eligible non-terminal runs`);
  console.log(`  --stale-days <days>    ${formatCliModeLabel("--stale-days", CLI_ARG_OPTIONS)} Stale classification threshold (default: ${DEFAULT_STALE_DAYS})`);
  console.log(`  --force                ${formatCliModeLabel("--force", CLI_ARG_OPTIONS)} Override a live or unverifiable run lease when removing a worktree`);
  console.log(`  --force-terminal       ${formatCliModeLabel("--force-terminal", CLI_ARG_OPTIONS)} Remove an unverifiable terminal worktree contained under the relay base`);
  process.exit(0);
}

function run() {
  const unknownFlags = findUnknownFlags(args, CLI_ARG_OPTIONS);
  if (unknownFlags.length) {
    throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  }

  const repoRoot = path.resolve(readArg(args, "--repo", ".", CLI_ARG_OPTIONS));
  const dryRun = hasCliFlag("--dry-run");
  const all = hasCliFlag("--all");
  const jsonOut = hasCliFlag("--json");
  const inspectOnly = hasCliFlag("--inspect");
  const reconcileMerged = hasCliFlag("--reconcile-merged");
  const force = hasCliFlag("--force");
  const forceTerminal = hasCliFlag("--force-terminal");
  const staleDays = parsePositiveNumber(readArg(args, "--stale-days", String(DEFAULT_STALE_DAYS), CLI_ARG_OPTIONS), "--stale-days");
  const olderThanHours = all ? 0 : parseHours(readArg(args, "--older-than", "24", CLI_ARG_OPTIONS), "--older-than");
  const now = Date.now();
  const cutoff = now - olderThanHours * 60 * 60 * 1000;

  const result = {
    repoRoot,
    olderThanHours,
    staleDays,
    dryRun,
    force,
    forceTerminal,
    all,
    inspectOnly,
    reconcileMerged,
    cleaned: [],
    reconciled: [],
    failed: [],
    staleOpen: [],
    skipped: [],
    inventory: [],
    reapedShells: [],
    skippedShells: [],
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
      prNumber: data.git?.pr_number || null,
      ageHours,
      cleanupStatus,
      closeCommand: `node skills/relay-dispatch/scripts/close-run.js --repo ${JSON.stringify(repoRoot)} --run-id ${JSON.stringify(runId)} --reason ${JSON.stringify("stale_non_terminal_run")}`,
    };

    const terminalState = isTerminalState(data.state);
    let normalizedData = data;
    let forcedTerminalUnverifiable = false;
    try {
      const validatedPaths = validateManifestPaths(data.paths, {
        expectedRepoRoot: repoRoot,
        manifestPath,
        runId: data.run_id,
        allowMissingWorktree: terminalState,
        acceptMissingRelayContainedForCleanup: terminalState,
        acceptUnverifiableRelayContainedForCleanup: terminalState && forceTerminal,
        ...VALIDATE_MANIFEST_CLEANUP_OPTS,
      });
      forcedTerminalUnverifiable = Boolean(validatedPaths.unverifiableRelayContainedForCleanup);
      normalizedData = {
        ...data,
        paths: {
          ...(data.paths || {}),
          repo_root: validatedPaths.repoRoot,
          worktree: validatedPaths.worktree,
        },
      };
    } catch (error) {
      let terminalForceEligible = false;
      if (terminalState) {
        try {
          const forceValidatedPaths = validateManifestPaths(data.paths, {
            expectedRepoRoot: repoRoot,
            manifestPath,
            runId: data.run_id,
            allowMissingWorktree: true,
            acceptMissingRelayContainedForCleanup: true,
            acceptUnverifiableRelayContainedForCleanup: true,
            ...VALIDATE_MANIFEST_CLEANUP_OPTS,
          });
          terminalForceEligible = Boolean(forceValidatedPaths.unverifiableRelayContainedForCleanup);
        } catch {
          terminalForceEligible = false;
        }
      }
      const sanitizedError = /run_id must be a single path segment/.test(String(error.message || ""))
        ? `cleanup-worktrees: manifest ${JSON.stringify(path.basename(manifestPath))} has an invalid stored run_id; inspect the manifest before retrying.`
        : error.message;
      result.failed.push({
        ...baseInfo,
        nextAction: terminalForceEligible ? "retry_with_force_terminal" : "inspect_manifest_paths",
        worktreeRemoved: false,
        branchDeleted: false,
        pruneRan: false,
        reason: terminalForceEligible
          ? "terminal_unverifiable_requires_force"
          : (terminalState ? "refused_terminal_manifest_paths" : "refused_non_terminal_manifest_paths"),
        classification: terminalForceEligible
          ? "cleanable_terminal_unverifiable_path"
          : "refused_manifest_paths",
        error: sanitizedError,
      });
      continue;
    }

    const health = assessRunWorktreeHealth({
      repoRoot,
      data: normalizedData,
      worktreePath: normalizedData.paths?.worktree || null,
      staleDays,
    });
    const enrichedBaseInfo = {
      ...baseInfo,
      health,
    };

    if (inspectOnly) {
      result.inventory.push({
        ...enrichedBaseInfo,
        reason: health.finishPath,
      });
      continue;
    }

    if (
      reconcileMerged
      && health.reconcileEligible
    ) {
      let leaseStatus = null;
      try {
        leaseStatus = assertNoLiveRunLease({
          repoRoot,
          runId: normalizedData.run_id,
          force,
          caller: "cleanup-worktrees",
        });
      } catch (error) {
        result.failed.push({
          ...enrichedBaseInfo,
          cleanupStatus: CLEANUP_STATUSES.FAILED,
          nextAction: "reconcile_run_or_force_cleanup",
          worktreeRemoved: false,
          branchDeleted: false,
          pruneRan: false,
          error: error.message,
          reason: "live_lease",
        });
        continue;
      }
      const leaseReport = corruptRunLeaseReportFields(leaseStatus);

      let reconcileData = normalizedData;
      if (!dryRun) {
        reconcileData = forceUpdateManifestState(
          normalizedData,
          "merged",
          "manual_cleanup_required",
          {
            reason: "janitor_reconcile_merged",
            operator: "cleanup-worktrees",
          }
        );
        writeManifest(manifestPath, reconcileData, body);
        appendRunEvent(repoRoot, reconcileData.run_id, {
          event: EVENTS.STATE_RECOVERY,
          state_from: normalizedData.state,
          state_to: reconcileData.state,
          head_sha: reconcileData.git?.head_sha || null,
          round: reconcileData.review?.rounds || null,
          reason: "janitor_reconcile_merged",
        });
      }

      const cleanupResult = runCleanup({
        repoRoot,
        data: reconcileData,
        dryRun,
        deleteMergedBranch: true,
        acceptPrunedRelayOwned: true,
        acceptVanishedRepoRootForCleanup: true,
      });

      const item = {
        ...enrichedBaseInfo,
        ...leaseReport,
        state: dryRun ? normalizedData.state : reconcileData.state,
        cleanupStatus: cleanupResult.summary.cleanupStatus,
        nextAction: cleanupResult.summary.nextAction,
        worktreeRemoved: cleanupResult.summary.worktreeRemoved,
        branchDeleted: cleanupResult.summary.branchDeleted,
        pruneRan: cleanupResult.summary.pruneRan,
        error: cleanupResult.summary.error,
        reason: "reconcile_merged",
      };

      if (!dryRun) {
        writeManifest(manifestPath, cleanupResult.updatedData, body);
        appendRunEvent(repoRoot, cleanupResult.updatedData.run_id, {
          event: EVENTS.CLEANUP_RESULT,
          state_from: cleanupResult.updatedData.state,
          state_to: cleanupResult.updatedData.state,
          head_sha: cleanupResult.updatedData.git?.head_sha || null,
          round: cleanupResult.updatedData.review?.rounds || null,
          reason: cleanupResult.summary.cleanupStatus === CLEANUP_STATUSES.SUCCEEDED
            ? "reconcile_cleanup_succeeded"
            : cleanupResult.summary.error,
        });
      }

      if (cleanupResult.summary.cleanupStatus === CLEANUP_STATUSES.SUCCEEDED) {
        result.reconciled.push(item);
      } else {
        result.failed.push(item);
      }
      continue;
    }

    if (!all && updatedAt && updatedAt > cutoff) {
      result.skipped.push({ ...enrichedBaseInfo, reason: "recent" });
      continue;
    }

    if (!isTerminalState(normalizedData.state)) {
      const staleReason = health.stale ? "stale_non_terminal" : "non-terminal";
      result.staleOpen.push({
        ...enrichedBaseInfo,
        reason: staleReason,
      });
      continue;
    }

    if (cleanupStatus === CLEANUP_STATUSES.SUCCEEDED) {
      result.skipped.push({ ...enrichedBaseInfo, reason: "already_cleaned" });
      continue;
    }

    let leaseStatus = null;
    try {
      leaseStatus = assertNoLiveRunLease({
        repoRoot,
        runId: normalizedData.run_id,
        force,
        caller: "cleanup-worktrees",
      });
    } catch (error) {
      result.failed.push({
        ...enrichedBaseInfo,
        cleanupStatus: CLEANUP_STATUSES.FAILED,
        nextAction: "reconcile_run_or_force_cleanup",
        worktreeRemoved: false,
        branchDeleted: false,
        pruneRan: false,
        error: error.message,
        reason: "live_lease",
      });
      continue;
    }
    const leaseReport = corruptRunLeaseReportFields(leaseStatus);

    const cleanupResult = runCleanup({
      repoRoot,
      data: normalizedData,
      dryRun,
      deleteMergedBranch: normalizedData.state === "merged",
      acceptPrunedRelayOwned: true,
      allowMissingWorktree: true,
      acceptMissingRelayContainedForCleanup: true,
      acceptUnverifiableRelayContainedForCleanup: forcedTerminalUnverifiable,
      acceptVanishedRepoRootForCleanup: true,
    });

    const item = {
      ...enrichedBaseInfo,
      ...leaseReport,
      cleanupStatus: cleanupResult.summary.cleanupStatus,
      nextAction: cleanupResult.summary.nextAction,
      worktreeRemoved: cleanupResult.summary.worktreeRemoved,
      branchDeleted: cleanupResult.summary.branchDeleted,
      pruneRan: cleanupResult.summary.pruneRan,
      error: cleanupResult.summary.error,
      classification: forcedTerminalUnverifiable
        ? "cleanable_terminal_unverifiable_path"
        : "owned",
      ...(forcedTerminalUnverifiable
        ? {
          reason: "forced_terminal_unverifiable_path",
        }
        : {
          reason: "owned_relay_worktree",
        }),
    };

    if (!dryRun) {
      writeManifest(manifestPath, cleanupResult.updatedData, body);
      appendRunEvent(repoRoot, cleanupResult.updatedData.run_id, {
        event: EVENTS.CLEANUP_RESULT,
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

  if (!inspectOnly) {
    const shellSweep = sweepOrphanedWorktreeShells({ dryRun });
    result.reapedShells = shellSweep.reaped;
    result.skippedShells = shellSweep.skipped;
  }

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Relay janitor: ${repoRoot}`);
    if (inspectOnly) {
      console.log(`  inspect:    ${result.inventory.length} runs`);
    }
    console.log(`  cleaned:    ${result.cleaned.length}`);
    console.log(`  reconciled: ${result.reconciled.length}`);
    console.log(`  failed:     ${result.failed.length}`);
    console.log(`  stale open: ${result.staleOpen.length}`);
    console.log(`  skipped:    ${result.skipped.length}`);
    if (result.failed.length) {
      console.log("  failures:");
      result.failed.forEach((entry) => console.log(`    ${entry.runId}: ${entry.error}`));
    }
    if (result.staleOpen.length) {
      console.log("  stale open runs:");
      result.staleOpen.forEach((entry) => {
        const finishPath = entry.health?.finishPath || "unknown";
        console.log(`    ${entry.runId} (${entry.state}, ${entry.ageHours ?? "?"}h old, ${finishPath}) -> ${entry.health?.recommendedAction || entry.closeCommand}`);
      });
    }
    if (inspectOnly && result.inventory.length) {
      console.log("  inventory:");
      result.inventory.forEach((entry) => {
        console.log(`    ${entry.runId} (${entry.state}, ${entry.health.finishPath}) -> ${entry.health.recommendedAction}`);
      });
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
