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
