const ALLOWED_SCORE_TIERS = new Set(["contract", "quality"]);
const { gh } = require("./common");

function splitMarkdownTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|")) return null;
  const content = trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
  return content.split("|").map((cell) => cell.trim());
}

function isMarkdownTableDivider(line) {
  const cells = splitMarkdownTableRow(line);
  return Array.isArray(cells) && cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function isMissingScoreCell(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "—" || normalized === "–" || normalized === "-" || normalized === "n/a" || normalized === "na";
}

function parseScoreLog(markdownText) {
  if (typeof markdownText !== "string" || !markdownText.trim()) {
    return [];
  }

  const lines = markdownText.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = splitMarkdownTableRow(lines[index]);
    if (!headerCells || headerCells.length < 2 || !isMarkdownTableDivider(lines[index + 1])) {
      continue;
    }

    const normalizedHeaders = headerCells.map((cell) => cell.toLowerCase());
    const factorIndex = normalizedHeaders.indexOf("factor");
    const statusIndex = normalizedHeaders.indexOf("status");
    const finalIndex = normalizedHeaders.indexOf("final");
    const iterIndexes = normalizedHeaders
      .map((cell, cellIndex) => (/^iter\s+\d+$/i.test(cell) ? cellIndex : -1))
      .filter((cellIndex) => cellIndex !== -1);
    if (factorIndex === -1 || statusIndex === -1 || (finalIndex === -1 && iterIndexes.length === 0)) {
      continue;
    }

    const parsedRows = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = splitMarkdownTableRow(lines[rowIndex]);
      if (!rowCells) break;

      const factor = String(rowCells[factorIndex] || "").trim();
      if (!factor) continue;

      let score = finalIndex !== -1 ? String(rowCells[finalIndex] || "").trim() : "";
      if (isMissingScoreCell(score)) {
        const fallbackIndex = [...iterIndexes]
          .reverse()
          .find((candidateIndex) => !isMissingScoreCell(rowCells[candidateIndex]));
        score = fallbackIndex === undefined ? "" : String(rowCells[fallbackIndex] || "").trim();
      }
      if (isMissingScoreCell(score)) {
        continue;
      }
      parsedRows.push({ factor, score });
    }

    if (parsedRows.length > 0) {
      return parsedRows;
    }
  }

  return [];
}

function normalizeFactorKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseNumericScore(value) {
  const text = String(value || "").trim();
  if (isMissingScoreCell(text)) return null;
  const match = text.match(/^(-?\d+(?:\.\d+)?)(?:\s*\/\s*10(?:\.0+)?)?$/);
  if (!match) return null;
  return Number(match[1]);
}

function loadPrBody(repoPath, prNumber) {
  if (!prNumber) return "";
  try {
    const raw = gh(repoPath, "pr", "view", String(prNumber), "--json", "body");
    return String(JSON.parse(raw).body || "");
  } catch {
    return "";
  }
}

function formatDelta(delta) {
  return `${delta > 0 ? "+" : ""}${delta}`;
}

function buildScoreDivergenceAnalysis(markdownText, rubricScores) {
  if (!Array.isArray(rubricScores) || rubricScores.length === 0) {
    return { warnings: [], eventPayload: [] };
  }

  const scoreLog = parseScoreLog(markdownText);
  if (scoreLog.length === 0) {
    return { warnings: [], eventPayload: [] };
  }

  const executorScores = new Map(scoreLog.map((entry) => [normalizeFactorKey(entry.factor), entry.score]));
  const numericMatches = [];
  for (const score of rubricScores) {
    const factorKey = normalizeFactorKey(score.factor);
    const executor = executorScores.get(factorKey);
    if (!executor) continue;

    const executorNumeric = parseNumericScore(executor);
    const reviewerNumeric = parseNumericScore(score.observed);
    if (executorNumeric === null || reviewerNumeric === null) continue;

    const delta = Number((executorNumeric - reviewerNumeric).toFixed(4));
    numericMatches.push({
      factor: score.factor,
      executor,
      reviewer: score.observed,
      delta,
      tier: ALLOWED_SCORE_TIERS.has(score.tier) ? score.tier : null,
    });
  }

  if (numericMatches.length === 0) {
    return { warnings: [], eventPayload: [] };
  }

  return {
    warnings: numericMatches
      .filter((entry) => Math.abs(entry.delta) >= 3)
      .map((entry) => `${entry.factor}: executor ${entry.executor}, reviewer ${entry.reviewer} (${formatDelta(entry.delta)})`),
    eventPayload: numericMatches.filter((entry) => entry.tier !== null),
  };
}

module.exports = {
  buildScoreDivergenceAnalysis,
  formatDelta,
  isMarkdownTableDivider,
  isMissingScoreCell,
  loadPrBody,
  normalizeFactorKey,
  parseNumericScore,
  parseScoreLog,
  splitMarkdownTableRow,
};
