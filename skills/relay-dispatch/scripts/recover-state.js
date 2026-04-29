#!/usr/bin/env node
// Operator recovery CLI (#211): advance a relay run's state after an external event
// (fix commit pushed manually, stalled dispatch to recover from, etc.) without the
// free-text `manual_state_override` hack.
//
// Trust model (answers to `references/rubric-trust-model.md` at authoring time):
//   Q1 (forge): an attacker with manifest write access could forge `last_reviewed_sha`
//     to pretend a commit exists. Mitigation: the fresh-commit precondition reads
//     git HEAD on the working branch via execFileSync and compares it to the stored
//     `last_reviewed_sha`. Attacker cannot forge git HEAD without branch write access
//     too, which already implies code access.
//   Q2 (gate): this file; specifically the whitelist check in `main()` and the
//     fresh-commit precondition in `requireFreshCommitOnBranch()`.
//   Q3 (external verifier): `git rev-parse` against the working branch's HEAD SHA.
//     The claim (`review.last_reviewed_sha`) does not self-attest; the gate reads an
//     independent artifact (git's object db for the branch).

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { STATES, forceTransitionState } = require("./manifest/lifecycle");
const {
  getRunDir,
  validateManifestPaths,
} = require("./manifest/paths");
const { writeManifest } = require("./manifest/store");
const { readTextFileWithoutFollowingSymlinks } = require("./manifest/rubric");
const { modeLabel, readArg, schemaHasFlag } = require("./cli-args");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent, EVENTS } = require("./relay-events");
const CLI_ARG_OPTIONS = { commandName: "recover-state", reservedFlags: ["-h"] };
const PR_BODY_FETCH_TIMEOUT_MS = 15000;

// Whitelist: recovery transitions that the normal dispatch/review/merge flow does NOT support.
// If `ALLOWED_TRANSITIONS` in relay-manifest.js changes, this table must be reviewed — recovery
// is an opt-in extension, not an override.
const RECOVERY_TRANSITIONS = Object.freeze([
  {
    from: STATES.CHANGES_REQUESTED,
    to: STATES.REVIEW_PENDING,
    nextAction: "run_review",
    requireForce: false,
    requireFreshCommit: true,
    resetLastReviewedSha: false,
    description: "Operator pushed a fix commit directly to the branch instead of re-dispatching.",
  },
  {
    from: STATES.ESCALATED,
    to: STATES.REVIEW_PENDING,
    nextAction: "run_review",
    requireForce: true,
    requireFreshCommit: false,
    resetLastReviewedSha: false,
    description: "Recover an escalated run (typically: re-dispatch was a no-op because the fix already landed).",
  },
  {
    from: STATES.ESCALATED,
    to: STATES.CHANGES_REQUESTED,
    nextAction: "await_redispatch",
    requireForce: false,
    requireFreshCommit: false,
    resetLastReviewedSha: false,
    description: "Go back one step; dispatch --run-id can then resume normally.",
  },
  {
    from: STATES.DISPATCHED,
    to: STATES.CHANGES_REQUESTED,
    nextAction: "await_redispatch",
    requireForce: true,
    requireFreshCommit: false,
    resetLastReviewedSha: false,
    description: "Dispatch hung or operator killed; unstick the manifest so re-dispatch is reachable.",
  },
]);

function printUsage(stream = console.log) {
  stream(
    "Usage: recover-state.js (--repo <path> --run-id <id> | --manifest <path>) --to <state> --reason <text> [--force] [--dry-run] [--json]\n" +
    "\n" +
    "Options:\n" +
    `  --repo <path>     ${modeLabel("--repo")} Repository root\n` +
    `  --run-id <id>     ${modeLabel("--run-id")} Relay run identifier\n` +
    `  --manifest <path> ${modeLabel("--manifest")} Explicit manifest path\n` +
    `  --to <state>      ${modeLabel("--to")} Recovery target state\n` +
    `  --reason <text>   ${modeLabel("--reason")} Audit reason\n` +
    `  --force           ${modeLabel("--force")} Confirm selected recovery transitions\n` +
    `  --allow-same-head ${modeLabel("--allow-same-head")} Allow same-HEAD review recovery when PR-body evidence changed\n` +
    `  --require-pr-body-change ${modeLabel("--require-pr-body-change")} Require current PR body to differ from the latest review snapshot\n` +
    `  --dry-run         ${modeLabel("--dry-run")} Print result without writing\n` +
    `  --json            ${modeLabel("--json")} Output JSON\n` +
    "\n" +
    "Whitelisted recovery transitions:\n" +
    RECOVERY_TRANSITIONS.map((t) => {
      const forceFlag = t.requireForce ? " (--force required)" : "";
      const freshFlag = t.requireFreshCommit
        ? " (fresh commit required on branch; same-HEAD PR-body-only recovery requires both same-HEAD flags)"
        : "";
      return `  ${t.from} -> ${t.to}${forceFlag}${freshFlag}`;
    }).join("\n")
  );
}

function findRecovery(fromState, toState) {
  return RECOVERY_TRANSITIONS.find((t) => t.from === fromState && t.to === toState) || null;
}

function formatAllowedSet() {
  return RECOVERY_TRANSITIONS.map((t) => `${t.from} -> ${t.to}`).join(", ");
}

function readHeadSha(repoRoot, branch) {
  const args = branch
    ? ["-C", repoRoot, "rev-parse", `refs/heads/${branch}`]
    : ["-C", repoRoot, "rev-parse", "HEAD"];
  return execFileSync("git", args, { encoding: "utf-8", stdio: "pipe" }).trim();
}

function getBranchHeadContext({ repoRoot, manifestData }) {
  const branch = manifestData?.git?.working_branch;
  if (!branch) {
    throw new Error(
      "Cannot verify fresh commit: manifest has no git.working_branch. " +
      "Recovery transitions to review_pending from changes_requested require a branch to compare HEAD against."
    );
  }

  let currentHead;
  try {
    currentHead = readHeadSha(repoRoot, branch);
  } catch (error) {
    throw new Error(
      `Cannot read git HEAD for branch '${branch}' in ${repoRoot}: ${error.message}. ` +
      "Ensure the branch exists locally (fetch if needed) before running recover-state."
    );
  }

  const lastReviewedSha = manifestData?.review?.last_reviewed_sha || null;
  return { currentHead, lastReviewedSha };
}

function requireFreshCommitOnBranch({ repoRoot, manifestData }) {
  const { currentHead, lastReviewedSha } = getBranchHeadContext({ repoRoot, manifestData });
  const branch = manifestData?.git?.working_branch;
  if (lastReviewedSha && currentHead === lastReviewedSha) {
    throw new Error(
      `Refusing recovery: git HEAD for '${branch}' (${currentHead}) equals review.last_reviewed_sha. ` +
      "No new commits have landed since the last review round. Push the fix commit first, " +
      "or use --to changes_requested if you intend to re-dispatch."
    );
  }

  return { currentHead, lastReviewedSha };
}

function normalizePrBody(text) {
  return `${String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n?$/, "\n")}`;
}

function collapseWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function summarizeCommandFailure(error) {
  const status = error?.status ?? error?.signal ?? "unknown";
  const stderr = collapseWhitespace(error?.stderr || "");
  const stdout = collapseWhitespace(error?.stdout || "");
  const message = collapseWhitespace(error?.message || String(error));
  const detail = stderr || stdout || message || "unknown error";
  const truncated = detail.length > 500 ? `${detail.slice(0, 497)}...` : detail;
  return `status ${status}: ${truncated}`;
}

function getManifestPrNumber(manifestData) {
  const raw = manifestData?.git?.pr_number ?? manifestData?.github?.pr_number ?? null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function findLatestPrBodySnapshot(runDir) {
  let entries;
  try {
    entries = fs.readdirSync(runDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  const snapshots = entries
    .map((entry) => {
      const match = entry.name.match(/^review-round-(\d+)-pr-body\.md$/);
      if (!match) return null;
      return {
        name: entry.name,
        path: path.join(runDir, entry.name),
        round: Number(match[1]),
      };
    })
    .filter(Boolean)
    .sort((left, right) => (right.round - left.round) || left.name.localeCompare(right.name));

  return snapshots[0] || null;
}

function fetchCurrentPrBody(repoRoot, prNumber) {
  try {
    const body = execFileSync(
      "gh",
      ["pr", "view", String(prNumber), "--json", "body", "-q", ".body"],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: PR_BODY_FETCH_TIMEOUT_MS,
      }
    );
    return normalizePrBody(body);
  } catch (error) {
    throw new Error(
      `Cannot fetch current PR body for PR #${prNumber}: ${summarizeCommandFailure(error)}`
    );
  }
}

function requirePrBodyOnlyEvidence({ repoRoot, manifestData, currentHead, lastReviewedSha }) {
  const prNumber = getManifestPrNumber(manifestData);
  if (!prNumber) {
    throw new Error(
      "Refusing same-HEAD PR-body-only recovery: manifest has no PR number " +
      "(expected git.pr_number or github.pr_number)."
    );
  }

  const runDir = getRunDir(repoRoot, manifestData.run_id);
  const latestSnapshot = findLatestPrBodySnapshot(runDir);
  if (!latestSnapshot) {
    throw new Error(
      `Refusing same-HEAD PR-body-only recovery: no prior PR body snapshot found in ${runDir}. ` +
      "Expected review-round-N-pr-body.md from an earlier review round."
    );
  }

  const previousBody = readTextFileWithoutFollowingSymlinks(latestSnapshot.path);
  const currentBody = fetchCurrentPrBody(repoRoot, prNumber);
  if (currentBody === normalizePrBody(previousBody)) {
    throw new Error(
      "Refusing same-HEAD PR-body-only recovery: current PR body matches latest prior " +
      `PR body snapshot ${latestSnapshot.name}. Edit the PR body before retrying.`
    );
  }

  return {
    currentHead,
    lastReviewedSha,
    prBodyOnly: true,
    prNumber,
    previousSnapshotPath: latestSnapshot.path,
    previousSnapshotRound: latestSnapshot.round,
  };
}

function main() {
  const args = process.argv.slice(2);
  const hasCliFlag = (flag) => schemaHasFlag(args, flag, CLI_ARG_OPTIONS);
  if (!args.length || hasCliFlag("--help") || hasCliFlag("-h")) {
    printUsage(console.log);
    process.exit(hasCliFlag("--help") || hasCliFlag("-h") ? 0 : 1);
  }

  const repoRoot = path.resolve(readArg(args, "--repo", undefined, CLI_ARG_OPTIONS) || ".");
  const runId = readArg(args, "--run-id", undefined, CLI_ARG_OPTIONS);
  const manifestArg = readArg(args, "--manifest", undefined, CLI_ARG_OPTIONS);
  const toState = readArg(args, "--to", undefined, CLI_ARG_OPTIONS);
  const reason = readArg(args, "--reason", undefined, CLI_ARG_OPTIONS);
  const force = hasCliFlag("--force");
  const allowSameHead = hasCliFlag("--allow-same-head");
  const requirePrBodyChange = hasCliFlag("--require-pr-body-change");
  const dryRun = hasCliFlag("--dry-run");
  const jsonOut = hasCliFlag("--json");

  if (!runId && !manifestArg) {
    throw new Error("Provide --run-id or --manifest");
  }
  if (!toState) {
    throw new Error("--to <state> is required");
  }
  if (!reason) {
    throw new Error("--reason <text> is required (audit trail)");
  }
  if (allowSameHead !== requirePrBodyChange) {
    throw new Error(
      "--allow-same-head and --require-pr-body-change must be passed together. " +
      "Same-HEAD recovery is only supported for audited PR-body-only evidence changes."
    );
  }

  const { manifestPath, data, body } = resolveManifestRecord({
    repoRoot,
    runId,
    manifestPath: manifestArg,
  });
  const validatedPaths = validateManifestPaths(data.paths, {
    expectedRepoRoot: repoRoot,
    manifestPath,
    runId: data.run_id,
    caller: "recover-state",
  });
  const safeData = {
    ...data,
    paths: {
      ...(data.paths || {}),
      repo_root: validatedPaths.repoRoot,
      worktree: validatedPaths.worktree,
    },
  };

  const fromState = safeData.state;
  const recovery = findRecovery(fromState, toState);
  if (!recovery) {
    throw new Error(
      `Recovery transition '${fromState} -> ${toState}' is not whitelisted. ` +
      `Allowed: ${formatAllowedSet()}. ` +
      "Transitions supported by the normal flow are intentionally excluded from this CLI."
    );
  }
  if (recovery.requireForce && !force) {
    throw new Error(
      `Recovery transition '${fromState} -> ${toState}' requires --force. ` +
      `Rationale: ${recovery.description} Re-run with --force to confirm.`
    );
  }

  let commitContext = null;
  let prBodyOnlyContext = null;
  if (recovery.requireFreshCommit) {
    const headContext = getBranchHeadContext({
      repoRoot: validatedPaths.repoRoot,
      manifestData: safeData,
    });
    const sameReviewedHead = headContext.lastReviewedSha
      && headContext.currentHead === headContext.lastReviewedSha;
    if (sameReviewedHead && allowSameHead && requirePrBodyChange) {
      prBodyOnlyContext = requirePrBodyOnlyEvidence({
        repoRoot: validatedPaths.repoRoot,
        manifestData: safeData,
        ...headContext,
      });
    } else {
      commitContext = requireFreshCommitOnBranch({
        repoRoot: validatedPaths.repoRoot,
        manifestData: safeData,
      });
    }
  }

  const updated = forceTransitionState(safeData, toState, recovery.nextAction);

  if (recovery.resetLastReviewedSha) {
    updated.review = { ...(updated.review || {}), last_reviewed_sha: null };
  }

  if (!dryRun) {
    writeManifest(manifestPath, updated, body);
    appendRunEvent(repoRoot, updated.run_id, {
      event: EVENTS.STATE_RECOVERY,
      state_from: fromState,
      state_to: toState,
      head_sha: commitContext?.currentHead || prBodyOnlyContext?.currentHead || updated.git?.head_sha || null,
      round: prBodyOnlyContext?.previousSnapshotRound || updated.review?.rounds || null,
      reason,
      last_reviewed_sha: commitContext?.lastReviewedSha
        ?? prBodyOnlyContext?.lastReviewedSha
        ?? (safeData.review?.last_reviewed_sha || null),
      ...(prBodyOnlyContext
        ? {
            pr_body_only: true,
            pr_number: prBodyOnlyContext.prNumber,
          }
        : {}),
    });
  }

  const result = {
    manifestPath,
    runId: updated.run_id,
    previousState: fromState,
    state: updated.state,
    nextAction: updated.next_action,
    reason,
    force,
    freshCommit: commitContext,
    prBodyOnly: prBodyOnlyContext,
    dryRun,
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Recovered relay run: ${manifestPath}`);
    console.log(`  State:        ${fromState} -> ${updated.state}`);
    console.log(`  Next action:  ${updated.next_action}`);
    console.log(`  Reason:       ${reason}`);
    if (commitContext) {
      console.log(`  HEAD sha:     ${commitContext.currentHead}`);
      console.log(`  Prev reviewed: ${commitContext.lastReviewedSha || "(none)"}`);
    }
    if (prBodyOnlyContext) {
      console.log("  PR body only: true");
      console.log(`  HEAD sha:     ${prBodyOnlyContext.currentHead}`);
      console.log(`  Prev reviewed: ${prBodyOnlyContext.lastReviewedSha || "(none)"}`);
      console.log(`  PR number:    ${prBodyOnlyContext.prNumber}`);
      console.log(`  Snapshot:     ${prBodyOnlyContext.previousSnapshotPath}`);
    }
    if (dryRun) console.log("  dry-run:      no changes written");
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { RECOVERY_TRANSITIONS };
