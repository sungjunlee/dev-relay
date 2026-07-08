#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { bindCliArgs, findUnknownFlags, modeLabel } = require("./cli-args");
const { execGh, execGit } = require("./exec");
const { STATES } = require("./manifest/lifecycle");
const { getCanonicalRepoRoot, getRunDir, validateManifestPaths } = require("./manifest/paths");
const { classifyRepositoryDirt } = require("./runtime-dirt");
const { resolveManifestRecord } = require("./relay-resolver");
const {
  getDispatchResultCandidates,
  getRunArtifactPaths,
  getRunLeaseStatus,
} = require("./run-runtime-state");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--run-id", "--manifest", "--json", "--help", "-h"];
const CLI_ARG_OPTIONS = { commandName: "run-observer", reservedFlags: KNOWN_FLAGS };
const cliArgs = bindCliArgs(args, CLI_ARG_OPTIONS);

function hasCliFlag(flag) {
  return cliArgs.hasFlag(flag);
}

function usage() {
  return [
    "Usage: run-observer.js --repo <path> (--run-id <id> | --manifest <path>) [--json]",
    "",
    "Build a read-only status row for one relay run from existing local artifacts.",
    "",
    "Options:",
    `  --repo <path>      ${modeLabel("--repo")} Repository root (default: .)`,
    `  --run-id <id>      ${modeLabel("--run-id")} Relay run identifier`,
    `  --manifest <path>  ${modeLabel("--manifest")} Relay manifest path`,
    `  --json             ${modeLabel("--json")} Output JSON`,
    `  --help, -h         ${modeLabel("--help")} Show help`,
  ].join("\n");
}

function statFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function readTail(filePath, maxBytes = 4000) {
  const stat = statFile(filePath);
  if (!stat || stat.size <= 0) return "";
  const length = Math.min(maxBytes, stat.size);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.toString("utf-8").trimEnd();
  } finally {
    fs.closeSync(fd);
  }
}

function isoFromMs(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function maxMtimeIso(paths) {
  let max = null;
  for (const filePath of paths.filter(Boolean)) {
    const stat = statFile(filePath);
    if (!stat || stat.size <= 0) continue;
    max = max === null ? stat.mtimeMs : Math.max(max, stat.mtimeMs);
  }
  return isoFromMs(max);
}

function secondsSince(iso) {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

function safeGit(repoPath, argv) {
  try {
    return execGit(repoPath, argv);
  } catch {
    return null;
  }
}

function countRange(repoPath, range) {
  const raw = safeGit(repoPath, ["rev-list", "--count", range]);
  const count = Number(raw);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

function countNewCommits(worktreePath, data) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return 0;
  const startHead = data.git?.head_sha || null;
  if (startHead && safeGit(worktreePath, ["rev-parse", "--verify", startHead])) {
    return countRange(worktreePath, `${startHead}..HEAD`);
  }
  const baseBranch = data.git?.base_branch || "main";
  for (const ref of [`refs/remotes/origin/${baseBranch}`, baseBranch]) {
    if (safeGit(worktreePath, ["rev-parse", "--verify", ref])) {
      return countRange(worktreePath, `${ref}..HEAD`);
    }
  }
  return 0;
}

function inspectWorktree(worktreePath, data) {
  const exists = !!worktreePath && fs.existsSync(worktreePath);
  if (!exists) {
    return {
      path: worktreePath || null,
      exists: false,
      reviewable_dirt: false,
      new_commits: 0,
      current_head: data.git?.head_sha || null,
    };
  }
  const statusText = safeGit(worktreePath, ["status", "--porcelain"]) || "";
  const currentHead = safeGit(worktreePath, ["rev-parse", "HEAD"]) || data.git?.head_sha || null;
  return {
    path: worktreePath,
    exists: true,
    reviewable_dirt: classifyRepositoryDirt(statusText).hasReviewableDirt,
    new_commits: countNewCommits(worktreePath, data),
    current_head: currentHead,
  };
}

function hasNonEmptyFile(filePath) {
  const stat = statFile(filePath);
  return !!stat && stat.size > 0;
}

function firstNonEmptyResult(repoRoot, runId, data) {
  return getDispatchResultCandidates(repoRoot, runId, data).find(hasNonEmptyFile) || null;
}

function inspectPr(repoRoot, data) {
  const storedNumber = data.git?.pr_number ?? null;
  const branch = data.git?.working_branch || null;
  if (storedNumber) {
    try {
      const raw = execGh(repoRoot, [
        "pr", "view", String(storedNumber),
        "--json", "number,state,url,headRefName,mergedAt",
      ], { timeout: 5000 });
      const parsed = JSON.parse(raw);
      return {
        number: parsed.number ?? storedNumber,
        state: parsed.state || "unknown",
        url: parsed.url || null,
        head_ref: parsed.headRefName || branch,
        source: "manifest",
        lookup_status: "ok",
      };
    } catch (error) {
      return {
        number: storedNumber,
        state: "unknown",
        url: null,
        head_ref: branch,
        source: "manifest",
        lookup_status: "github_unavailable",
        error: String(error.message || error),
      };
    }
  }
  if (!branch) {
    return { number: null, state: null, url: null, head_ref: null, source: "none", lookup_status: "skipped" };
  }
  try {
    const raw = execGh(repoRoot, [
      "pr", "list",
      "--head", branch,
      "--state", "all",
      "--json", "number,state,url,headRefName,mergedAt",
    ], { timeout: 5000 });
    const candidates = JSON.parse(raw);
    const pr = Array.isArray(candidates) && candidates.length ? candidates[0] : null;
    if (!pr) {
      return { number: null, state: null, url: null, head_ref: branch, source: "branch", lookup_status: "not_found" };
    }
    return {
      number: pr.number ?? null,
      state: pr.state || "unknown",
      url: pr.url || null,
      head_ref: pr.headRefName || branch,
      source: "branch",
      lookup_status: "ok",
    };
  } catch (error) {
    return {
      number: null,
      state: "unknown",
      url: null,
      head_ref: branch,
      source: "branch",
      lookup_status: "github_unavailable",
      error: String(error.message || error),
    };
  }
}

function buildLogs(paths) {
  const lastOutputAt = maxMtimeIso([paths.stdoutLog, paths.stderrLog]);
  return {
    stdout_path: paths.stdoutLog,
    stderr_path: paths.stderrLog,
    result_path: paths.resultFile,
    last_output_at: lastOutputAt,
    silent_for_s: secondsSince(lastOutputAt),
    stdout_tail: readTail(paths.stdoutLog),
    stderr_tail: readTail(paths.stderrLog),
  };
}

function classify({ data, lease, logs, worktree, pr, resultFile }) {
  if (data.state === STATES.READY_TO_MERGE) return "ready_to_merge";
  if (data.state === STATES.MERGED) return "merged_not_finalized";
  if (!worktree.exists && data.state !== STATES.MERGED && data.state !== STATES.CLOSED) return "missing_worktree";
  if (lease.live && Number(lease.remaining_s) <= 0) return "timed_out_live";
  if (lease.live) return logs.last_output_at ? "running_with_output" : "running_silent";
  if (pr.number && !data.git?.pr_number) return "pr_without_manifest_stamp";
  if (!pr.number && data.state === STATES.REVIEW_PENDING) return "branch_without_pr";
  if (
    data.state === STATES.DISPATCHED
    && (resultFile || worktree.new_commits > 0 || worktree.reviewable_dirt)
  ) {
    return "dead_with_work";
  }
  if (data.state === STATES.DISPATCHED) return "dead_no_work";
  return "unknown_needs_manual_inspection";
}

function commandFor(repoRoot, runId, kind, manifestPath = null) {
  const repoArg = JSON.stringify(repoRoot);
  const runArg = JSON.stringify(runId);
  const manifestArg = JSON.stringify(manifestPath || runId);
  if (kind === "recover") {
    return `node skills/relay/scripts/relay-recover.js --repo ${repoArg} --run-id ${runArg} --dry-run --json`;
  }
  if (kind === "reconcile") {
    return `node skills/relay-dispatch/scripts/reconcile-run.js --repo ${repoArg} --run-id ${runArg} --dry-run --json`;
  }
  if (kind === "resume") {
    return `node skills/relay-dispatch/scripts/dispatch.js --manifest ${manifestArg}`;
  }
  if (kind === "merge") {
    return `node skills/relay-merge/scripts/finalize-run.js --run-id ${runArg} --json`;
  }
  return `node skills/relay/scripts/relay-status.js --repo ${repoArg} --run-id ${runArg} --json`;
}

function nextActionFor(classification, repoRoot, runId, manifestPath) {
  const table = {
    running_with_output: ["wait_or_reconcile", "reconcile"],
    running_silent: ["wait_or_reconcile", "reconcile"],
    timed_out_live: ["reconcile_timeout", "reconcile"],
    dead_with_work: ["recover", "recover"],
    dead_no_work: ["resume_dispatch", "resume"],
    missing_worktree: ["manual_inspection", "status"],
    branch_without_pr: ["publish_or_reconcile", "reconcile"],
    pr_without_manifest_stamp: ["reconcile_or_review", "reconcile"],
    ready_to_merge: ["merge_when_approved", "merge"],
    merged_not_finalized: ["finalize_cleanup", "merge"],
    unknown_needs_manual_inspection: ["manual_inspection", "status"],
  };
  const [kind, commandKind] = table[classification] || table.unknown_needs_manual_inspection;
  return { kind, command: commandFor(repoRoot, runId, commandKind, manifestPath) };
}

function observeRun({ repo = ".", runId, manifestPath } = {}) {
  const repoRoot = getCanonicalRepoRoot(path.resolve(repo));
  const record = resolveManifestRecord({ repoRoot, runId, manifestPath, includeTerminal: true });
  const data = record.data;
  const normalizedRunId = data.run_id;
  const validated = validateManifestPaths(data.paths, {
    expectedRepoRoot: repoRoot,
    manifestPath: record.manifestPath,
    runId: normalizedRunId,
    allowMissingWorktree: true,
    caller: "run-observer",
  });
  const normalizedRepoRoot = validated.repoRoot;
  const paths = getRunArtifactPaths(normalizedRepoRoot, normalizedRunId);
  const lease = getRunLeaseStatus(normalizedRepoRoot, normalizedRunId);
  const logs = buildLogs(paths);
  const worktree = inspectWorktree(validated.worktree, data);
  const pr = inspectPr(normalizedRepoRoot, data);
  const resultFile = firstNonEmptyResult(normalizedRepoRoot, normalizedRunId, data);
  const classification = classify({ data, lease, logs, worktree, pr, resultFile });
  return {
    run_id: normalizedRunId,
    state: data.state,
    manifest_path: record.manifestPath,
    run_dir: getRunDir(normalizedRepoRoot, normalizedRunId),
    lease: {
      status: lease.status || lease.reason,
      live: lease.live,
      can_signal: lease.canSignal,
      elapsed_s: lease.elapsed_s,
      remaining_s: lease.remaining_s,
      path: lease.leasePath,
      error: lease.error || null,
    },
    logs,
    worktree,
    pr,
    result_file: resultFile,
    classification,
    next_action: nextActionFor(classification, normalizedRepoRoot, normalizedRunId, record.manifestPath),
  };
}

function formatText(row) {
  return [
    `Run: ${row.run_id}`,
    `State: ${row.state}`,
    `Lease: ${row.lease.status || "unknown"}, elapsed ${row.lease.elapsed_s ?? "?"}s, remaining ${row.lease.remaining_s ?? "?"}s`,
    `Output: ${row.logs.last_output_at ? `silent for ${row.logs.silent_for_s}s` : "no output observed"}`,
    `Worktree: ${row.worktree.exists ? "exists" : "missing"}, reviewable=${row.worktree.reviewable_dirt}, commits=${row.worktree.new_commits}`,
    `PR: ${row.pr.number ? `#${row.pr.number} ${row.pr.state}` : row.pr.lookup_status}`,
    `Classification: ${row.classification}`,
    `Next: ${row.next_action.kind}`,
    `Command: ${row.next_action.command}`,
  ].join("\n");
}

function main() {
  if (!args.length || hasCliFlag(["--help", "-h"])) {
    console.log(usage());
    process.exit(hasCliFlag(["--help", "-h"]) ? 0 : 1);
  }
  const unknownFlags = findUnknownFlags(args, KNOWN_FLAGS);
  if (unknownFlags.length) {
    throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  }
  const repo = cliArgs.getArg("--repo", ".");
  const runId = cliArgs.getArg("--run-id");
  const manifestPath = cliArgs.getArg("--manifest");
  if (!runId && !manifestPath) throw new Error("--run-id or --manifest is required");
  if (runId && manifestPath) throw new Error("--run-id and --manifest are mutually exclusive");
  const row = observeRun({ repo, runId, manifestPath });
  console.log(hasCliFlag("--json") ? JSON.stringify(row, null, 2) : formatText(row));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`run-observer: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  classify,
  observeRun,
};
