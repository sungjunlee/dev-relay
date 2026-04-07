const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getEventsPath } = require("./relay-manifest");
const {
  appendIterationScore,
  appendRubricQuality,
  appendScoreDivergence,
  readRunEvents,
} = require("./relay-events");

function createContext() {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  return {
    repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), "relay-events-")),
    runId: "issue-95-20260406000000000",
  };
}

function createScore(overrides = {}) {
  return {
    factor: "Integration correctness",
    target: ">= 8/10",
    observed: "8/10",
    met: true,
    status: "pass",
    ...overrides,
  };
}

function createRubricQuality(overrides = {}) {
  return {
    grade: "A",
    prerequisites: 2,
    contract_factors: 2,
    quality_factors: 1,
    substantive_total: 3,
    quality_ratio: 0.3333,
    auto_coverage: 0.5,
    risk_signals: ["high_factor_count"],
    task_size: "M",
    ...overrides,
  };
}

function createDivergence(overrides = {}) {
  return {
    factor: "Coverage",
    executor: "9/10",
    reviewer: "6/10",
    delta: 3,
    tier: "contract",
    ...overrides,
  };
}

test("appendIterationScore writes an iteration_score record to events.jsonl", () => {
  const { repoRoot, runId } = createContext();
  const record = appendIterationScore(repoRoot, runId, {
    round: 2,
    scores: [
      createScore(),
      createScore({
        factor: "Factor analysis correctness",
        observed: "6/10",
        met: false,
        status: "fail",
      }),
    ],
  });

  const eventsPath = getEventsPath(repoRoot, runId);
  const lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);

  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed, record);
  assert.deepEqual(readRunEvents(repoRoot, runId), [record]);
});

test("appendIterationScore requires run_id", () => {
  const { repoRoot } = createContext();
  assert.throws(() => appendIterationScore(repoRoot, "", {
    round: 1,
    scores: [createScore()],
  }), /run_id is required/);
});

test("appendIterationScore rejects an empty scores array", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendIterationScore(repoRoot, runId, {
    round: 1,
    scores: [],
  }), /scores must be a non-empty array/);
});

test("appendIterationScore rejects a non-array scores value", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendIterationScore(repoRoot, runId, {
    round: 1,
    scores: "bad",
  }), /scores must be a non-empty array/);
});

test("appendIterationScore requires factor for each score", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendIterationScore(repoRoot, runId, {
    round: 1,
    scores: [createScore({ factor: "   " })],
  }), /scores\[0\]\.factor is required/);
});

test("appendIterationScore requires target for each score", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendIterationScore(repoRoot, runId, {
    round: 1,
    scores: [createScore({ target: undefined })],
  }), /scores\[0\]\.target is required/);
});

test("appendIterationScore requires observed for each score", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendIterationScore(repoRoot, runId, {
    round: 1,
    scores: [createScore({ observed: undefined })],
  }), /scores\[0\]\.observed is required/);
});

test("appendIterationScore requires met to be boolean", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendIterationScore(repoRoot, runId, {
    round: 1,
    scores: [createScore({ met: "true" })],
  }), /scores\[0\]\.met must be boolean/);
});

test("appendIterationScore requires status for each score", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendIterationScore(repoRoot, runId, {
    round: 1,
    scores: [createScore({ status: undefined })],
  }), /scores\[0\]\.status must be one of: pass, fail, not_run/);
});

test("appendIterationScore rejects invalid status values", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendIterationScore(repoRoot, runId, {
    round: 1,
    scores: [createScore({ status: "partial" })],
  }), /scores\[0\]\.status must be one of: pass, fail, not_run/);
});

test("appendIterationScore persists a valid tier and omits invalid or missing tiers", () => {
  const { repoRoot, runId } = createContext();
  appendIterationScore(repoRoot, runId, {
    round: 1,
    scores: [
      createScore({ factor: "Contract", tier: "contract" }),
      createScore({ factor: "No tier", tier: undefined }),
      createScore({ factor: "Invalid tier", tier: "unknown" }),
    ],
  });

  const [event] = readRunEvents(repoRoot, runId);
  assert.equal(event.scores[0].tier, "contract");
  assert.ok(!("tier" in event.scores[1]));
  assert.ok(!("tier" in event.scores[2]));
});

test("appendRubricQuality writes a rubric_quality record to events.jsonl", () => {
  const { repoRoot, runId } = createContext();
  const record = appendRubricQuality(repoRoot, runId, createRubricQuality());

  const eventsPath = getEventsPath(repoRoot, runId);
  const lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);

  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed, record);
  assert.deepEqual(readRunEvents(repoRoot, runId), [record]);
});

test("appendRubricQuality rejects an invalid grade", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendRubricQuality(repoRoot, runId, createRubricQuality({ grade: "E" })), /grade must be one of: A, B, C, D/);
});

test("appendRubricQuality rejects non-array risk_signals", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendRubricQuality(repoRoot, runId, createRubricQuality({ risk_signals: "bad" })), /risk_signals must be an array of strings/);
});

test("appendRubricQuality rejects an invalid task_size", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendRubricQuality(repoRoot, runId, createRubricQuality({ task_size: "XXL" })), /task_size must be one of: S, M, L, XL/);
});

test("appendScoreDivergence writes a score_divergence record to events.jsonl", () => {
  const { repoRoot, runId } = createContext();
  const record = appendScoreDivergence(repoRoot, runId, {
    round: 2,
    divergences: [
      createDivergence(),
      createDivergence({ factor: "Docs", executor: "8", reviewer: "5", delta: 3, tier: "quality" }),
    ],
  });

  const eventsPath = getEventsPath(repoRoot, runId);
  const lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);

  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed, record);
  assert.deepEqual(readRunEvents(repoRoot, runId), [record]);
});

test("appendScoreDivergence rejects an empty divergences array", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendScoreDivergence(repoRoot, runId, {
    round: 1,
    divergences: [],
  }), /divergences must be a non-empty array/);
});

test("appendScoreDivergence rejects an invalid tier", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendScoreDivergence(repoRoot, runId, {
    round: 1,
    divergences: [createDivergence({ tier: "hygiene" })],
  }), /divergences\[0\]\.tier must be one of: contract, quality/);
});

test("appendScoreDivergence rejects a missing factor", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(() => appendScoreDivergence(repoRoot, runId, {
    round: 1,
    divergences: [createDivergence({ factor: "   " })],
  }), /divergences\[0\]\.factor is required/);
});
