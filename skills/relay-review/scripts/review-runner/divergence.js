"use strict";

// Legacy-only Score Log reader. Current review never imports this module and
// never compares executor-authored scores with reviewer verdicts.
const { gh } = require("./common");
const {
  isMissingScoreCell,
  parseNumericScore,
} = require("./score-utils");

function normalizeFactorKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function splitMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|")) return null;
  const content = trimmed.endsWith("|")
    ? trimmed.slice(1, -1)
    : trimmed.slice(1);
  return content.split("|").map((cell) => cell.trim());
}

function isMarkdownTableDivider(line) {
  const cells = splitMarkdownTableRow(line);
  return Array.isArray(cells)
    && cells.length > 0
    && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function parseScoreLog(markdownText) {
  if (typeof markdownText !== "string" || !markdownText.trim()) {
    return [];
  }

  const lines = markdownText.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = splitMarkdownTableRow(lines[index]);
    if (
      !headerCells
      || headerCells.length < 2
      || !isMarkdownTableDivider(lines[index + 1])
    ) {
      continue;
    }

    const normalizedHeaders = headerCells.map((cell) => cell.toLowerCase());
    const factorIndex = normalizedHeaders.indexOf("factor");
    const statusIndex = normalizedHeaders.indexOf("status");
    const finalIndex = normalizedHeaders.indexOf("final");
    const iterIndexes = normalizedHeaders
      .map((cell, cellIndex) => (/^iter\s+\d+$/i.test(cell) ? cellIndex : -1))
      .filter((cellIndex) => cellIndex !== -1);
    if (
      factorIndex === -1
      || statusIndex === -1
      || (finalIndex === -1 && iterIndexes.length === 0)
    ) {
      continue;
    }

    const parsedRows = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = splitMarkdownTableRow(lines[rowIndex]);
      if (!rowCells) break;

      const factor = String(rowCells[factorIndex] || "").trim();
      if (!factor) continue;

      let score = finalIndex !== -1
        ? String(rowCells[finalIndex] || "").trim()
        : "";
      if (isMissingScoreCell(score)) {
        const fallbackIndex = [...iterIndexes]
          .reverse()
          .find((candidateIndex) => !isMissingScoreCell(rowCells[candidateIndex]));
        score = fallbackIndex === undefined
          ? ""
          : String(rowCells[fallbackIndex] || "").trim();
      }
      if (!isMissingScoreCell(score)) {
        parsedRows.push({ factor, score });
      }
    }

    if (parsedRows.length > 0) {
      return parsedRows;
    }
  }

  return [];
}

function loadPrBody(repoPath, prNumber) {
  if (!prNumber) return "";
  try {
    const raw = gh(
      repoPath,
      "pr",
      "view",
      String(prNumber),
      "--json",
      "body"
    );
    return String(JSON.parse(raw).body || "");
  } catch {
    return "";
  }
}

module.exports = {
  loadPrBody,
  normalizeFactorKey,
  parseNumericScore,
  parseScoreLog,
};
