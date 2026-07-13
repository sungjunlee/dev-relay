const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("child_process");
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
const { readRunEvents } = require("../../../skills/relay-dispatch/scripts/relay-events");
const { createEnforcementFixture } = require("../../relay-dispatch/scripts/test-support");
const {
  getAdvisoryLaneLeasePath,
  isProcessGroupAlive,
  writeAdvisoryLaneLease,
} = require("../../../skills/relay-dispatch/scripts/run-runtime-state");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-merge", "scripts", "finalize-run.js");
const TERM_IGNORING_LANE = path.join(__dirname, "..", "fixtures", "term-ignoring-lane.js");
const DEFAULT_COMMIT_DATE = "2026-04-03T08:00:00Z";
const DEFAULT_REVIEW_COMMENT = {
  body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
  createdAt: DEFAULT_COMMIT_DATE,
};

function buildReadyManifest(manifest) {
  let next = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  next = updateManifestState(next, STATES.REVIEW_PENDING, "run_review");
  next = updateManifestState(next, STATES.READY_TO_MERGE, "await_explicit_merge");
  return {
    ...next,
    review: {
      ...(next.review || {}),
      last_reviewed_sha: next.git?.head_sha || null,
      latest_verdict: "lgtm",
      rounds: 1,
    },
  };
}

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-finalize-lane-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-lane-"));
  const originRoot = path.join(repoRoot, "origin.git");
  execFileSync("git", ["init", "--bare", originRoot], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Merge Lane Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-merge-lane@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", originRoot], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const branch = "issue-963";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(worktreePath, "smoke.txt"), "ok\n", "utf-8");
  execFileSync("git", ["-C", worktreePath, "add", "smoke.txt"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "commit", "-m", "Add smoke"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "push", "-u", "origin", branch], { encoding: "utf-8", stdio: "pipe" });
  const headSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();

  const runId = createRunId({
    branch,
    timestamp: new Date("2026-07-12T07:00:00.000Z"),
  });
  const { manifestPath, runDir } = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 963,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest.anchor = createEnforcementFixture({
    repoRoot,
    runId,
    state: "loaded",
  }).anchor;
  manifest.git.pr_number = 123;
  manifest.git.head_sha = headSha;
  manifest = buildReadyManifest(manifest);
  writeManifest(manifestPath, manifest);

  return { repoRoot, manifestPath, branch, worktreePath, headSha, runId, runDir };
}

function writeFakeGh(logPath, {
  comments = [DEFAULT_REVIEW_COMMENT],
  commits = [],
  headRefName = "issue-963",
} = {}) {
  const ghPath = path.join(path.dirname(logPath), "fake-gh-lane.js");
  const statePath = path.join(path.dirname(logPath), "fake-gh-lane-state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    headRefName,
    baseRefName: "main",
    defaultBranchName: "main",
    comments,
    commits,
    state: "OPEN",
    mergeCommit: null,
    mergeable: "MERGEABLE",
    statusCheckRollup: [{ name: "unit", conclusion: "SUCCESS", status: "COMPLETED" }],
    stateAfterMerge: "MERGED",
    mergeCommitAfterMerge: { oid: "merged-sha" },
    prMergeExitCode: 0,
    prMergeStderr: "",
    title: "fix(relay): advisory lane reap",
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
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  const state = loadState();
  process.stdout.write(JSON.stringify({
    headRefName: state.headRefName,
    baseRefName: state.baseRefName,
    state: state.state,
    mergeCommit: state.mergeCommit,
    comments: state.comments,
    commits: state.commits,
    mergeable: state.mergeable,
    statusCheckRollup: state.statusCheckRollup,
    title: state.title,
    headRefOid: state.commits[0]?.oid || null,
  }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write("[]");
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view") {
  const state = loadState();
  process.stdout.write(JSON.stringify({
    defaultBranchRef: { name: state.defaultBranchName },
  }));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "close") {
  process.exit(0);
}
process.exit(0);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return ghPath;
}

function execFinalize(fixture, { extraArgs = [], env = {} } = {}) {
  const logPath = path.join(fixture.repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    comments: [DEFAULT_REVIEW_COMMENT],
    commits: [{ oid: fixture.headSha, committedDate: DEFAULT_COMMIT_DATE }],
  });
  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", fixture.repoRoot,
    "--branch", fixture.branch,
    "--pr", "123",
    "--no-issue-close",
    ...extraArgs,
    "--json",
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      RELAY_GH_BIN: fakeGh,
      RELAY_ADVISORY_LANE_REAP_GRACE_MS: "400",
      ...env,
    },
  });
  return {
    ...fixture,
    logPath,
    result: JSON.parse(stdout),
    events: readRunEvents(fixture.repoRoot, fixture.runId),
  };
}

function spawnTermIgnoringLane() {
  const child = spawn(process.execPath, [TERM_IGNORING_LANE], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  assert.ok(Number.isInteger(child.pid) && child.pid > 0);
  // Detached spawn → pgid == pid.
  assert.equal(isProcessGroupAlive(child.pid), true);
  return child.pid;
}

function forceKillPgid(pgid) {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {}
}

test("finalize-run reaps a live TERM-ignoring advisory lane before worktree removal", () => {
  const fixture = setupRepo();
  const pgid = spawnTermIgnoringLane();
  const leasePath = getAdvisoryLaneLeasePath(fixture.runDir, 1, "codex");
  try {
    writeAdvisoryLaneLease(fixture.runDir, {
      pid: pgid,
      pgid,
      round: 1,
      reviewer: "codex",
    });
    assert.equal(fs.existsSync(leasePath), true);
    assert.equal(fs.existsSync(fixture.worktreePath), true);

    const { result } = execFinalize(fixture);

    assert.equal(isProcessGroupAlive(pgid), false);
    assert.equal(fs.existsSync(leasePath), false);
    assert.equal(fs.existsSync(fixture.worktreePath), false);
    assert.ok(Array.isArray(result.advisoryLaneReaps));
    assert.equal(result.advisoryLaneReaps.length, 1);
    assert.deepEqual(result.advisoryLaneReaps[0], {
      pgid,
      pid: pgid,
      reviewer: "codex",
      round: 1,
      host: os.hostname(),
      leasePath,
      outcome: "reaped",
      signaled_kill: true,
    });
    assert.equal(result.cleanup.worktreeRemoved, true);
  } finally {
    forceKillPgid(pgid);
  }
});

test("finalize-run removes a stale dead-pid advisory lane lease without signaling", () => {
  const fixture = setupRepo();
  const deadPgid = 2147483646;
  assert.equal(isProcessGroupAlive(deadPgid), false);
  const leasePath = getAdvisoryLaneLeasePath(fixture.runDir, 1, "opencode");
  writeAdvisoryLaneLease(fixture.runDir, {
    pid: deadPgid,
    pgid: deadPgid,
    round: 1,
    reviewer: "opencode",
  });

  const { result } = execFinalize(fixture);

  assert.equal(fs.existsSync(leasePath), false);
  assert.equal(result.advisoryLaneReaps.length, 1);
  assert.equal(result.advisoryLaneReaps[0].outcome, "stale");
  assert.equal(result.advisoryLaneReaps[0].pgid, deadPgid);
  assert.equal(result.advisoryLaneReaps[0].reviewer, "opencode");
  assert.equal(result.cleanup.worktreeRemoved, true);
});

test("finalize-run skips host-mismatch advisory lane leases and leaves the process alive", () => {
  const fixture = setupRepo();
  const pgid = spawnTermIgnoringLane();
  const leasePath = getAdvisoryLaneLeasePath(fixture.runDir, 2, "pi");
  try {
    writeAdvisoryLaneLease(fixture.runDir, {
      pid: pgid,
      pgid,
      host: "foreign.example.invalid",
      round: 2,
      reviewer: "pi",
    });

    const { result } = execFinalize(fixture);

    assert.equal(isProcessGroupAlive(pgid), true);
    assert.equal(fs.existsSync(leasePath), true);
    assert.equal(result.advisoryLaneReaps.length, 1);
    assert.equal(result.advisoryLaneReaps[0].outcome, "skipped_host_mismatch");
    assert.equal(result.advisoryLaneReaps[0].pgid, pgid);
    assert.equal(result.advisoryLaneReaps[0].reviewer, "pi");
  } finally {
    forceKillPgid(pgid);
  }
});

test("finalize-run --dry-run reports would_reap and leaves the lane process alive", () => {
  const fixture = setupRepo();
  const pgid = spawnTermIgnoringLane();
  const leasePath = getAdvisoryLaneLeasePath(fixture.runDir, 1, "codex");
  try {
    writeAdvisoryLaneLease(fixture.runDir, {
      pid: pgid,
      pgid,
      round: 1,
      reviewer: "codex",
    });

    const { result } = execFinalize(fixture, { extraArgs: ["--dry-run"] });

    assert.equal(result.dryRun, true);
    assert.equal(isProcessGroupAlive(pgid), true);
    assert.equal(fs.existsSync(leasePath), true);
    assert.equal(fs.existsSync(fixture.worktreePath), true);
    assert.equal(result.advisoryLaneReaps.length, 1);
    assert.equal(result.advisoryLaneReaps[0].outcome, "would_reap");
    assert.equal(result.advisoryLaneReaps[0].pgid, pgid);
  } finally {
    forceKillPgid(pgid);
  }
});

test("finalize-run with no advisory lane leases omits advisoryLaneReaps (byte-identical idle shape)", () => {
  const fixture = setupRepo();
  const { result } = execFinalize(fixture);
  assert.equal("advisoryLaneReaps" in result, false);
  assert.equal(result.cleanup.worktreeRemoved, true);
});

test("finalize-run reaps two coexisting per-attempt lane leases for the same reviewer", () => {
  const fixture = setupRepo();
  const pgid1 = spawnTermIgnoringLane();
  const pgid2 = spawnTermIgnoringLane();
  try {
    const first = writeAdvisoryLaneLease(fixture.runDir, {
      pid: pgid1,
      pgid: pgid1,
      round: 1,
      reviewer: "codex",
    });
    const second = writeAdvisoryLaneLease(fixture.runDir, {
      pid: pgid2,
      pgid: pgid2,
      round: 1,
      reviewer: "codex",
    });
    assert.equal(first.lease.attempt, 1);
    assert.equal(second.lease.attempt, 2);
    assert.notEqual(first.leasePath, second.leasePath);

    const { result } = execFinalize(fixture);

    assert.equal(isProcessGroupAlive(pgid1), false);
    assert.equal(isProcessGroupAlive(pgid2), false);
    assert.equal(fs.existsSync(first.leasePath), false);
    assert.equal(fs.existsSync(second.leasePath), false);
    assert.equal(result.advisoryLaneReaps.length, 2);
    const byPgid = new Map(result.advisoryLaneReaps.map((entry) => [entry.pgid, entry]));
    assert.equal(byPgid.get(pgid1).outcome, "reaped");
    assert.equal(byPgid.get(pgid2).outcome, "reaped");
    assert.equal(byPgid.get(pgid1).signaled_kill, true);
    assert.equal(byPgid.get(pgid2).signaled_kill, true);
  } finally {
    forceKillPgid(pgid1);
    forceKillPgid(pgid2);
  }
});
