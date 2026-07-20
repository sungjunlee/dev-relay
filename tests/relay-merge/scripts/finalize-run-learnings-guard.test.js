// canary: bare-string `event === "..."` reader assertions in this file are deliberate canaries against EVENTS schema drift; do not port to EVENTS.X (see #313).
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
  readManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { createEnforcementFixture } = require("../../relay-dispatch/scripts/test-support");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-merge", "scripts", "finalize-run.js");
const DEFAULT_COMMIT_DATE = "2026-04-03T08:00:00Z";

function buildReadyToMergeManifest(manifest) {
  const dispatched = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  const reviewPending = updateManifestState(dispatched, STATES.REVIEW_PENDING, "run_review");
  const withReview = {
    ...reviewPending,
    review: {
      ...(reviewPending.review || {}),
      last_reviewed_sha: reviewPending.git?.head_sha || null,
      latest_verdict: "pending",
      rounds: 1,
    },
  };
  const ready = updateManifestState(withReview, STATES.READY_TO_MERGE, "await_explicit_merge");
  return {
    ...ready,
    review: {
      ...(ready.review || {}),
      latest_verdict: "lgtm",
    },
  };
}

function seedCapabilitiesForLearning(repoRoot) {
  fs.mkdirSync(path.join(repoRoot, "spec"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "backlog", "sprints"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "spec", "capabilities.md"), `# Test Capabilities

## Capability: merge-finalize

**Goal:** test learning writes

### Learnings
<!-- LEARN:BEGIN -->
<!-- LEARN:END -->
`, "utf-8");
  fs.writeFileSync(path.join(repoRoot, "backlog", "sprints", "2026-05-test.md"), `---
status: active
component: "merge-finalize"
---

# Test Sprint
`, "utf-8");
  execFileSync("git", ["add", "spec/capabilities.md", "backlog/sprints/2026-05-test.md"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  execFileSync("git", ["commit", "-m", "Seed capabilities"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  execFileSync("git", ["push", "origin", "main"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

function setupRepoOnUnexpectedBranch() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-finalize-guard-"));
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

  seedCapabilitiesForLearning(repoRoot);

  const branch = "issue-42";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(worktreePath, "smoke.txt"), "ok\n", "utf-8");
  execFileSync("git", ["-C", worktreePath, "add", "smoke.txt"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "commit", "-m", "Add smoke"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "push", "-u", "origin", branch], { encoding: "utf-8", stdio: "pipe" });
  const headSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();

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
    state: "loaded",
  }).anchor;
  manifest.git.pr_number = 123;
  manifest.git.head_sha = headSha;
  manifest = buildReadyToMergeManifest(manifest);
  writeManifest(manifestPath, manifest);

  const unexpectedBranch = "worktree-809-stray";
  execFileSync("git", ["checkout", "-b", unexpectedBranch], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });

  return { repoRoot, branch, headSha, unexpectedBranch, runId, manifestPath };
}

/**
 * Canonical checkout genuinely diverges from origin/main: the stray branch
 * lacks backlog/sprints and the capability block that exist on the remote base.
 */
function setupRepoWithDivergentCanonicalCheckout() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-finalize-divergent-"));
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
  const rootCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();

  // Seed learning files onto main / origin only (after recording the root).
  seedCapabilitiesForLearning(repoRoot);

  const branch = "issue-42";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(worktreePath, "smoke.txt"), "ok\n", "utf-8");
  execFileSync("git", ["-C", worktreePath, "add", "smoke.txt"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "commit", "-m", "Add smoke"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", worktreePath, "push", "-u", "origin", branch], { encoding: "utf-8", stdio: "pipe" });
  const headSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();

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
    state: "loaded",
  }).anchor;
  manifest.git.pr_number = 123;
  manifest.git.head_sha = headSha;
  manifest = buildReadyToMergeManifest(manifest);
  writeManifest(manifestPath, manifest);

  // Move the canonical checkout back to the pre-seed root so it lacks
  // backlog/capabilities that exist on origin/main.
  const unexpectedBranch = "divergent-no-backlog";
  execFileSync("git", ["checkout", "-b", unexpectedBranch, rootCommit], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.appendFileSync(path.join(repoRoot, "README.md"), "local dirt\n", "utf-8");

  assert.equal(fs.existsSync(path.join(repoRoot, "spec", "capabilities.md")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "backlog", "sprints")), false);

  return { repoRoot, branch, headSha, unexpectedBranch, runId, manifestPath };
}

function snapshotCanonical(repoRoot) {
  const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  const branch = currentBranch(repoRoot);
  // Tracked-only: finalize cleanup may remove retained worktrees / create
  // untracked helper files; those must not mask canonical-independence checks.
  const trackedStatus = execFileSync(
    "git",
    ["-C", repoRoot, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf-8", stdio: "pipe" }
  );
  return { head, branch, trackedStatus };
}

function writeFakeGh(logPath, { headRefName, commits, issueBody = null }) {
  const ghPath = path.join(path.dirname(logPath), "fake-gh.js");
  const statePath = path.join(path.dirname(logPath), "fake-gh-state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    headRefName,
    baseRefName: "main",
    defaultBranchName: "main",
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: LGTM\nRounds: 1",
        createdAt: DEFAULT_COMMIT_DATE,
      },
    ],
    commits,
    state: "OPEN",
    mergeCommit: null,
    mergeable: "MERGEABLE",
    statusCheckRollup: [],
    stateAfterMerge: "MERGED",
    mergeCommitAfterMerge: { oid: "merged-sha" },
    issueBody,
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
    statusCheckRollup: state.statusCheckRollup
  }));
}
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write("[]");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  const state = loadState();
  process.stdout.write(JSON.stringify({ body: state.issueBody || "" }));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "close") {
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view") {
  const state = loadState();
  process.stdout.write(JSON.stringify({
    defaultBranchRef: {
      name: state.defaultBranchName
    }
  }));
  process.exit(0);
}
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return ghPath;
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

function currentBranch(repoRoot) {
  return execFileSync("git", ["-C", repoRoot, "symbolic-ref", "--short", "HEAD"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

test("finalize-run writes durable learnings without depending on canonical branch (#955 / #809)", () => {
  const { repoRoot, branch, headSha, unexpectedBranch, runId } = setupRepoOnUnexpectedBranch();
  const before = snapshotCanonical(repoRoot);
  const capabilitiesPath = path.join(repoRoot, "spec", "capabilities.md");
  const beforeCapabilities = fs.readFileSync(capabilitiesPath, "utf-8");
  assert.equal(remoteBranchExists(repoRoot, unexpectedBranch), false);
  assert.equal(before.branch, unexpectedBranch);

  const logPath = path.join(repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    headRefName: branch,
    commits: [
      {
        oid: headSha,
        committedDate: DEFAULT_COMMIT_DATE,
      },
    ],
    issueBody: "component: merge-finalize\n\nStandalone derive path.",
  });

  const stdout = execFileSync(process.execPath, [
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
  assert.equal(result.learnings.status, "appended");
  assert.equal(result.learnings.durability.status, "pushed");
  assert.equal(result.learnings.canonicalUntouched, true);
  assert.equal(result.learnings.sprintFile, path.join(repoRoot, "backlog", "sprints", "2026-05-test.md"));
  assert.doesNotMatch(String(result.learnings.sprintFile || ""), /relay-learn-/);
  assert.deepEqual(snapshotCanonical(repoRoot), before);
  assert.equal(remoteBranchExists(repoRoot, unexpectedBranch), false);
  // Canonical checkout file content is unchanged; durability lands on origin/main.
  assert.equal(fs.readFileSync(capabilitiesPath, "utf-8"), beforeCapabilities);
  execFileSync("git", ["-C", repoRoot, "fetch", "origin", "main"], { encoding: "utf-8", stdio: "pipe" });
  const remoteCapabilities = execFileSync(
    "git",
    ["-C", repoRoot, "show", "origin/main:spec/capabilities.md"],
    { encoding: "utf-8", stdio: "pipe" }
  );
  assert.match(remoteCapabilities, new RegExp(`run #${runId}`));
});

test("finalize-run durable learnings succeed while canonical checkout is dirty", () => {
  const { repoRoot, branch, headSha, unexpectedBranch, runId } = setupRepoOnUnexpectedBranch();
  fs.appendFileSync(path.join(repoRoot, "README.md"), "local dirt\n", "utf-8");
  const before = snapshotCanonical(repoRoot);
  assert.match(before.trackedStatus, /README\.md/);

  const logPath = path.join(repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    headRefName: branch,
    commits: [{ oid: headSha, committedDate: DEFAULT_COMMIT_DATE }],
  });

  const stdout = execFileSync(process.execPath, [
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
  assert.equal(result.learnings.status, "appended");
  assert.equal(result.learnings.durability.status, "pushed");
  assert.deepEqual(snapshotCanonical(repoRoot), before);
  execFileSync("git", ["-C", repoRoot, "fetch", "origin", "main"], { encoding: "utf-8", stdio: "pipe" });
  const remoteCapabilities = execFileSync(
    "git",
    ["-C", repoRoot, "show", "origin/main:spec/capabilities.md"],
    { encoding: "utf-8", stdio: "pipe" }
  );
  assert.match(remoteCapabilities, new RegExp(`run #${runId}`));
});

test("finalize-run writes learnings from remote tip when canonical backlog/capabilities diverge", () => {
  const { repoRoot, branch, headSha, unexpectedBranch, runId } = setupRepoWithDivergentCanonicalCheckout();
  const before = snapshotCanonical(repoRoot);
  assert.equal(before.branch, unexpectedBranch);
  assert.equal(fs.existsSync(path.join(repoRoot, "spec", "capabilities.md")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "backlog", "sprints")), false);

  const logPath = path.join(repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    headRefName: branch,
    commits: [{ oid: headSha, committedDate: DEFAULT_COMMIT_DATE }],
    issueBody: "component: merge-finalize\n\nDerive despite divergent checkout.",
  });

  const stdout = execFileSync(process.execPath, [
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
  assert.equal(result.learnings.status, "appended");
  assert.equal(result.learnings.durability.status, "pushed");
  assert.equal(result.learnings.sprintFile, path.join(repoRoot, "backlog", "sprints", "2026-05-test.md"));
  assert.doesNotMatch(String(result.learnings.sprintFile || ""), /\/tmp\/relay-learn-/);
  assert.deepEqual(snapshotCanonical(repoRoot), before);
  assert.equal(fs.existsSync(path.join(repoRoot, "spec", "capabilities.md")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "backlog", "sprints")), false);

  execFileSync("git", ["-C", repoRoot, "fetch", "origin", "main"], { encoding: "utf-8", stdio: "pipe" });
  const remoteCapabilities = execFileSync(
    "git",
    ["-C", repoRoot, "show", "origin/main:spec/capabilities.md"],
    { encoding: "utf-8", stdio: "pipe" }
  );
  assert.match(remoteCapabilities, new RegExp(`run #${runId}`));
});

test("finalize-run threads manifest ownership through the durable learnings seam", () => {
  const { repoRoot, branch, headSha, runId, manifestPath } = setupRepoOnUnexpectedBranch();
  const before = snapshotCanonical(repoRoot);

  const record = readManifest(manifestPath);
  record.data.ownership = {
    sprint: "backlog/sprints/2026-05-test.md",
    component: "merge-finalize",
  };
  writeManifest(manifestPath, record.data, record.body);

  const logPath = path.join(repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    headRefName: branch,
    commits: [{ oid: headSha, committedDate: DEFAULT_COMMIT_DATE }],
    // No issue body — ownership must come from the manifest seam.
    issueBody: null,
  });

  const stdout = execFileSync(process.execPath, [
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
  assert.equal(result.learnings.status, "appended");
  assert.equal(result.learnings.durability.status, "pushed");
  assert.equal(result.learnings.owner?.source, "fleet");
  assert.equal(result.learnings.owner?.component, "merge-finalize");
  assert.equal(result.learnings.sprintFile, path.join(repoRoot, "backlog", "sprints", "2026-05-test.md"));
  assert.deepEqual(snapshotCanonical(repoRoot), before);
  execFileSync("git", ["-C", repoRoot, "fetch", "origin", "main"], { encoding: "utf-8", stdio: "pipe" });
  const remoteCapabilities = execFileSync(
    "git",
    ["-C", repoRoot, "show", "origin/main:spec/capabilities.md"],
    { encoding: "utf-8", stdio: "pipe" }
  );
  assert.match(remoteCapabilities, new RegExp(`run #${runId}`));
});

test("finalize-run learning push recovers from a just-merged remote advance race", () => {
  const { repoRoot, branch, headSha, runId } = setupRepoOnUnexpectedBranch();
  const originRoot = path.join(repoRoot, "origin.git");

  const logPath = path.join(repoRoot, "gh.log");
  const fakeGh = writeFakeGh(logPath, {
    headRefName: branch,
    commits: [{ oid: headSha, committedDate: DEFAULT_COMMIT_DATE }],
  });

  // On the first learning push (HEAD:refs/heads/main), advance the bare remote
  // with an empty commit so the push is rejected non-fast-forward, then retry.
  const gitWrapper = path.join(repoRoot, "fake-git-race.js");
  const marker = path.join(repoRoot, "race-fired");
  fs.writeFileSync(gitWrapper, `#!/usr/bin/env node
const { spawnSync } = require("child_process");
const fs = require("fs");
const args = process.argv.slice(2);
const marker = ${JSON.stringify(marker)};
const bare = ${JSON.stringify(originRoot)};
function gitBare(bareArgs) {
  return spawnSync("git", ["--git-dir", bare, ...bareArgs], { encoding: "utf-8" });
}
const isLearningPush = args.includes("push") && args.some((a) => String(a).startsWith("HEAD:refs/heads/main"));
if (isLearningPush && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, "1");
  const tree = gitBare(["rev-parse", "main^{tree}"]).stdout.trim();
  const parent = gitBare(["rev-parse", "main"]).stdout.trim();
  const commit = gitBare(["commit-tree", tree, "-p", parent, "-m", "race advance"]).stdout.trim();
  gitBare(["update-ref", "refs/heads/main", commit]);
}
const result = spawnSync("git", args, { encoding: "utf-8" });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status == null ? 1 : result.status);
`, "utf-8");
  fs.chmodSync(gitWrapper, 0o755);

  const stdout = execFileSync(process.execPath, [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", branch,
    "--pr", "123",
    "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      RELAY_GH_BIN: fakeGh,
      RELAY_GIT_BIN: gitWrapper,
    },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.learnings.status, "appended");
  assert.equal(result.learnings.durability.status, "pushed");
  assert.ok((result.learnings.pushAttempts || result.learnings.durability.attempts) >= 2);
  assert.equal(fs.existsSync(marker), true);
  execFileSync("git", ["-C", repoRoot, "fetch", "origin", "main"], { encoding: "utf-8", stdio: "pipe" });
  const remoteLog = execFileSync("git", ["-C", repoRoot, "log", "--oneline", "origin/main"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  assert.match(remoteLog, /Record relay learning/);
  assert.match(remoteLog, /race advance/);
  const remoteCapabilities = execFileSync(
    "git",
    ["-C", repoRoot, "show", "origin/main:spec/capabilities.md"],
    { encoding: "utf-8", stdio: "pipe" }
  );
  assert.match(remoteCapabilities, new RegExp(`run #${runId}`));
});
