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
} = require("./worktree-runtime");

const FIXTURE_DIR = path.join(__dirname, "__fixtures__", "worktree-runtime");

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
    resultFile: "/tmp/issue187-fixtures/tmp/dispatch-codex-11111111.txt",
    cleanupPolicy: "on_close",
    timeout: 2400,
    rubricFile: "/tmp/issue187-fixtures/rubric.yaml",
    worktreePlan: {
      worktree: "/tmp/issue187-fixtures/relay-home/worktrees/11111111/repo",
      branch: "test-branch",
      worktreeinclude: [],
    },
  });
  const expected = fs.readFileSync(path.join(FIXTURE_DIR, "dispatch-dry-run.txt"), "utf-8").trimEnd();
  assert.equal(actual, expected);
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

test("createWorktree forwards registration args through the shared runtime helper", () => {
  const { repoRoot, root } = setupRepo();
  const worktreePath = path.join(root, "worktrees", "register", "repo");
  const calls = [];

  const result = createWorktree({
    repoRoot,
    worktreePath,
    branch: "issue-187-register",
    title: "Pinned Register",
    register: true,
    pin: true,
    copyFiles: [],
    dependencies: {
      registerWorktreeImpl(options) {
        calls.push(options);
        return { threadId: "thread-123" };
      },
    },
  });

  assert.equal(result.threadId, "thread-123");
  assert.deepEqual(calls, [{
    repoRoot,
    worktreePath,
    branch: "issue-187-register",
    title: "Pinned Register",
    pin: true,
    logger: null,
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
      copyFiles: [],
      dependencies: {
        registerWorktreeImpl() {
          throw new Error("simulated register failure");
        },
      },
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
