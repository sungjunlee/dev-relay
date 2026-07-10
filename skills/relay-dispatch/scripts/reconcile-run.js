#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { findUnknownFlags, modeLabel, readArg, schemaHasFlag } = require("./cli-args");
const { execGit } = require("./exec");
const {
  buildExecutionEvidence,
  EXECUTION_EVIDENCE_FILENAME,
  writeExecutionEvidence,
} = require("./execution-evidence");
const { STATES, updateManifestState } = require("./manifest/lifecycle");
const { getRunDir, summarizeFailure, validateManifestPaths } = require("./manifest/paths");
const { readManifest, writeManifest } = require("./manifest/store");
const { classifyRepositoryDirt } = require("./runtime-dirt");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent, EVENTS } = require("./relay-events");
const {
  confirmRunLeaseSupervisorDeath,
  corruptRunLeaseEventFields,
  corruptRunLeaseReportFields,
  getDispatchResultCandidates,
  getRunLeaseStatus,
  latestRunEvent,
  removeRunLease,
  terminateProcessGroup,
  waitForProcessGroupExit,
} = require("./run-runtime-state");

const args = process.argv.slice(2);
const CLI_ARG_OPTIONS = { commandName: "reconcile-run", reservedFlags: ["-h"] };
const hasCliFlag = (flag) => schemaHasFlag(args, flag, CLI_ARG_OPTIONS);

function printHelp(exitCode) {
  console.log("Usage: reconcile-run.js --repo <path> --run-id <id> [--dry-run] [--json]");
  console.log("\nSettle a dispatched relay run after supervisor death, reboot, timeout, or interrupted dispatch.");
  console.log("\nOptions:");
  console.log(`  --repo <path>    ${modeLabel("--repo")} Repository root (default: .)`);
  console.log(`  --run-id <id>    ${modeLabel("--run-id")} Relay run identifier`);
  console.log(`  --dry-run        ${modeLabel("--dry-run")} Report the decision row and planned actions without mutating`);
  console.log(`  --json           ${modeLabel("--json")} Output JSON`);
  console.log(`  --help           ${modeLabel("--help")} Show help`);
  process.exit(exitCode);
}

if (!args.length || hasCliFlag(["--help", "-h"])) {
  printHelp(hasCliFlag(["--help", "-h"]) ? 0 : 1);
}

function hasNonEmptyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function firstPresentResultFile(repoRoot, runId, data) {
  return getDispatchResultCandidates(repoRoot, runId, data).find(hasNonEmptyFile) || null;
}

function countRange(worktreePath, range) {
  const raw = execGit(worktreePath, ["rev-list", "--count", range]);
  const count = Number(raw);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

function countNewCommits(worktreePath, data) {
  const startHead = data.git?.head_sha || null;
  if (startHead) {
    try {
      execGit(worktreePath, ["rev-parse", "--verify", startHead]);
      return countRange(worktreePath, `${startHead}..HEAD`);
    } catch {}
  }
  const baseBranch = data.git?.base_branch || "main";
  for (const ref of [`refs/remotes/origin/${baseBranch}`, baseBranch]) {
    try {
      execGit(worktreePath, ["rev-parse", "--verify", ref]);
      return countRange(worktreePath, `${ref}..HEAD`);
    } catch {}
  }
  return 0;
}

function inspectWorktree(worktreePath, data) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { newCommits: 0, hasReviewableDirt: false, currentHead: data.git?.head_sha || null };
  }
  let currentHead = data.git?.head_sha || null;
  try {
    currentHead = execGit(worktreePath, ["rev-parse", "HEAD"]);
  } catch {}
  let statusText = "";
  try {
    statusText = execGit(worktreePath, ["status", "--porcelain"]);
  } catch {}
  return {
    newCommits: countNewCommits(worktreePath, data),
    hasReviewableDirt: classifyRepositoryDirt(statusText).hasReviewableDirt,
    currentHead,
  };
}

function resumeCommand(manifestPath) {
  return `node skills/relay-dispatch/scripts/dispatch.js --manifest ${manifestPath}`;
}

function outputResult(result, jsonOut) {
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`reconcile-run row ${result.row}: ${result.status}`);
  console.log(`  Run: ${result.runId}`);
  console.log(`  State: ${result.state}`);
  if (result.nextAction) console.log(`  Next action: ${result.nextAction}`);
  if (result.resumeCommand) console.log(`  Resume: ${result.resumeCommand}`);
  if (result.remaining_s !== undefined && result.remaining_s !== null) {
    console.log(`  Remaining: ${result.remaining_s}s`);
  }
  if (result.plannedActions?.length) {
    console.log(`  Planned: ${result.plannedActions.join(", ")}`);
  }
}

function buildBaseResult({ row, rowName, status, manifestPath, runId, data, dryRun, nextAction = null }) {
  return {
    row,
    rowName,
    status,
    manifestPath,
    runId,
    state: data.state,
    nextAction,
    dryRun,
  };
}

function appendInterruptedIfNeeded(
  repoRoot,
  data,
  manifestPath,
  reason,
  leaseStatus,
  worktreePath,
  dryRun,
  {
    executorTerminated = reason === "reconcile_timeout",
    suppressDuplicateTail = true,
    eventFields = {},
  } = {}
) {
  const tail = latestRunEvent(repoRoot, data.run_id);
  const alreadyTail = tail?.event === EVENTS.DISPATCH_INTERRUPTED;
  const shouldAppend = !dryRun && (!suppressDuplicateTail || !alreadyTail);
  if (shouldAppend) {
    appendRunEvent(repoRoot, data.run_id, {
      event: EVENTS.DISPATCH_INTERRUPTED,
      state_from: data.state,
      state_to: data.state,
      head_sha: data.git?.head_sha || null,
      reason,
      executor_pid: leaseStatus.lease?.pid ?? null,
      executor_pgid: leaseStatus.lease?.pgid ?? null,
      elapsed_s: leaseStatus.elapsed_s,
      timeout_s: leaseStatus.lease?.timeout_s ?? null,
      executor_terminated: executorTerminated,
      worktree: worktreePath || null,
      ...eventFields,
    });
  }
  return {
    journaled: shouldAppend,
    alreadyTail,
    resumeCommand: resumeCommand(manifestPath),
  };
}

function dispatchCompletionTarget(data) {
  const publishPolicy = data.dispatch?.publish_policy || "immediate";
  if (publishPolicy === "after-internal-review") {
    return {
      state: STATES.INTERNAL_REVIEW_PENDING,
      nextAction: "run_internal_review",
    };
  }
  if (publishPolicy === "immediate") {
    return {
      state: STATES.REVIEW_PENDING,
      nextAction: "run_review",
    };
  }
  throw new Error(`unsupported dispatch.publish_policy for reconcile: ${publishPolicy}`);
}

function appendStateRecovery(repoRoot, before, after, reason, eventFields = {}) {
  appendRunEvent(repoRoot, after.run_id, {
    event: EVENTS.STATE_RECOVERY,
    state_from: before.state,
    state_to: after.state,
    head_sha: after.git?.head_sha || null,
    round: after.review?.rounds || null,
    reason,
    ...eventFields,
  });
}

function transitionDispatchedToCompletionTarget({ repoRoot, manifestPath, body, data, currentHead, dryRun, eventFields = {} }) {
  const target = dispatchCompletionTarget(data);
  const updated = {
    ...updateManifestState(data, target.state, target.nextAction),
    git: {
      ...(data.git || {}),
      head_sha: currentHead || data.git?.head_sha || null,
    },
  };
  if (!dryRun) {
    writeManifest(manifestPath, updated, body);
    appendStateRecovery(repoRoot, data, updated, "reconcile_dead_work", eventFields);
  }
  return updated;
}

function runRecoverCommit({ repoRoot, runId, dryRun }) {
  const recoverPath = path.join(__dirname, "recover-commit.js");
  const argv = [
    recoverPath,
    "--repo", repoRoot,
    "--run-id", runId,
    "--reason", `reconcile-run recovered work for ${runId}`,
    "--json",
  ];
  if (dryRun) argv.push("--dry-run");
  const stdout = execFileSync(process.execPath, argv, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout);
}

/**
 * Stamp execution-evidence.json from the executor result file after row-4 recovery,
 * matching the normal dispatch-completion builder/shape. Leaves evidence already
 * bound to the recovered head untouched.
 */
function stampExecutionEvidenceFromResult({
  repoRoot,
  runId,
  resultFile,
  recoveredHead,
  executor,
}) {
  if (!resultFile || !recoveredHead) {
    return { skipped: "missing_result_or_head" };
  }
  const runDir = getRunDir(repoRoot, runId);
  const evidencePath = path.join(runDir, EXECUTION_EVIDENCE_FILENAME);
  if (fs.existsSync(evidencePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
      if (existing && typeof existing === "object" && existing.head_sha === recoveredHead) {
        return { skipped: "evidence_already_bound", path: evidencePath };
      }
    } catch {
      // Corrupt or unreadable evidence: fall through and rewrite like normal completion.
    }
  }
  const writtenPath = writeExecutionEvidence(
    runDir,
    buildExecutionEvidence({
      headSha: recoveredHead,
      testCommand: undefined,
      resultFilePath: resultFile,
      executor: executor || "executor",
      testExitCode: 0,
    })
  );
  return { stamped: true, path: writtenPath };
}

async function main() {
  const unknownFlags = findUnknownFlags(args, "reconcile-run");
  if (unknownFlags.length) {
    throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  }

  const repoRoot = path.resolve(readArg(args, "--repo", ".", CLI_ARG_OPTIONS));
  const runId = readArg(args, "--run-id", undefined, CLI_ARG_OPTIONS);
  const dryRun = hasCliFlag("--dry-run");
  const jsonOut = hasCliFlag("--json");
  if (!runId) {
    throw new Error("--run-id is required");
  }

  const record = resolveManifestRecord({ repoRoot, runId });
  const validatedPaths = validateManifestPaths(record.data.paths, {
    expectedRepoRoot: repoRoot,
    manifestPath: record.manifestPath,
    runId: record.data.run_id,
    allowMissingWorktree: true,
    caller: "reconcile-run",
  });
  const data = {
    ...record.data,
    paths: {
      ...(record.data.paths || {}),
      repo_root: validatedPaths.repoRoot,
      worktree: validatedPaths.worktree,
    },
  };
  const normalizedRepoRoot = validatedPaths.repoRoot;
  const normalizedRunId = data.run_id;
  const worktreePath = validatedPaths.worktree;

  if (data.state !== STATES.DISPATCHED) {
    outputResult({
      ...buildBaseResult({
        row: 1,
        rowName: "not_dispatched",
        status: "noop",
        manifestPath: record.manifestPath,
        runId: normalizedRunId,
        data,
        dryRun,
        nextAction: "none",
      }),
      state: data.state,
    }, jsonOut);
    return;
  }

  const leaseStatus = getRunLeaseStatus(normalizedRepoRoot, normalizedRunId);
  const leaseUnexpired = leaseStatus.exists
    && leaseStatus.lease
    && leaseStatus.remaining_s > 0;
  if (!leaseStatus.live && leaseUnexpired && leaseStatus.reason !== "host_mismatch") {
    const deathConfirmed = await confirmRunLeaseSupervisorDeath(leaseStatus);
    if (!deathConfirmed) {
      outputResult({
        ...buildBaseResult({
          row: 2,
          rowName: "lease_live_within_timeout",
          status: "running",
          manifestPath: record.manifestPath,
          runId: normalizedRunId,
          data,
          dryRun,
          nextAction: "wait_for_executor",
        }),
        lease: leaseStatus.lease,
        leaseStatus: "supervisor_pid_alive_after_reprobe",
        elapsed_s: leaseStatus.elapsed_s,
        remaining_s: leaseStatus.remaining_s,
      }, jsonOut);
      return;
    }
  }
  if (leaseStatus.live) {
    const timedOut = leaseStatus.elapsed_s > Number(leaseStatus.lease.timeout_s);
    if (!timedOut || !leaseStatus.canSignal) {
      outputResult({
        ...buildBaseResult({
          row: 2,
          rowName: "lease_live_within_timeout",
          status: timedOut ? "running_unverified" : "running",
          manifestPath: record.manifestPath,
          runId: normalizedRunId,
          data,
          dryRun,
          nextAction: "wait_for_executor",
        }),
        lease: leaseStatus.lease,
        leaseStatus: leaseStatus.reason,
        elapsed_s: leaseStatus.elapsed_s,
        remaining_s: leaseStatus.remaining_s,
      }, jsonOut);
      return;
    }

    const plannedActions = [
      "kill_process_group",
      "wait_for_process_group_exit",
      "journal_dispatch_interrupted",
      "remove_lease_if_process_group_gone",
    ];
    if (dryRun) {
      outputResult({
        ...buildBaseResult({
          row: 3,
          rowName: "lease_live_timed_out",
          status: "dry_run",
          manifestPath: record.manifestPath,
          runId: normalizedRunId,
          data,
          dryRun,
          nextAction: "kill_executor_then_resume_or_reconcile",
        }),
        lease: leaseStatus.lease,
        elapsed_s: leaseStatus.elapsed_s,
        plannedActions,
      }, jsonOut);
      return;
    }

    terminateProcessGroup(leaseStatus.lease.pgid);
    const killConfirmed = await waitForProcessGroupExit(leaseStatus.lease.pgid);
    if (!killConfirmed) {
      const interrupted = appendInterruptedIfNeeded(
        normalizedRepoRoot,
        data,
        record.manifestPath,
        "reconcile_timeout_unsettled",
        leaseStatus,
        worktreePath,
        false,
        { executorTerminated: false, suppressDuplicateTail: false }
      );
      outputResult({
        ...buildBaseResult({
          row: 3,
          rowName: "lease_live_timed_out",
          status: "timed_out_unsettled",
          manifestPath: record.manifestPath,
          runId: normalizedRunId,
          data,
          dryRun,
          nextAction: "kill_executor_or_wait",
        }),
        lease: leaseStatus.lease,
        elapsed_s: leaseStatus.elapsed_s,
        killConfirmed,
        journaled: interrupted.journaled,
        resumeCommand: interrupted.resumeCommand,
      }, jsonOut);
      return;
    }
    const interrupted = appendInterruptedIfNeeded(
      normalizedRepoRoot,
      data,
      record.manifestPath,
      "reconcile_timeout",
      leaseStatus,
      worktreePath,
      false,
      { executorTerminated: true, suppressDuplicateTail: false }
    );
    removeRunLease(normalizedRepoRoot, normalizedRunId);
    outputResult({
      ...buildBaseResult({
        row: 3,
        rowName: "lease_live_timed_out",
        status: "timed_out_killed",
        manifestPath: record.manifestPath,
        runId: normalizedRunId,
        data,
        dryRun,
        nextAction: "resume_or_reconcile",
      }),
      lease: leaseStatus.lease,
      elapsed_s: leaseStatus.elapsed_s,
      killConfirmed,
      journaled: interrupted.journaled,
      resumeCommand: interrupted.resumeCommand,
    }, jsonOut);
    return;
  }

  const resultFile = firstPresentResultFile(normalizedRepoRoot, normalizedRunId, data);
  const worktreeInspection = inspectWorktree(worktreePath, data);
  const hasRecoverableWork = worktreeInspection.newCommits > 0 || worktreeInspection.hasReviewableDirt;
  const hasResult = !!resultFile;
  const corruptLeaseReport = corruptRunLeaseReportFields(leaseStatus);
  const corruptLeaseEvent = corruptRunLeaseEventFields(leaseStatus);
  if (hasResult || hasRecoverableWork) {
    const target = dispatchCompletionTarget(data);
    const plannedActions = [
      "remove_lease_if_present",
      target.state === STATES.INTERNAL_REVIEW_PENDING
        ? "transition_to_internal_review_pending"
        : "transition_to_review_pending",
      "run_recover_commit_if_needed",
    ];
    if (dryRun) {
      outputResult({
        ...buildBaseResult({
          row: 4,
          rowName: "dead_with_result_or_work",
          status: "dry_run",
          manifestPath: record.manifestPath,
          runId: normalizedRunId,
          data,
          dryRun,
          nextAction: "recover_commit_or_review",
        }),
        resultFile,
        newCommits: worktreeInspection.newCommits,
        hasReviewableDirt: worktreeInspection.hasReviewableDirt,
        plannedActions,
        ...corruptLeaseReport,
      }, jsonOut);
      return;
    }

    removeRunLease(normalizedRepoRoot, normalizedRunId);
    let recovery = null;
    let updated = null;
    if (hasRecoverableWork) {
      recovery = runRecoverCommit({
        repoRoot: normalizedRepoRoot,
        runId: normalizedRunId,
        dryRun: false,
      });
      updated = readManifest(record.manifestPath).data;
      appendStateRecovery(normalizedRepoRoot, data, updated, "reconcile_dead_work", corruptLeaseEvent);
    } else {
      updated = transitionDispatchedToCompletionTarget({
        repoRoot: normalizedRepoRoot,
        manifestPath: record.manifestPath,
        body: record.body,
        data,
        currentHead: worktreeInspection.currentHead,
        dryRun: false,
        eventFields: corruptLeaseEvent,
      });
    }
    let executionEvidence = null;
    if (hasResult) {
      const recoveredHead = updated.git?.head_sha || worktreeInspection.currentHead || null;
      executionEvidence = stampExecutionEvidenceFromResult({
        repoRoot: normalizedRepoRoot,
        runId: normalizedRunId,
        resultFile,
        recoveredHead,
        executor: data.roles?.executor || updated.roles?.executor,
      });
    }
    outputResult({
      ...buildBaseResult({
        row: 4,
        rowName: "dead_with_result_or_work",
        status: "recovered",
        manifestPath: record.manifestPath,
        runId: normalizedRunId,
        data: updated,
        dryRun,
        nextAction: updated.next_action,
      }),
      state: updated.state,
      resultFile,
      newCommits: worktreeInspection.newCommits,
      hasReviewableDirt: worktreeInspection.hasReviewableDirt,
      recovery,
      executionEvidence,
      ...corruptLeaseReport,
    }, jsonOut);
    return;
  }

  const plannedActions = ["journal_dispatch_interrupted_if_needed", "remove_lease_if_present"];
  if (dryRun) {
    outputResult({
      ...buildBaseResult({
        row: 5,
        rowName: "dead_no_result_no_work",
        status: "dry_run",
        manifestPath: record.manifestPath,
        runId: normalizedRunId,
        data,
        dryRun,
        nextAction: "resume_dispatch",
      }),
      plannedActions,
      resumeCommand: resumeCommand(record.manifestPath),
      ...corruptLeaseReport,
    }, jsonOut);
    return;
  }

  const interrupted = appendInterruptedIfNeeded(
    normalizedRepoRoot,
    data,
    record.manifestPath,
    "reconcile_dead_no_work",
    leaseStatus,
    worktreePath,
    false,
    { eventFields: corruptLeaseEvent }
  );
  removeRunLease(normalizedRepoRoot, normalizedRunId);
  outputResult({
    ...buildBaseResult({
      row: 5,
      rowName: "dead_no_result_no_work",
      status: "interrupted",
      manifestPath: record.manifestPath,
      runId: normalizedRunId,
      data,
      dryRun,
      nextAction: "resume_dispatch",
    }),
    journaled: interrupted.journaled,
    alreadyTailEvent: interrupted.alreadyTail,
    resumeCommand: interrupted.resumeCommand,
    ...corruptLeaseReport,
  }, jsonOut);
}

main().catch((error) => {
  console.error(`Error: ${summarizeFailure(error)}`);
  process.exit(1);
});
