"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const host = require("../../../skills/relay-dispatch/scripts/host");

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

function writeCleanupObligation(runDir, attemptId, obligation) {
  const owner = ownerSecret(runDir);
  const body = {
    v: 2, attempt_id: attemptId, lock_id: owner.lock_id, host_handle: owner.host_handle,
    identities: { supervisor: { pid: owner.process.pid, pgid: owner.process.pgid, started_at: owner.process.started_at }, executor: null },
    error: "injected cleanup obligation", terminal: { status: "failed", exit_code: 1, signal: null },
    obligation, observed_at: new Date().toISOString(),
  };
  const signature = crypto.createHmac("sha256", owner.secret).update(JSON.stringify(body)).digest("hex");
  fs.writeFileSync(path.join(runDir, `host-attempt-${attemptId}.cleanup-incomplete.json`),
    `${JSON.stringify({ ...body, auth_sha256: signature })}\n`, { mode: 0o600 });
}

test("a same-second PID reuse without the inherited scope token is never signalled", { timeout: 30_000 }, async (t) => {
  const scope = host.sandboxInvocation.beginProcessScope();
  const foreign = spawnIdle({ PATH: process.env.PATH }), member = spawnIdle({ PATH: process.env.PATH, ...scope.env });
  t.after(() => { for (const child of [foreign, member]) if (!processDead(child.pid)) try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(liveIdentity(foreign.pid).pgid, foreign.pid, "the foreign process leads its own group");

  const foreignAudit = host.sandboxInvocation.reapProcessGroup(foreign.pid, scope.seal);
  assert.deepEqual(foreignAudit, { survived_terminal: false, absent: false, unverified: true });
  assert.equal(processDead(foreign.pid), false, "an unrelated same-PID group must never be signalled");

  const scopedAudit = host.sandboxInvocation.reapProcessGroup(member.pid, scope.seal);
  assert.equal(scopedAudit.survived_terminal, true);
  assert.equal(scopedAudit.absent, true);
  assert.equal(scopedAudit.unverified, false);
  assert.equal(processDead(member.pid), true);
  assert.equal(processDead(foreign.pid), false);
});

test("group reap signals only individually scope-verified PIDs and preserves an unrelated PGID member", { timeout: 30_000 }, async (t) => {
  const scope = host.sandboxInvocation.beginProcessScope(), value = roots("mixed-pgid"), pidsPath = path.join(value.root, "pids.json");
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

  const audit = host.sandboxInvocation.reapProcessGroup(pids.leader, scope.seal);
  assert.equal(audit.survived_terminal, true);
  assert.equal(audit.absent, false);
  assert.equal(audit.unverified, true);
  assert.equal(processDead(pids.leader), true, "the verified scoped leader is reaped");
  assert.equal(processDead(pids.outsider), false, "the unscoped member is never reached by a group signal");
});

test("lost cleanup scope proof requires exact external action and then converges", { timeout: 30_000 }, async (t) => {
  const value = roots("scope-loss"), attemptId = "scope-loss", capability = lock(value, attemptId);
  const scope = host.sandboxInvocation.beginProcessScope(), marker = path.join(value.root, "inherited-scope.txt");
  const foreign = spawnScopeDroppingIdle({ PATH: process.env.PATH, ...scope.env }, marker);
  t.after(() => { if (!processDead(foreign.pid)) try { process.kill(-foreign.pid, "SIGKILL"); } catch {} try { host.releaseRunLock(capability); } catch {} });
  await waitForFile(marker);
  assert.equal(fs.readFileSync(marker, "utf8"), scope.env.RELAY_PROCESS_SCOPE, "the process must inherit the run scope before dropping it");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const credentialRoot = path.join(value.runDir, `executor-credentials-${attemptId}`);
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [liveIdentity(foreign.pid)], credential_root: { path: credentialRoot, dev: null, ino: null },
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

test("cleanup recovery treats an exact zombie as gone even when ps redacts its scope environment", { timeout: 30_000 }, async (t) => {
  const value = roots("zombie-cleanup"), attemptId = "zombie-cleanup", capability = lock(value, attemptId);
  const scope = host.sandboxInvocation.beginProcessScope(), pidsPath = path.join(value.root, "zombie.json");
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
  writeCleanupObligation(value.runDir, attemptId, { processes: [identity], credential_root: { path: path.join(value.runDir, `executor-credentials-${attemptId}`), dev: null, ino: null }, scope_seal: scope.seal });
  await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "settle exact zombie" });
  assert.equal(host.inspectOwnership({ runDir: value.runDir }).status, "absent");
  assert.equal(fs.existsSync(path.join(value.runDir, `attempt-${attemptId}.result.json`)), true);
  assert.equal(processDead(parent.pid), false, "recovery must not signal a process outside the exact obligation");
});

test("a credential-root pathname swap is quarantined, preserved as evidence, and never deleted", { timeout: 30_000 }, async (t) => {
  const value = roots("root-swap"), attemptId = "root-swap", capability = lock(value, attemptId);
  t.after(() => { try { host.releaseRunLock(capability); } catch {} });
  const credentialRoot = path.join(value.runDir, `executor-credentials-${attemptId}`);
  fs.mkdirSync(credentialRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(credentialRoot, "auth.json"), "bound-secret", { mode: 0o600 });
  const bound = fs.lstatSync(credentialRoot), stashed = `${credentialRoot}.stashed`;
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [], credential_root: { path: credentialRoot, dev: bound.dev, ino: bound.ino }, scope_seal: null,
  });
  const realRename = fs.renameSync;
  fs.renameSync = function swapBeforeQuarantine(from, to) {
    if (String(from) === credentialRoot) {
      fs.renameSync = realRename;
      realRename(from, stashed);
      fs.mkdirSync(from, { mode: 0o700 });
      fs.writeFileSync(path.join(from, "planted"), "attacker", { mode: 0o600 });
    }
    return realRename(from, to);
  };
  let failure;
  try {
    await assert.rejects(host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "settle a swapped credential root" }),
      (error) => { failure = error; return error.code === "HOST_CLEANUP_INCOMPLETE" && /was replaced before quarantined removal/.test(error.message); });
  } finally { fs.renameSync = realRename; }
  assert.equal(fs.existsSync(failure.quarantinePath), true, "the swapped tree is preserved as evidence");
  assert.equal(fs.readFileSync(path.join(failure.quarantinePath, "planted"), "utf8"), "attacker");
  assert.equal(path.dirname(failure.quarantinePath), value.runDir);
  assert.equal(fs.readFileSync(path.join(stashed, "auth.json"), "utf8"), "bound-secret");
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), false);
});

// Covers the window where a prior removal quarantined the bound root and then failed to roll it back:
// the obligation still names the original pathname, which is now absent. Absence must not be read as
// cleanup success while a sibling quarantine still holds the signed identity and its secret bytes.
test("an unrolled-back quarantine is reclaimed instead of settling on an absent pathname", async (t) => {
  const value = roots("quarantine-orphan"), attemptId = "quarantine-orphan", capability = lock(value, attemptId);
  t.after(() => { try { host.releaseRunLock(capability); } catch {} });
  const credentialRoot = path.join(value.runDir, `executor-credentials-${attemptId}`);
  fs.mkdirSync(credentialRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(credentialRoot, "auth.json"), "bound-secret", { mode: 0o600 });
  const bound = fs.lstatSync(credentialRoot);
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [], credential_root: { path: credentialRoot, dev: bound.dev, ino: bound.ino }, scope_seal: null,
  });
  // Replay a failed removal whose rollback also failed: bound root renamed aside, original pathname gone.
  const orphan = path.join(value.runDir, `.executor-credentials-${attemptId}.quarantine.${process.pid}.deadbeefdeadbeef`);
  fs.renameSync(credentialRoot, orphan);
  assert.equal(fs.existsSync(credentialRoot), false);
  assert.equal(fs.lstatSync(orphan).ino, bound.ino, "the quarantine must still carry the signed identity");

  await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "reclaim an orphaned quarantine" });

  assert.equal(fs.existsSync(orphan), false, "the secret-bearing quarantine must be removed, not orphaned");
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.includes(".quarantine.")), false);
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), true);
  assert.equal(host.inspectOwnership({ runDir: value.runDir }).status, "absent");
});

// Reclaim must not delete by pathname. Between the identity check and the removal, a racing process can
// move the real quarantine away and leave a decoy at that name; the removal must land on neither.
test("a reclaimed quarantine swapped before removal is preserved, not deleted", { timeout: 30_000 }, async (t) => {
  const value = roots("quarantine-reclaim-swap"), attemptId = "quarantine-reclaim-swap", capability = lock(value, attemptId);
  t.after(() => { try { host.releaseRunLock(capability); } catch {} });
  const credentialRoot = path.join(value.runDir, `executor-credentials-${attemptId}`);
  fs.mkdirSync(credentialRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(credentialRoot, "auth.json"), "bound-secret", { mode: 0o600 });
  const bound = fs.lstatSync(credentialRoot);
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [], credential_root: { path: credentialRoot, dev: bound.dev, ino: bound.ino }, scope_seal: null,
  });
  const orphan = path.join(value.runDir, `.executor-credentials-${attemptId}.quarantine.${process.pid}.abadcafeabadcafe`);
  fs.renameSync(credentialRoot, orphan);
  const stashed = path.join(value.runDir, "stashed-real-quarantine");

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
  assert.equal(fs.readFileSync(path.join(stashed, "auth.json"), "utf8"), "bound-secret", "the real secret tree must not be deleted");
  assert.equal(fs.existsSync(failure.quarantinePath), true, "the decoy is preserved as evidence");
  assert.equal(fs.readFileSync(path.join(failure.quarantinePath, "planted"), "utf8"), "attacker");
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), false, "settled must not be published");
});

// Removal unlinks a pathname, so a rename racing the delete can leave the bound tree alive under another
// quarantine name while the delete still returns success. Settling must depend on a post-condition scan,
// not on the delete's return value.
test("a bound tree surviving removal under a quarantine name blocks settling", async (t) => {
  const value = roots("quarantine-survives"), attemptId = "quarantine-survives", capability = lock(value, attemptId);
  t.after(() => { try { host.releaseRunLock(capability); } catch {} });
  const credentialRoot = path.join(value.runDir, `executor-credentials-${attemptId}`);
  fs.mkdirSync(credentialRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(credentialRoot, "auth.json"), "bound-secret", { mode: 0o600 });
  const bound = fs.lstatSync(credentialRoot);
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [], credential_root: { path: credentialRoot, dev: bound.dev, ino: bound.ino }, scope_seal: null,
  });
  // Race the delete: move the verified tree to another quarantine name so the rmSync unlinks nothing.
  const survivor = path.join(value.runDir, `.executor-credentials-${attemptId}.quarantine.${process.pid}.5ur5170r5ur5170r`);
  const realRm = fs.rmSync;
  fs.rmSync = function renameInsteadOfRemoving(target, options) {
    if (String(target).includes(".quarantine.")) { fs.rmSync = realRm; fs.renameSync(target, survivor); return undefined; }
    return realRm(target, options);
  };
  try {
    await assert.rejects(host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "settle after a racing rename" }),
      (error) => error.code === "HOST_CLEANUP_INCOMPLETE" && /survived removal under a quarantine name/.test(error.message));
  } finally { fs.rmSync = realRm; }
  assert.equal(fs.readFileSync(path.join(survivor, "auth.json"), "utf8"), "bound-secret", "the surviving tree is retained as evidence");
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), false, "settled must not be published");
});

// A quarantine whose identity does not match the signed binding is someone else's tree. It must be left
// untouched and must not be mistaken for the bound root.
test("a quarantine that does not match the signed identity is not reclaimed", async (t) => {
  const value = roots("quarantine-foreign"), attemptId = "quarantine-foreign", capability = lock(value, attemptId);
  t.after(() => { try { host.releaseRunLock(capability); } catch {} });
  const credentialRoot = path.join(value.runDir, `executor-credentials-${attemptId}`);
  fs.mkdirSync(credentialRoot, { mode: 0o700 });
  const bound = fs.lstatSync(credentialRoot);
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [], credential_root: { path: credentialRoot, dev: bound.dev, ino: bound.ino }, scope_seal: null,
  });
  fs.rmSync(credentialRoot, { recursive: true, force: true });
  const foreign = path.join(value.runDir, `.executor-credentials-${attemptId}.quarantine.${process.pid}.00000000000000ff`);
  fs.mkdirSync(foreign, { mode: 0o700 });
  fs.writeFileSync(path.join(foreign, "unrelated"), "not-ours", { mode: 0o600 });
  assert.notEqual(fs.lstatSync(foreign).ino, bound.ino);

  await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "settle a genuinely absent root" });

  assert.equal(fs.readFileSync(path.join(foreign, "unrelated"), "utf8"), "not-ours", "an unrelated tree must survive");
  assert.equal(host.inspectOwnership({ runDir: value.runDir }).status, "absent");
});

test("a quarantine removal failure rolls the bound root back for convergent recovery", async (t) => {
  const value = roots("quarantine-rm-failure"), attemptId = "quarantine-rm-failure", capability = lock(value, attemptId);
  t.after(() => { try { host.releaseRunLock(capability); } catch {} });
  const credentialRoot = path.join(value.runDir, `executor-credentials-${attemptId}`);
  fs.mkdirSync(credentialRoot, { mode: 0o700 }); fs.writeFileSync(path.join(credentialRoot, "auth.json"), "bound-secret", { mode: 0o600 });
  const bound = fs.lstatSync(credentialRoot);
  writeCleanupObligation(value.runDir, attemptId, {
    processes: [], credential_root: { path: credentialRoot, dev: bound.dev, ino: bound.ino }, scope_seal: null,
  });
  await assert.rejects(host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "inject quarantine removal failure",
    fault(stage) { if (stage === "credential_after_quarantine") throw new Error("injected rm failure"); } }),
  (error) => error.code === "HOST_CLEANUP_INCOMPLETE" && /rolled back/.test(error.message));
  assert.equal(fs.readFileSync(path.join(credentialRoot, "auth.json"), "utf8"), "bound-secret");
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.includes(".quarantine.")), false);
  assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), false);
  assert.notEqual(host.inspectOwnership({ runDir: value.runDir }).status, "absent");
  await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "retry rolled-back cleanup" });
  assert.equal(host.inspectOwnership({ runDir: value.runDir }).status, "absent");
  assert.equal(fs.existsSync(credentialRoot), false);
  assert.equal(fs.readdirSync(value.runDir).some((name) => name.includes("auth.json") || name.includes(".quarantine.")), false);
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

test("sandbox grants only declared input/result/temp paths and never HOME, ownership, siblings, or opaque argv paths", () => {
  const value = roots("sandbox"), ownership = path.join(value.runDir, "ownership"); fs.mkdirSync(ownership, { mode: 0o700 });
  const allowed = path.join(value.runDir, "allowed.txt"), sibling = path.join(value.runDir, "sibling.txt"), secret = path.join(ownership, "secret");
  const hostileModelPath = path.join(value.runDir, "model-secret.txt"), proof = path.join(value.runDir, "proof.json"), tmp = path.join(value.runDir, "tmp");
  fs.writeFileSync(allowed, "allowed"); fs.writeFileSync(sibling, "sibling"); fs.writeFileSync(secret, "secret", { mode: 0o600 });
  fs.writeFileSync(hostileModelPath, "model-secret"); fs.mkdirSync(tmp);
  const script = [
    "const fs=require('fs');const [allowed,sibling,secret,model,proof]=process.argv.slice(1);",
    "const read=p=>{try{return fs.readFileSync(p,'utf8')}catch(e){return 'denied:'+e.code}};",
    "const write=p=>{try{fs.writeFileSync(p,'x');return 'written'}catch(e){return 'denied:'+e.code}};",
    "fs.writeFileSync(proof,JSON.stringify({allowed:read(allowed),sibling:read(sibling),secret:read(secret),model:read(model),sibling_write:write(sibling),home:read(process.env.HOME+'/nonexistent-secret')}));",
  ].join("");
  const invocation = host.sandboxInvocation({ role: "executor", command: process.execPath,
    args: ["-e", script, allowed, sibling, secret, hostileModelPath, proof, "--model", hostileModelPath],
    readFiles: [allowed], writeFiles: [proof], writeRoots: [tmp], ownershipDir: ownership });
  const result = spawnSync(invocation.command, invocation.args, { cwd: value.worktree, env: invocation.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(fs.readFileSync(proof, "utf8"));
  assert.equal(observed.allowed, "allowed");
  for (const key of ["sibling", "secret", "model", "sibling_write", "home"]) assert.match(observed[key], /^denied:/, key);
});

test("a reviewer executable under HOME/bin does not widen reads to HOME", () => {
  const value = roots("reviewer-home"), fakeHome = path.join(value.root, "home"), bin = path.join(fakeHome, "bin");
  fs.mkdirSync(fakeHome); fs.mkdirSync(bin);
  const secret = path.join(fakeHome, "secret.txt"), reviewer = path.join(bin, "reviewer"), proof = path.join(value.runDir, "reviewer-proof.txt");
  fs.writeFileSync(secret, "home-secret");
  fs.writeFileSync(reviewer, "#!/bin/sh\nif value=$(/bin/cat \"$HOME/secret.txt\" 2>/dev/null); then /usr/bin/printf '%s' \"$value\" > \"$1\"; else /usr/bin/printf denied > \"$1\"; fi\n");
  fs.chmodSync(reviewer, 0o755);
  const invocation = host.sandboxInvocation({ role: "reviewer", command: reviewer, args: [proof], writeFiles: [proof],
    env: { ...process.env, HOME: fakeHome }, networkAccess: "disabled" });
  const result = spawnSync(invocation.command, invocation.args, { cwd: value.worktree, env: invocation.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(proof, "utf8"), "denied");
});

test("executor inherits only the minimal host environment plus explicit adapter entries", async () => {
  const value = roots("env-canary"), attemptId = "env-canary", capability = lock(value, attemptId);
  const marker = path.join(value.worktree, "environment.txt"), barrier = path.join(value.runDir, "env.release");
  const previous = process.env.RELAY_PARENT_SECRET_CANARY;
  process.env.RELAY_PARENT_SECRET_CANARY = "must-not-cross";
  try {
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)},[process.env.RELAY_PARENT_SECRET_CANARY||'missing',process.env.RELAY_EXPLICIT_SAFE||'missing',process.env.RELAY_EPHEMERAL_TOKEN||'missing'].join(':'))`;
    const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", script],
      trustedWorktreeRoot: value.worktree, cwd: value.worktree, executorEnv: { RELAY_EXPLICIT_SAFE: "allowed" }, ephemeralEnv: { RELAY_EPHEMERAL_TOKEN: "one-shot" }, testGateBarrierPath: barrier, lockContext: capability });
    const running = JSON.parse(fs.readFileSync(path.join(value.runDir, `host-attempt-${attemptId}.running.json`)));
    assert.doesNotMatch(spawnSync("/bin/ps", ["eww", "-p", `${running.supervisor.pid},${running.executor.pid}`], { encoding: "utf8" }).stdout, /one-shot/);
    fs.writeFileSync(barrier, "release", { mode: 0o600 });
    const result = await host.waitForTerminalResult(receipt);
    assert.equal(result.status, "completed");
    assert.equal(fs.readFileSync(marker, "utf8"), "missing:allowed:one-shot");
    assert.doesNotMatch(fs.readFileSync(path.join(value.runDir, `host-attempt-${attemptId}.config.json`), "utf8"), /must-not-cross|one-shot/);
    assert.equal(fs.readdirSync(value.runDir).some((name) => name.startsWith(".host-secret-")), false);
  } finally {
    if (previous === undefined) delete process.env.RELAY_PARENT_SECRET_CANARY; else process.env.RELAY_PARENT_SECRET_CANARY = previous;
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

test("an executable directly under HOME is literal-readable without widening HOME", () => {
  const value = roots("home-root-executable"), fakeHome = path.join(value.root, "home"); fs.mkdirSync(fakeHome);
  const secret = path.join(fakeHome, "secret.txt"), executable = path.join(fakeHome, "executor"), proof = path.join(value.runDir, "proof.txt");
  fs.writeFileSync(secret, "home-secret");
  fs.writeFileSync(executable, "#!/bin/sh\nif /bin/cat \"$HOME/secret.txt\" > \"$1\" 2>/dev/null; then exit 0; else /usr/bin/printf denied > \"$1\"; fi\n");
  fs.chmodSync(executable, 0o755);
  const invocation = host.sandboxInvocation({ role: "executor", command: executable, args: [proof], writeFiles: [proof],
    env: { ...process.env, HOME: fakeHome } });
  const result = spawnSync(invocation.command, invocation.args, { cwd: value.worktree, env: invocation.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(proof, "utf8"), "denied");
});

test("a narrow package root inside HOME is readable without exposing package siblings or HOME", () => {
  const value = roots("declared-home-runtime"), fakeHome = path.join(value.root, "home"), bundle = path.join(fakeHome, ".tool"), bin = path.join(bundle, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const dependency = path.join(bin, "dependency.txt"), secret = path.join(bundle, "secret.txt"), executable = path.join(bin, "executor"), proof = path.join(value.runDir, "proof.txt");
  fs.writeFileSync(dependency, "runtime-dependency"); fs.writeFileSync(secret, "adjacent-secret");
  fs.writeFileSync(executable, "#!/bin/sh\nread_file(){ /bin/cat \"$1\" 2>/dev/null || /usr/bin/printf denied; }\n/usr/bin/printf '%s|%s' \"$(read_file \"$1\")\" \"$(read_file \"$2\")\" > \"$3\"\n");
  fs.chmodSync(executable, 0o755);
  let invocation = host.sandboxInvocation({ role: "executor", command: executable, args: [dependency, secret, proof], writeFiles: [proof], env: { ...process.env, HOME: fakeHome } });
  assert.equal(spawnSync(invocation.command, invocation.args, { cwd: value.worktree, env: invocation.env }).status, 0);
  assert.equal(fs.readFileSync(proof, "utf8"), "denied|denied");
  invocation = host.sandboxInvocation({ role: "executor", command: executable, args: [dependency, secret, proof], writeFiles: [proof],
    runtimeDependencies: { executableParent: 0, interpreterParent: null }, env: { ...process.env, HOME: fakeHome } });
  assert.equal(spawnSync(invocation.command, invocation.args, { cwd: value.worktree, env: invocation.env }).status, 0);
  assert.equal(fs.readFileSync(proof, "utf8"), "runtime-dependency|denied");
  assert.throws(() => host.sandboxInvocation({ role: "executor", command: executable, args: [proof], writeFiles: [proof],
    runtimeDependencies: { executableParent: 1, interpreterParent: null }, env: { ...process.env, HOME: bundle } }),
  (error) => error.code === "INVALID_INVOCATION");
});

test("a missing system CA bundle fails typed instead of raw ENOENT", () => {
  const original = fs.realpathSync;
  fs.realpathSync = function systemCaAbsent(target, ...args) {
    if (target === "/etc/ssl/cert.pem") { const error = new Error(`ENOENT: no such file or directory, realpath '${target}'`); error.code = "ENOENT"; throw error; }
    return original.call(this, target, ...args);
  };
  try {
    assert.throws(() => host.sandboxInvocation({ role: "executor", command: process.execPath, networkAccess: "enabled" }),
      (error) => error.code === "UNTRUSTED_SYSTEM_CA" && /absent/.test(error.message));
  } finally { fs.realpathSync = original; }
});

test("network policy is explicit and grants only transport and per-user trust Mach services, never Keychain", () => {
  const value = roots("network-profile"), proof = path.join(value.runDir, "network-proof.json");
  const disabled = host.sandboxInvocation({ role: "executor", command: process.execPath, readRoots: [value.worktree], networkAccess: "disabled" }).args[1];
  const script = "const fs=require('fs');let sibling='readable';try{fs.readFileSync('/private/etc/hosts')}catch(e){sibling='denied:'+e.code}fs.writeFileSync(process.argv[1],JSON.stringify({ca:process.env.SSL_CERT_FILE,certificate:fs.readFileSync(process.env.SSL_CERT_FILE,'utf8').includes('BEGIN CERTIFICATE'),sibling}))";
  const invocation = host.sandboxInvocation({ role: "executor", command: process.execPath, args: ["-e", script, proof], readRoots: [value.worktree], writeFiles: [proof], networkAccess: "enabled" });
  const enabled = invocation.args[1], ca = fs.realpathSync("/etc/ssl/cert.pem");
  assert.doesNotMatch(disabled, /allow network|SystemConfiguration\.configd|opendirectoryd\.libinfo|trustd/);
  assert.match(enabled, /allow network/); assert.match(enabled, /SystemConfiguration\.configd/); assert.match(enabled, /opendirectoryd\.libinfo/);
  assert.match(enabled, /\(global-name "com\.apple\.trustd\.agent"\)/);
  assert.match(enabled, new RegExp(`literal "${ca.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.doesNotMatch(enabled, /\(subpath "\/(?:private\/)?etc/);
  assert.doesNotMatch(enabled, /com\.apple\.trustd"|securityd|SecurityServer|keychain|mach-lookup.*regex|mach-lookup.*global-prefix/);
  assert.equal(Object.hasOwn(host.sandboxInvocation({ role: "executor", command: process.execPath, networkAccess: "disabled" }).env, "SSL_CERT_FILE"), false);
  assert.equal(spawnSync(invocation.command, invocation.args, { cwd: value.worktree, env: invocation.env }).status, 0);
  const observed = JSON.parse(fs.readFileSync(proof, "utf8"));
  assert.equal(observed.ca, ca); assert.equal(observed.certificate, true); assert.match(observed.sibling, /^denied:/);
  assert.throws(() => host.sandboxInvocation({ role: "executor", command: process.execPath, networkAccess: "enabled", env: { ...process.env, SSL_CERT_FILE: proof } }),
    (error) => error.code === "INVALID_INVOCATION" && /host-reserved/.test(error.message));
});

test("offline trust evaluation needs exactly the per-user trust agent lookup", () => {
  const value = roots("offline-trust"), certificate = path.join(value.worktree, "root.pem");
  const match = fs.readFileSync("/etc/ssl/cert.pem", "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  assert.ok(match, "the trusted root-owned CA literal contains a certificate");
  fs.writeFileSync(certificate, `${match[0]}\n`, { mode: 0o600 });
  const options = { role: "executor", command: "/usr/bin/security",
    args: ["verify-cert", "-c", certificate, "-r", certificate, "-N", "-L", "-l", "-q"], readFiles: [certificate] };
  const disabled = host.sandboxInvocation({ ...options, networkAccess: "disabled" });
  const enabled = host.sandboxInvocation({ ...options, networkAccess: "enabled" });
  const exactAgentOnly = { ...disabled, args: [...disabled.args] };
  exactAgentOnly.args[1] = exactAgentOnly.args[1].replace("(allow file-read-metadata)",
    '(allow file-read-metadata)(allow mach-lookup (global-name "com.apple.trustd.agent"))');
  const run = (invocation) => spawnSync(invocation.command, invocation.args, { cwd: value.worktree, env: invocation.env, encoding: "utf8" });
  assert.notEqual(run(disabled).status, 0, "offline trust fails without the agent lookup");
  assert.equal(run(enabled).status, 0, "network-enabled policy permits offline trust evaluation");
  assert.equal(run(exactAgentOnly).status, 0, "the exact agent lookup alone permits the same offline trust evaluation");
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

test("credential request stages exact private HOME/XDG files and keeps sources and values out of durable and argv surfaces", async () => {
  const value = roots("credentials"), attemptId = "credentials", capability = lock(value, attemptId);
  const source = path.join(value.root, "auth.json"), proof = path.join(value.worktree, "credential-proof.json");
  const secret = "credential-secret-7f1d", envSecret = "environment-secret-3a9c";
  fs.writeFileSync(source, secret, { mode: 0o600 }); fs.chmodSync(source, 0o600);
  const metadata = { files: [{ id: "auth", targetRoot: "home", targetRel: ".tool/auth.json", access: "read" }], envHints: [] };
  const script = [
    "const fs=require('fs'),path=require('path');",
    "const cache=path.join(process.env.HOME,'.tool/cache/state.json');fs.mkdirSync(path.dirname(cache),{recursive:true});fs.writeFileSync(cache,'state');",
    "let authWrite='written';try{fs.writeFileSync(path.join(process.env.HOME,'.tool/auth.json'),'changed')}catch(e){authWrite='denied:'+e.code}",
    "fs.writeFileSync(process.argv[1],JSON.stringify({home:process.env.HOME,xdg:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME,",
    "file:fs.readFileSync(path.join(process.env.HOME,'.tool/auth.json'),'utf8'),cache:fs.readFileSync(cache,'utf8'),authWrite,env:process.env.TOOL_API_KEY,modes:[fs.statSync(process.env.HOME).mode&511,fs.statSync(path.join(process.env.HOME,'.tool/auth.json')).mode&511]}));",
  ].join("");
  try {
    const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", script, proof],
      trustedWorktreeRoot: value.worktree, cwd: value.worktree, credentialRequest: { metadata, envNames: ["TOOL_API_KEY"], fileSpecs: [`auth=${source}`], env: { TOOL_API_KEY: envSecret } }, lockContext: capability });
    const configPath = path.join(value.runDir, `host-attempt-${attemptId}.config.json`), configText = fs.readFileSync(configPath, "utf8"), config = JSON.parse(configText);
    assert.deepEqual(config.credentials, [{ id: "auth", targetRoot: "home", targetRel: ".tool/auth.json", access: "read", size: Buffer.byteLength(secret), sha: crypto.createHash("sha256").update(secret).digest("hex") }]);
    assert.doesNotMatch(configText, new RegExp(`${secret}|${envSecret}|${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(JSON.stringify(config.args), new RegExp(`${secret}|${envSecret}|${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal((await host.waitForTerminalResult(receipt)).status, "completed");
    const observed = JSON.parse(fs.readFileSync(proof, "utf8"));
    assert.equal(observed.file, secret); assert.equal(observed.cache, "state"); assert.match(observed.authWrite, /^denied:/); assert.equal(observed.env, envSecret); assert.deepEqual(observed.modes, [0o700, 0o600]);
    assert.match(observed.home, /executor-credentials-credentials\/home$/); assert.match(observed.xdg, /executor-credentials-credentials\/xdg-config$/); assert.match(observed.data, /executor-credentials-credentials\/xdg-data$/);
    assert.equal(fs.existsSync(path.dirname(observed.home)), false);
    for (const name of fs.readdirSync(value.runDir).filter((name) => /\.(?:json|log)$/.test(name))) {
      const text = fs.readFileSync(path.join(value.runDir, name), "utf8"); assert.doesNotMatch(text, new RegExp(`${secret}|${envSecret}`), name);
    }
  } finally { host.releaseRunLock(capability); }
});

test("private environment paths use distinct short attempt roots, execute inside the sandbox, and clean exactly", async () => {
  const value = roots("private-env-paths"), observed = [];
  const declarations = [{ key: "TOOL_CONFIG_DIR", root: "home", relative: ".tool" }, { key: "TOOL_DATA_DIR", root: "scratch", relative: "tool-data" }];
  for (const attemptId of ["private-path-a", "private-path-b"]) {
    const capability = lock(value, attemptId), proof = path.join(value.worktree, `${attemptId}.json`);
    try {
      const script = "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({home:process.env.HOME,config:process.env.TOOL_CONFIG_DIR,data:process.env.TOOL_DATA_DIR}));";
      const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", script, proof],
        trustedWorktreeRoot: value.worktree, cwd: value.worktree, privateEnvPaths: declarations, lockContext: capability });
      const config = JSON.parse(fs.readFileSync(path.join(value.runDir, `host-attempt-${attemptId}.config.json`), "utf8"));
      assert.deepEqual(config.private_env_paths, declarations); assert.ok(Buffer.byteLength(config.credential_root) <= 64); assert.match(config.credential_root, /\/relay-[0-9a-f]{32}$/);
      assert.equal((await host.waitForTerminalResult(receipt)).status, "completed"); const output = JSON.parse(fs.readFileSync(proof, "utf8")); observed.push(output);
      assert.equal(output.config, path.join(output.home, ".tool")); assert.match(output.data, /\/scratch\/tool-data$/); assert.ok(Buffer.byteLength(output.data) <= 83);
      assert.equal(fs.existsSync(config.credential_root), false);
    } finally { host.releaseRunLock(capability); }
  }
  assert.notEqual(path.dirname(observed[0].home), path.dirname(observed[1].home));
  const longAttempt = "private-reject-length", longCapability = lock(value, longAttempt);
  try {
    const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId: longAttempt, command: process.execPath, args: ["-e", "0"], trustedWorktreeRoot: value.worktree,
      cwd: value.worktree, privateEnvPaths: [{ key: "TOOL_DATA_DIR", root: "scratch", relative: "x".repeat(80) }], lockContext: longCapability });
    const terminal = await host.waitForTerminalResult(receipt); assert.equal(terminal.status, "spawn_error"); assert.match(terminal.error, /short-path limit/);
    assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(path.join(value.runDir, `host-attempt-${longAttempt}.config.json`), "utf8")).credential_root), false);
  } finally { host.releaseRunLock(longCapability); }
  for (const privateEnvPaths of [[{ key: "TOOL_DATA_DIR", root: "scratch", relative: "/tmp/escape" }], declarations]) {
    const attemptId = `private-reject-${privateEnvPaths.length}`, capability = lock(value, attemptId);
    try { assert.throws(() => host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", "0"], trustedWorktreeRoot: value.worktree,
      cwd: value.worktree, privateEnvPaths, ...(privateEnvPaths.length > 1 ? { executorEnv: { TOOL_DATA_DIR: "/tmp/caller" } } : {}), lockContext: capability }),
    (error) => error.code === "INVALID_INVOCATION"); } finally { host.releaseRunLock(capability); }
  }
});

test("credential sources and catalog selections fail closed before supervisor artifacts", () => {
  const metadata = { files: [{ id: "auth", targetRoot: "home", targetRel: ".tool/auth.json", access: "read" }], envHints: ["TOOL_API_KEY"] };
  for (const kind of ["world", "symlink", "fifo"]) {
    const value = roots(`credential-${kind}`), attemptId = `credential-${kind}`, capability = lock(value, attemptId), source = path.join(value.root, "source");
    try {
      if (kind === "world") fs.writeFileSync(source, "secret", { mode: 0o644 });
      else if (kind === "symlink") { const target = path.join(value.root, "target"); fs.writeFileSync(target, "secret", { mode: 0o600 }); fs.symlinkSync(target, source); }
      else spawnSync("mkfifo", [source]);
      assert.throws(() => host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", "0"], trustedWorktreeRoot: value.worktree, cwd: value.worktree,
        credentialRequest: { metadata, fileSpecs: [`auth=${source}`] }, lockContext: capability }), (error) => ["UNTRUSTED_CREDENTIAL", "INVALID_CREDENTIAL"].includes(error.code));
      assert.equal(fs.readdirSync(value.runDir).some((name) => name.includes(`host-attempt-${attemptId}`)), false);
    } finally { host.releaseRunLock(capability); }
  }
});

test("credential source inode/content swap between prepare and bind fails before config publication", () => {
  const value = roots("credential-swap"), attemptId = "credential-swap", capability = lock(value, attemptId);
  const source = path.join(value.root, "source"), replacement = path.join(value.root, "replacement");
  fs.writeFileSync(source, "first-secret", { mode: 0o600 }); fs.writeFileSync(replacement, "second-secret", { mode: 0o600 });
  const metadata = { files: [{ id: "auth", targetRoot: "home", targetRel: ".tool/auth.json", access: "read" }], envHints: [] };
  try {
    assert.throws(() => host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", "0"],
      trustedWorktreeRoot: value.worktree, cwd: value.worktree, credentialRequest: { metadata, fileSpecs: [`auth=${source}`] },
      testCredentialPrepared: () => fs.renameSync(replacement, source), lockContext: capability }), (error) => error.code === "CREDENTIAL_CHANGED");
    assert.equal(fs.readdirSync(value.runDir).some((name) => name.includes(`host-attempt-${attemptId}`)), false);
  } finally { host.releaseRunLock(capability); }
});

test("partial credential prepare failure zeroes already-read source buffers", () => {
  const value = roots("credential-partial"), attemptId = "credential-partial", capability = lock(value, attemptId);
  const first = path.join(value.root, "first"), second = path.join(value.root, "second"), secret = "first-partial-secret";
  fs.writeFileSync(first, secret, { mode: 0o600 }); fs.writeFileSync(second, "unsafe", { mode: 0o644 });
  const metadata = { files: [
    { id: "first", targetRoot: "home", targetRel: ".tool/first", access: "read" },
    { id: "second", targetRoot: "home", targetRel: ".tool/second", access: "read" },
  ], envHints: [] };
  const originalRead = fs.readFileSync; let captured = null;
  fs.readFileSync = function readAndCapture(target, ...args) {
    const bytes = originalRead.call(this, target, ...args);
    if (Number.isInteger(target) && Buffer.isBuffer(bytes) && bytes.toString("utf8") === secret) captured = bytes;
    return bytes;
  };
  try {
    assert.throws(() => host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", "0"],
      trustedWorktreeRoot: value.worktree, cwd: value.worktree, credentialRequest: { metadata, fileSpecs: [`first=${first}`, `second=${second}`] }, lockContext: capability }),
    (error) => error.code === "UNTRUSTED_CREDENTIAL");
    assert.ok(captured); assert.equal(captured.every((byte) => byte === 0), true);
    assert.equal(fs.readdirSync(value.runDir).some((name) => name.includes(`host-attempt-${attemptId}`)), false);
  } finally { fs.readFileSync = originalRead; host.releaseRunLock(capability); }
});

test("cleanup-incomplete recovery settles exact obligations and converges after a crash", async () => {
  const value = roots("credential-cleanup"), attemptId = "credential-cleanup", capability = lock(value, attemptId);
  const marker = path.join(value.runDir, "cleanup.fail"); fs.writeFileSync(marker, "fail", { mode: 0o600 });
  try {
    const receipt = host.launchLocalSupervisor({ runDir: value.runDir, attemptId, command: process.execPath, args: ["-e", "0"],
      trustedWorktreeRoot: value.worktree, cwd: value.worktree, testCleanupFailurePath: marker, lockContext: capability });
    await assert.rejects(host.waitForTerminalResult(receipt, { timeoutMs: 10_000 }), (error) => {
      assert.equal(error.code, "HOST_CLEANUP_INCOMPLETE"); assert.match(error.cleanup_sha256, /^[0-9a-f]{64}$/); return true;
    });
    const cleanupPath = path.join(value.runDir, `host-attempt-${attemptId}.cleanup-incomplete.json`), cleanup = JSON.parse(fs.readFileSync(cleanupPath, "utf8"));
    assert.match(cleanup.auth_sha256, /^[0-9a-f]{64}$/); assert.match(cleanup.error, /cleanup failed/);
    assert.equal(cleanup.obligation.credential_root.path, path.join(value.runDir, `executor-credentials-${attemptId}`));
    assert.ok(Number.isInteger(cleanup.obligation.credential_root.dev));
    assert.ok(cleanup.obligation.processes.every((identity) => Number.isInteger(identity.pid) && identity.started_at));
    assert.equal(fs.existsSync(receipt.result_path), false);
    fs.rmSync(marker, { force: true });
    // The recorded supervisor/executor are short-lived; a same-second PID reuse (macOS lstart is
    // second-resolution) can transiently make the exact reap look like a foreign unscoped process,
    // which the host correctly refuses to signal (HOST_CLEANUP_EXTERNAL_ACTION_REQUIRED, see the dedicated
    // "a same-second PID reuse without the inherited scope token" test above). Production recovery
    // re-observes and retries, so this test does too: the reused pid exits within a second and the
    // retry converges. This is not a timeout widening; the transient bind failure is a first-class
    // recovery-observable state and convergence is still asserted below.
    const settleRetrying = async (fault) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          return await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: value.runDir }), reason: "recover cleanup", ...(fault ? { fault } : {}) });
        } catch (error) {
          if (error.code === "HOST_CLEANUP_EXTERNAL_ACTION_REQUIRED") {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          throw error;
        }
      }
      assert.fail("cleanup settle did not converge across 10 re-observations");
    };
    await assert.rejects(settleRetrying((stage) => { if (stage === "after_settled") throw new Error("crash after settled proof"); }), /crash after settled proof/);
    assert.equal(fs.existsSync(path.join(value.runDir, `host-attempt-${attemptId}.cleanup-settled.json`)), true);
    assert.equal(fs.existsSync(receipt.result_path), false);
    await settleRetrying();
    assert.equal(host.inspectOwnership({ runDir: value.runDir }).status, "absent");
    assert.equal((await host.waitForTerminalResult(receipt)).status, "failed");
    assert.equal(fs.existsSync(cleanup.obligation.credential_root.path), false);
  } finally {
    fs.rmSync(marker, { force: true }); fs.rmSync(path.join(value.runDir, `executor-credentials-${attemptId}`), { recursive: true, force: true }); try { host.releaseRunLock(capability); } catch {}
  }
});

test("pre-exec environment injection keys fail before supervisor launch", () => {
  const value = roots("env-injection"), capability = lock(value, "env-injection"), marker = path.join(value.worktree, "injected");
  const options = { runDir: value.runDir, attemptId: "env-injection", command: process.execPath, args: ["-e", "0"], trustedWorktreeRoot: value.worktree, cwd: value.worktree, lockContext: capability };
  try {
    for (const key of ["SSL_CERT_FILE", "NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "BASH_ENV", "ENV", "ZDOTDIR", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "LUA_INIT", "PHPRC", "PHP_INI_SCAN_DIR", "PYTHONSTARTUP", "PYTHONPATH", "PERL5OPT", "RUBYOPT", "GEM_HOME"])
      assert.throws(() => host.launchLocalSupervisor({ ...options, executorEnv: { [key]: marker } }), (error) => error.code === "INVALID_INVOCATION", key);
    assert.throws(() => host.launchLocalSupervisor({ ...options, ephemeralEnv: { NODE_OPTIONS: marker } }), (error) => error.code === "INVALID_INVOCATION");
    fs.writeFileSync(path.join(value.worktree, ".zshenv"), `print -r -- $RELAY_EPHEMERAL_TOKEN > ${marker}\n`);
    assert.throws(() => host.launchLocalSupervisor({ ...options, command: "/bin/zsh", args: ["-c", ":"], executorEnv: { ZDOTDIR: value.worktree }, ephemeralEnv: { RELAY_EPHEMERAL_TOKEN: "pre-sandbox-secret" } }), (error) => error.code === "INVALID_INVOCATION");
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
