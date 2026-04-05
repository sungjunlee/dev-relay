const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CLEANUP_STATUSES,
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  inferIssueNumber,
  readManifest,
  updateManifestCleanup,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");

test("inferIssueNumber extracts issue numbers from issue branches", () => {
  assert.equal(inferIssueNumber("issue-42"), 42);
  assert.equal(inferIssueNumber("feature/issue-99-auth"), 99);
  assert.equal(inferIssueNumber("feature/auth"), null);
});

test("createRunId is branch-stable and filesystem-safe", () => {
  const runId = createRunId({
    branch: "Feature/Auth Flow",
    timestamp: new Date("2026-04-02T12:34:56Z"),
  });
  assert.equal(runId, "feature-auth-flow-20260402123456000");
});

test("manifest round-trips through frontmatter helpers", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-"));
  const runId = "issue-42-20260402103000";
  const worktreePath = path.join(repoRoot, "wt");
  const { manifestPath } = ensureRunLayout(repoRoot, runId);
  const manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-42",
    baseBranch: "main",
    issueNumber: 42,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "claude",
  });

  writeManifest(manifestPath, manifest);
  const parsed = readManifest(manifestPath);

  assert.equal(parsed.data.run_id, runId);
  assert.equal(parsed.data.state, STATES.DRAFT);
  assert.equal(parsed.data.issue.number, 42);
  assert.equal(parsed.data.roles.reviewer, "claude");
  assert.equal(parsed.data.git.head_sha, null);
  assert.equal(parsed.data.review.last_reviewed_sha, null);
  assert.equal(parsed.data.cleanup.status, CLEANUP_STATUSES.PENDING);
  assert.match(parsed.body, /# Notes/);
});

test("manifest round-trips multiline scalar values", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-multiline-"));
  const runId = "issue-42-20260402103001";
  const worktreePath = path.join(repoRoot, "wt");
  const { manifestPath } = ensureRunLayout(repoRoot, runId);
  const manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-42",
    baseBranch: "main",
    issueNumber: 42,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "claude",
  });
  manifest.cleanup.error = "dirty worktree: M README.md\n?? docs/direct-read-relay-operator-note.md";

  writeManifest(manifestPath, manifest);
  const parsed = readManifest(manifestPath);

  assert.equal(
    parsed.data.cleanup.error,
    "dirty worktree: M README.md\n?? docs/direct-read-relay-operator-note.md"
  );
});

test("readManifest migrates v1 roles.worker to roles.executor", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-migrate-"));
  const runId = "migrate-v1-20260402103000";
  const wtPath = path.join(tmpRoot, "wt");
  const { manifestPath } = ensureRunLayout(tmpRoot, runId);
  const manifest = createManifestSkeleton({
    repoRoot: tmpRoot,
    runId,
    branch: "migrate-v1",
    baseBranch: "main",
    issueNumber: 99,
    worktreePath: wtPath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "claude",
  });
  // Simulate a v1 manifest: rename executor back to worker
  manifest.roles.worker = manifest.roles.executor;
  delete manifest.roles.executor;
  writeManifest(manifestPath, manifest);

  const parsed = readManifest(manifestPath);
  assert.equal(parsed.data.roles.executor, "codex");
  assert.equal(parsed.data.roles.worker, undefined);
});

test("updateManifestState allows valid transitions and rejects invalid ones", () => {
  const manifest = {
    state: STATES.DRAFT,
    next_action: "start_dispatch",
    timestamps: { created_at: "2026-04-02T10:30:00Z", updated_at: "2026-04-02T10:30:00Z" },
  };

  const dispatched = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  assert.equal(dispatched.state, STATES.DISPATCHED);
  assert.equal(dispatched.next_action, "await_dispatch_result");

  const closed = updateManifestState(manifest, STATES.CLOSED, "done");
  assert.equal(closed.state, STATES.CLOSED);

  assert.throws(
    () => updateManifestState(dispatched, STATES.MERGED, "done"),
    /Invalid relay state transition/
  );
});

test("updateManifestCleanup records cleanup metadata without changing state", () => {
  const manifest = {
    state: STATES.MERGED,
    next_action: "manual_cleanup_required",
    cleanup: {
      status: CLEANUP_STATUSES.PENDING,
      last_attempted_at: null,
      cleaned_at: null,
      worktree_removed: false,
      branch_deleted: false,
      prune_ran: false,
      error: null,
    },
    timestamps: { created_at: "2026-04-02T10:30:00Z", updated_at: "2026-04-02T10:30:00Z" },
  };

  const updated = updateManifestCleanup(manifest, {
    status: CLEANUP_STATUSES.SUCCEEDED,
    last_attempted_at: "2026-04-03T00:00:00Z",
    cleaned_at: "2026-04-03T00:00:00Z",
    worktree_removed: true,
    branch_deleted: true,
    prune_ran: true,
  }, "done");

  assert.equal(updated.state, STATES.MERGED);
  assert.equal(updated.next_action, "done");
  assert.equal(updated.cleanup.status, CLEANUP_STATUSES.SUCCEEDED);
  assert.equal(updated.cleanup.worktree_removed, true);
  assert.equal(updated.cleanup.branch_deleted, true);
});
