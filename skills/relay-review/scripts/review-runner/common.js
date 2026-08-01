const { randomUUID } = require("crypto");
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

const git = (repoPath, ...gitArgs) => {
  const lastArg = gitArgs.at(-1);
  const options = lastArg && typeof lastArg === "object" && !Array.isArray(lastArg)
    ? gitArgs.pop()
    : {};
  return execGit(repoPath, gitArgs, options);
};

function readText(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf-8");
}

/**
 * Publish JSON so readers only ever observe an absent or complete file.
 *
 * Readers may poll an artifact while another process is publishing it. A direct
 * overwrite exposes truncated JSON between truncate and write.
 */
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {}
  }
}

module.exports = {
  gh,
  git,
  readText,
  writeJson,
  writeText,
};
