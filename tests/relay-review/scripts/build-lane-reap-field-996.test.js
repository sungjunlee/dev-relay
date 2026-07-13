"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildLaneReapField,
} = require("../../../skills/relay-review/scripts/review-runner/advisory-lane-reap");

function entry(outcome, pgid, extras = {}) {
  return { outcome, pgid, ...extras };
}

test("buildLaneReapField #996 empty / non-array → stale default", () => {
  assert.deepEqual(buildLaneReapField([]), { outcome: "stale", pgid: null });
  assert.deepEqual(buildLaneReapField(null), { outcome: "stale", pgid: null });
  assert.deepEqual(buildLaneReapField(undefined), { outcome: "stale", pgid: null });
  assert.deepEqual(buildLaneReapField({}), { outcome: "stale", pgid: null });
});

test("buildLaneReapField #996 single reaped → unchanged primary", () => {
  const outcomes = [entry("reaped", 111, { signaled_kill: true })];
  assert.deepEqual(buildLaneReapField(outcomes), {
    outcome: "reaped",
    pgid: 111,
    signaled_kill: true,
  });
});

test("buildLaneReapField #996 [skipped_host_mismatch, reaped] → reaped (newer attempt)", () => {
  const outcomes = [
    entry("skipped_host_mismatch", 10, { reviewer: "codex", round: 1 }),
    entry("reaped", 20, { signaled_kill: false }),
  ];
  const field = buildLaneReapField(outcomes);
  assert.equal(field.outcome, "reaped");
  assert.equal(field.pgid, 20);
  assert.equal(field.signaled_kill, false);
  assert.equal(field.all, outcomes);
});

test("buildLaneReapField #996 [stale, reaped] → reaped", () => {
  const outcomes = [
    entry("stale", 30),
    entry("reaped", 40, { signaled_kill: true }),
  ];
  const field = buildLaneReapField(outcomes);
  assert.equal(field.outcome, "reaped");
  assert.equal(field.pgid, 40);
  assert.equal(field.signaled_kill, true);
  assert.equal(field.all, outcomes);
});

test("buildLaneReapField #996 [reaped, reap_failed] → reap_failed (higher precedence)", () => {
  const outcomes = [
    entry("reaped", 50, { signaled_kill: false }),
    entry("reap_failed", 60, { signaled_kill: true }),
  ];
  const field = buildLaneReapField(outcomes);
  assert.equal(field.outcome, "reap_failed");
  assert.equal(field.pgid, 60);
  assert.equal(field.signaled_kill, true);
  assert.equal(field.all, outcomes);
});

test("buildLaneReapField #996 ties within class resolve to LAST (newest attempt)", () => {
  const outcomes = [
    entry("stale", 70),
    entry("would_remove_stale", 80),
    entry("skipped_pid_reuse", 90),
  ];
  const field = buildLaneReapField(outcomes);
  assert.equal(field.outcome, "skipped_pid_reuse");
  assert.equal(field.pgid, 90);
  assert.equal(field.all, outcomes);
});

test("buildLaneReapField #996 would_reap preferred over stale / host-mismatch / corrupt", () => {
  const outcomes = [
    entry("skipped_host_mismatch", 1),
    entry("corrupt", null),
    entry("stale", 2),
    entry("would_reap", 3),
  ];
  const field = buildLaneReapField(outcomes);
  assert.equal(field.outcome, "would_reap");
  assert.equal(field.pgid, 3);
  assert.equal(field.all, outcomes);
});

test("buildLaneReapField #996 all preserved on every multi-outcome case", () => {
  const cases = [
    [entry("skipped_host_mismatch", 1), entry("reaped", 2)],
    [entry("stale", 1), entry("reaped", 2)],
    [entry("reaped", 1), entry("reap_failed", 2)],
    [entry("corrupt", null), entry("would_remove_corrupt", null)],
  ];
  for (const outcomes of cases) {
    const field = buildLaneReapField(outcomes);
    assert.equal(field.all, outcomes, `all must be same array ref for ${outcomes.map((o) => o.outcome)}`);
    assert.equal(field.all.length, outcomes.length);
  }
});
