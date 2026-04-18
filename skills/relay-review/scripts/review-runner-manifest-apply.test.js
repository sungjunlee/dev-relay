const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { STATES, updateManifestState } = require("../../relay-dispatch/scripts/manifest/lifecycle");
const { createManifestSkeleton, ensureRunLayout } = require("../../relay-dispatch/scripts/manifest/store");
const {
  applyPolicyViolationToManifest,
  applyVerdictToManifest,
} = require("./review-runner/manifest-apply");

function createManifestInState(state = STATES.REVIEW_PENDING) {
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

  let manifest = createManifestSkeleton({
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
  manifest = {
    ...manifest,
    anchor: {
      ...(manifest.anchor || {}),
      rubric_path: "rubric.yaml",
    },
    git: {
      ...(manifest.git || {}),
      pr_number: 11,
      head_sha: "old-head-sha",
    },
    review: {
      ...(manifest.review || {}),
      reviewer_login: "trusted-reviewer",
      last_gate: { status: "old_gate" },
    },
  };

  if (state === STATES.DISPATCHED) {
    return updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  }
  if (state === STATES.REVIEW_PENDING) {
    return updateManifestState(
      updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result"),
      STATES.REVIEW_PENDING,
      "run_review"
    );
  }
  if (state === STATES.CHANGES_REQUESTED) {
    return updateManifestState(
      createManifestInState(STATES.REVIEW_PENDING),
      STATES.CHANGES_REQUESTED,
      "re_dispatch_requested_changes"
    );
  }
  if (state === STATES.READY_TO_MERGE) {
    return updateManifestState(
      createManifestInState(STATES.REVIEW_PENDING),
      STATES.READY_TO_MERGE,
      "await_explicit_merge"
    );
  }
  if (state === STATES.ESCALATED) {
    return updateManifestState(
      createManifestInState(STATES.REVIEW_PENDING),
      STATES.ESCALATED,
      "inspect_review_failure"
    );
  }
  if (state === STATES.MERGED) {
    return updateManifestState(
      createManifestInState(STATES.READY_TO_MERGE),
      STATES.MERGED,
      "manual_cleanup_required"
    );
  }
  if (state === STATES.CLOSED) {
    return updateManifestState(
      createManifestInState(STATES.ESCALATED),
      STATES.CLOSED,
      "done"
    );
  }
  return manifest;
}

function makeVerdict(verdict, nextAction) {
  return {
    verdict,
    next_action: nextAction,
  };
}

function normalizeUpdatedTimestamp(manifest) {
  return {
    ...manifest,
    timestamps: {
      ...(manifest.timestamps || {}),
      updated_at: "<updated>",
    },
  };
}

function assertManifestWriteParity(actual, before, expected) {
  assert.equal(actual.timestamps.created_at, before.timestamps.created_at);
  assert.ok(Date.parse(actual.timestamps.updated_at) >= Date.parse(before.timestamps.updated_at));
  assert.deepEqual(normalizeUpdatedTimestamp(actual), normalizeUpdatedTimestamp(expected));
}

test("manifest-apply/applyVerdictToManifest preserves the PASS field-write contract", () => {
  const manifest = createManifestInState(STATES.REVIEW_PENDING);
  const result = applyVerdictToManifest(
    manifest,
    makeVerdict("pass", "ready_to_merge"),
    1,
    189,
    "abc123",
    0
  );

  assertManifestWriteParity(result, manifest, {
    ...manifest,
    state: STATES.READY_TO_MERGE,
    next_action: "await_explicit_merge",
    git: {
      ...manifest.git,
      pr_number: 189,
      head_sha: "abc123",
    },
    review: {
      ...manifest.review,
      rounds: 1,
      latest_verdict: "lgtm",
      repeated_issue_count: 0,
      last_reviewed_sha: "abc123",
      last_gate: null,
    },
  });
});

test("manifest-apply/applyVerdictToManifest fail-closes PASS with the full rubric gate payload", () => {
  const manifest = createManifestInState(STATES.REVIEW_PENDING);
  const rubricGateFailure = {
    status: "rubric_state_failed_closed",
    layer: "review-runner",
    rubricState: "missing",
    rubricStatus: "missing",
    recoveryCommand: "node dispatch.js --run-id issue-189",
    recovery: "Restore rubric and re-dispatch.",
    reason: "rubric missing",
  };
  const result = applyVerdictToManifest(
    manifest,
    makeVerdict("pass", "ready_to_merge"),
    2,
    189,
    "abc123",
    0,
    { rubricGateFailure }
  );

  assertManifestWriteParity(result, manifest, {
    ...manifest,
    state: STATES.CHANGES_REQUESTED,
    next_action: "repair_rubric_and_redispatch",
    git: {
      ...manifest.git,
      pr_number: 189,
      head_sha: "abc123",
    },
    review: {
      ...manifest.review,
      rounds: 2,
      latest_verdict: "rubric_state_failed_closed",
      repeated_issue_count: 0,
      last_reviewed_sha: "abc123",
      last_gate: {
        status: "rubric_state_failed_closed",
        layer: "review-runner",
        rubric_state: "missing",
        rubric_status: "missing",
        recovery_command: "node dispatch.js --run-id issue-189",
        recovery: "Restore rubric and re-dispatch.",
        reason: "rubric missing",
      },
    },
  });
});

test("manifest-apply/applyVerdictToManifest preserves the CHANGES_REQUESTED field-write contract", () => {
  const manifest = createManifestInState(STATES.REVIEW_PENDING);
  const result = applyVerdictToManifest(
    manifest,
    makeVerdict("changes_requested", "changes_requested"),
    3,
    189,
    "abc123",
    4
  );

  assertManifestWriteParity(result, manifest, {
    ...manifest,
    state: STATES.CHANGES_REQUESTED,
    next_action: "re_dispatch_requested_changes",
    git: {
      ...manifest.git,
      pr_number: 189,
      head_sha: "abc123",
    },
    review: {
      ...manifest.review,
      rounds: 3,
      latest_verdict: "changes_requested",
      repeated_issue_count: 4,
      last_reviewed_sha: "abc123",
      last_gate: null,
    },
  });
});

test("manifest-apply/applyVerdictToManifest refreshes same-state CHANGES_REQUESTED without a transition", () => {
  const manifest = createManifestInState(STATES.CHANGES_REQUESTED);
  const result = applyVerdictToManifest(
    manifest,
    makeVerdict("changes_requested", "changes_requested"),
    4,
    189,
    "abc123",
    2
  );

  assertManifestWriteParity(result, manifest, {
    ...manifest,
    next_action: "re_dispatch_requested_changes",
    git: {
      ...manifest.git,
      pr_number: 189,
      head_sha: "abc123",
    },
    review: {
      ...manifest.review,
      rounds: 4,
      latest_verdict: "changes_requested",
      repeated_issue_count: 2,
      last_reviewed_sha: "abc123",
      last_gate: null,
    },
  });
});

test("manifest-apply/applyVerdictToManifest preserves the ESCALATED field-write contract", () => {
  const manifest = createManifestInState(STATES.REVIEW_PENDING);
  const result = applyVerdictToManifest(
    manifest,
    makeVerdict("escalated", "escalated"),
    5,
    189,
    "abc123",
    7
  );

  assertManifestWriteParity(result, manifest, {
    ...manifest,
    state: STATES.ESCALATED,
    next_action: "inspect_review_failure",
    git: {
      ...manifest.git,
      pr_number: 189,
      head_sha: "abc123",
    },
    review: {
      ...manifest.review,
      rounds: 5,
      latest_verdict: "escalated",
      repeated_issue_count: 0,
      last_reviewed_sha: "abc123",
      last_gate: null,
    },
  });
});

test("manifest-apply/applyVerdictToManifest denies changes_requested -> pass and -> escalated transitions", async (t) => {
  const manifest = createManifestInState(STATES.CHANGES_REQUESTED);

  await t.test("pass", () => {
    assert.throws(() => applyVerdictToManifest(
      manifest,
      makeVerdict("pass", "ready_to_merge"),
      6,
      189,
      "abc123",
      0
    ), /Invalid relay state transition: changes_requested -> ready_to_merge/);
  });

  await t.test("escalated", () => {
    assert.throws(() => applyVerdictToManifest(
      manifest,
      makeVerdict("escalated", "escalated"),
      6,
      189,
      "abc123",
      0
    ), /Invalid relay state transition: changes_requested -> escalated/);
  });
});

test("manifest-apply/applyVerdictToManifest denies terminal-state mutations via validateTransition", async (t) => {
  for (const state of [STATES.MERGED, STATES.CLOSED]) {
    await t.test(state, () => {
      assert.throws(() => applyVerdictToManifest(
        createManifestInState(state),
        makeVerdict("pass", "ready_to_merge"),
        7,
        189,
        "abc123",
        0
      ), new RegExp(`Invalid relay state transition: ${state} -> ready_to_merge`));
    });
  }
});

test("manifest-apply/applyPolicyViolationToManifest preserves the escalation write contract", () => {
  const manifest = createManifestInState(STATES.REVIEW_PENDING);
  const result = applyPolicyViolationToManifest(
    manifest,
    8,
    189,
    "abc123",
    "policy_violation"
  );

  assertManifestWriteParity(result, manifest, {
    ...manifest,
    state: STATES.ESCALATED,
    next_action: "inspect_review_failure",
    git: {
      ...manifest.git,
      pr_number: 189,
      head_sha: "abc123",
    },
    review: {
      ...manifest.review,
      rounds: 8,
      latest_verdict: "policy_violation",
      repeated_issue_count: 0,
      last_reviewed_sha: "abc123",
    },
  });
});

test("manifest-apply/applyPolicyViolationToManifest denies terminal-state escalation", () => {
  assert.throws(() => applyPolicyViolationToManifest(
    createManifestInState(STATES.MERGED),
    9,
    189,
    "abc123",
    "policy_violation"
  ), /Invalid relay state transition: merged -> escalated/);
});
