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
  readManifest,
  updateManifestState,
  writeManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");
const { readRunEvents } = require("../../relay-dispatch/scripts/relay-events");
const { createEnforcementFixture } = require("../../relay-dispatch/scripts/test-support");

const SCRIPT = path.join(__dirname, "finalize-run.js");
const DEFAULT_COMMIT_DATE = "2026-04-03T08:00:00Z";
const DEFAULT_REVIEW_COMMENT = {
  body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
  createdAt: DEFAULT_COMMIT_DATE,
};

test("finalize-run help includes review-bypass decision tree", () => {
  const result = spawnSync("node", [SCRIPT, "--help"], {
    encoding: "utf-8",
    stdio: "pipe",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Review-bypass decision tree/);
  assert.ok(result.stdout.split(/\r?\n/).some((line) => (
    line.includes("State is 'review_pending'")
    && line.includes("--skip-review <reason>")
  )));
});

function buildManifestForState(manifest, targetState) {
  switch (targetState) {
    case STATES.DRAFT:
      return manifest;
    case STATES.DISPATCHED:
      return updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
    case STATES.REVIEW_PENDING: {
      const dispatched = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
      const reviewPending = updateManifestState(dispatched, STATES.REVIEW_PENDING, "run_review");
      return {
        ...reviewPending,
        review: {
          ...(reviewPending.review || {}),
          last_reviewed_sha: reviewPending.git?.head_sha || null,
          latest_verdict: "pending",
          rounds: 1,
        },
      };
    }
    case STATES.CHANGES_REQUESTED: {
      const reviewPending = buildManifestForState(manifest, STATES.REVIEW_PENDING);
      const requested = updateManifestState(reviewPending, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
      return {
        ...requested,
        review: {
          ...(requested.review || {}),
          latest_verdict: "changes_requested",
        },
      };
    }
    case STATES.READY_TO_MERGE: {
      const reviewPending = buildManifestForState(manifest, STATES.REVIEW_PENDING);
      const ready = updateManifestState(reviewPending, STATES.READY_TO_MERGE, "await_explicit_merge");
      return {
        ...ready,
        review: {
          ...(ready.review || {}),
          latest_verdict: "lgtm",
        },
      };
    }
    case STATES.ESCALATED: {
      const reviewPending = buildManifestForState(manifest, STATES.REVIEW_PENDING);
      const escalated = updateManifestState(reviewPending, STATES.ESCALATED, "inspect_review_failure");
      return {
        ...escalated,
        review: {
          ...(escalated.review || {}),
          latest_verdict: "escalated",
        },
      };
    }
    case STATES.MERGED: {
      const ready = buildManifestForState(manifest, STATES.READY_TO_MERGE);
      return updateManifestState(ready, STATES.MERGED, "manual_cleanup_required");
    }
    case STATES.CLOSED: {
      const ready = buildManifestForState(manifest, STATES.READY_TO_MERGE);
      return updateManifestState(ready, STATES.CLOSED, "done");
    }
    default:
      throw new Error(`Unsupported fixture manifest state: ${targetState}`);
  }
}

function setupRepo({
  dirtyWorktree = false,
  enforcementState = "loaded",
  manifestState = STATES.READY_TO_MERGE,
} = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-finalize-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const originRoot = path.join(repoRoot, "origin.git");
  execFileSync("git", ["init", "--bare", originRoot], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Merge Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-merge@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", originRoot], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const branch = "issue-42";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(worktreePath, "smoke.txt"), "ok\n", "utf-8");
  execFileSync("git", ["-C", worktreePath, "add", "smoke.txt"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "commit", "-m", "Add smoke"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "push", "-u", "origin", branch], { encoding: "utf-8", stdio: "pipe" });
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
    executor: "codex",
    reviewer: "codex",
  });
  manifest.anchor = createEnforcementFixture({
    repoRoot,
    runId,
    state: enforcementState,
  }).anchor;
  manifest.git.pr_number = 123;
  manifest.git.head_sha = headSha;
  manifest = buildManifestForState(manifest, manifestState);
  writeManifest(manifestPath, manifest);

  return { repoRoot, manifestPath, branch, worktreePath, headSha, runId };
}

function createUnrelatedRelayOwnedWorktree(repoRoot, branch = "issue-42") {
  const attackerParent = fs.mkdtempSync(path.join(os.tmpdir(), "relay-finalize-foreign-"));
  const attackerRoot = path.join(attackerParent, path.basename(repoRoot));
  fs.mkdirSync(attackerRoot, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Finalize Foreign"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-finalize-foreign@example.com"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(attackerRoot, "README.md"), "foreign\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: attackerRoot, encoding: "utf-8", stdio: "pipe" });
  const relayWorktrees = path.join(process.env.RELAY_HOME, "worktrees");
  fs.mkdirSync(relayWorktrees, { recursive: true });
  const attackerWorktreeParent = fs.mkdtempSync(path.join(relayWorktrees, "foreign-"));
  const attackerWorktree = path.join(attackerWorktreeParent, path.basename(repoRoot));
  execFileSync("git", ["worktree", "add", attackerWorktree, "-b", branch], {
    cwd: attackerRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(attackerWorktree, "sentinel.txt"), "foreign\n", "utf-8");
  return { attackerRoot, attackerWorktree };
}

function createMissingRelayOwnedWorktree(repoRoot) {
  const relayWorktrees = path.join(process.env.RELAY_HOME, "worktrees");
  fs.mkdirSync(relayWorktrees, { recursive: true });
  const worktreeParent = fs.mkdtempSync(path.join(relayWorktrees, "missing-"));
  return path.join(worktreeParent, path.basename(repoRoot));
}

function createUnrelatedGitRepo(prefix = "relay-finalize-manifest-cwd-") {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Finalize Manifest"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-finalize-manifest@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "manifest selector\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return repoRoot;
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

function remoteBranchExists(repoRoot, branch) {
  try {
    execFileSync("git", ["-C", repoRoot, "ls-remote", "--exit-code", "--heads", "origin", branch], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function writeFakeGh(logPath, {
  headRefName = "issue-42",
  comments = [],
  commits = [],
  state = "OPEN",
  mergeCommit = null,
  mergeable = "MERGEABLE",
  statusCheckRollup = [],
  stateAfterMerge = "MERGED",
  mergeCommitAfterMerge = { oid: "merged-sha" },
  prMergeExitCode = 0,
  prMergeStderr = "",
} = {}) {
  const ghPath = path.join(path.dirname(logPath), "fake-gh.js");
  const statePath = path.join(path.dirname(logPath), "fake-gh-state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    headRefName,
    comments,
    commits,
    state,
    mergeCommit,
    mergeable,
    statusCheckRollup,
    stateAfterMerge,
    mergeCommitAfterMerge,
    prMergeExitCode,
    prMergeStderr,
  }), "utf-8");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
function loadState() {
  return JSON.parse(fs.readFileSync(statePath, "utf-8"));
}
function saveState(next) {
  fs.writeFileSync(statePath, JSON.stringify(next), "utf-8");
}
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n", "utf-8");
if (args[0] === "pr" && args[1] === "merge") {
  const state = loadState();
  state.state = state.stateAfterMerge;
  state.mergeCommit = state.mergeCommitAfterMerge;
  saveState(state);
  if (state.prMergeExitCode) {
    process.stderr.write(state.prMergeStderr || "merge failed");
    process.exit(state.prMergeExitCode);
  }
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  const state = loadState();
  process.stdout.write(JSON.stringify({
    headRefName: state.headRefName,
    state: state.state,
    mergeCommit: state.mergeCommit,
    comments: state.comments,
    commits: state.commits,
    mergeable: state.mergeable,
    statusCheckRollup: state.statusCheckRollup
  }));
}
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return ghPath;
}

function runFinalizeSkipReview({
  enforcementState = "loaded",
  rubricGrandfathered = undefined,
  reason = "hotfix",
} = {}) {
  const fixture = setupRepo();
  if (enforcementState !== "loaded" || rubricGrandfathered !== undefined) {
    createEnforcementFixture({
      repoRoot: fixture.repoRoot,
      runId: fixture.runId,
      manifestPath: fixture.manifestPath,
      state: enforcementState,
      anchorOverrides: rubricGrandfathered === undefined
        ? {}
        : { rubric_grandfathered: rubricGrandfathered },
    });
  }
  const logPath = path.join(fixture.repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    comments: [],
    commits: [
      {
        oid: fixture.headSha,
        committedDate: "2026-04-03T08:00:00Z",
      },
    ],
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", fixture.repoRoot,
    "--branch", fixture.branch,
    "--pr", "123",
    "--skip-review", reason,
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_GH_BIN: fakeGh },
  });

  return {
    ...fixture,
    logPath,
    result: JSON.parse(stdout),
    events: readRunEvents(fixture.repoRoot, fixture.runId),
  };
}

function execFinalize(fixture, {
  extraArgs = [],
  ghOptions = {},
  env = {},
  selectorArgs = ["--repo", fixture.repoRoot, "--branch", fixture.branch],
  cwd = fixture.repoRoot,
} = {}) {
  const logPath = path.join(fixture.repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    comments: [],
    commits: [
      {
        oid: fixture.headSha,
        committedDate: DEFAULT_COMMIT_DATE,
      },
    ],
    ...ghOptions,
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    ...selectorArgs,
    "--pr", "123",
    ...extraArgs,
    "--json",
  ], {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_GH_BIN: fakeGh, ...env },
  });

  return {
    ...fixture,
    logPath,
    result: JSON.parse(stdout),
    events: readRunEvents(fixture.repoRoot, fixture.runId),
  };
}

function spawnForceFinalize(fixture, reason) {
  const logPath = path.join(fixture.repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    comments: [],
    commits: [
      {
        oid: fixture.headSha,
        committedDate: DEFAULT_COMMIT_DATE,
      },
    ],
  });

  const result = spawnSync("node", [
    SCRIPT,
    "--repo", fixture.repoRoot,
    "--branch", fixture.branch,
    "--pr", "123",
    "--force-finalize-nonready",
    "--reason", reason,
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_GH_BIN: fakeGh },
  });

  return { ...fixture, logPath, result };
}

test("finalize-run force-finalize merges an escalated run with an auditable event trail", () => {
  const fixture = setupRepo({ manifestState: STATES.ESCALATED });
  const forceReason = "reviewer-swap exhausted, diff clean per manual inspection";
  const { result, events, repoRoot, manifestPath, branch, worktreePath, logPath, headSha } = execFinalize(fixture, {
    extraArgs: ["--force-finalize-nonready", "--reason", forceReason],
  });

  const forceEvent = events.find((entry) => entry.event === "force_finalize");
  const mergeEvent = events.find((entry) => entry.event === "merge_finalize");
  const manifest = readManifest(manifestPath).data;

  assert.equal(result.previousState, STATES.ESCALATED);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.forceFinalized, true);
  assert.equal(result.forceFinalizeReason, forceReason);
  assert.equal(forceEvent?.state_from, STATES.ESCALATED);
  assert.equal(forceEvent?.state_to, STATES.MERGED);
  assert.equal(forceEvent?.reason, forceReason);
  assert.equal(forceEvent?.pr_number, 123);
  assert.equal("bootstrap_exempt" in forceEvent, false);
  assert.equal(forceEvent?.last_reviewed_sha, headSha);
  assert.equal(forceEvent?.head_sha, headSha);
  assert.equal(mergeEvent?.state_to, STATES.MERGED);
  assert.equal(manifest.state, STATES.MERGED);
  assert.equal(manifest.last_force.reason, forceReason);
  assert.equal(manifest.last_force.from_state, STATES.ESCALATED);
  assert.equal(manifest.last_force.to_state, STATES.MERGED);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(branchExists(repoRoot, branch), false);
  assert.equal(remoteBranchExists(repoRoot, branch), false);
  assert.match(fs.readFileSync(logPath, "utf-8"), /pr merge 123 --squash/);
});

test("finalize-run default squash collapses TDD red branch history to one base commit", () => {
  const fixture = setupRepo({ manifestState: STATES.READY_TO_MERGE });
  const baseBefore = Number(execFileSync("git", ["-C", fixture.repoRoot, "rev-list", "--count", "main"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim());

  fs.writeFileSync(path.join(fixture.worktreePath, "anchor.test.js"), "assert red first\n", "utf-8");
  execFileSync("git", ["-C", fixture.worktreePath, "add", "anchor.test.js"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", fixture.worktreePath, "commit", "-m", "tdd: red — add anchor test"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(fixture.worktreePath, "anchor.test.js"), "assert green at head\n", "utf-8");
  execFileSync("git", ["-C", fixture.worktreePath, "add", "anchor.test.js"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", fixture.worktreePath, "commit", "-m", "Implement anchor behavior"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  execFileSync("git", ["-C", fixture.worktreePath, "push"], { encoding: "utf-8", stdio: "pipe" });
  const headSha = execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  const manifest = readManifest(fixture.manifestPath).data;
  manifest.git.head_sha = headSha;
  manifest.review.last_reviewed_sha = headSha;
  writeManifest(fixture.manifestPath, manifest);

  const logPath = path.join(fixture.repoRoot, "gh-tdd-squash.log");
  const ghPath = path.join(fixture.repoRoot, "fake-gh-tdd-squash.js");
  const statePath = path.join(fixture.repoRoot, "fake-gh-tdd-squash-state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    state: "OPEN",
    mergeCommit: null,
  }), "utf-8");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const args = process.argv.slice(2);
const repoRoot = ${JSON.stringify(fixture.repoRoot)};
const statePath = ${JSON.stringify(statePath)};
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n", "utf-8");
function loadState() { return JSON.parse(fs.readFileSync(statePath, "utf-8")); }
function saveState(next) { fs.writeFileSync(statePath, JSON.stringify(next), "utf-8"); }
if (args[0] === "pr" && args[1] === "view") {
  const state = loadState();
  process.stdout.write(JSON.stringify({
    headRefName: ${JSON.stringify(fixture.branch)},
    state: state.state,
    mergeCommit: state.mergeCommit,
    comments: [{ body: "<!-- relay-review -->\\n## Relay Review\\nVerdict: PASS\\nRounds: 1", createdAt: ${JSON.stringify(DEFAULT_COMMIT_DATE)} }],
    commits: [{ oid: ${JSON.stringify(headSha)}, committedDate: ${JSON.stringify(DEFAULT_COMMIT_DATE)} }],
    mergeable: "MERGEABLE",
    statusCheckRollup: []
  }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "merge") {
  execFileSync("git", ["-C", repoRoot, "checkout", "main"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoRoot, "merge", "--squash", ${JSON.stringify(fixture.branch)}], { stdio: "pipe" });
  execFileSync("git", ["-C", repoRoot, "commit", "-m", "Squash TDD branch"], { stdio: "pipe" });
  const sha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();
  saveState({ state: "MERGED", mergeCommit: { oid: sha } });
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "close") process.exit(0);
process.exit(0);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", fixture.repoRoot,
    "--branch", fixture.branch,
    "--pr", "123",
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_GH_BIN: ghPath },
  });

  const result = JSON.parse(stdout);
  const baseAfter = Number(execFileSync("git", ["-C", fixture.repoRoot, "rev-list", "--count", "main"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim());
  const lastSubject = execFileSync("git", ["-C", fixture.repoRoot, "log", "-1", "--pretty=%s", "main"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  const ghLog = fs.readFileSync(logPath, "utf-8");

  assert.equal(result.state, STATES.MERGED);
  assert.equal(baseAfter, baseBefore + 1);
  assert.equal(lastSubject, "Squash TDD branch");
  assert.doesNotMatch(lastSubject, /^tdd: red — /);
  assert.match(ghLog, /pr merge 123 --squash/);
});

test("finalize-run warns but succeeds for legacy bootstrap-prefixed force-finalize reasons", () => {
  const fixture = setupRepo({ manifestState: STATES.ESCALATED });
  const { result } = spawnForceFinalize(fixture, "Bootstrap: this PR introduces the writer");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /relay-reconcile-artifact/);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.state, STATES.MERGED);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.MERGED);
});

test("finalize-run does not warn for non-bootstrap force-finalize reasons", () => {
  const fixture = setupRepo({ manifestState: STATES.ESCALATED });
  const { result } = spawnForceFinalize(fixture, "operator override after manual review");

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /relay-reconcile-artifact/);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.state, STATES.MERGED);
});

for (const sourceState of [
  STATES.REVIEW_PENDING,
  STATES.CHANGES_REQUESTED,
  STATES.DISPATCHED,
  STATES.DRAFT,
]) {
  test(`finalize-run force-finalize merges a ${sourceState} run`, () => {
    const fixture = setupRepo({ manifestState: sourceState });
    const { result, events, manifestPath } = execFinalize(fixture, {
      extraArgs: ["--force-finalize-nonready", "--reason", `operator override from ${sourceState}`],
    });

    const forceEvent = events.find((entry) => entry.event === "force_finalize");
    const manifest = readManifest(manifestPath).data;

    assert.equal(result.previousState, sourceState);
    assert.equal(result.state, STATES.MERGED);
    assert.equal(forceEvent?.state_from, sourceState);
    assert.equal(forceEvent?.state_to, STATES.MERGED);
    assert.equal(forceEvent?.head_sha, fixture.headSha);
    assert.equal(manifest.state, STATES.MERGED);
    assert.equal(manifest.last_force.from_state, sourceState);
    assert.equal(manifest.last_force.to_state, STATES.MERGED);
  });
}

test("finalize-run force-finalize from ready_to_merge still emits a force audit event", () => {
  const fixture = setupRepo({ manifestState: STATES.READY_TO_MERGE });
  const forceReason = "operator requested explicit audit trail";
  const { result, events, manifestPath } = execFinalize(fixture, {
    extraArgs: ["--force-finalize-nonready", "--reason", forceReason],
    ghOptions: {
      comments: [DEFAULT_REVIEW_COMMENT],
    },
  });

  const forceEvent = events.find((entry) => entry.event === "force_finalize");
  const mergeEvent = events.find((entry) => entry.event === "merge_finalize");
  const manifest = readManifest(manifestPath).data;

  assert.equal(result.previousState, STATES.READY_TO_MERGE);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(forceEvent?.state_from, STATES.READY_TO_MERGE);
  assert.equal(forceEvent?.reason, forceReason);
  assert.equal(mergeEvent?.state_to, STATES.MERGED);
  assert.equal(manifest.last_force.reason, forceReason);
  assert.equal(manifest.last_force.from_state, STATES.READY_TO_MERGE);
});

test("finalize-run rejects force-finalize from merged without mutating audit state", () => {
  const fixture = setupRepo({ manifestState: STATES.MERGED });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--manifest", fixture.manifestPath,
    "--pr", "123",
    "--force-finalize-nonready",
    "--reason", "stuck",
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }), (error) => {
    assert.match(String(error.stderr), /force-finalize cannot be used from terminal state merged/);
    return true;
  });

  const manifest = readManifest(fixture.manifestPath).data;
  assert.equal(manifest.state, STATES.MERGED);
  assert.equal("last_force" in manifest, false);
  assert.deepEqual(readRunEvents(fixture.repoRoot, fixture.runId), []);
  assert.equal(fs.existsSync(fixture.worktreePath), true);
  assert.equal(branchExists(fixture.repoRoot, fixture.branch), true);
});

test("finalize-run rejects force-finalize from closed without mutating audit state", () => {
  const fixture = setupRepo({ manifestState: STATES.CLOSED });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--manifest", fixture.manifestPath,
    "--pr", "123",
    "--force-finalize-nonready",
    "--reason", "stuck",
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }), (error) => {
    assert.match(String(error.stderr), /force-finalize cannot be used from terminal state closed/);
    return true;
  });

  const manifest = readManifest(fixture.manifestPath).data;
  assert.equal(manifest.state, STATES.CLOSED);
  assert.equal("last_force" in manifest, false);
  assert.deepEqual(readRunEvents(fixture.repoRoot, fixture.runId), []);
  assert.equal(fs.existsSync(fixture.worktreePath), true);
  assert.equal(branchExists(fixture.repoRoot, fixture.branch), true);
});

test("finalize-run rejects force-finalize without --reason before any side effect", () => {
  const fixture = setupRepo({ manifestState: STATES.ESCALATED });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", fixture.repoRoot,
    "--branch", fixture.branch,
    "--pr", "123",
    "--force-finalize-nonready",
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }), (error) => {
    assert.match(String(error.stderr), /--force-finalize-nonready requires --reason <non-empty-text>/);
    return true;
  });

  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.ESCALATED);
  assert.deepEqual(readRunEvents(fixture.repoRoot, fixture.runId), []);
  assert.equal(fs.existsSync(fixture.worktreePath), true);
  assert.equal(branchExists(fixture.repoRoot, fixture.branch), true);
  assert.equal(remoteBranchExists(fixture.repoRoot, fixture.branch), true);
  assert.equal(fs.existsSync(path.join(fixture.repoRoot, "gh.log")), false);
});

test("finalize-run rejects force-finalize with a whitespace-only --reason", () => {
  const fixture = setupRepo({ manifestState: STATES.ESCALATED });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", fixture.repoRoot,
    "--branch", fixture.branch,
    "--pr", "123",
    "--force-finalize-nonready",
    "--reason", "   ",
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }), (error) => {
    assert.match(String(error.stderr), /--force-finalize-nonready requires --reason <non-empty-text>/);
    return true;
  });

  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.ESCALATED);
  assert.deepEqual(readRunEvents(fixture.repoRoot, fixture.runId), []);
  assert.equal(fs.existsSync(fixture.worktreePath), true);
  assert.equal(branchExists(fixture.repoRoot, fixture.branch), true);
});

test("finalize-run force-finalize dry-run is observation-only and does not append audit events", () => {
  const fixture = setupRepo({ manifestState: STATES.ESCALATED });
  const { result } = execFinalize(fixture, {
    extraArgs: ["--force-finalize-nonready", "--reason", "dry-run check", "--dry-run"],
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.forceFinalized, true);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.ESCALATED);
  assert.deepEqual(readRunEvents(fixture.repoRoot, fixture.runId), []);
  assert.equal(fs.existsSync(fixture.worktreePath), true);
  assert.equal(branchExists(fixture.repoRoot, fixture.branch), true);
  assert.equal(remoteBranchExists(fixture.repoRoot, fixture.branch), true);
});

test("finalize-run combined skip-review and force-finalize emits both audit events", () => {
  const fixture = setupRepo({ manifestState: STATES.REVIEW_PENDING });
  const { result, events, logPath, manifestPath } = execFinalize(fixture, {
    extraArgs: [
      "--force-finalize-nonready",
      "--reason", "stuck",
      "--skip-review", "no reviewer",
    ],
  });

  const skipEvent = events.find((entry) => entry.event === "skip_review");
  const forceEvent = events.find((entry) => entry.event === "force_finalize");
  const manifest = readManifest(manifestPath).data;
  const ghLog = fs.readFileSync(logPath, "utf-8");

  assert.equal(result.state, STATES.MERGED);
  assert.equal(skipEvent?.reason, "no reviewer");
  assert.equal(forceEvent?.reason, "stuck");
  assert.equal(forceEvent?.state_from, STATES.REVIEW_PENDING);
  assert.equal(manifest.last_force.reason, "stuck");
  assert.match(ghLog, /pr comment 123 --body/);
  assert.match(ghLog, /pr merge 123 --squash/);
});

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
  assert.equal(result.remoteBranchDeleted, true);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.nextAction, "done");
  assert.equal(result.cleanup.cleanupStatus, "succeeded");
  assert.equal(result.cleanup.worktreeRemoved, true);
  assert.equal(result.cleanup.branchDeleted, true);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(branchExists(repoRoot, branch), false);
  assert.equal(remoteBranchExists(repoRoot, branch), false);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.MERGED);
  assert.equal(manifest.next_action, "done");
  assert.equal(manifest.cleanup.status, "succeeded");
  assert.equal(manifest.cleanup.worktree_removed, true);
  assert.equal(manifest.cleanup.branch_deleted, true);

  const ghLog = fs.readFileSync(logPath, "utf-8");
  assert.match(ghLog, /pr view 123 --json comments,commits/);
  assert.match(ghLog, /pr merge 123 --squash/);
  assert.match(ghLog, /issue close 42 --comment Resolved in PR #123/);
});

test("finalize-run rejects invalid manifest run_id before merge finalization", () => {
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
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    run_id: "../victim-finalize-run",
  }, record.body);

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
  }), (error) => {
    assert.match(String(error.stderr), /run_id must be a single path segment/);
    return true;
  });

  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(branchExists(repoRoot, branch), true);
});

test("finalize-run rejects crafted manifest repo roots before merge or cleanup side effects", () => {
  const { repoRoot, manifestPath, branch, worktreePath, headSha } = setupRepo();
  const attackerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-finalize-attacker-"));
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
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    paths: {
      ...(record.data.paths || {}),
      repo_root: attackerRoot,
      worktree: path.join(attackerRoot, "wt", "issue-42"),
    },
  }, record.body);

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
  }), (error) => {
    assert.match(String(error.stderr), /manifest paths\.repo_root/);
    return true;
  });

  assert.equal(fs.existsSync(worktreePath), true, "finalize-run must reject before cleaning the real worktree");
  assert.equal(branchExists(repoRoot, branch), true);
  assert.equal(readManifest(manifestPath).data.state, STATES.READY_TO_MERGE);
  assert.equal(fs.existsSync(logPath), false);
});

test("finalize-run rejects relay-base same-name worktrees before merge or cleanup side effects", () => {
  const { repoRoot, manifestPath, branch, worktreePath, headSha } = setupRepo();
  const { attackerWorktree } = createUnrelatedRelayOwnedWorktree(repoRoot, branch);
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
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    paths: {
      ...(record.data.paths || {}),
      worktree: attackerWorktree,
    },
  }, record.body);

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
  }), (error) => {
    assert.match(String(error.stderr), /manifest paths\.worktree/);
    return true;
  });

  assert.equal(fs.existsSync(worktreePath), true, "finalize-run must reject before cleaning the real worktree");
  assert.equal(fs.existsSync(path.join(attackerWorktree, "sentinel.txt")), true);
  assert.equal(branchExists(repoRoot, branch), true);
  assert.equal(readManifest(manifestPath).data.state, STATES.READY_TO_MERGE);
  assert.equal(fs.existsSync(logPath), false);
});

test("finalize-run rejects missing relay-base same-name worktrees before merge or cleanup side effects", () => {
  const { repoRoot, manifestPath, branch, worktreePath, headSha } = setupRepo();
  const missingWorktree = createMissingRelayOwnedWorktree(repoRoot);
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
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    paths: {
      ...(record.data.paths || {}),
      worktree: missingWorktree,
    },
  }, record.body);

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
  }), (error) => {
    assert.match(String(error.stderr), /manifest paths\.worktree/);
    return true;
  });

  assert.equal(fs.existsSync(worktreePath), true, "finalize-run must reject before cleaning the real worktree");
  assert.equal(branchExists(repoRoot, branch), true);
  assert.equal(fs.existsSync(missingWorktree), false);
  assert.equal(readManifest(manifestPath).data.state, STATES.READY_TO_MERGE);
  assert.equal(fs.existsSync(logPath), false);
});

test("finalize-run fails closed when branch+PR resolution only finds a stale terminal manifest", () => {
  const { repoRoot, manifestPath, branch } = setupRepo();
  const record = readManifest(manifestPath);
  const staleManifest = {
    ...updateManifestState(record.data, STATES.MERGED, "manual_cleanup_required"),
    git: {
      ...(record.data.git || {}),
      pr_number: null,
    },
  };
  writeManifest(manifestPath, staleManifest, record.body);

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
  }), (error) => {
    assert.match(String(error.stderr), /Only terminal branch matches exist/);
    assert.match(String(error.stderr), /Create a fresh dispatch for this branch before retrying/);
    return true;
  });

  assert.equal(readManifest(manifestPath).data.git.pr_number, null);
});

test("finalize-run --skip-merge --pr resolves a merged manifest and continues cleanup", () => {
  const { repoRoot, manifestPath, branch, worktreePath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(
    manifestPath,
    updateManifestState(record.data, STATES.MERGED, "manual_cleanup_required"),
    record.body
  );

  const logPath = path.join(repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--pr", "123",
    "--skip-merge",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_GH_BIN: fakeGh },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.previousState, STATES.MERGED);
  assert.equal(result.mergePerformed, false);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.nextAction, "done");
  assert.equal(result.cleanup.cleanupStatus, "succeeded");
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(branchExists(repoRoot, branch), false);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.MERGED);
  assert.equal(manifest.cleanup.status, "succeeded");

  const ghLog = fs.readFileSync(logPath, "utf-8");
  assert.doesNotMatch(ghLog, /pr merge 123 --squash/);
  assert.match(ghLog, /issue close 42 --comment Resolved in PR #123/);
});

test("finalize-run keeps standalone --pr hardened for stale merged manifests unless --skip-merge is set", () => {
  const { repoRoot, manifestPath, worktreePath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(
    manifestPath,
    updateManifestState(record.data, STATES.MERGED, "manual_cleanup_required"),
    record.body
  );

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--pr", "123",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }), (error) => {
    assert.match(String(error.stderr), /No relay manifest found for pr '123'/);
    assert.match(String(error.stderr), /Only terminal PR matches exist/);
    return true;
  });

  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(readManifest(manifestPath).data.state, STATES.MERGED);
});

test("finalize-run resumes cleanup when the PR is already merged", () => {
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
    state: "MERGED",
    mergeCommit: { oid: "merged-sha" },
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
  assert.equal(result.mergePerformed, false);
  assert.equal(result.mergeRecovered, true);
  assert.equal(result.remoteBranchDeleted, true);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.nextAction, "done");
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(remoteBranchExists(repoRoot, branch), false);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.MERGED);
  assert.equal(manifest.cleanup.status, "succeeded");

  const ghLog = fs.readFileSync(logPath, "utf-8");
  assert.doesNotMatch(ghLog, /pr merge 123 --squash/);
});

test("finalize-run blocks merge when PR has merge conflicts", () => {
  const { repoRoot, manifestPath, branch } = setupRepo();
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
        oid: execFileSync("git", ["-C", repoRoot, "rev-parse", branch], { encoding: "utf-8", stdio: "pipe" }).trim(),
        committedDate: "2026-04-03T08:00:00Z",
      },
    ],
    mergeable: "CONFLICTING",
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
  }), /merge conflicts with the base branch/);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
});

test("finalize-run blocks merge when CI checks are failing", () => {
  const { repoRoot, manifestPath, branch } = setupRepo();
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
        oid: execFileSync("git", ["-C", repoRoot, "rev-parse", branch], { encoding: "utf-8", stdio: "pipe" }).trim(),
        committedDate: "2026-04-03T08:00:00Z",
      },
    ],
    statusCheckRollup: [
      { name: "lint", conclusion: "SUCCESS" },
      { name: "test-unit", conclusion: "FAILURE" },
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
  }), /failing CI checks: test-unit/);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
});

test("finalize-run preserves terminal state when gh merge does not complete immediately", () => {
  const { repoRoot, manifestPath, branch } = setupRepo();
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
        oid: execFileSync("git", ["-C", repoRoot, "rev-parse", branch], { encoding: "utf-8", stdio: "pipe" }).trim(),
        committedDate: "2026-04-03T08:00:00Z",
      },
    ],
    stateAfterMerge: "OPEN",
    mergeCommitAfterMerge: null,
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
    env: { ...process.env, RELAY_GH_BIN: fakeGh, RELAY_MERGE_QUEUE_POLL_MS: "100", RELAY_MERGE_QUEUE_MAX_POLLS: "1" },
  }), /removed from the merge queue|did not merge after/);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.next_action, "await_explicit_merge");
  assert.equal(remoteBranchExists(repoRoot, branch), true);
});

test("finalize-run recovers when gh merge errors after the PR is already merged", () => {
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
    prMergeExitCode: 1,
    prMergeStderr: "local branch still checked out",
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
  assert.equal(result.mergePerformed, false);
  assert.equal(result.mergeRecovered, true);
  assert.equal(result.remoteBranchDeleted, true);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.nextAction, "done");
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(remoteBranchExists(repoRoot, branch), false);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.MERGED);
  assert.equal(manifest.cleanup.status, "succeeded");
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
  assert.equal(result.remoteBranchDeleted, true);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.nextAction, "manual_cleanup_required");
  assert.equal(result.cleanup.cleanupStatus, "failed");
  assert.match(result.cleanup.error, /dirty worktree/);
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(branchExists(repoRoot, branch), true);
  assert.equal(remoteBranchExists(repoRoot, branch), false);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.MERGED);
  assert.equal(manifest.next_action, "manual_cleanup_required");
  assert.equal(manifest.cleanup.status, "failed");
  assert.match(manifest.cleanup.error, /dirty worktree/);
});

test("finalize-run can derive the repo root from --manifest alone even from an unrelated git repo", () => {
  const { repoRoot, manifestPath, branch, worktreePath, headSha } = setupRepo();
  const selectorRepo = createUnrelatedGitRepo();
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
    cwd: selectorRepo,
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

test("finalize-run accepts a worktree --repo selector and validates against the canonical repo root", () => {
  const { repoRoot, branch, worktreePath, headSha, manifestPath } = setupRepo();
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
    "--repo", worktreePath,
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
  assert.equal(result.branch, branch);
  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.nextAction, "done");
  assert.equal(fs.existsSync(worktreePath), false);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.MERGED);
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

test("finalize-run skip-review journals rubric_status: persisted", () => {
  const { result, events } = runFinalizeSkipReview();
  const skipEvent = events.find((entry) => entry.event === "skip_review");

  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.reviewGate.status, "skipped");
  assert.equal(result.reviewGate.rubricStatus, "persisted");
  assert.equal(skipEvent?.rubric_status, "persisted");
});

test("finalize-run skip-review blocks legacy_grandfather_field instead of merging", () => {
  const fixture = setupRepo();
  createEnforcementFixture({
    repoRoot: fixture.repoRoot,
    runId: fixture.runId,
    manifestPath: fixture.manifestPath,
    state: "loaded",
    anchorOverrides: { rubric_grandfathered: true },
  });
  const logPath = path.join(fixture.repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    comments: [],
    commits: [
      {
        oid: fixture.headSha,
        committedDate: "2026-04-03T08:00:00Z",
      },
    ],
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", fixture.repoRoot,
    "--branch", fixture.branch,
    "--pr", "123",
    "--skip-review", "hotfix",
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, RELAY_GH_BIN: fakeGh },
  }), /Fresh review gate failed: unsupported_grandfather_field/);

  const manifest = readManifest(fixture.manifestPath).data;
  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  const skipEvent = events.find((entry) => entry.event === "skip_review");
  const mergeBlockedEvent = events.find((entry) => entry.event === "merge_blocked");
  const ghLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";

  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(skipEvent, undefined);
  assert.equal(mergeBlockedEvent?.reason, "unsupported_grandfather_field");
  assert.doesNotMatch(ghLog, /rubric_status: legacy_grandfather_field/);
  assert.doesNotMatch(ghLog, /rubric_grandfathered\./);
});

test("finalize-run skip-review with a missing rubric merges and records rubric_status: missing in comment and events", () => {
  const { result, events, logPath } = runFinalizeSkipReview({ enforcementState: "missing" });
  const skipEvent = events.find((entry) => entry.event === "skip_review");

  assert.equal(result.state, STATES.MERGED);
  assert.equal(result.reviewGate.status, "skipped");
  assert.equal(result.reviewGate.rubricStatus, "missing");
  assert.equal(skipEvent?.rubric_status, "missing");
  assert.equal(skipEvent?.reason, "hotfix");
  assert.match(fs.readFileSync(logPath, "utf-8"), /rubric_status: missing/);
});
