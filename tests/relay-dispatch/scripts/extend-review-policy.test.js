const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { findUnknownFlags } = require("../../../skills/relay-dispatch/scripts/cli-args");
const {
  createManifestSkeleton,
} = require("../../../skills/relay-dispatch/scripts/manifest/store");

const ROOT = path.join(__dirname, "..", "..", "..");
const REMOVED_MODULE = path.join(
  ROOT,
  "skills",
  "relay-dispatch",
  "scripts",
  "extend-review-policy.js",
);

test("mutable review-policy extension surface stays deleted", () => {
  assert.equal(fs.existsSync(REMOVED_MODULE), false);
  assert.deepEqual(
    findUnknownFlags(["--max-rounds", "4"], {
      reservedFlags: ["--branch", "--prompt", "--dry-run", "--json", "--help", "-h"],
      booleanFlags: ["--dry-run", "--json", "--help", "-h"],
    }),
    ["--max-rounds"],
  );
});

test("new manifests have no mutable review-round budget", () => {
  const manifest = createManifestSkeleton({
    repoRoot: ROOT,
    runId: "round-policy-deletion-evidence-20260731000000000",
    branch: "work",
    baseBranch: "main",
    issueNumber: 1134,
    worktreePath: ROOT,
  });
  assert.equal(Object.hasOwn(manifest.review, "max_rounds"), false);
  assert.equal(Object.hasOwn(manifest.review, "round_budget"), false);
  assert.equal(manifest.review.rounds, 0);
  assert.equal(manifest.review.latest_verdict, "pending");
});
