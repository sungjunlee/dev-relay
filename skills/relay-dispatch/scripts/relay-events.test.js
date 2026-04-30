const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getEventsPath } = require("./relay-manifest");
const {
  appendIterationScore,
  appendRubricQuality,
  appendRunEvent,
  appendScoreDivergence,
  EVENTS,
  readRunEvents,
} = require("./relay-events");

function initGitRepo(repoRoot, actor = "Relay Events Test") {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", actor], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay@example.com"], { cwd: repoRoot, stdio: "pipe" });
}

function withGitIdentityDisabled(testFn) {
  const previousEnv = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-isolated-"));
  const isolatedXdg = fs.mkdtempSync(path.join(os.tmpdir(), "relay-xdg-isolated-"));

  process.env.HOME = isolatedHome;
  process.env.XDG_CONFIG_HOME = isolatedXdg;
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  try {
    testFn();
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createContext(actor = "Relay Events Test") {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-events-"));
  initGitRepo(repoRoot, actor);
  return {
    repoRoot,
    runId: "issue-95-20260406000000000",
  };
}

function createContextWithoutActor() {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-events-missing-actor-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay@example.com"], { cwd: repoRoot, stdio: "pipe" });
  return {
    repoRoot,
    runId: "issue-95-20260406000000001",
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
  assert.equal(record.actor, "Relay Events Test");
  assert.deepEqual(parsed, record);
  assert.deepEqual(readRunEvents(repoRoot, runId), [record]);
});

test("appendRunEvent writes actor from git config user.name", () => {
  const { repoRoot, runId } = createContext("Relay Operator");
  const record = appendRunEvent(repoRoot, runId, {
    event: EVENTS.DISPATCH_START,
    state_from: "draft",
    state_to: "dispatched",
  });

  const [parsed] = readRunEvents(repoRoot, runId);
  assert.equal(record.actor, "Relay Operator");
  assert.equal(parsed.actor, "Relay Operator");
});

const RUN_EVENT_FIELD_CASES = [
  {
    label: "rubric_status",
    fields: {
      event: EVENTS.SKIP_REVIEW,
      state_from: "ready_to_merge",
      state_to: "ready_to_merge",
      reason: "hotfix",
      rubric_status: "missing",
    },
    expected: { rubric_status: "missing" },
  },
  {
    label: "origin",
    fields: {
      event: EVENTS.REVIEW_APPLY,
      state_from: "review_pending",
      state_to: "escalated",
      reason: "max_rounds_exceeded",
      origin: "system",
    },
    expected: { origin: "system" },
  },
  {
    label: "last_reviewed_sha",
    fields: {
      event: EVENTS.STATE_RECOVERY,
      state_from: "changes_requested",
      state_to: "review_pending",
      head_sha: "deadbeef",
      reason: "external commit",
      last_reviewed_sha: "cafef00d",
    },
    expected: { last_reviewed_sha: "cafef00d" },
  },
  {
    label: "pr_number",
    fields: {
      event: EVENTS.FORCE_FINALIZE,
      state_from: "escalated",
      state_to: "merged",
      head_sha: "deadbeef",
      reason: "operator override",
      pr_number: 123,
    },
    expected: { pr_number: 123 },
  },
  {
    label: "pr_body_only",
    fields: {
      event: EVENTS.STATE_RECOVERY,
      state_from: "changes_requested",
      state_to: "review_pending",
      head_sha: "deadbeef",
      reason: "PR body metadata fixed",
      last_reviewed_sha: "deadbeef",
      pr_body_only: true,
    },
    expected: { pr_body_only: true },
  },
  {
    label: "recover commit commit_sha and branch",
    fields: {
      event: EVENTS.RECOVER_COMMIT,
      state_from: "review_pending",
      state_to: "review_pending",
      head_sha: "deadbeef",
      commit_sha: "deadbeef",
      branch: "issue-281",
      reason: "executor completed before commit",
      pr_number: 281,
    },
    expected: { commit_sha: "deadbeef", branch: "issue-281" },
  },
];

test("appendRunEvent round-trips optional fields when provided", () => {
  for (const row of RUN_EVENT_FIELD_CASES) {
    const { repoRoot, runId } = createContext();
    const record = appendRunEvent(repoRoot, runId, row.fields);

    const [parsed] = readRunEvents(repoRoot, runId);
    for (const [key, value] of Object.entries(row.expected)) {
      assert.equal(record[key], value, `${row.label} record ${key}`);
      assert.equal(parsed[key], value, `${row.label} parsed ${key}`);
    }
  }
});

test("appendRunEvent omits last_reviewed_sha when absent", () => {
  const { repoRoot, runId } = createContext();
  const record = appendRunEvent(repoRoot, runId, {
    event: EVENTS.DISPATCH_START,
    state_from: "draft",
    state_to: "dispatched",
    reason: "start",
  });

  assert.equal(Object.prototype.hasOwnProperty.call(record, "last_reviewed_sha"), false);
});

// Test-side bare event strings below are intentional canaries: one proves write-time
// rejection of unknown current names, and one proves read-time tolerance for legacy
// historical journal names.
test("appendRunEvent throws on event name not in EVENTS", () => {
  const { repoRoot, runId } = createContext();
  assert.throws(
    () => appendRunEvent(repoRoot, runId, {
      event: "not_a_relay_event",
      state_from: "draft",
      state_to: "draft",
    }),
    /Unknown relay event name "not_a_relay_event"/
  );
});

test("readRunEvents tolerates historical-only event names", () => {
  const { repoRoot, runId } = createContext();
  const eventsPath = getEventsPath(repoRoot, runId);
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  const historicalEvent = { event: "manual_state_override", run_id: runId };
  fs.writeFileSync(eventsPath, `${JSON.stringify(historicalEvent)}\n`, "utf-8");

  assert.deepEqual(readRunEvents(repoRoot, runId), [historicalEvent]);
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
  assert.equal(record.actor, "Relay Events Test");
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
  assert.equal(record.actor, "Relay Events Test");
  assert.deepEqual(parsed, record);
  assert.deepEqual(readRunEvents(repoRoot, runId), [record]);
});

test("appendIterationScore falls back to unknown actor when git user.name is unavailable", () => {
  withGitIdentityDisabled(() => {
    const { repoRoot, runId } = createContextWithoutActor();
    const record = appendIterationScore(repoRoot, runId, {
      round: 1,
      scores: [createScore()],
    });

    assert.equal(record.actor, "unknown");
  });
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

// ---------------------------------------------------------------------------
// #197 — events.jsonl symlink trust-root refusal
// ---------------------------------------------------------------------------

test("appendRunEvent refuses when events.jsonl is replaced with a symlink", () => {
  const { repoRoot, runId } = createContext();
  // Seed the run layout with a legit first event.
  appendRunEvent(repoRoot, runId, { event: EVENTS.DISPATCH_START });

  const eventsPath = getEventsPath(repoRoot, runId);
  const victim = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-events-victim-")), "victim.jsonl");
  fs.writeFileSync(victim, "pre-existing victim content\n", "utf-8");

  fs.rmSync(eventsPath);
  fs.symlinkSync(victim, eventsPath);

  assert.throws(
    () => appendRunEvent(repoRoot, runId, { event: EVENTS.DISPATCH_RESULT }),
    /Refusing to (append to|open) symlinked/i
  );
  // Victim file must not have been mutated.
  assert.equal(fs.readFileSync(victim, "utf-8"), "pre-existing victim content\n");
});

test("readRunEvents refuses when events.jsonl is a symlink", () => {
  const { repoRoot, runId } = createContext();
  appendRunEvent(repoRoot, runId, { event: EVENTS.DISPATCH_START });

  const eventsPath = getEventsPath(repoRoot, runId);
  const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-events-foreign-"));
  const foreignEvents = path.join(foreignDir, "foreign-events.jsonl");
  fs.writeFileSync(foreignEvents, '{"event":"spoofed","run_id":"other"}\n', "utf-8");

  fs.rmSync(eventsPath);
  fs.symlinkSync(foreignEvents, eventsPath);

  assert.throws(
    () => readRunEvents(repoRoot, runId),
    /Refusing to (read|open) symlinked/i
  );
});

test("readRunEvents refuses dangling symlinks instead of silently returning []", () => {
  // #197 fail-closed: a dangling symlink at events.jsonl must NOT be treated
  // as "file missing" (existsSync follows links and would say "missing").
  const { repoRoot, runId } = createContext();
  appendRunEvent(repoRoot, runId, { event: EVENTS.DISPATCH_START });

  const eventsPath = getEventsPath(repoRoot, runId);
  fs.rmSync(eventsPath);
  // Point at a path that does not exist — dangling symlink.
  fs.symlinkSync("/nonexistent-relay-target-xyz", eventsPath);

  assert.throws(
    () => readRunEvents(repoRoot, runId),
    /Refusing to (read|open) symlinked/i
  );
});

test("appendRunEvent refuses dangling symlinks (no silent create-through)", () => {
  // #197 defense-in-depth: on platforms without O_NOFOLLOW, the previous
  // fallback used existsSync and would have called openSync(O_CREAT) through
  // a dangling symlink. This test proves the behavior on any platform — the
  // fallback in openForWriteWithoutFollowingSymlinks refuses dangling links.
  const { repoRoot, runId } = createContext();
  // Seed layout (without an events.jsonl yet).
  appendRunEvent(repoRoot, runId, { event: EVENTS.DISPATCH_START });

  const eventsPath = getEventsPath(repoRoot, runId);
  fs.rmSync(eventsPath);
  const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-events-dangling-"));
  const victimTarget = path.join(victimDir, "victim.jsonl");
  // Dangling: victimTarget does not exist yet.
  fs.symlinkSync(victimTarget, eventsPath);

  assert.throws(
    () => appendRunEvent(repoRoot, runId, { event: EVENTS.DISPATCH_RESULT }),
    /Refusing to (append to|open) symlinked/i
  );
  assert.equal(fs.existsSync(victimTarget), false, "victim target must not have been created through the symlink");
});
