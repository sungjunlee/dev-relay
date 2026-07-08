const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createWorktree,
  formatDispatchDryRun,
  formatPlan,
  removeWorktree,
} = require("../../../skills/relay-dispatch/scripts/worktree-runtime");

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "worktree-runtime");

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-worktree-runtime-"));
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Runtime Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-runtime@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return { root, repoRoot };
}

function revParse(repoRoot, ref) {
  return execFileSync("git", ["rev-parse", ref], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

function commitFile(repoRoot, fileName, content, message) {
  fs.writeFileSync(path.join(repoRoot, fileName), content, "utf-8");
  execFileSync("git", ["add", fileName], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", message], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return revParse(repoRoot, "HEAD");
}

test("formatPlan matches the frozen create-worktree text fixture", () => {
  const actual = formatPlan({
    worktreePath: "/tmp/issue187-fixtures/relay-home/worktrees/11111111/repo",
    branch: "codex/wt-11111111-repo",
    title: "Worktree: repo",
    register: false,
    pin: false,
    includeFiles: [],
  });
  const expected = fs.readFileSync(path.join(FIXTURE_DIR, "create-dry-run.txt"), "utf-8").trimEnd();
  assert.equal(actual, expected);
});

test("formatDispatchDryRun matches the frozen dispatch text fixture", () => {
  const frozenJson = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "dispatch-dry-run.json"), "utf-8"));
  const actual = formatDispatchDryRun({
    runId: "test-branch-20260418005000000-22222222",
    mode: "new",
    executor: "codex",
    repoRoot: "/tmp/issue187-fixtures/repo",
    manifestPath: "/tmp/issue187-fixtures/relay-home/runs/repo-c079affd/test-branch-20260418005000000-22222222.md",
    prompt: "task",
    model: null,
    sandbox: "workspace-write",
    register: false,
    resultFile: "/tmp/issue187-fixtures/relay-home/runs/repo-c079affd/test-branch-20260418005000000-22222222/dispatch-result.txt",
    cleanupPolicy: "on_close",
    timeout: 2400,
    rubricFile: "/tmp/issue187-fixtures/rubric.yaml",
    reviewAssurance: "standard",
    policyDecision: frozenJson.policy_decision,
    routingDecision: frozenJson.routing_decision,
    worktreePlan: {
      worktree: "/tmp/issue187-fixtures/relay-home/worktrees/11111111/repo",
      branch: "test-branch",
      worktreeinclude: [],
    },
  });
  const expected = fs.readFileSync(path.join(FIXTURE_DIR, "dispatch-dry-run.txt"), "utf-8").trimEnd();
  assert.equal(actual, expected);
});

test("formatDispatchDryRun formats advisory lane arrays without object coercion", () => {
  const actual = formatDispatchDryRun({
    runId: "lane-array-1",
    mode: "new",
    executor: "codex",
    repoRoot: "/tmp/repo",
    manifestPath: "/tmp/manifest.md",
    prompt: "task",
    model: null,
    sandbox: "workspace-write",
    register: false,
    resultFile: "/tmp/result.txt",
    cleanupPolicy: "on_close",
    timeout: 2400,
    routingDecision: {
      matched: true,
      matched_rule: { name: "docs", index: 0 },
      source_tags: { cli: ["docs"] },
      effective_tags: ["docs"],
      selected: {
        advisory_review: [
          {
            reviewer: "opencode",
            profile: "blindspot",
            model: "example/opencode-model-fast",
          },
          {
            reviewer: "pi",
            profile: "blindspot",
            trigger: "on_pass",
            gating: true,
          },
        ],
      },
    },
    worktreePlan: {
      worktree: "/tmp/worktree",
      branch: "issue-lanes",
      worktreeinclude: [],
    },
  });

  assert.match(
    actual,
    /Selected: advisory_review=opencode\/blindspot model=example\/opencode-model-fast, pi\/blindspot trigger=on_pass gating=true/
  );
  assert.doesNotMatch(actual, /\[object Object\]/);
});

test("formatDispatchDryRun formats legacy single advisory reviewer_model selections", () => {
  const actual = formatDispatchDryRun({
    runId: "legacy-object-1",
    mode: "new",
    executor: "codex",
    repoRoot: "/tmp/repo",
    manifestPath: "/tmp/manifest.md",
    prompt: "task",
    model: null,
    sandbox: "workspace-write",
    register: false,
    resultFile: "/tmp/result.txt",
    cleanupPolicy: "on_close",
    timeout: 2400,
    routingDecision: {
      matched: true,
      matched_rule: { name: "legacy", index: 0 },
      source_tags: { cli: ["compat"] },
      effective_tags: ["compat"],
      selected: {
        advisory_review: {
          reviewer: "cline",
          reviewer_model: "cline-pass/glm-5.2",
        },
      },
    },
    worktreePlan: {
      worktree: "/tmp/worktree",
      branch: "issue-legacy",
      worktreeinclude: [],
    },
  });

  assert.match(actual, /Selected: advisory_review=cline\/blindspot model=cline-pass\/glm-5.2/);
});

test("createWorktree dry-run returns the frozen fixture shape", () => {
  const actual = createWorktree({
    repoRoot: "/tmp/issue187-fixtures/repo",
    worktreePath: "/tmp/issue187-fixtures/relay-home/worktrees/11111111/repo",
    branch: "codex/wt-11111111-repo",
    title: "Worktree: repo",
    register: false,
    pin: false,
    dryRun: true,
    includeFiles: [],
  });
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "create-dry-run.json"), "utf-8"));
  assert.deepEqual(actual, expected);
});

test("createWorktree creates a fresh branch and worktree", () => {
  const { repoRoot, root } = setupRepo();
  const worktreePath = path.join(root, "worktrees", "fresh", "repo");

  const result = createWorktree({
    repoRoot,
    worktreePath,
    branch: "issue-187-fresh",
    title: "Dispatch: issue-187-fresh",
    copyFiles: [],
  });

  assert.equal(result.worktree, worktreePath);
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(
    execFileSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim(),
    "issue-187-fresh"
  );
});

test("createWorktree creates a fresh branch from an explicit start point", () => {
  const { repoRoot, root } = setupRepo();
  const startPoint = revParse(repoRoot, "HEAD");
  commitFile(repoRoot, "later.txt", "later\n", "later");
  const worktreePath = path.join(root, "worktrees", "start-point", "repo");

  createWorktree({
    repoRoot,
    worktreePath,
    branch: "issue-795-start-point",
    title: "Dispatch: issue-795-start-point",
    startPoint,
    copyFiles: [],
  });

  assert.equal(revParse(worktreePath, "HEAD"), startPoint);
});

test("createWorktree falls back to an existing branch when -b creation fails", () => {
  const { repoRoot, root } = setupRepo();
  const branch = "issue-187-existing";
  const worktreePath = path.join(root, "worktrees", "existing", "repo");
  execFileSync("git", ["branch", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const result = createWorktree({
    repoRoot,
    worktreePath,
    branch,
    title: "Dispatch: issue-187-existing",
    copyFiles: [],
  });

  assert.equal(result.worktree, worktreePath);
  assert.equal(
    execFileSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim(),
    branch
  );
});

test("createWorktree existing-branch fallback ignores the start point", () => {
  const { repoRoot, root } = setupRepo();
  const branch = "issue-795-existing";
  const branchHead = revParse(repoRoot, "HEAD");
  execFileSync("git", ["branch", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const laterHead = commitFile(repoRoot, "later-existing.txt", "later\n", "later existing");
  const worktreePath = path.join(root, "worktrees", "existing-start-point", "repo");

  createWorktree({
    repoRoot,
    worktreePath,
    branch,
    title: "Dispatch: issue-795-existing",
    startPoint: laterHead,
    copyFiles: [],
  });

  assert.equal(revParse(worktreePath, "HEAD"), branchHead);
});

test("createWorktree forwards registration args through an adapter callback", () => {
  const { repoRoot, root } = setupRepo();
  const worktreePath = path.join(root, "worktrees", "register", "repo");
  const calls = [];

  const result = createWorktree({
    repoRoot,
    worktreePath,
    branch: "issue-187-register",
    title: "Pinned Register",
    register: true,
    registerFn(options) {
      calls.push(options);
      return { threadId: "thread-123" };
    },
    pin: true,
    copyFiles: [],
  });

  assert.equal(result.threadId, "thread-123");
  assert.deepEqual(calls, [{
    wtPath: worktreePath,
    repoPath: repoRoot,
    branch: "issue-187-register",
    title: "Pinned Register",
    pin: true,
  }]);
});

test("createWorktree removes the created worktree when a post-create step fails", () => {
  const { repoRoot, root } = setupRepo();
  const worktreePath = path.join(root, "worktrees", "cleanup", "repo");

  assert.throws(() => {
    createWorktree({
      repoRoot,
      worktreePath,
      branch: "issue-187-cleanup",
      title: "Cleanup Test",
      register: true,
      registerFn() {
        throw new Error("simulated register failure");
      },
      copyFiles: [],
    });
  }, /simulated register failure/);

  assert.equal(fs.existsSync(worktreePath), false);
});

test("removeWorktree is idempotent when the target worktree does not exist", () => {
  const { repoRoot, root } = setupRepo();
  const missingPath = path.join(root, "worktrees", "missing", "repo");
  assert.doesNotThrow(() => {
    removeWorktree({ repoRoot, worktreePath: missingPath });
  });
});
