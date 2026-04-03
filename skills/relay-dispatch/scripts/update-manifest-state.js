#!/usr/bin/env node
/**
 * Update a relay run manifest state after review or merge.
 *
 * Usage:
 *   ./update-manifest-state.js --manifest <path> --state <state> [options]
 *   ./update-manifest-state.js --repo <path> --run-id <id> --state <state> [options]
 *   ./update-manifest-state.js --repo <path> --branch <name> --state <state> [options]
 *
 * Options:
 *   --manifest <path>      Manifest path to update
 *   --repo <path>          Repository root used with --branch
 *   --run-id <id>          Relay run identifier
 *   --branch <name>        Working branch convenience selector
 *   --state <state>        Target relay state
 *   --next-action <name>   Override next_action
 *   --pr-number <n>        Persist git.pr_number
 *   --head-sha <sha>       Persist git.head_sha
 *   --rounds <n>           Persist review.rounds
 *   --verdict <name>       Persist review.latest_verdict
 *   --last-reviewed-sha <sha> Persist review.last_reviewed_sha
 *   --max-rounds <n>       Persist review.max_rounds
 *   --repeated-issue-count <n> Persist review.repeated_issue_count
 *   --dry-run              Print result without writing
 *   --json                 Output JSON
 *   --help, -h             Show usage
 */

const path = require("path");
const {
  STATES,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");
const { resolveManifestRecord } = require("./relay-resolver");

const args = process.argv.slice(2);
const KNOWN_FLAGS = [
  "--manifest", "--repo", "--run-id", "--branch", "--state", "--next-action",
  "--pr-number", "--head-sha", "--rounds", "--verdict", "--last-reviewed-sha",
  "--max-rounds", "--repeated-issue-count", "--dry-run", "--json", "--help", "-h",
];

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: update-manifest-state.js (--manifest <path> | --repo <path> --run-id <id> | --repo <path> --branch <name>) --state <state> [options]");
  console.log("\nUpdate relay run state after review or merge.");
  console.log("\nOptions:");
  console.log("  --manifest <path>    Manifest path to update");
  console.log("  --repo <path>        Repository root used with --run-id or --branch");
  console.log("  --run-id <id>        Relay run identifier");
  console.log("  --branch <name>      Working branch convenience selector");
  console.log("  --state <state>      Target relay state");
  console.log("  --next-action <name> Override next_action");
  console.log("  --pr-number <n>      Persist git.pr_number");
  console.log("  --head-sha <sha>     Persist git.head_sha");
  console.log("  --rounds <n>         Persist review.rounds");
  console.log("  --verdict <name>     Persist review.latest_verdict");
  console.log("  --last-reviewed-sha <sha> Persist review.last_reviewed_sha");
  console.log("  --max-rounds <n>     Persist review.max_rounds");
  console.log("  --repeated-issue-count <n> Persist review.repeated_issue_count");
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
  const runId = getArg("--run-id");
  const branch = getArg("--branch");

  if (manifestPath && (repoPath || branch || runId)) {
    throw new Error("Use either --manifest or --repo with --run-id/--branch, not both");
  }

  if (manifestPath) return path.resolve(manifestPath);

  if (!repoPath || (!runId && !branch)) {
    throw new Error("Either --manifest or both --repo and one of --run-id/--branch are required");
  }

  const match = resolveManifestRecord({ repoRoot: path.resolve(repoPath), runId, branch });
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
  const headSha = getArg("--head-sha");
  const rounds = parsePositiveInt(getArg("--rounds"), "--rounds");
  const verdict = getArg("--verdict");
  const lastReviewedSha = getArg("--last-reviewed-sha");
  const maxRounds = parsePositiveInt(getArg("--max-rounds"), "--max-rounds");
  const repeatedIssueCount = parsePositiveInt(getArg("--repeated-issue-count"), "--repeated-issue-count");

  let updated = updateManifestState(data, targetState, nextAction);

  if (prNumber !== undefined || headSha !== undefined) {
    updated = {
      ...updated,
      git: {
        ...(updated.git || {}),
        ...(prNumber !== undefined ? { pr_number: prNumber } : {}),
        ...(headSha !== undefined ? { head_sha: headSha } : {}),
      },
    };
  }

  if (
    rounds !== undefined ||
    verdict !== undefined ||
    lastReviewedSha !== undefined ||
    maxRounds !== undefined ||
    repeatedIssueCount !== undefined
  ) {
    updated = {
      ...updated,
      review: {
        ...(updated.review || {}),
        ...(rounds !== undefined ? { rounds } : {}),
        ...(verdict !== undefined ? { latest_verdict: verdict } : {}),
        ...(lastReviewedSha !== undefined ? { last_reviewed_sha: lastReviewedSha } : {}),
        ...(maxRounds !== undefined ? { max_rounds: maxRounds } : {}),
        ...(repeatedIssueCount !== undefined ? { repeated_issue_count: repeatedIssueCount } : {}),
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
    headSha: updated.git?.head_sha || null,
    rounds: updated.review?.rounds ?? null,
    verdict: updated.review?.latest_verdict || null,
    lastReviewedSha: updated.review?.last_reviewed_sha || null,
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
    if (result.headSha) console.log(`  head_sha: ${result.headSha}`);
    if (result.verdict) console.log(`  verdict: ${result.verdict}`);
    if (result.rounds !== null) console.log(`  rounds: ${result.rounds}`);
    if (result.lastReviewedSha) console.log(`  last_reviewed_sha: ${result.lastReviewedSha}`);
    if (result.dryRun) console.log("  dry-run: no changes written");
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
