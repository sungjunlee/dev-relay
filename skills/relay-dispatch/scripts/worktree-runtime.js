const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { copyWorktreeFiles, getWorktreeIncludeFiles } = require("./worktreeinclude");
const { registerCodexApp } = require("./codex-app-register");

function git(repoDir, ...gitArgs) {
  return execFileSync("git", ["-C", repoDir, ...gitArgs], { encoding: "utf-8" }).trim();
}

function formatPlan({ worktreePath, branch, title, register, pin, includeFiles }) {
  const lines = [
    "Dry run:",
    `  Worktree: ${worktreePath}`,
    `  Branch:   ${branch}`,
    `  Title:    ${title}`,
    `  Register: ${register}`,
  ];
  if (pin) lines.push("  Pinned:   yes");
  if (includeFiles.length) lines.push(`  .worktreeinclude: ${includeFiles.join(", ")}`);
  return lines.join("\n");
}

function formatDispatchDryRun({
  runId,
  mode,
  executor,
  repoRoot,
  manifestPath,
  prompt,
  model,
  sandbox,
  register,
  resultFile,
  cleanupPolicy,
  timeout,
  rubricFile = null,
  rubricGrandfathered = false,
  requestId = null,
  leafId = null,
  doneCriteriaFile = null,
  worktreePlan,
}) {
  const lines = [
    `  Run:      ${runId}`,
    "Dry run:",
    `  Mode:     ${mode}`,
    `  Executor: ${executor}`,
    `  Repo:     ${repoRoot}`,
    `  Worktree: ${worktreePlan.worktree}`,
    `  Branch:   ${worktreePlan.branch}`,
    `  Manifest: ${manifestPath}`,
    `  Prompt:   ${prompt.slice(0, 80)}...`,
    `  Model:    ${model || "(default)"}`,
    `  Sandbox:  ${sandbox}`,
    `  Register: ${register}`,
    `  Result:   ${resultFile}`,
    `  Cleanup:  ${cleanupPolicy}`,
    `  Timeout:  ${timeout}s`,
  ];
  if (rubricFile) {
    lines.push(`  Rubric:   ${rubricFile}`);
  }
  if (rubricGrandfathered) {
    lines.push("  Rubric:   grandfathered pre-change run");
  }
  if (requestId) {
    lines.push(`  Request:  ${requestId}`);
  }
  if (leafId) {
    lines.push(`  Leaf:     ${leafId}`);
  }
  if (doneCriteriaFile) {
    lines.push(`  Done AC:  ${doneCriteriaFile}`);
  }
  if (worktreePlan.worktreeinclude.length) {
    lines.push(`  .worktreeinclude: ${worktreePlan.worktreeinclude.join(", ")}`);
  }
  return lines.join("\n");
}

function removeWorktree({ repoRoot, worktreePath, dependencies = {} }) {
  const gitRunner = dependencies.gitRunner || git;
  try {
    gitRunner(repoRoot, "worktree", "remove", "--force", worktreePath);
  } catch {}
}

function registerWorktree({
  repoRoot,
  worktreePath,
  branch,
  title,
  pin = false,
  logger = null,
  dependencies = {},
}) {
  const registerCodexAppImpl = dependencies.registerCodexAppImpl || registerCodexApp;
  const registration = registerCodexAppImpl({
    wtPath: worktreePath,
    repoPath: repoRoot,
    branch,
    title,
    pin,
  });
  if (typeof logger === "function") {
    logger({ event: "register", worktreePath, branch, title, pin, threadId: registration.threadId || null });
  }
  return registration;
}

function createWorktree({
  repoRoot,
  worktreePath,
  branch,
  title,
  includeFiles,
  copyFiles = [],
  register = false,
  pin = false,
  dryRun = false,
  logger = null,
  assertWithin = null,
  dependencies = {},
}) {
  const gitRunner = dependencies.gitRunner || git;
  const getWorktreeIncludeFilesImpl = dependencies.getWorktreeIncludeFilesImpl || getWorktreeIncludeFiles;
  const copyWorktreeFilesImpl = dependencies.copyWorktreeFilesImpl || copyWorktreeFiles;
  const registerWorktreeImpl = dependencies.registerWorktreeImpl || registerWorktree;
  const removeWorktreeImpl = dependencies.removeWorktreeImpl || removeWorktree;
  const resolvedIncludeFiles = includeFiles || getWorktreeIncludeFilesImpl(repoRoot);
  const plan = {
    worktree: worktreePath,
    branch,
    title,
    register,
    pin,
    worktreeinclude: resolvedIncludeFiles,
  };

  if (dryRun) {
    if (typeof logger === "function") {
      logger({ event: "dry_run", plan });
    }
    return plan;
  }

  let createdWorktree = false;
  let copiedFiles = [];
  let threadId = null;

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  try {
    try {
      gitRunner(repoRoot, "worktree", "add", worktreePath, "-b", branch);
    } catch {
      try {
        gitRunner(repoRoot, "worktree", "add", worktreePath, branch);
      } catch (error) {
        throw new Error(`failed to create worktree for branch '${branch}': ${error.message}`);
      }
    }
    createdWorktree = true;
    if (typeof logger === "function") {
      logger({ event: "create", worktreePath, branch });
    }

    const copied = copyWorktreeFilesImpl(repoRoot, worktreePath, {
      copyFiles,
      assertWithin,
    });
    copiedFiles = copied.copied;
    if (typeof logger === "function") {
      logger({ event: "copy", worktreePath, copiedFiles });
    }

    if (register) {
      const registration = registerWorktreeImpl({
        repoRoot,
        worktreePath,
        branch,
        title,
        pin,
        logger,
      });
      threadId = registration.threadId || null;
    }
  } catch (error) {
    if (createdWorktree) {
      removeWorktreeImpl({ repoRoot, worktreePath, dependencies });
    }
    throw error;
  }

  return {
    ...plan,
    copiedFiles,
    threadId,
  };
}

module.exports = {
  createWorktree,
  formatDispatchDryRun,
  formatPlan,
  registerWorktree,
  removeWorktree,
};
