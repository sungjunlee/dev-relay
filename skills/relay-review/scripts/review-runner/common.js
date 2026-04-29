const fs = require("fs");
const path = require("path");
const { execGit, execGh } = require("../../../relay-dispatch/scripts/exec");

const gh = (repoPath, ...ghArgs) => {
  const lastArg = ghArgs.at(-1);
  const options = lastArg && typeof lastArg === "object" && !Array.isArray(lastArg)
    ? ghArgs.pop()
    : {};
  return execGh(repoPath, ghArgs, options);
};

const git = (repoPath, ...gitArgs) => execGit(repoPath, gitArgs);

const RUBRIC_PASS_THROUGH_STATES = new Set(["loaded"]);

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

module.exports = {
  gh,
  git,
  parsePositiveInt,
  readText,
  RUBRIC_PASS_THROUGH_STATES,
  writeText,
};
