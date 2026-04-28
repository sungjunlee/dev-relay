"use strict";

const { execFileSync } = require("child_process");

function outputOrRaw(output, raw) {
  return raw ? output : output.trim();
}

function execGit(repoPath, args, opts = {}) {
  const { raw = false, cwd, encoding, stdio, ...execOpts } = opts;
  const gitBin = process.env.RELAY_GIT_BIN || "git";
  const output = execFileSync(gitBin, ["-C", repoPath, ...args], {
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

module.exports = {
  execGit,
  execGh,
};
