"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const SCRIPT = path.resolve(__dirname, "../../../skills/relay-merge/scripts/run-full-gate.js");

function makeFixture({ delayMs = 0, fail = false, block = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-full-gate-test-"));
  const repo = path.join(root, "repo");
  const suites = path.join(repo, "fake-suites");
  const home = path.join(root, "home");
  fs.mkdirSync(suites, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const releasePath = path.join(root, "release-first-suite");
  const testFile = path.join(suites, fail ? "failing.test.js" : "passing.test.js");
  fs.writeFileSync(testFile, `
const test = require("node:test");
const assert = require("node:assert/strict");
test("fake suite", async () => {
  ${delayMs ? `await new Promise((resolve) => setTimeout(resolve, ${delayMs}));` : ""}
  ${block ? `
  const started = Date.now();
  while (!require("fs").existsSync(${JSON.stringify(releasePath)})) {
    if (Date.now() - started > 30000) throw new Error("release marker timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }` : ""}
  assert.equal(1, ${fail ? 2 : 1});
});
`, "utf-8");
  return { root, repo, suites, home, testFile, releasePath };
}

function invoke(fixture, output, extraArgs = []) {
  const env = { ...process.env, HOME: fixture.home };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [
    SCRIPT,
    "--repo", fixture.repo,
    "--suites", path.join(fixture.suites, "*.test.js"),
    "--output", output,
    ...extraArgs,
    "--lock-timeout", "5",
  ], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, pid: child.pid }));
  });
  return { child, completion };
}

async function waitFor(predicate, description, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

test("two invocations serialize and the second reports the live lock owner", async (t) => {
  const fixture = makeFixture({ block: true });
  t.after(() => {
    fs.writeFileSync(fixture.releasePath, "release\n", "utf-8");
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const firstOutput = path.join(fixture.root, "first.log");
  const secondOutput = path.join(fixture.root, "second.log");
  const lockPath = path.join(fixture.home, ".relay", "locks", "full-gate.lock");

  const first = invoke(fixture, firstOutput, ["--json"]);
  const firstOwner = await waitFor(() => readJson(lockPath), "first detached runner lock");
  assert.notEqual(firstOwner.pid, first.child.pid, "detached runner, not invoker, owns the lock");

  const second = invoke(fixture, secondOutput);
  const waiting = await waitFor(() => {
    const status = readJson(`${secondOutput}.status.json`);
    return status?.state === "waiting_for_lock" ? status : null;
  }, "second runner lock wait");
  assert.equal(waiting.lock_wait.owner.pid, firstOwner.pid);
  fs.writeFileSync(fixture.releasePath, "release\n", "utf-8");

  const [firstResult, secondResult] = await Promise.all([first.completion, second.completion]);
  assert.equal(firstResult.code, 0);
  assert.equal(secondResult.code, 0);
  assert.match(secondResult.stdout, /Waiting for full-gate lock owned by pid/);
  assert.match(secondResult.stdout, /Full-gate lock acquired/);
  const secondSentinel = readJson(`${secondOutput}.done`);
  assert.equal(secondSentinel.result, "pass");
  assert.equal(secondSentinel.lock_wait.did_wait, true);
  assert.equal(secondSentinel.lock_wait.owner.pid, firstOwner.pid);
  assert.ok(secondSentinel.lock_wait.waited_ms > 0);
});

// Regression for #975: the detached runner can acquire the lock and finish
// (fast suites) within a single SENTINEL_POLL_MS window, so waitForDetached's
// poll loop finds the completion sentinel before it ever observes the
// intermediate status.state === "running" transition. This drives
// waitForDetached directly (via a throwaway child process that requires the
// script and calls the export) so the "sentinel beats the status poll" skip
// is deterministic instead of depending on real subprocess/suite timing.
test("waitForDetached announces lock acquisition even when the sentinel beats the status poll", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-full-gate-skip-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statusPath = path.join(root, "gate.status.json");
  const sentinelPath = path.join(root, "gate.done");
  const owner = { pid: 987654, pgid: 987654, host: "loaded-ci-host", started_at: new Date(0).toISOString() };

  // Only ever write "waiting_for_lock" — the status file never flips to
  // "running", modelling the skip from the invoker's point of view.
  fs.writeFileSync(statusPath, `${JSON.stringify({
    runner_pid: owner.pid,
    runner_pgid: owner.pgid,
    state: "waiting_for_lock",
    lock_wait: { did_wait: true, waited_ms: 250, owner, stale_reclaimed: false },
  })}\n`, "utf-8");

  const driverSource = [
    `const mod = require(${JSON.stringify(SCRIPT)});`,
    `process.exitCode = 0;`,
    `const result = mod.waitForDetached(${JSON.stringify({ statusPath, sentinelPath, json: false })});`,
    `process.stdout.write("DRIVER_RESULT:" + JSON.stringify(result) + "\\n");`,
  ].join("\n");
  const driver = spawn(process.execPath, ["-e", driverSource], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  driver.stdout.on("data", (chunk) => { stdout += chunk; });
  let stderr = "";
  driver.stderr.on("data", (chunk) => { stderr += chunk; });

  // Only write the sentinel once the driver has genuinely announced the wait
  // itself, so the invariant this test relies on (announcedState already
  // "waiting_for_lock" when the sentinel is discovered) is never racy.
  await waitFor(() => stdout.includes("Waiting for full-gate lock owned by pid 987654"), "driver to announce waiting_for_lock");

  const sentinelResult = {
    result: "pass",
    exit_code: 0,
    duration_ms: 4242,
    output: path.join(root, "gate.log"),
    sentinel: sentinelPath,
    total_files: 3,
    total_failed_files: 0,
    failed_files: [],
    lock_wait: { did_wait: true, waited_ms: 250, owner, stale_reclaimed: false },
  };
  const sentinelTemp = `${sentinelPath}.tmp`;
  fs.writeFileSync(sentinelTemp, `${JSON.stringify(sentinelResult)}\n`, "utf-8");
  fs.renameSync(sentinelTemp, sentinelPath);

  const completion = await new Promise((resolve, reject) => {
    driver.once("error", reject);
    driver.once("close", (code) => resolve({ code }));
  });
  assert.equal(completion.code, 0, stderr);
  assert.match(stdout, /Waiting for full-gate lock owned by pid 987654 \(pgid 987654, host loaded-ci-host\)\.\.\./);
  assert.match(stdout, /Full-gate lock acquired; running suites serially\.\.\./);
  assert.ok(
    stdout.indexOf("Waiting for full-gate lock") < stdout.indexOf("Full-gate lock acquired"),
    "waiting announcement must precede the lock-acquired announcement",
  );
  // Status never flipped to "running" — the fix must not require it to.
  assert.equal(readJson(statusPath).state, "waiting_for_lock");
});

// Regression for #1172: a loaded host can delay waitForDetached's poll loop past
// the waiting_for_lock status entirely, so neither announcement fires and the
// invoker sees silence while it was in fact blocked. #975 covered the sentinel
// beating the "running" status; this is the sentinel beating "waiting_for_lock"
// itself, where announcedState is still null.
test("waitForDetached announces the wait from the sentinel when it never observed waiting_for_lock", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-full-gate-silent-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statusPath = path.join(root, "gate.status.json");
  const sentinelPath = path.join(root, "gate.done");
  const owner = { pid: 424242, pgid: 424242, host: "saturated-ci-host", started_at: new Date(0).toISOString() };

  // The sentinel exists before the driver's first poll, and no status file is
  // ever written. This is the loaded-host case: the whole waiting_for_lock
  // window elapsed between two polls.
  fs.writeFileSync(sentinelPath, `${JSON.stringify({
    result: "pass",
    exit_code: 0,
    duration_ms: 315,
    output: path.join(root, "gate.log"),
    sentinel: sentinelPath,
    total_files: 1,
    total_failed_files: 0,
    failed_files: [],
    lock_wait: { did_wait: true, waited_ms: 1200, owner, stale_reclaimed: false },
  })}\n`, "utf-8");

  const driverSource = [
    `const mod = require(${JSON.stringify(SCRIPT)});`,
    `process.exitCode = 0;`,
    `const result = mod.waitForDetached(${JSON.stringify({ statusPath, sentinelPath, json: false })});`,
    `process.stdout.write("DRIVER_RESULT:" + JSON.stringify(result) + "\\n");`,
  ].join("\n");
  const driver = spawn(process.execPath, ["-e", driverSource], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  driver.stdout.on("data", (chunk) => { stdout += chunk; });
  let stderr = "";
  driver.stderr.on("data", (chunk) => { stderr += chunk; });
  const completion = await new Promise((resolve, reject) => {
    driver.once("error", reject);
    driver.once("close", (code) => resolve({ code }));
  });

  assert.equal(completion.code, 0, stderr);
  assert.match(stdout, /Waiting for full-gate lock owned by pid 424242 \(pgid 424242, host saturated-ci-host\)\.\.\./);
  assert.match(stdout, /Full-gate lock acquired; running suites serially\.\.\./);
  assert.ok(
    stdout.indexOf("Waiting for full-gate lock") < stdout.indexOf("Full-gate lock acquired"),
    "waiting announcement must precede the lock-acquired announcement",
  );
  assert.match(stdout, /DRIVER_RESULT:/);
  // The status file was never written at all, so the announcements can only
  // have come from the sentinel's durable lock_wait record.
  assert.equal(fs.existsSync(statusPath), false);
});

// Negative control for the above: a run that never waited must stay silent, so
// the sentinel-derived announcement is gated on did_wait rather than emitted
// unconditionally whenever a sentinel is found first.
test("waitForDetached stays silent when the sentinel records no lock wait", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-full-gate-nowait-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statusPath = path.join(root, "gate.status.json");
  const sentinelPath = path.join(root, "gate.done");

  fs.writeFileSync(sentinelPath, `${JSON.stringify({
    result: "pass",
    exit_code: 0,
    duration_ms: 200,
    output: path.join(root, "gate.log"),
    sentinel: sentinelPath,
    total_files: 1,
    total_failed_files: 0,
    failed_files: [],
    lock_wait: { did_wait: false, waited_ms: 0, owner: null, stale_reclaimed: false },
  })}\n`, "utf-8");

  const driverSource = [
    `const mod = require(${JSON.stringify(SCRIPT)});`,
    `process.exitCode = 0;`,
    `const result = mod.waitForDetached(${JSON.stringify({ statusPath, sentinelPath, json: false })});`,
    `process.stdout.write("DRIVER_RESULT:" + JSON.stringify(result) + "\\n");`,
  ].join("\n");
  const driver = spawn(process.execPath, ["-e", driverSource], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  driver.stdout.on("data", (chunk) => { stdout += chunk; });
  const completion = await new Promise((resolve, reject) => {
    driver.once("error", reject);
    driver.once("close", (code) => resolve({ code }));
  });

  assert.equal(completion.code, 0);
  assert.doesNotMatch(stdout, /Waiting for full-gate lock/);
  assert.doesNotMatch(stdout, /Full-gate lock acquired/);
  assert.match(stdout, /DRIVER_RESULT:/);
});

test("a lock owned by a real exited process is reclaimed as stale", async (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    dead.once("error", reject);
    dead.once("close", resolve);
  });
  assert.throws(() => process.kill(dead.pid, 0), { code: "ESRCH" });

  const lockPath = path.join(fixture.home, ".relay", "locks", "full-gate.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: dead.pid,
    pgid: dead.pid,
    host: os.hostname(),
    started_at: new Date(0).toISOString(),
  })}\n`, "utf-8");

  const output = path.join(fixture.root, "stale.log");
  const invocation = invoke(fixture, output, ["--json"]);
  const result = await invocation.completion;
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, "pass");
  assert.equal(payload.lock_wait.stale_reclaimed, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test("a failed suite produces failed-file evidence, totals, JSON, and exit 1", async (t) => {
  const fixture = makeFixture({ fail: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const output = path.join(fixture.root, "failure.log");
  const invocation = invoke(fixture, output, ["--json"]);
  const result = await invocation.completion;

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, "fail");
  assert.equal(payload.total_files, 1);
  assert.equal(payload.total_failed_files, 1);
  const failedLabel = path.relative(fixture.repo, fixture.testFile);
  assert.deepEqual(payload.failed_files, [failedLabel]);
  assert.equal(typeof payload.duration_ms, "number");
  assert.equal(payload.lock_wait.did_wait, false);
  const evidence = fs.readFileSync(output, "utf-8");
  assert.match(evidence, new RegExp(`===== ${failedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} =====`));
  assert.match(evidence, new RegExp(`FAILED_FILE: ${failedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(evidence, /TOTAL_FAILED_FILES: 1/);
  assert.match(evidence, /TOTAL_FILES: 1/);
  assert.equal(readJson(`${output}.done`).exit_code, 1);
});

test("lock timeout is a distinct JSON result and exit code", async (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const lockPath = path.join(fixture.home, ".relay", "locks", "full-gate.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    pgid: process.pid,
    host: os.hostname(),
    started_at: new Date().toISOString(),
  })}\n`, "utf-8");

  const output = path.join(fixture.root, "timeout.log");
  const invocation = invoke(fixture, output, ["--lock-timeout", "0", "--json"]);
  const result = await invocation.completion;
  assert.equal(result.code, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, "lock_timeout");
  assert.equal(payload.exit_code, 2);
  assert.equal(payload.lock_wait.did_wait, true);
  assert.equal(payload.lock_wait.owner.pid, process.pid);
  assert.equal(typeof payload.duration_ms, "number");
});

test("detached runner completes after only its invoking process is terminated", async (t) => {
  const fixture = makeFixture({ delayMs: 700 });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const output = path.join(fixture.root, "detached.log");
  const invocation = invoke(fixture, output, ["--json"]);
  const lockPath = path.join(fixture.home, ".relay", "locks", "full-gate.lock");
  const owner = await waitFor(() => readJson(lockPath), "detached runner lock");
  assert.notEqual(owner.pid, invocation.child.pid);

  invocation.child.kill("SIGTERM");
  const invokerResult = await invocation.completion;
  assert.equal(invokerResult.signal, "SIGTERM");
  const sentinel = await waitFor(() => readJson(`${output}.done`), "completion sentinel after invoker termination");
  assert.equal(sentinel.result, "pass");
  assert.match(fs.readFileSync(output, "utf-8"), /TOTAL_FAILED_FILES: 0/);
  await waitFor(() => !fs.existsSync(lockPath), "detached runner lock release");
});
