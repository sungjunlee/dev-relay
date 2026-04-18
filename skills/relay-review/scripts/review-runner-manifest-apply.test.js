const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  ensureRunLayout,
  updateManifestState,
} = require("../../relay-dispatch/scripts/relay-manifest");
const {
  applyPolicyViolationToManifest,
  applyVerdictToManifest,
} = require("./review-runner/manifest-apply");

function createReviewPendingManifest() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-manifest-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });

  const runId = "issue-189-20260418020202020";
  const { runDir } = ensureRunLayout(repoRoot, runId);
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: Behavior\n", "utf-8");
  const data = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-189",
    baseBranch: "main",
    issueNumber: 189,
    worktreePath: path.join(repoRoot, "wt", "issue-189"),
    orchestrator: "codex",
    executor: "codex",
    reviewer: "claude",
  });
  data.anchor = { rubric_path: "rubric.yaml" };
  return updateManifestState(
    updateManifestState(data, STATES.DISPATCHED, "await_dispatch_result"),
    STATES.REVIEW_PENDING,
    "run_review"
  );
}

function makeVerdict(verdict, nextAction) {
  return {
    verdict,
    next_action: nextAction,
  };
}

test("manifest-apply/applyVerdictToManifest keeps PASS -> ready_to_merge", () => {
  const result = applyVerdictToManifest(
    createReviewPendingManifest(),
    makeVerdict("pass", "ready_to_merge"),
    1,
    189,
    "abc123",
    0
  );

  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.next_action, "await_explicit_merge");
  assert.equal(result.review.latest_verdict, "lgtm");
});

test("manifest-apply/applyVerdictToManifest fail-closes PASS with a rubric gate failure", () => {
  const result = applyVerdictToManifest(
    createReviewPendingManifest(),
    makeVerdict("pass", "ready_to_merge"),
    2,
    189,
    "abc123",
    0,
    {
      rubricGateFailure: {
        status: "rubric_state_failed_closed",
        layer: "review-runner",
        rubricState: "missing",
        rubricStatus: "missing",
        recoveryCommand: "node dispatch.js ...",
        recovery: "Restore rubric and re-dispatch.",
        reason: "rubric missing",
      },
    }
  );

  assert.equal(result.state, STATES.CHANGES_REQUESTED);
  assert.equal(result.next_action, "repair_rubric_and_redispatch");
  assert.equal(result.review.latest_verdict, "rubric_state_failed_closed");
  assert.equal(result.review.last_gate.rubric_state, "missing");
});

test("manifest-apply/applyVerdictToManifest keeps repeated issue count only for changes_requested", () => {
  const changesRequested = applyVerdictToManifest(
    createReviewPendingManifest(),
    makeVerdict("changes_requested", "changes_requested"),
    3,
    189,
    "abc123",
    4
  );
  const escalated = applyVerdictToManifest(
    createReviewPendingManifest(),
    makeVerdict("escalated", "escalated"),
    3,
    189,
    "abc123",
    4
  );

  assert.equal(changesRequested.state, STATES.CHANGES_REQUESTED);
  assert.equal(changesRequested.review.repeated_issue_count, 4);
  assert.equal(escalated.state, STATES.ESCALATED);
  assert.equal(escalated.review.repeated_issue_count, 0);
});

test("manifest-apply/applyPolicyViolationToManifest escalates with the supplied reason", () => {
  const result = applyPolicyViolationToManifest(
    createReviewPendingManifest(),
    5,
    189,
    "abc123",
    "policy_violation"
  );

  assert.equal(result.state, STATES.ESCALATED);
  assert.equal(result.next_action, "inspect_review_failure");
  assert.equal(result.review.latest_verdict, "policy_violation");
});
