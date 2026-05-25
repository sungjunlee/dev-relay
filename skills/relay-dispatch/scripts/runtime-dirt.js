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
  if (typeof line !== "string" || line.length < 4) return "";
  return line.slice(3).trim();
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
  return classified.runtimeMetadataStatus || ".antigravitycli/";
}

function gitAddReviewableArgs(statusText) {
  const classified = classifyRepositoryDirt(statusText);
  if (!classified.hasRuntimeMetadataDirt) {
    return ["add", "-A"];
  }
  return [
    "add", "-A", "--", ".",
    ":(exclude).antigravitycli",
    ":(exclude).antigravitycli/**",
  ];
}

module.exports = {
  RUNTIME_METADATA_ROOTS,
  classifyRepositoryDirt,
  formatRuntimeMetadataDirt,
  gitAddReviewableArgs,
  isRuntimeMetadataStatusLine,
};
