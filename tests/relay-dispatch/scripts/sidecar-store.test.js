const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ensureRunLayout,
  getSidecarOutputDir,
  getSidecarsDir,
  getSidecarsIndexPath,
} = require("../../../skills/relay-dispatch/scripts/manifest/paths");
const {
  appendRunEvent,
  EVENTS,
  readRunEvents,
} = require("../../../skills/relay-dispatch/scripts/relay-events");
const {
  appendSidecarFailed,
  appendSidecarResult,
  appendSidecarStart,
  readSidecarIndex,
  SIDECAR_TRUST_LEVEL,
  upsertSidecarEntry,
} = require("../../../skills/relay-dispatch/scripts/sidecar-store");

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Sidecar Test"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay@example.com"], { cwd: repoRoot, stdio: "pipe" });
}

function createContext() {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-sidecar-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sidecar-repo-"));
  initGitRepo(repoRoot);
  const runId = "issue-372-20260508010101000-a1b2c3d4";
  ensureRunLayout(repoRoot, runId);
  return { repoRoot, runId };
}

function createEntry(overrides = {}) {
  return {
    id: "lint-report",
    kind: "static-analysis",
    executor: "codex",
    model: "gpt-5",
    provider: "openai",
    status: "pending",
    output_path: "sidecars/lint-report/result.json",
    trust_level: SIDECAR_TRUST_LEVEL,
    ...overrides,
  };
}

test("readSidecarIndex returns an empty index without creating storage", () => {
  const { repoRoot, runId } = createContext();
  const sidecarsDir = getSidecarsDir(repoRoot, runId);
  const indexPath = getSidecarsIndexPath(repoRoot, runId);

  assert.deepEqual(readSidecarIndex(repoRoot, runId), { sidecars: [] });
  assert.equal(fs.existsSync(sidecarsDir), false);
  assert.equal(fs.existsSync(indexPath), false);
});

test("upsertSidecarEntry lazily creates index.json and replaces entries by id", () => {
  const { repoRoot, runId } = createContext();
  const first = upsertSidecarEntry(repoRoot, runId, createEntry({ model: undefined, provider: undefined }));
  const second = upsertSidecarEntry(repoRoot, runId, createEntry({
    status: "completed",
    output_path: "sidecars/lint-report/result.json",
  }));

  assert.deepEqual(first, {
    id: "lint-report",
    kind: "static-analysis",
    executor: "codex",
    model: null,
    provider: null,
    status: "pending",
    output_path: "sidecars/lint-report/result.json",
    trust_level: SIDECAR_TRUST_LEVEL,
  });
  assert.equal(fs.existsSync(getSidecarsIndexPath(repoRoot, runId)), true);
  assert.deepEqual(readSidecarIndex(repoRoot, runId), { sidecars: [second] });
  assert.equal(readSidecarIndex(repoRoot, runId).sidecars.length, 1);
});

test("upsertSidecarEntry validates status, trust level, and id-scoped output paths", () => {
  const { repoRoot, runId } = createContext();

  assert.throws(
    () => upsertSidecarEntry(repoRoot, runId, createEntry({ status: "partial" })),
    /status must be one of: pending, running, completed, failed/
  );
  assert.throws(
    () => upsertSidecarEntry(repoRoot, runId, createEntry({ trust_level: "evidence" })),
    /trust_level must be "advisory"/
  );
  assert.throws(
    () => upsertSidecarEntry(repoRoot, runId, createEntry({ output_path: "../escape" })),
    /output_path must be run-dir-relative/
  );
  assert.throws(
    () => upsertSidecarEntry(repoRoot, runId, createEntry({ output_path: path.join(os.tmpdir(), "escape") })),
    /output_path must be run-dir-relative/
  );
  assert.throws(
    () => upsertSidecarEntry(repoRoot, runId, createEntry({ output_path: "rubric.json" })),
    /output_path must be under sidecars\/lint-report\//
  );
  assert.throws(
    () => upsertSidecarEntry(repoRoot, runId, createEntry({ output_path: "sidecars/other/result.json" })),
    /output_path must be under sidecars\/lint-report\//
  );
  assert.throws(
    () => upsertSidecarEntry(repoRoot, runId, createEntry({ output_path: "sidecars/lint-report" })),
    /output_path must be under sidecars\/lint-report\//
  );
  assert.throws(
    () => upsertSidecarEntry(repoRoot, runId, createEntry({
      id: "other",
      output_path: "sidecars/lint-report/result.json",
    })),
    /output_path must be under sidecars\/other\//
  );
});

test("readSidecarIndex refuses symlinked index.json", () => {
  const { repoRoot, runId } = createContext();
  const sidecarsDir = getSidecarsDir(repoRoot, runId);
  const indexPath = getSidecarsIndexPath(repoRoot, runId);
  const targetPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-sidecar-target-")), "index.json");
  fs.mkdirSync(sidecarsDir, { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify({ sidecars: [] }), "utf-8");
  fs.symlinkSync(targetPath, indexPath);

  assert.throws(
    () => readSidecarIndex(repoRoot, runId),
    /Refusing to read symlinked sidecars index/
  );
  assert.throws(
    () => upsertSidecarEntry(repoRoot, runId, createEntry()),
    /Refusing to read symlinked sidecars index/
  );
});

test("getSidecarOutputDir exposes but does not create per-sidecar output directories", () => {
  const { repoRoot, runId } = createContext();
  const outputDir = getSidecarOutputDir(repoRoot, runId, "lint-report");

  assert.equal(outputDir, path.join(getSidecarsDir(repoRoot, runId), "lint-report"));
  assert.equal(fs.existsSync(outputDir), false);
  assert.throws(
    () => getSidecarOutputDir(repoRoot, runId, "../escape"),
    /sidecar_id must be a single path segment|sidecar_id may not be/
  );
});

test("sidecar lifecycle helpers append advisory events without manifest state transitions", () => {
  const { repoRoot, runId } = createContext();
  const started = appendSidecarStart(repoRoot, runId, {
    id: "lint-report",
    kind: "static-analysis",
    executor: "codex",
    model: "gpt-5",
    provider: "openai",
  });
  const completed = appendSidecarResult(repoRoot, runId, {
    id: "lint-report",
    kind: "static-analysis",
    output_path: "sidecars/lint-report/result.json",
    elapsed_ms: 123,
  });
  const failed = appendSidecarFailed(repoRoot, runId, {
    id: "coverage-report",
    kind: "coverage",
    failure_reason: "tool exited 1",
  });

  assert.equal(started.event, EVENTS.SIDECAR_START);
  assert.equal(started.sidecar_id, "lint-report");
  assert.equal(started.executor, "codex");
  assert.equal(started.model, "gpt-5");
  assert.equal(started.provider, "openai");
  assert.equal(started.trust_level, SIDECAR_TRUST_LEVEL);
  assert.equal(completed.event, EVENTS.SIDECAR_RESULT);
  assert.equal(completed.output_path, "sidecars/lint-report/result.json");
  assert.equal(completed.trust_level, SIDECAR_TRUST_LEVEL);
  assert.equal(completed.elapsed_ms, 123);
  assert.equal(completed.sidecar_elapsed_ms, 123);
  assert.equal(completed.critical_path_wait_ms, 0);
  assert.equal(completed.consumed_by_phase, "metrics");
  assert.equal(completed.phase_decision_waited, false);
  assert.equal(completed.frontier_step_replaced, false);
  assert.equal(failed.event, EVENTS.SIDECAR_FAILED);
  assert.equal(failed.failure_reason, "tool exited 1");

  const events = readRunEvents(repoRoot, runId);
  assert.deepEqual(events, [started, completed, failed]);
  for (const event of events) {
    assert.equal(event.state_from, null);
    assert.equal(event.state_to, null);
  }
});

test("sidecar events coexist with legacy-shaped non-sidecar events", () => {
  const { repoRoot, runId } = createContext();
  const dispatchStart = appendRunEvent(repoRoot, runId, {
    event: EVENTS.DISPATCH_START,
    state_from: "draft",
    state_to: "dispatched",
    reason: "start",
  });
  const sidecarResult = appendSidecarResult(repoRoot, runId, {
    id: "lint-report",
    kind: "static-analysis",
    output_path: "sidecars/lint-report/result.json",
  });

  const events = readRunEvents(repoRoot, runId);
  assert.deepEqual(events, [dispatchStart, sidecarResult]);
  for (const key of ["sidecar_id", "kind", "output_path", "trust_level"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(events[0], key), false);
  }
  assert.equal(events[1].trust_level, SIDECAR_TRUST_LEVEL);
});

test("appendSidecarResult rejects output paths outside the matching sidecar directory", () => {
  const { repoRoot, runId } = createContext();

  assert.throws(
    () => appendSidecarResult(repoRoot, runId, {
      id: "lint-report",
      kind: "static-analysis",
      output_path: "sidecars/other/result.json",
    }),
    /output_path must be under sidecars\/lint-report\//
  );
});
