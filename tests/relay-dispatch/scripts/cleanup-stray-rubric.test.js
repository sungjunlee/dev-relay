const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CLEANUP_STATUSES,
  STATES,
  createManifestSkeleton,
  createRunId,
  runCleanup,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
}

function setupRun() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cleanup-rubric-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  git(repoRoot, ["init", "-b", "main"]);
  git(repoRoot, ["config", "user.name", "Relay Cleanup Test"]);
  git(repoRoot, ["config", "user.email", "relay-cleanup@example.com"]);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  git(repoRoot, ["add", "README.md"]);
  git(repoRoot, ["commit", "-m", "init"]);

  const branch = "issue-502";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(repoRoot, ["worktree", "add", worktreePath, "-b", branch]);

  const runId = createRunId({
    branch,
    timestamp: new Date("2026-05-20T00:00:00.000Z"),
  });
  const data = {
    ...createManifestSkeleton({
      repoRoot,
      runId,
      branch,
      baseBranch: "main",
      issueNumber: 502,
      worktreePath,
      orchestrator: "codex",
      executor: "codex",
      reviewer: "codex",
    }),
    state: STATES.MERGED,
    next_action: "cleanup",
  };

  return { repoRoot, worktreePath, data };
}

function cleanupResultFor(changeWorktree) {
  const { repoRoot, worktreePath, data } = setupRun();
  changeWorktree(worktreePath);
  return {
    repoRoot,
    worktreePath,
    result: runCleanup({ repoRoot, data }),
  };
}

function assertDirtyCleanup(result, worktreePath, expectedPattern, message) {
  assert.equal(result.updatedData.cleanup.status, CLEANUP_STATUSES.FAILED, message);
  assert.equal(result.updatedData.next_action, "manual_cleanup_required", message);
  assert.match(result.updatedData.cleanup.error, /dirty worktree/, message);
  assert.match(result.updatedData.cleanup.error, expectedPattern, message);
  assert.equal(result.summary.worktreeDirty, true, message);
  assert.equal(fs.existsSync(worktreePath), true, message);
}

test("runCleanup removes a worktree whose only uncommitted content is untracked root rubric.yaml", () => {
  const { worktreePath, result } = cleanupResultFor((worktree) => {
    fs.writeFileSync(path.join(worktree, "rubric.yaml"), "rubric:\n", "utf-8");
  });

  assert.equal(result.updatedData.cleanup.status, CLEANUP_STATUSES.SUCCEEDED);
  assert.equal(result.updatedData.next_action, "done");
  assert.equal(result.updatedData.cleanup.worktree_removed, true);
  assert.equal(result.updatedData.cleanup.error, null);
  assert.equal(result.summary.worktreeDirty, false);
  assert.equal(fs.existsSync(worktreePath), false);
});

test("runCleanup still blocks cleanup when a tracked file is modified", () => {
  const { worktreePath, result } = cleanupResultFor((worktree) => {
    fs.writeFileSync(path.join(worktree, "README.md"), "changed\n", "utf-8");
  });

  assertDirtyCleanup(result, worktreePath, /README\.md/);
});

test("runCleanup still blocks cleanup when an untracked file is not root rubric.yaml", () => {
  const { worktreePath, result } = cleanupResultFor((worktree) => {
    fs.writeFileSync(path.join(worktree, "other.txt"), "leftover\n", "utf-8");
  });

  assertDirtyCleanup(result, worktreePath, /\?\? other\.txt/);
});

test("runCleanup still blocks cleanup when root rubric.yaml is not the only uncommitted content", () => {
  const { worktreePath, result } = cleanupResultFor((worktree) => {
    fs.writeFileSync(path.join(worktree, "rubric.yaml"), "rubric:\n", "utf-8");
    fs.writeFileSync(path.join(worktree, "other.txt"), "leftover\n", "utf-8");
  });

  assertDirtyCleanup(result, worktreePath, /\?\? other\.txt/);
});

test("runCleanup does not treat rubric.yaml substrings or nested paths as relay-owned strays", () => {
  const cases = [
    {
      name: "nested rubric",
      mutate(worktree) {
        fs.mkdirSync(path.join(worktree, "skills"), { recursive: true });
        fs.writeFileSync(path.join(worktree, "skills", "rubric.yaml"), "nested\n", "utf-8");
      },
      pattern: /\?\? skills\/rubric\.yaml/,
    },
    {
      name: "backup file",
      mutate(worktree) {
        fs.writeFileSync(path.join(worktree, "rubric.yaml.bak"), "backup\n", "utf-8");
      },
      pattern: /\?\? rubric\.yaml\.bak/,
    },
    {
      name: "subdirectory rubric",
      mutate(worktree) {
        fs.mkdirSync(path.join(worktree, "sub"), { recursive: true });
        fs.writeFileSync(path.join(worktree, "sub", "rubric.yaml"), "nested\n", "utf-8");
      },
      pattern: /\?\? sub\/rubric\.yaml/,
    },
    {
      name: "tracked rubric modification",
      mutate(worktree) {
        fs.writeFileSync(path.join(worktree, "rubric.yaml"), "tracked\n", "utf-8");
        git(worktree, ["add", "rubric.yaml"]);
        git(worktree, ["commit", "-m", "track rubric"]);
        fs.writeFileSync(path.join(worktree, "rubric.yaml"), "modified\n", "utf-8");
      },
      pattern: /rubric\.yaml/,
    },
    {
      name: "staged rubric",
      mutate(worktree) {
        fs.writeFileSync(path.join(worktree, "rubric.yaml"), "staged\n", "utf-8");
        git(worktree, ["add", "rubric.yaml"]);
      },
      pattern: /rubric\.yaml/,
    },
  ];

  for (const entry of cases) {
    const { worktreePath, result } = cleanupResultFor(entry.mutate);
    assertDirtyCleanup(result, worktreePath, entry.pattern, entry.name);
  }
});
