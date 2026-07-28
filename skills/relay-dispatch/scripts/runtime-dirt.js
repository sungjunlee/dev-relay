"use strict";

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

function statusPathspecs(line) {
  const paths = statusPaths(line);
  /*
   * A staged rename/copy has R/C in the index column. A rename source is
   * already absent from the index, so passing it to git add as an allowlist
   * pathspec aborts the entire add. The destination alone is sufficient for
   * both shapes to retain the staged index entry (and to pick up any later
   * destination edits).
   *
   * line[2] distinguishes an intact "R  old -> new" / "RM old -> new" entry
   * from an unstaged first entry whose leading space execGit trimmed to
   * "R old -> new". The latter must keep both paths.
   */
  const hasStagedRenameOrCopy = line[2] === " " && /[RC]/.test(line[0]);
  return hasStagedRenameOrCopy && paths.length > 1 ? paths.slice(-1) : paths;
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

function reviewableStatusPathspecs(statusText) {
  const classified = classifyRepositoryDirt(statusText);
  return [...new Set(
    splitStatusLines(classified.reviewableStatus).flatMap((line) => statusPathspecs(line))
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

function gitAddReviewableArgs(statusText) {
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
  const reviewablePaths = reviewableStatusPathspecs(statusText);
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
