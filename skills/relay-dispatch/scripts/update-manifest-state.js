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
const { STATES, updateManifestState } = require("./manifest/lifecycle");
const {
  readManifest,
  writeManifest,
} = require("./manifest/store");
const { parsePositiveInt } = require("./manifest/paths");
const { getArg, hasFlag, modeLabel } = require("./cli-args");
const { resolveManifestRecord } = require("./relay-resolver");

const args = process.argv.slice(2);
const CLI_ARG_OPTIONS = { commandName: "update-manifest-state", reservedFlags: ["-h"] };
const hasCliFlag = (flag) => hasFlag(args, flag, CLI_ARG_OPTIONS);

if (!args.length || hasCliFlag(["--help", "-h"])) {
  console.log("Usage: update-manifest-state.js (--manifest <path> | --repo <path> --run-id <id> | --repo <path> --branch <name>) --state <state> [options]");
  console.log("\nUpdate relay run state after review or merge.");
  console.log("\nOptions:");
  console.log(`  --manifest <path>    ${modeLabel("--manifest")} Manifest path to update`);
  console.log(`  --repo <path>        ${modeLabel("--repo")} Repository root used with --run-id or --branch`);
  console.log(`  --run-id <id>        ${modeLabel("--run-id")} Relay run identifier`);
  console.log(`  --branch <name>      ${modeLabel("--branch")} Working branch convenience selector`);
  console.log(`  --state <state>      ${modeLabel("--state")} Target relay state`);
  console.log(`  --next-action <name> ${modeLabel("--next-action")} Override next_action`);
  console.log(`  --pr-number <n>      ${modeLabel("--pr-number")} Persist git.pr_number`);
  console.log(`  --head-sha <sha>     ${modeLabel("--head-sha")} Persist git.head_sha`);
  console.log(`  --rounds <n>         ${modeLabel("--rounds")} Persist review.rounds`);
  console.log(`  --verdict <name>     ${modeLabel("--verdict")} Persist review.latest_verdict`);
  console.log(`  --last-reviewed-sha <sha> ${modeLabel("--last-reviewed-sha")} Persist review.last_reviewed_sha`);
  console.log(`  --max-rounds <n>     ${modeLabel("--max-rounds")} Persist review.max_rounds`);
  console.log(`  --repeated-issue-count <n> ${modeLabel("--repeated-issue-count")} Persist review.repeated_issue_count`);
  console.log(`  --dry-run            ${modeLabel("--dry-run")} Print result without writing`);
  console.log(`  --json               ${modeLabel("--json")} Output JSON`);
  process.exit(hasCliFlag(["--help", "-h"]) ? 0 : 1);
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
  const manifestPath = getArg(args, "--manifest", undefined, CLI_ARG_OPTIONS);
  const repoPath = getArg(args, "--repo", undefined, CLI_ARG_OPTIONS);
  const runId = getArg(args, "--run-id", undefined, CLI_ARG_OPTIONS);
  const branch = getArg(args, "--branch", undefined, CLI_ARG_OPTIONS);

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
  const targetState = getArg(args, "--state", undefined, CLI_ARG_OPTIONS);
  if (!targetState) {
    throw new Error("--state is required");
  }

  const manifestPath = resolveManifestPath();
  const { data, body } = readManifest(manifestPath);
  const nextAction = getArg(args, "--next-action", undefined, CLI_ARG_OPTIONS) || defaultNextAction(targetState);
  const prNumber = parsePositiveInt(getArg(args, "--pr-number", undefined, CLI_ARG_OPTIONS), "--pr-number");
  const headSha = getArg(args, "--head-sha", undefined, CLI_ARG_OPTIONS);
  const rounds = parsePositiveInt(getArg(args, "--rounds", undefined, CLI_ARG_OPTIONS), "--rounds");
  const verdict = getArg(args, "--verdict", undefined, CLI_ARG_OPTIONS);
  const lastReviewedSha = getArg(args, "--last-reviewed-sha", undefined, CLI_ARG_OPTIONS);
  const maxRounds = parsePositiveInt(getArg(args, "--max-rounds", undefined, CLI_ARG_OPTIONS), "--max-rounds");
  const repeatedIssueCount = parsePositiveInt(getArg(args, "--repeated-issue-count", undefined, CLI_ARG_OPTIONS), "--repeated-issue-count");

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
    dryRun: hasCliFlag("--dry-run"),
  };

  if (!hasCliFlag("--dry-run")) {
    writeManifest(manifestPath, updated, body);
  }

  if (hasCliFlag("--json")) {
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
