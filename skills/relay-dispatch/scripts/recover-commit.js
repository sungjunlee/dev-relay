#!/usr/bin/env node
"use strict";

/**
 * relay-recover-commit: commit executor-complete-but-uncommitted runs; push/open PR only after publication.
 */

const fs = require("fs");
const path = require("path");

const { parsePrNumber, formatExecError } = require("./dispatch-publish");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent, EVENTS } = require("./relay-events");
const { STATES, updateManifestState } = require("./manifest/lifecycle");
const { writeManifest } = require("./manifest/store");
const { getCanonicalRepoRoot, getRunDir, nowIso, summarizeFailure, validateManifestPaths } = require("./manifest/paths");
const { stampPrNumberUnderLock } = require("./manifest/pr-number-stamp");
const {
  EXECUTION_EVIDENCE_FILENAME,
  buildExecutionEvidence,
  hashFileSha256,
  rebrandEvidence,
  writeExecutionEvidence,
} = require("./execution-evidence");
const {
  findUnknownFlags,
  modeLabel,
  readArg,
  schemaHasFlag,
} = require("./cli-args");
const { execGit, execGh, resolveBranchRemote } = require("./exec");
const {
  classifyRepositoryDirt,
  formatRuntimeMetadataDirt,
  gitAddReviewableArgs,
} = require("./runtime-dirt");
const {
  formatLeaseForMessage,
  getRunLeaseStatus,
} = require("./run-runtime-state");

const args = process.argv.slice(2);
const CLI_ARG_OPTIONS = { commandName: "recover-commit", reservedFlags: ["-h"] };
const hasCliFlag = (flag) => schemaHasFlag(args, flag, CLI_ARG_OPTIONS);
const getCliArg = (flag, fallback) => readArg(args, flag, fallback, CLI_ARG_OPTIONS);

function printHelp(exitCode) {
  console.log("Usage: recover-commit.js (--repo <path> --run-id <id> | --manifest <path>) --reason <text> [options]");
  console.log("\nCommit recoverable work left by an executor. review_pending runs push/open PR; internal_review_pending runs only commit locally.");
  console.log("\nOptions:");
  console.log(`  --repo <path>       ${modeLabel("--repo")} Repository root used with --run-id (default: .)`);
  console.log(`  --run-id <id>       ${modeLabel("--run-id")} Relay run identifier`);
  console.log(`  --manifest <path>   ${modeLabel("--manifest")} Explicit manifest path`);
  console.log(`  --reason <text>     ${modeLabel("--reason")} Required audit reason; preserved verbatim`);
  console.log(`  --pr-title <text>   ${modeLabel("--pr-title")} PR title override`);
  console.log(`  --pr-body-file <path> ${modeLabel("--pr-body-file")} PR body override file`);
  console.log(`  --test-command <cmd> ${modeLabel("--test-command")} Operator-run test command for missing execution evidence`);
  console.log(`  --test-result-file <path> ${modeLabel("--test-result-file")} Operator-run test output file to hash for missing execution evidence`);
  console.log(`  --test-exit-code <n> ${modeLabel("--test-exit-code")} Operator-run test exit code for missing execution evidence`);
  console.log(`  --replace-placeholder-evidence ${modeLabel("--replace-placeholder-evidence")} Replace timeout placeholder evidence with operator-run evidence`);
  console.log(`  --dry-run           ${modeLabel("--dry-run")} Print planned git/gh commands and manifest mutation only`);
  console.log(`  --json              ${modeLabel("--json")} Output JSON`);
  console.log("\nDecision tree:");
  console.log("  - Use recover-commit when the executor completed and the retained worktree has uncommitted changes or unpushed commits.");
  console.log("  - Use dispatch.js --run-id <id> when review requested changes and you need a same-run executor resume.");
  console.log("  - Use finalize-run.js --force-finalize-nonready --reason <text> only when an operator intentionally merges a non-ready run.");
  process.exit(exitCode);
}

if (!args.length || hasCliFlag(["--help", "-h"])) {
  printHelp(hasCliFlag(["--help", "-h"]) ? 0 : 1);
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function commandRecord(cwd, argv) {
  return {
    cwd,
    argv,
    shell: argv.map(shellQuote).join(" "),
  };
}

function defaultPrTitle(branch, runId) {
  return `Recover ${branch} (${runId})`;
}

function normalizeIssueNumber(value) {
  const issueNumber = Number(value);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
}

function inferIssueNumberFromBranch(branch) {
  const matches = [...String(branch || "").matchAll(/(?:^|\/)issue-(\d+)(?=$|[-/])/g)];
  if (matches.length !== 1) return null;
  return normalizeIssueNumber(matches[0][1]);
}

function resolveIssueNumberForTitle(data, branch) {
  return normalizeIssueNumber(data.issue?.number) || inferIssueNumberFromBranch(branch);
}

function fetchIssueTitle(repoPath, issueNumber) {
  const raw = execGh(repoPath, ["issue", "view", String(issueNumber), "--json", "title,number"]);
  const parsed = JSON.parse(raw);
  const parsedNumber = normalizeIssueNumber(parsed.number);
  const title = String(parsed.title || "").trim();
  if (parsedNumber !== issueNumber || !title) {
    throw new Error(`gh issue view returned invalid title data for issue #${issueNumber}`);
  }
  return title;
}

function resolvePrTitle({ explicitTitle, repoPath, branch, runId, data }) {
  if (explicitTitle) {
    return {
      title: explicitTitle,
      source: "explicit",
      issueNumber: null,
    };
  }

  const fallbackTitle = defaultPrTitle(branch, runId);
  const issueNumber = resolveIssueNumberForTitle(data, branch);
  if (!issueNumber) {
    return {
      title: fallbackTitle,
      source: "fallback",
      issueNumber: null,
    };
  }

  try {
    const issueTitle = fetchIssueTitle(repoPath, issueNumber);
    return {
      title: `${issueTitle} (#${issueNumber})`,
      source: normalizeIssueNumber(data.issue?.number) ? "manifest_issue" : "branch_issue",
      issueNumber,
    };
  } catch {
    return {
      title: fallbackTitle,
      source: "fallback",
      issueNumber,
    };
  }
}

function buildPrBody({ runId, reason, branch, timestamp, manifestPath, data }) {
  return [
    "## Recovery Summary",
    "",
    "Opened by `relay-recover-commit` after the executor completed but did not publish a PR.",
    "",
    `- Run ID: ${runId}`,
    `- Branch: ${branch}`,
    `- Reason: ${reason}`,
    `- Provenance: manifest ${manifestPath}; orchestrator=${data.roles?.orchestrator || "unknown"}; executor=${data.roles?.executor || "unknown"}`,
    `- Recovered at (UTC): ${timestamp}`,
  ].join("\n");
}

function buildCommitBody({ runId, reason, timestamp }) {
  return [
    `Run ID: ${runId}`,
    `Reason: ${reason}`,
    `Recovered at (UTC): ${timestamp}`,
  ].join("\n");
}

function readPrBodyFile(prBodyFile) {
  if (!prBodyFile) return null;
  const resolved = path.resolve(prBodyFile);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`--pr-body-file must point to a file: ${resolved}`);
  }
  return fs.readFileSync(resolved, "utf-8");
}

function parseTestExitCode(value, flagWasProvided) {
  if (!flagWasProvided) return undefined;
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error("--test-exit-code <n> is required when --test-exit-code is provided");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`--test-exit-code must be an integer, got ${value}`);
  }
  if (parsed !== 0) {
    throw new Error(`--test-exit-code must be 0 for operator-verified execution evidence, got ${parsed}`);
  }
  return parsed;
}

function resolveTestResultFile(resultFileArg) {
  if (!resultFileArg) return undefined;
  const resolved = path.resolve(resultFileArg);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`--test-result-file must point to a file: ${resolved}`);
  }
  return resolved;
}

function validateOperatorEvidenceFlagSet(providedFlags) {
  if (providedFlags.length === 0 || providedFlags.length === 3) return;
  const required = ["--test-command", "--test-result-file", "--test-exit-code"];
  const missing = required.filter((flag) => !providedFlags.includes(flag));
  throw new Error(
    "Operator execution evidence flags must be provided together: " +
    `${required.join(", ")}. Missing: ${missing.join(", ")}`
  );
}

function warnMissingExecutionEvidence(runId) {
  console.error(
    `Warning: ${EXECUTION_EVIDENCE_FILENAME} missing for ${runId}; ` +
    "pass --test-command <cmd> --test-result-file <path> --test-exit-code <n> to record operator-run evidence."
  );
}

function writeOperatorExecutionEvidenceIfRequested({
  runDir,
  evidencePath,
  operatorEvidenceRequested,
  testCommand,
  testResultFile,
  testExitCode,
  headSha,
  timestamp,
}) {
  if (!operatorEvidenceRequested) return null;
  const evidence = {
    ...buildExecutionEvidence({
      headSha,
      testCommand,
      resultFilePath: testResultFile,
      executor: "recover-commit-operator-v1",
      recordedAt: timestamp,
      testExitCode,
    }),
    recorded_by: "recover-commit-operator-v1",
  };
  const writtenPath = writeExecutionEvidence(runDir, evidence);
  return {
    path: writtenPath,
    hash: hashFileSha256(writtenPath),
  };
}

function resolveRun({ repoArg, runId, manifestArg }) {
  const repoRoot = path.resolve(repoArg || ".");
  try {
    return resolveManifestRecord({
      repoRoot,
      manifestPath: manifestArg,
      runId,
    });
  } catch (error) {
    throw new Error(`run_resolution_failed: ${summarizeFailure(error)}`);
  }
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
  throw new Error(`unsupported dispatch.publish_policy for recovery: ${publishPolicy}`);
}

function expectedRepoRootForValidation(repoArg, manifestArg) {
  if (manifestArg && !repoArg) return undefined;
  return getCanonicalRepoRoot(path.resolve(repoArg || "."));
}

function countRange(worktreePath, range) {
  const raw = execGit(worktreePath, ["rev-list", "--count", range]);
  const count = Number(raw);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

function countUnpushedCommits(worktreePath, branch, baseBranch, remoteName = "origin") {
  try {
    const upstream = execGit(worktreePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (upstream) return countRange(worktreePath, `${upstream}..HEAD`);
  } catch {}

  for (const ref of [
    `refs/remotes/${remoteName}/${branch}`,
    ...(baseBranch ? [`refs/remotes/${remoteName}/${baseBranch}`, baseBranch] : []),
  ]) {
    try {
      execGit(worktreePath, ["rev-parse", "--verify", ref]);
      return countRange(worktreePath, `${ref}..HEAD`);
    } catch {}
  }
  return 0;
}

function findExistingPr(worktreePath, branch) {
  const raw = execGh(worktreePath, ["pr", "list", "--head", branch, "--json", "number", "--jq", ".[0].number"]);
  return parsePrNumber(raw);
}

function appendRecoveryEvent(repoRoot, data, event, reason, commitSha, prNumber, branch) {
  appendRunEvent(repoRoot, data.run_id, {
    event,
    state_from: data.state,
    state_to: data.state,
    head_sha: commitSha || data.git?.head_sha || null,
    commit_sha: commitSha || null,
    pr_number: prNumber ?? null,
    branch,
    round: data.review?.rounds || null,
    reason,
  });
}

function appendFailureEvent(repoRoot, data, status, detail, commitSha, branch) {
  try {
    appendRecoveryEvent(repoRoot, data, EVENTS.RECOVER_COMMIT_FAILED, `${status}: ${detail}`, commitSha, null, branch);
  } catch {}
}

function main() {
  const unknownFlags = findUnknownFlags(args, "recover-commit");
  if (unknownFlags.length > 0) {
    throw new Error(`Unknown flag(s): ${unknownFlags.join(", ")}`);
  }

  const repoArg = getCliArg("--repo");
  const runId = getCliArg("--run-id");
  const manifestArg = getCliArg("--manifest");
  const reason = String(getCliArg("--reason") || "").trim();
  const prTitleArg = getCliArg("--pr-title");
  const prBodyFile = getCliArg("--pr-body-file");
  const operatorEvidenceFlags = ["--test-command", "--test-result-file", "--test-exit-code"]
    .filter((flag) => hasCliFlag(flag));
  const replacePlaceholderEvidence = hasCliFlag("--replace-placeholder-evidence");
  validateOperatorEvidenceFlagSet(operatorEvidenceFlags);
  if (replacePlaceholderEvidence && operatorEvidenceFlags.length === 0) {
    throw new Error(
      "--replace-placeholder-evidence requires operator execution evidence flags together: " +
      "--test-command, --test-result-file, --test-exit-code"
    );
  }
  const operatorEvidenceRequested = operatorEvidenceFlags.length > 0;
  const testCommand = getCliArg("--test-command");
  const testResultFileArg = getCliArg("--test-result-file");
  const testExitCodeArg = getCliArg("--test-exit-code");
  if (operatorEvidenceRequested) {
    // A flag given as the final argv token parses to undefined; blank values are
    // equally unusable — both would silently write "unspecified" evidence fields.
    if (typeof testCommand !== "string" || testCommand.trim() === "") {
      throw new Error("--test-command requires a non-empty value when recording operator evidence");
    }
    if (typeof testResultFileArg !== "string" || testResultFileArg.trim() === "") {
      throw new Error("--test-result-file requires a non-empty value when recording operator evidence");
    }
  }
  const testExitCodeProvided = hasCliFlag("--test-exit-code");
  const dryRun = hasCliFlag("--dry-run");
  const jsonOut = hasCliFlag("--json");
  const timestamp = nowIso();

  if (!runId && !manifestArg) {
    throw new Error("Either --run-id or --manifest is required");
  }
  if (runId && manifestArg) {
    throw new Error("Use either --run-id or --manifest, not both");
  }
  if (!reason) {
    throw new Error("--reason <text> is required");
  }

  const manifestRecord = resolveRun({ repoArg, runId, manifestArg });
  const expectedRepoRoot = expectedRepoRootForValidation(repoArg, manifestArg);
  const validatedPaths = validateManifestPaths(manifestRecord.data?.paths, {
    expectedRepoRoot,
    manifestPath: manifestRecord.manifestPath,
    runId: manifestRecord.data?.run_id,
    caller: "recover-commit",
  });
  let data = {
    ...manifestRecord.data,
    paths: {
      ...(manifestRecord.data?.paths || {}),
      repo_root: validatedPaths.repoRoot,
      worktree: validatedPaths.worktree,
    },
  };
  const branch = data.git?.working_branch;
  const worktreePath = validatedPaths.worktree;
  const runDir = getRunDir(validatedPaths.repoRoot, data.run_id);
  const evidencePath = path.join(runDir, EXECUTION_EVIDENCE_FILENAME);
  const evidenceExists = fs.existsSync(evidencePath);
  let replacedEvidence = null;

  if (operatorEvidenceRequested && evidenceExists) {
    let existingEvidence = null;
    try {
      const parsedEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
      if (parsedEvidence && typeof parsedEvidence === "object" && !Array.isArray(parsedEvidence)) {
        existingEvidence = parsedEvidence;
      }
    } catch {}
    const isPlaceholder = (
      existingEvidence?.recorded_by === "dispatch-orchestrator-v1" &&
      existingEvidence?.test_command === "unspecified"
    );
    if (replacePlaceholderEvidence && isPlaceholder) {
      replacedEvidence = {
        recorded_by: existingEvidence.recorded_by,
        test_exit_code: existingEvidence.test_exit_code ?? null,
      };
    } else {
      const placeholderHint = isPlaceholder && !replacePlaceholderEvidence
        ? " Pass --replace-placeholder-evidence to replace timeout placeholder evidence."
        : "";
      throw new Error(
        `${EXECUTION_EVIDENCE_FILENAME} already exists for ${data.run_id}; refusing to overwrite it. ` +
        "Use skills/relay-dispatch/scripts/rebrand-evidence.js when existing evidence needs to be rebound to a new HEAD." +
        placeholderHint
      );
    }
  }
  const testResultFile = resolveTestResultFile(testResultFileArg);
  const testExitCode = parseTestExitCode(testExitCodeArg, testExitCodeProvided);

  if (data.state === STATES.MERGED || data.state === STATES.CLOSED) {
    throw new Error(`force-finalize cannot be used from terminal state ${data.state}`);
  }
  const recoveringFromDispatched = data.state === STATES.DISPATCHED;
  if (recoveringFromDispatched) {
    const leaseStatus = getRunLeaseStatus(validatedPaths.repoRoot, data.run_id);
    if (leaseStatus.live || leaseStatus.reason === "host_mismatch") {
      const leaseKind = leaseStatus.reason === "host_mismatch" ? "unverifiable run lease" : "live run lease";
      throw new Error(
        `recover-commit refuses dispatched recovery while ${leaseKind} exists for ${data.run_id}: ` +
        `${formatLeaseForMessage(leaseStatus)}. Run reconcile-run.js --repo ${validatedPaths.repoRoot} --run-id ${data.run_id} first.`
      );
    }
    const target = dispatchCompletionTarget(data);
    data = updateManifestState(data, target.state, target.nextAction);
  }
  const internalReview = data.state === STATES.INTERNAL_REVIEW_PENDING;
  if (![STATES.INTERNAL_REVIEW_PENDING, STATES.REVIEW_PENDING].includes(data.state)) {
    throw new Error(`recover-commit requires state=${STATES.INTERNAL_REVIEW_PENDING} or ${STATES.REVIEW_PENDING}, got ${data.state}`);
  }
  if (!branch) {
    throw new Error("manifest is missing git.working_branch");
  }

  const currentBranch = execGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (currentBranch !== branch) {
    throw new Error(`manifest worktree is on branch ${currentBranch}, expected ${branch}`);
  }

  const statusText = execGit(worktreePath, ["status", "--porcelain"]);
  const dirt = classifyRepositoryDirt(statusText);
  const hasUncommittedChanges = dirt.hasReviewableDirt;
  const baseBranch = data.git?.base_branch || "main";
  const remoteName = resolveBranchRemote(worktreePath, branch);
  const unpushedCommits = countUnpushedCommits(worktreePath, branch, data.git?.base_branch, remoteName);
  const prBody = readPrBodyFile(prBodyFile) || buildPrBody({
    runId: data.run_id,
    reason,
    branch,
    timestamp,
    manifestPath: manifestRecord.manifestPath,
    data,
  });
  const commitTitle = `Recover relay run ${data.run_id}`;
  const commitBody = buildCommitBody({ runId: data.run_id, reason, timestamp });

  let existingPrNumber = null;
  if (!internalReview && !dryRun) {
    try {
      existingPrNumber = findExistingPr(worktreePath, branch);
    } catch (error) {
      throw new Error(`pr_list_failed: ${formatExecError(error)}`);
    }
  }
  if (dirt.hasOnlyRuntimeMetadataDirt && unpushedCommits === 0 && existingPrNumber === null) {
    const detail = (
      "worktree contains only runtime metadata dirt " +
      `(${formatRuntimeMetadataDirt(statusText)}); executor produced no reviewable repository changes`
    );
    appendFailureEvent(validatedPaths.repoRoot, data, "nothing_to_recover", detail, data.git?.head_sha || null, branch);
    throw new Error(`nothing_to_recover: ${detail}`);
  }
  if (!hasUncommittedChanges && unpushedCommits === 0 && existingPrNumber === null) {
    throw new Error("nothing_to_recover: worktree has no uncommitted changes, no unpushed commits, and no existing PR");
  }

  if (dryRun) {
    const prTitleResolution = internalReview
      ? { title: null, source: "not_published", issueNumber: null }
      : resolvePrTitle({
        explicitTitle: prTitleArg,
        repoPath: worktreePath,
        branch,
        runId: data.run_id,
        data,
      });
    const plannedCommands = internalReview
      ? []
      : [commandRecord(worktreePath, ["gh", "pr", "list", "--head", branch, "--json", "number", "--jq", ".[0].number"])];
    if (hasUncommittedChanges) {
      plannedCommands.push(commandRecord(worktreePath, ["git", "-C", worktreePath, "add", "-A"]));
      plannedCommands.push(commandRecord(worktreePath, ["git", "-C", worktreePath, "commit", "-m", commitTitle, "-m", commitBody]));
    }
    if (!internalReview) {
      plannedCommands.push(commandRecord(worktreePath, ["git", "-C", worktreePath, "push", "-u", remoteName, branch]));
      plannedCommands.push(commandRecord(worktreePath, [
        "gh", "pr", "create",
        "--base", baseBranch,
        "--head", branch,
        "--title", prTitleResolution.title,
        "--body", prBody,
      ]));
    }

    const result = {
      status: "dry_run",
      runId: data.run_id,
      branch,
      worktree: worktreePath,
      prTitle: prTitleResolution.title,
      prTitleSource: prTitleResolution.source,
      prTitleIssueNumber: prTitleResolution.issueNumber,
      hasUncommittedChanges,
      unpushedCommits,
      commands: plannedCommands,
      manifestMutation: {
        state: data.state,
        git_head_sha: "update after commit, if a commit is created",
        git_pr_number: internalReview ? null : "stamp after PR number is known, if missing",
      },
    };
    console.log(jsonOut ? JSON.stringify(result, null, 2) : plannedCommands.map((cmd) => cmd.shell).join("\n"));
    return;
  }

  let commitSha = execGit(worktreePath, ["rev-parse", "HEAD"]);
  let commitCreated = false;
  if (hasUncommittedChanges) {
    try {
      execGit(worktreePath, gitAddReviewableArgs(statusText));
      execGit(worktreePath, ["commit", "-m", commitTitle, "-m", commitBody]);
      commitSha = execGit(worktreePath, ["rev-parse", "HEAD"]);
      commitCreated = true;
    } catch (error) {
      const detail = formatExecError(error);
      appendFailureEvent(validatedPaths.repoRoot, data, "commit_failed", detail, commitSha, branch);
      throw new Error(`commit_failed: ${detail}`);
    }
  }
  if (evidenceExists && !replacedEvidence) {
    const rebrandResult = rebrandEvidence(runDir, {
      newHeadSha: commitSha,
      recordedBy: "recover-commit-rebrand",
      reason: commitCreated
        ? `recover-commit added new commit; previous evidence bound to pre-commit SHA. Audit reason: ${reason}`
        : `recover-commit recovered existing commit; previous evidence bound to stale SHA. Audit reason: ${reason}`,
    });
    if (rebrandResult.rewritten) {
      appendRunEvent(validatedPaths.repoRoot, data.run_id, {
        event: EVENTS.EXECUTION_EVIDENCE_REBRANDED,
        previous_head_sha: rebrandResult.previousSha,
        new_head_sha: commitSha,
        reason,
        override_class: "execution_evidence_rebrand",
        affected_head_sha: commitSha,
        prior_state: data.state,
        required_reason: reason,
        operator_initiated: true,
        execution_evidence_path: rebrandResult.evidencePath,
        execution_evidence_hash: rebrandResult.evidenceHash,
      });
    }
  }
  if (!evidenceExists || replacedEvidence) {
    const operatorEvidence = writeOperatorExecutionEvidenceIfRequested({
      runDir,
      evidencePath,
      operatorEvidenceRequested,
      testCommand,
      testResultFile,
      testExitCode,
      headSha: commitSha,
      timestamp,
    });
    if (operatorEvidence) {
      appendRunEvent(validatedPaths.repoRoot, data.run_id, {
        event: EVENTS.OPERATOR_EXECUTION_EVIDENCE,
        state_from: data.state,
        state_to: data.state,
        head_sha: commitSha,
        commit_sha: commitSha,
        branch,
        round: data.review?.rounds || null,
        reason,
        operator_initiated: true,
        execution_evidence_path: operatorEvidence.path,
        execution_evidence_hash: operatorEvidence.hash,
        ...(replacedEvidence ? { before: replacedEvidence } : {}),
      });
    }
    if (!operatorEvidenceRequested) {
      warnMissingExecutionEvidence(data.run_id);
    }
  }

  let prNumber = existingPrNumber;
  let prCreated = false;
  if (internalReview) {
    const updatedData = {
      ...data,
      next_action: "run_internal_review",
      git: {
        ...(data.git || {}),
        head_sha: commitSha,
      },
    };
    writeManifest(manifestRecord.manifestPath, updatedData, manifestRecord.body);
    appendRecoveryEvent(validatedPaths.repoRoot, updatedData, EVENTS.RECOVER_COMMIT, reason, commitSha, null, branch);
    const result = {
      status: "recovered",
      manifestPath: manifestRecord.manifestPath,
      runId: data.run_id,
      state: updatedData.state,
      branch,
      worktree: worktreePath,
      commitSha,
      commitCreated,
      prNumber: null,
      prCreated: false,
      existingPr: false,
      dryRun: false,
    };
    if (jsonOut) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Recovered relay run: ${data.run_id}`);
      console.log(`  Branch: ${branch}`);
      console.log(`  Commit: ${commitSha}${commitCreated ? " (created)" : " (existing)"}`);
      console.log("  PR: not published yet");
      console.log(`  State: ${result.state}`);
    }
    return;
  }

  const shouldPush = prNumber === null || hasUncommittedChanges || unpushedCommits > 0;
  if (shouldPush) {
    try {
      execGit(worktreePath, ["push", "-u", remoteName, branch]);
    } catch (error) {
      const detail = formatExecError(error);
      appendFailureEvent(validatedPaths.repoRoot, data, "push_failed", detail, commitSha, branch);
      throw new Error(`push_failed: ${detail}`);
    }
  }

  if (prNumber === null) {
    try {
      prNumber = findExistingPr(worktreePath, branch);
    } catch (error) {
      const detail = formatExecError(error);
      appendFailureEvent(validatedPaths.repoRoot, data, "pr_create_failed", detail, commitSha, branch);
      throw new Error(`pr_create_failed: ${detail}`);
    }
    if (prNumber === null) {
      try {
        const prTitleResolution = resolvePrTitle({
          explicitTitle: prTitleArg,
          repoPath: worktreePath,
          branch,
          runId: data.run_id,
          data,
        });
        // --base/--head are explicit: without --base, gh falls back to the repository
      // default branch and silently opens the recovery PR against the wrong target
      // whenever manifest git.base_branch differs (#1083).
      const raw = execGh(worktreePath, [
        "pr", "create",
        "--base", baseBranch,
        "--head", branch,
        "--title", prTitleResolution.title,
        "--body", prBody,
      ]);
        prNumber = parsePrNumber(raw);
      } catch (error) {
        const detail = formatExecError(error);
        appendFailureEvent(validatedPaths.repoRoot, data, "pr_create_failed", detail, commitSha, branch);
        throw new Error(`pr_create_failed: ${detail}`);
      }
      if (prNumber === null) {
        const detail = "could not parse PR number from gh pr create output";
        appendFailureEvent(validatedPaths.repoRoot, data, "pr_create_failed", detail, commitSha, branch);
        throw new Error(`pr_create_failed: ${detail}`);
      }
      prCreated = true;
    }
  }

  // git.head_sha must follow any commit we just created, independent of whether a
  // pr_number stamp is also due (#1084). Previously a run that was already
  // review_pending with pr_number set took neither stamping branch, so no manifest
  // write happened at all and head_sha stayed at the pre-commit SHA while the
  // evidence artifact had already been rebound to the new commit.
  const prNumberUnset = data.git?.pr_number === undefined || data.git?.pr_number === null;
  let stampedRecord = manifestRecord;
  if (recoveringFromDispatched || prNumberUnset || commitCreated) {
    stampedRecord = stampPrNumberUnderLock(manifestRecord, prNumber, {
      expectedRepoRoot: validatedPaths.repoRoot,
      caller: recoveringFromDispatched
        ? "recover-commit dispatched PR stamping"
        : "recover-commit PR stamping",
      reason: `Stamped git.pr_number=${prNumber} during recover-commit`,
      updateFreshData(freshData) {
        let updatedData = freshData;
        let shouldUpdateHead = false;
        if (updatedData.state === STATES.DISPATCHED) {
          const target = dispatchCompletionTarget(updatedData);
          updatedData = updateManifestState(updatedData, target.state, target.nextAction);
          shouldUpdateHead = true;
        } else if ([STATES.INTERNAL_REVIEW_PENDING, STATES.REVIEW_PENDING].includes(updatedData.state)) {
          shouldUpdateHead = recoveringFromDispatched || commitCreated;
        }
        if (!shouldUpdateHead) {
          return updatedData;
        }
        return {
          ...updatedData,
          git: {
            ...(updatedData.git || {}),
            head_sha: commitSha,
          },
        };
      },
    });
  }

  appendRecoveryEvent(validatedPaths.repoRoot, stampedRecord.data || data, EVENTS.RECOVER_COMMIT, reason, commitSha, prNumber, branch);

  const result = {
    status: "recovered",
    manifestPath: manifestRecord.manifestPath,
    runId: data.run_id,
    state: (stampedRecord.data || data).state,
    branch,
    worktree: worktreePath,
    commitSha,
    commitCreated,
    prNumber,
    prCreated,
    existingPr: existingPrNumber !== null,
    dryRun: false,
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Recovered relay run: ${data.run_id}`);
    console.log(`  Branch: ${branch}`);
    console.log(`  Commit: ${commitSha}${commitCreated ? " (created)" : " (existing)"}`);
    console.log(`  PR: #${prNumber}${prCreated ? " (created)" : " (existing)"}`);
    console.log(`  State: ${result.state}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
