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
  writeManifest,
  readManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");

const SCRIPT = path.join(__dirname, "review-runner.js");

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-runner-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const runId = "issue-42-20260403010000000";
  const manifestPath = ensureRunLayout(repoRoot, runId).manifestPath;
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-42",
    baseBranch: "main",
    issueNumber: 42,
    worktreePath: path.join(repoRoot, "wt", "issue-42"),
    orchestrator: "codex",
    worker: "codex",
    reviewer: "claude",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  writeManifest(manifestPath, manifest);

  const doneCriteriaPath = path.join(repoRoot, "done-criteria.md");
  const diffPath = path.join(repoRoot, "pr.diff");
  fs.writeFileSync(doneCriteriaPath, "# Done Criteria\n\n- Add smoke.txt\n- Do not touch auth\n", "utf-8");
  fs.writeFileSync(diffPath, "diff --git a/smoke.txt b/smoke.txt\n+ok\n", "utf-8");

  return { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath };
}

function writeVerdict(repoRoot, name, verdict) {
  const filePath = path.join(repoRoot, name);
  fs.writeFileSync(filePath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");
  return filePath;
}

function writeReviewerScript(repoRoot, name, verdict) {
  const filePath = path.join(repoRoot, name);
  const body = `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(verdict))});
`;
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeMutatingReviewerScript(repoRoot, name, verdict) {
  const filePath = path.join(repoRoot, name);
  const body = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const repoIndex = args.indexOf("--repo");
const repo = repoIndex !== -1 ? args[repoIndex + 1] : process.cwd();
fs.writeFileSync(path.join(repo, "reviewer-mutated.txt"), "bad\\n", "utf-8");
process.stdout.write(${JSON.stringify(JSON.stringify(verdict))});
`;
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

test("prepare-only writes a prompt bundle without changing manifest state", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.prepareOnly, true);
  assert.equal(result.round, 1);
  assert.equal(result.state, STATES.REVIEW_PENDING);
  assert.equal(path.basename(result.promptPath), "review-round-1-prompt.md");
  assert.ok(fs.existsSync(result.promptPath));
  assert.ok(fs.existsSync(result.doneCriteriaPath));
  assert.ok(fs.existsSync(result.diffPath));
  assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING);
  assert.equal(readManifest(manifestPath).data.run_id, runId);
});

test("pass verdict moves review_pending to ready_to_merge", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "pass.json", {
    verdict: "pass",
    summary: "All done criteria are satisfied.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.commentPosted, false);
  assert.ok(fs.existsSync(result.verdictPath));

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.next_action, "await_explicit_merge");
  assert.equal(manifest.git.pr_number, 123);
  assert.equal(manifest.review.rounds, 1);
  assert.equal(manifest.review.latest_verdict, "lgtm");
});

test("changes_requested verdict creates a re-dispatch artifact", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "changes.json", {
    verdict: "changes_requested",
    summary: "One requirement is missing.",
    contract_status: "fail",
    quality_status: "pass",
    next_action: "changes_requested",
    issues: [
      {
        title: "Missing smoke file",
        body: "The PR does not add the required smoke.txt output.",
        file: "src/index.js",
        line: 12,
        category: "contract",
        severity: "high",
      },
    ],
    rubric_scores: [],
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.CHANGES_REQUESTED);
  assert.ok(result.redispatchPath);
  assert.ok(fs.existsSync(result.redispatchPath));
  const redispatchText = fs.readFileSync(result.redispatchPath, "utf-8");
  assert.match(redispatchText, /Fix these review issues in the PR/);
  assert.match(redispatchText, /src\/index.js:12/);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.CHANGES_REQUESTED);
  assert.equal(manifest.next_action, "re_dispatch_requested_changes");
  assert.equal(manifest.review.rounds, 1);
  assert.equal(manifest.review.latest_verdict, "changes_requested");
});

test("reviewer-script invocation can drive a round without --review-file", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewerScript = writeReviewerScript(repoRoot, "reviewer-pass.js", {
    verdict: "pass",
    summary: "Automated reviewer passed the change.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer-script", reviewerScript,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.reviewerScript, reviewerScript);
  assert.ok(result.rawResponsePath);
  assert.ok(fs.existsSync(result.rawResponsePath));

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.review.latest_verdict, "lgtm");
});

test("invalid pass verdict is rejected", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "invalid-pass.json", {
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [
      {
        title: "Should not be here",
        body: "PASS verdict cannot carry issues.",
        file: "x.js",
        line: 1,
        category: "contract",
        severity: "low",
      },
    ],
    rubric_scores: [],
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /PASS verdict must not include issues/);
});

test("invalid rubric score entry is rejected", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "invalid-rubric.json", {
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [
      {
        factor: "Contract coverage",
        target: ">= 8",
        observed: "9",
        status: "pass",
      },
    ],
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /rubric_scores\[0\]\.notes is required/);
});

test("reviewer write policy violation escalates the manifest", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewerScript = writeMutatingReviewerScript(repoRoot, "reviewer-mutates.js", {
    verdict: "pass",
    summary: "This should not be trusted.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer-script", reviewerScript,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /Reviewer write policy violation detected/);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.next_action, "inspect_review_failure");
  assert.equal(manifest.review.rounds, 1);
  assert.equal(manifest.review.latest_verdict, "policy_violation");
});
