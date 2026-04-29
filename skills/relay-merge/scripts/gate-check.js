#!/usr/bin/env node
/**
 * Verify relay-review audit trail before merge.
 *
 * Checks that a PR has a <!-- relay-review --> comment with a verdict.
 * Hard gate by default; --skip <reason> provides a documented escape hatch.
 *
 * Usage:
 *   ./gate-check.js <PR-number> [options]
 *
 * Options:
 *   --skip <reason>   Skip review gate with documented reason (writes PR comment)
 *   --dry-run         Parse from stdin instead of calling gh CLI
 *   --json            Output result as JSON
 *   --help, -h        Show usage
 *
 * Exit codes:
 *   0  LGTM or skip (with audit trail)
 *   1  No review comment, stale review, CHANGES_REQUESTED, ESCALATED, or error
 *
 * Examples:
 *   ./gate-check.js 42                        # Check PR #42 for review
 *   ./gate-check.js 42 --skip "hotfix"        # Skip with documented reason
 *   echo '<json>' | ./gate-check.js 42 --dry-run  # Test with mock data
 */

const fs = require("fs");
const path = require("path");
const {
  buildSkipReviewGateFailure,
  buildSkipComment,
  evaluateReviewGate,
  summarizeRubricAuditForSkip,
} = require("./review-gate");
const { loadRubricFromRunDir } = require("../../relay-review/scripts/review-runner/context");
const { buildReviewRunnerRubricGateFailure } = require("../../relay-review/scripts/review-runner/redispatch");
const {
  getCanonicalRepoRoot,
  getRunDir,
  validateManifestPaths,
} = require("../../relay-dispatch/scripts/manifest/paths");
const { appendRunEvent } = require("../../relay-dispatch/scripts/relay-events");
const { resolveManifestRecord } = require("../../relay-dispatch/scripts/relay-resolver");
const { stampPrNumberUnderLock } = require("../../relay-dispatch/scripts/manifest/pr-number-stamp");
const {
  getArg,
  getPositionals,
  hasFlag,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const { execGh } = require("../../relay-dispatch/scripts/exec");

function getGateCheckRepoRoot() {
  return getCanonicalRepoRoot(process.cwd());
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const CLI_ARG_OPTIONS = { commandName: "gate-check", reservedFlags: ["-h"] };
const hasCliFlag = (flag) => hasFlag(args, flag, CLI_ARG_OPTIONS);

if (!args.length || hasCliFlag("--help") || hasCliFlag("-h")) {
  console.log("Usage: gate-check.js <PR-number> [--skip <reason>] [--dry-run] [--json]");
  console.log("\nVerify relay-review audit trail before merge.");
  console.log("\nOptions:");
  console.log(`  --skip <reason>   ${modeLabel("--skip")} Skip review with documented reason (writes PR comment)`);
  console.log(`  --dry-run         ${modeLabel("--dry-run")} Read comment JSON from stdin instead of gh CLI`);
  console.log(`  --json            ${modeLabel("--json")} Output as JSON`);
  process.exit(hasCliFlag("--help") || hasCliFlag("-h") ? 0 : 1);
}

const PR_NUM = getPositionals(args, "gate-check")[0];
if (!PR_NUM || !/^\d+$/.test(PR_NUM)) {
  console.error("Error: PR number is required (positive integer)");
  process.exit(1);
}

const DRY_RUN = hasCliFlag("--dry-run");
const JSON_OUT = hasCliFlag("--json");

const SKIP = hasCliFlag("--skip");
const SKIP_REASON = getArg(args, "--skip", null, CLI_ARG_OPTIONS);

if (SKIP && !SKIP_REASON) {
  console.error("Error: --skip requires a reason. Example: --skip \"hotfix for production outage\"");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryResolveManifestForPr(prNumber, headRefName) {
  try {
    // gate-check runs before merge finalization, so it must never resolve merged/closed manifests.
    const manifestRecord = resolveManifestRecord({
      repoRoot: getGateCheckRepoRoot(),
      prNumber,
      branch: headRefName || undefined,
    });
    const numericPrNumber = Number(prNumber);
    if (
      Number.isInteger(numericPrNumber)
      && numericPrNumber >= 0
      && (manifestRecord.data?.git?.pr_number === undefined || manifestRecord.data?.git?.pr_number === null)
    ) {
      return stampPrNumberUnderLock(manifestRecord, numericPrNumber, {
        expectedRepoRoot: getGateCheckRepoRoot(),
        caller: "gate-check PR stamping",
        reason: `Stamped git.pr_number=${numericPrNumber} during gate-check PR resolution`,
      });
    }
    return manifestRecord;
  } catch (error) {
    return { error };
  }
}

function resolveSkipAuditContext(prNumber) {
  try {
    const raw = execGh(null, ["pr", "view", String(prNumber), "--json", "headRefName"]);
    const parsed = JSON.parse(raw);
    const manifestRecord = tryResolveManifestForPr(prNumber, parsed.headRefName || null);
    if (manifestRecord.error || !manifestRecord.data) {
      return {
        rubricStatus: "unresolved-manifest",
        manifestData: null,
        runDir: null,
      };
    }

    let manifestData = manifestRecord.data;
    const validatedPaths = validateManifestPaths(manifestData.paths, {
      expectedRepoRoot: getGateCheckRepoRoot(),
      manifestPath: manifestRecord.manifestPath,
      runId: manifestData.run_id,
      caller: "gate-check skip audit",
    });
    manifestData = {
      ...manifestData,
      paths: {
        ...(manifestData.paths || {}),
        repo_root: validatedPaths.repoRoot,
        worktree: validatedPaths.worktree,
      },
    };

    const runDir = getRunDir(validatedPaths.repoRoot, manifestData.run_id);
    const rubricAudit = summarizeRubricAuditForSkip(manifestData, { runDir });
    return {
      ...rubricAudit,
      manifestData,
      runDir,
    };
  } catch {
    return {
      rubricStatus: "unresolved-manifest",
      readyToMerge: true,
      manifestData: null,
      runDir: null,
    };
  }
}

function deriveReviewRunnerRubricGate(manifestData, runDir) {
  if (!manifestData || !runDir) {
    return null;
  }

  const rubricLoad = loadRubricFromRunDir(runDir, manifestData);
  const gateFailure = buildReviewRunnerRubricGateFailure(
    manifestData.run_id,
    path.join(runDir, ".gate-check-rubric-recovery.md"),
    rubricLoad
  );
  if (!gateFailure) {
    return null;
  }

  return {
    status: gateFailure.status,
    layer: gateFailure.layer,
    rubricState: gateFailure.rubricState,
    rubricStatus: gateFailure.rubricStatus,
  };
}

const STATUS_RENDERERS = {
  lgtm(result, prNumber) {
    console.log(`✓ PR #${prNumber}: relay-review LGTM (round ${result.round || "?"}) — ready to merge`);
  },
  skipped(result, prNumber) {
    console.log(`⊘ PR #${prNumber}: review skipped — ${result.reason} — merge explicitly if appropriate`);
  },
  escalated(result, prNumber) {
    console.log(`✗ PR #${prNumber}: relay-review ESCALATED — resolve issues before merge`);
    if (result.issues) console.log(`  ${result.issues}`);
  },
  changes_requested(result, prNumber) {
    console.log(`✗ PR #${prNumber}: relay-review requested changes — re-dispatch or fix the branch before merge`);
    if (result.issues) console.log(`  ${result.issues}`);
  },
  missing_rubric_path(result, prNumber) {
    console.log(`✗ PR #${prNumber}: run is missing anchor.rubric_path — merge blocked`);
    console.log("  Re-dispatch from relay-plan with --rubric-file before rerunning relay-review.");
  },
  missing_rubric_file(result, prNumber) {
    console.log(`✗ PR #${prNumber}: anchored rubric file is missing from the run directory — merge blocked`);
    if (result.reason) console.log(`  ${result.reason}`);
    console.log("  Restore the anchored rubric file, or re-dispatch with a persisted rubric before rerunning relay-review.");
  },
  empty_rubric_file(result, prNumber) {
    console.log(`✗ PR #${prNumber}: anchored rubric file is empty — merge blocked`);
    if (result.reason) console.log(`  ${result.reason}`);
    console.log("  Regenerate the rubric with relay-plan and re-dispatch before rerunning relay-review.");
  },
  invalid_rubric_path(result, prNumber) {
    console.log(`✗ PR #${prNumber}: anchor.rubric_path escapes the run directory — merge blocked`);
    if (result.reason) console.log(`  ${result.reason}`);
    console.log("  Fix anchor.rubric_path to stay inside the run directory, then re-dispatch before rerunning relay-review.");
  },
  invalid_rubric_file(result, prNumber) {
    console.log(`✗ PR #${prNumber}: anchor.rubric_path does not point to a readable rubric file — merge blocked`);
    if (result.reason) console.log(`  ${result.reason}`);
    console.log("  Fix or restore the anchored rubric file, then re-dispatch before rerunning relay-review.");
  },
  unsupported_grandfather_field(result, prNumber) {
    console.log(`✗ PR #${prNumber}: manifest still carries anchor.rubric_grandfathered — merge blocked`);
    if (result.reason) console.log(`  ${result.reason}`);
    console.log("  Remove anchor.rubric_grandfathered and persist a valid anchor.rubric_path before rerunning relay-review.");
  },
  manifest_resolution_failed(result, prNumber) {
    console.log(`✗ PR #${prNumber}: unable to resolve relay manifest — merge blocked`);
    if (result.reason) console.log(`  ${result.reason}`);
  },
  reviewer_login_required(result, prNumber) {
    console.log(`✗ PR #${prNumber}: reviewer_login was required for this run but could not be recorded — merge blocked`);
    console.log("  Origin resolved to a non-default GitHub host but gh api user --hostname <host> failed during relay-review.");
    console.log("  Fix the host auth (export GH_HOST=<host> or gh auth switch --hostname <host>), rerun relay-review, then retry.");
  },
  unauthorized_reviewer(result, prNumber) {
    console.log(`✗ PR #${prNumber}: relay-review comment found but from unauthorized author (expected: ${result.expectedReviewerLogin})`);
  },
  stale(result, prNumber) {
    console.log(`✗ PR #${prNumber}: relay-review is stale — run review again for the latest commit before merge`);
    if (result.latestCommit) console.log(`  Latest commit: ${result.latestCommit}`);
    if (result.reviewedAt) console.log(`  Review time:   ${result.reviewedAt}`);
  },
};

function defaultStatusRenderer(result, prNumber) {
  console.log(`✗ PR #${prNumber}: no relay-review comment found`);
  console.log("  Run /relay-review first, or use --skip <reason> to bypass with audit trail.");
}

function output(result) {
  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    (STATUS_RENDERERS[result.status] || defaultStatusRenderer)(result, PR_NUM);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // --- Skip path: write audit comment and exit ---
  if (SKIP) {
    const skipAudit = DRY_RUN
      ? {
          rubricStatus: "unresolved-manifest",
          readyToMerge: true,
          manifestData: null,
          runDir: null,
        }
      : resolveSkipAuditContext(PR_NUM);
    const skipGateFailure = buildSkipReviewGateFailure(PR_NUM, skipAudit);
    if (skipGateFailure) {
      output(skipGateFailure);
      process.exit(1);
    }
    const skipComment = buildSkipComment(SKIP_REASON, skipAudit);

    if (DRY_RUN) {
      output({
        status: "skipped",
        pr: PR_NUM,
        reason: SKIP_REASON,
        comment: skipComment,
        rubricStatus: skipAudit.rubricStatus,
        readyToMerge: true,
      });
    } else {
      execGh(null, ["pr", "comment", PR_NUM, "--body", skipComment]);
      output({
        status: "skipped",
        pr: PR_NUM,
        reason: SKIP_REASON,
        rubricStatus: skipAudit.rubricStatus,
        readyToMerge: true,
      });
    }
    return;
  }

  // --- Check path: look for relay-review comment ---
  let comments;
  let commits;
  let manifestData = null;
  let runDir = null;
  if (DRY_RUN) {
    // Dry-run: read JSON object/array from stdin, or plain text as single comment
    const stdin = require("fs").readFileSync(0, "utf-8").trim();
    try {
      const parsed = JSON.parse(stdin);
      // Accept {comments:[...], commits:[...]} or [{body:...}] or [string]
      comments = parsed.comments || parsed;
      commits = Array.isArray(parsed.commits) ? parsed.commits : [];
      manifestData = parsed.manifest || null;
      runDir = typeof parsed.runDir === "string" ? parsed.runDir : null;
    } catch {
      // Plain text: treat entire stdin as one comment body
      comments = [{ body: stdin, createdAt: null }];
      commits = [];
    }
  } else {
    const raw = execGh(null, ["pr", "view", PR_NUM, "--json", "comments,commits,headRefName"]);
    const parsed = JSON.parse(raw);
    comments = parsed.comments || [];
    commits = parsed.commits || [];
    const manifestRecord = tryResolveManifestForPr(PR_NUM, parsed.headRefName || null);
    if (manifestRecord.error || !manifestRecord.data) {
      output({
        status: "manifest_resolution_failed",
        pr: PR_NUM,
        readyToMerge: false,
        reason: manifestRecord.error
          ? manifestRecord.error.message
          : `resolveManifestRecord returned no manifest data for PR #${PR_NUM}`,
      });
      process.exit(1);
    }
    manifestData = manifestRecord.data;
    try {
      const validatedPaths = validateManifestPaths(manifestData.paths, {
        expectedRepoRoot: getGateCheckRepoRoot(),
        manifestPath: manifestRecord.manifestPath,
        runId: manifestData.run_id,
        caller: "gate-check",
      });
      manifestData = {
        ...manifestData,
        paths: {
          ...(manifestData.paths || {}),
          repo_root: validatedPaths.repoRoot,
          worktree: validatedPaths.worktree,
        },
      };
      runDir = getRunDir(validatedPaths.repoRoot, manifestData.run_id);
    } catch (error) {
      output({
        status: "manifest_resolution_failed",
        pr: PR_NUM,
        readyToMerge: false,
        reason: error.message,
      });
      process.exit(1);
    }
  }

  const expectedReviewerLogin = manifestData?.review?.reviewer_login || null;
  // review.reviewer_login_required is set by review-runner.js when the origin
  // host was resolvable but gh could not return a host-scoped login. Without
  // this hard-stop, fail-closed in getGhLogin would silently degrade into a
  // skipped verification gate on non-default GitHub hosts (issue #199).
  //
  // Gate on the flag regardless of reviewer_login presence: review-runner
  // clears reviewer_login when setting the flag, but if a manifest arrives
  // with both fields populated (older code, manual edit), the flag is
  // authoritative — the operator explicitly signaled that any previously
  // recorded login is no longer trustworthy.
  if (manifestData?.review?.reviewer_login_required === true) {
    output({
      status: "reviewer_login_required",
      pr: PR_NUM,
      readyToMerge: false,
      reason: "manifest.review.reviewer_login_required is set — host-scoped gh api user failed during relay-review; fix host auth (GH_HOST / gh auth switch --hostname <host>) and rerun relay-review",
    });
    process.exit(1);
  }
  if (!DRY_RUN && !expectedReviewerLogin && manifestData) {
    console.error("Note: reviewer author verification skipped — manifest is missing review.reviewer_login. Use finalize-run.js for full verification.");
  }
  const result = evaluateReviewGate({
    prNumber: PR_NUM,
    comments,
    commits,
    manifestData,
    expectedReviewerLogin,
    runDir,
  });
  const reviewRunnerRubricGate = deriveReviewRunnerRubricGate(manifestData, runDir);
  const enrichedResult = reviewRunnerRubricGate
    ? { ...result, reviewRunnerRubricGate }
    : result;
  if (enrichedResult.note) {
    console.error(`Note: ${enrichedResult.note}`);
  }
  output(enrichedResult);
  if (!enrichedResult.readyToMerge) {
    process.exit(1);
  }
}

main();
