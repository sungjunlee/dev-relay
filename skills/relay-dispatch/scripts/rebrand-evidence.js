#!/usr/bin/env node
"use strict";

/**
 * relay-rebrand-evidence: update execution evidence after orchestrator-side
 * correction commits without committing, pushing, opening PRs, or changing state.
 */

const fs = require("fs");
const path = require("path");

const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent, EVENTS } = require("./relay-events");
const {
  EXECUTION_EVIDENCE_FILENAME,
  rebrandEvidence,
} = require("./execution-evidence");
const { getCanonicalRepoRoot, getRunDir, summarizeFailure, validateManifestPaths } = require("./manifest/paths");
const {
  findUnknownFlags,
  modeLabel,
  readArg,
  schemaHasFlag,
} = require("./cli-args");
const { execGit } = require("./exec");

const args = process.argv.slice(2);
const CLI_ARG_OPTIONS = { commandName: "rebrand-evidence", reservedFlags: ["-h"] };
const hasCliFlag = (flag) => schemaHasFlag(args, flag, CLI_ARG_OPTIONS);
const getCliArg = (flag, fallback) => readArg(args, flag, fallback, CLI_ARG_OPTIONS);
const RECORDED_BY = "orchestrator-correction-rebrand";

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function printHelp(exitCode) {
  console.log("Usage: rebrand-evidence.js (--repo <path> --run-id <id> | --manifest <path>) --reason <text> [--dry-run] [--json]");
  console.log("\nRebind an existing execution-evidence.json artifact to the current correction commit without publishing git changes.");
  console.log("\nOptions:");
  console.log(`  --repo <path>       ${modeLabel("--repo")} Repository root used with --run-id (default: .)`);
  console.log(`  --run-id <id>       ${modeLabel("--run-id")} Relay run identifier`);
  console.log(`  --manifest <path>   ${modeLabel("--manifest")} Explicit manifest path`);
  console.log(`  --reason <text>     ${modeLabel("--reason")} Required audit reason; preserved verbatim`);
  console.log(`  --dry-run           ${modeLabel("--dry-run")} Print the planned evidence mutation only`);
  console.log(`  --json              ${modeLabel("--json")} Output JSON`);
  console.log(`  --help              ${modeLabel("--help")} Show this help`);
  console.log("\nDecision tree:");
  console.log("  Use rebrand-evidence after the orchestrator already made a correction commit and only execution-evidence.json is stale.");
  console.log("  Use recover-commit when the executor left recoverable work that still needs commit, push, or PR publication.");
  console.log("  Use finalize-run --force-finalize-nonready only when an operator intentionally finalizes a non-ready run despite the review gate.");
  process.exit(exitCode);
}

if (hasCliFlag(["--help", "-h"])) {
  printHelp(0);
}

function usageError(message) {
  throw new UsageError(`${message}. See --help.`);
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

function expectedRepoRootForValidation(repoArg, manifestArg) {
  if (manifestArg && !repoArg) return undefined;
  return getCanonicalRepoRoot(path.resolve(repoArg || "."));
}

function readCurrentHeadSha(data, validatedPaths) {
  const branch = data.git?.working_branch;
  if (!branch) {
    throw new Error("manifest is missing git.working_branch");
  }

  if (data.cleanup?.worktree_removed === false) {
    if (!validatedPaths.worktree) {
      throw new Error("manifest paths.worktree is required when cleanup.worktree_removed is false");
    }
    const currentBranch = execGit(validatedPaths.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (currentBranch !== branch) {
      throw new Error(`manifest worktree is on branch ${currentBranch}, expected ${branch}`);
    }
    return {
      branch,
      newHeadSha: execGit(validatedPaths.worktree, ["rev-parse", "HEAD"]),
      headSource: "worktree",
    };
  }

  return {
    branch,
    newHeadSha: execGit(validatedPaths.repoRoot, ["rev-parse", `refs/heads/${branch}`]),
    headSource: "repo_ref",
  };
}

function previewRebrand(runDir, { newHeadSha, reason }) {
  const evidencePath = path.join(runDir, EXECUTION_EVIDENCE_FILENAME);
  if (!fs.existsSync(evidencePath)) {
    return { skipped: "no_existing_evidence" };
  }
  if (!/^[0-9a-f]{40}$/.test(newHeadSha || "")) {
    return { skipped: "rejected_bad_sha", reason: "newHeadSha must be a 40-character lowercase hex SHA" };
  }

  const existing = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  if (existing.head_sha === newHeadSha) {
    return { skipped: "sha_unchanged" };
  }
  return {
    rewritten: true,
    previousSha: existing.head_sha,
    newHeadSha,
    plannedMutation: {
      file: evidencePath,
      previousHeadSha: existing.head_sha,
      newHeadSha,
      recordedBy: RECORDED_BY,
      reason,
    },
  };
}

function buildResult({ status, manifestPath, data, branch, headSource, newHeadSha, dryRun, rebrandResult }) {
  return {
    status,
    manifestPath,
    runId: data.run_id,
    branch,
    headSource,
    newHeadSha,
    dryRun,
    ...rebrandResult,
  };
}

function printResult(result, jsonOut) {
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.status === "dry_run") {
    if (result.skipped) {
      console.log(`Dry-run skipped rebrand: ${result.skipped}`);
      return;
    }
    console.log(`Dry-run would rebrand execution evidence for ${result.runId}`);
    console.log(`  Previous HEAD: ${result.plannedMutation.previousHeadSha}`);
    console.log(`  New HEAD:      ${result.plannedMutation.newHeadSha}`);
    console.log(`  Recorded by:   ${result.plannedMutation.recordedBy}`);
    return;
  }

  if (result.skipped) {
    console.log(`Skipped rebrand: ${result.skipped}`);
    return;
  }
  console.log(`Rebranded execution evidence for ${result.runId}`);
  console.log(`  Previous HEAD: ${result.previousSha}`);
  console.log(`  New HEAD:      ${result.newHeadSha}`);
}

function main() {
  const unknownFlags = findUnknownFlags(args, "rebrand-evidence");
  if (unknownFlags.length > 0) {
    usageError(`Unknown flag(s): ${unknownFlags.join(", ")}`);
  }

  const repoArg = getCliArg("--repo");
  const runId = getCliArg("--run-id");
  const manifestArg = getCliArg("--manifest");
  const reason = getCliArg("--reason");
  const dryRun = hasCliFlag("--dry-run");
  const jsonOut = hasCliFlag("--json");

  if (!runId && !manifestArg) {
    usageError("Either --run-id or --manifest is required");
  }
  if (runId && manifestArg) {
    usageError("Use either --run-id or --manifest, not both");
  }
  if (!reason) {
    usageError("--reason <text> is required");
  }

  const manifestRecord = resolveRun({ repoArg, runId, manifestArg });
  const expectedRepoRoot = expectedRepoRootForValidation(repoArg, manifestArg);
  const validatedPaths = validateManifestPaths(manifestRecord.data?.paths, {
    expectedRepoRoot,
    manifestPath: manifestRecord.manifestPath,
    runId: manifestRecord.data?.run_id,
    caller: "rebrand-evidence",
  });
  const data = {
    ...manifestRecord.data,
    paths: {
      ...(manifestRecord.data?.paths || {}),
      repo_root: validatedPaths.repoRoot,
      worktree: validatedPaths.worktree,
    },
  };
  const { branch, newHeadSha, headSource } = readCurrentHeadSha(data, validatedPaths);
  const runDir = getRunDir(validatedPaths.repoRoot, data.run_id);

  if (dryRun) {
    const rebrandResult = previewRebrand(runDir, { newHeadSha, reason });
    printResult(buildResult({
      status: "dry_run",
      manifestPath: manifestRecord.manifestPath,
      data,
      branch,
      headSource,
      newHeadSha,
      dryRun: true,
      rebrandResult,
    }), jsonOut);
    return;
  }

  const rebrandResult = rebrandEvidence(runDir, {
    newHeadSha,
    recordedBy: RECORDED_BY,
    reason,
  });
  if (rebrandResult.rewritten === true) {
    appendRunEvent(validatedPaths.repoRoot, data.run_id, {
      event: EVENTS.EXECUTION_EVIDENCE_REBRANDED,
      previous_head_sha: rebrandResult.previousSha,
      new_head_sha: newHeadSha,
      reason,
      execution_evidence_path: rebrandResult.evidencePath,
      execution_evidence_hash: rebrandResult.evidenceHash,
    });
  }

  printResult(buildResult({
    status: rebrandResult.skipped ? "skipped" : "rebranded",
    manifestPath: manifestRecord.manifestPath,
    data,
    branch,
    headSource,
    newHeadSha,
    dryRun: false,
    rebrandResult,
  }), jsonOut);
}

try {
  main();
} catch (error) {
  console.error(error instanceof UsageError ? error.message : `Error: ${error.message}`);
  process.exit(1);
}
