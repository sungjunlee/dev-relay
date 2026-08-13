"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const host = require("../../../skills/relay-dispatch/scripts/host");

const FAKE_OPENCODE = path.join(__dirname, "../fixtures/fake-opencode.js");

function roots(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-supervisor-${label}-`)));
  const runDir = path.join(root, "run"), worktree = path.join(root, "worktree");
  fs.mkdirSync(runDir); fs.mkdirSync(worktree);
  return { root, runDir: fs.realpathSync(runDir), worktree: fs.realpathSync(worktree) };
}

function lock(value, attemptId) {
  return host.acquireRunLock({ runDir: value.runDir, attemptId, operation: "dispatch", worktreeDir: value.worktree });
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function processDead(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
}

const IDLE = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";

// Reads exactly what host.js reads. A same-second PID reuse is indistinguishable here by construction:
// `lstart` has one-second resolution, so an unrelated process occupying a recorded PID yields a matching
// {pid, pgid, started_at} triple. Only the inherited scope token separates the two.
function liveIdentity(pid) {
  if (process.platform === "linux" && fs.existsSync(`/proc/${pid}/stat`)) {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8"), close = raw.lastIndexOf(")"), fields = raw.slice(close + 2).trim().split(/\s+/);
    const ticks = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim());
    const boot = Number(fs.readFileSync("/proc/stat", "utf8").split(/\r?\n/).find((line) => line.startsWith("btime ")).slice(6));
    return { pid, pgid: Number(fields[2]), started_at: new Date((boot + Number(fields[19]) / ticks) * 1000).toISOString() };
  }
  const out = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pgid=,lstart="], { encoding: "utf8" }).stdout.trim();
  const match = out.match(/^(\d+)\s+(.*)$/);
  assert.ok(match, `no ps row for ${pid}`);
  return { pid, pgid: Number(match[1]), started_at: new Date(Date.parse(match[2].replace(/\s+/g, " "))).toISOString() };
}

// Orphaned on purpose: the idle process must be reaped by init, not linger as a zombie child of the test.
function spawnIdle(env) {
  const launcher = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(IDLE)}],{detached:true,stdio:'ignore'});c.unref();process.stdout.write(String(c.pid))`;
  const launched = spawnSync(process.execPath, ["-e", launcher], { encoding: "utf8", env, timeout: 20_000 });
  assert.equal(launched.status, 0, launched.stderr);
  return { pid: Number(launched.stdout.trim()) };
}

function spawnScopeDroppingIdle(env, markerPath) {
  const shell = 'printf %s "$RELAY_PROCESS_SCOPE" > "$1"; shift; exec /usr/bin/env -u RELAY_PROCESS_SCOPE "$@"';
  const args = ["-c", shell, "relay-drop-scope", markerPath, process.execPath, "-e", IDLE];
  const launcher = `const c=require('child_process').spawn('/bin/sh',${JSON.stringify(args)},{detached:true,stdio:'ignore',env:${JSON.stringify(env)}});c.unref();process.stdout.write(String(c.pid))`;
  const launched = spawnSync(process.execPath, ["-e", launcher], { encoding: "utf8", timeout: 20_000 });
  assert.equal(launched.status, 0, launched.stderr);
  return { pid: Number(launched.stdout.trim()) };
}

function ownerSecret(runDir) {
  const ownership = path.join(runDir, "ownership");
  const name = fs.readdirSync(ownership).filter((entry) => entry.endsWith(".owner.json")).sort().at(-1);
  return JSON.parse(fs.readFileSync(path.join(ownership, name), "utf8"));
}

function writeCleanupObligation(runDir, attemptId, obligation, kind = obligation.staged_input_root ? "reviewer" : "executor") {
  const owner = ownerSecret(runDir);
  const body = {
    v: 2, kind, attempt_id: attemptId, lock_id: owner.lock_id, host_handle: owner.host_handle,
    identities: { supervisor: { pid: owner.process.pid, pgid: owner.process.pgid, started_at: owner.process.started_at }, executor: null },
    error: "injected cleanup obligation", terminal: { status: "failed", exit_code: 1, signal: null },
    obligation, observed_at: new Date().toISOString(),
  };
  const signature = crypto.createHmac("sha256", owner.secret).update(JSON.stringify(body)).digest("hex");
  fs.writeFileSync(path.join(runDir, `host-attempt-${attemptId}.cleanup-incomplete.json`),
    `${JSON.stringify({ ...body, auth_sha256: signature })}\n`, { mode: 0o600 });
}

function stagedInputRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "relay-review-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a same-second PID reuse without the inherited scope token is never signalled", { timeout: 30_000 }, async (t) => {
  const scope = host.hostInvocation.beginProcessScope();
  const foreign = spawnIdle({ PATH: process.env.PATH }), member = spawnIdle({ PATH: process.env.PATH, ...scope.env });
  t.after(() => { for (const child of [foreign, member]) if (!processDead(child.pid)) try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(liveIdentity(foreign.pid).pgid, foreign.pid, "the foreign process leads its own group");

  const foreignAudit = host.hostInvocation.reapProcessGroup(foreign.pid, scope.seal);
  assert.deepEqual(foreignAudit, { survived_terminal: false, absent: false, unverified: true });
  assert.equal(processDead(foreign.pid), false, "an unrelated same-PID group must never be signalled");

  const scopedAudit = host.hostInvocation.reapProcessGroup(member.pid, scope.seal);
  assert.equal(scopedAudit.survived_terminal, true);
  assert.equal(scopedAudit.absent, true);
  assert.equal(scopedAudit.unverified, false);
  assert.equal(processDead(member.pid), true);
  assert.equal(processDead(foreign.pid), false);
});

test("group reap signals only individually scope-verified PIDs and preserves an unrelated PGID member", { timeout: 30_000 }, async (t) => {
  const scope = host.hostInvocation.beginProcessScope(), value = roots("mixed-pgid"), pidsPath = path.join(value.root, "pids.json");
  const leaderScript = [
    "const {spawn}=require('child_process'),fs=require('fs');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(IDLE)}],{env:{PATH:process.env.PATH},stdio:'ignore'});`,
    `fs.writeFileSync(${JSON.stringify(pidsPath)},JSON.stringify({leader:process.pid,outsider:child.pid}));`,
    IDLE,
  ].join("");
  const launcher = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaderScript)}],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH,...${JSON.stringify(scope.env)}}});c.unref();`;
  const launched = spawnSync(process.execPath, ["-e", launcher], { encoding: "utf8", timeout: 20_000 });
  assert.equal(launched.status, 0, launched.stderr); await waitForFile(pidsPath);
  const pids = JSON.parse(fs.readFileSync(pidsPath, "utf8"));
  t.after(() => { for (const pid of Object.values(pids)) if (!processDead(pid)) try { process.kill(pid, "SIGKILL"); } catch {} });
  assert.equal(liveIdentity(pids.leader).pgid, pids.leader);
  assert.equal(liveIdentity(pids.outsider).pgid, pids.leader, "the outsider intentionally shares the leader PGID");

  const audit = host.hostInvocation.reapProcessGroup(pids.leader, scope.seal);
  assert.equal(audit.survived_terminal, true);
  assert.equal(audit.absent, false);
  assert.equal(audit.unverified, true);
  assert.equal(processDead(pids.leader), true, "the verified scoped leader is reaped");
  assert.equal(processDead(pids.outsider), false, "the unscoped member is never reached by a group signal");
});

test("lost cleanup scope proof requires exact external action and then converges", { timeout: 30_000 }, async (t) => {
  const value = roots("scope-loss"), attemptId = "scope-loss", capability = lock(value, attemptId);
  const scope = host.hostInvocation.beginProcessScope(), marker = path.join(value.root, "inherited-scope.txt");
  const foreign = spawnScopeDroppingIdle({ PATH: process.env.PATH, ...scope.env }, marker);
  t.after(() => { if (!processDead(foreign.pid)) try { process.kill(-foreign.pid, "SIGKILL"); } catch {} try { host.releaseRunLock(capability); } catch {} });
  await waitForFile(marker);
  assert.equal(fs.readFileSync(marker, "utf8"), scope.env.RELAY_PROCESS_SCOPE, "the process must inherit the run scope before dropping it");
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [liveIdentity(foreign.pid)], staged_input_root: null,
    scope_seal: scope.seal,
  });
  const inspection = host.inspectOwnership({ runDir: value.runDir });
  await assert.rejects(host.breakStaleRunLock({ inspection, reason: "settle an unverified cleanup identity" }), (error) => {
    assert.equal(error.code, "HOST_CLEANUP_EXTERNAL_ACTION_REQUIRED");
    assert.equal(error.recommended_action, "terminate_exact_process_externally_then_retry");
    assert.deepEqual(error.process_identity, liveIdentity(foreign.pid));
    assert.equal(error.relay_signalled, false);
    return true;
  });
  assert.equal(processDead(foreign.pid), false, "a cleanup obligation must never signal an unverifiable identity");
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), false);

  process.kill(foreign.pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await host.breakStaleRunLock({
    inspection: host.inspectOwnership({ runDir: value.runDir }),
    reason: "exact external process termination completed",
  });
  assert.equal(host.inspectOwnership({ runDir: value.runDir }).status, "absent");
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), true);
  assert.equal(fs.existsSync(path.join(value.runDir, `attempt-${attemptId}.result.json`)), true);
});

test("Linux cleanup retains stat identity when proc cmdline is unreadable", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "linux") return;
  const value = roots("linux-redacted-cmdline"), attemptId = "linux-redacted-cmdline", capability = lock(value, attemptId);
  const scope = host.hostInvocation.beginProcessScope(), marker = path.join(value.root, "inherited-scope.txt");
  const foreign = spawnScopeDroppingIdle({ PATH: process.env.PATH, ...scope.env }, marker);
  t.after(() => { if (!processDead(foreign.pid)) try { process.kill(-foreign.pid, "SIGKILL"); } catch {} try { host.releaseRunLock(capability); } catch {} });
  await waitForFile(marker);
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [liveIdentity(foreign.pid)], staged_input_root: null,
    scope_seal: scope.seal,
  });
  const realReadFile = fs.readFileSync;
  fs.readFileSync = function redactCmdline(filePath, ...args) {
    if (filePath === `/proc/${foreign.pid}/cmdline`) { const error = new Error("redacted"); error.code = "EACCES"; throw error; }
    return realReadFile.call(this, filePath, ...args);
  };
  try {
    await assert.rejects(
      host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "do not lose redacted live identity" }),
      (error) => error.code === "HOST_CLEANUP_EXTERNAL_ACTION_REQUIRED" && error.process_identity?.pid === foreign.pid,
    );
  } finally { fs.readFileSync = realReadFile; }
  assert.equal(processDead(foreign.pid), false);
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), false);
});

test("Linux process identity ignores a PATH-shadowed getconf", () => {
  if (process.platform !== "linux") return;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-shadow-getconf-")));
  const shadow = path.join(root, "getconf"), marker = path.join(root, "shadow-called");
  fs.writeFileSync(shadow, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf 999999999999\\n\n`, { mode: 0o755 });
  const modulePath = path.resolve(__dirname, "../../../skills/relay-dispatch/scripts/host.js");
  const child = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(modulePath)}).hostInvocation.beginProcessScope()`], {
    encoding: "utf8", env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` },
  });
  try { assert.equal(child.status, 0, child.stderr); assert.equal(fs.existsSync(marker), false); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("cleanup recovery treats an exact zombie as gone even when ps redacts its scope environment", { timeout: 30_000 }, async (t) => {
  const value = roots("zombie-cleanup"), attemptId = "zombie-cleanup", capability = lock(value, attemptId);
  const scope = host.hostInvocation.beginProcessScope(), pidsPath = path.join(value.root, "zombie.json");
  const parentScript = [
    "const {spawn}=require('child_process'),fs=require('fs');",
    "const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),500)'],{stdio:'ignore'});",
    `fs.writeFileSync(${JSON.stringify(pidsPath)},JSON.stringify({parent:process.pid,child:child.pid}));`,
    "process.kill(process.pid,'SIGSTOP');setInterval(()=>{},1000);",
  ].join("");
  const parent = require("child_process").spawn(process.execPath, ["-e", parentScript], { detached: true, stdio: "ignore", env: { ...process.env, ...scope.env } });
  parent.unref(); t.after(() => { for (const pid of [parent.pid]) if (!processDead(pid)) try { process.kill(pid, "SIGKILL"); } catch {} try { host.releaseRunLock(capability); } catch {} });
  await waitForFile(pidsPath); const pids = JSON.parse(fs.readFileSync(pidsPath, "utf8")), identity = liveIdentity(pids.child);
  const zombie = await (async () => { const end = Date.now() + 5_000; while (Date.now() < end) {
    const state = spawnSync("/bin/ps", ["-p", String(pids.child), "-o", "state="], { encoding: "utf8" }).stdout.trim();
    if (/^Z/.test(state)) return state; await new Promise((resolve) => setTimeout(resolve, 20));
  } return ""; })();
  assert.match(zombie, /^Z/, "the stopped parent must leave an exact zombie identity");
  writeCleanupObligation(value.runDir, attemptId, { processes: [identity], staged_input_root: null, scope_seal: scope.seal });
  await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "settle exact zombie" });
  assert.equal(host.inspectOwnership({ runDir: value.runDir }).status, "absent");
  assert.equal(fs.existsSync(path.join(value.runDir, `attempt-${attemptId}.result.json`)), true);
  assert.equal(processDead(parent.pid), false, "recovery must not signal a process outside the exact obligation");
});

test("a staged-input-root pathname swap is quarantined, preserved as evidence, and never deleted", { timeout: 30_000 }, async (t) => {
  const value = roots("root-swap"), attemptId = "root-swap", capability = lock(value, attemptId);
  t.after(() => { try { host.releaseRunLock(capability); } catch {} });
  const stagedRoot = stagedInputRoot(t);
  fs.writeFileSync(path.join(stagedRoot, "input.md"), "bound-input", { mode: 0o600 });
  const bound = fs.lstatSync(stagedRoot), stashed = `${stagedRoot}.stashed`;
  t.after(() => fs.rmSync(stashed, { recursive: true, force: true }));
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [], staged_input_root: { path: stagedRoot, dev: bound.dev, ino: bound.ino }, scope_seal: null,
  });
  const realRename = fs.renameSync;
  fs.renameSync = function swapBeforeQuarantine(from, to) {
    if (String(from) === stagedRoot) {
      fs.renameSync = realRename;
      realRename(from, stashed);
      fs.mkdirSync(from, { mode: 0o700 });
      fs.writeFileSync(path.join(from, "planted"), "attacker", { mode: 0o600 });
    }
    return realRename(from, to);
  };
  let failure;
  try {
    await assert.rejects(host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "settle a swapped staged input root" }),
      (error) => { failure = error; return error.code === "HOST_CLEANUP_INCOMPLETE" && /was replaced before quarantined removal/.test(error.message); });
  } finally { fs.renameSync = realRename; }
  assert.equal(fs.existsSync(failure.quarantinePath), true, "the swapped tree is preserved as evidence");
  assert.equal(fs.readFileSync(path.join(failure.quarantinePath, "planted"), "utf8"), "attacker");
  assert.equal(path.dirname(failure.quarantinePath), path.dirname(stagedRoot));
  assert.equal(fs.readFileSync(path.join(stashed, "input.md"), "utf8"), "bound-input");
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), false);
});

// Covers the window where a prior removal quarantined the bound root and then failed to roll it back:
// the obligation still names the original pathname, which is now absent. Absence must not be read as
// cleanup success while a sibling quarantine still holds the signed identity and its staged bytes.
test("an unrolled-back staged-input quarantine is reclaimed instead of settling on an absent pathname", async (t) => {
  const value = roots("quarantine-orphan"), attemptId = "quarantine-orphan", capability = lock(value, attemptId);
  t.after(() => { try { host.releaseRunLock(capability); } catch {} });
  const stagedRoot = stagedInputRoot(t);
  fs.writeFileSync(path.join(stagedRoot, "input.md"), "bound-input", { mode: 0o600 });
  const bound = fs.lstatSync(stagedRoot);
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [], staged_input_root: { path: stagedRoot, dev: bound.dev, ino: bound.ino }, scope_seal: null,
  });
  // Replay a failed removal whose rollback also failed: bound root renamed aside, original pathname gone.
  const orphan = path.join(path.dirname(stagedRoot), `.${path.basename(stagedRoot)}.quarantine.${process.pid}.deadbeefdeadbeef`);
  fs.renameSync(stagedRoot, orphan);
  assert.equal(fs.existsSync(stagedRoot), false);
  assert.equal(fs.lstatSync(orphan).ino, bound.ino, "the quarantine must still carry the signed identity");

  await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "reclaim an orphaned quarantine" });

  assert.equal(fs.existsSync(orphan), false, "the staged-input quarantine must be removed, not orphaned");
  assert.equal(fs.readdirSync(path.dirname(stagedRoot)).some((name) => name.includes(`${path.basename(stagedRoot)}.quarantine.`)), false);
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), true);
  assert.equal(host.inspectOwnership({ runDir: value.runDir }).status, "absent");
});

// Reclaim must not delete by pathname. Between the identity check and the removal, a racing process can
// move the real quarantine away and leave a decoy at that name; the removal must land on neither.
test("a reclaimed staged-input quarantine swapped before removal is preserved, not deleted", { timeout: 30_000 }, async (t) => {
  const value = roots("quarantine-reclaim-swap"), attemptId = "quarantine-reclaim-swap", capability = lock(value, attemptId);
  t.after(() => { try { host.releaseRunLock(capability); } catch {} });
  const stagedRoot = stagedInputRoot(t);
  fs.writeFileSync(path.join(stagedRoot, "input.md"), "bound-input", { mode: 0o600 });
  const bound = fs.lstatSync(stagedRoot);
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [], staged_input_root: { path: stagedRoot, dev: bound.dev, ino: bound.ino }, scope_seal: null,
  });
  const orphan = path.join(path.dirname(stagedRoot), `.${path.basename(stagedRoot)}.quarantine.${process.pid}.abadcafeabadcafe`);
  fs.renameSync(stagedRoot, orphan);
  const stashed = path.join(path.dirname(stagedRoot), "stashed-real-quarantine");
  t.after(() => fs.rmSync(stashed, { recursive: true, force: true }));

  const realRename = fs.renameSync;
  fs.renameSync = function swapReclaimedQuarantine(from, to) {
    if (String(from) === orphan) {
      fs.renameSync = realRename;
      realRename(from, stashed);
      fs.mkdirSync(from, { mode: 0o700 });
      fs.writeFileSync(path.join(from, "planted"), "attacker", { mode: 0o600 });
    }
    return realRename(from, to);
  };
  let failure;
  try {
    await assert.rejects(host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "reclaim a swapped quarantine" }),
      (error) => { failure = error; return error.code === "HOST_CLEANUP_INCOMPLETE" && /was replaced before quarantined removal/.test(error.message); });
  } finally { fs.renameSync = realRename; }
  assert.equal(fs.readFileSync(path.join(stashed, "input.md"), "utf8"), "bound-input", "the real staged tree must not be deleted");
  assert.equal(fs.existsSync(failure.quarantinePath), true, "the decoy is preserved as evidence");
  assert.equal(fs.readFileSync(path.join(failure.quarantinePath, "planted"), "utf8"), "attacker");
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), false, "settled must not be published");
});

// Removal unlinks a pathname, so a rename racing the delete can leave the bound tree alive under another
// quarantine name while the delete still returns success. Settling must depend on a post-condition scan,
// not on the delete's return value.
test("a staged-input tree surviving removal under a quarantine name blocks settling", async (t) => {
  const value = roots("quarantine-survives"), attemptId = "quarantine-survives", capability = lock(value, attemptId);
  t.after(() => { try { host.releaseRunLock(capability); } catch {} });
  const stagedRoot = stagedInputRoot(t);
  fs.writeFileSync(path.join(stagedRoot, "input.md"), "bound-input", { mode: 0o600 });
  const bound = fs.lstatSync(stagedRoot);
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [], staged_input_root: { path: stagedRoot, dev: bound.dev, ino: bound.ino }, scope_seal: null,
  });
  // Race the delete: move the verified tree to another quarantine name so the rmSync unlinks nothing.
  const survivor = path.join(path.dirname(stagedRoot), `.${path.basename(stagedRoot)}.quarantine.${process.pid}.5ur5170r5ur5170r`);
  t.after(() => fs.rmSync(survivor, { recursive: true, force: true }));
  const realRm = fs.rmSync;
  fs.rmSync = function renameInsteadOfRemoving(target, options) {
    if (String(target).includes(".quarantine.")) { fs.rmSync = realRm; fs.renameSync(target, survivor); return undefined; }
    return realRm(target, options);
  };
  try {
    await assert.rejects(host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "settle after a racing rename" }),
      (error) => error.code === "HOST_CLEANUP_INCOMPLETE" && /survived removal under a quarantine name/.test(error.message));
  } finally { fs.rmSync = realRm; }
  assert.equal(fs.readFileSync(path.join(survivor, "input.md"), "utf8"), "bound-input", "the surviving tree is retained as evidence");
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), false, "settled must not be published");
});

// A quarantine whose identity does not match the signed binding is someone else's tree. It must be left
// untouched and must not be mistaken for the bound staged-input root.
test("a staged-input quarantine that does not match the signed identity is not reclaimed", async (t) => {
  const value = roots("quarantine-foreign"), attemptId = "quarantine-foreign", capability = lock(value, attemptId);
  t.after(() => { try { host.releaseRunLock(capability); } catch {} });
  const stagedRoot = stagedInputRoot(t);
  const bound = fs.lstatSync(stagedRoot);
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [], staged_input_root: { path: stagedRoot, dev: bound.dev, ino: bound.ino }, scope_seal: null,
  });
  const displaced = path.join(path.dirname(stagedRoot), ".displaced-staged-input-root");
  fs.renameSync(stagedRoot, displaced);
  t.after(() => fs.rmSync(displaced, { recursive: true, force: true }));
  const foreign = path.join(path.dirname(stagedRoot), `.${path.basename(stagedRoot)}.quarantine.${process.pid}.00000000000000ff`);
  fs.mkdirSync(foreign, { mode: 0o700 });
  t.after(() => fs.rmSync(foreign, { recursive: true, force: true }));
  fs.writeFileSync(path.join(foreign, "unrelated"), "not-ours", { mode: 0o600 });
  assert.notEqual(fs.lstatSync(foreign).ino, bound.ino);

  await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "settle a genuinely absent root" });

  assert.equal(fs.readFileSync(path.join(foreign, "unrelated"), "utf8"), "not-ours", "an unrelated tree must survive");
  assert.equal(host.inspectOwnership({ runDir: value.runDir }).status, "absent");
});

test("a staged-input quarantine removal failure rolls the bound root back for convergent recovery", async (t) => {
  const value = roots("quarantine-rm-failure"), attemptId = "quarantine-rm-failure", capability = lock(value, attemptId);
  t.after(() => { try { host.releaseRunLock(capability); } catch {} });
  const stagedRoot = stagedInputRoot(t);
  fs.writeFileSync(path.join(stagedRoot, "input.md"), "bound-input", { mode: 0o600 });
  const bound = fs.lstatSync(stagedRoot);
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [], staged_input_root: { path: stagedRoot, dev: bound.dev, ino: bound.ino }, scope_seal: null,
  });
  await assert.rejects(host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "inject quarantine removal failure",
    fault(stage) { if (stage === "staged_input_after_quarantine") throw new Error("injected rm failure"); } }),
  (error) => error.code === "HOST_CLEANUP_INCOMPLETE" && /rolled back/.test(error.message));
  assert.equal(fs.readFileSync(path.join(stagedRoot, "input.md"), "utf8"), "bound-input");
  assert.equal(fs.readdirSync(path.dirname(stagedRoot)).some((name) => name.includes(`${path.basename(stagedRoot)}.quarantine.`)), false);
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), false);
  assert.notEqual(host.inspectOwnership({ runDir: value.runDir }).status, "absent");
  await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "retry rolled-back cleanup" });
  assert.equal(host.inspectOwnership({ runDir: value.runDir }).status, "absent");
  assert.equal(fs.existsSync(stagedRoot), false);
  assert.equal(fs.readdirSync(path.dirname(stagedRoot)).some((name) => name.includes(`${path.basename(stagedRoot)}.quarantine.`)), false);
});

test("cleanup artifacts reject legacy roots, unknown keys, and unknown kinds", async (t) => {
  for (const [label, obligation, kind] of [
    ["legacy-root", { processes: [], scope_seal: null, staged_input_root: null, credential_root: null }, "executor"],
    ["unknown-key", { processes: [], scope_seal: null, staged_input_root: null, extra: true }, "executor"],
    ["unknown-kind", { processes: [], scope_seal: null, staged_input_root: null }, "legacy"],
  ]) {
    const value = roots(`cleanup-schema-${label}`), attemptId = `cleanup-schema-${label}`, capability = lock(value, attemptId);
    t.after(() => { try { host.releaseRunLock(capability); } catch {} });
    writeCleanupObligation(value.runDir, attemptId, obligation, kind);
    await assert.rejects(host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: `reject ${label}` }),
      (error) => error.code === "HOST_ARTIFACT_INVALID" && /cleanup obligation is invalid/.test(error.message));
  }
});

test("config claim starts the executor exactly once and terminal bytes are authenticated", async () => {
  const value = roots("once"), attemptId = "exactly-once", capability = lock(value, attemptId);
  const marker = path.join(value.worktree, "count.txt");
  const script = `const fs=require('fs');const p=${JSON.stringify(marker)};fs.appendFileSync(p,'1\\n')`;
  const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", script],
    trustedWorktreeRoot: value.worktree, cwd: value.worktree, lockContext: capability });
  const result = await host.waitForTerminalResult(receipt);
  assert.equal(result.status, "completed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(value.runDir, `host-attempt-${attemptId}.config.json`))).process_contract, "inherited_scope_no_daemon");
  assert.equal(fs.readFileSync(marker, "utf8"), "1\n");
  assert.throws(() => host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", script],
    trustedWorktreeRoot: value.worktree, cwd: value.worktree, lockContext: capability }),
  (error) => error.code === "HOST_ATTEMPT_ALREADY_LAUNCHED");

  const forged = { ...result, status: "failed" };
  fs.writeFileSync(receipt.result_path, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
  await assert.rejects(host.waitForTerminalResult(receipt, { timeoutMs: 100 }), (error) => error.code === "HOST_RESULT_MISMATCH");
  host.releaseRunLock(capability);
});

test("detached supervisor survives launcher exit and leaves terminal proof for recovery", { timeout: 30_000 }, async () => {
  const value = roots("survival");
  const workerScript = `require("fs").writeFileSync(${JSON.stringify(path.join(value.worktree, "survived.txt"))}, "yes")`;
  const launcher = [
    "const fs=require('fs');const host=require('./skills/relay-dispatch/scripts/host');",
    "const runDir=fs.realpathSync(process.argv[1]),worktree=fs.realpathSync(process.argv[2]);",
    "const lock=host.acquireRunLock({runDir,attemptId:'survive',operation:'dispatch',worktreeDir:worktree});",
    "const marker=require('path').join(worktree,'survived.txt');",
    `const receipt=host.launchLocalSupervisor({runDir,attemptId:'survive',command:process.execPath,args:['-e',${JSON.stringify(workerScript)}],trustedWorktreeRoot:worktree,cwd:worktree,lockContext:lock});`,
    "process.stdout.write(JSON.stringify(receipt));",
  ].join("");
  const launched = spawnSync(process.execPath, ["-e", launcher, value.runDir, value.worktree], {
    cwd: path.resolve(__dirname, "../../.."), encoding: "utf8", timeout: 20_000,
  });
  assert.equal(launched.status, 0, launched.stderr);
  const receipt = JSON.parse(launched.stdout);
  await waitForFile(receipt.result_path);
  assert.equal(fs.readFileSync(path.join(value.worktree, "survived.txt"), "utf8"), "yes");
  const inspection = host.inspectOwnership({ runDir: value.runDir });
  assert.equal(inspection.status, "stale");
  await host.breakStaleRunLock({ inspection, reason: "launcher exited", resultPath: receipt.result_path });
  assert.equal(host.inspectOwnership({ runDir: value.runDir }).status, "absent");
});

test("cancel terminates the executor process group and descendants within a bound", { timeout: 30_000 }, async () => {
  const value = roots("cancel"), attemptId = "cancel-tree", capability = lock(value, attemptId);
  const pids = path.join(value.worktree, "pids.json");
  const worker = [
    "const {spawn}=require('child_process'),fs=require('fs');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);",
    `fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify({worker:process.pid,child:child.pid}));`,
    "setInterval(()=>{},1000);",
  ].join("");
  const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", worker],
    trustedWorktreeRoot: value.worktree, cwd: value.worktree, timeoutMs: 20_000, cancelGraceMs: 200, lockContext: capability });
  await waitForFile(pids);
  const identities = JSON.parse(fs.readFileSync(pids, "utf8"));
  host.cancelHost(receipt, { reason: "test" });
  const result = await host.waitForTerminalResult(receipt, { timeoutMs: 10_000 });
  assert.equal(result.status, "cancelled");
  const end = Date.now() + 5_000;
  while (Date.now() < end && (!processDead(identities.worker) || !processDead(identities.child))) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(processDead(identities.worker), true);
  assert.equal(processDead(identities.child), true);
  host.releaseRunLock(capability);
});

test("executor inherits ambient host auth/config while blocking Relay and runtime injection", async () => {
  const value = roots("env-canary"), attemptId = "env-canary", capability = lock(value, attemptId);
  const marker = path.join(value.worktree, "environment.txt"), barrier = path.join(value.runDir, "env.release");
  const previous = process.env.RELAY_PARENT_SECRET_CANARY;
  process.env.RELAY_PARENT_SECRET_CANARY = "must-not-cross";
  try {
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)},[process.env.RELAY_PARENT_SECRET_CANARY||'missing',process.env.EXPLICIT_SAFE||'missing'].join(':'))`;
    const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", script],
      trustedWorktreeRoot: value.worktree, cwd: value.worktree, executorEnv: { EXPLICIT_SAFE: "allowed" }, testGateBarrierPath: barrier, lockContext: capability });
    const running = JSON.parse(fs.readFileSync(path.join(value.runDir, `host-attempt-${attemptId}.running.json`)));
    assert.doesNotMatch(spawnSync("/bin/ps", ["eww", "-p", `${running.supervisor.pid},${running.executor.pid}`], { encoding: "utf8" }).stdout, /must-not-cross/);
    fs.writeFileSync(barrier, "release", { mode: 0o600 });
    const result = await host.waitForTerminalResult(receipt);
    assert.equal(result.status, "completed");
    assert.equal(fs.readFileSync(marker, "utf8"), "missing:allowed");
    const config = JSON.parse(fs.readFileSync(path.join(value.runDir, `host-attempt-${attemptId}.config.json`), "utf8"));
    assert.equal(Object.hasOwn(config, "ambient_env"), false);
    assert.equal(Object.hasOwn(config, "executor_env"), false);
    assert.doesNotMatch(JSON.stringify(config), /must-not-cross/);
    assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith(".host-secret-")), false);
  } finally {
    if (previous === undefined) delete process.env.RELAY_PARENT_SECRET_CANARY; else process.env.RELAY_PARENT_SECRET_CANARY = previous;
    host.releaseRunLock(capability);
  }
});

test("host ambient sanitizer preserves CLI session values and rejects startup injection", () => {
  const safe = host.hostInvocation.ambientEnvironment({ HOME: "/tmp/home", XDG_CONFIG_HOME: "/tmp/config", SSL_CERT_FILE: "/tmp/ca.pem",
    RELAY_PROCESS_SCOPE: "forged", RELAY_ARBITRARY_INJECTION: "forged", NODE_OPTIONS: "--require=evil", LD_PRELOAD: "evil", BASH_ENV: "/tmp/evil" }, "test ambient");
  assert.deepEqual(safe, { HOME: "/tmp/home", XDG_CONFIG_HOME: "/tmp/config", SSL_CERT_FILE: "/tmp/ca.pem" });
  assert.throws(() => host.hostInvocation.ambientEnvironment({}, "test ambient", { NODE_PATH: "/tmp/evil" }), /invalid environment entry/);
});

test("ambient host payload has no named-file window before supervisor spawn", () => {
  const value = roots("secret-fd"), attemptId = "secret-fd", capability = lock(value, attemptId), marker = "ambient-secret-must-not-persist";
  const previous = process.env.HOST_SECRET_PRESPAWN;
  process.env.HOST_SECRET_PRESPAWN = marker;
  try {
    assert.throws(() => host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", "0"],
      trustedWorktreeRoot: value.worktree, cwd: value.worktree, lockContext: capability,
      testBeforeSupervisorSpawn({ runDir, configPath }) {
        assert.equal(runDir, value.runDir);
        assert.equal(fs.readdirSync(runDir).some((name) => name.startsWith(".host-secret-")), false);
        assert.doesNotMatch(fs.readFileSync(configPath, "utf8"), new RegExp(marker));
        throw new Error("injected pre-spawn failure");
      },
    }), /injected pre-spawn failure/);
    assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith(".host-secret-")), false);
  } finally {
    if (previous === undefined) delete process.env.HOST_SECRET_PRESPAWN; else process.env.HOST_SECRET_PRESPAWN = previous;
    host.releaseRunLock(capability);
  }
});

test("a closed executor gate still terminates same-PGID descendants before terminal proof", { timeout: 20_000 }, async (t) => {
  const value = roots("closed-gate-tree"), attemptId = "closed-gate-tree", capability = lock(value, attemptId);
  const pidPath = path.join(value.worktree, "descendant.pid");
  let descendantPid = null;
  t.after(() => {
    if (descendantPid && !processDead(descendantPid)) try { process.kill(descendantPid, "SIGKILL"); } catch {}
    try { host.releaseRunLock(capability); } catch {}
  });
  const childScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const worker = [
    "const {spawn}=require('child_process'),fs=require('fs');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});`,
    `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));child.unref();`,
  ].join("");
  const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", worker],
    trustedWorktreeRoot: value.worktree, cwd: value.worktree, cancelGraceMs: 100, lockContext: capability });
  await waitForFile(pidPath); descendantPid = Number(fs.readFileSync(pidPath, "utf8"));
  const result = await host.waitForTerminalResult(receipt, { timeoutMs: 8_000 });
  assert.equal(result.status, "completed");
  const end = Date.now() + 3_000;
  while (Date.now() < end && !processDead(descendantPid)) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(processDead(descendantPid), true);
});

test("a daemon-style setsid child is reaped and makes terminal completion fail closed", { timeout: 30_000 }, async (t) => {
  const value = roots("escaped-daemon"), attemptId = "escaped-daemon", capability = lock(value, attemptId);
  const pidPath = path.join(value.worktree, "daemon.pid"); let daemonPids = [];
  t.after(() => {
    for (const pid of daemonPids) if (!processDead(pid)) try { process.kill(-pid, "SIGKILL"); } catch {}
    try { host.releaseRunLock(capability); } catch {}
  });
  const daemonSource = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const worker = [
    "const {spawn}=require('child_process'),fs=require('fs');",
    `const scoped=spawn(process.execPath,['-e',${JSON.stringify(daemonSource)},${JSON.stringify(value.worktree)}],{detached:true,stdio:'ignore'});`,
    `const lineageOnly=spawn(process.execPath,['-e',${JSON.stringify(daemonSource)}],{detached:true,stdio:'ignore'});`,
    `fs.writeFileSync(${JSON.stringify(pidPath)},JSON.stringify([scoped.pid,lineageOnly.pid]));scoped.unref();lineageOnly.unref();`,
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);",
  ].join("");
  const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", worker],
    trustedWorktreeRoot: value.worktree, cwd: value.worktree, cancelGraceMs: 100, lockContext: capability });
  await waitForFile(pidPath); daemonPids = JSON.parse(fs.readFileSync(pidPath, "utf8"));
  const result = await host.waitForTerminalResult(receipt, { timeoutMs: 15_000 });
  assert.equal(result.status, "failed");
  assert.match(result.error, /escaped process audit failed: matched=[1-9]\d* reaped=[1-9]\d* remaining=0/);
  const end = Date.now() + 3_000;
  while (Date.now() < end && daemonPids.some((pid) => !processDead(pid))) await new Promise((resolve) => setTimeout(resolve, 25));
  for (const pid of daemonPids) {
    assert.equal(processDead(pid), true);
    try { process.kill(-pid, 0); assert.fail("daemon PGID survived terminal result"); }
    catch (error) { assert.equal(error.code, "ESRCH"); }
  }
});

test("an immediate setsid reparent is found by exact inherited process scope", { timeout: 30_000 }, async (t) => {
  const value = roots("immediate-setsid"), attemptId = "immediate-setsid", capability = lock(value, attemptId);
  const pidPath = path.join(value.worktree, "immediate-daemon.pid"); let daemonPid = null;
  t.after(() => {
    if (daemonPid && !processDead(daemonPid)) try { process.kill(-daemonPid, "SIGKILL"); } catch {}
    try { host.releaseRunLock(capability); } catch {}
  });
  const daemon = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const worker = [
    "const {spawn}=require('child_process'),fs=require('fs');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(daemon)}],{detached:true,stdio:'ignore'});`,
    `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));child.unref();`,
  ].join("");
  const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", worker],
    trustedWorktreeRoot: value.worktree, cwd: value.worktree, cancelGraceMs: 100, lockContext: capability });
  await waitForFile(pidPath); daemonPid = Number(fs.readFileSync(pidPath, "utf8"));
  const result = await host.waitForTerminalResult(receipt, { timeoutMs: 15_000 });
  assert.equal(result.status, "failed");
  assert.match(result.error, /escaped process audit failed: matched=[1-9]\d* reaped=[1-9]\d* remaining=0/);
  assert.equal(processDead(daemonPid), true);
});

test("an unrelated post-baseline process with only the worktree argv is never signalled", { timeout: 30_000 }, async (t) => {
  const value = roots("unrelated-argv"), attemptId = "unrelated-argv", capability = lock(value, attemptId);
  const ready = path.join(value.worktree, "worker.ready"), release = path.join(value.worktree, "worker.release"); let unrelated;
  t.after(() => {
    if (unrelated && !processDead(unrelated.pid)) try { process.kill(-unrelated.pid, "SIGKILL"); } catch {}
    try { host.releaseRunLock(capability); } catch {}
  });
  const worker = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'1');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)`;
  const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", worker],
    trustedWorktreeRoot: value.worktree, cwd: value.worktree, lockContext: capability });
  await waitForFile(ready);
  unrelated = require("child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", value.worktree], { detached: true, stdio: "ignore" });
  unrelated.unref(); fs.writeFileSync(release, "1");
  const result = await host.waitForTerminalResult(receipt, { timeoutMs: 15_000 });
  assert.equal(result.status, "completed");
  assert.equal(processDead(unrelated.pid), false);
});

test("staged input bytes remain bound when the caller path mutates after launch", async () => {
  const value = roots("input-binding"), attemptId = "input-binding", capability = lock(value, attemptId);
  const input = path.join(value.runDir, "prompt.md"), proof = path.join(value.worktree, "observed.txt");
  fs.writeFileSync(input, "original", { mode: 0o600 });
  const script = "const fs=require('fs');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);fs.writeFileSync(process.argv[1],fs.readFileSync(process.argv[2]))";
  try {
    const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath,
      args: ["-e", script, proof, input], inputFiles: [input], trustedWorktreeRoot: value.worktree, cwd: value.worktree, lockContext: capability });
    fs.writeFileSync(input, "mutated", { mode: 0o600 });
    const result = await host.waitForTerminalResult(receipt);
    assert.equal(result.status, "completed");
    assert.equal(fs.readFileSync(proof, "utf8"), "original");
  } finally { host.releaseRunLock(capability); }
});

test("bound prompt reaches native executor only through exact stdin bytes and metadata-only host config", async () => {
  const value = roots("prompt-stdin"), attemptId = "prompt-stdin", capability = lock(value, attemptId);
  const sentinel = "PROMPT_SENTINEL_7ee4bafc\n", input = path.join(value.runDir, "prompt.md");
  const proof = path.join(value.worktree, "stdin.txt"), barrier = path.join(value.runDir, "stdin.release");
  fs.writeFileSync(input, sentinel, { mode: 0o600 });
  const script = "require('fs').writeFileSync(process.argv[1],require('fs').readFileSync(0))";
  try {
    const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath,
      args: ["-e", script, proof], inputFiles: [input], stdinPath: input,
      stdinSha256: crypto.createHash("sha256").update(sentinel).digest("hex"), trustedWorktreeRoot: value.worktree,
      cwd: value.worktree, testGateBarrierPath: barrier, lockContext: capability });
    const configPath = path.join(value.runDir, `host-attempt-${attemptId}.config.json`);
    const config = JSON.parse(fs.readFileSync(configPath));
    assert.equal(config.stdin_binding.size, Buffer.byteLength(sentinel));
    assert.equal(config.stdin_binding.sha256, crypto.createHash("sha256").update(sentinel).digest("hex"));
    assert.doesNotMatch(JSON.stringify({ command: config.command, args: config.args }), /PROMPT_SENTINEL/);
    for (const name of fs.readdirSync(value.runDir).filter((name) => /\.(json|log)$/.test(name))) {
      assert.doesNotMatch(fs.readFileSync(path.join(value.runDir, name), "utf8"), /PROMPT_SENTINEL/, name);
    }
    fs.writeFileSync(barrier, "release", { mode: 0o600 });
    assert.equal((await host.waitForTerminalResult(receipt)).status, "completed");
    assert.equal(fs.readFileSync(proof, "utf8"), sentinel);
  } finally { host.releaseRunLock(capability); }
});

test("host preserves ambient HOME/XDG and auth environment without serializing them", async () => {
  const value = roots("ambient-env"), attemptId = "ambient-env", capability = lock(value, attemptId);
  const proof = path.join(value.worktree, "ambient-proof.json"), ambient = "ambient-auth-canary";
  const previous = { auth: process.env.AMBIENT_AUTH_CANARY, relay: process.env.RELAY_PARENT_SECRET_CANARY };
  process.env.AMBIENT_AUTH_CANARY = ambient; process.env.RELAY_PARENT_SECRET_CANARY = "must-not-cross";
  try {
    const script = "require('fs').writeFileSync(process.argv[1],JSON.stringify({home:process.env.HOME,config:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME,auth:process.env.AMBIENT_AUTH_CANARY,relay:process.env.RELAY_PARENT_SECRET_CANARY||null}))";
    const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", script, proof],
      trustedWorktreeRoot: value.worktree, cwd: value.worktree, lockContext: capability });
    const configText = fs.readFileSync(path.join(value.runDir, `host-attempt-${attemptId}.config.json`), "utf8");
    assert.doesNotMatch(configText, new RegExp(`${ambient}|must-not-cross`));
    assert.equal((await host.waitForTerminalResult(receipt)).status, "completed");
    const observed = JSON.parse(fs.readFileSync(proof, "utf8"));
    assert.equal(observed.home, process.env.HOME); assert.equal(observed.config, process.env.XDG_CONFIG_HOME);
    assert.equal(observed.data, process.env.XDG_DATA_HOME); assert.equal(observed.auth, ambient); assert.equal(observed.relay, null);
  } finally {
    if (previous.auth === undefined) delete process.env.AMBIENT_AUTH_CANARY; else process.env.AMBIENT_AUTH_CANARY = previous.auth;
    if (previous.relay === undefined) delete process.env.RELAY_PARENT_SECRET_CANARY; else process.env.RELAY_PARENT_SECRET_CANARY = previous.relay;
    host.releaseRunLock(capability);
  }
});

test("pre-exec environment injection keys fail before supervisor launch", () => {
  const value = roots("env-injection"), capability = lock(value, "env-injection"), marker = path.join(value.worktree, "injected");
  const options = { runDir: value.runDir, attemptId: "env-injection", command: process.execPath, args: ["-e", "0"], trustedWorktreeRoot: value.worktree, cwd: value.worktree, lockContext: capability };
  try {
    for (const key of ["RELAY_EXPLICIT_SAFE", "NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "BASH_ENV", "ENV", "ZDOTDIR", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "LUA_INIT", "PHPRC", "PHP_INI_SCAN_DIR", "PYTHONSTARTUP", "PYTHONPATH", "PERL5OPT", "RUBYOPT", "GEM_HOME"])
      assert.throws(() => host.launchLocalSupervisor({ ...options, executorEnv: { [key]: marker } }), (error) => error.code === "INVALID_INVOCATION", key);
    assert.doesNotThrow(() => host.launchLocalSupervisor({ ...options, executorEnv: { SSL_CERT_FILE: marker } }));
    assert.equal(fs.existsSync(marker), false);
  } finally { host.releaseRunLock(capability); }
});

test("host rejects adapters outside the inherited-scope no-daemon contract", () => {
  const value = roots("daemon-contract"), attemptId = "daemon-contract", capability = lock(value, attemptId);
  try {
    assert.throws(() => host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", "0"],
      trustedWorktreeRoot: value.worktree, cwd: value.worktree, processContainment: "daemon_capable", lockContext: capability }),
    (error) => error.code === "INVALID_INVOCATION" && /inherited_scope_no_daemon/.test(error.message));
    assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.config.json`)), false);
  } finally { host.releaseRunLock(capability); }
});

test("staged inode and bytes are revalidated immediately before gate release", async () => {
  for (const replacement of [false, true]) {
    const value = roots(`stage-swap-${replacement}`), attemptId = `stage-swap-${replacement}`, capability = lock(value, attemptId);
    const input = path.join(value.runDir, "prompt.md"), barrier = path.join(value.runDir, "gate.release"); fs.writeFileSync(input, "original", { mode: 0o600 });
    try {
      const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", "process.stdin.resume()"], inputFiles: [input],
        stdinPath: input, stdinSha256: crypto.createHash("sha256").update("original").digest("hex"),
        trustedWorktreeRoot: value.worktree, cwd: value.worktree, testGateBarrierPath: barrier, lockContext: capability });
      const config = JSON.parse(fs.readFileSync(path.join(value.runDir, `host-attempt-${attemptId}.config.json`)));
      assert.equal(config.test_gate_barrier, barrier); assert.equal(fs.existsSync(receipt.result_path), false);
      if (replacement) { const swap = path.join(value.runDir, "swap"); fs.writeFileSync(swap, "tampered", { mode: 0o600 }); fs.renameSync(swap, config.input_files[0].path); }
      else fs.writeFileSync(config.input_files[0].path, "tampered", { mode: 0o600 });
      fs.writeFileSync(barrier, "release", { mode: 0o600 });
      const result = await host.waitForTerminalResult(receipt); assert.equal(result.status, "spawn_error"); assert.match(result.error, /changed after launch/);
    } finally { host.releaseRunLock(capability); }
  }
});

test("an atomically replaced executor/runtime path is rejected before spawn", async () => {
  const value = roots("runtime-swap"), attemptId = "runtime-swap", capability = lock(value, attemptId);
  const tool = path.join(value.root, "tool.sh"), barrier = path.join(value.runDir, "gate.release");
  fs.writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  try {
    const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: tool, args: [], trustedWorktreeRoot: value.worktree,
      cwd: value.worktree, testGateBarrierPath: barrier, lockContext: capability });
    const config = JSON.parse(fs.readFileSync(path.join(value.runDir, `host-attempt-${attemptId}.config.json`), "utf8"));
    assert.equal(config.command, tool); assert.ok(config.runtime_files.some((binding) => binding.path === tool));
    const replacement = path.join(value.root, "tool.replacement"); fs.writeFileSync(replacement, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    fs.renameSync(replacement, tool); fs.writeFileSync(barrier, "release", { mode: 0o600 });
    const result = await host.waitForTerminalResult(receipt);
    assert.equal(result.status, "spawn_error"); assert.match(result.error, /runtime executable closure changed after launch/);
  } finally { host.releaseRunLock(capability); }
});

test("a runtime closure mutation after pathname spawn cannot publish success", async () => {
  const value = roots("runtime-post-spawn-swap"), attemptId = "runtime-post-spawn-swap", capability = lock(value, attemptId);
  const tool = path.join(value.worktree, "tool.sh");
  // The sandbox grants the executor workspace writes, so this mutation occurs
  // after the shell has already resolved and begun executing the pathname.
  fs.writeFileSync(tool, `#!/bin/sh\nprintf '#!/bin/sh\\nexit 1\\n' > ${JSON.stringify(tool)}\nexit 0\n`, { mode: 0o700 });
  try {
    const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: tool, args: [], trustedWorktreeRoot: value.worktree,
      cwd: value.worktree, lockContext: capability });
    const result = await host.waitForTerminalResult(receipt);
    assert.equal(result.status, "failed");
    assert.match(result.error, /runtime executable closure changed during execution/);
  } finally { host.releaseRunLock(capability); }
});

test("cleanup deadline cannot publish a pending completed outcome", () => {
  const source = fs.readFileSync(require.resolve("../../../skills/relay-dispatch/scripts/host"), "utf8");
  assert.doesNotMatch(source, /Date\.now\(\) >= end\)[^\n]*finish\(pendingClose/);
  assert.match(source, /Date\.now\(\) >= end\)[^\n]*cleanupIncomplete/);
  assert.doesNotMatch(source, /process group cleanup bound elapsed[^\n]*status:\s*"failed"/);
});

// #1242: a fake OpenCode that prints a definitive provider-unavailable signal on stderr and then
// stays alive must be force-cancelled well before its configured timeout, with the executor process
// group reaped and no cleanup obligation left open.
test("a recognized provider-unavailable stderr signal cancels a live dispatch attempt before its timeout", { timeout: 30_000 }, async () => {
  const value = roots("opencode-quota-dispatch"), attemptId = "opencode-quota-dispatch", capability = lock(value, attemptId);
  const started = Date.now();
  const receipt = host.launchLocalSupervisor({
    runDir: value.runDir, attemptId, command: process.execPath,
    args: [FAKE_OPENCODE, "run", "--auto", "--print-logs", "--log-level", "ERROR", "--pure", "--dir", value.worktree],
    trustedWorktreeRoot: value.worktree, cwd: value.worktree,
    timeoutMs: 20_000, cancelGraceMs: 200,
    providerUnavailableSignals: ["insufficient_quota", "quota exceeded"],
    executorEnv: { FAKE_OPENCODE_STAY_ALIVE: "1", FAKE_OPENCODE_SIGNAL: "Anthropic API error 429: insufficient_quota" },
    lockContext: capability,
  });
  const config = JSON.parse(fs.readFileSync(path.join(value.runDir, `host-attempt-${attemptId}.config.json`), "utf8"));
  assert.deepEqual(config.provider_unavailable_signals, ["insufficient_quota", "quota exceeded"]);
  const result = await host.waitForTerminalResult(receipt, { timeoutMs: 10_000 });
  assert.equal(result.status, "cancelled");
  assert.equal(result.termination, "provider_unavailable");
  assert.ok(Date.now() - started < 10_000, `early termination must beat the 20s timeout (elapsed ${Date.now() - started}ms)`);
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-incomplete.json`)), false);
  const running = JSON.parse(fs.readFileSync(path.join(value.runDir, `host-attempt-${attemptId}.running.json`), "utf8"));
  const end = Date.now() + 5_000;
  while (Date.now() < end && (!processDead(running.supervisor.pid) || !processDead(running.executor.pid))) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(processDead(running.supervisor.pid), true, "the supervisor must exit after early termination");
  assert.equal(processDead(running.executor.pid), true, "the executor gate must be reaped");
  host.releaseRunLock(capability);
});

// Regression for the window bug: a provider prints its signal and then keeps talking. Matching a
// fixed-size retained tail instead of the newly read bytes silently drops every signal that is not
// flush against the end of the stream, which is the common real-world shape.
test("a recognized signal followed by trailing output still cancels the attempt", { timeout: 30_000 }, async () => {
  const value = roots("opencode-quota-trailing"), attemptId = "opencode-quota-trailing", capability = lock(value, attemptId);
  const trailing = "add credits and retry; see the provider dashboard for the current billing period".padEnd(120, ".");
  const started = Date.now();
  const receipt = host.launchLocalSupervisor({
    runDir: value.runDir, attemptId, command: process.execPath,
    args: [FAKE_OPENCODE, "run", "--auto", "--print-logs", "--log-level", "ERROR", "--pure"],
    trustedWorktreeRoot: value.worktree, cwd: value.worktree,
    timeoutMs: 20_000, cancelGraceMs: 200,
    providerUnavailableSignals: ["insufficient_quota"],
    executorEnv: { FAKE_OPENCODE_STAY_ALIVE: "1", FAKE_OPENCODE_SIGNAL: `error: insufficient_quota - ${trailing}` },
    lockContext: capability,
  });
  const result = await host.waitForTerminalResult(receipt, { timeoutMs: 10_000 });
  assert.equal(result.status, "cancelled");
  assert.equal(result.termination, "provider_unavailable");
  assert.ok(Date.now() - started < 10_000, `early termination must beat the 20s timeout (elapsed ${Date.now() - started}ms)`);
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-incomplete.json`)), false);
  host.releaseRunLock(capability);
});

// Unrecognized stderr is not a provider-unavailable signal: the attempt keeps its existing
// timeout behavior and fails closed as timed_out, never cancelled early.
test("unrecognized stderr does not shorten a live attempt's timeout", { timeout: 30_000 }, async () => {
  const value = roots("opencode-unrecognized"), attemptId = "opencode-unrecognized", capability = lock(value, attemptId);
  const started = Date.now();
  const receipt = host.launchLocalSupervisor({
    runDir: value.runDir, attemptId, command: process.execPath,
    args: [FAKE_OPENCODE, "run", "--pure", "--dir", value.worktree],
    trustedWorktreeRoot: value.worktree, cwd: value.worktree,
    timeoutMs: 2_000, cancelGraceMs: 200,
    providerUnavailableSignals: ["insufficient_quota"],
    executorEnv: { FAKE_OPENCODE_STAY_ALIVE: "1", FAKE_OPENCODE_SIGNAL: "provider is having a bad day" },
    lockContext: capability,
  });
  const result = await host.waitForTerminalResult(receipt, { timeoutMs: 15_000 });
  assert.equal(result.status, "timed_out");
  assert.equal(result.termination, undefined);
  assert.ok(Date.now() - started >= 1_500, `unrecognized stderr must not cancel early (elapsed ${Date.now() - started}ms)`);
  host.releaseRunLock(capability);
});

// An adapter that declares no provider-unavailable signals must reach the supervisor with exactly
// the config bytes it had before this feature existed: the key is absent, not present-and-empty, so
// the config SHA of every undeclared adapter is unchanged.
test("an adapter with no declared signals leaves the supervisor config free of the field", { timeout: 30_000 }, async () => {
  const value = roots("no-signal-config"), attemptId = "no-signal-config", capability = lock(value, attemptId);
  const receipt = host.launchLocalSupervisor({
    runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", "process.exit(0)"],
    trustedWorktreeRoot: value.worktree, cwd: value.worktree, timeoutMs: 20_000, cancelGraceMs: 200, lockContext: capability,
  });
  const config = JSON.parse(fs.readFileSync(path.join(value.runDir, `host-attempt-${attemptId}.config.json`), "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(config, "provider_unavailable_signals"), false);
  await host.waitForTerminalResult(receipt, { timeoutMs: 10_000 });
  host.releaseRunLock(capability);
});

// Early termination only ever force-cancels an executor that is still alive. A CLI that prints the
// signal and exits on its own keeps its natural outcome (failed, exit 2, no signal) unchanged, with
// no termination reason attached and no process-scope error, because the watcher requires a live
// scope member other than the gate before it cancels.
test("a self-exiting fake that emits a recognized signal keeps its natural outcome", { timeout: 30_000 }, async () => {
  const value = roots("opencode-self-exit"), attemptId = "opencode-self-exit", capability = lock(value, attemptId);
  const receipt = host.launchLocalSupervisor({
    runDir: value.runDir, attemptId, command: process.execPath,
    args: [FAKE_OPENCODE, "run", "--pure", "--dir", value.worktree],
    trustedWorktreeRoot: value.worktree, cwd: value.worktree,
    timeoutMs: 20_000, cancelGraceMs: 1_000,
    providerUnavailableSignals: ["insufficient_quota"],
    executorEnv: { FAKE_OPENCODE_SIGNAL: "insufficient_quota", FAKE_OPENCODE_EXIT_CODE: "2", FAKE_OPENCODE_EXIT_DELAY_MS: "0" },
    lockContext: capability,
  });
  const result = await host.waitForTerminalResult(receipt, { timeoutMs: 10_000 });
  // The natural outcome must win outright: the watcher only cancels while the executor itself is
  // still a live member of the scope, and this executor exited on its own.
  assert.equal(result.status, "failed");
  assert.equal(result.exit_code, 2);
  assert.equal(result.signal, null);
  assert.equal(result.termination, undefined);
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-incomplete.json`)), false);
  host.releaseRunLock(capability);
});
