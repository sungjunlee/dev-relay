#!/usr/bin/env node
/**
 * Update a relay run manifest state after review or merge.
 *
 * Usage:
 *   ./update-manifest-state.js --manifest <path> --state <state> [options]
 *   ./update-manifest-state.js --repo <path> --branch <name> --state <state> [options]
 *
 * Options:
 *   --manifest <path>      Manifest path to update
 *   --repo <path>          Repository root used with --branch
 *   --branch <name>        Working branch used to locate latest manifest
 *   --state <state>        Target relay state
 *   --next-action <name>   Override next_action
 *   --pr-number <n>        Persist git.pr_number
 *   --rounds <n>           Persist review.rounds
 *   --verdict <name>       Persist review.latest_verdict
 *   --dry-run              Print result without writing
 *   --json                 Output JSON
 *   --help, -h             Show usage
 */

const path = require("path");
const {
  STATES,
  findLatestManifestForBranch,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");

const args = process.argv.slice(2);
const KNOWN_FLAGS = [
  "--manifest", "--repo", "--branch", "--state", "--next-action",
  "--pr-number", "--rounds", "--verdict", "--dry-run", "--json", "--help", "-h",
];

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: update-manifest-state.js (--manifest <path> | --repo <path> --branch <name>) --state <state> [options]");
  console.log("\nUpdate relay run state after review or merge.");
  console.log("\nOptions:");
  console.log("  --manifest <path>    Manifest path to update");
  console.log("  --repo <path>        Repository root used with --branch");
  console.log("  --branch <name>      Working branch used to locate latest manifest");
  console.log("  --state <state>      Target relay state");
  console.log("  --next-action <name> Override next_action");
  console.log("  --pr-number <n>      Persist git.pr_number");
  console.log("  --rounds <n>         Persist review.rounds");
  console.log("  --verdict <name>     Persist review.latest_verdict");
  console.log("  --dry-run            Print result without writing");
  console.log("  --json               Output JSON");
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
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function defaultNextAction(state) {
  switch (state) {
    case STATES.CHANGES_REQUESTED:
      return "re_dispatch_requested_changes";
    case STATES.READY_TO_MERGE:
      return "await_explicit_merge";
    case STATES.MERGED:
      return "manual_cleanup_required";
    case STATES.ESCALATED:
      return "inspect_review_failure";
    case STATES.CLOSED:
      return "done";
    default:
      return "update_run_state";
  }
}

function resolveManifestPath() {
  const manifestPath = getArg("--manifest");
  const repoPath = getArg("--repo");
  const branch = getArg("--branch");

  if (manifestPath && (repoPath || branch)) {
    throw new Error("Use either --manifest or --repo with --branch, not both");
  }

  if (manifestPath) return path.resolve(manifestPath);

  if (!repoPath || !branch) {
    throw new Error("Either --manifest or both --repo and --branch are required");
  }

  const match = findLatestManifestForBranch(path.resolve(repoPath), branch);
  if (!match) {
    throw new Error(`No relay manifest found for branch '${branch}'`);
  }
  return match.manifestPath;
}

function main() {
  const targetState = getArg("--state");
  if (!targetState) {
    throw new Error("--state is required");
  }

  const manifestPath = resolveManifestPath();
  const { data, body } = readManifest(manifestPath);
  const nextAction = getArg("--next-action") || defaultNextAction(targetState);
  const prNumber = parsePositiveInt(getArg("--pr-number"), "--pr-number");
  const rounds = parsePositiveInt(getArg("--rounds"), "--rounds");
  const verdict = getArg("--verdict");

  let updated = updateManifestState(data, targetState, nextAction);

  if (prNumber !== undefined) {
    updated = {
      ...updated,
      git: {
        ...(updated.git || {}),
        pr_number: prNumber,
      },
    };
  }

  if (rounds !== undefined || verdict !== undefined) {
    updated = {
      ...updated,
      review: {
        ...(updated.review || {}),
        ...(rounds !== undefined ? { rounds } : {}),
        ...(verdict !== undefined ? { latest_verdict: verdict } : {}),
      },
    };
  }

  const result = {
    manifestPath,
    previousState: data.state,
    state: updated.state,
    nextAction: updated.next_action,
    branch: updated.git?.working_branch || null,
    prNumber: updated.git?.pr_number ?? null,
    rounds: updated.review?.rounds ?? null,
    verdict: updated.review?.latest_verdict || null,
    dryRun: hasFlag("--dry-run"),
  };

  if (!hasFlag("--dry-run")) {
    writeManifest(manifestPath, updated, body);
  }

  if (hasFlag("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Updated relay manifest: ${manifestPath}`);
    console.log(`  ${result.previousState} -> ${result.state}`);
    console.log(`  next_action: ${result.nextAction}`);
    if (result.prNumber !== null) console.log(`  pr_number: ${result.prNumber}`);
    if (result.verdict) console.log(`  verdict: ${result.verdict}`);
    if (result.rounds !== null) console.log(`  rounds: ${result.rounds}`);
    if (result.dryRun) console.log("  dry-run: no changes written");
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
