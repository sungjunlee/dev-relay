const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { STATES, updateManifestState } = require("../../relay-dispatch/scripts/manifest/lifecycle");
const { ensureRunLayout, getEventsPath } = require("../../relay-dispatch/scripts/manifest/paths");
const { createManifestSkeleton, readManifest, writeManifest } = require("../../relay-dispatch/scripts/manifest/store");
const {
  captureGitStatus,
  loadReviewText,
  resolveReviewerName,
  resolveReviewerScript,
} = require("./review-runner/reviewer-invoke");

function setupReviewRun() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-invoke-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });

  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  process.env.RELAY_HOME = relayHome;
  const runId = "issue-189-20260418020202020";
  const { runDir, manifestPath } = ensureRunLayout(repoRoot, runId);
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
  };
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  writeManifest(manifestPath, manifest, "# Notes\n");

  const promptPath = path.join(runDir, "prompt.md");
  fs.writeFileSync(promptPath, "Return a passing review.\n", "utf-8");

  return {
    relayHome,
    repoRoot,
    runDir,
    manifestPath,
    manifest,
    promptPath,
    runId,
  };
}

function writeExecutable(dir, name, body) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

test("reviewer-invoke/resolveReviewerName preserves arg, manifest, env precedence", (t) => {
  const originalReviewer = process.env.RELAY_REVIEWER;
  t.after(() => {
    if (originalReviewer === undefined) {
      delete process.env.RELAY_REVIEWER;
      return;
    }
    process.env.RELAY_REVIEWER = originalReviewer;
  });

  process.env.RELAY_REVIEWER = "env-reviewer";
  assert.equal(resolveReviewerName({ roles: { reviewer: "manifest-reviewer" } }, "arg-reviewer"), "arg-reviewer");
  assert.equal(resolveReviewerName({ roles: { reviewer: "manifest-reviewer" } }), "env-reviewer");
  assert.equal(resolveReviewerName({ roles: { reviewer: "unknown" } }), "env-reviewer");
});

test("reviewer-invoke/resolveReviewerScript resolves built-in adapters and rejects invalid names", () => {
  const script = resolveReviewerScript("codex");
  assert.match(script, /invoke-reviewer-codex\.js$/);
  assert.throws(() => resolveReviewerScript("../bad"), /Invalid reviewer name/);
});

test("reviewer-invoke/loadReviewText forwards promptPath to the adapter and persists the raw response", (t) => {
  const originalRelayHome = process.env.RELAY_HOME;
  const { relayHome, repoRoot, runDir, manifestPath, manifest, promptPath } = setupReviewRun();
  t.after(() => {
    if (originalRelayHome === undefined) {
      delete process.env.RELAY_HOME;
      return;
    }
    process.env.RELAY_HOME = originalRelayHome;
  });
  process.env.RELAY_HOME = relayHome;

  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-helper-"));
  const reviewerScript = writeExecutable(helperDir, "reviewer-reads-prompt.js", `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const promptIndex = args.indexOf("--prompt-file");
const promptPath = promptIndex !== -1 ? args[promptIndex + 1] : null;
if (!promptPath || promptPath === "undefined") {
  process.stderr.write("missing prompt path\\n");
  process.exit(7);
}
process.stdout.write(JSON.stringify({
  promptPath,
  promptText: fs.readFileSync(promptPath, "utf-8").trim(),
}) + "\\n");
`);

  const { rawResponsePath, reviewText } = loadReviewText({
    body: "# Notes\n",
    data: manifest,
    manifestPath,
    prNumber: 11,
    promptPath,
    reviewFile: null,
    reviewRepoPath: repoRoot,
    reviewedHeadSha: "abc123",
    reviewerModel: null,
    reviewerName: "codex",
    reviewerScript,
    round: 1,
    runDir,
    runRepoPath: repoRoot,
  });

  assert.ok(rawResponsePath);
  assert.equal(fs.readFileSync(rawResponsePath, "utf-8"), `${reviewText}\n`);
  assert.deepEqual(JSON.parse(reviewText), {
    promptPath,
    promptText: "Return a passing review.",
  });
});

test("reviewer-invoke/loadReviewText escalates when the reviewer mutates the worktree", (t) => {
  const originalRelayHome = process.env.RELAY_HOME;
  const { relayHome, repoRoot, runDir, manifestPath, manifest, promptPath, runId } = setupReviewRun();
  t.after(() => {
    if (originalRelayHome === undefined) {
      delete process.env.RELAY_HOME;
      return;
    }
    process.env.RELAY_HOME = originalRelayHome;
  });
  process.env.RELAY_HOME = relayHome;

  const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-helper-"));
  const reviewerScript = writeExecutable(helperDir, "reviewer-mutates.js", `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const repoIndex = args.indexOf("--repo");
const repo = repoIndex !== -1 ? args[repoIndex + 1] : process.cwd();
fs.writeFileSync(path.join(repo, "mutated.txt"), "dirty\\n", "utf-8");
process.stdout.write("{\\"verdict\\":\\"pass\\"}\\n");
`);

  assert.throws(() => loadReviewText({
    body: "# Notes\n",
    data: manifest,
    manifestPath,
    prNumber: 11,
    promptPath,
    reviewFile: null,
    reviewRepoPath: repoRoot,
    reviewedHeadSha: "abc123",
    reviewerModel: null,
    reviewerName: "codex",
    reviewerScript,
    round: 1,
    runDir,
    runRepoPath: repoRoot,
  }), /Reviewer write policy violation detected/);

  const updatedManifest = readManifest(manifestPath).data;
  const violationPath = path.join(runDir, "review-round-1-policy-violation.txt");
  const eventsPath = getEventsPath(repoRoot, runId);

  assert.equal(updatedManifest.state, STATES.ESCALATED);
  assert.equal(updatedManifest.next_action, "inspect_review_failure");
  assert.equal(updatedManifest.review.rounds, 1);
  assert.equal(updatedManifest.review.latest_verdict, "policy_violation");
  assert.equal(updatedManifest.review.last_reviewed_sha, "abc123");
  assert.match(fs.readFileSync(violationPath, "utf-8"), /mutated\.txt/);
  assert.match(fs.readFileSync(eventsPath, "utf-8"), /"reason":"policy_violation"/);
});

test("reviewer-invoke/captureGitStatus preserves dirty-worktree detection", () => {
  const { repoRoot } = setupReviewRun();
  fs.writeFileSync(path.join(repoRoot, "dirty.txt"), "dirty\n", "utf-8");

  assert.match(captureGitStatus(repoRoot), /dirty\.txt/);
});
