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
  readManifest,
  updateManifestState,
  writeManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");

const SCRIPT = path.join(__dirname, "finalize-run.js");

function setupRepo({ dirtyWorktree = false } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-finalize-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Merge Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-merge@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const branch = "issue-42";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(worktreePath, "smoke.txt"), "ok\n", "utf-8");
  execFileSync("git", ["-C", worktreePath, "add", "smoke.txt"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "commit", "-m", "Add smoke"], { encoding: "utf-8", stdio: "pipe" });
  const headSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();

  if (dirtyWorktree) {
    fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "leftover\n", "utf-8");
  }

  const runId = createRunId({
    branch,
    timestamp: new Date("2026-04-03T07:00:00.000Z"),
  });
  const manifestPath = ensureRunLayout(repoRoot, runId).manifestPath;
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 42,
    worktreePath,
    orchestrator: "codex",
    worker: "codex",
    reviewer: "codex",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  manifest.git.head_sha = headSha;
  manifest.review.last_reviewed_sha = headSha;
  manifest.review.latest_verdict = "lgtm";
  manifest.review.rounds = 1;
  writeManifest(manifestPath, manifest);

  return { repoRoot, manifestPath, branch, worktreePath, headSha };
}

function branchExists(repoRoot, branch) {
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", `refs/heads/${branch}`], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function writeFakeGh(logPath, { headRefName = "issue-42", comments = [], commits = [] } = {}) {
  const ghPath = path.join(path.dirname(logPath), "fake-gh.js");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n", "utf-8");
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    headRefName: ${JSON.stringify(headRefName)},
    comments: ${JSON.stringify(comments)},
    commits: ${JSON.stringify(commits)}
  }));
}
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return ghPath;
}

test("finalize-run merges and cleans a ready run", () => {
  const { repoRoot, manifestPath, branch, worktreePath, headSha } = setupRepo();
  const logPath = path.join(repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [
      {
        oid: headSha,
        committedDate: "2026-04-03T08:00:00Z",
      },
    ],
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", branch,
    "--pr", "123",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_GH_BIN: fakeGh },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.mergePerformed, true);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.nextAction, "done");
  assert.equal(result.cleanup.cleanupStatus, "succeeded");
  assert.equal(result.cleanup.worktreeRemoved, true);
  assert.equal(result.cleanup.branchDeleted, true);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(branchExists(repoRoot, branch), false);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.MERGED);
  assert.equal(manifest.next_action, "done");
  assert.equal(manifest.cleanup.status, "succeeded");
  assert.equal(manifest.cleanup.worktree_removed, true);
  assert.equal(manifest.cleanup.branch_deleted, true);

  const ghLog = fs.readFileSync(logPath, "utf-8");
  assert.match(ghLog, /pr view 123 --json comments,commits/);
  assert.match(ghLog, /pr merge 123 --squash --delete-branch/);
  assert.match(ghLog, /issue close 42 --comment Resolved in PR #123/);
});

test("finalize-run preserves dirty worktrees and records manual cleanup follow-up", () => {
  const { repoRoot, manifestPath, branch, worktreePath, headSha } = setupRepo({ dirtyWorktree: true });
  const logPath = path.join(repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [
      {
        oid: headSha,
        committedDate: "2026-04-03T08:00:00Z",
      },
    ],
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", branch,
    "--pr", "123",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_GH_BIN: fakeGh },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.mergePerformed, true);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.nextAction, "manual_cleanup_required");
  assert.equal(result.cleanup.cleanupStatus, "failed");
  assert.match(result.cleanup.error, /dirty worktree/);
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(branchExists(repoRoot, branch), true);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.MERGED);
  assert.equal(manifest.next_action, "manual_cleanup_required");
  assert.equal(manifest.cleanup.status, "failed");
  assert.match(manifest.cleanup.error, /dirty worktree/);
});

test("finalize-run can derive the repo root from --manifest alone", () => {
  const { repoRoot, manifestPath, branch, worktreePath, headSha } = setupRepo();
  const logPath = path.join(repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [
      {
        oid: headSha,
        committedDate: "2026-04-03T08:00:00Z",
      },
    ],
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--manifest", manifestPath,
    "--pr", "123",
    "--json",
  ], {
    cwd: os.tmpdir(),
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_GH_BIN: fakeGh },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.branch, branch);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.nextAction, "done");
  assert.equal(fs.existsSync(worktreePath), false);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.cleanup.status, "succeeded");
});

test("finalize-run blocks merge when review is stale for current HEAD", () => {
  const { repoRoot, manifestPath, branch, worktreePath } = setupRepo();
  fs.writeFileSync(path.join(worktreePath, "followup.txt"), "new\n", "utf-8");
  execFileSync("git", ["-C", worktreePath, "add", "followup.txt"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "commit", "-m", "Follow-up"], { encoding: "utf-8", stdio: "pipe" });
  const newHeadSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();

  const logPath = path.join(repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [
      {
        oid: newHeadSha,
        committedDate: "2026-04-03T09:00:00Z",
      },
    ],
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", branch,
    "--pr", "123",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_GH_BIN: fakeGh },
  }), /Fresh review gate failed: stale/);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
});

test("finalize-run blocks merge when no relay review audit trail exists", () => {
  const { repoRoot, branch, headSha } = setupRepo();
  const logPath = path.join(repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    comments: [],
    commits: [
      {
        oid: headSha,
        committedDate: "2026-04-03T08:00:00Z",
      },
    ],
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", branch,
    "--pr", "123",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_GH_BIN: fakeGh },
  }), /Fresh review gate failed: missing/);
});

test("finalize-run accepts an explicit skip-review reason", () => {
  const { repoRoot, branch, headSha } = setupRepo();
  const logPath = path.join(repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    comments: [],
    commits: [
      {
        oid: headSha,
        committedDate: "2026-04-03T08:00:00Z",
      },
    ],
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", branch,
    "--pr", "123",
    "--skip-review", "hotfix",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_GH_BIN: fakeGh },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.reviewGate.status, "skipped");

  const ghLog = fs.readFileSync(logPath, "utf-8");
  assert.match(ghLog, /pr comment 123 --body/);
});
