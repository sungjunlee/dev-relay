const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  inferIssueNumber,
  readManifest,
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
    worker: "codex",
    reviewer: "claude",
  });

  writeManifest(manifestPath, manifest);
  const parsed = readManifest(manifestPath);

  assert.equal(parsed.data.run_id, runId);
  assert.equal(parsed.data.state, STATES.DRAFT);
  assert.equal(parsed.data.issue.number, 42);
  assert.equal(parsed.data.roles.reviewer, "claude");
  assert.match(parsed.body, /# Notes/);
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

  assert.throws(
    () => updateManifestState(dispatched, STATES.MERGED, "done"),
    /Invalid relay state transition/
  );
});
