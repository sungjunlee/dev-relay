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
const { execFileSync } = require("child_process");
const { buildSkipComment, evaluateReviewGate } = require("./review-gate");
const { STATES, getRunDir, readManifest, writeManifest } = require("../../relay-dispatch/scripts/relay-manifest");
const { appendRunEvent, readRunEvents } = require("../../relay-dispatch/scripts/relay-events");
const { resolveManifestRecord } = require("../../relay-dispatch/scripts/relay-resolver");

const PR_NUMBER_STAMP_LOCK_NAME = ".pr_number_stamp.lock";
const PR_NUMBER_STAMP_LOCK_TIMEOUT_MS = 5000;
const PR_NUMBER_STAMP_LOCK_POLL_MS = 50;
const PR_NUMBER_STAMP_WAIT_STATE = new Int32Array(new SharedArrayBuffer(4));
// Rule 7 (#177 / #166): whitelist non-terminal states so tampered or missing
// state values fail-closed (skip stamping) at the inside-lock recheck. Scoped
// locally in gate-check.js to keep #166's fix inside the agreed file boundary
// and avoid widening relay-resolver.js's public API.
const NON_TERMINAL_STATES_FOR_PR_STAMP = new Set(
  Object.values(STATES).filter((state) => state !== STATES.MERGED && state !== STATES.CLOSED)
);

function isNonTerminalStateForPrStamp(state) {
  return NON_TERMINAL_STATES_FOR_PR_STAMP.has(state);
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: gate-check.js <PR-number> [--skip <reason>] [--dry-run] [--json]");
  console.log("\nVerify relay-review audit trail before merge.");
  console.log("\nOptions:");
  console.log("  --skip <reason>   Skip review with documented reason (writes PR comment)");
  console.log("  --dry-run         Read comment JSON from stdin instead of gh CLI");
  console.log("  --json            Output as JSON");
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

const KNOWN_FLAGS = ["--skip", "--dry-run", "--json", "--help", "-h"];

const PR_NUM = args.find((a) => !a.startsWith("-") && !KNOWN_FLAGS.includes(a));
if (!PR_NUM || !/^\d+$/.test(PR_NUM)) {
  console.error("Error: PR number is required (positive integer)");
  process.exit(1);
}

const DRY_RUN = args.includes("--dry-run");
const JSON_OUT = args.includes("--json");

// --skip <reason>: flag is at index i, reason is at index i+1
const skipIdx = args.indexOf("--skip");
const SKIP = skipIdx !== -1;
const SKIP_REASON = SKIP && skipIdx + 1 < args.length && !args[skipIdx + 1].startsWith("-")
  ? args[skipIdx + 1]
  : null;

if (SKIP && !SKIP_REASON) {
  console.error("Error: --skip requires a reason. Example: --skip \"hotfix for production outage\"");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gh(...ghArgs) {
  const ghBin = process.env.RELAY_GH_BIN || "gh";
  return execFileSync(ghBin, ghArgs, {
    encoding: "utf-8",
    stdio: "pipe",
  });
}

function readFreshManifestRecord(manifestRecord) {
  const fresh = readManifest(manifestRecord.manifestPath);
  return {
    ...manifestRecord,
    data: fresh.data,
    body: fresh.body,
  };
}

function waitForPrNumberStampLock(lockPath) {
  const deadline = Date.now() + PR_NUMBER_STAMP_LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      // Rule 1 layer A (#166): serialize the read-check-write-append branch so only one
      // gate-check process performs first-resolution stamping for a run at a time.
      return fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      Atomics.wait(PR_NUMBER_STAMP_WAIT_STATE, 0, 0, PR_NUMBER_STAMP_LOCK_POLL_MS);
    }
  }

  return null;
}

function stampPrNumberUnderLock(manifestRecord, numericPrNumber) {
  const repoRoot = manifestRecord.data?.paths?.repo_root || process.cwd();
  const runDir = getRunDir(repoRoot, manifestRecord.data?.run_id);
  const lockPath = path.join(runDir, PR_NUMBER_STAMP_LOCK_NAME);
  let lockFd = null;

  fs.mkdirSync(runDir, { recursive: true });
  lockFd = waitForPrNumberStampLock(lockPath);
  if (lockFd === null) {
    // #185 / meta-rule 1 recursive: the timeout fallthrough serves two downstream
    // consumers. Audit-trail dedup is still fail-safe, but the merge gate must
    // fail-closed if a stale lock or peer crash left git.pr_number unset. Re-read
    // first so healthy contention still succeeds when the peer finished stamping
    // during our wait.
    const freshRecord = readFreshManifestRecord(manifestRecord);
    const freshPrNumber = freshRecord.data?.git?.pr_number;
    if (freshPrNumber !== undefined && freshPrNumber !== null) {
      return freshRecord;
    }
    throw new Error(
      "gate-check: .pr_number_stamp.lock contention timeout left git.pr_number unset after a fresh re-read. "
      + "This indicates a stale lock or peer crash during first-resolution stamping. "
      + `Clear the .pr_number_stamp.lock file and retry: rm ${JSON.stringify(lockPath)}. `
      + "See #185 / #166 for background."
    );
  }

  try {
    const freshRecord = readFreshManifestRecord(manifestRecord);

    // Rule 4 (#166): re-apply the non-terminal whitelist after the fresh read.
    // resolveManifestRecord filtered out merged/closed at the caller, but a
    // concurrent close-run / finalize-run may have transitioned the manifest
    // during our bounded wait. Fail-safe skip preserves the caller's contract
    // without turning the race into a throw.
    if (!isNonTerminalStateForPrStamp(freshRecord.data?.state)) {
      return freshRecord;
    }

    if (freshRecord.data?.git?.pr_number !== undefined && freshRecord.data?.git?.pr_number !== null) {
      return freshRecord;
    }

    const updatedData = {
      ...freshRecord.data,
      git: {
        ...(freshRecord.data?.git || {}),
        pr_number: numericPrNumber,
      },
    };

    writeManifest(manifestRecord.manifestPath, updatedData, freshRecord.body);

    // Rule 1 layer B (#166): dedupe against the committed journal so even a future lock
    // regression cannot emit duplicate first-resolution pr_number_stamped events.
    const alreadyStamped = readRunEvents(repoRoot, updatedData.run_id)
      .some((entry) => entry.event === "pr_number_stamped");

    if (!alreadyStamped) {
      appendRunEvent(repoRoot, updatedData.run_id, {
        event: "pr_number_stamped",
        state_from: updatedData.state,
        state_to: updatedData.state,
        head_sha: updatedData.git?.head_sha || null,
        round: updatedData.review?.rounds || null,
        reason: `Stamped git.pr_number=${numericPrNumber} during gate-check PR resolution`,
      });
    }

    return {
      ...freshRecord,
      data: updatedData,
    };
  } finally {
    try {
      fs.closeSync(lockFd);
    } catch {}
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function tryResolveManifestForPr(prNumber, headRefName) {
  try {
    // gate-check runs before merge finalization, so it must never resolve merged/closed manifests.
    const manifestRecord = resolveManifestRecord({
      repoRoot: process.cwd(),
      prNumber,
      branch: headRefName || undefined,
    });
    const numericPrNumber = Number(prNumber);
    if (
      Number.isInteger(numericPrNumber)
      && numericPrNumber >= 0
      && (manifestRecord.data?.git?.pr_number === undefined || manifestRecord.data?.git?.pr_number === null)
    ) {
      return stampPrNumberUnderLock(manifestRecord, numericPrNumber);
    }
    return manifestRecord;
  } catch (error) {
    return { error };
  }
}

function output(result) {
  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.status === "lgtm") {
      console.log(`✓ PR #${PR_NUM}: relay-review LGTM (round ${result.round || "?"}) — ready to merge`);
    } else if (result.status === "skipped") {
      console.log(`⊘ PR #${PR_NUM}: review skipped — ${result.reason} — merge explicitly if appropriate`);
    } else if (result.status === "escalated") {
      console.log(`✗ PR #${PR_NUM}: relay-review ESCALATED — resolve issues before merge`);
      if (result.issues) console.log(`  ${result.issues}`);
    } else if (result.status === "changes_requested") {
      console.log(`✗ PR #${PR_NUM}: relay-review requested changes — re-dispatch or fix the branch before merge`);
      if (result.issues) console.log(`  ${result.issues}`);
    } else if (result.status === "missing_rubric_path") {
      console.log(`✗ PR #${PR_NUM}: run is missing anchor.rubric_path — merge blocked`);
      console.log("  Re-dispatch from relay-plan with --rubric-file, or explicitly grandfather a pre-change run.");
    } else if (result.status === "missing_rubric_file") {
      console.log(`✗ PR #${PR_NUM}: anchored rubric file is missing from the run directory — merge blocked`);
      if (result.reason) console.log(`  ${result.reason}`);
      console.log("  Restore the anchored rubric file, or re-dispatch with a persisted rubric before rerunning relay-review.");
    } else if (result.status === "empty_rubric_file") {
      console.log(`✗ PR #${PR_NUM}: anchored rubric file is empty — merge blocked`);
      if (result.reason) console.log(`  ${result.reason}`);
      console.log("  Regenerate the rubric with relay-plan and re-dispatch before rerunning relay-review.");
    } else if (result.status === "invalid_rubric_path") {
      console.log(`✗ PR #${PR_NUM}: anchor.rubric_path escapes the run directory — merge blocked`);
      if (result.reason) console.log(`  ${result.reason}`);
      console.log("  Fix anchor.rubric_path to stay inside the run directory, then re-dispatch before rerunning relay-review.");
    } else if (result.status === "invalid_rubric_file") {
      console.log(`✗ PR #${PR_NUM}: anchor.rubric_path does not point to a readable rubric file — merge blocked`);
      if (result.reason) console.log(`  ${result.reason}`);
      console.log("  Fix or restore the anchored rubric file, then re-dispatch before rerunning relay-review.");
    } else if (result.status === "manifest_resolution_failed") {
      console.log(`✗ PR #${PR_NUM}: unable to resolve relay manifest — merge blocked`);
      if (result.reason) console.log(`  ${result.reason}`);
    } else if (result.status === "unauthorized_reviewer") {
      console.log(`✗ PR #${PR_NUM}: relay-review comment found but from unauthorized author (expected: ${result.expectedReviewerLogin})`);
    } else if (result.status === "stale") {
      console.log(`✗ PR #${PR_NUM}: relay-review is stale — run review again for the latest commit before merge`);
      if (result.latestCommit) console.log(`  Latest commit: ${result.latestCommit}`);
      if (result.reviewedAt) console.log(`  Review time:   ${result.reviewedAt}`);
    } else {
      console.log(`✗ PR #${PR_NUM}: no relay-review comment found`);
      console.log("  Run /relay-review first, or use --skip <reason> to bypass with audit trail.");
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // --- Skip path: write audit comment and exit ---
  if (SKIP) {
    const skipComment = buildSkipComment(SKIP_REASON);

    if (DRY_RUN) {
      output({ status: "skipped", pr: PR_NUM, reason: SKIP_REASON, comment: skipComment, readyToMerge: true });
    } else {
      execFileSync("gh", ["pr", "comment", PR_NUM, "--body", skipComment], {
        encoding: "utf-8",
        stdio: "pipe",
      });
      output({ status: "skipped", pr: PR_NUM, reason: SKIP_REASON, readyToMerge: true });
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
    const raw = gh("pr", "view", PR_NUM, "--json", "comments,commits,headRefName");
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
      runDir = getRunDir(manifestData.paths?.repo_root || process.cwd(), manifestData.run_id);
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
  if (result.note) {
    console.error(`Note: ${result.note}`);
  }
  output(result);
  if (!result.readyToMerge) {
    process.exit(1);
  }
}

main();
