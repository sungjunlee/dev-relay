const fs = require("fs");
const {
  ensureRunLayout,
  getEventsPath,
  getRunsDir,
} = require("./relay-manifest");

const ALLOWED_ITERATION_STATUSES = new Set(["pass", "fail", "not_run"]);

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
    run_id: runId,
    state_from: normalizeEventValue(eventData.state_from),
    state_to: normalizeEventValue(eventData.state_to),
    head_sha: normalizeEventValue(eventData.head_sha),
    round: normalizeEventValue(eventData.round),
    reason: normalizeEventValue(eventData.reason),
  };

  fs.appendFileSync(getEventsPath(repoRoot, runId), `${JSON.stringify(record)}\n`, "utf-8");
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
    run_id: runId,
    round,
    scores: scores.map((score) => ({
      factor: score.factor,
      target: score.target,
      observed: score.observed,
      met: score.met,
      status: score.status,
    })),
  };

  fs.appendFileSync(getEventsPath(repoRoot, runId), `${JSON.stringify(record)}\n`, "utf-8");
  return record;
}

function readRunEvents(repoRoot, runId) {
  const eventsPath = getEventsPath(repoRoot, runId);
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, "utf-8")
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
  appendRunEvent,
  readAllRunEvents,
  readRunEvents,
};
