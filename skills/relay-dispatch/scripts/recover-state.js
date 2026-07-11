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
//
// Same-head checks-green route (#950): re-enters review at the exact reviewed head
// after post-publication CI turns green. The manifest `review.pending_checks_marker`
// only proves the prior round's block was procedural (it proceeded on pending checks);
// it does NOT self-attest that checks flipped green. The gate therefore verifies TWO
// independent artifacts — git HEAD (still equals the marker's anchored head) and a live
// `gh pr checks` re-poll (every check in a non-pending, non-failed bucket) — before it
// force-transitions changes_requested -> review_pending.

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { STATES, forceTransitionState, updateManifestState } = require("./manifest/lifecycle");
const {
  getEventsPath,
  getRunDir,
  getWorktreeGitCommonDir,
  sameFilesystemLocation,
  validateManifestPaths,
} = require("./manifest/paths");
const { getActorName, writeManifest } = require("./manifest/store");
const { readTextFileWithoutFollowingSymlinks } = require("./manifest/rubric");
const { findUnknownFlags, modeLabel, readArg, schemaHasFlag } = require("./cli-args");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendEventLineToPath, appendRunEvent, EVENTS } = require("./relay-events");
const { classifyChecks, fetchChecks } = require("./wait-for-check");
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
    from: STATES.READY_TO_MERGE,
    to: STATES.REVIEW_PENDING,
    nextAction: "run_review",
    requireForce: false,
    requireFreshCommit: false,
    requireReadyHeadDrift: true,
    resetLastReviewedSha: false,
    description: "PR HEAD advanced after a passing review; recover to review_pending for a fresh review.",
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
  {
    from: STATES.MERGE_BLOCKED,
    to: STATES.READY_TO_MERGE,
    nextAction: "await_explicit_merge",
    requireForce: false,
    requireFreshCommit: false,
    resetLastReviewedSha: false,
    description: "Operator cleared the merge blocker; the next fleet drive re-run retries the merge queue.",
  },
  {
    from: STATES.MERGE_BLOCKED,
    to: STATES.REVIEW_PENDING,
    nextAction: "run_review",
    requireForce: false,
    requireFreshCommit: false,
    resetLastReviewedSha: false,
    description: "Rebased merge_blocked child needs re-review before the fleet drive retries the merge.",
  },
]);

function appendStateRecoveryEvent(repoRoot, runId, eventData) {
  if (eventData.worktree_missing !== true) {
    return appendRunEvent(repoRoot, runId, eventData);
  }
  const record = {
    ts: eventData.ts || new Date().toISOString(),
    event: eventData.event,
    actor: getActorName(repoRoot),
    run_id: runId,
    ...Object.fromEntries(
      Object.entries(eventData)
        .filter(([key, value]) => key !== "event" && value !== undefined)
    ),
  };
  return appendEventLineToPath(getEventsPath(repoRoot, runId), record);
}

function sameRecordedRepoCommonDir(recordedRepoRoot, resolvedRepoRoot) {
  if (!recordedRepoRoot || !resolvedRepoRoot) return false;
  const recordedCommonDir = getWorktreeGitCommonDir(recordedRepoRoot);
  const resolvedCommonDir = getWorktreeGitCommonDir(resolvedRepoRoot);
  if (!recordedCommonDir || !resolvedCommonDir) return false;
  return recordedCommonDir === resolvedCommonDir
    || sameFilesystemLocation(recordedCommonDir, resolvedCommonDir);
}

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
    `  --allow-same-head ${modeLabel("--allow-same-head")} Allow same-HEAD review recovery with exactly one same-HEAD evidence flag\n` +
    `  --require-pr-body-change ${modeLabel("--require-pr-body-change")} Require current PR body to differ from the latest review snapshot\n` +
    `  --require-checks-green ${modeLabel("--require-checks-green")} Require the pending-checks marker at HEAD and all-green live gh pr checks\n` +
    `  --dry-run         ${modeLabel("--dry-run")} Print result without writing\n` +
    `  --json            ${modeLabel("--json")} Output JSON\n` +
    "\n" +
    "Whitelisted recovery transitions:\n" +
    RECOVERY_TRANSITIONS.map((t) => {
      const forceFlag = t.requireForce ? " (--force required)" : "";
      const freshFlag = t.requireFreshCommit
        ? " (fresh commit required on branch; same-HEAD recovery requires --allow-same-head plus exactly one of --require-pr-body-change or --require-checks-green)"
        : "";
      const driftFlag = t.requireReadyHeadDrift
        ? " (live PR HEAD drift required)"
        : "";
      return `  ${t.from} -> ${t.to}${forceFlag}${freshFlag}${driftFlag}`;
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

function fetchLivePrHead(repoRoot, prNumber) {
  try {
    const ghBin = process.env.RELAY_GH_BIN || "gh";
    const raw = execFileSync(
      ghBin,
      ["pr", "view", String(prNumber), "--json", "number,headRefName,headRefOid"],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: PR_BODY_FETCH_TIMEOUT_MS,
      }
    );
    const parsed = JSON.parse(raw || "{}");
    return {
      prNumber: Number(parsed.number || prNumber),
      headRefName: parsed.headRefName || null,
      headSha: parsed.headRefOid || null,
    };
  } catch (error) {
    throw new Error(
      `Cannot fetch live PR HEAD for PR #${prNumber}: ${summarizeCommandFailure(error)}`
    );
  }
}

function requireReadyHeadDriftEvidence({ repoRoot, manifestData }) {
  const prNumber = getManifestPrNumber(manifestData);
  if (!prNumber) {
    throw new Error(
      "Refusing stale-ready recovery: manifest has no PR number " +
      "(expected git.pr_number or github.pr_number)."
    );
  }

  const live = fetchLivePrHead(repoRoot, prNumber);
  if (!live.headSha) {
    throw new Error(`Refusing stale-ready recovery: PR #${prNumber} live HEAD is missing.`);
  }

  const lastReviewedSha = manifestData?.review?.last_reviewed_sha || null;
  const manifestHeadSha = manifestData?.git?.head_sha || null;
  if (!lastReviewedSha && !manifestHeadSha) {
    throw new Error(
      "Refusing stale-ready recovery: manifest has neither review.last_reviewed_sha nor git.head_sha " +
      "to compare against the live PR HEAD."
    );
  }

  const differsFromReviewed = Boolean(lastReviewedSha && live.headSha !== lastReviewedSha);
  const differsFromManifestHead = Boolean(manifestHeadSha && live.headSha !== manifestHeadSha);
  if (!differsFromReviewed && !differsFromManifestHead) {
    const equalTargets = [];
    if (lastReviewedSha) equalTargets.push("review.last_reviewed_sha");
    if (manifestHeadSha) equalTargets.push("git.head_sha");
    throw new Error(
      `Refusing stale-ready recovery: live PR HEAD for PR #${prNumber} (${live.headSha}) ` +
      `equals ${equalTargets.join(" and ")}. Objective drift evidence requires the live PR HEAD ` +
      "to differ from review.last_reviewed_sha or git.head_sha."
    );
  }

  return {
    prNumber: live.prNumber || prNumber,
    headRefName: live.headRefName,
    oldSha: differsFromReviewed ? lastReviewedSha : manifestHeadSha,
    newSha: live.headSha,
    lastReviewedSha,
    manifestHeadSha,
    differsFromReviewed,
    differsFromManifestHead,
  };
}

function requireRetainedWorktreeAtLiveHead({ repoRoot, manifestData, readyHeadDrift }) {
  const worktreePath = manifestData?.paths?.worktree;
  const branch = manifestData?.git?.working_branch || readyHeadDrift?.headRefName || null;
  if (!worktreePath) {
    throw new Error(
      "Refusing stale-ready recovery: manifest has no paths.worktree. " +
      "Cannot verify the retained review checkout before returning to review_pending."
    );
  }
  if (!branch) {
    throw new Error(
      "Refusing stale-ready recovery: manifest has no git.working_branch and the PR head branch is unknown. " +
      "Cannot verify the retained review checkout before returning to review_pending."
    );
  }

  let worktreeHead;
  try {
    worktreeHead = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch (error) {
    throw new Error(
      `Refusing stale-ready recovery: cannot read retained worktree HEAD at ${worktreePath}: ` +
      `${summarizeCommandFailure(error)}`
    );
  }

  if (worktreeHead !== readyHeadDrift.newSha) {
    throw new Error(
      `Refusing stale-ready recovery: retained worktree HEAD for '${branch}' is ${worktreeHead}, ` +
      `but live PR HEAD is ${readyHeadDrift.newSha}. ` +
      `Update the retained worktree first, for example: git -C ${worktreePath} fetch origin ${branch} && ` +
      `git -C ${worktreePath} reset --hard ${readyHeadDrift.newSha}`
    );
  }

  return { worktreePath, branch, worktreeHead };
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

// Same-head checks-green re-entry (#950). Accepts changes_requested -> review_pending
// at the exact reviewed head only when (a) git HEAD still equals review.last_reviewed_sha,
// (b) review.pending_checks_marker is present and anchored to that same head (proving the
// prior round's block was procedural), and (c) a live gh pr checks re-poll shows no check
// in the fail or pending bucket. The marker alone never suffices — the live re-poll is the
// independent artifact that proves checks actually flipped green.
function requireChecksGreenEvidence({ repoRoot, manifestData, currentHead, lastReviewedSha }) {
  const branch = manifestData?.git?.working_branch;
  if (!lastReviewedSha || currentHead !== lastReviewedSha) {
    throw new Error(
      `Refusing same-HEAD checks-green recovery: git HEAD for '${branch}' (${currentHead}) ` +
      `does not equal review.last_reviewed_sha (${lastReviewedSha || "none"}). ` +
      "The checks-green route only re-enters review at the exact reviewed head; " +
      "use the fresh-commit route when a new commit has landed."
    );
  }

  const marker = manifestData?.review?.pending_checks_marker || null;
  if (!marker || marker.head_sha !== currentHead) {
    throw new Error(
      "Refusing same-HEAD checks-green recovery: no pending-checks marker anchored to the reviewed head " +
      `(${currentHead}). The prior round did not proceed on pending checks — ` +
      "use the fresh-commit or --require-pr-body-change route instead."
    );
  }

  const prNumber = getManifestPrNumber(manifestData);
  if (!prNumber) {
    throw new Error(
      "Refusing same-HEAD checks-green recovery: manifest has no PR number " +
      "(expected git.pr_number or github.pr_number)."
    );
  }

  let checks;
  try {
    checks = fetchChecks(repoRoot, prNumber);
  } catch (error) {
    throw new Error(
      `Refusing same-HEAD checks-green recovery: cannot fetch live gh pr checks for PR #${prNumber}: ` +
      `${summarizeCommandFailure(error)}`
    );
  }

  const { failedChecks, pendingChecks } = classifyChecks(checks);
  if (failedChecks.length || pendingChecks.length) {
    const failedNames = failedChecks.map((check) => check.name).join(", ") || "none";
    const pendingNames = pendingChecks.map((check) => check.name).join(", ") || "none";
    throw new Error(
      `Refusing same-HEAD checks-green recovery: live gh pr checks for PR #${prNumber} are not all green ` +
      `(failed: ${failedNames}; pending: ${pendingNames}). Wait for CI to finish and pass before re-entering review.`
    );
  }
  if (checks.length === 0) {
    throw new Error(
      `Refusing same-HEAD checks-green recovery: PR #${prNumber} reports no live checks, but the ` +
      "pending-checks marker implies checks were pending at review time. Re-verify the PR's CI state."
    );
  }

  return {
    checksGreen: true,
    currentHead,
    lastReviewedSha,
    prNumber,
    markerRound: Number.isInteger(marker.round) ? marker.round : null,
    checkNames: checks.map((check) => check.name),
  };
}

function main() {
  const args = process.argv.slice(2);
  const hasCliFlag = (flag) => schemaHasFlag(args, flag, CLI_ARG_OPTIONS);
  if (!args.length || hasCliFlag("--help") || hasCliFlag("-h")) {
    printUsage(console.log);
    process.exit(hasCliFlag("--help") || hasCliFlag("-h") ? 0 : 1);
  }

  const unknownFlags = findUnknownFlags(args, "recover-state");
  if (unknownFlags.length) {
    throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  }

  const repoRoot = path.resolve(readArg(args, "--repo", undefined, CLI_ARG_OPTIONS) || ".");
  const runId = readArg(args, "--run-id", undefined, CLI_ARG_OPTIONS);
  const manifestArg = readArg(args, "--manifest", undefined, CLI_ARG_OPTIONS);
  const toState = readArg(args, "--to", undefined, CLI_ARG_OPTIONS);
  const reason = readArg(args, "--reason", undefined, CLI_ARG_OPTIONS);
  const force = hasCliFlag("--force");
  const allowSameHead = hasCliFlag("--allow-same-head");
  const requirePrBodyChange = hasCliFlag("--require-pr-body-change");
  const requireChecksGreen = hasCliFlag("--require-checks-green");
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
  const sameHeadEvidenceFlagCount = [requirePrBodyChange, requireChecksGreen].filter(Boolean).length;
  if (allowSameHead && sameHeadEvidenceFlagCount !== 1) {
    throw new Error(
      "--allow-same-head requires exactly one same-HEAD evidence flag: " +
      "--require-pr-body-change (audited PR-body change) or --require-checks-green (marker + all-green live checks). " +
      "The two evidence flags are mutually exclusive."
    );
  }
  if (!allowSameHead && sameHeadEvidenceFlagCount > 0) {
    throw new Error(
      "--require-pr-body-change and --require-checks-green require --allow-same-head. " +
      "Same-HEAD recovery is only supported for audited same-HEAD evidence changes."
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
    allowMissingWorktree: true,
    caller: "recover-state",
  });
  const preserveRecordedPaths = sameRecordedRepoCommonDir(data.paths?.repo_root, validatedPaths.repoRoot);
  const safeData = {
    ...data,
    paths: {
      ...(data.paths || {}),
      repo_root: preserveRecordedPaths ? data.paths.repo_root : validatedPaths.repoRoot,
      worktree: preserveRecordedPaths ? data.paths?.worktree : validatedPaths.worktree,
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
  let checksGreenContext = null;
  let readyHeadDriftContext = null;
  if (recovery.requireFreshCommit) {
    const headContext = getBranchHeadContext({
      repoRoot: validatedPaths.repoRoot,
      manifestData: safeData,
    });
    const sameReviewedHead = headContext.lastReviewedSha
      && headContext.currentHead === headContext.lastReviewedSha;
    if (allowSameHead && requireChecksGreen) {
      // The operator explicitly opted into same-HEAD checks-green re-entry; this
      // route verifies same head, marker, and live checks itself (never falls back
      // to the fresh-commit route — a moved head is a refusal, not a silent switch).
      checksGreenContext = requireChecksGreenEvidence({
        repoRoot: validatedPaths.repoRoot,
        manifestData: safeData,
        ...headContext,
      });
    } else if (sameReviewedHead && allowSameHead && requirePrBodyChange) {
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
  if (recovery.requireReadyHeadDrift) {
    readyHeadDriftContext = requireReadyHeadDriftEvidence({
      repoRoot: validatedPaths.repoRoot,
      manifestData: safeData,
    });
    requireRetainedWorktreeAtLiveHead({
      repoRoot: validatedPaths.repoRoot,
      manifestData: safeData,
      readyHeadDrift: readyHeadDriftContext,
    });
  }

  let updated = fromState === STATES.MERGE_BLOCKED
    && (toState === STATES.READY_TO_MERGE || toState === STATES.REVIEW_PENDING)
    ? updateManifestState(safeData, toState, recovery.nextAction)
    : forceTransitionState(safeData, toState, recovery.nextAction);

  if (recovery.resetLastReviewedSha) {
    updated.review = { ...(updated.review || {}), last_reviewed_sha: null };
  }
  if (checksGreenContext) {
    // Consume the pending-checks marker so the same-head route is single-use: a later
    // changes_requested at this head (e.g. a real finding) cannot replay the re-entry.
    updated = { ...updated, review: { ...(updated.review || {}) } };
    delete updated.review.pending_checks_marker;
  }
  if (readyHeadDriftContext) {
    updated = {
      ...updated,
      git: {
        ...(updated.git || {}),
        pr_number: readyHeadDriftContext.prNumber,
        head_sha: readyHeadDriftContext.newSha,
      },
    };
  }

  if (!dryRun) {
    writeManifest(manifestPath, updated, body);
    appendStateRecoveryEvent(repoRoot, updated.run_id, {
      event: EVENTS.STATE_RECOVERY,
      state_from: fromState,
      state_to: toState,
      head_sha: readyHeadDriftContext?.newSha
        || commitContext?.currentHead
        || prBodyOnlyContext?.currentHead
        || checksGreenContext?.currentHead
        || updated.git?.head_sha
        || null,
      round: prBodyOnlyContext?.previousSnapshotRound || checksGreenContext?.markerRound || updated.review?.rounds || null,
      reason,
      last_reviewed_sha: commitContext?.lastReviewedSha
        ?? prBodyOnlyContext?.lastReviewedSha
        ?? checksGreenContext?.lastReviewedSha
        ?? readyHeadDriftContext?.lastReviewedSha
        ?? (safeData.review?.last_reviewed_sha || null),
      ...(validatedPaths.worktreeMissing ? { worktree_missing: true } : {}),
      ...(readyHeadDriftContext
        ? {
            pr_number: readyHeadDriftContext.prNumber,
            previous_head_sha: readyHeadDriftContext.oldSha,
            new_head_sha: readyHeadDriftContext.newSha,
          }
        : {}),
      ...(prBodyOnlyContext
        ? {
            pr_body_only: true,
            pr_number: prBodyOnlyContext.prNumber,
          }
        : {}),
      ...(checksGreenContext
        ? {
            pr_number: checksGreenContext.prNumber,
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
    checksGreen: checksGreenContext,
    readyHeadDrift: readyHeadDriftContext,
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
    if (checksGreenContext) {
      console.log("  Checks green: true");
      console.log(`  HEAD sha:     ${checksGreenContext.currentHead}`);
      console.log(`  Prev reviewed: ${checksGreenContext.lastReviewedSha || "(none)"}`);
      console.log(`  PR number:    ${checksGreenContext.prNumber}`);
      console.log(`  Checks:       ${checksGreenContext.checkNames.join(", ") || "(none)"}`);
    }
    if (readyHeadDriftContext) {
      console.log("  Ready drift:  true");
      console.log(`  PR number:    ${readyHeadDriftContext.prNumber}`);
      console.log(`  Prev HEAD:    ${readyHeadDriftContext.oldSha}`);
      console.log(`  New HEAD:     ${readyHeadDriftContext.newSha}`);
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
