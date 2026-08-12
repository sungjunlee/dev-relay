"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const host = require("../../../skills/relay-dispatch/scripts/host");

function directory(label) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-host-${label}-`)));
}

function acquire(runDir, attemptId, extra = {}) {
  return host.acquireRunLock({
    runDir,
    attemptId,
    operation: "test",
    worktreeDir: runDir,
    ...extra,
  });
}

function ownerRecord(runDir) {
  const ownership = path.join(runDir, "ownership");
  const ownerPath = fs.readdirSync(ownership)
    .filter((name) => name.endsWith(".owner.json"))
    .map((name) => path.join(ownership, name))[0];
  return { ownerPath, owner: JSON.parse(fs.readFileSync(ownerPath, "utf8")) };
}

function sign(body, secret, field = "result_auth_sha256") {
  const signature = crypto.createHmac("sha256", secret)
    .update(JSON.stringify(body))
    .digest("hex");
  return { ...body, [field]: signature };
}

test("host exposes only the trusted-local core operations", () => {
  assert.deepEqual(Object.keys(host).sort(), [
    "acquireRunLock",
    "assertRunLockHeld",
    "breakStaleRunLock",
    "cancelHost",
    "inspectOwnership",
    "launchLocalSupervisor",
    "releaseRunLock",
    "retainReviewerCleanup",
    "hostInvocation",
    "waitForTerminalResult",
    "withRunLock",
  ].sort());
});

test("lock capability binds object identity, open inode, run, and immutable generation", () => {
  const runDir = directory("capability");
  const lock = acquire(runDir, "capability");
  assert.equal(host.assertRunLockHeld(lock, runDir), true);
  assert.throws(() => host.assertRunLockHeld({ ...lock }, runDir), (error) => error.code === "LOCK_CAPABILITY_INVALID");
  assert.throws(() => host.assertRunLockHeld(lock, directory("other")), (error) => error.code === "LOCK_RUN_MISMATCH");

  const { ownerPath } = ownerRecord(runDir);
  fs.renameSync(ownerPath, `${ownerPath}.moved`);
  assert.throws(() => host.assertRunLockHeld(lock, runDir), (error) => error.code === "LOCK_INODE_MISMATCH");
});

test("the authoritative signed close precedes the single release outcome and generations are never reused", () => {
  const runDir = directory("close");
  const order = [], closeVisibleAtAudit = [];
  const closedPath = path.join(runDir, "ownership", "000000000001.closed.json");
  const lock = acquire(runDir, "first", { audit: (fragment) => order.push(fragment.type) });
  const firstOwner = ownerRecord(runDir).ownerPath;
  const released = host.releaseRunLock(lock, {
    outcome: "completed",
    audit: (fragment) => {
      order.push(fragment.type);
      if (fragment.type === "lock_released") closeVisibleAtAudit.push(fs.existsSync(closedPath));
    },
  });
  assert.deepEqual(order, ["lock_acquired", "lock_released"]);
  assert.deepEqual(closeVisibleAtAudit, [true], "no release outcome may be emitted before the signed close exists");
  assert.equal(released.outcome, "completed");
  assert.ok(fs.existsSync(firstOwner));
  assert.equal(released.markerPath, closedPath);
  assert.equal(host.inspectOwnership({ runDir }).status, "absent");

  const next = acquire(runDir, "second");
  const owners = fs.readdirSync(path.join(runDir, "ownership")).filter((name) => name.endsWith(".owner.json")).sort();
  assert.deepEqual(owners, ["000000000001.owner.json", "000000000002.owner.json"]);
  host.releaseRunLock(next);
});

test("a lost release receipt is replayed exactly once by the next lock holder", () => {
  const runDir = directory("audit-fail");
  const lock = acquire(runDir, "release-fail");
  assert.throws(() => host.releaseRunLock(lock, { audit: () => { throw new Error("audit failed"); } }), /audit failed/);
  assert.throws(() => host.assertRunLockHeld(lock, runDir), (error) => error.code === "LOCK_NOT_HELD");
  const closed = fs.readdirSync(path.join(runDir, "ownership")).filter((name) => name.endsWith(".closed.json"));
  assert.deepEqual(closed, ["000000000001.closed.json"], "the authoritative close survives a failed release receipt");
  assert.deepEqual(host.releaseRunLock(lock), { released: false, reason: "already_released" });

  const replayed = [];
  const second = acquire(runDir, "replay", { audit: (fragment, capability) => replayed.push([fragment.type, fragment.payload.outcome, capability.attempt_id]) });
  assert.deepEqual(replayed, [["lock_acquired", undefined, "replay"], ["lock_released", "released", "replay"]]);
  assert.equal(replayed.filter(([type]) => type === "lock_released").length, 1, "exactly one canonical release outcome is materialized");
  host.releaseRunLock(second);
  const third = [];
  const last = acquire(runDir, "replay-again", { audit: (fragment) => third.push([fragment.type, fragment.payload.outcome]) });
  assert.deepEqual(third.filter(([type]) => type === "lock_released"), [["lock_released", "released"], ["lock_released", "released"]]);
  host.releaseRunLock(last);

  const secondRun = directory("acquire-audit-fail");
  assert.throws(() => acquire(secondRun, "acquire-fail", { audit: () => { throw new Error("boom"); } }), (error) => error.code === "LOCK_AUDIT_FAILED");
  assert.equal(host.inspectOwnership({ runDir: secondRun }).status, "absent");
  assert.equal(fs.readdirSync(path.join(secondRun, "ownership")).filter((name) => name.endsWith(".closed.json")).length, 1);
});

test("unknown identity can be broken only by an exactly authenticated terminal result", async () => {
  const runDir = directory("terminal-proof");
  const lock = acquire(runDir, "foreign", { host: "foreign.example" });
  const { owner } = ownerRecord(runDir);
  const inspection = host.inspectOwnership({ runDir });
  assert.equal(inspection.status, "unknown");
  await assert.rejects(host.breakStaleRunLock({ inspection, reason: "no proof" }), (error) => error.code === "BREAK_EVIDENCE_INSUFFICIENT");

  const resultPath = path.join(runDir, "attempt-foreign.result.json");
  const body = {
    attempt_id: owner.attempt_id,
    lock_id: owner.lock_id,
    host_kind: "local_supervisor",
    host_handle: owner.host_handle,
    status: "cancelled",
    exit_code: null,
    signal: null,
    error: null,
    completed_at: new Date().toISOString(),
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(sign(body, owner.secret))}\n`, { mode: 0o600 });
  await host.breakStaleRunLock({ inspection, reason: "terminal proof", resultPath });
  assert.equal(host.inspectOwnership({ runDir }).status, "absent");
  assert.throws(() => host.assertRunLockHeld(lock, runDir));
});

test("dead local owner requires two internal probes separated by at least ten seconds", { timeout: 20_000 }, async () => {
  const runDir = directory("two-probes");
  const child = spawnSync(process.execPath, ["-e", [
    "const host=require('./skills/relay-dispatch/scripts/host');",
    "const fs=require('fs');",
    "const runDir=fs.realpathSync(process.argv[1]);",
    "host.acquireRunLock({runDir,attemptId:'dead-owner',operation:'test',worktreeDir:runDir});",
  ].join(""), runDir], { cwd: path.resolve(__dirname, "../../.."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const inspection = host.inspectOwnership({ runDir });
  assert.equal(inspection.status, "stale");
  const started = Date.now();
  await host.breakStaleRunLock({ inspection, reason: "confirmed dead" });
  assert.ok(Date.now() - started >= 9_900);
  assert.equal(host.inspectOwnership({ runDir }).status, "absent");
});

test("ownership directory creation converges when a competing creator wins", () => {
  const runDir = directory("mkdir-race"), target = path.join(runDir, "ownership"), originalExists = fs.existsSync, originalMkdir = fs.mkdirSync;
  fs.existsSync = (value) => value === target ? false : originalExists(value);
  fs.mkdirSync = (value, options) => { if (value === target) { originalMkdir(value, options); const error = new Error("race"); error.code = "EEXIST"; throw error; } return originalMkdir(value, options); };
  let capability; try { capability = acquire(runDir, "mkdir-race"); } finally { fs.existsSync = originalExists; fs.mkdirSync = originalMkdir; }
  host.releaseRunLock(capability);
});
