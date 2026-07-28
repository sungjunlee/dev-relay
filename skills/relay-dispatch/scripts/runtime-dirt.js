"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_METADATA_ROOTS = Object.freeze([
  ".antigravitycli",
]);

function splitStatusLines(statusText) {
  return String(statusText || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function statusPath(line) {
  if (typeof line !== "string" || line.length < 3) return "";
  if (line[2] === " ") return line.slice(3).trim();
  // execGit trims command output, so an unstaged first line can arrive as
  // "M path" rather than the porcelain form " M path".
  if (line[1] === " ") return line.slice(2).trim();
  return "";
}

function decodeQuotedStatusPath(filePath) {
  if (!filePath.startsWith("\"") || !filePath.endsWith("\"")) return filePath;

  const chunks = [];
  let literal = "";
  const flushLiteral = () => {
    if (!literal) return;
    chunks.push(Buffer.from(literal, "utf-8"));
    literal = "";
  };
  const escapes = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\x0b",
    "\\": "\\",
    "\"": "\"",
  };

  for (let index = 1; index < filePath.length - 1; index += 1) {
    const char = filePath[index];
    if (char !== "\\") {
      literal += char;
      continue;
    }

    flushLiteral();
    const escaped = filePath[index + 1];
    if (/[0-7]/.test(escaped || "")) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(filePath[index + 1 + octal.length] || "")) {
        octal += filePath[index + 1 + octal.length];
      }
      chunks.push(Buffer.from([Number.parseInt(octal, 8)]));
      index += octal.length;
      continue;
    }

    chunks.push(Buffer.from(escapes[escaped] ?? escaped ?? "\\", "utf-8"));
    index += 1;
  }

  flushLiteral();
  return Buffer.concat(chunks).toString("utf-8");
}

function renameSeparatorIndex(filePath) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index <= filePath.length - 4; index += 1) {
    const char = filePath[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (!quoted && filePath.slice(index, index + 4) === " -> ") return index;
  }
  return -1;
}

function statusPaths(line) {
  const filePath = statusPath(line);
  if (!filePath) return [];
  if (!/[RC]/.test(line.slice(0, 2))) {
    return [decodeQuotedStatusPath(filePath)];
  }

  const separatorIndex = renameSeparatorIndex(filePath);
  if (separatorIndex === -1) return [decodeQuotedStatusPath(filePath)];
  return [
    decodeQuotedStatusPath(filePath.slice(0, separatorIndex)),
    decodeQuotedStatusPath(filePath.slice(separatorIndex + 4)),
  ];
}

function worktreeStatusCode(line) {
  if (typeof line !== "string") return " ";
  if (line[2] === " ") return line[1] || " ";
  // execGit trims the leading index-column space from the first unstaged line.
  if (line[1] === " ") return line[0] || " ";
  return " ";
}

function isPresentOnDisk(repoPath, filePath) {
  try {
    fs.lstatSync(path.resolve(repoPath, filePath));
    return true;
  } catch {
    return false;
  }
}

function statusPathspecs(repoPath, line) {
  const paths = statusPaths(line);
  const worktreePath = paths.at(-1);
  /*
   * General pathspec predicate: emit a path only when git add can have work
   * to do for it — the path is present on disk, or it is the current worktree
   * path and porcelain column 2 reports an unstaged change. This omits any
   * fully staged path that is absent from disk, regardless of its status code,
   * while retaining absent paths for AD and unstaged deletions.
   *
   * Rename/copy porcelain lists a historical source before the current path;
   * column 2 describes the current path only.
   */
  return paths.filter((filePath) => (
    isPresentOnDisk(repoPath, filePath) ||
    (filePath === worktreePath && worktreeStatusCode(line) !== " ")
  ));
}

function isRuntimeMetadataStatusLine(line) {
  if (typeof line !== "string" || line.slice(0, 2) !== "??") return false;
  const filePath = statusPath(line).replace(/\/+$/, "");
  return RUNTIME_METADATA_ROOTS.some((root) => filePath === root || filePath.startsWith(`${root}/`));
}

function classifyRepositoryDirt(statusText) {
  const lines = splitStatusLines(statusText);
  const runtimeMetadataLines = [];
  const reviewableLines = [];

  for (const line of lines) {
    if (isRuntimeMetadataStatusLine(line)) {
      runtimeMetadataLines.push(line);
    } else {
      reviewableLines.push(line);
    }
  }

  return {
    hasDirt: lines.length > 0,
    hasRuntimeMetadataDirt: runtimeMetadataLines.length > 0,
    hasOnlyRuntimeMetadataDirt: lines.length > 0 && reviewableLines.length === 0,
    hasReviewableDirt: reviewableLines.length > 0,
    runtimeMetadataStatus: runtimeMetadataLines.join("\n"),
    reviewableStatus: reviewableLines.join("\n"),
  };
}

function formatRuntimeMetadataDirt(statusText) {
  const classified = classifyRepositoryDirt(statusText);
  return classified.runtimeMetadataStatus || `${RUNTIME_METADATA_ROOTS[0]}/`;
}

function reviewableStatusPaths(statusText) {
  const classified = classifyRepositoryDirt(statusText);
  return [...new Set(
    splitStatusLines(classified.reviewableStatus).flatMap((line) => statusPaths(line))
  )];
}

function reviewableStatusPathspecs(statusText, repoPath) {
  const classified = classifyRepositoryDirt(statusText);
  return [...new Set(
    splitStatusLines(classified.reviewableStatus).flatMap((line) => statusPathspecs(repoPath, line))
  )];
}

function formatEmptyReviewableIndexError(statusText) {
  const paths = reviewableStatusPaths(statusText);
  const detail = paths.length
    ? paths.map((filePath) => JSON.stringify(filePath)).join(", ")
    : JSON.stringify(classifyRepositoryDirt(statusText).reviewableStatus);
  return (
    "reviewable staging contradiction: classifyRepositoryDirt reported reviewable dirt, " +
    "but gitAddReviewableArgs left the index empty; reviewable paths that failed to stage: " +
    detail
  );
}

function runtimeMetadataRootExclusions() {
  return RUNTIME_METADATA_ROOTS.flatMap((root) => [
    `:(exclude)${root}`,
    `:(exclude)${root}/**`,
  ]);
}

function gitAddReviewableArgs(statusText, repoPath = process.cwd()) {
  const classified = classifyRepositoryDirt(statusText);
  if (!classified.hasRuntimeMetadataDirt) {
    return ["add", "-A"];
  }

  /*
   * Invariant: anything classifyRepositoryDirt reports reviewable is stageable
   * by the argv returned here for the same status text.
   *
   * A reviewable-path allowlist preserves tracked changes beneath runtime roots
   * while excluding untracked runtime metadata. It also deliberately excludes
   * runtime files created after the status snapshot; enumerating only the
   * runtime paths seen above would race with a still-running metadata writer.
   * Both the allowlist and runtime classification derive from
   * RUNTIME_METADATA_ROOTS through classifyRepositoryDirt.
   */
  const reviewablePaths = reviewableStatusPathspecs(statusText, repoPath);
  if (reviewablePaths.length > 0) {
    return ["add", "-A", "--", ...reviewablePaths];
  }
  return ["add", "-A", "--", ".", ...runtimeMetadataRootExclusions()];
}

module.exports = {
  RUNTIME_METADATA_ROOTS,
  classifyRepositoryDirt,
  formatEmptyReviewableIndexError,
  formatRuntimeMetadataDirt,
  gitAddReviewableArgs,
  isRuntimeMetadataStatusLine,
  reviewableStatusPaths,
};
