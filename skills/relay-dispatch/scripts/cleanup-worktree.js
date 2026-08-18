"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function git(repo, args) {
  return execFileSync(process.env.RELAY_GIT_BIN || "git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function registeredWorktrees(repoRoot) {
  return git(repoRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function cleanupWorktree(record, mergeFact) {
  if (!fs.existsSync(record.git.worktree)) return { status: "already_absent" };
  let worktree;
  try { worktree = fs.realpathSync(record.git.worktree); }
  catch (error) { return { status: "retained", reason: error.message }; }
  if (worktree === record.repo.root) {
    return { status: "retained", reason: "refusing to remove the canonical repository checkout" };
  }
  let commonDir;
  try {
    commonDir = fs.realpathSync(path.resolve(
      worktree,
      git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ));
  } catch (error) {
    return { status: "retained", reason: `worktree identity failed: ${error.message}` };
  }
  if (fs.realpathSync(path.dirname(commonDir)) !== record.repo.root) {
    return { status: "retained", reason: "worktree belongs to a different repository" };
  }
  const registered = registeredWorktrees(record.repo.root)
    .map((entry) => { try { return fs.realpathSync(entry); } catch { return null; } });
  if (!registered.includes(worktree)) {
    return { status: "retained", reason: "path is not a registered linked worktree" };
  }
  const head = git(worktree, ["rev-parse", "HEAD"]);
  if (head !== mergeFact.payload.pr_head_sha) {
    return { status: "retained", reason: "worktree HEAD changed after review" };
  }
  if (git(worktree, ["status", "--porcelain"])) {
    return { status: "retained", reason: "worktree contains uncommitted changes" };
  }
  try {
    git(record.repo.root, ["worktree", "remove", worktree]);
    return { status: "removed" };
  } catch (error) {
    return { status: "retained", reason: error.message };
  }
}

module.exports = { cleanupWorktree };
