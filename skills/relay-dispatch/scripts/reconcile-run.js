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
  hashFileSha256,
  rebrandEvidence,
  writeExecutionEvidence,
} = require("./execution-evidence");
const { forceUpdateManifestState, STATES, updateManifestState } = require("./manifest/lifecycle");
const { getRunDir, summarizeFailure, validateManifestPaths } = require("./manifest/paths");
const { readManifest, writeManifest } = require("./manifest/store");
const { classifyRepositoryDirt } = require("./runtime-dirt");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent, EVENTS, readRunEvents } = require("./relay-events");
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
  console.log("Usage: reconcile-run.js --repo <path> --run-id <id> [--test-result-file <path>] [--dry-run] [--json]");
  console.log("\nSettle a dispatched relay run after supervisor death, reboot, timeout, or interrupted dispatch.");
  console.log("Also salvages a terminal escalated run that timed out with committed-but-unpushed work.");
  console.log("\nOptions:");
  console.log(`  --repo <path>    ${modeLabel("--repo")} Repository root (default: .)`);
  console.log(`  --run-id <id>    ${modeLabel("--run-id")} Relay run identifier`);
  console.log(`  --test-result-file <path> ${modeLabel("--test-result-file")} Operator test output hashed as salvage execution evidence; a replaceable placeholder is written when omitted`);
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

// --- Escalated-timeout salvage (row 6, #949) ---------------------------------
// When a dispatch supervisor stamps `executor total_timeout` and escalates a run
// whose executor had actually committed its work (clean tree, commits ahead of the
// remote) but never pushed, the manifest is terminal `escalated`, so the row-1 noop
// swallowed it. This path force-with-lease pushes the retained commits, stamps
// evidence, and recovers the run to review_pending through the legal escalated ->
// review_pending transition.

const SALVAGE_ROW = 6;
const SALVAGE_ROW_NAME = "salvage_committed_unpushed";

function salvageAuditReason(runId) {
  return `reconcile-run salvaged committed-unpushed work after executor timeout escalation (run ${runId})`;
}

function resolveTestResultFile(resultFileArg) {
  if (resultFileArg === undefined || resultFileArg === null || String(resultFileArg).trim() === "") {
    return null;
  }
  const resolved = path.resolve(resultFileArg);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`--test-result-file must point to a file: ${resolved}`);
  }
  return resolved;
}

function latestDispatchResultEvent(repoRoot, runId) {
  let latest = null;
  for (const event of readRunEvents(repoRoot, runId)) {
    if (event?.event === EVENTS.DISPATCH_RESULT) latest = event;
  }
  return latest;
}

// The supervisor records the timeout outcome as a DISPATCH_RESULT with
// dispatch_failure_class "total_timeout" and state_to "escalated". Requiring that
// stamp keeps the salvage scoped to timeout escalations; other escalations (publish
// or review failures) fall through to the row-1 noop.
function isEscalatedTimeoutRun(repoRoot, runId, data) {
  if (data.state !== STATES.ESCALATED) return false;
  const latest = latestDispatchResultEvent(repoRoot, runId);
  return Boolean(
    latest
    && latest.dispatch_failure_class === "total_timeout"
    && latest.state_to === STATES.ESCALATED
  );
}

function countCommitsAheadOfBase(worktreePath, data) {
  const baseBranch = data.git?.base_branch || "main";
  for (const ref of [`refs/remotes/origin/${baseBranch}`, baseBranch]) {
    try {
      execGit(worktreePath, ["rev-parse", "--verify", ref]);
      return countRange(worktreePath, `${ref}..HEAD`);
    } catch {}
  }
  return 0;
}

// Commits present locally but not on the branch's own remote ref. When the remote
// ref exists we count origin/<branch>..HEAD; when the branch was never pushed we
// fall back to commits beyond the dispatch base (head_sha may already point at the
// committed HEAD in an escalated manifest, so it is not a reliable "unpushed" marker).
function countUnpushedAgainstRemote(worktreePath, branch, data) {
  const remoteRef = `refs/remotes/origin/${branch}`;
  try {
    execGit(worktreePath, ["rev-parse", "--verify", remoteRef]);
    return countRange(worktreePath, `${remoteRef}..HEAD`);
  } catch {}
  return countCommitsAheadOfBase(worktreePath, data);
}

function inspectSalvageWorktree(worktreePath, branch, data) {
  let currentHead = data.git?.head_sha || null;
  try {
    currentHead = execGit(worktreePath, ["rev-parse", "HEAD"]);
  } catch {}
  let statusText = "";
  try {
    statusText = execGit(worktreePath, ["status", "--porcelain"]);
  } catch {}
  return {
    currentHead,
    hasReviewableDirt: classifyRepositoryDirt(statusText).hasReviewableDirt,
    unpushedCommits: countUnpushedAgainstRemote(worktreePath, branch, data),
  };
}

// Never a bare --force: the executor may have force-pushed once before stalling, so
// the lease guards against overwriting a remote that moved past our known point.
function pushSalvageForceWithLease(worktreePath, branch) {
  try {
    execGit(worktreePath, ["push", "--force-with-lease", "origin", branch]);
    return { ok: true };
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 6)
      .join(" ");
    return { ok: false, detail: detail || "git push --force-with-lease failed" };
  }
}

function planSalvageEvidence(runDir, testResultFile) {
  const evidencePath = path.join(runDir, EXECUTION_EVIDENCE_FILENAME);
  if (testResultFile) {
    return { action: "operator_result_file", verified: true, evidencePath };
  }
  if (fs.existsSync(evidencePath)) {
    return { action: "rebrand_placeholder", verified: false, evidencePath };
  }
  return { action: "write_placeholder", verified: false, evidencePath };
}

// Evidence never silently claims verification: an operator --test-result-file is
// hashed and bound to the salvaged HEAD; otherwise existing timeout-placeholder
// evidence is rebranded (or a fresh placeholder written) with "unspecified" hashes.
function stampSalvageEvidence({ repoRoot, runId, runDir, salvageHead, executor, testResultFile, reason }) {
  const plan = planSalvageEvidence(runDir, testResultFile);
  if (plan.action === "operator_result_file") {
    const writtenPath = writeExecutionEvidence(runDir, {
      ...buildExecutionEvidence({
        headSha: salvageHead,
        testCommand: undefined,
        resultFilePath: testResultFile,
        executor: executor || "executor",
        testExitCode: 0,
      }),
      recorded_by: "reconcile-salvage-operator-v1",
    });
    const hash = hashFileSha256(writtenPath);
    appendRunEvent(repoRoot, runId, {
      event: EVENTS.OPERATOR_EXECUTION_EVIDENCE,
      state_from: STATES.ESCALATED,
      state_to: STATES.REVIEW_PENDING,
      head_sha: salvageHead,
      reason,
      operator_initiated: true,
      execution_evidence_path: writtenPath,
      execution_evidence_hash: hash,
    });
    return { verified: true, recordedBy: "reconcile-salvage-operator-v1", path: writtenPath, hash };
  }
  if (plan.action === "rebrand_placeholder") {
    const rebrand = rebrandEvidence(runDir, {
      newHeadSha: salvageHead,
      recordedBy: "reconcile-salvage-rebrand",
      reason,
    });
    if (rebrand.rewritten) {
      appendRunEvent(repoRoot, runId, {
        event: EVENTS.EXECUTION_EVIDENCE_REBRANDED,
        previous_head_sha: rebrand.previousSha,
        new_head_sha: salvageHead,
        reason,
        override_class: "execution_evidence_rebrand",
        affected_head_sha: salvageHead,
        prior_state: STATES.ESCALATED,
        required_reason: reason,
        operator_initiated: true,
        execution_evidence_path: rebrand.evidencePath,
        execution_evidence_hash: rebrand.evidenceHash,
      });
    }
    return {
      verified: false,
      placeholder: true,
      rebranded: rebrand.rewritten === true,
      skipped: rebrand.skipped || null,
      path: plan.evidencePath,
    };
  }
  const writtenPath = writeExecutionEvidence(runDir, buildExecutionEvidence({
    headSha: salvageHead,
    testCommand: undefined,
    resultFilePath: null,
    executor: executor || "executor",
  }));
  return { verified: false, placeholder: true, written: true, path: writtenPath };
}

function warnSalvagePlaceholderEvidence(runId) {
  console.error(
    `Warning: salvage execution evidence for ${runId} is a replaceable placeholder ` +
    "(not operator-verified); pass --test-result-file <path> to record verified evidence."
  );
}

function salvageResult({ status, manifestPath, runId, data, dryRun, nextAction, extra = {} }) {
  return {
    ...buildBaseResult({
      row: SALVAGE_ROW,
      rowName: SALVAGE_ROW_NAME,
      status,
      manifestPath,
      runId,
      data,
      dryRun,
      nextAction,
    }),
    ...extra,
  };
}

async function trySalvageEscalatedTimeout(
  { repoRoot, runId, manifestPath, body, data, worktreePath, dryRun, jsonOut, testResultFile }
) {
  if (!isEscalatedTimeoutRun(repoRoot, runId, data)) return false;

  const branch = data.git?.working_branch || null;

  // Never preempt a still-owned run — a live (or unverifiable host-mismatch) lease
  // means the supervisor process group may still be alive.
  const leaseStatus = getRunLeaseStatus(repoRoot, runId);
  if (leaseStatus.live || leaseStatus.reason === "host_mismatch") {
    outputResult(salvageResult({
      status: "still_owned",
      manifestPath,
      runId,
      data,
      dryRun,
      nextAction: "wait_for_executor",
      extra: {
        lease: leaseStatus.lease,
        leaseStatus: leaseStatus.reason,
        elapsed_s: leaseStatus.elapsed_s,
        remaining_s: leaseStatus.remaining_s,
      },
    }), jsonOut);
    return true;
  }

  // Worktree gone or branch unknown: nothing to salvage -> fall through to row-1 noop.
  if (!branch || !worktreePath || !fs.existsSync(worktreePath)) return false;

  const inspection = inspectSalvageWorktree(worktreePath, branch, data);

  // A dirty tree is surfaced for manual handling, never auto-salvaged.
  if (inspection.hasReviewableDirt) {
    outputResult(salvageResult({
      status: "dirty_surfaced",
      manifestPath,
      runId,
      data,
      dryRun,
      nextAction: "manual_recover_commit",
      extra: {
        branch,
        hasReviewableDirt: true,
        unpushedCommits: inspection.unpushedCommits,
      },
    }), jsonOut);
    return true;
  }

  // Clean tree but no unpushed commits: genuinely nothing to salvage -> row-1 noop.
  if (inspection.unpushedCommits <= 0) return false;

  const runDir = getRunDir(repoRoot, runId);
  const executor = data.roles?.executor || "executor";
  const pushTarget = `origin/${branch}`;
  const evidencePlan = planSalvageEvidence(runDir, testResultFile);
  const reason = salvageAuditReason(runId);

  if (dryRun) {
    outputResult(salvageResult({
      status: "dry_run",
      manifestPath,
      runId,
      data,
      dryRun,
      nextAction: "salvage_push_then_review",
      extra: {
        branch,
        unpushedCommits: inspection.unpushedCommits,
        pushTarget,
        forceWithLease: true,
        evidenceAction: evidencePlan.action,
        evidenceVerified: evidencePlan.verified,
        targetState: STATES.REVIEW_PENDING,
        plannedActions: [
          `push_force_with_lease:${pushTarget}`,
          "remove_lease_if_present",
          evidencePlan.verified
            ? "stamp_operator_execution_evidence"
            : "write_replaceable_placeholder_evidence",
          "force_transition_escalated_to_review_pending",
        ],
      },
    }), jsonOut);
    return true;
  }

  // Push before any state mutation: a rejected lease leaves the run untouched.
  const pushResult = pushSalvageForceWithLease(worktreePath, branch);
  if (!pushResult.ok) {
    outputResult(salvageResult({
      status: "push_rejected",
      manifestPath,
      runId,
      data,
      dryRun,
      nextAction: "manual_reconcile_remote",
      extra: {
        branch,
        pushTarget,
        unpushedCommits: inspection.unpushedCommits,
        forceWithLeaseRejected: true,
        pushError: pushResult.detail,
      },
    }), jsonOut);
    return true;
  }

  removeRunLease(repoRoot, runId);

  const salvageHead = inspection.currentHead || data.git?.head_sha || null;
  const executionEvidence = stampSalvageEvidence({
    repoRoot,
    runId,
    runDir,
    salvageHead,
    executor,
    testResultFile,
    reason,
  });
  if (!executionEvidence.verified) {
    warnSalvagePlaceholderEvidence(runId);
  }

  const updated = {
    ...forceUpdateManifestState(data, STATES.REVIEW_PENDING, "run_review", { reason }),
    git: {
      ...(data.git || {}),
      head_sha: salvageHead || data.git?.head_sha || null,
    },
  };
  writeManifest(manifestPath, updated, body);
  appendStateRecovery(repoRoot, data, updated, reason);

  outputResult(salvageResult({
    status: "salvaged",
    manifestPath,
    runId,
    data: updated,
    dryRun,
    nextAction: updated.next_action,
    extra: {
      state: updated.state,
      branch,
      pushTarget,
      unpushedCommits: inspection.unpushedCommits,
      forceWithLease: true,
      executionEvidence,
    },
  }), jsonOut);
  return true;
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
  const testResultFile = resolveTestResultFile(readArg(args, "--test-result-file", undefined, CLI_ARG_OPTIONS));
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
    const salvaged = await trySalvageEscalatedTimeout({
      repoRoot: normalizedRepoRoot,
      runId: normalizedRunId,
      manifestPath: record.manifestPath,
      body: record.body,
      data,
      worktreePath,
      dryRun,
      jsonOut,
      testResultFile,
    });
    if (salvaged) return;
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
