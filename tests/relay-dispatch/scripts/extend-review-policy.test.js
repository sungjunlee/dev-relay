"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  acquireManifestLock,
  createManifestSkeleton,
  readManifest,
  releaseManifestLock,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/manifest/store");
const {
  ensureRunLayout,
  getEventsPath,
} = require("../../../skills/relay-dispatch/scripts/manifest/paths");
const {
  PolicyUpdateRefusal,
  extendReviewPolicy,
} = require("../../../skills/relay-dispatch/scripts/extend-review-policy");

const SCRIPT = path.join(
  __dirname,
  "..", "..", "..",
  "skills", "relay-dispatch", "scripts", "extend-review-policy.js"
);
const RUN_ID = "issue-1053-20260722113152000-a1b2c3d4";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Review Policy Operator"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "operator@example.com"], { cwd: repoRoot, stdio: "pipe" });
}

function setupFixture(overrides = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-repo-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-home-"));
  initGitRepo(repoRoot);
  process.env.RELAY_HOME = relayHome;

  const layout = ensureRunLayout(repoRoot, RUN_ID);
  const manifest = createManifestSkeleton({
    repoRoot,
    runId: RUN_ID,
    branch: "issue-1053",
    baseBranch: "main",
    issueNumber: 1053,
    worktreePath: repoRoot,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest.state = overrides.state || "changes_requested";
  manifest.next_action = "await_redispatch";
  manifest.git.head_sha = overrides.headSha === undefined ? HEAD_SHA : overrides.headSha;
  manifest.review.rounds = overrides.rounds === undefined ? 7 : overrides.rounds;
  manifest.review.max_rounds = overrides.maxRounds === undefined ? 7 : overrides.maxRounds;
  manifest.timestamps.updated_at = "2026-07-19T16:49:07.992Z";
  writeManifest(layout.manifestPath, manifest, "# Notes\n\n## Review History\n");

  const eventsPath = getEventsPath(repoRoot, RUN_ID);
  fs.writeFileSync(eventsPath, overrides.eventsContent || "", "utf-8");
  return { repoRoot, relayHome, manifestPath: layout.manifestPath, eventsPath };
}

function runCommand(fixture, extraArgs, env = {}) {
  return spawnSync(process.execPath, [
    SCRIPT,
    "--repo", fixture.repoRoot,
    "--run-id", RUN_ID,
    ...extraArgs,
  ], {
    encoding: "utf-8",
    env: { ...process.env, RELAY_HOME: fixture.relayHome, ...env },
  });
}

function mutationArgs(maxRounds = "8", guards = {}) {
  return [
    "--max-rounds", maxRounds,
    "--reason", "Corrective redispatch requires public R8",
    "--expected-state", guards.state || "changes_requested",
    "--expected-round", String(guards.round ?? 7),
    "--expected-head", guards.head || HEAD_SHA,
    "--json",
  ];
}

function bytes(fixture) {
  return {
    manifest: fs.readFileSync(fixture.manifestPath),
    events: fs.existsSync(fixture.eventsPath) ? fs.readFileSync(fixture.eventsPath) : null,
  };
}

function assertBytesEqual(actual, expected) {
  assert.deepEqual(actual.manifest, expected.manifest, "manifest bytes must remain unchanged");
  assert.deepEqual(actual.events, expected.events, "event bytes must remain unchanged");
}

test("success monotonically updates the cap and appends one snapshot-consistent policy_updated event", () => {
  const fixture = setupFixture();
  const before = readManifest(fixture.manifestPath).data;
  const result = runCommand(fixture, mutationArgs());

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "updated");
  assert.deepEqual(output.delta, { current_max_rounds: 7, requested_max_rounds: 8, increase: 1 });

  const after = readManifest(fixture.manifestPath).data;
  assert.equal(after.review.max_rounds, 8);
  assert.notEqual(after.timestamps.updated_at, before.timestamps.updated_at);
  const normalizedAfter = structuredClone(after);
  normalizedAfter.review.max_rounds = before.review.max_rounds;
  normalizedAfter.timestamps.updated_at = before.timestamps.updated_at;
  assert.deepEqual(normalizedAfter, before, "only max_rounds and updated_at may change");

  const eventLines = fs.readFileSync(fixture.eventsPath, "utf-8").trim().split("\n").filter(Boolean);
  assert.equal(eventLines.length, 1);
  const event = JSON.parse(eventLines[0]);
  assert.equal(event.event, "policy_updated");
  assert.equal(event.state, "changes_requested");
  assert.equal(event.state_from, "changes_requested");
  assert.equal(event.state_to, "changes_requested");
  assert.equal(event.round, 7);
  assert.equal(event.head_sha, HEAD_SHA);
  assert.equal(event.old_max_rounds, 7);
  assert.equal(event.new_max_rounds, 8);
  assert.equal(event.reason, "Corrective redispatch requires public R8");
  assert.equal(event.actor, "Review Policy Operator");
  assert.equal(event.origin, "operator");
  assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.notEqual(event.event, "state_recovery");
});

test("dry-run derives guards and reports the delta with zero mutation", () => {
  const fixture = setupFixture({ eventsContent: '{"event":"dispatch_result"}\n' });
  const before = bytes(fixture);
  const result = runCommand(fixture, [
    "--max-rounds", "8",
    "--reason", "Preview one more review",
    "--dry-run",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "dry_run");
  assert.deepEqual(output.guards, {
    expected_state: "changes_requested",
    expected_round: 7,
    expected_head: HEAD_SHA,
  });
  assert.deepEqual(output.delta, { current_max_rounds: 7, requested_max_rounds: 8, increase: 1 });
  assertBytesEqual(bytes(fixture), before);
});

test("equal and decreased caps are refused idempotently with structured exit 2", () => {
  for (const requested of ["7", "6"]) {
    const fixture = setupFixture();
    const before = bytes(fixture);
    const result = runCommand(fixture, mutationArgs(requested));
    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "refused");
    assert.equal(output.error_code, "non_monotonic_max_rounds");
    assertBytesEqual(bytes(fixture), before);
  }
});

test("malformed or omitted max-rounds and blank reason fail closed", () => {
  for (const args of [
    mutationArgs("0"),
    mutationArgs("2.5"),
    mutationArgs("bogus"),
    ["--reason", "valid", "--json"],
    ["--max-rounds", "8", "--reason", "", "--json"],
  ]) {
    const fixture = setupFixture();
    const before = bytes(fixture);
    const result = runCommand(fixture, args);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).status, "refused");
    assertBytesEqual(bytes(fixture), before);
  }
});

test("mutating call requires all explicit guards", () => {
  const fixture = setupFixture();
  const before = bytes(fixture);
  const result = runCommand(fixture, [
    "--max-rounds", "8",
    "--reason", "No implicit guard snapshot",
    "--json",
  ]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error_code, "missing_guards");
  assertBytesEqual(bytes(fixture), before);
});

test("dry-run guards reject concurrent manifest drift and stale HEAD without mutation", () => {
  const fixture = setupFixture();
  const preview = runCommand(fixture, [
    "--max-rounds", "8", "--reason", "Preview", "--dry-run", "--json",
  ]);
  assert.equal(preview.status, 0, preview.stderr);
  const guards = JSON.parse(preview.stdout).guards;

  const record = readManifest(fixture.manifestPath);
  record.data.review.rounds = 8;
  record.data.git.head_sha = "fedcba9876543210fedcba9876543210fedcba98";
  writeManifest(fixture.manifestPath, record.data, record.body);
  const afterDrift = bytes(fixture);

  const result = runCommand(fixture, mutationArgs("9", {
    state: guards.expected_state,
    round: guards.expected_round,
    head: guards.expected_head,
  }));
  assert.equal(result.status, 2, result.stderr);
  const refusal = JSON.parse(result.stdout);
  assert.equal(refusal.error_code, "concurrent_manifest_drift");
  assert.deepEqual(refusal.mismatches.map((item) => item.guard).sort(), ["expected_head", "expected_round"]);
  assertBytesEqual(bytes(fixture), afterDrift);
});

test("invalid/terminal states and a missing event sink are real refusals", () => {
  for (const scenario of ["invalid", "terminal", "missing_events"]) {
    const fixture = setupFixture({
      state: scenario === "invalid" ? "forged_state" : scenario === "terminal" ? "merged" : "changes_requested",
    });
    if (scenario === "missing_events") fs.unlinkSync(fixture.eventsPath);
    const before = bytes(fixture);
    const result = runCommand(fixture, mutationArgs());
    assert.equal(result.status, 2, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).error_code,
      scenario === "invalid"
        ? "invalid_state"
        : scenario === "terminal" ? "terminal_state" : "missing_event_sink"
    );
    assertBytesEqual(bytes(fixture), before);
  }
});

test("an unwritable event sink blocks the mutation instead of acting as a warning", () => {
  const fixture = setupFixture({ eventsContent: '{"event":"dispatch_start"}\n' });
  const before = bytes(fixture);
  fs.chmodSync(fixture.eventsPath, 0o444);
  try {
    const result = runCommand(fixture, mutationArgs());
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).error_code, "unwritable_event_sink");
    assertBytesEqual(bytes(fixture), before);
  } finally {
    fs.chmodSync(fixture.eventsPath, 0o644);
  }
});

test("simulated manifest write failure rolls back with zero event mutation", () => {
  const fixture = setupFixture({ eventsContent: '{"event":"dispatch_start"}\n' });
  const before = bytes(fixture);
  process.env.RELAY_HOME = fixture.relayHome;

  assert.throws(
    () => extendReviewPolicy({
      repoRoot: fixture.repoRoot,
      runId: RUN_ID,
      maxRounds: "8",
      reason: "Simulate storage failure",
      expectedState: "changes_requested",
      expectedRound: "7",
      expectedHead: HEAD_SHA,
    }, {
      writeManifestUnlocked() {
        const error = new Error("simulated write failure");
        error.code = "EIO";
        throw error;
      },
    }),
    (error) => error instanceof PolicyUpdateRefusal && error.result.error_code === "manifest_write_failed"
  );
  assertBytesEqual(bytes(fixture), before);
});

test("manifest lock contention exits 2 and leaves manifest and event bytes untouched", () => {
  const fixture = setupFixture();
  const before = bytes(fixture);
  const lock = acquireManifestLock(fixture.manifestPath);
  try {
    const result = runCommand(fixture, mutationArgs(), {
      RELAY_MANIFEST_LOCK_TIMEOUT_MS: "20",
      RELAY_MANIFEST_LOCK_POLL_MS: "5",
      RELAY_MANIFEST_LOCK_STALE_MS: "60000",
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).error_code, "lock_contention");
    assertBytesEqual(bytes(fixture), before);
  } finally {
    releaseManifestLock(lock);
  }
});

test("event append failure restores both files to their exact pre-transaction bytes", () => {
  const fixture = setupFixture({ eventsContent: '{"event":"dispatch_start"}\n' });
  const before = bytes(fixture);
  process.env.RELAY_HOME = fixture.relayHome;

  assert.throws(
    () => extendReviewPolicy({
      repoRoot: fixture.repoRoot,
      runId: RUN_ID,
      maxRounds: "8",
      reason: "Exercise paired rollback",
      expectedState: "changes_requested",
      expectedRound: "7",
      expectedHead: HEAD_SHA,
    }, {
      appendRunEvent(_repoRoot, _runId, _event, options) {
        fs.appendFileSync(options.eventsPath, "partial-event\n", "utf-8");
        throw new Error("simulated event failure");
      },
    }),
    (error) => error instanceof PolicyUpdateRefusal && error.result.error_code === "event_append_failed"
  );
  assertBytesEqual(bytes(fixture), before);
});
