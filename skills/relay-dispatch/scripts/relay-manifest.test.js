const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CLEANUP_STATUSES,
  STATES,
  captureAttempt,
  collectEnvironmentSnapshot,
  compareEnvironmentSnapshot,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  formatAttemptsForPrompt,
  getRepoSlug,
  inferIssueNumber,
  readManifest,
  readPreviousAttempts,
  updateManifestCleanup,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");

function initGitRepo(repoRoot, actor = "Relay Test") {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", actor], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay@example.com"], { cwd: repoRoot, stdio: "pipe" });
}

function withGitIdentityDisabled(testFn) {
  const previousEnv = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-isolated-"));
  const isolatedXdg = fs.mkdtempSync(path.join(os.tmpdir(), "relay-xdg-isolated-"));

  process.env.HOME = isolatedHome;
  process.env.XDG_CONFIG_HOME = isolatedXdg;
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  try {
    testFn();
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");
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
    executor: "codex",
    reviewer: "claude",
  });

  writeManifest(manifestPath, manifest);
  const parsed = readManifest(manifestPath);

  assert.equal(parsed.data.run_id, runId);
  assert.equal(parsed.data.state, STATES.DRAFT);
  assert.equal(parsed.data.actor.name, "Relay Maintainer");
  assert.equal(parsed.data.issue.number, 42);
  assert.equal(parsed.data.roles.reviewer, "claude");
  assert.equal(parsed.data.git.head_sha, null);
  assert.equal(parsed.data.review.last_reviewed_sha, null);
  assert.equal(parsed.data.cleanup.status, CLEANUP_STATUSES.PENDING);
  assert.match(parsed.body, /# Notes/);
});

test("manifest round-trips multiline scalar values", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-multiline-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = "issue-42-20260402103001";
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
    executor: "codex",
    reviewer: "claude",
  });
  manifest.cleanup.error = "dirty worktree: M README.md\n?? docs/direct-read-relay-operator-note.md";

  writeManifest(manifestPath, manifest);
  const parsed = readManifest(manifestPath);

  assert.equal(
    parsed.data.cleanup.error,
    "dirty worktree: M README.md\n?? docs/direct-read-relay-operator-note.md"
  );
});

test("createManifestSkeleton falls back to unknown actor when git user.name is unavailable", () => {
  withGitIdentityDisabled(() => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-actor-missing-"));
    const manifest = createManifestSkeleton({
      repoRoot,
      runId: "issue-42-20260402103002",
      branch: "issue-42",
      baseBranch: "main",
      issueNumber: 42,
      worktreePath: path.join(repoRoot, "wt"),
      orchestrator: "codex",
      executor: "codex",
      reviewer: "claude",
    });

    assert.deepEqual(manifest.actor, { name: "unknown" });
  });
});

test("createManifestSkeleton stores optional intake linkage without changing state semantics", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-intake-linkage-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");

  const manifest = createManifestSkeleton({
    repoRoot,
    runId: "issue-42-20260402103003",
    branch: "issue-42",
    baseBranch: "main",
    issueNumber: 42,
    worktreePath: path.join(repoRoot, "wt"),
    orchestrator: "codex",
    executor: "codex",
    reviewer: "claude",
    requestId: "req-20260409000000000",
    leafId: "leaf-01",
    doneCriteriaPath: "/tmp/frozen-done-criteria.md",
    doneCriteriaSource: "request_snapshot",
  });

  assert.equal(manifest.state, STATES.DRAFT);
  assert.equal(manifest.source.request_id, "req-20260409000000000");
  assert.equal(manifest.source.leaf_id, "leaf-01");
  assert.equal(manifest.anchor.done_criteria_path, "/tmp/frozen-done-criteria.md");
  assert.equal(manifest.anchor.done_criteria_source, "request_snapshot");
});

test("readManifest migrates v1 roles.worker to roles.executor", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-migrate-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = "migrate-v1-20260402103000";
  const wtPath = path.join(tmpRoot, "wt");
  const { manifestPath } = ensureRunLayout(tmpRoot, runId);
  const manifest = createManifestSkeleton({
    repoRoot: tmpRoot,
    runId,
    branch: "migrate-v1",
    baseBranch: "main",
    issueNumber: 99,
    worktreePath: wtPath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "claude",
  });
  // Simulate a v1 manifest: rename executor back to worker
  manifest.roles.worker = manifest.roles.executor;
  delete manifest.roles.executor;
  writeManifest(manifestPath, manifest);

  const parsed = readManifest(manifestPath);
  assert.equal(parsed.data.roles.executor, "codex");
  assert.equal(parsed.data.roles.worker, undefined);
});

test("getRepoSlug is deterministic and collision-resistant", () => {
  const slug1 = getRepoSlug("/Users/dev/my-project");
  const slug2 = getRepoSlug("/Users/dev/my-project");
  assert.equal(slug1, slug2);

  const slug3 = getRepoSlug("/Users/other/my-project");
  assert.notEqual(slug1, slug3);
  assert.match(slug1, /^my-project-[a-f0-9]{8}$/);
  assert.match(slug3, /^my-project-[a-f0-9]{8}$/);

  assert.throws(() => getRepoSlug(null), /non-empty repoRoot/);
  assert.throws(() => getRepoSlug(""), /non-empty repoRoot/);
  assert.throws(() => getRepoSlug(undefined), /non-empty repoRoot/);
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

  const closed = updateManifestState(manifest, STATES.CLOSED, "done");
  assert.equal(closed.state, STATES.CLOSED);

  assert.throws(
    () => updateManifestState(dispatched, STATES.MERGED, "done"),
    /Invalid relay state transition/
  );
});

test("updateManifestCleanup records cleanup metadata without changing state", () => {
  const manifest = {
    state: STATES.MERGED,
    next_action: "manual_cleanup_required",
    cleanup: {
      status: CLEANUP_STATUSES.PENDING,
      last_attempted_at: null,
      cleaned_at: null,
      worktree_removed: false,
      branch_deleted: false,
      prune_ran: false,
      error: null,
    },
    timestamps: { created_at: "2026-04-02T10:30:00Z", updated_at: "2026-04-02T10:30:00Z" },
  };

  const updated = updateManifestCleanup(manifest, {
    status: CLEANUP_STATUSES.SUCCEEDED,
    last_attempted_at: "2026-04-03T00:00:00Z",
    cleaned_at: "2026-04-03T00:00:00Z",
    worktree_removed: true,
    branch_deleted: true,
    prune_ran: true,
  }, "done");

  assert.equal(updated.state, STATES.MERGED);
  assert.equal(updated.next_action, "done");
  assert.equal(updated.cleanup.status, CLEANUP_STATUSES.SUCCEEDED);
  assert.equal(updated.cleanup.worktree_removed, true);
  assert.equal(updated.cleanup.branch_deleted, true);
});

test("readPreviousAttempts returns [] on corrupted JSON", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-corrupt-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = "issue-corrupt-20260403120000000";

  // Write a valid attempt to create the file at the correct path
  captureAttempt(repoRoot, runId, { score_log: "test" });
  assert.equal(readPreviousAttempts(repoRoot, runId).length, 1);

  // Find and corrupt the previous-attempts.json file
  const findFile = (dir, name) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const r = findFile(full, name); if (r) return r; }
      if (entry.name === name) return full;
    }
    return null;
  };
  const attemptsFile = findFile(process.env.RELAY_HOME, "previous-attempts.json");
  fs.writeFileSync(attemptsFile, "{broken json[", "utf-8");

  const result = readPreviousAttempts(repoRoot, runId);
  assert.deepEqual(result, []);
});

test("captureAttempt writes and readPreviousAttempts reads correctly", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-attempts-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = "issue-42-20260403120000000";
  ensureRunLayout(repoRoot, runId);

  assert.deepEqual(readPreviousAttempts(repoRoot, runId), []);

  const first = captureAttempt(repoRoot, runId, {
    score_log: "| Factor | Target | Final |\n| Perf | < 0.2s | 0.35s |",
    reviewer_feedback: "Timeout middleware missing on /api/orders",
    failed_approaches: ["Fixed-delay retry", "Skipping /api/orders timeout"],
  });
  assert.equal(first.dispatch_number, 1);
  assert.ok(first.timestamp);

  const second = captureAttempt(repoRoot, runId, {
    score_log: "| Factor | Target | Final |\n| Perf | < 0.2s | 0.18s |",
    reviewer_feedback: "Retry still uses fixed delay",
    failed_approaches: ["Fixed-delay retry"],
  });
  assert.equal(second.dispatch_number, 2);

  const attempts = readPreviousAttempts(repoRoot, runId);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].dispatch_number, 1);
  assert.equal(attempts[1].dispatch_number, 2);
  assert.match(attempts[0].score_log, /0\.35s/);
});

test("captureAttempt validates inputs", () => {
  assert.throws(() => captureAttempt("/tmp", null, {}), /run_id is required/);
  assert.throws(() => captureAttempt("/tmp", "run-1", null), /attemptData must be an object/);
  assert.throws(() => captureAttempt("/tmp", "run-1", "string"), /attemptData must be an object/);
});

test("formatAttemptsForPrompt returns empty string for no attempts", () => {
  assert.equal(formatAttemptsForPrompt([]), "");
  assert.equal(formatAttemptsForPrompt(null), "");
});

test("formatAttemptsForPrompt formats attempts correctly", () => {
  const attempts = [
    {
      dispatch_number: 1,
      score_log: "| Factor | Target | Final |\n| Perf | < 0.2s | 0.35s |",
      reviewer_feedback: "Timeout middleware missing",
      failed_approaches: ["Fixed-delay retry", "Skipping timeout"],
    },
  ];
  const result = formatAttemptsForPrompt(attempts);
  assert.match(result, /## Previous Attempt \(dispatch #1\)/);
  assert.match(result, /### Score Log/);
  assert.match(result, /0\.35s/);
  assert.match(result, /### Reviewer Feedback/);
  assert.match(result, /Timeout middleware missing/);
  assert.match(result, /### Do NOT Repeat/);
  assert.match(result, /- Fixed-delay retry/);
  assert.match(result, /- Skipping timeout/);
});

test("collectEnvironmentSnapshot returns expected shape", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-env-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "x\n");
  execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });

  const snapshot = collectEnvironmentSnapshot(repoRoot, "main");

  assert.equal(snapshot.node_version, process.version);
  assert.equal(typeof snapshot.dispatch_ts, "string");
  assert.ok(snapshot.dispatch_ts.endsWith("Z"));
  assert.equal(snapshot.main_sha, null);
  assert.equal(snapshot.lockfile_hash, null);
});

test("collectEnvironmentSnapshot hashes lockfile when present", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-env-lock-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "package-lock.json"), '{"lockfileVersion":3}\n');

  const snapshot = collectEnvironmentSnapshot(repoRoot, "main");

  assert.ok(snapshot.lockfile_hash);
  assert.match(snapshot.lockfile_hash, /^sha256:[a-f0-9]{64}$/);
});

test("compareEnvironmentSnapshot returns empty array for identical snapshots", () => {
  const snapshot = {
    node_version: "v22.12.0",
    main_sha: "abc1234",
    lockfile_hash: "sha256:aaa",
    dispatch_ts: "2026-04-06T04:00:00.000Z",
  };
  const drift = compareEnvironmentSnapshot(snapshot, { ...snapshot });
  assert.deepEqual(drift, []);
});

test("compareEnvironmentSnapshot detects field changes", () => {
  const baseline = {
    node_version: "v22.12.0",
    main_sha: "abc1234",
    lockfile_hash: "sha256:aaa",
    dispatch_ts: "2026-04-06T04:00:00.000Z",
  };
  const current = {
    node_version: "v22.12.0",
    main_sha: "def5678",
    lockfile_hash: "sha256:bbb",
    dispatch_ts: "2026-04-06T05:00:00.000Z",
  };
  const drift = compareEnvironmentSnapshot(baseline, current);
  assert.equal(drift.length, 2);
  assert.ok(drift.some(d => d.field === "main_sha" && d.from === "abc1234" && d.to === "def5678"));
  assert.ok(drift.some(d => d.field === "lockfile_hash" && d.from === "sha256:aaa" && d.to === "sha256:bbb"));
  assert.ok(!drift.some(d => d.field === "dispatch_ts"), "dispatch_ts must be excluded from drift");
});

test("compareEnvironmentSnapshot returns empty array when baseline is null", () => {
  const current = {
    node_version: "v22.12.0",
    main_sha: "abc1234",
    lockfile_hash: null,
    dispatch_ts: "2026-04-06T04:00:00.000Z",
  };
  assert.deepEqual(compareEnvironmentSnapshot(null, current), []);
  assert.deepEqual(compareEnvironmentSnapshot(undefined, current), []);
});

test("compareEnvironmentSnapshot skips fields that are null in both", () => {
  const baseline = { node_version: "v22.12.0", main_sha: null, lockfile_hash: null, dispatch_ts: "t1" };
  const current = { node_version: "v22.12.0", main_sha: null, lockfile_hash: null, dispatch_ts: "t2" };
  assert.deepEqual(compareEnvironmentSnapshot(baseline, current), []);
});

test("manifest round-trips with environment block", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-env-rt-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = "issue-96-20260406040000000";
  const { manifestPath } = ensureRunLayout(repoRoot, runId);
  const manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-96",
    baseBranch: "main",
    issueNumber: 96,
    worktreePath: path.join(repoRoot, "wt"),
    orchestrator: "claude",
    executor: "codex",
    reviewer: "claude",
    environment: {
      node_version: "v22.12.0",
      main_sha: "abc1234def5678",
      lockfile_hash: "sha256:aabbccdd",
      dispatch_ts: "2026-04-06T04:00:00.000Z",
    },
  });

  writeManifest(manifestPath, manifest);
  const parsed = readManifest(manifestPath);

  assert.equal(parsed.data.environment.node_version, "v22.12.0");
  assert.equal(parsed.data.environment.main_sha, "abc1234def5678");
  assert.equal(parsed.data.environment.lockfile_hash, "sha256:aabbccdd");
  assert.equal(parsed.data.environment.dispatch_ts, "2026-04-06T04:00:00.000Z");
});
