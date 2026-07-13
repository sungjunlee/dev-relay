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
  getRunDir,
  getWorktreeGitCommonDir,
  isPathContainedWithin,
  listManifestPaths,
  sameFilesystemLocation,
  summarizeFailure,
  validateManifestPaths,
} = require("./manifest/paths");
const {
  readManifest,
  writeManifest,
} = require("./manifest/store");
const { findUnknownFlags, modeLabel, readArg, schemaHasFlag } = require("./cli-args");
const { appendRunEvent, EVENTS } = require("./relay-events");
const { safeFormatRunId } = require("./relay-resolver");
const { assertNoLiveRunLease, corruptRunLeaseReportFields, reapAdvisoryLaneLeases } = require("./run-runtime-state");
const {
  DEFAULT_STALE_DAYS,
  assessRunWorktreeHealth,
} = require("./worktree-health");

const args = process.argv.slice(2);
const CLI_ARG_OPTIONS = { commandName: "cleanup-worktrees" };
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

function isRealpathContainedWithin(basePath, candidatePath) {
  try {
    const realBase = fs.realpathSync.native(basePath);
    const realCandidate = fs.realpathSync.native(candidatePath);
    return isPathContainedWithin(realBase, realCandidate);
  } catch {
    return false;
  }
}

function removeAdvisoryWorktreeDirectory(candidatePath, runDir) {
  if (!fs.existsSync(candidatePath)) {
    return true;
  }
  if (!isRealpathContainedWithin(runDir, candidatePath)) {
    throw new Error(`refusing rm fallback outside run advisory root: ${candidatePath}`);
  }
  fs.rmSync(candidatePath, { recursive: true, force: true });
  return !fs.existsSync(candidatePath);
}

/**
 * Prune stale advisory-lane worktrees under a terminal run's run dir.
 * Candidates must be realpath-contained under the run dir; when the checkout
 * still resolves, its git common dir must match the trust root.
 */
function pruneAdvisoryWorktreesForRun({
  repoRoot,
  runId,
  dryRun,
  expectedGitCommonDir,
}) {
  const runDir = getRunDir(repoRoot, runId);
  const advisoryRoot = path.join(runDir, "advisory-worktrees");
  const results = [];
  if (!fs.existsSync(advisoryRoot)) {
    return results;
  }

  let entries;
  try {
    entries = fs.readdirSync(advisoryRoot, { withFileTypes: true });
  } catch (error) {
    results.push({
      runId,
      path: advisoryRoot,
      classification: "refused",
      reason: "advisory_root_unreadable",
      error: summarizeFailure(error),
    });
    return results;
  }

  for (const entry of entries) {
    const candidate = path.join(advisoryRoot, entry.name);
    if (!isPathContainedWithin(runDir, candidate)) {
      results.push({
        runId,
        path: candidate,
        classification: "refused",
        reason: "outside_run_dir_advisory_root",
      });
      continue;
    }

    const candidateExists = fs.existsSync(candidate);
    if (candidateExists) {
      if (!isRealpathContainedWithin(runDir, candidate)) {
        results.push({
          runId,
          path: candidate,
          classification: "refused",
          reason: "realpath_outside_run_dir_advisory_root",
        });
        continue;
      }
      const candidateCommonDir = getWorktreeGitCommonDir(candidate);
      if (!candidateCommonDir) {
        results.push({
          runId,
          path: candidate,
          classification: "refused",
          reason: "unverifiable_git_common_dir",
        });
        continue;
      }
      const matchesTrustRoot = candidateCommonDir === expectedGitCommonDir
        || sameFilesystemLocation(candidateCommonDir, expectedGitCommonDir);
      if (!matchesTrustRoot) {
        results.push({
          runId,
          path: candidate,
          classification: "refused",
          reason: "foreign_git_common_dir",
        });
        continue;
      }
    }

    if (dryRun) {
      results.push({
        runId,
        path: candidate,
        classification: "pruned-planned",
        reason: "terminal_advisory_worktree",
      });
      continue;
    }

    let removed = !candidateExists;
    const errors = [];
    if (candidateExists) {
      try {
        execGit(repoRoot, ["worktree", "remove", "--force", candidate]);
        removed = !fs.existsSync(candidate);
      } catch (error) {
        try {
          execGit(repoRoot, ["worktree", "prune"]);
          removed = removeAdvisoryWorktreeDirectory(candidate, runDir);
          if (!removed) {
            errors.push(`advisory worktree still exists after fallback: ${candidate}`);
          }
        } catch (fallbackError) {
          errors.push(
            `worktree remove failed: ${summarizeFailure(error)}; ` +
            `rm fallback failed: ${summarizeFailure(fallbackError)}`
          );
        }
      }
    } else {
      try {
        execGit(repoRoot, ["worktree", "prune"]);
      } catch (error) {
        errors.push(`worktree prune failed: ${summarizeFailure(error)}`);
      }
    }

    if (errors.length || (candidateExists && fs.existsSync(candidate))) {
      results.push({
        runId,
        path: candidate,
        classification: "refused",
        reason: "advisory_prune_failed",
        error: errors.join("; ") || `advisory worktree still exists: ${candidate}`,
      });
      continue;
    }

    results.push({
      runId,
      path: candidate,
      classification: "owned",
      reason: "terminal_advisory_worktree_pruned",
    });
  }

  return results;
}

if (hasCliFlag(["--help", "-h"])) {
  console.log("Usage: cleanup-worktrees.js [options]");
  console.log("\nManifest-aware relay janitor for stale worktrees.");
  console.log("\nOptions:");
  console.log(`  --repo <path>          ${modeLabel("--repo")} Repository root (default: .)`);
  console.log(`  --older-than <hours>   ${modeLabel("--older-than")} Only consider runs older than N hours (default: 24)`);
  console.log(`  --all                  ${modeLabel("--all")} Ignore age threshold`);
  console.log(`  --dry-run              ${modeLabel("--dry-run")} Show what would be cleaned without writing`);
  console.log(`  --json                 ${modeLabel("--json")} Output as JSON`);
  console.log(`  --inspect              ${modeLabel("--inspect")} Health inventory only (no cleanup or shell sweep)`);
  console.log(`  --reconcile-merged     ${modeLabel("--reconcile-merged")} Reconcile merged drift for eligible non-terminal runs`);
  console.log(`  --stale-days <days>    ${modeLabel("--stale-days")} Stale classification threshold (default: ${DEFAULT_STALE_DAYS})`);
  console.log(`  --force                ${modeLabel("--force")} Override a live or unverifiable run lease when removing a worktree`);
  console.log(`  --force-terminal       ${modeLabel("--force-terminal")} Remove an unverifiable terminal worktree contained under the relay base`);
  process.exit(0);
}

function run() {
  const unknownFlags = findUnknownFlags(args, "cleanup-worktrees");
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
  const expectedGitCommonDir = getWorktreeGitCommonDir(repoRoot) || path.join(repoRoot, ".git");

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
    advisoryPruned: [],
    advisoryRefused: [],
  };

  const advisoryLaneReaps = [];

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

    // Terminal + age-eligible: prune advisory-lane worktrees even when the
    // executor worktree was already cleaned (they are not recorded in paths.worktree).
    const advisoryResults = pruneAdvisoryWorktreesForRun({
      repoRoot,
      runId: normalizedData.run_id,
      dryRun,
      expectedGitCommonDir,
    });
    for (const advisory of advisoryResults) {
      if (advisory.classification === "refused") {
        result.advisoryRefused.push(advisory);
      } else {
        result.advisoryPruned.push(advisory);
      }
    }

    // Terminal + age-eligible: reap any surviving advisory-lane process groups
    // recorded in per-attempt lane leases (#988). Non-terminal runs never reach here.
    // Isolate per-run: one throwing runDir (EACCES/EIO/ENOTDIR) must not abort
    // the sweep of remaining runs (#996).
    const runDir = getRunDir(repoRoot, normalizedData.run_id);
    try {
      const laneReaps = reapAdvisoryLaneLeases({ runDir, dryRun });
      for (const reap of laneReaps) {
        advisoryLaneReaps.push({
          ...reap,
          runId: normalizedData.run_id,
        });
      }
    } catch (error) {
      advisoryLaneReaps.push({
        runId: normalizedData.run_id,
        outcome: "sweep_error",
        error: summarizeFailure(error),
      });
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

  if (advisoryLaneReaps.length > 0) {
    result.advisoryLaneReaps = advisoryLaneReaps;
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
    console.log(`  advisory:   ${result.advisoryPruned.length} pruned, ${result.advisoryRefused.length} refused`);
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
    if (result.advisoryPruned.length) {
      console.log("  advisory pruned:");
      result.advisoryPruned.forEach((entry) => {
        console.log(`    ${entry.runId}: ${entry.classification} ${entry.path} (${entry.reason})`);
      });
    }
    if (result.advisoryRefused.length) {
      console.log("  advisory refused:");
      result.advisoryRefused.forEach((entry) => {
        console.log(`    ${entry.runId}: ${entry.classification} ${entry.path} (${entry.reason})`);
      });
    }
    if (advisoryLaneReaps.length) {
      console.log(`  advisory lane reaps: ${advisoryLaneReaps.length}`);
      advisoryLaneReaps.forEach((entry) => {
        console.log(`    ${entry.runId}: ${entry.outcome} pgid=${entry.pgid} reviewer=${entry.reviewer} round=${entry.round}`);
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
