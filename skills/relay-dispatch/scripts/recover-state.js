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
const { execFileSync } = require("child_process");
const { STATES, forceTransitionState } = require("./manifest/lifecycle");
const {
  validateManifestPaths,
} = require("./manifest/paths");
const { writeManifest } = require("./manifest/store");
const { getArg, hasFlag, modeLabel } = require("./cli-args");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent } = require("./relay-events");
const CLI_ARG_OPTIONS = { commandName: "recover-state", reservedFlags: ["-h"] };

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
    `  --dry-run         ${modeLabel("--dry-run")} Print result without writing\n` +
    `  --json            ${modeLabel("--json")} Output JSON\n` +
    "\n" +
    "Whitelisted recovery transitions:\n" +
    RECOVERY_TRANSITIONS.map((t) => {
      const forceFlag = t.requireForce ? " (--force required)" : "";
      const freshFlag = t.requireFreshCommit ? " (fresh commit required on branch)" : "";
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

function requireFreshCommitOnBranch({ repoRoot, manifestData }) {
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
  if (lastReviewedSha && currentHead === lastReviewedSha) {
    throw new Error(
      `Refusing recovery: git HEAD for '${branch}' (${currentHead}) equals review.last_reviewed_sha. ` +
      "No new commits have landed since the last review round. Push the fix commit first, " +
      "or use --to changes_requested if you intend to re-dispatch."
    );
  }

  return { currentHead, lastReviewedSha };
}

function main() {
  const args = process.argv.slice(2);
  const hasCliFlag = (flag) => hasFlag(args, flag, CLI_ARG_OPTIONS);
  if (!args.length || hasCliFlag("--help") || hasCliFlag("-h")) {
    printUsage(console.log);
    process.exit(hasCliFlag("--help") || hasCliFlag("-h") ? 0 : 1);
  }

  const repoRoot = path.resolve(getArg(args, "--repo", undefined, CLI_ARG_OPTIONS) || ".");
  const runId = getArg(args, "--run-id", undefined, CLI_ARG_OPTIONS);
  const manifestArg = getArg(args, "--manifest", undefined, CLI_ARG_OPTIONS);
  const toState = getArg(args, "--to", undefined, CLI_ARG_OPTIONS);
  const reason = getArg(args, "--reason", undefined, CLI_ARG_OPTIONS);
  const force = hasCliFlag("--force");
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
  if (recovery.requireFreshCommit) {
    commitContext = requireFreshCommitOnBranch({
      repoRoot: validatedPaths.repoRoot,
      manifestData: safeData,
    });
  }

  const updated = forceTransitionState(safeData, toState, recovery.nextAction);

  if (recovery.resetLastReviewedSha) {
    updated.review = { ...(updated.review || {}), last_reviewed_sha: null };
  }

  if (!dryRun) {
    writeManifest(manifestPath, updated, body);
    appendRunEvent(repoRoot, updated.run_id, {
      event: "state_recovery",
      state_from: fromState,
      state_to: toState,
      head_sha: commitContext?.currentHead || updated.git?.head_sha || null,
      round: updated.review?.rounds || null,
      reason,
      last_reviewed_sha: commitContext?.lastReviewedSha ?? (safeData.review?.last_reviewed_sha || null),
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
