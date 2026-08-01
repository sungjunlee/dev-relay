"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const DISPATCH = path.join(ROOT, "skills", "relay-dispatch", "scripts", "dispatch.js");

function admissionHelpers() {
  const source = fs.readFileSync(DISPATCH, "utf8");
  const marker = "// ---------------------------------------------------------------------------\n// Args";
  const prelude = source.slice(0, source.indexOf(marker));
  const sandbox = { require: createRequire(DISPATCH), module: { exports: {} }, process, console, Buffer, setTimeout, clearTimeout };
  vm.runInNewContext(`${prelude}\nmodule.exports = { admissionMutationSnapshot, prepareAdmissionMutationCandidate, commitAdmissionMutationCandidate, acquireAdmissionMutation, releaseAdmissionMutation, acquireIssueAdmission, acquireIssueLock, releaseIssueLock, publishIssueLockExclusive, fleetIssueLockPath };`, sandbox, { filename: DISPATCH });
  return sandbox.module.exports;
}

function setupRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "relay-admission-"));
  execFileSync("git", ["init", "-q", repo]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]);
  return { repo, relayHome: fs.mkdtempSync(path.join(os.tmpdir(), "relay-admission-home-")) };
}

function runContender(runner, env) {
  const handle = { result: null, promise: null };
  handle.promise = new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, DISPATCH], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => { handle.result = { code, stderr }; resolve(handle.result); });
  });
  return handle;
}

test("fleet admission never unlinks a replacement inode and mutation guards fail closed", async () => {
  const { repo, relayHome } = setupRepo(); const prior = process.env.RELAY_HOME; process.env.RELAY_HOME = relayHome;
  try {
    const { acquireAdmissionMutation, releaseAdmissionMutation, acquireIssueLock, releaseIssueLock, fleetIssueLockPath } = admissionHelpers();
    const lock = acquireIssueLock({ repoRoot: repo, issueNumber: 1134, fleetId: "fleet-vnext", runId: "issue-1134-20260801000000000-aaaaaaaa" });
    const replacement = `${lock.lockPath}.replacement`;
    fs.writeFileSync(replacement, JSON.stringify({ token: "replacement", pid: process.pid, hostname: os.hostname() }));
    fs.renameSync(replacement, lock.lockPath);
    assert.equal(releaseIssueLock(lock), false, "holder release must not delete a replacement inode");
    assert.equal(JSON.parse(fs.readFileSync(lock.lockPath, "utf8")).token, "replacement");

    fs.writeFileSync(lock.lockPath, JSON.stringify({ token: "dead", pid: 99999999, hostname: os.hostname() }));
    fs.writeFileSync(`${lock.lockPath}.mutation`, JSON.stringify({ token: "other" }));
    assert.throws(
      () => acquireIssueLock({ repoRoot: repo, issueNumber: 1134, fleetId: "fleet-vnext", runId: "issue-1134-20260801000000001-bbbbbbbb" }),
      /mutation is active/,
    );
    fs.unlinkSync(`${lock.lockPath}.mutation`);
    const winner = acquireIssueLock({ repoRoot: repo, issueNumber: 1134, fleetId: "fleet-vnext", runId: "issue-1134-20260801000000002-cccccccc" });
    assert.throws(
      () => acquireIssueLock({ repoRoot: repo, issueNumber: 1134, fleetId: "fleet-vnext", runId: "issue-1134-20260801000000003-dddddddd" }),
      /is held/,
    );
    assert.equal(releaseIssueLock(winner), true);

    // Two fresh processes race for a dead holder.  One may reclaim under the
    // mutation guard; the other must observe either the guard or the live new
    // holder, never delete it and also succeed.
    fs.writeFileSync(lock.lockPath, JSON.stringify({ token: "dead-again", pid: 99999999, hostname: os.hostname() }));
    const runner = path.join(repo, "contender.js");
    fs.writeFileSync(runner, [
      "const fs=require('fs'),vm=require('vm'); const {createRequire}=require('module');",
      "const dispatch=process.argv[2], source=fs.readFileSync(dispatch,'utf8'), marker='// ---------------------------------------------------------------------------\\n// Args';",
      "const sandbox={require:createRequire(dispatch),module:{exports:{}},process,console,Buffer};",
      "vm.runInNewContext(source.slice(0,source.indexOf(marker))+'\\nmodule.exports={acquireIssueLock};',sandbox,{filename:dispatch});",
      "try { sandbox.module.exports.acquireIssueLock({repoRoot:process.env.REPO,issueNumber:1134,fleetId:'fleet-vnext',runId:process.env.RUN_ID}); fs.writeFileSync(process.env.ACQUIRED_PATH,'acquired'); const timer=setInterval(()=>{if(fs.existsSync(process.env.RELEASE_PATH)){clearInterval(timer);process.exit(0)}},10); } catch(e) { console.error(e.message); process.exit(1); }",
    ].join("\n"));
    const releasePath = path.join(repo, "release-contender");
    const contenders = ["eeeeeeee", "ffffffff"].map((suffix, index) => runContender(runner, {
      ...process.env, RELAY_HOME: relayHome, REPO: repo,
      RUN_ID: `issue-1134-2026080100000001${index}-${suffix}`,
      ACQUIRED_PATH: path.join(repo, `contender-${index}.acquired`), RELEASE_PATH: releasePath,
    }));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const acquired = [0, 1].filter((index) => fs.existsSync(path.join(repo, `contender-${index}.acquired`))).length;
      if (acquired === 1 && contenders.some((handle) => handle.result?.code === 1)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal([0, 1].filter((index) => fs.existsSync(path.join(repo, `contender-${index}.acquired`))).length, 1);
    fs.writeFileSync(releasePath, "release");
    const results = await Promise.all(contenders.map((handle) => handle.promise));
    assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));

    // Deterministic pathname replacement while an immutable generation is
    // active. Release must not publish a terminal marker for replacement bytes.
    try { fs.unlinkSync(lock.lockPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const guard = acquireAdmissionMutation(lock.lockPath);
    assert.ok(guard);
    const retiredGuard = `${guard.ownerPath}.retired`;
    fs.renameSync(guard.ownerPath, retiredGuard);
    const replacementOwner = { ...guard.owner, token: "f".repeat(32) };
    fs.writeFileSync(guard.ownerPath, `${JSON.stringify(replacementOwner)}\n`);
    assert.equal(releaseAdmissionMutation(guard), false);
    assert.equal(JSON.parse(fs.readFileSync(guard.ownerPath, "utf8")).token, "f".repeat(32));
    assert.equal(fs.existsSync(guard.terminalPath), false);
  } finally { process.env.RELAY_HOME = prior; }
});

test("immutable mutation generations elect exactly one winner for the former A/B reclaim interleaving", () => {
  const { repo, relayHome } = setupRepo(); const prior = process.env.RELAY_HOME; process.env.RELAY_HOME = relayHome;
  try {
    const {
      admissionMutationSnapshot,
      prepareAdmissionMutationCandidate,
      commitAdmissionMutationCandidate,
      releaseAdmissionMutation,
      fleetIssueLockPath,
    } = admissionHelpers();
    const lockPath = fleetIssueLockPath(repo, 1135);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    // Seed a real released predecessor. Both reclaimers then observe that
    // exact same terminal tail before either publishes its successor.
    const seed = commitAdmissionMutationCandidate(
      prepareAdmissionMutationCandidate(lockPath, admissionMutationSnapshot(lockPath)),
    );
    assert.ok(seed);
    assert.equal(releaseAdmissionMutation(seed), true);
    const predecessor = admissionMutationSnapshot(lockPath);
    assert.equal(predecessor.entries.length, 1);
    assert.equal(predecessor.entries[0].terminal.outcome, "released");
    const contenderA = prepareAdmissionMutationCandidate(lockPath, predecessor);
    const contenderB = prepareAdmissionMutationCandidate(lockPath, predecessor);
    assert.equal(contenderA.generation, contenderB.generation);
    assert.equal(contenderA.ownerPath, contenderB.ownerPath);
    const winnerA = commitAdmissionMutationCandidate(contenderA);
    const loserB = commitAdmissionMutationCandidate(contenderB);
    assert.ok(winnerA);
    assert.equal(loserB, null);

    // B cannot acquire the mutation generation and therefore cannot reach the
    // stale issue-lock revalidation/unlink section that A protects.
    assert.equal(releaseAdmissionMutation(winnerA), true);
    const next = admissionMutationSnapshot(lockPath);
    assert.equal(next.active, null);
    assert.equal(next.nextGeneration, predecessor.nextGeneration + 1);
  } finally { process.env.RELAY_HOME = prior; }
});

test("fleet admission reclaims crashed or PID-reused mutation generations and scans only after lock", () => {
  const { repo, relayHome } = setupRepo(); const prior = process.env.RELAY_HOME; process.env.RELAY_HOME = relayHome;
  try {
    const {
      admissionMutationSnapshot,
      prepareAdmissionMutationCandidate,
      commitAdmissionMutationCandidate,
      acquireIssueAdmission,
      acquireIssueLock,
      releaseIssueLock,
      fleetIssueLockPath,
    } = admissionHelpers();
    const lockPath = fleetIssueLockPath(repo, 1135);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const stale = prepareAdmissionMutationCandidate(lockPath, admissionMutationSnapshot(lockPath));
    stale.owner = {
      ...stale.owner,
      process_started_at: "2000-01-01T00:00:00.000Z",
      process_fingerprint: null,
    };
    assert.ok(commitAdmissionMutationCandidate(stale));
    const recovered = acquireIssueLock({ repoRoot: repo, issueNumber: 1135, fleetId: "fleet-vnext", runId: "issue-1135-20260801000000000-aaaaaaaa" });
    const recoveredSnapshot = admissionMutationSnapshot(lockPath);
    assert.equal(recoveredSnapshot.entries[0].terminal.outcome, "broken");
    assert.equal(recoveredSnapshot.active, null, "the recovery generation is released after issue-lock acquisition");
    assert.equal(releaseIssueLock(recovered), true);

    let observedLock = false;
    const admission = acquireIssueAdmission({
      repoRoot: repo, issueNumber: 1136, fleetId: "fleet-vnext",
      runId: "issue-1136-20260801000000000-bbbbbbbb",
      scanInflight() { observedLock = fs.existsSync(fleetIssueLockPath(repo, 1136)); return [{ runId: "prior" }]; },
    });
    assert.equal(observedLock, true, "authoritative rescan occurs under the issue lock");
    assert.deepEqual(admission.inflightRuns, [{ runId: "prior" }]);
    assert.equal(releaseIssueLock(admission.lock), true);
  } finally { process.env.RELAY_HOME = prior; }
});

test("fleet admission refuses symlinked logical lock parents before publishing or scanning its ledger", () => {
  const { repo, relayHome } = setupRepo(); const prior = process.env.RELAY_HOME; process.env.RELAY_HOME = fs.realpathSync(relayHome);
  try {
    const { acquireIssueLock, admissionMutationSnapshot, fleetIssueLockPath } = admissionHelpers();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-admission-escape-")));
    fs.symlinkSync(outside, path.join(process.env.RELAY_HOME, "fleets"), "dir");
    const logicalLockPath = fleetIssueLockPath(repo, 1138);
    const expectedOutsideLock = path.join(outside, path.basename(path.dirname(path.dirname(logicalLockPath))), "locks", path.basename(logicalLockPath));

    assert.throws(
      () => acquireIssueLock({ repoRoot: repo, issueNumber: 1138, fleetId: "fleet-vnext", runId: "issue-1138-20260801000000000-aaaaaaaa" }),
      /contains a symlink component/,
    );
    assert.equal(fs.existsSync(expectedOutsideLock), false, "lock publication must not traverse the symlinked fleet parent");
    assert.throws(() => admissionMutationSnapshot(logicalLockPath), /contains a symlink component/);
  } finally { process.env.RELAY_HOME = prior; }
});

test("issue-lock publication leaves no partial lock after write, fsync, or directory-fsync EIO", () => {
  const { repo, relayHome } = setupRepo(); const prior = process.env.RELAY_HOME; process.env.RELAY_HOME = relayHome;
  try {
    const { publishIssueLockExclusive, acquireIssueLock, releaseIssueLock, fleetIssueLockPath } = admissionHelpers();
    const lockPath = fleetIssueLockPath(repo, 1137);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const record = { issue_number: 1137, fleet_id: "fleet-vnext", run_id: "issue-1137-20260801000000000-aaaaaaaa", token: "a".repeat(32) };

    for (const stage of ["write", "file-fsync", "dir-fsync"]) {
      let injected = false;
      const faultyFs = {
        ...fs,
        writeFileSync(...args) {
          if (stage === "write" && !injected) {
            injected = true;
            const error = new Error("injected EIO"); error.code = "EIO"; throw error;
          }
          return fs.writeFileSync(...args);
        },
        fsyncSync(fd) {
          const isDirectory = fs.fstatSync(fd).isDirectory();
          if (
            !injected
            && ((stage === "file-fsync" && !isDirectory) || (stage === "dir-fsync" && isDirectory))
          ) {
            injected = true;
            const error = new Error("injected EIO"); error.code = "EIO"; throw error;
          }
          return fs.fsyncSync(fd);
        },
      };
      assert.throws(() => publishIssueLockExclusive(lockPath, record, faultyFs), /injected EIO/, stage);
      assert.equal(fs.existsSync(lockPath), false, `${stage} must not leave a poison lock`);
      assert.equal(
        fs.readdirSync(path.dirname(lockPath)).some((name) => name.startsWith(`.${path.basename(lockPath)}.tmp.`)),
        false,
        `${stage} must remove the private temporary inode`,
      );

      const admitted = acquireIssueLock({
        repoRoot: repo,
        issueNumber: 1137,
        fleetId: "fleet-vnext",
        runId: `issue-1137-2026080100000000${stage.length}-bbbbbbbb`,
      });
      assert.equal(releaseIssueLock(admitted), true, `${stage} retry admission must release normally`);
    }
  } finally { process.env.RELAY_HOME = prior; }
});
