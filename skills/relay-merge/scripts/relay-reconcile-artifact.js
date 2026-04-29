#!/usr/bin/env node
/**
 * Reconcile a bootstrap artifact writer run that predates the artifact it now
 * needs for normal merge finalization.
 *
 * Usage:
 *   relay-reconcile-artifact --repo <path> --run-id <id> --artifact-path <path> --writer-pr <int> --reason <text> [options]
 *   relay-reconcile-artifact --manifest <path> --artifact-path <path> --writer-pr <int> --reason <text> [options]
 *
 * Options:
 *   --repo <path>          Repository root (default: .)
 *   --run-id <id>          Relay run identifier
 *   --manifest <path>      Explicit manifest path
 *   --branch <name>        Resolve an active run by branch
 *   --pr <number>          Resolve an active run by stored PR number
 *   --artifact-path <path> Required artifact path being reconciled
 *   --writer-pr <int>      Required PR number that introduced the writer
 *   --reason <text>        Required audit reason
 *   --skip-review <reason> Optional audit event for intentional review bypass
 *   --json                 Output JSON
 *   --help, -h             Show usage
 */

const path = require("path");
const {
  getExpectedManifestRepoRoot,
  parsePositiveInt,
  validateManifestPaths,
} = require("../../relay-dispatch/scripts/manifest/paths");
const {
  STATES,
  forceUpdateManifestState,
} = require("../../relay-dispatch/scripts/manifest/lifecycle");
const {
  getActorName,
  writeManifest,
} = require("../../relay-dispatch/scripts/manifest/store");
const { resolveManifestRecord } = require("../../relay-dispatch/scripts/relay-resolver");
const { appendRunEvent, EVENTS } = require("../../relay-dispatch/scripts/relay-events");
const { bindCliArgs } = require("../../relay-dispatch/scripts/cli-args");

const args = process.argv.slice(2);
const KNOWN_FLAGS = [
  "--repo", "--run-id", "--manifest", "--branch", "--pr",
  "--artifact-path", "--writer-pr", "--reason", "--skip-review",
  "--json", "--help", "-h",
];
const { getArg, hasFlag } = bindCliArgs(args, {
  commandName: "relay-reconcile-artifact",
  reservedFlags: KNOWN_FLAGS,
});

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: relay-reconcile-artifact (--repo <path> --run-id <id> | --manifest <path>) --artifact-path <path> --writer-pr <int> --reason <text> [options]");
  console.log("\nMark a non-terminal bootstrap run merged after its required artifact writer lands.");
  console.log("\nOptions:");
  console.log("  --repo <path>          Repository root (default: .)");
  console.log("  --run-id <id>          Relay run identifier");
  console.log("  --manifest <path>      Explicit manifest path");
  console.log("  --branch <name>        Resolve an active run by branch");
  console.log("  --pr <number>          Resolve an active run by stored PR number");
  console.log("  --artifact-path <path> Required artifact path being reconciled");
  console.log("  --writer-pr <int>      Required PR number that introduced the writer");
  console.log("  --reason <text>        Required audit reason");
  console.log("  --skip-review <reason> Optional audit event for intentional review bypass");
  console.log("  --json                 Output JSON");
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

function requireNonEmptyArg(flag, label) {
  const value = getArg(flag);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function sameBootstrapExemption(data, { artifactPath, writerPr, reason }) {
  const existing = data?.bootstrap_exempt || {};
  return (
    existing.enabled === true
    && existing.artifact_path === artifactPath
    && Number(existing.writer_pr) === writerPr
    && existing.reason === reason
  );
}

function main() {
  const artifactPath = requireNonEmptyArg("--artifact-path", "--artifact-path <path>");
  const writerPr = parsePositiveInt(requireNonEmptyArg("--writer-pr", "--writer-pr <int>"), "--writer-pr <int>");
  const reason = requireNonEmptyArg("--reason", "--reason <text>");
  const skipReviewReason = getArg("--skip-review");
  if (hasFlag("--skip-review") && !String(skipReviewReason || "").trim()) {
    throw new Error("--skip-review <reason> is required when --skip-review is used");
  }

  const repoArg = getArg("--repo");
  let repoPath = path.resolve(repoArg || ".");
  const manifestArg = getArg("--manifest");
  const runId = getArg("--run-id");
  const branch = getArg("--branch");
  const prNumber = getArg("--pr") === undefined
    ? undefined
    : parsePositiveInt(getArg("--pr"), "--pr");
  const jsonOut = hasFlag("--json");

  let manifestRecord = resolveManifestRecord({
    repoRoot: repoPath,
    manifestPath: manifestArg,
    runId,
    branch,
    prNumber,
    includeTerminal: true,
  });
  const selectorExpectedRepoRoot = manifestArg
    ? undefined
    : getExpectedManifestRepoRoot(repoPath, repoArg);
  let validatedPaths = validateManifestPaths(manifestRecord.data?.paths, {
    expectedRepoRoot: selectorExpectedRepoRoot,
    manifestPath: manifestRecord.manifestPath,
    runId: manifestRecord.data?.run_id,
    caller: "relay-reconcile-artifact",
  });
  repoPath = validatedPaths.repoRoot;
  if ((manifestArg || runId) && !repoArg) {
    manifestRecord = resolveManifestRecord({
      repoRoot: repoPath,
      manifestPath: manifestArg,
      runId,
      branch,
      prNumber,
      includeTerminal: true,
    });
    validatedPaths = validateManifestPaths(manifestRecord.data?.paths, {
      expectedRepoRoot: manifestArg ? undefined : repoPath,
      manifestPath: manifestRecord.manifestPath,
      runId: manifestRecord.data?.run_id,
      caller: "relay-reconcile-artifact",
    });
  }

  const { manifestPath, data, body } = manifestRecord;
  const safeData = {
    ...data,
    paths: {
      ...(data.paths || {}),
      repo_root: validatedPaths.repoRoot,
      worktree: validatedPaths.worktree,
    },
  };

  if (safeData.state === STATES.CLOSED) {
    throw new Error(`force-finalize cannot be used from terminal state ${safeData.state}`);
  }
  const requestedBootstrapExemption = {
    enabled: true,
    artifact_path: artifactPath,
    writer_pr: writerPr,
    reason,
  };
  if (safeData.state === STATES.MERGED) {
    if (sameBootstrapExemption(safeData, { artifactPath, writerPr, reason })) {
      const result = {
        manifestPath,
        previousState: safeData.state,
        state: safeData.state,
        nextAction: safeData.next_action,
        bootstrapExempt: true,
        artifactPath,
        writerPr,
        reason,
        skipReviewReason: skipReviewReason || null,
        idempotent: true,
      };
      if (jsonOut) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Bootstrap artifact already reconciled: ${manifestPath}`);
      }
      return;
    }
    throw new Error(`force-finalize cannot be used from terminal state ${safeData.state}`);
  }

  const operatorName = getActorName(repoPath);
  const updated = forceUpdateManifestState({
    ...safeData,
    bootstrap_exempt: requestedBootstrapExemption,
  }, STATES.MERGED, "manual_cleanup_required", {
    reason,
    operator: operatorName,
  });

  if (skipReviewReason) {
    appendRunEvent(repoPath, safeData.run_id, {
      event: EVENTS.SKIP_REVIEW,
      state_from: safeData.state,
      state_to: safeData.state,
      head_sha: safeData.git?.head_sha || null,
      round: safeData.review?.rounds || null,
      reason: skipReviewReason,
      pr_number: writerPr,
    });
  }
  appendRunEvent(repoPath, safeData.run_id, {
    event: EVENTS.FORCE_FINALIZE,
    state_from: safeData.state,
    state_to: STATES.MERGED,
    head_sha: safeData.git?.head_sha || null,
    round: safeData.review?.rounds || null,
    reason,
    pr_number: writerPr,
    last_reviewed_sha: safeData.review?.last_reviewed_sha,
    bootstrap_exempt: true,
  });
  writeManifest(manifestPath, updated, body);

  const result = {
    manifestPath,
    previousState: safeData.state,
    state: updated.state,
    nextAction: updated.next_action,
    bootstrapExempt: true,
    artifactPath,
    writerPr,
    reason,
    skipReviewReason: skipReviewReason || null,
    idempotent: false,
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Reconciled bootstrap artifact run: ${manifestPath}`);
    console.log(`  State:         ${safeData.state} -> ${updated.state}`);
    console.log(`  Artifact path: ${artifactPath}`);
    console.log(`  Writer PR:     #${writerPr}`);
    console.log(`  Next action:   ${updated.next_action}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
