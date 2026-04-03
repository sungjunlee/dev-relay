#!/usr/bin/env node
/**
 * Merge a ready relay run, then finalize cleanup and manifest metadata.
 *
 * Usage:
 *   ./finalize-run.js --repo <path> --pr <number> [options]
 *   ./finalize-run.js --manifest <path> --pr <number> [options]
 *
 * Options:
 *   --repo <path>          Repository root (default: .)
 *   --manifest <path>      Explicit manifest path
 *   --branch <name>        Override branch name
 *   --pr <number>          Pull request number
 *   --merge-method <name>  squash | merge | rebase (default: squash)
 *   --skip-merge           Skip the PR merge step and run cleanup only
 *   --no-issue-close       Skip linked issue close
 *   --dry-run              Print what would happen without writing
 *   --json                 Output JSON
 *   --help, -h             Show usage
 */

const { execFileSync } = require("child_process");
const path = require("path");
const {
  STATES,
  findLatestManifestForBranch,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");
const { runCleanup, summarizeError } = require("../../relay-dispatch/scripts/relay-cleanup");

const args = process.argv.slice(2);
const KNOWN_FLAGS = [
  "--repo", "--manifest", "--branch", "--pr", "--merge-method",
  "--skip-merge", "--no-issue-close", "--dry-run", "--json", "--help", "-h",
];

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: finalize-run.js (--repo <path> | --manifest <path>) --pr <number> [options]");
  console.log("\nMerge a ready relay run, then finalize cleanup and manifest metadata.");
  console.log("\nOptions:");
  console.log("  --repo <path>          Repository root (default: .)");
  console.log("  --manifest <path>      Explicit manifest path");
  console.log("  --branch <name>        Override branch name");
  console.log("  --pr <number>          Pull request number");
  console.log("  --merge-method <name>  squash | merge | rebase (default: squash)");
  console.log("  --skip-merge           Skip the PR merge step and run cleanup only");
  console.log("  --no-issue-close       Skip linked issue close");
  console.log("  --dry-run              Print what would happen without writing");
  console.log("  --json                 Output JSON");
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

function getArg(flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  const value = args[index + 1];
  return KNOWN_FLAGS.includes(value) ? undefined : value;
}

function hasFlag(flag) {
  return args.includes(flag);
}

function parsePositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function gh(ghBin, repoPath, ...ghArgs) {
  return execFileSync(ghBin, ghArgs, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function resolveBranch(ghBin, repoPath, prNumber, branchArg, manifestData) {
  if (branchArg) return branchArg;
  if (manifestData?.git?.working_branch) return manifestData.git.working_branch;
  const raw = gh(ghBin, repoPath, "pr", "view", String(prNumber), "--json", "headRefName");
  return JSON.parse(raw).headRefName;
}

function resolveManifest(repoPath, manifestArg, branch) {
  if (manifestArg) {
    const manifestPath = path.resolve(manifestArg);
    return { manifestPath, ...readManifest(manifestPath) };
  }

  if (!branch) {
    throw new Error("Branch is required when --manifest is not provided");
  }

  const match = findLatestManifestForBranch(repoPath, branch);
  if (!match) {
    throw new Error(`No relay manifest found for branch '${branch}'`);
  }
  return match;
}

function mergeFlag(method) {
  switch (method) {
    case "squash":
      return "--squash";
    case "merge":
      return "--merge";
    case "rebase":
      return "--rebase";
    default:
      throw new Error(`Unsupported merge method: ${method}`);
  }
}

function main() {
  const repoArg = getArg("--repo");
  let repoPath = path.resolve(repoArg || ".");
  const manifestArg = getArg("--manifest");
  const prNumber = parsePositiveInt(getArg("--pr"), "--pr");
  const mergeMethod = getArg("--merge-method") || "squash";
  const dryRun = hasFlag("--dry-run");
  const skipMerge = hasFlag("--skip-merge");
  const skipIssueClose = hasFlag("--no-issue-close");
  const jsonOut = hasFlag("--json");
  const ghBin = process.env.RELAY_GH_BIN || "gh";
  const gitBin = process.env.RELAY_GIT_BIN || "git";

  let branch = getArg("--branch");
  let manifestRecord = null;

  if (manifestArg) {
    manifestRecord = resolveManifest(repoPath, manifestArg);
    if (!repoArg && manifestRecord.data.paths?.repo_root) {
      repoPath = path.resolve(manifestRecord.data.paths.repo_root);
    }
    branch = resolveBranch(ghBin, repoPath, prNumber, branch, manifestRecord.data);
  } else {
    if (!branch) {
      const raw = gh(ghBin, repoPath, "pr", "view", String(prNumber), "--json", "headRefName");
      branch = JSON.parse(raw).headRefName;
    }
    manifestRecord = resolveManifest(repoPath, null, branch);
  }

  const { manifestPath, data, body } = manifestRecord;
  if (skipMerge && data.state !== STATES.MERGED) {
    throw new Error("--skip-merge can only be used for runs that are already in the merged state");
  }
  if (!skipMerge && data.state !== STATES.READY_TO_MERGE) {
    if (data.state !== STATES.MERGED) {
      throw new Error(`Expected relay run to be ${STATES.READY_TO_MERGE} before merge, got ${data.state}`);
    }
  }

  let updated = data;
  let mergePerformed = false;
  let issueClosed = false;
  let issueCloseWarning = null;

  if (!skipMerge && data.state === STATES.READY_TO_MERGE) {
    if (!dryRun) {
      gh(ghBin, repoPath, "pr", "merge", String(prNumber), mergeFlag(mergeMethod), "--delete-branch");
    }
    updated = updateManifestState(updated, STATES.MERGED, "manual_cleanup_required");
    mergePerformed = true;
  }

  const issueNumber = updated.issue?.number || null;
  if (!skipIssueClose && issueNumber) {
    if (!dryRun) {
      try {
        gh(ghBin, repoPath, "issue", "close", String(issueNumber), "--comment", `Resolved in PR #${prNumber}`);
        issueClosed = true;
      } catch (error) {
        issueCloseWarning = summarizeError(error);
      }
    }
  }

  const cleanupResult = runCleanup({
    repoRoot: repoPath,
    data: updated,
    gitBin,
    dryRun,
    deleteMergedBranch: updated.state === STATES.MERGED,
  });
  updated = cleanupResult.updatedData;

  if (!dryRun) {
    writeManifest(manifestPath, updated, body);
  }

  const result = {
    manifestPath,
    previousState: data.state,
    state: updated.state,
    nextAction: updated.next_action,
    branch,
    prNumber,
    issueNumber,
    mergePerformed,
    mergeMethod,
    issueClosed,
    issueCloseWarning,
    cleanup: cleanupResult.summary,
    dryRun,
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Finalized relay run: ${manifestPath}`);
    console.log(`  State:        ${data.state} -> ${updated.state}`);
    console.log(`  Next action:  ${updated.next_action}`);
    console.log(`  Merge:        ${mergePerformed ? `performed (${mergeMethod})` : (skipMerge ? "skipped" : "already merged")}`);
    console.log(`  Issue close:  ${issueNumber ? (issueClosed ? "closed" : (issueCloseWarning ? `warning: ${issueCloseWarning}` : "skipped")) : "none"}`);
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
