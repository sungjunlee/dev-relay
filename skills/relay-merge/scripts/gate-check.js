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

const { execFileSync } = require("child_process");
const { buildSkipComment, evaluateReviewGate } = require("./review-gate");

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
  if (DRY_RUN) {
    // Dry-run: read JSON object/array from stdin, or plain text as single comment
    const stdin = require("fs").readFileSync(0, "utf-8").trim();
    try {
      const parsed = JSON.parse(stdin);
      // Accept {comments:[...], commits:[...]} or [{body:...}] or [string]
      comments = parsed.comments || parsed;
      commits = Array.isArray(parsed.commits) ? parsed.commits : [];
      manifestData = parsed.manifest || null;
    } catch {
      // Plain text: treat entire stdin as one comment body
      comments = [{ body: stdin, createdAt: null }];
      commits = [];
    }
  } else {
    const raw = execFileSync("gh", [
      "pr", "view", PR_NUM, "--json", "comments,commits",
    ], { encoding: "utf-8", stdio: "pipe" });
    const parsed = JSON.parse(raw);
    comments = parsed.comments || [];
    commits = parsed.commits || [];
  }

  const expectedReviewerLogin = manifestData?.review?.reviewer_login || null;
  if (!DRY_RUN && !expectedReviewerLogin) {
    console.error("Note: reviewer author verification skipped — no manifest data. Use finalize-run.js for full verification.");
  }
  const result = evaluateReviewGate({
    prNumber: PR_NUM,
    comments,
    commits,
    manifestData,
    expectedReviewerLogin,
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
