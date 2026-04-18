const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CLEANUP_STATUSES,
  createCleanupSkeleton,
  updateManifestCleanup,
} = require("./cleanup");

test("manifest/cleanup createCleanupSkeleton preserves pending defaults", () => {
  const cleanup = createCleanupSkeleton();
  assert.equal(cleanup.status, CLEANUP_STATUSES.PENDING);
  assert.equal(cleanup.worktree_removed, false);
  assert.equal(cleanup.error, null);
});

test("manifest/cleanup updateManifestCleanup patches cleanup without changing state", () => {
  const manifest = updateManifestCleanup({
    state: "closed",
    next_action: "manual_cleanup_required",
    cleanup: {},
    timestamps: {},
  }, {
    status: CLEANUP_STATUSES.SKIPPED,
    error: null,
  }, "done");

  assert.equal(manifest.state, "closed");
  assert.equal(manifest.next_action, "done");
  assert.equal(manifest.cleanup.status, CLEANUP_STATUSES.SKIPPED);
});
