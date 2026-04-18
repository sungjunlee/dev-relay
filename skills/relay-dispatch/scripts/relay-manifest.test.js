const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
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
  getCanonicalRepoRoot,
  getManifestPath,
  getRubricAnchorStatus,
  getRepoSlug,
  getRunDir,
  inferIssueNumber,
  readManifest,
  readPreviousAttempts,
  updateManifestCleanup,
  updateManifestState,
  validateManifestPaths,
  validateRunId,
  writeManifest,
} = require("./relay-manifest");
const {
  createGrandfatheredRubricAnchor,
} = require("./test-support");

function initGitRepo(repoRoot, actor = "Relay Test") {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", actor], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay@example.com"], { cwd: repoRoot, stdio: "pipe" });
}

function createCommittedRepo(repoRoot, actor = "Relay Test") {
  initGitRepo(repoRoot, actor);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
}

function createRelayOwnedWorktree(repoRoot, branch = "issue-42") {
  const relayWorktrees = path.join(process.env.RELAY_HOME, "worktrees");
  fs.mkdirSync(relayWorktrees, { recursive: true });
  const worktreeParent = fs.mkdtempSync(path.join(relayWorktrees, "relay-owned-"));
  const worktreePath = path.join(worktreeParent, path.basename(repoRoot));
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  return worktreePath;
}

function createUnrelatedRelayOwnedWorktree(repoRoot, branch = "issue-42") {
  const attackerParent = fs.mkdtempSync(path.join(os.tmpdir(), "relay-foreign-repo-"));
  const attackerRoot = path.join(attackerParent, path.basename(repoRoot));
  fs.mkdirSync(attackerRoot, { recursive: true });
  createCommittedRepo(attackerRoot, "Relay Foreign");
  const worktreePath = createRelayOwnedWorktree(attackerRoot, branch);
  fs.writeFileSync(path.join(worktreePath, "sentinel.txt"), "foreign\n", "utf-8");
  return { attackerRoot, worktreePath };
}

function createMissingRelayOwnedWorktree(repoRoot) {
  const relayWorktrees = path.join(process.env.RELAY_HOME, "worktrees");
  fs.mkdirSync(relayWorktrees, { recursive: true });
  const worktreeParent = fs.mkdtempSync(path.join(relayWorktrees, "relay-missing-"));
  return path.join(worktreeParent, path.basename(repoRoot));
}

function writeRunRubric(repoRoot, runId, rubricPath = "rubric.yaml", content = "rubric:\n  factors:\n    - name: manifest\n") {
  const { runDir } = ensureRunLayout(repoRoot, runId);
  const fullPath = path.join(runDir, rubricPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
  return { runDir, fullPath };
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
  const originalRandomBytes = crypto.randomBytes;
  try {
    crypto.randomBytes = (size) => {
      assert.equal(size, 4);
      return Buffer.from("a1b2c3d4", "hex");
    };

    const runId = createRunId({
      branch: "Feature/Auth Flow",
      timestamp: new Date("2026-04-02T12:34:56Z"),
    });
    assert.equal(runId, "feature-auth-flow-20260402123456000-a1b2c3d4");
  } finally {
    crypto.randomBytes = originalRandomBytes;
  }
});

test("validateRunId accepts sampled historical relay run_ids", () => {
  const historicalRunIds = [
    "issue-114-20260408100846873",
    "issue-132-20260410150841243",
    "issue-138-20260412044608184",
    "issue-148-20260412072649097",
    "issue-156-20260412101412608",
    "issue-158-20260417080000000-a1b2c3d4",
  ];

  for (const runId of historicalRunIds) {
    const result = validateRunId(runId);
    assert.equal(result.valid, true, `${runId} should be accepted`);
    assert.equal(result.status, "valid");
    assert.equal(result.runId, runId);
    assert.equal(result.reason, null);
  }
});

test("validateRunId rejects unsafe and non-conforming values", () => {
  const cases = [
    {
      runId: null,
      status: "missing_run_id",
      pattern: /run_id must be set to a single path segment/,
    },
    {
      runId: "",
      status: "missing_run_id",
      pattern: /got ""/,
    },
    {
      runId: ".",
      status: "invalid_run_id",
      pattern: /may not be '\.' or '\.\.'/,
    },
    {
      runId: "..",
      status: "invalid_run_id",
      pattern: /may not be '\.' or '\.\.'/,
    },
    {
      runId: "../victim-run",
      status: "invalid_run_id",
      pattern: /may not contain '\.\.' segments/,
    },
    {
      runId: "issue-42/20260412000000000",
      status: "invalid_run_id",
      pattern: /may not contain '\/'/,
    },
    {
      runId: "issue-42\\20260412000000000",
      status: "invalid_run_id",
      pattern: /may not contain '\\\\'/,
    },
    {
      runId: "Issue-42-20260412000000000",
      status: "invalid_run_id",
      pattern: /shape emitted by createRunId/,
    },
  ];

  for (const entry of cases) {
    const result = validateRunId(entry.runId);
    assert.equal(result.valid, false, `${JSON.stringify(entry.runId)} should be rejected`);
    assert.equal(result.status, entry.status);
    assert.match(result.reason, entry.pattern);
    assert.match(result.reason, new RegExp(String.raw`${JSON.stringify(entry.runId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
});

test("getRunDir and getManifestPath reject invalid run_id before path derivation", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runid-paths-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot);

  assert.throws(
    () => getRunDir(repoRoot, "../victim-run"),
    /run_id must be a single path segment/
  );
  assert.throws(
    () => getManifestPath(repoRoot, "issue-42\\20260412000000000"),
    /run_id must be a single path segment/
  );
});

test("validateManifestPaths accepts repo-contained and relay-owned worktrees", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-paths-ok-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  createCommittedRepo(repoRoot, "Relay Paths");
  const runId = "issue-42-20260402103000500";
  const manifestPath = ensureRunLayout(repoRoot, runId).manifestPath;

  const repoContained = validateManifestPaths({
    repo_root: repoRoot,
    worktree: path.join(repoRoot, "wt", "issue-42"),
  }, {
    expectedRepoRoot: repoRoot,
    manifestPath,
    runId,
    caller: "relay-manifest.test repo-contained",
  });
  assert.equal(repoContained.repoRoot, path.resolve(repoRoot));
  assert.equal(repoContained.worktree, path.join(repoRoot, "wt", "issue-42"));
  assert.equal(repoContained.worktreeLocation, "repo_root");

  const relayOwnedWorktree = createRelayOwnedWorktree(repoRoot);
  const relayOwned = validateManifestPaths({
    repo_root: repoRoot,
    worktree: relayOwnedWorktree,
  }, {
    expectedRepoRoot: repoRoot,
    manifestPath,
    runId,
    caller: "relay-manifest.test relay-owned",
  });
  assert.equal(relayOwned.worktree, relayOwnedWorktree);
  assert.equal(relayOwned.worktreeLocation, "relay_worktree");

  const linkedRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-linked-root-"));
  execFileSync("git", ["worktree", "add", linkedRepoRoot, "-b", "issue-42-linked-root"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  const linkedManifestPath = ensureRunLayout(linkedRepoRoot, runId).manifestPath;
  const linkedRelayOwnedWorktree = createRelayOwnedWorktree(linkedRepoRoot, "issue-42-linked-relay");
  const linkedRelayOwned = validateManifestPaths({
    repo_root: linkedRepoRoot,
    worktree: linkedRelayOwnedWorktree,
  }, {
    expectedRepoRoot: linkedRepoRoot,
    manifestPath: linkedManifestPath,
    runId,
    caller: "relay-manifest.test linked relay-owned",
  });
  assert.equal(linkedRelayOwned.worktree, linkedRelayOwnedWorktree);
  assert.equal(linkedRelayOwned.worktreeLocation, "relay_worktree");
});

test("validateManifestPaths rejects mismatched repo roots, escaped worktrees, and manifest-path mismatches", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-paths-bad-"));
  const attackerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-paths-attacker-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  createCommittedRepo(repoRoot, "Relay Paths");
  createCommittedRepo(attackerRoot, "Relay Attacker");
  const runId = "issue-42-20260402103000600";
  const manifestPath = ensureRunLayout(repoRoot, runId).manifestPath;
  const missingRelayOwnedWorktree = createMissingRelayOwnedWorktree(repoRoot);

  assert.throws(() => validateManifestPaths({
    repo_root: attackerRoot,
    worktree: path.join(attackerRoot, "wt", "issue-42"),
  }, {
    expectedRepoRoot: repoRoot,
    manifestPath,
    runId,
    caller: "relay-manifest.test mismatched repo",
  }), /does not match the expected repo root/);

  assert.throws(() => validateManifestPaths({
    repo_root: repoRoot,
    worktree: attackerRoot,
  }, {
    expectedRepoRoot: repoRoot,
    manifestPath,
    runId,
    caller: "relay-manifest.test escaped worktree",
  }), /is not contained under the expected repo root/);

  assert.throws(() => validateManifestPaths({
    repo_root: repoRoot,
    worktree: missingRelayOwnedWorktree,
  }, {
    expectedRepoRoot: repoRoot,
    manifestPath,
    runId,
    caller: "relay-manifest.test missing relay-owned worktree",
  }), /is not contained under the expected repo root/);

  assert.throws(() => validateManifestPaths({
    repo_root: attackerRoot,
    worktree: path.join(attackerRoot, "wt", path.basename(attackerRoot)),
  }, {
    manifestPath,
    runId,
    caller: "relay-manifest.test manifest mismatch",
  }), /does not match the manifest storage path/);

  const { worktreePath: unrelatedRelayWorktree } = createUnrelatedRelayOwnedWorktree(repoRoot);
  assert.throws(() => validateManifestPaths({
    repo_root: repoRoot,
    worktree: unrelatedRelayWorktree,
  }, {
    expectedRepoRoot: repoRoot,
    manifestPath,
    runId,
    caller: "relay-manifest.test unrelated relay-owned worktree",
  }), /is not contained under the expected repo root/);
});

test("manifest round-trips through frontmatter helpers", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");
  const runId = "issue-42-20260402103000000";
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
  initGitRepo(repoRoot, "Relay Maintainer");
  const runId = "issue-42-20260402103001000";
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
      runId: "issue-42-20260402103002000",
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
    runId: "issue-42-20260402103003000",
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
  initGitRepo(tmpRoot, "Relay Maintainer");
  const runId = "migrate-v1-20260402103000000";
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

test("getRepoSlug canonicalizes repo roots across subdirs, symlinks, and worktrees", () => {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoParent = fs.mkdtempSync(path.join(os.tmpdir(), "relay-slug-parent-"));
  const repoRoot = path.join(repoParent, "my-project");
  fs.mkdirSync(repoRoot, { recursive: true });
  createCommittedRepo(repoRoot);
  const canonicalRepoRoot = fs.realpathSync(repoRoot);

  const subdir = path.join(repoRoot, "nested", "dir");
  fs.mkdirSync(subdir, { recursive: true });

  const symlinkParent = fs.mkdtempSync(path.join(os.tmpdir(), "relay-slug-link-"));
  const symlinkPath = path.join(symlinkParent, "my-project-link");
  fs.symlinkSync(repoRoot, symlinkPath, "dir");

  const worktreePath = createRelayOwnedWorktree(repoRoot, "issue-42-slug");

  const slugFromRepo = getRepoSlug(repoRoot);
  assert.equal(getCanonicalRepoRoot(repoRoot), canonicalRepoRoot);
  assert.equal(getCanonicalRepoRoot(subdir), canonicalRepoRoot);
  assert.equal(getCanonicalRepoRoot(symlinkPath), canonicalRepoRoot);
  assert.equal(getCanonicalRepoRoot(worktreePath), canonicalRepoRoot);
  assert.equal(getRepoSlug(subdir), slugFromRepo);
  assert.equal(getRepoSlug(symlinkPath), slugFromRepo);
  assert.equal(getRepoSlug(worktreePath), slugFromRepo);
  assert.match(slugFromRepo, /^my-project-[a-f0-9]{8}$/);
});

test("getRepoSlug stays deterministic and differentiates same-name repos by canonical path", () => {
  const repoParentA = fs.mkdtempSync(path.join(os.tmpdir(), "relay-slug-a-"));
  const repoRootA = path.join(repoParentA, "my-project");
  fs.mkdirSync(repoRootA, { recursive: true });
  createCommittedRepo(repoRootA);

  const repoParentB = fs.mkdtempSync(path.join(os.tmpdir(), "relay-slug-b-"));
  const repoRootB = path.join(repoParentB, "my-project");
  fs.mkdirSync(repoRootB, { recursive: true });
  createCommittedRepo(repoRootB);

  const slug1 = getRepoSlug(repoRootA);
  const slug2 = getRepoSlug(repoRootA);
  const slug3 = getRepoSlug(repoRootB);

  assert.equal(slug1, slug2);
  assert.notEqual(slug1, slug3);
  assert.match(slug1, /^my-project-[a-f0-9]{8}$/);
  assert.match(slug3, /^my-project-[a-f0-9]{8}$/);
});

test("getCanonicalRepoRoot and getRepoSlug fail clearly for non-git paths", () => {
  const nonGitPath = fs.mkdtempSync(path.join(os.tmpdir(), "relay-non-git-"));

  assert.throws(
    () => getCanonicalRepoRoot(nonGitPath),
    /getCanonicalRepoRoot: unable to resolve main repo root from .*relay-non-git-.*: /
  );
  assert.throws(
    () => getRepoSlug(nonGitPath),
    /getCanonicalRepoRoot: unable to resolve main repo root from .*relay-non-git-.*: /
  );
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

test("forceTransitionState bypasses ALLOWED_TRANSITIONS but keeps enum + invariant checks", () => {
  const { forceTransitionState } = require("./relay-manifest");
  const manifest = {
    state: STATES.CHANGES_REQUESTED,
    next_action: "await_redispatch",
    timestamps: { created_at: "2026-04-17T13:00:00Z", updated_at: "2026-04-17T13:00:00Z" },
  };

  // changes_requested -> review_pending is NOT in ALLOWED_TRANSITIONS but forceTransitionState allows it.
  const recovered = forceTransitionState(manifest, STATES.REVIEW_PENDING, "run_review");
  assert.equal(recovered.state, STATES.REVIEW_PENDING);
  assert.equal(recovered.next_action, "run_review");

  // Unknown state values are still rejected (enum check preserved).
  assert.throws(
    () => forceTransitionState(manifest, "not_a_state", "???"),
    /Unknown relay state/
  );
  assert.throws(
    () => forceTransitionState({ ...manifest, state: "bogus" }, STATES.REVIEW_PENDING, "run_review"),
    /Unknown relay state/
  );
});

test("updateManifestState rejects dispatched -> review_pending when anchor.rubric_path is missing", () => {
  const manifest = {
    run_id: "issue-42-20260412000000000",
    state: STATES.DISPATCHED,
    next_action: "await_dispatch_result",
    anchor: {},
    timestamps: { created_at: "2026-04-12T00:00:00Z", updated_at: "2026-04-12T00:00:00Z" },
  };

  assert.throws(
    () => updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review"),
    /anchor\.rubric_path/
  );
});

test("updateManifestState allows dispatched -> review_pending when anchor.rubric_path is present", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-rubric-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");
  const runId = "issue-42-20260412000001000";
  writeRunRubric(repoRoot, runId);
  const manifest = {
    run_id: runId,
    state: STATES.DISPATCHED,
    next_action: "await_dispatch_result",
    anchor: { rubric_path: "rubric.yaml" },
    paths: { repo_root: repoRoot },
    timestamps: { created_at: "2026-04-12T00:00:00Z", updated_at: "2026-04-12T00:00:00Z" },
  };

  const updated = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  assert.equal(updated.state, STATES.REVIEW_PENDING);
});

test("updateManifestState rejects dispatched -> review_pending when the legacy grandfather field is true", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-grandfathered-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");
  const manifest = {
    run_id: "issue-42-20260412000002000",
    state: STATES.DISPATCHED,
    next_action: "await_dispatch_result",
    anchor: { rubric_grandfathered: true },
    paths: { repo_root: repoRoot },
    timestamps: { created_at: "2026-04-12T00:00:00Z", updated_at: "2026-04-12T00:00:00Z" },
  };

  assert.throws(
    () => updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review"),
    /anchor\.rubric_grandfathered is no longer supported/
  );
});

test("getRubricAnchorStatus rejects invalid run_id even for grandfathered runs", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-grandfather-runid-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");

  assert.throws(
    () => getRubricAnchorStatus({
      run_id: "../victim-run",
      anchor: { rubric_grandfathered: createGrandfatheredRubricAnchor() },
      paths: { repo_root: repoRoot },
    }),
    /may not contain '\.\.' segments/
  );
});

test("getRubricAnchorStatus rejects missing and empty run_id before rubric or grandfathered handling", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-missing-runid-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");

  const cases = [
    {
      label: "missing run_id with rubric_path",
      manifest: {
        anchor: { rubric_path: "rubric.yaml" },
        paths: { repo_root: repoRoot },
      },
      pattern: /got undefined/,
    },
    {
      label: "empty run_id with rubric_path",
      manifest: {
        run_id: "",
        anchor: { rubric_path: "rubric.yaml" },
        paths: { repo_root: repoRoot },
      },
      pattern: /got ""/,
    },
    {
      label: "missing run_id with grandfathered anchor",
      manifest: {
        anchor: { rubric_grandfathered: createGrandfatheredRubricAnchor() },
        paths: { repo_root: repoRoot },
      },
      pattern: /got undefined/,
    },
    {
      label: "empty run_id with grandfathered anchor",
      manifest: {
        run_id: "",
        anchor: { rubric_grandfathered: createGrandfatheredRubricAnchor() },
        paths: { repo_root: repoRoot },
      },
      pattern: /got ""/,
    },
  ];

  for (const entry of cases) {
    assert.throws(
      () => getRubricAnchorStatus(entry.manifest),
      (error) => {
        assert.match(error.message, /run_id must be set to a single path segment/);
        assert.match(error.message, entry.pattern);
        return true;
      },
      entry.label
    );
  }
});

test("getRubricAnchorStatus distinguishes satisfied, empty, outside_run_dir, and legacy grandfather-field rejection", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-anchor-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");

  const runId = "issue-42-20260412000003000";
  writeRunRubric(repoRoot, runId);
  const satisfied = getRubricAnchorStatus({
    run_id: runId,
    anchor: { rubric_path: "rubric.yaml" },
    paths: { repo_root: repoRoot },
  });
  assert.equal(satisfied.status, "satisfied");
  assert.equal(satisfied.satisfied, true);

  const emptyRunId = "issue-42-20260412000004000";
  writeRunRubric(repoRoot, emptyRunId, "rubric.yaml", "   \n");
  const empty = getRubricAnchorStatus({
    run_id: emptyRunId,
    anchor: { rubric_path: "rubric.yaml" },
    paths: { repo_root: repoRoot },
  });
  assert.equal(empty.status, "empty");
  assert.equal(empty.satisfied, false);

  const escaped = getRubricAnchorStatus({
    run_id: runId,
    anchor: { rubric_path: "../escape.yaml" },
    paths: { repo_root: repoRoot },
  });
  assert.equal(escaped.status, "outside_run_dir");
  assert.equal(escaped.satisfied, false);

  const grandfathered = getRubricAnchorStatus({
    run_id: runId,
    anchor: { rubric_path: "rubric.yaml", rubric_grandfathered: createGrandfatheredRubricAnchor() },
    paths: { repo_root: repoRoot },
  });
  assert.equal(grandfathered.status, "legacy_grandfather_field");
  assert.equal(grandfathered.satisfied, false);
  assert.match(grandfathered.error, /anchor\.rubric_grandfathered is no longer supported/);
});

test("getRubricAnchorStatus rejects explicit false after grandfather retirement", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-legacy-grandfather-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");
  writeRunRubric(repoRoot, "issue-42-20260412000003001");

  const result = getRubricAnchorStatus({
    run_id: "issue-42-20260412000003001",
    anchor: {
      rubric_path: "rubric.yaml",
      rubric_grandfathered: false,
    },
    paths: { repo_root: repoRoot },
  });

  assert.equal(result.status, "legacy_grandfather_field");
  assert.equal(result.satisfied, false);
  assert.match(result.error, /anchor\.rubric_grandfathered is no longer supported/);
});

test("getRubricAnchorStatus fails closed for malformed grandfather provenance objects", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-malformed-grandfather-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");

  const result = getRubricAnchorStatus({
    run_id: "issue-42-20260412000003002",
    anchor: {
      rubric_grandfathered: {
        from_migration: "rubric-mandatory.yaml",
        reason: "missing actor and applied_at",
      },
    },
    paths: { repo_root: repoRoot },
  });

  assert.equal(result.status, "legacy_grandfather_field");
  assert.equal(result.satisfied, false);
  assert.match(result.error, /anchor\.rubric_grandfathered is no longer supported/);
});

test("getRubricAnchorStatus rejects object-form grandfather provenance regardless of provenance shape", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-unbacked-grandfather-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");

  const result = getRubricAnchorStatus({
    run_id: "issue-42-20260412000003009",
    anchor: {
      rubric_grandfathered: createGrandfatheredRubricAnchor({
        actor: "hand-edited-test",
      }),
    },
    paths: { repo_root: repoRoot },
  });

  assert.equal(result.status, "legacy_grandfather_field");
  assert.equal(result.satisfied, false);
  assert.match(result.error, /anchor\.rubric_grandfathered is no longer supported/);
});

test("getRubricAnchorStatus fails closed for parseable non-ISO grandfather provenance timestamps", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-non-iso-grandfather-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");

  const result = getRubricAnchorStatus({
    run_id: "issue-42-20260412000003003",
    anchor: {
      rubric_grandfathered: {
        from_migration: "rubric-mandatory.yaml",
        applied_at: "04/17/2026",
        actor: "Relay Maintainer",
      },
    },
    paths: { repo_root: repoRoot },
  });

  assert.equal(result.status, "legacy_grandfather_field");
  assert.equal(result.satisfied, false);
  assert.match(result.error, /anchor\.rubric_grandfathered is no longer supported/);
});

test("getRubricAnchorStatus rejects symlinked rubric files even when they target readable files", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-symlink-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");

  const outsideTarget = path.join(os.tmpdir(), `relay-outside-rubric-${Date.now()}.yaml`);
  fs.writeFileSync(outsideTarget, "outside: true\n", "utf-8");

  const sameRunId = "issue-42-20260412000005000";
  const sameRunLayout = ensureRunLayout(repoRoot, sameRunId);
  const siblingTarget = path.join(sameRunLayout.runDir, "rubric-copy.yaml");
  fs.writeFileSync(siblingTarget, "rubric:\n  factors:\n    - name: sibling\n", "utf-8");
  fs.symlinkSync(siblingTarget, path.join(sameRunLayout.runDir, "rubric.yaml"));

  const otherRunId = "issue-42-20260412000006000";
  const otherRunTarget = writeRunRubric(repoRoot, otherRunId).fullPath;
  const linkedRunId = "issue-42-20260412000007000";
  const linkedRunLayout = ensureRunLayout(repoRoot, linkedRunId);
  fs.symlinkSync(otherRunTarget, path.join(linkedRunLayout.runDir, "rubric.yaml"));

  const outsideRunId = "issue-42-20260412000008000";
  const outsideRunLayout = ensureRunLayout(repoRoot, outsideRunId);
  fs.symlinkSync(outsideTarget, path.join(outsideRunLayout.runDir, "rubric.yaml"));

  [
    { runId: outsideRunId, label: "outside file" },
    { runId: linkedRunId, label: "other run rubric" },
    { runId: sameRunId, label: "same run sibling file" },
  ].forEach(({ runId, label }) => {
    const result = getRubricAnchorStatus({
      run_id: runId,
      anchor: { rubric_path: "rubric.yaml" },
      paths: { repo_root: repoRoot },
    });

    assert.equal(result.status, "symlink_escape", label);
    assert.equal(result.satisfied, false, label);
  });
});

test("getRubricAnchorStatus fails closed for contained-but-malformed rubric paths", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-malformed-rubric-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");

  const runId = "issue-42-20260412000008500";
  const { runDir } = ensureRunLayout(repoRoot, runId);
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: malformed\n", "utf-8");

  const result = getRubricAnchorStatus({
    run_id: runId,
    anchor: { rubric_path: "rubric.yaml/child" },
    paths: { repo_root: repoRoot },
  });

  assert.equal(result.status, "unreadable");
  assert.equal(result.satisfied, false);
  assert.match(result.error, /rubric\.yaml\/child/);
});

test("getRubricAnchorStatus distinguishes parent symlink escapes from lexical outside_run_dir", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-parent-symlink-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Maintainer");

  const runId = "issue-42-20260412000009000";
  const { runDir } = ensureRunLayout(repoRoot, runId);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-rubric-outside-dir-"));
  const escapedParent = path.join(runDir, "rubric-link");
  fs.symlinkSync(outsideDir, escapedParent);

  const result = getRubricAnchorStatus({
    run_id: runId,
    anchor: { rubric_path: "rubric-link/rubric.yaml" },
    paths: { repo_root: repoRoot },
  });

  assert.equal(result.status, "follows_outside_run_dir");
  assert.equal(result.satisfied, false);
  assert.match(result.error, /real run directory/i);
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
  initGitRepo(repoRoot, "Relay Maintainer");
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
  initGitRepo(repoRoot, "Relay Maintainer");
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
  initGitRepo(repoRoot, "Relay Maintainer");
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

// ---------------------------------------------------------------------------
// #197 — previous-attempts.json symlink trust-root refusal
// ---------------------------------------------------------------------------

test("readPreviousAttempts refuses when previous-attempts.json is a symlink", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-symlink-attempts-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-attempts-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  const runId = "issue-197-20260417000000000";

  // Seed a first legit attempt so the file exists.
  captureAttempt(repoRoot, runId, { score_log: "first attempt" });
  const attemptsPath = findAttemptsFile(process.env.RELAY_HOME);

  const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-attempts-foreign-"));
  const foreignAttempts = path.join(foreignDir, "foreign-attempts.json");
  fs.writeFileSync(foreignAttempts, '[{"score_log":"spoofed"}]', "utf-8");

  fs.rmSync(attemptsPath);
  fs.symlinkSync(foreignAttempts, attemptsPath);

  // Must NOT silently fall back to [] — symlink refusal surfaces as a thrown
  // error (fail-closed, per #157 class avoidance).
  assert.throws(
    () => readPreviousAttempts(repoRoot, runId),
    /Refusing to (read|open) symlinked previous-attempts\.json/i
  );
});

test("captureAttempt refuses when previous-attempts.json is a symlink", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-symlink-capture-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-capture-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  const runId = "issue-197-20260417000000001";

  captureAttempt(repoRoot, runId, { score_log: "first attempt" });
  const attemptsPath = findAttemptsFile(process.env.RELAY_HOME);

  const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-attempts-victim-"));
  const victim = path.join(victimDir, "victim.json");
  fs.writeFileSync(victim, "original victim content", "utf-8");

  fs.rmSync(attemptsPath);
  fs.symlinkSync(victim, attemptsPath);

  assert.throws(
    () => captureAttempt(repoRoot, runId, { score_log: "second attempt" }),
    /Refusing to (read|write|open) symlinked previous-attempts\.json/i
  );
  // Victim file must not have been mutated — whether the refusal fires on the
  // read-before-append path or on the write path, the net effect is identical.
  assert.equal(fs.readFileSync(victim, "utf-8"), "original victim content");
});

function findAttemptsFile(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findAttemptsFile(full);
      if (found) return found;
    }
    if (entry.name === "previous-attempts.json") return full;
  }
  return null;
}

test("readPreviousAttempts refuses dangling symlinks instead of silently returning []", () => {
  // #197 fail-closed: dangling symlink must NOT be treated as "file missing".
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-dangling-read-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-dangling-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  const runId = "issue-197-20260417000000002";

  // Seed one attempt so the run layout exists, then remove the file and
  // replace it with a dangling symlink.
  captureAttempt(repoRoot, runId, { score_log: "first attempt" });
  const attemptsPath = findAttemptsFile(process.env.RELAY_HOME);
  fs.rmSync(attemptsPath);
  fs.symlinkSync("/nonexistent-relay-attempts-target-xyz", attemptsPath);

  assert.throws(
    () => readPreviousAttempts(repoRoot, runId),
    /Refusing to (read|open) symlinked previous-attempts\.json/i
  );
});

test("captureAttempt refuses dangling symlinks (no create-through on write)", () => {
  // Proves the write helper also refuses dangling symlinks — defense-in-depth
  // for platforms without O_NOFOLLOW where the pre-fix existsSync fallback
  // would have happily created through the link.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-manifest-dangling-write-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-dangling-w-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  const runId = "issue-197-20260417000000003";

  captureAttempt(repoRoot, runId, { score_log: "first attempt" });
  const attemptsPath = findAttemptsFile(process.env.RELAY_HOME);

  const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-attempts-dangling-"));
  const victimTarget = path.join(victimDir, "victim.json");
  fs.rmSync(attemptsPath);
  fs.symlinkSync(victimTarget, attemptsPath);

  assert.throws(
    () => captureAttempt(repoRoot, runId, { score_log: "second attempt" }),
    /Refusing to (read|write|open) symlinked previous-attempts\.json/i
  );
  assert.equal(fs.existsSync(victimTarget), false, "victim must not have been created through the symlink");
});

// Direct unit tests for the shared write helpers — prove that the write path
// itself (independent of captureAttempt's read-then-write sequencing) refuses
// symlinks. Exported via relay-manifest.
const {
  appendTextFileWithoutFollowingSymlinks,
  writeTextFileWithoutFollowingSymlinks,
} = require("./relay-manifest");

test("appendTextFileWithoutFollowingSymlinks refuses an existing symlink at target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-append-symlink-"));
  const target = path.join(dir, "events.jsonl");
  const victim = path.join(dir, "victim.jsonl");
  fs.writeFileSync(victim, "pre-existing\n", "utf-8");
  fs.symlinkSync(victim, target);

  assert.throws(
    () => appendTextFileWithoutFollowingSymlinks(target, "malicious\n"),
    /Refusing to open symlinked path/
  );
  assert.equal(fs.readFileSync(victim, "utf-8"), "pre-existing\n");
});

test("writeTextFileWithoutFollowingSymlinks refuses an existing symlink at target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-write-symlink-"));
  const target = path.join(dir, "attempts.json");
  const victim = path.join(dir, "victim.json");
  fs.writeFileSync(victim, "pre-existing", "utf-8");
  fs.symlinkSync(victim, target);

  assert.throws(
    () => writeTextFileWithoutFollowingSymlinks(target, '[{"spoofed":true}]'),
    /Refusing to open symlinked path/
  );
  assert.equal(fs.readFileSync(victim, "utf-8"), "pre-existing");
});

test("writeTextFileWithoutFollowingSymlinks refuses a dangling symlink at target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-write-dangling-"));
  const target = path.join(dir, "attempts.json");
  const danglingTarget = path.join(dir, "does-not-exist.json");
  fs.symlinkSync(danglingTarget, target);

  assert.throws(
    () => writeTextFileWithoutFollowingSymlinks(target, '[{"ok":true}]'),
    /Refusing to open symlinked path/
  );
  assert.equal(fs.existsSync(danglingTarget), false, "dangling target must not have been created through the symlink");
});

test("writeTextFileWithoutFollowingSymlinks creates a new file when the target is truly absent", () => {
  // Regression check: make sure the "no entry at path" code path still works
  // end-to-end and produces a regular file with the expected content.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-write-create-"));
  const target = path.join(dir, "attempts.json");
  writeTextFileWithoutFollowingSymlinks(target, '[{"ok":true}]');
  assert.equal(fs.readFileSync(target, "utf-8"), '[{"ok":true}]');
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
});

test("appendTextFileWithoutFollowingSymlinks refuses a dangling symlink at target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-append-dangling-"));
  const target = path.join(dir, "events.jsonl");
  const danglingTarget = path.join(dir, "does-not-exist.jsonl");
  fs.symlinkSync(danglingTarget, target);

  assert.throws(
    () => appendTextFileWithoutFollowingSymlinks(target, "malicious\n"),
    /Refusing to open symlinked path/
  );
  assert.equal(fs.existsSync(danglingTarget), false, "dangling target must not have been created through the symlink");
});

test("appendTextFileWithoutFollowingSymlinks creates a new file when the target is truly absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-append-create-"));
  const target = path.join(dir, "events.jsonl");
  appendTextFileWithoutFollowingSymlinks(target, "{\"event\":\"one\"}\n");
  appendTextFileWithoutFollowingSymlinks(target, "{\"event\":\"two\"}\n");
  assert.equal(
    fs.readFileSync(target, "utf-8"),
    "{\"event\":\"one\"}\n{\"event\":\"two\"}\n"
  );
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
});

test("write helpers refuse a FIFO at the target path (POSIX only)", { skip: process.platform === "win32" }, () => {
  // Defense-in-depth: trust-root protection isn't only about symlinks. A FIFO
  // dropped at the target path could block `open(O_WRONLY)` forever waiting
  // for a reader, or a socket/device could have side-effects. The helpers
  // use O_NONBLOCK on POSIX and gate the fd with fstat+isFile.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fifo-"));
  const target = path.join(dir, "events.jsonl");
  execFileSync("mkfifo", [target], { stdio: "pipe" });

  // With O_NONBLOCK, open(O_WRONLY) on a reader-less FIFO fails with ENXIO
  // on Linux/macOS — that's an acceptable refusal (attacker attempt blocked)
  // even though it doesn't go through our ELOOP path. Alternately, if the
  // platform opens it (with a reader attached, hypothetically), the fstat
  // gate inside gateWritableFd catches it with ENOT_REGULAR_FILE. Either
  // way, no writeSync lands on the FIFO.
  assert.throws(
    () => appendTextFileWithoutFollowingSymlinks(target, "x\n"),
    (error) => ["ENOT_REGULAR_FILE", "ENXIO"].includes(error.code) || /Not a regular file/.test(error.message)
  );
  assert.throws(
    () => writeTextFileWithoutFollowingSymlinks(target, "x"),
    (error) => ["ENOT_REGULAR_FILE", "ENXIO"].includes(error.code) || /Not a regular file/.test(error.message)
  );
});

test("write helpers loop on short writes so records are never truncated", () => {
  // fs.writeSync may return fewer bytes than requested. For regular disk
  // files this is rare, but when it happens (page-cache pressure, signal
  // interruption, future fs overlay), a truncated JSONL record would
  // silently corrupt events.jsonl or previous-attempts.json.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-short-write-"));
  const target = path.join(dir, "attempts.json");
  const payload = '[{"dispatch_number":1,"score_log":"AB"}]';

  const realWriteSync = fs.writeSync;
  let calls = 0;
  fs.writeSync = function patchedWriteSync(fd, buffer, offset, length, position) {
    calls += 1;
    // On the first call, write only 5 bytes of the requested length — a
    // deliberate short write. Subsequent calls complete the remainder.
    if (calls === 1 && Buffer.isBuffer(buffer)) {
      const partial = Math.min(5, length);
      return realWriteSync.call(fs, fd, buffer, offset, partial, position);
    }
    return realWriteSync.apply(fs, arguments);
  };
  try {
    writeTextFileWithoutFollowingSymlinks(target, payload);
  } finally {
    fs.writeSync = realWriteSync;
  }

  assert.equal(fs.readFileSync(target, "utf-8"), payload, "full payload must land on disk despite the short write");
  assert.ok(calls >= 2, "short-write path must have been exercised");
});

const { readTextFileWithoutFollowingSymlinks } = require("./relay-manifest");

test("read helper refuses a FIFO at the target path (POSIX only)", { skip: process.platform === "win32" }, () => {
  // Round-4 codex catch: on platforms with O_NOFOLLOW, a FIFO would pass the
  // O_NOFOLLOW check (it's not a symlink), and the fstat+isFile guard inside
  // the primary branch was self-throwing EINVAL — which the outer catch then
  // swallowed, falling through to the lstat path which would reopen the FIFO
  // without O_NOFOLLOW. That path can block on open(O_RDONLY) waiting for a
  // writer, or worse, have side-effects on devices.
  //
  // The fix uses a distinct ENOT_REGULAR_FILE code so the outer catch does
  // NOT swallow it, and adds O_NONBLOCK so the open(O_RDONLY) returns
  // immediately for non-regular files. Either path is an acceptable refusal.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-read-fifo-"));
  const target = path.join(dir, "events.jsonl");
  execFileSync("mkfifo", [target], { stdio: "pipe" });

  assert.throws(
    () => readTextFileWithoutFollowingSymlinks(target),
    (error) =>
      error.code === "ENOT_REGULAR_FILE"
      || error.code === "ENXIO"
      || /Not a regular file/.test(error.message)
  );
});
