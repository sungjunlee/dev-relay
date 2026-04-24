#!/usr/bin/env node
"use strict";

/**
 * relay-recover-commit: commit/push/open-PR for executor-complete-but-uncommitted runs.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { parsePrNumber, formatExecError } = require("./dispatch-publish");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent } = require("./relay-events");
const { STATES } = require("./manifest/lifecycle");
const { getCanonicalRepoRoot, validateManifestPaths } = require("./manifest/paths");
const { summarizeError } = require("./manifest/store");
const { stampPrNumberUnderLock } = require("./manifest/pr-number-stamp");
const {
  findUnknownFlags,
  getArg,
  hasFlag,
  modeLabel,
} = require("./cli-args");

const args = process.argv.slice(2);
const CLI_ARG_OPTIONS = { commandName: "recover-commit", reservedFlags: ["-h"] };
const hasCliFlag = (flag) => hasFlag(args, flag, CLI_ARG_OPTIONS);
const getCliArg = (flag, fallback) => getArg(args, flag, fallback, CLI_ARG_OPTIONS);

function printHelp(exitCode) {
  console.log("Usage: recover-commit.js (--repo <path> --run-id <id> | --manifest <path>) --reason <text> [options]");
  console.log("\nCommit, push, and open or reuse a PR for a review_pending relay run whose executor left recoverable work behind.");
  console.log("\nOptions:");
  console.log(`  --repo <path>       ${modeLabel("--repo")} Repository root used with --run-id (default: .)`);
  console.log(`  --run-id <id>       ${modeLabel("--run-id")} Relay run identifier`);
  console.log(`  --manifest <path>   ${modeLabel("--manifest")} Explicit manifest path`);
  console.log(`  --reason <text>     ${modeLabel("--reason")} Required audit reason; preserved verbatim`);
  console.log(`  --pr-title <text>   ${modeLabel("--pr-title")} PR title override`);
  console.log(`  --pr-body-file <path> ${modeLabel("--pr-body-file")} PR body override file`);
  console.log(`  --dry-run           ${modeLabel("--dry-run")} Print planned git/gh commands and manifest mutation only`);
  console.log(`  --json              ${modeLabel("--json")} Output JSON`);
  console.log("\nDecision tree:");
  console.log("  - Use recover-commit when the executor completed, the run is review_pending, and the retained worktree has uncommitted changes or unpushed commits.");
  console.log("  - Use dispatch.js --run-id <id> when review requested changes and you need a same-run executor resume.");
  console.log("  - Use finalize-run.js --force-finalize-nonready --reason <text> only when an operator intentionally merges a non-ready run.");
  process.exit(exitCode);
}

if (!args.length || hasCliFlag(["--help", "-h"])) {
  printHelp(hasCliFlag(["--help", "-h"]) ? 0 : 1);
}

function nowIso() {
  return new Date().toISOString();
}

function git(gitBin, repoPath, ...gitArgs) {
  return execFileSync(gitBin, ["-C", repoPath, ...gitArgs], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function gh(ghBin, repoPath, ...ghArgs) {
  return execFileSync(ghBin, ghArgs, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
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

function resolveRun({ repoArg, runId, manifestArg }) {
  const repoRoot = path.resolve(repoArg || ".");
  try {
    return resolveManifestRecord({
      repoRoot,
      manifestPath: manifestArg,
      runId,
    });
  } catch (error) {
    throw new Error(`run_resolution_failed: ${summarizeError(error)}`);
  }
}

function expectedRepoRootForValidation(repoArg, manifestArg) {
  if (manifestArg && !repoArg) return undefined;
  return getCanonicalRepoRoot(path.resolve(repoArg || "."));
}

function countRange(gitBin, worktreePath, range) {
  const raw = git(gitBin, worktreePath, "rev-list", "--count", range);
  const count = Number(raw);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

function countUnpushedCommits(gitBin, worktreePath, branch, baseBranch) {
  try {
    const upstream = git(gitBin, worktreePath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
    if (upstream) return countRange(gitBin, worktreePath, `${upstream}..HEAD`);
  } catch {}

  for (const ref of [
    `refs/remotes/origin/${branch}`,
    ...(baseBranch ? [`refs/remotes/origin/${baseBranch}`, baseBranch] : []),
  ]) {
    try {
      git(gitBin, worktreePath, "rev-parse", "--verify", ref);
      return countRange(gitBin, worktreePath, `${ref}..HEAD`);
    } catch {}
  }
  return 0;
}

function findExistingPr(ghBin, worktreePath, branch) {
  const raw = gh(ghBin, worktreePath, "pr", "list", "--head", branch, "--json", "number", "--jq", ".[0].number");
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
    appendRecoveryEvent(repoRoot, data, "recover_commit_failed", `${status}: ${detail}`, commitSha, null, branch);
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
  const reason = getCliArg("--reason");
  const prTitleArg = getCliArg("--pr-title");
  const prBodyFile = getCliArg("--pr-body-file");
  const dryRun = hasCliFlag("--dry-run");
  const jsonOut = hasCliFlag("--json");
  const gitBin = process.env.RELAY_GIT_BIN || "git";
  const ghBin = process.env.RELAY_GH_BIN || "gh";
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
  const data = {
    ...manifestRecord.data,
    paths: {
      ...(manifestRecord.data?.paths || {}),
      repo_root: validatedPaths.repoRoot,
      worktree: validatedPaths.worktree,
    },
  };
  const branch = data.git?.working_branch;
  const worktreePath = validatedPaths.worktree;

  if (data.state === STATES.MERGED || data.state === STATES.CLOSED) {
    throw new Error(`force-finalize cannot be used from terminal state ${data.state}`);
  }
  if (data.state !== STATES.REVIEW_PENDING) {
    throw new Error(`recover-commit requires state=${STATES.REVIEW_PENDING}, got ${data.state}`);
  }
  if (!branch) {
    throw new Error("manifest is missing git.working_branch");
  }

  const currentBranch = git(gitBin, worktreePath, "rev-parse", "--abbrev-ref", "HEAD");
  if (currentBranch !== branch) {
    throw new Error(`manifest worktree is on branch ${currentBranch}, expected ${branch}`);
  }

  const statusText = git(gitBin, worktreePath, "status", "--porcelain");
  const hasUncommittedChanges = statusText.trim() !== "";
  const unpushedCommits = countUnpushedCommits(gitBin, worktreePath, branch, data.git?.base_branch);
  const prBody = readPrBodyFile(prBodyFile) || buildPrBody({
    runId: data.run_id,
    reason,
    branch,
    timestamp,
    manifestPath: manifestRecord.manifestPath,
    data,
  });
  const prTitle = prTitleArg || defaultPrTitle(branch, data.run_id);
  const commitTitle = `Recover relay run ${data.run_id}`;
  const commitBody = buildCommitBody({ runId: data.run_id, reason, timestamp });
  const plannedCommands = [
    commandRecord(worktreePath, [ghBin, "pr", "list", "--head", branch, "--json", "number", "--jq", ".[0].number"]),
  ];
  if (hasUncommittedChanges) {
    plannedCommands.push(commandRecord(worktreePath, [gitBin, "-C", worktreePath, "add", "-A"]));
    plannedCommands.push(commandRecord(worktreePath, [gitBin, "-C", worktreePath, "commit", "-m", commitTitle, "-m", commitBody]));
  }
  plannedCommands.push(commandRecord(worktreePath, [gitBin, "-C", worktreePath, "push", "-u", "origin", branch]));
  plannedCommands.push(commandRecord(worktreePath, [ghBin, "pr", "create", "--title", prTitle, "--body", prBody]));

  let existingPrNumber = null;
  if (!dryRun) {
    try {
      existingPrNumber = findExistingPr(ghBin, worktreePath, branch);
    } catch (error) {
      throw new Error(`pr_list_failed: ${formatExecError(error)}`);
    }
  }
  if (!hasUncommittedChanges && unpushedCommits === 0 && existingPrNumber === null) {
    throw new Error("nothing_to_recover: worktree has no uncommitted changes, no unpushed commits, and no existing PR");
  }

  if (dryRun) {
    const result = {
      status: "dry_run",
      runId: data.run_id,
      branch,
      worktree: worktreePath,
      hasUncommittedChanges,
      unpushedCommits,
      commands: plannedCommands,
      manifestMutation: {
        state: data.state,
        git_pr_number: "stamp after PR number is known, if missing",
      },
    };
    console.log(jsonOut ? JSON.stringify(result, null, 2) : plannedCommands.map((cmd) => cmd.shell).join("\n"));
    return;
  }

  let commitSha = git(gitBin, worktreePath, "rev-parse", "HEAD");
  let commitCreated = false;
  if (hasUncommittedChanges) {
    try {
      git(gitBin, worktreePath, "add", "-A");
      git(gitBin, worktreePath, "commit", "-m", commitTitle, "-m", commitBody);
      commitSha = git(gitBin, worktreePath, "rev-parse", "HEAD");
      commitCreated = true;
    } catch (error) {
      const detail = formatExecError(error);
      appendFailureEvent(validatedPaths.repoRoot, data, "commit_failed", detail, commitSha, branch);
      throw new Error(`commit_failed: ${detail}`);
    }
  }

  let prNumber = existingPrNumber;
  let prCreated = false;
  const shouldPush = prNumber === null || hasUncommittedChanges || unpushedCommits > 0;
  if (shouldPush) {
    try {
      git(gitBin, worktreePath, "push", "-u", "origin", branch);
    } catch (error) {
      const detail = formatExecError(error);
      appendFailureEvent(validatedPaths.repoRoot, data, "push_failed", detail, commitSha, branch);
      throw new Error(`push_failed: ${detail}`);
    }
  }

  if (prNumber === null) {
    try {
      prNumber = findExistingPr(ghBin, worktreePath, branch);
    } catch (error) {
      const detail = formatExecError(error);
      appendFailureEvent(validatedPaths.repoRoot, data, "pr_create_failed", detail, commitSha, branch);
      throw new Error(`pr_create_failed: ${detail}`);
    }
    if (prNumber === null) {
      try {
        const raw = gh(ghBin, worktreePath, "pr", "create", "--title", prTitle, "--body", prBody);
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

  let stampedRecord = manifestRecord;
  if (data.git?.pr_number === undefined || data.git?.pr_number === null) {
    stampedRecord = stampPrNumberUnderLock(manifestRecord, prNumber, {
      expectedRepoRoot: validatedPaths.repoRoot,
      caller: "recover-commit PR stamping",
      reason: `Stamped git.pr_number=${prNumber} during recover-commit`,
    });
  }

  appendRecoveryEvent(validatedPaths.repoRoot, stampedRecord.data || data, "recover_commit", reason, commitSha, prNumber, branch);

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
