"use strict";

const { execFileSync } = require("child_process");

const DEFAULT_EXEC_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function outputOrRaw(output, raw) {
  return raw ? output : output.trim();
}

function execGit(repoPath, args, opts = {}) {
  const { raw = false, cwd, encoding, stdio, ...execOpts } = opts;
  const gitBin = process.env.RELAY_GIT_BIN || "git";
  const output = execFileSync(gitBin, ["-C", repoPath, ...args], {
    maxBuffer: DEFAULT_EXEC_MAX_BUFFER_BYTES,
    ...execOpts,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return outputOrRaw(output, raw);
}

function execGh(repoPath, args, opts = {}) {
  const { raw = false, cwd, encoding, stdio, ...execOpts } = opts;
  const ghBin = process.env.RELAY_GH_BIN || "gh";
  const options = {
    maxBuffer: DEFAULT_EXEC_MAX_BUFFER_BYTES,
    ...execOpts,
    encoding: "utf-8",
    stdio: "pipe",
  };
  if (repoPath != null) {
    options.cwd = repoPath;
  }
  const output = execFileSync(ghBin, args, options);
  return outputOrRaw(output, raw);
}

// Resolve the remote a branch actually tracks, falling back to "origin".
// Mirrors dispatch-publish.js's resolveBranchRemote (#229) for the recovery and
// correction scripts, which drive git through execGit rather than an injected
// execFile. Without this they hardcode "origin" and target the wrong remote in a
// repo whose branch remote is named otherwise (#1083).
function resolveBranchRemote(worktreePath, branch) {
  if (!branch) return "origin";
  try {
    return execGit(worktreePath, ["config", "--get", `branch.${branch}.remote`]) || "origin";
  } catch {
    return "origin";
  }
}

module.exports = {
  DEFAULT_EXEC_MAX_BUFFER_BYTES,
  execGit,
  execGh,
  resolveBranchRemote,
};
