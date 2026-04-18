const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function gh(repoPath, ...ghArgs) {
  return execFileSync("gh", ghArgs, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

function git(repoPath, ...gitArgs) {
  return execFileSync("git", gitArgs, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

function parsePositiveInt(value, label) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf-8");
}

function looksLikeGitRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, ".git"));
}

module.exports = {
  gh,
  git,
  looksLikeGitRepo,
  parsePositiveInt,
  readText,
  writeText,
};
