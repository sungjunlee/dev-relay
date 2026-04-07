const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getEventsPath } = require("./relay-manifest");
const { appendIterationScore, readRunEvents } = require("./relay-events");

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
