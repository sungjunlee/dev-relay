const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
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
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay", "scripts", "run-preflight.js");

function setupReadyRun({ liveHead = "abc123", reviewedSha = "abc123", manifestHead = "abc123" } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-preflight-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");

  const runId = createRunId({
    branch: "issue-691",
    timestamp: new Date("2026-06-08T00:00:00.000Z"),
  });
  const { manifestPath } = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-691",
    baseBranch: "main",
    issueNumber: 691,
    worktreePath: repoRoot,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest.git.pr_number = 691;
  manifest.git.head_sha = manifestHead;
  manifest.anchor.rubric_path = "rubric.yaml";
  fs.writeFileSync(path.join(ensureRunLayout(repoRoot, runId).runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: ready drift\n", "utf-8");
  manifest.review = {
    ...(manifest.review || {}),
    rounds: 1,
    latest_verdict: "lgtm",
    last_reviewed_sha: reviewedSha,
  };
  manifest = updateManifestState(
    updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result"),
    STATES.REVIEW_PENDING,
    "run_review"
  );
  manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  writeManifest(manifestPath, manifest);

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-preflight-gh-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    number: 691,
    headRefName: "issue-691",
    headRefOid: ${JSON.stringify(liveHead)}
  }));
  process.exit(0);
}
process.stderr.write("unexpected gh args: " + args.join(" "));
process.exit(2);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);

  return { repoRoot, runId, manifestPath, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } };
}

function runReviewPreflight(fixture) {
  return JSON.parse(execFileSync("node", [
    SCRIPT,
    "--stage", "review",
    "--repo", fixture.repoRoot,
    "--run-id", fixture.runId,
    "--pr", "691",
    "--json",
  ], {
    encoding: "utf-8",
    env: fixture.env,
  }));
}

test("review preflight reports unchanged ready_to_merge PR as merge-ready", () => {
  const fixture = setupReadyRun({ liveHead: "abc123", reviewedSha: "abc123", manifestHead: "abc123" });

  const result = runReviewPreflight(fixture);

  assert.equal(result.snapshot.state, STATES.READY_TO_MERGE);
  assert.equal(result.ready_status.status, "merge_ready");
  assert.equal(result.ready_status.pr_number, 691);
  assert.equal(result.ready_status.old_sha, "abc123");
  assert.equal(result.ready_status.new_sha, "abc123");
  assert.equal(result.ready_status.next_action, "proceed_to_merge");
});

test("review preflight reports ready_to_merge PR with live HEAD drift as stale-ready", () => {
  const fixture = setupReadyRun({ liveHead: "def456", reviewedSha: "abc123", manifestHead: "abc123" });

  const result = runReviewPreflight(fixture);

  assert.equal(result.snapshot.state, STATES.READY_TO_MERGE);
  assert.equal(result.ready_status.status, "stale_ready");
  assert.equal(result.ready_status.pr_number, 691);
  assert.equal(result.ready_status.old_sha, "abc123");
  assert.equal(result.ready_status.new_sha, "def456");
  assert.equal(result.ready_status.reviewed_sha, "abc123");
  assert.equal(result.ready_status.manifest_head_sha, "abc123");
  assert.equal(result.ready_status.next_action, "recover_ready_to_review_pending_then_rerun_review");
});
