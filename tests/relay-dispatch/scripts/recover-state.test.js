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
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { validateManifestPaths } = require("../../../skills/relay-dispatch/scripts/manifest/paths");
const { readRunEvents } = require("../../../skills/relay-dispatch/scripts/relay-events");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "recover-state.js");

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
  } else if (state === STATES.READY_TO_MERGE) {
    manifest.review = { ...manifest.review, latest_verdict: "lgtm" };
    manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  } else if (state === STATES.MERGE_BLOCKED) {
    manifest.review = { ...manifest.review, latest_verdict: "lgtm" };
    manifest.git = { ...manifest.git, head_sha: initialHead };
    manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
    manifest = updateManifestState(manifest, STATES.MERGE_BLOCKED, "resolve_merge_block");
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

function createLinkedCheckout(repoRoot, prefix = "krill-recover-linked-") {
  const linkedPath = path.join(
    os.tmpdir(),
    `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  execFileSync("git", ["worktree", "add", "--detach", linkedPath, "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  assert.notEqual(path.basename(linkedPath), path.basename(repoRoot));
  return linkedPath;
}

function restampManifestWorktree({ repoRoot, manifestPath, worktreePath }) {
  const record = readManifest(manifestPath);
  const updated = {
    ...record.data,
    paths: {
      ...(record.data.paths || {}),
      worktree: worktreePath,
    },
  };
  writeManifest(manifestPath, updated, record.body);
  return updated;
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

function writeGhPrHeadScript(headRefOid, { number = 334, headRefName = "issue-211" } = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-gh-head-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    number: ${JSON.stringify(number)},
    headRefName: ${JSON.stringify(headRefName)},
    headRefOid: ${JSON.stringify(headRefOid)}
  }));
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

test("recover-state --manifest from linked cwd preserves equivalent recorded repo_root and worktree bytes (#857)", () => {
  const { repoRoot, manifestPath, runId, worktreePath, branch } = setupRepo({ state: STATES.ESCALATED });
  const linkedPath = createLinkedCheckout(repoRoot);
  execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  const relayNamedWorktree = path.join(
    process.env.RELAY_HOME,
    "worktrees",
    "issue-857",
    path.basename(linkedPath)
  );
  fs.mkdirSync(path.dirname(relayNamedWorktree), { recursive: true });
  execFileSync("git", ["worktree", "add", relayNamedWorktree, branch], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  restampManifestWorktree({ repoRoot, manifestPath, worktreePath: relayNamedWorktree });
  const before = readManifest(manifestPath).data;
  const recordedRepoRoot = before.paths.repo_root;
  const recordedWorktree = before.paths.worktree;

  const validated = validateManifestPaths(before.paths, {
    expectedRepoRoot: linkedPath,
    manifestPath,
    runId,
    caller: "review-runner-style #857 regression",
  });
  assert.equal(validated.repoRoot, path.resolve(linkedPath));
  assert.equal(path.basename(validated.worktree), path.basename(linkedPath));

  const stdout = execFileSync("node", [
    SCRIPT,
    "--manifest", manifestPath,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "operator recovered from linked checkout without restamping paths",
    "--force",
    "--json",
  ], {
    cwd: linkedPath,
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: process.env.RELAY_HOME },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.previousState, STATES.ESCALATED);
  assert.equal(result.state, STATES.REVIEW_PENDING);

  const afterText = fs.readFileSync(manifestPath, "utf-8");
  assert.ok(afterText.includes(`repo_root: '${recordedRepoRoot}'`));
  assert.ok(afterText.includes(`worktree: '${recordedWorktree}'`));
  const after = readManifest(manifestPath).data;
  assert.equal(after.paths.repo_root, recordedRepoRoot);
  assert.equal(after.paths.worktree, recordedWorktree);

  const event = readRunEvents(recordedRepoRoot, runId).find((entry) => entry.event === "state_recovery");
  assert.equal(event?.state_from, STATES.ESCALATED);
  assert.equal(event?.state_to, STATES.REVIEW_PENDING);
  assert.equal(event?.reason, "operator recovered from linked checkout without restamping paths");
});

test("recover-state with identical canonical root leaves recorded paths unchanged (#857)", () => {
  const { repoRoot, manifestPath, runId } = setupRepo({ state: STATES.ESCALATED });
  const before = readManifest(manifestPath).data;

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "canonical root recovery should not restamp paths",
    "--force",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.REVIEW_PENDING);
  const after = readManifest(manifestPath).data;
  assert.equal(after.paths.repo_root, before.paths.repo_root);
  assert.equal(after.paths.worktree, before.paths.worktree);
});

test("recover-state rejects non-equivalent repo roots without writing manifest paths (#857)", () => {
  const { repoRoot, manifestPath, runId } = setupRepo({ state: STATES.ESCALATED });
  const before = readManifest(manifestPath).data;
  const unrelatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recover-unrelated-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: unrelatedRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Recover Unrelated"], { cwd: unrelatedRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-recover-unrelated@example.com"], { cwd: unrelatedRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(unrelatedRoot, "README.md"), "unrelated\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: unrelatedRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: unrelatedRoot, encoding: "utf-8", stdio: "pipe" });

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", unrelatedRoot,
    "--manifest", manifestPath,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "must reject unrelated repo root",
    "--force",
    "--json",
  ], { encoding: "utf-8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest paths\.repo_root/);
  const after = readManifest(manifestPath).data;
  assert.equal(after.state, before.state);
  assert.equal(after.paths.repo_root, before.paths.repo_root);
  assert.equal(after.paths.worktree, before.paths.worktree);
});

test("ready_to_merge -> review_pending succeeds when live PR HEAD drift is objective evidence", () => {
  const { repoRoot, manifestPath, runId, worktreePath, branch, initialHead } = setupRepo({
    state: STATES.READY_TO_MERGE,
    prNumber: 334,
  });
  const liveHead = addCommitOnBranch(worktreePath, branch, "ready-drift.txt");
  const env = { ...process.env, ...writeGhPrHeadScript(liveHead, { number: 334 }) };

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "PR head advanced after passing review",
    "--json",
  ], { encoding: "utf-8", env });

  const result = JSON.parse(stdout);
  assert.equal(result.previousState, STATES.READY_TO_MERGE);
  assert.equal(result.state, STATES.REVIEW_PENDING);
  assert.equal(result.nextAction, "run_review");
  assert.equal(result.readyHeadDrift.prNumber, 334);
  assert.equal(result.readyHeadDrift.oldSha, initialHead);
  assert.equal(result.readyHeadDrift.newSha, liveHead);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.next_action, "run_review");
  assert.equal(manifest.git.head_sha, liveHead);
  assert.equal(manifest.review.last_reviewed_sha, initialHead);

  const event = readRunEvents(repoRoot, runId).find((entry) => entry.event === "state_recovery");
  assert.equal(event?.state_from, STATES.READY_TO_MERGE);
  assert.equal(event?.state_to, STATES.REVIEW_PENDING);
  assert.equal(event?.pr_number, 334);
  assert.equal(event?.previous_head_sha, initialHead);
  assert.equal(event?.new_head_sha, liveHead);
  assert.equal(event?.head_sha, liveHead);
  assert.equal(event?.last_reviewed_sha, initialHead);
  assert.equal(event?.reason, "PR head advanced after passing review");
});

test("ready_to_merge -> review_pending fails when retained worktree is not at live PR HEAD", () => {
  const { repoRoot, runId, initialHead } = setupRepo({
    state: STATES.READY_TO_MERGE,
    prNumber: 334,
  });
  const liveHead = "def4567890abcdefdef4567890abcdefdef45678";
  const env = { ...process.env, ...writeGhPrHeadScript(liveHead, { number: 334 }) };

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "PR head advanced remotely after passing review",
    "--json",
  ], { encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /retained worktree HEAD/);
  assert.match(result.stderr, new RegExp(initialHead));
  assert.match(result.stderr, new RegExp(liveHead));
  assert.match(result.stderr, /fetch origin issue-211/);
  assert.match(result.stderr, /reset --hard/);
});

test("ready_to_merge -> review_pending fails when live PR HEAD has not drifted", () => {
  const { repoRoot, runId, initialHead } = setupRepo({
    state: STATES.READY_TO_MERGE,
    prNumber: 334,
  });
  const env = { ...process.env, ...writeGhPrHeadScript(initialHead, { number: 334 }) };

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "retry review without objective drift",
    "--json",
  ], { encoding: "utf-8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing stale-ready recovery/);
  assert.match(result.stderr, /equals review\.last_reviewed_sha/);
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

test("merge_blocked -> ready_to_merge succeeds with audited reason and no --force", () => {
  const { repoRoot, manifestPath, runId, initialHead } = setupRepo({ state: STATES.MERGE_BLOCKED });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.READY_TO_MERGE,
    "--reason", "fresh-review gate unblocked; retry merge",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.previousState, STATES.MERGE_BLOCKED);
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.nextAction, "await_explicit_merge");
  assert.equal(result.force, false);
  assert.equal(result.freshCommit, null);
  assert.equal(result.prBodyOnly, null);
  assert.equal(result.readyHeadDrift, null);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.next_action, "await_explicit_merge");

  const event = readRunEvents(repoRoot, runId).find((entry) => entry.event === "state_recovery");
  assert.equal(event?.state_from, STATES.MERGE_BLOCKED);
  assert.equal(event?.state_to, STATES.READY_TO_MERGE);
  assert.equal(event?.head_sha, initialHead);
  assert.equal(event?.last_reviewed_sha, initialHead);
  assert.equal(event?.reason, "fresh-review gate unblocked; retry merge");
});

test("merge_blocked -> ready_to_merge requires an audited reason", () => {
  const { repoRoot, runId } = setupRepo({ state: STATES.MERGE_BLOCKED });

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.READY_TO_MERGE,
    "--json",
  ], { encoding: "utf-8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--reason <text> is required/);
});

test("non-merge_blocked -> ready_to_merge is rejected without changing manifest state", () => {
  const { repoRoot, manifestPath, runId } = setupRepo({ state: STATES.CHANGES_REQUESTED });

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.READY_TO_MERGE,
    "--reason", "invalid ready recovery source",
    "--json",
  ], { encoding: "utf-8" });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(`Recovery transition '${STATES.CHANGES_REQUESTED} -> ${STATES.READY_TO_MERGE}' is not whitelisted`)
  );
  assert.equal(readManifest(manifestPath).data.state, STATES.CHANGES_REQUESTED);
});

test("merge_blocked -> another target is rejected without changing manifest state", () => {
  const { repoRoot, manifestPath, runId } = setupRepo({ state: STATES.MERGE_BLOCKED });

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "invalid merge-blocked recovery target",
    "--json",
  ], { encoding: "utf-8" });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(`Recovery transition '${STATES.MERGE_BLOCKED} -> ${STATES.REVIEW_PENDING}' is not whitelisted`)
  );
  assert.equal(readManifest(manifestPath).data.state, STATES.MERGE_BLOCKED);
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
  const allowed = [
    `${STATES.CHANGES_REQUESTED} -> ${STATES.REVIEW_PENDING}`,
    `${STATES.READY_TO_MERGE} -> ${STATES.REVIEW_PENDING}`,
    `${STATES.ESCALATED} -> ${STATES.REVIEW_PENDING}`,
    `${STATES.ESCALATED} -> ${STATES.CHANGES_REQUESTED}`,
    `${STATES.DISPATCHED} -> ${STATES.CHANGES_REQUESTED}`,
    `${STATES.MERGE_BLOCKED} -> ${STATES.READY_TO_MERGE}`,
  ].join(", ");
  assert.ok(result.stderr.includes(`Allowed: ${allowed}.`), result.stderr);
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

test("dispatched -> changes_requested succeeds when the manifest worktree path no longer exists", () => {
  const { repoRoot, runId, manifestPath, worktreePath } = setupRepo({ state: STATES.DISPATCHED });
  execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.CHANGES_REQUESTED,
    "--reason", "dispatch hung; executor killed externally",
    "--force",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.previousState, STATES.DISPATCHED);
  assert.equal(result.state, STATES.CHANGES_REQUESTED);
  assert.equal(result.nextAction, "await_redispatch");

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.CHANGES_REQUESTED);

  const event = readRunEvents(repoRoot, runId).find((entry) => entry.event === "state_recovery");
  assert.equal(event?.state_from, STATES.DISPATCHED);
  assert.equal(event?.state_to, STATES.CHANGES_REQUESTED);
  assert.equal(event?.worktree_missing, true);
  assert.equal(event?.reason, "dispatch hung; executor killed externally");
});
