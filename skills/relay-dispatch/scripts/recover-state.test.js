const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  getEventsPath,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");
const { readRunEvents } = require("./relay-events");

const SCRIPT = path.join(__dirname, "recover-state.js");

// Runs the manifest through DRAFT -> DISPATCHED -> REVIEW_PENDING -> desired end state.
// After REVIEW_PENDING the fixture records review.last_reviewed_sha = <initial HEAD on branch>
// so tests can simulate "no fresh commits" vs "fresh commit landed" scenarios.
function setupRepo({ state = STATES.CHANGES_REQUESTED, branch = "issue-211", prNumber = null, githubPrNumber = null } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recover-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  process.env.RELAY_HOME = relayHome;

  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Recover Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-recover@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const runId = createRunId({ branch, timestamp: new Date("2026-04-17T13:00:00.000Z") });
  const runLayout = ensureRunLayout(repoRoot, runId);
  const manifestPath = runLayout.manifestPath;
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 211,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest.git.pr_number = prNumber;
  if (githubPrNumber !== null) {
    manifest.github = { pr_number: githubPrNumber };
  }
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor.rubric_path = "rubric.yaml";
  fs.writeFileSync(path.join(runLayout.runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: recover-state\n", "utf-8");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");

  // Record the current HEAD as if review round 1 just completed.
  const initialHead = execFileSync("git", ["-C", repoRoot, "rev-parse", `refs/heads/${branch}`], {
    encoding: "utf-8",
  }).trim();
  manifest.review = { ...manifest.review, last_reviewed_sha: initialHead, rounds: 1 };

  if (state === STATES.CHANGES_REQUESTED) {
    manifest = updateManifestState(manifest, STATES.CHANGES_REQUESTED, "await_redispatch");
  } else if (state === STATES.ESCALATED) {
    manifest = updateManifestState(manifest, STATES.ESCALATED, "inspect_review_failure");
  } else if (state === STATES.DISPATCHED) {
    manifest = { ...manifest, state: STATES.DISPATCHED, next_action: "await_dispatch_result" };
  }

  writeManifest(manifestPath, manifest);

  return { repoRoot, manifestPath, runId, runDir: runLayout.runDir, worktreePath, branch, initialHead };
}

function addCommitOnBranch(worktreePath, branch, filename = "fix.txt") {
  // Commit inside the worktree so we don't disturb main's checkout state.
  const existing = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  }).trim();
  fs.writeFileSync(path.join(worktreePath, filename), "fix\n", "utf-8");
  execFileSync("git", ["-C", worktreePath, "add", filename], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "commit", "-m", "fix"], { encoding: "utf-8", stdio: "pipe" });
  const newHead = execFileSync("git", ["-C", worktreePath, "rev-parse", `refs/heads/${branch}`], {
    encoding: "utf-8",
  }).trim();
  assert.notEqual(newHead, existing);
  return newHead;
}

function writeGhPrBodyScript(body) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-gh-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (
  args[0] === "pr"
  && args[1] === "view"
  && args.includes("--json")
  && args.includes("body")
  && args.includes("-q")
  && args[args.indexOf("-q") + 1] === ".body"
) {
  process.stdout.write(${JSON.stringify(body)});
  process.exit(0);
}
console.error("unexpected gh args: " + args.join(" "));
process.exit(2);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
  };
}

test("changes_requested -> review_pending succeeds after a fresh commit", () => {
  const { repoRoot, manifestPath, runId, worktreePath, branch, initialHead } = setupRepo({ state: STATES.CHANGES_REQUESTED });
  const newHead = addCommitOnBranch(worktreePath, branch);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "external commit pushed directly",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.REVIEW_PENDING);
  assert.equal(result.previousState, STATES.CHANGES_REQUESTED);
  assert.equal(result.nextAction, "run_review");
  assert.equal(result.freshCommit.currentHead, newHead);
  assert.equal(result.freshCommit.lastReviewedSha, initialHead);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.next_action, "run_review");
  assert.equal(manifest.review.last_reviewed_sha, initialHead, "recovery must NOT auto-reset last_reviewed_sha");

  const events = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8");
  assert.match(events, /"event":"state_recovery"/);
  assert.match(events, new RegExp(`"state_from":"${STATES.CHANGES_REQUESTED}"`));
  assert.match(events, new RegExp(`"state_to":"${STATES.REVIEW_PENDING}"`));
  assert.match(events, new RegExp(`"head_sha":"${newHead}"`));
  assert.match(events, new RegExp(`"last_reviewed_sha":"${initialHead}"`));
});

test("changes_requested -> review_pending fails when HEAD equals last_reviewed_sha", () => {
  const { repoRoot, runId } = setupRepo({ state: STATES.CHANGES_REQUESTED });
  // No fresh commit added.

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "trying without a fresh commit",
    "--json",
  ], { encoding: "utf-8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /equals review\.last_reviewed_sha/);
  assert.match(result.stderr, /Push the fix commit first/);
});

test("changes_requested -> review_pending supports audited same-HEAD PR-body-only recovery", () => {
  const { repoRoot, manifestPath, runId, runDir, initialHead } = setupRepo({
    state: STATES.CHANGES_REQUESTED,
    prNumber: 334,
  });
  fs.writeFileSync(path.join(runDir, "review-round-1-pr-body.md"), "missing metadata\n", "utf-8");
  const env = { ...process.env, ...writeGhPrBodyScript("fixed metadata\n") };

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "PR body metadata fixed with gh pr edit",
    "--allow-same-head",
    "--require-pr-body-change",
    "--json",
  ], { encoding: "utf-8", env });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.REVIEW_PENDING);
  assert.equal(result.previousState, STATES.CHANGES_REQUESTED);
  assert.equal(result.nextAction, "run_review");
  assert.equal(result.freshCommit, null);
  assert.equal(result.prBodyOnly.prBodyOnly, true);
  assert.equal(result.prBodyOnly.currentHead, initialHead);
  assert.equal(result.prBodyOnly.lastReviewedSha, initialHead);
  assert.equal(result.prBodyOnly.prNumber, 334);
  assert.equal(path.basename(result.prBodyOnly.previousSnapshotPath), "review-round-1-pr-body.md");

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.next_action, "run_review");
  assert.equal(manifest.review.last_reviewed_sha, initialHead, "recovery must NOT auto-reset last_reviewed_sha");

  const event = readRunEvents(repoRoot, runId).find((entry) => entry.event === "state_recovery");
  assert.equal(event?.head_sha, initialHead);
  assert.equal(event?.last_reviewed_sha, initialHead);
  assert.equal(event?.pr_body_only, true);
  assert.equal(event?.pr_number, 334);
  assert.equal(event?.reason, "PR body metadata fixed with gh pr edit");
});

test("same-HEAD PR-body-only recovery requires a PR number", () => {
  const { repoRoot, runId, runDir } = setupRepo({ state: STATES.CHANGES_REQUESTED });
  fs.writeFileSync(path.join(runDir, "review-round-1-pr-body.md"), "missing metadata\n", "utf-8");
  const env = { ...process.env, ...writeGhPrBodyScript("fixed metadata\n") };

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "PR body metadata fixed",
    "--allow-same-head",
    "--require-pr-body-change",
    "--json",
  ], { encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest has no PR number/);
});

test("same-HEAD PR-body-only recovery accepts github.pr_number fallback", () => {
  const { repoRoot, runId, runDir } = setupRepo({
    state: STATES.CHANGES_REQUESTED,
    githubPrNumber: 335,
  });
  fs.writeFileSync(path.join(runDir, "review-round-1-pr-body.md"), "missing metadata\n", "utf-8");
  const env = { ...process.env, ...writeGhPrBodyScript("fixed metadata\n") };

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "PR body metadata fixed",
    "--allow-same-head",
    "--require-pr-body-change",
    "--dry-run",
    "--json",
  ], { encoding: "utf-8", env });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.REVIEW_PENDING);
  assert.equal(result.dryRun, true);
  assert.equal(result.prBodyOnly.prNumber, 335);
});

test("same-HEAD PR-body-only recovery requires a prior PR body snapshot", () => {
  const { repoRoot, runId } = setupRepo({
    state: STATES.CHANGES_REQUESTED,
    prNumber: 334,
  });
  const env = { ...process.env, ...writeGhPrBodyScript("fixed metadata\n") };

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "PR body metadata fixed",
    "--allow-same-head",
    "--require-pr-body-change",
    "--json",
  ], { encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no prior PR body snapshot/);
});

test("same-HEAD PR-body-only recovery compares the latest numbered PR body snapshot", () => {
  const { repoRoot, runId, runDir } = setupRepo({
    state: STATES.CHANGES_REQUESTED,
    prNumber: 334,
  });
  fs.writeFileSync(path.join(runDir, "review-round-1-pr-body.md"), "old metadata\n", "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-pr-body.md"), "fixed metadata\n", "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-10-pr-body.md"), "latest metadata\n", "utf-8");
  const env = { ...process.env, ...writeGhPrBodyScript("latest metadata\n") };

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "PR body metadata fixed",
    "--allow-same-head",
    "--require-pr-body-change",
    "--json",
  ], { encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /matches latest prior PR body snapshot review-round-10-pr-body\.md/);
});

test("same-HEAD PR-body-only recovery requires both explicit opt-in flags", () => {
  const { repoRoot, runId, runDir } = setupRepo({
    state: STATES.CHANGES_REQUESTED,
    prNumber: 334,
  });
  fs.writeFileSync(path.join(runDir, "review-round-1-pr-body.md"), "missing metadata\n", "utf-8");
  const env = { ...process.env, ...writeGhPrBodyScript("fixed metadata\n") };

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "PR body metadata fixed",
    "--allow-same-head",
    "--json",
  ], { encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be passed together/);
});

test("escalated -> review_pending requires --force; succeeds with --force", () => {
  const { repoRoot, runId, manifestPath } = setupRepo({ state: STATES.ESCALATED });

  const refused = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "external-commit landed outside dispatch",
    "--json",
  ], { encoding: "utf-8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires --force/);

  const accepted = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "external-commit landed outside dispatch",
    "--force",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(accepted);
  assert.equal(result.state, STATES.REVIEW_PENDING);
  assert.equal(result.force, true);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
});

test("unlisted transition (dispatched -> merged) rejected with allowed set listed", () => {
  const { repoRoot, runId } = setupRepo({ state: STATES.DISPATCHED });

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.MERGED,
    "--reason", "trying to sneak through",
    "--json",
  ], { encoding: "utf-8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`Recovery transition '${STATES.DISPATCHED} -> ${STATES.MERGED}' is not whitelisted`));
  assert.match(result.stderr, /Allowed: /);
  // All four whitelisted transitions must appear in the allowed list.
  assert.match(result.stderr, new RegExp(`${STATES.CHANGES_REQUESTED} -> ${STATES.REVIEW_PENDING}`));
  assert.match(result.stderr, new RegExp(`${STATES.ESCALATED} -> ${STATES.REVIEW_PENDING}`));
  assert.match(result.stderr, new RegExp(`${STATES.ESCALATED} -> ${STATES.CHANGES_REQUESTED}`));
  assert.match(result.stderr, new RegExp(`${STATES.DISPATCHED} -> ${STATES.CHANGES_REQUESTED}`));
});

test("--reason is required", () => {
  const { repoRoot, runId } = setupRepo({ state: STATES.ESCALATED });

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.CHANGES_REQUESTED,
    "--json",
  ], { encoding: "utf-8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--reason <text> is required/);
});

test("escalated -> changes_requested succeeds without --force (alias for 'go back')", () => {
  const { repoRoot, runId, manifestPath } = setupRepo({ state: STATES.ESCALATED });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.CHANGES_REQUESTED,
    "--reason", "no-op dispatch escalated; returning to changes_requested for re-dispatch",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.CHANGES_REQUESTED);
  assert.equal(result.nextAction, "await_redispatch");

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.CHANGES_REQUESTED);
});
