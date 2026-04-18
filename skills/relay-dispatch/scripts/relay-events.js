const fs = require("fs");
const { getActorName } = require("./manifest/store");
const { ensureRunLayout, getEventsPath, getRunsDir } = require("./manifest/paths");
const {
  appendTextFileWithoutFollowingSymlinks,
  readTextFileWithoutFollowingSymlinks,
} = require("./manifest/rubric");

function appendEventLine(repoRoot, runId, record) {
  const eventsPath = getEventsPath(repoRoot, runId);
  try {
    appendTextFileWithoutFollowingSymlinks(eventsPath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new Error(
        `Refusing to append to symlinked events.jsonl at ${eventsPath}: ${error.message}`
      );
    }
    throw error;
  }
}

const ALLOWED_ITERATION_STATUSES = new Set(["pass", "fail", "not_run"]);
const ALLOWED_SCORE_TIERS = new Set(["contract", "quality"]);
const ALLOWED_RUBRIC_GRADES = new Set(["A", "B", "C", "D"]);
const ALLOWED_TASK_SIZES = new Set(["S", "M", "L", "XL"]);

function normalizeEventValue(value) {
  return value === undefined ? null : value;
}

function appendRunEvent(repoRoot, runId, eventData) {
  if (!runId) {
    throw new Error("run_id is required to append a relay event");
  }
  if (!String(eventData?.event || "").trim()) {
    throw new Error("event is required to append a relay event");
  }

  ensureRunLayout(repoRoot, runId);
  const record = {
    ts: eventData.ts || new Date().toISOString(),
    event: eventData.event,
    actor: getActorName(repoRoot),
    run_id: runId,
    state_from: normalizeEventValue(eventData.state_from),
    state_to: normalizeEventValue(eventData.state_to),
    head_sha: normalizeEventValue(eventData.head_sha),
    round: normalizeEventValue(eventData.round),
    reason: normalizeEventValue(eventData.reason),
    ...(eventData.reviewer !== undefined
      ? { reviewer: normalizeEventValue(eventData.reviewer) }
      : {}),
    ...(eventData.rubric_status !== undefined
      ? { rubric_status: normalizeEventValue(eventData.rubric_status) }
      : {}),
    ...(eventData.last_reviewed_sha !== undefined
      ? { last_reviewed_sha: normalizeEventValue(eventData.last_reviewed_sha) }
      : {}),
  };

  appendEventLine(repoRoot, runId, record);
  return record;
}

function appendIterationScore(repoRoot, runId, { round, scores } = {}) {
  if (!runId) {
    throw new Error("run_id is required");
  }
  if (!Array.isArray(scores) || scores.length === 0) {
    throw new Error("scores must be a non-empty array");
  }

  for (const [index, score] of scores.entries()) {
    const location = `scores[${index}]`;
    if (typeof score?.factor !== "string" || !score.factor.trim()) {
      throw new Error(`${location}.factor is required`);
    }
    if (typeof score.target !== "string") {
      throw new Error(`${location}.target is required`);
    }
    if (typeof score.observed !== "string") {
      throw new Error(`${location}.observed is required`);
    }
    if (typeof score.met !== "boolean") {
      throw new Error(`${location}.met must be boolean`);
    }
    if (!ALLOWED_ITERATION_STATUSES.has(score.status)) {
      throw new Error(`${location}.status must be one of: pass, fail, not_run`);
    }
  }

  ensureRunLayout(repoRoot, runId);
  const record = {
    ts: new Date().toISOString(),
    event: "iteration_score",
    actor: getActorName(repoRoot),
    run_id: runId,
    round,
    scores: scores.map((score) => ({
      factor: score.factor,
      target: score.target,
      observed: score.observed,
      met: score.met,
      status: score.status,
      ...(ALLOWED_SCORE_TIERS.has(score.tier) ? { tier: score.tier } : {}),
    })),
  };

  appendEventLine(repoRoot, runId, record);
  return record;
}

function appendRubricQuality(repoRoot, runId, data = {}) {
  if (!runId) {
    throw new Error("run_id is required");
  }
  if (!ALLOWED_RUBRIC_GRADES.has(data.grade)) {
    throw new Error("grade must be one of: A, B, C, D");
  }
  for (const field of ["prerequisites", "contract_factors", "quality_factors", "substantive_total"]) {
    if (typeof data[field] !== "number" || Number.isNaN(data[field])) {
      throw new Error(`${field} must be a number`);
    }
  }
  for (const field of ["quality_ratio", "auto_coverage"]) {
    if (typeof data[field] !== "number" || Number.isNaN(data[field])) {
      throw new Error(`${field} must be a number`);
    }
  }
  if (!Array.isArray(data.risk_signals)) {
    throw new Error("risk_signals must be an array of strings");
  }
  data.risk_signals.forEach((signal, index) => {
    if (typeof signal !== "string") {
      throw new Error(`risk_signals[${index}] must be a string`);
    }
  });
  if (!ALLOWED_TASK_SIZES.has(data.task_size)) {
    throw new Error("task_size must be one of: S, M, L, XL");
  }

  ensureRunLayout(repoRoot, runId);
  const record = {
    ts: new Date().toISOString(),
    event: "rubric_quality",
    actor: getActorName(repoRoot),
    run_id: runId,
    grade: data.grade,
    prerequisites: data.prerequisites,
    contract_factors: data.contract_factors,
    quality_factors: data.quality_factors,
    substantive_total: data.substantive_total,
    quality_ratio: data.quality_ratio,
    auto_coverage: data.auto_coverage,
    risk_signals: [...data.risk_signals],
    task_size: data.task_size,
  };

  appendEventLine(repoRoot, runId, record);
  return record;
}

function appendScoreDivergence(repoRoot, runId, { round, divergences } = {}) {
  if (!runId) {
    throw new Error("run_id is required");
  }
  if (!Array.isArray(divergences) || divergences.length === 0) {
    throw new Error("divergences must be a non-empty array");
  }

  divergences.forEach((entry, index) => {
    const location = `divergences[${index}]`;
    if (typeof entry?.factor !== "string" || !entry.factor.trim()) {
      throw new Error(`${location}.factor is required`);
    }
    if (typeof entry.executor !== "string") {
      throw new Error(`${location}.executor must be a string`);
    }
    if (typeof entry.reviewer !== "string") {
      throw new Error(`${location}.reviewer must be a string`);
    }
    if (typeof entry.delta !== "number" || Number.isNaN(entry.delta)) {
      throw new Error(`${location}.delta must be a number`);
    }
    if (!ALLOWED_SCORE_TIERS.has(entry.tier)) {
      throw new Error(`${location}.tier must be one of: contract, quality`);
    }
  });

  ensureRunLayout(repoRoot, runId);
  const record = {
    ts: new Date().toISOString(),
    event: "score_divergence",
    actor: getActorName(repoRoot),
    run_id: runId,
    round,
    divergences: divergences.map((entry) => ({
      factor: entry.factor,
      executor: entry.executor,
      reviewer: entry.reviewer,
      delta: entry.delta,
      tier: entry.tier,
    })),
  };

  appendEventLine(repoRoot, runId, record);
  return record;
}

function readRunEvents(repoRoot, runId) {
  const eventsPath = getEventsPath(repoRoot, runId);
  // Do NOT short-circuit on fs.existsSync — existsSync follows symlinks, so a
  // dangling symlink at eventsPath would return false and we'd silently
  // return []. That's exactly the fail-open class #157/#197 prohibit. Let
  // the safe reader handle the symlink check; distinguish ENOENT (truly
  // missing) from ELOOP (symlink refused) in the catch.
  let rawText;
  try {
    rawText = readTextFileWithoutFollowingSymlinks(eventsPath);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    if (error.code === "ELOOP") {
      throw new Error(
        `Refusing to read symlinked events.jsonl at ${eventsPath}: ${error.message}`
      );
    }
    throw error;
  }
  return rawText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readAllRunEvents(repoRoot) {
  const runsDir = getRunsDir(repoRoot);
  if (!fs.existsSync(runsDir)) return [];

  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readRunEvents(repoRoot, entry.name));
}

module.exports = {
  appendIterationScore,
  appendRubricQuality,
  appendRunEvent,
  appendScoreDivergence,
  readAllRunEvents,
  readRunEvents,
};
