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
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");
const { findManifestByRunId, resolveManifestRecord } = require("./relay-resolver");

function writeReviewPendingManifest(repoRoot, {
  runId,
  storedRunId = runId,
  branch = "issue-42",
  issueNumber = 42,
  updatedAt = "2026-04-03T00:00:00.000Z",
} = {}) {
  const manifestPath = ensureRunLayout(repoRoot, runId).manifestPath;
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber,
    worktreePath: path.join(repoRoot, "wt", branch),
    orchestrator: "codex",
    executor: "codex",
    reviewer: "claude",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor.rubric_grandfathered = true;
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  manifest.run_id = storedRunId;
  manifest.timestamps.updated_at = updatedAt;
  manifest.timestamps.created_at = updatedAt;
  writeManifest(manifestPath, manifest);
  return manifestPath;
}

test("findManifestByRunId rejects invalid run_id selectors before scanning manifests", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-find-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));

  assert.throws(
    () => findManifestByRunId(repoRoot, "../victim-run"),
    /may not contain '\.\.' segments/
  );
  assert.throws(
    () => findManifestByRunId(repoRoot, "issue-42\\20260412000000000"),
    /may not contain '\\\\'/
  );
});

test("resolveManifestRecord rejects non-conforming run_id selectors", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-shape-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  writeReviewPendingManifest(repoRoot, {
    runId: createRunId({
      branch: "issue-42",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
  });

  assert.throws(
    () => resolveManifestRecord({ repoRoot, runId: "Issue-42-20260412000000000" }),
    /shape emitted by createRunId/
  );
});

test("resolveManifestRecord rejects manifests whose stored run_id is invalid", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-invalid-manifest-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  writeReviewPendingManifest(repoRoot, {
    runId: createRunId({
      branch: "issue-42",
      timestamp: new Date("2026-04-03T00:05:00.000Z"),
    }),
    storedRunId: "../victim-run",
    updatedAt: "2026-04-03T00:05:00.000Z",
  });

  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "issue-42" }),
    /has invalid run_id: run_id must be a single path segment/
  );
});
