"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPTS = path.join(REPO_ROOT, "skills", "relay-orca", "scripts");
const STOP_JS = path.join(SCRIPTS, "stop.js");

const { RECEIPT_NOTE, parseReceipt, serializeReceipt, serializeReceiptWithRecords, STOP_REASON_MAX } = require(path.join(SCRIPTS, "lib", "receipt.js"));
const { REASONS: STOP_REASONS } = require(path.join(SCRIPTS, "lib", "stop-reasons.js"));
const { computeRepoSlug } = require(path.join(SCRIPTS, "lib", "repo-slug.js"));
const { programSegment } = require(path.join(SCRIPTS, "receipt-io.js"));
const { installFakeOrcaStop } = require(path.join(__dirname, "..", "fixtures", "fake-orca-stop.js"));
const { DEFAULT_RUNTIME_ID } = require(path.join(__dirname, "..", "fixtures", "fake-orca.js"));

const STOP_REPORT_KEYS = ["ok", "program_id", "receipt_path", "coordinator_stopped", "stopped_at", "stop_reason", "note", "blocking_reasons"];
const ALREADY_NOT_RUNNING_NOTE = "coordinator run already not running; treated as stopped (stop record written)";
const CANCELLATION_TOKENS = ["cancel", "cancelled", "canceled", "complete", "completed", "aborted", "discard"];
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function makeReceipt({ programId, slug, root }) {
  return {
    schema: 1,
    program_id: programId,
    source: "/tmp/accepted-program.json",
    repo: { slug, root },
    runtime_id: DEFAULT_RUNTIME_ID,
    tasks: [
      { outcome_id: "a", task_id: "orca-task-a", kind: "relay_run", wave: 1, orca_task_id: "orca-live-a", dispatch_id: "disp-orca-live-a", assignee: "term-a", relay_ids: { request: null, run: "run-a", fleet: null } },
    ],
    terminals_created: [],
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    note: RECEIPT_NOTE,
  };
}

function initGitRepo(root) {
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
}

function buildWorld({ programId, stopScenario = {}, corruptReceipt, receiptOverride }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orca-stop-"));
  const repoRoot = path.join(base, "repo");
  const programsRoot = path.join(base, "programs");
  fs.mkdirSync(repoRoot, { recursive: true });
  initGitRepo(repoRoot);
  const slug = computeRepoSlug(fs.realpathSync(repoRoot));
  const receiptDir = path.join(programsRoot, slug, programSegment(programId));
  fs.mkdirSync(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, "receipt.json");
  if (corruptReceipt !== undefined) {
    fs.writeFileSync(receiptPath, corruptReceipt, "utf-8");
  } else {
    const receipt = receiptOverride || makeReceipt({ programId, slug, root: fs.realpathSync(repoRoot) });
    fs.writeFileSync(receiptPath, serializeReceipt(receipt), "utf-8");
  }
  const orca = installFakeOrcaStop(stopScenario);
  return {
    base,
    repoRoot,
    programsRoot,
    slug,
    receiptPath,
    orca,
    receiptOnDisk() {
      return fs.readFileSync(receiptPath, "utf-8");
    },
    run(extraArgs = []) {
      const args = [STOP_JS, "--program-id", programId, "--json", "--orca-bin", orca.orcaPath, "--repo-root", repoRoot, ...extraArgs];
      const result = { status: 0, stdout: "", stderr: "" };
      try {
        result.stdout = execFileSync(process.execPath, args, { encoding: "utf-8", env: { ...process.env, RELAY_ORCA_PROGRAMS_ROOT: programsRoot }, stdio: "pipe" });
      } catch (error) {
        result.status = error.status;
        result.stdout = error.stdout ? String(error.stdout) : "";
        result.stderr = error.stderr ? String(error.stderr) : "";
      }
      result.body = result.stdout ? JSON.parse(result.stdout) : null;
      return result;
    },
    cleanup() {
      orca.cleanup();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

// Strip the two stop fields and re-serialize to prove only the stop fields changed.
function receiptMinusStop(text) {
  const receipt = parseReceipt(text).receipt;
  delete receipt.stopped_at;
  delete receipt.stop_reason;
  return serializeReceipt(receipt);
}

// ---------------------------------------------------------------------------
// D9.7 — run-stop invoked, bounded stop record added, nothing else changes
// ---------------------------------------------------------------------------

test("D9.7: stop invokes run-stop, records bounded stopped_at/stop_reason, only stop fields change, no cancellation language", () => {
  const programId = "epic-stop-basic";
  const world = buildWorld({ programId });
  const before = world.receiptOnDisk();
  try {
    const r = world.run(["--reason", "operator maintenance window"]);
    assert.equal(r.status, 0);
    assert.deepEqual(Object.keys(r.body), STOP_REPORT_KEYS);
    assert.equal(r.body.coordinator_stopped, true);
    assert.match(r.body.stopped_at, ISO_RE);
    assert.equal(r.body.stop_reason, "operator maintenance window");
    assert.equal(r.body.note, "");
    assert.deepEqual(r.body.blocking_reasons, []);

    // Exactly ONE mutating Orca subcommand — run-stop — was invoked.
    const log = world.orca.readLog();
    assert.deepEqual(log, ["orchestration run-stop --json"], "the only mutating subcommand is run-stop");
    assert.equal(world.orca.readPoison(), null, "restricted poison set never fires");

    // Byte comparison: only the stop fields changed.
    const after = world.receiptOnDisk();
    assert.notEqual(after, before, "stop fields were added");
    assert.equal(receiptMinusStop(after), before, "every non-stop field is byte-identical");
    const persisted = parseReceipt(after).receipt;
    assert.equal(persisted.stopped_at, r.body.stopped_at);
    assert.equal(persisted.stop_reason, "operator maintenance window");
    assert.equal(persisted.updated_at, "2026-07-12T00:00:00.000Z", "stop does not bump updated_at");

    // No cancellation/completion language anywhere in the report.
    const serialized = JSON.stringify(r.body).toLowerCase();
    CANCELLATION_TOKENS.forEach((token) => assert.ok(!serialized.includes(token), `stop report must not claim ${token}`));
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D5 — coordinator-only: restricted poison set proves no task/terminal is touched
// ---------------------------------------------------------------------------

test("D5: stop touches ONLY run-stop — no task-create/task-update/dispatch/terminal/reset/worktree", () => {
  const programId = "epic-stop-coordinator-only";
  const world = buildWorld({ programId });
  try {
    const r = world.run(["--reason", "pause"]);
    assert.equal(r.status, 0);
    const log = world.orca.readLog().join(" ");
    ["task-create", "task-update", "dispatch", "terminal", "reset", "worktree"].forEach((forbidden) => {
      assert.ok(!log.includes(forbidden), `stop must never invoke ${forbidden}; log=${log}`);
    });
    assert.equal(world.orca.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D9.13 — idempotency: second stop is a no-op, receipt byte-identical
// ---------------------------------------------------------------------------

test("D9.13: a second stop leaves the original stop record byte-identical and does not duplicate it", () => {
  const programId = "epic-stop-idempotent";
  const world = buildWorld({ programId });
  try {
    const first = world.run(["--reason", "first pause"]);
    assert.equal(first.status, 0);
    const afterFirst = world.receiptOnDisk();
    const firstStoppedAt = first.body.stopped_at;

    const second = world.run(["--reason", "second pause (should be ignored)"]);
    assert.equal(second.status, 0);
    assert.equal(second.body.coordinator_stopped, true, "second stop still reports the live run-stop result");
    assert.equal(second.body.stopped_at, firstStoppedAt, "second stop reports the ORIGINAL stopped_at");
    assert.equal(second.body.stop_reason, "first pause", "the original stop_reason is preserved, not overwritten");
    assert.equal(world.receiptOnDisk(), afterFirst, "the receipt is byte-identical after the second stop");

    // The stop record appears exactly once (never duplicated).
    const persisted = parseReceipt(world.receiptOnDisk()).receipt;
    assert.equal(persisted.stop_reason, "first pause");
    assert.equal(world.orca.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #1005 — the real no-active-run envelope is an accepted stopped condition
// ---------------------------------------------------------------------------

test("#1005: no-active-run succeeds with a note and writes only the stop record", () => {
  const programId = "epic-stop-no-active-run";
  const world = buildWorld({ programId, stopScenario: { mode: "no-active-run" } });
  const before = world.receiptOnDisk();
  try {
    const r = world.run(["--reason", "operator interruption"]);
    assert.equal(r.status, 0, "the parsed envelope wins over the fixture's nonzero exit");
    assert.deepEqual(Object.keys(r.body), STOP_REPORT_KEYS);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.coordinator_stopped, false);
    assert.match(r.body.stopped_at, ISO_RE);
    assert.equal(r.body.stop_reason, "operator interruption");
    assert.equal(r.body.note, ALREADY_NOT_RUNNING_NOTE);
    assert.deepEqual(r.body.blocking_reasons, []);

    const after = world.receiptOnDisk();
    assert.notEqual(after, before, "the stop record is written");
    assert.equal(receiptMinusStop(after), before, "only stopped_at and stop_reason change");
    const persisted = parseReceipt(after).receipt;
    assert.equal(persisted.note, RECEIPT_NOTE, "the report note is never persisted to the receipt");
    assert.equal(Object.hasOwn(persisted, "coordinator_stopped"), false);
    assert.deepEqual(world.orca.readLog(), ["orchestration run-stop --json"]);
    assert.equal(world.orca.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

test("#1005: no-active-run preserves an existing stop record byte-identically", () => {
  const programId = "epic-stop-no-active-idempotent";
  const world = buildWorld({ programId });
  try {
    const first = world.run(["--reason", "original pause"]);
    assert.equal(first.status, 0);
    const afterFirst = world.receiptOnDisk();

    world.orca.writeScenario({ mode: "no-active-run" });
    const second = world.run(["--reason", "replacement reason must be ignored"]);
    assert.equal(second.status, 0);
    assert.equal(second.body.ok, true);
    assert.equal(second.body.coordinator_stopped, false);
    assert.equal(second.body.stopped_at, first.body.stopped_at);
    assert.equal(second.body.stop_reason, "original pause");
    assert.equal(second.body.note, ALREADY_NOT_RUNNING_NOTE);
    assert.deepEqual(second.body.blocking_reasons, []);
    assert.equal(world.receiptOnDisk(), afterFirst, "the existing receipt remains byte-identical");
    assert.deepEqual(world.orca.readLog(), ["orchestration run-stop --json", "orchestration run-stop --json"]);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #1005 R1 — the stop write must NOT drop #947 additive record fields
// (follow_ups/decisions/authorizations/counters). Before #1005 the v0 stop always
// failed closed, so the write was unreachable; now the already_not_running success
// path (and the genuine run-stop success path) write, and a stop on a receipt carrying
// additive records must preserve them byte-for-byte — not silently delete them.
// ---------------------------------------------------------------------------

// Realistic #947 additive record shapes, mirroring the resume/status/gates write points.
const SEEDED_FOLLOW_UPS = [
  { id: "followup-later", source_outcome: "a", description: "operator deferred this", proposed_wave: 3, status: "deferred" },
];
const SEEDED_DECISIONS = [
  { id: "signoff", question: "proceed?", options: ["y", "n"], resolution: "approved", resolver: "alice", resolved_at: "2026-07-13T02:00:00Z", downstream_wave: 2 },
];

// Seed a receipt that carries additive records onto disk via the SAME serializer the
// run/resume/status write points use, so `before` is the real byte image a stop would meet.
function seedReceiptWithRecords(world, programId) {
  const receipt = makeReceipt({ programId, slug: world.slug, root: fs.realpathSync(world.repoRoot) });
  receipt.follow_ups = SEEDED_FOLLOW_UPS;
  receipt.decisions = SEEDED_DECISIONS;
  fs.writeFileSync(world.receiptPath, serializeReceiptWithRecords(receipt), "utf-8");
  return receipt;
}

// Strip the two stop fields and re-serialize WITH records, to prove that everything except
// the two stop fields — including the additive records — is byte-identical after a stop.
function receiptMinusStopWithRecords(text) {
  const receipt = parseReceipt(text).receipt;
  delete receipt.stopped_at;
  delete receipt.stop_reason;
  return serializeReceiptWithRecords(receipt);
}

test("#1005 R1: no-active-run stop preserves #947 additive records (follow_ups/decisions) byte-for-byte", () => {
  const programId = "epic-stop-additive-no-active";
  const world = buildWorld({ programId, stopScenario: { mode: "no-active-run" } });
  const seeded = seedReceiptWithRecords(world, programId);
  const before = world.receiptOnDisk();
  try {
    const r = world.run(["--reason", "operator interruption"]);
    assert.equal(r.status, 0, "no-active-run is an accepted stopped condition");
    assert.equal(r.body.ok, true);
    assert.equal(r.body.coordinator_stopped, false);
    assert.match(r.body.stopped_at, ISO_RE);
    assert.equal(r.body.note, ALREADY_NOT_RUNNING_NOTE);
    assert.deepEqual(r.body.blocking_reasons, []);

    const after = world.receiptOnDisk();
    assert.notEqual(after, before, "the stop record is written");
    // Everything except the two stop fields is byte-identical — the additive records survive.
    assert.equal(receiptMinusStopWithRecords(after), before, "only stopped_at and stop_reason change; additive records are preserved");

    const persisted = parseReceipt(after).receipt;
    assert.deepEqual(persisted.follow_ups, seeded.follow_ups, "follow_ups survive the stop write byte-for-byte");
    assert.deepEqual(persisted.decisions, seeded.decisions, "decisions survive the stop write byte-for-byte");
    assert.equal(persisted.stopped_at, r.body.stopped_at);
    assert.equal(persisted.stop_reason, "operator interruption");
    // Strongest byte check: the on-disk image is exactly the seeded records + the two stop keys.
    const expected = { ...seeded, stopped_at: r.body.stopped_at, stop_reason: r.body.stop_reason };
    assert.equal(after, serializeReceiptWithRecords(expected), "the stop write is byte-identical to records + the two stop keys");
    assert.equal(world.orca.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

test("#1005 R1: genuine run-stop success preserves #947 additive records byte-for-byte", () => {
  const programId = "epic-stop-additive-success";
  const world = buildWorld({ programId });
  const seeded = seedReceiptWithRecords(world, programId);
  const before = world.receiptOnDisk();
  try {
    const r = world.run(["--reason", "operator maintenance window"]);
    assert.equal(r.status, 0);
    assert.equal(r.body.coordinator_stopped, true);

    const after = world.receiptOnDisk();
    assert.notEqual(after, before, "the stop record is written");
    assert.equal(receiptMinusStopWithRecords(after), before, "only stop fields change; additive records preserved");
    const persisted = parseReceipt(after).receipt;
    assert.deepEqual(persisted.follow_ups, seeded.follow_ups);
    assert.deepEqual(persisted.decisions, seeded.decisions);
    assert.deepEqual(world.orca.readLog(), ["orchestration run-stop --json"]);
    assert.equal(world.orca.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// stop_reason is bounded (<=256)
// ---------------------------------------------------------------------------

test("D5: stop_reason is bounded to <=256 chars", () => {
  const programId = "epic-stop-bounded";
  const world = buildWorld({ programId });
  try {
    const r = world.run(["--reason", "x".repeat(1000)]);
    assert.equal(r.status, 0);
    assert.equal(r.body.stop_reason.length, STOP_REASON_MAX);
    assert.ok(r.body.stop_reason.length <= 256);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// run-stop failure → coordinator_stopped false, blocking_reason, no receipt write
// ---------------------------------------------------------------------------

test("run-stop failure → coordinator_stopped false, blocking_reasons, exit 65, receipt untouched", () => {
  const programId = "epic-stop-fail";
  const world = buildWorld({ programId, stopScenario: { mode: "generic-failure" } });
  const before = world.receiptOnDisk();
  try {
    const r = world.run(["--reason", "attempted"]);
    assert.equal(r.status, STOP_REASONS.COORDINATOR_STOP_FAILED);
    assert.equal(r.status, 65);
    assert.equal(r.body.coordinator_stopped, false);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.note, "");
    assert.ok(r.body.blocking_reasons.some((b) => b.reason_code === "COORDINATOR_STOP_FAILED"));
    assert.equal(r.body.stopped_at, null, "no stop record is written when run-stop fails");
    assert.equal(world.receiptOnDisk(), before, "the receipt is untouched on a failed stop");
    assert.equal(world.orca.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

test("run-stop ok envelope with stopped:false remains fail-closed", () => {
  const programId = "epic-stop-explicit-not-stopped";
  const world = buildWorld({ programId, stopScenario: { mode: "success", stopped: false } });
  const before = world.receiptOnDisk();
  try {
    const r = world.run(["--reason", "attempted"]);
    assert.equal(r.status, 65);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.coordinator_stopped, false);
    assert.equal(r.body.note, "");
    assert.equal(r.body.stopped_at, null);
    assert.equal(world.receiptOnDisk(), before);
  } finally {
    world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Receipt-layer fail-closed (50-52 verbatim) + usage
// ---------------------------------------------------------------------------

test("receipt: corrupted receipt → RECEIPT_CORRUPT exit 51, run-stop never invoked", () => {
  const programId = "epic-stop-corrupt";
  const world = buildWorld({ programId, corruptReceipt: "{ not json" });
  try {
    const r = world.run(["--reason", "x"]);
    assert.equal(r.status, 51);
    assert.equal(r.body.reason_code, "RECEIPT_CORRUPT");
    assert.deepEqual(world.orca.readLog(), [], "a corrupt receipt fails closed before run-stop");
    assert.equal(world.orca.readPoison(), null);
  } finally {
    world.cleanup();
  }
});

test("receipt: repo slug mismatch → RECEIPT_REPO_MISMATCH exit 52", () => {
  const programId = "epic-stop-repo-mismatch";
  const world = buildWorld({ programId, receiptOverride: null });
  // Rewrite the receipt with a foreign slug so the identity check fails closed.
  const receipt = makeReceipt({ programId, slug: "some-other-repo-deadbeef", root: "/tmp/other" });
  fs.writeFileSync(world.receiptPath, serializeReceipt(receipt), "utf-8");
  try {
    const r = world.run(["--reason", "x"]);
    assert.equal(r.status, 52);
    assert.equal(r.body.reason_code, "RECEIPT_REPO_MISMATCH");
    assert.deepEqual(world.orca.readLog(), []);
  } finally {
    world.cleanup();
  }
});

test("usage: unknown flag exits 64", () => {
  const world = buildWorld({ programId: "epic-stop-usage" });
  try {
    const r = world.run(["--bogus"]);
    assert.equal(r.status, 64);
  } finally {
    world.cleanup();
  }
});

test("usage: missing --program-id exits 64", () => {
  const world = buildWorld({ programId: "epic-stop-usage2" });
  try {
    const result = { status: 0 };
    try {
      execFileSync(process.execPath, [STOP_JS, "--json", "--orca-bin", world.orca.orcaPath, "--repo-root", world.repoRoot], { encoding: "utf-8", env: { ...process.env, RELAY_ORCA_PROGRAMS_ROOT: world.programsRoot }, stdio: "pipe" });
    } catch (error) {
      result.status = error.status;
    }
    assert.equal(result.status, 64);
  } finally {
    world.cleanup();
  }
});
