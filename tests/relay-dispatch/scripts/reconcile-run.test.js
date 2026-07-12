const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  getEventsPath,
  getRunDir,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { appendRunEvent, EVENTS, readRunEvents } = require("../../../skills/relay-dispatch/scripts/relay-events");
const { EXECUTION_EVIDENCE_FILENAME, buildExecutionEvidence, hashFileSha256 } = require("../../../skills/relay-dispatch/scripts/execution-evidence");
const { buildExecutionEvidencePreflight } = require("../../../skills/relay-review/scripts/review-runner/execution-evidence");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "reconcile-run.js");

function writeFakeGh(binDir, statePath, logPath, initialState = {}) {
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const statePath = process.env.RELAY_TEST_GH_STATE;
const logPath = process.env.RELAY_TEST_GH_LOG;
if (logPath) fs.appendFileSync(logPath, JSON.stringify(args) + "\\n", "utf-8");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf-8")) : {};
function save() { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); }
if (args[0] === "pr" && args[1] === "list") {
  if (state.failPrList) {
    process.stderr.write(state.failPrList + "\\n");
    process.exit(1);
  }
  if (state.existingPrNumber !== undefined && state.existingPrNumber !== null) {
    process.stdout.write(String(state.existingPrNumber) + "\\n");
  }
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  state.createCalls = Number(state.createCalls || 0) + 1;
  if (state.failPrCreate) {
    save();
    process.stderr.write(state.failPrCreate + "\\n");
    process.exit(1);
  }
  state.existingPrNumber = state.createNumber || 281;
  save();
  process.stdout.write("https://github.com/acme/dev-relay/pull/" + state.existingPrNumber + "\\n");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  const issueNumber = String(args[2]);
  const title = state.issueTitles && state.issueTitles[issueNumber];
  if (!title) {
    process.stderr.write("issue not found: " + issueNumber + "\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ number: Number(issueNumber), title }) + "\\n");
  process.exit(0);
}
process.stderr.write("unexpected fake gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  fs.writeFileSync(statePath, JSON.stringify({
    createNumber: 281,
    issueTitles: { "801": "Crash-only dispatch reconciliation" },
    ...initialState,
  }, null, 2));
  fs.writeFileSync(logPath, "");
  return ghPath;
}

function setupRepo({
  manifestState = STATES.DISPATCHED,
  committedWork = false,
  resultFile = false,
  resultFileContent = "executor result before crash\n",
  oldShapePaths = false,
  publishPolicy = "immediate",
  ghState = {},
  executionEvidence = true,
  dispatchResultFailureClass = undefined,
} = {}) {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-reconcile-run-")));
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-")));
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-reconcile-gh-")));
  const statePath = path.join(binDir, "gh-state.json");
  const ghLogPath = path.join(binDir, "gh.log");
  process.env.RELAY_HOME = relayHome;

  const originRoot = path.join(repoRoot, "origin.git");
  execFileSync("git", ["init", "--bare", originRoot], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Reconcile Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-reconcile@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", originRoot], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const branch = "issue-801";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const dispatchHead = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

  let committedHead = dispatchHead;
  if (committedWork) {
    fs.writeFileSync(path.join(worktreePath, "reconciled.txt"), "committed before crash\n", "utf-8");
    execFileSync("git", ["-C", worktreePath, "add", "reconciled.txt"], { encoding: "utf-8", stdio: "pipe" });
    execFileSync("git", ["-C", worktreePath, "commit", "-m", "Executor work before crash"], { encoding: "utf-8", stdio: "pipe" });
    committedHead = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  }

  const runId = createRunId({
    issueNumber: 801,
    branch,
    timestamp: new Date("2026-05-01T01:00:00.000Z"),
  });
  const layout = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 801,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.dispatch = { publish_policy: publishPolicy };
  manifest.anchor.rubric_path = "rubric.yaml";
  manifest.git.head_sha = dispatchHead;
  fs.writeFileSync(path.join(layout.runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: reconcile-run\n", "utf-8");
  if (manifestState === STATES.REVIEW_PENDING) {
    manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  } else if (manifestState === STATES.ESCALATED) {
    manifest = updateManifestState(manifest, STATES.ESCALATED, "inspect_dispatch_failure");
    manifest.git.head_sha = committedHead;
  } else if (manifestState !== STATES.DISPATCHED) {
    throw new Error(`unsupported fixture state ${manifestState}`);
  }
  if (oldShapePaths) {
    manifest.paths.result_file = path.join(os.tmpdir(), "dispatch-codex-old-shape.txt");
    manifest.paths.stdout_log = path.join(os.tmpdir(), "dispatch-codex-old-shape.log");
    manifest.paths.stderr_log = path.join(os.tmpdir(), "dispatch-codex-old-shape.err");
  }
  writeManifest(layout.manifestPath, manifest);
  if (resultFile) {
    fs.writeFileSync(path.join(layout.runDir, "dispatch-result.txt"), resultFileContent, "utf-8");
  }
  if (executionEvidence) {
    fs.writeFileSync(path.join(layout.runDir, EXECUTION_EVIDENCE_FILENAME), JSON.stringify({
      schema_version: 1,
      head_sha: dispatchHead,
      test_command: "node --test tests/relay-dispatch/scripts/*.test.js",
      test_result_hash: "unspecified",
      test_result_summary: "unspecified",
      recorded_at: "2026-05-01T01:00:00.000Z",
      recorded_by: "dispatch-orchestrator-v1",
    }, null, 2));
  }

  if (dispatchResultFailureClass !== undefined) {
    // Mirror the supervisor's timeout escalation stamp: a DISPATCH_RESULT event with
    // state_to escalated and the dispatch_failure_class the salvage path keys off.
    appendRunEvent(repoRoot, runId, {
      event: EVENTS.DISPATCH_RESULT,
      state_from: STATES.DISPATCHED,
      state_to: STATES.ESCALATED,
      head_sha: committedHead,
      reason: "new_dispatch:executor total_timeout after 3600s",
      dispatch_failure_class: dispatchResultFailureClass,
      publish_policy: publishPolicy,
    });
  }

  const ghPath = writeFakeGh(binDir, statePath, ghLogPath, ghState);
  const env = {
    ...process.env,
    RELAY_HOME: relayHome,
    RELAY_GH_BIN: ghPath,
    RELAY_TEST_GH_STATE: statePath,
    RELAY_TEST_GH_LOG: ghLogPath,
  };
  return {
    repoRoot,
    relayHome,
    runId,
    manifestPath: layout.manifestPath,
    runDir: layout.runDir,
    worktreePath,
    branch,
    dispatchHead,
    committedHead,
    originRoot,
    statePath,
    ghLogPath,
    env,
  };
}

function runReconcile(fixture, extraArgs = []) {
  return spawnSync(process.execPath, [
    SCRIPT,
    "--repo", fixture.repoRoot,
    "--run-id", fixture.runId,
    "--json",
    ...extraArgs,
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    env: fixture.env,
  });
}

function parseJsonResult(proc) {
  assert.equal(proc.status, 0, `expected reconcile success\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`);
  return JSON.parse(proc.stdout);
}

function writeLease(fixture, { pid = process.pid, pgid, host = os.hostname(), startedAt, timeoutS = 60 }) {
  const leasePath = path.join(fixture.runDir, "lease.json");
  fs.writeFileSync(leasePath, JSON.stringify({
    pid,
    pgid,
    host,
    started_at: startedAt,
    timeout_s: timeoutS,
  }, null, 2), "utf-8");
  return leasePath;
}

function isPgidAlive(pgid) {
  try {
    process.kill(-Number(pgid), 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    return false;
  }
}

function killPgid(pgid) {
  try {
    process.kill(-Number(pgid), "SIGTERM");
  } catch {}
}

function killPgidForce(pgid) {
  try {
    process.kill(-Number(pgid), "SIGKILL");
  } catch {}
}

async function waitFor(condition, { timeoutMs = 5000, intervalMs = 50, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${message}`);
}

// Reconcile targets executors whose dispatch supervisor is already dead, so the
// real process is orphaned (reparented to init, which reaps it on death). Spawn
// through a short-lived intermediate so the sleeper is orphaned the same way;
// keeping the test process as the parent would leave an unreaped zombie while
// runReconcile blocks the event loop in execFileSync, and kill(-pgid, 0) reports
// zombie groups as alive.
async function spawnOrphanedSleeper(t, { inlineSetup = "", cleanup = killPgid } = {}) {
  const sleeperSource = `${inlineSetup}setInterval(() => {}, 1000);`;
  const launcherSource = [
    'const { spawn } = require("child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(sleeperSource)}], { detached: true, stdio: "ignore" });`,
    "child.unref();",
    "console.log(child.pid);",
  ].join("\n");
  const stdout = execFileSync(process.execPath, ["-e", launcherSource], { encoding: "utf-8" });
  const pid = Number(stdout.trim());
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`orphaned sleeper launcher returned invalid pid: ${JSON.stringify(stdout)}`);
  }
  t.after(() => cleanup(pid));
  await waitFor(() => isPgidAlive(pid), { message: `pgid ${pid} alive` });
  return { pid };
}

function spawnSleeper(t) {
  return spawnOrphanedSleeper(t);
}

function spawnSigtermIgnoringSleeper(t) {
  return spawnOrphanedSleeper(t, {
    inlineSetup: "process.on('SIGTERM', () => {}); ",
    cleanup: killPgidForce,
  });
}

test("reconcile row 1 no-ops when manifest is not dispatched", () => {
  const fixture = setupRepo({ manifestState: STATES.REVIEW_PENDING });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 1);
  assert.equal(result.status, "noop");
  assert.equal(result.state, STATES.REVIEW_PENDING);
  assert.equal(result.nextAction, "none");
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.REVIEW_PENDING);
});

test("reconcile row 2 preserves work when an unexpired lease supervisor pid is live even if its pgid is empty", async (t) => {
  const fixture = setupRepo({ committedWork: true });
  const child = await spawnSleeper(t);
  const leasePath = writeLease(fixture, {
    pid: child.pid,
    pgid: 999999,
    startedAt: new Date().toISOString(),
    timeoutS: 60,
  });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 2);
  assert.equal(result.status, "running");
  assert.equal(result.lease.pid, child.pid);
  assert.ok(result.remaining_s > 0);
  assert.equal(fs.existsSync(leasePath), true);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.DISPATCHED);
  assert.equal(isPgidAlive(child.pid), true);
});

test("reconcile confirms an unexpired dead lease supervisor pid twice before row 4 recovery", () => {
  const fixture = setupRepo({ committedWork: true });
  const deadPid = 999999;
  const probeLog = path.join(fixture.runDir, "pid-probes.log");
  fixture.env.RELAY_TEST_PROCESS_PROBE_LOG = probeLog;
  writeLease(fixture, {
    pid: deadPid,
    pgid: deadPid,
    startedAt: new Date().toISOString(),
    timeoutS: 60,
  });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 4);
  assert.equal(result.status, "recovered");
  assert.deepEqual(
    fs.readFileSync(probeLog, "utf-8").trim().split(/\r?\n/),
    [String(deadPid), String(deadPid)]
  );
});

test("reconcile treats notifier-only pgid survivors as dead when the lease supervisor pid is dead", async (t) => {
  const fixture = setupRepo({ committedWork: true });
  const notifier = await spawnSleeper(t);
  const leasePath = writeLease(fixture, {
    pid: 999999,
    pgid: notifier.pid,
    startedAt: new Date().toISOString(),
    timeoutS: 60,
  });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 4);
  assert.equal(result.status, "recovered");
  assert.equal(fs.existsSync(leasePath), false);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.REVIEW_PENDING);
  assert.equal(isPgidAlive(notifier.pid), true);
});

test("reconcile treats a zombie-only process group lease as dead retry evidence", () => {
  const fixture = setupRepo();
  const pgid = 888888;
  const leasePath = writeLease(fixture, {
    pid: pgid,
    pgid,
    startedAt: new Date().toISOString(),
    timeoutS: 60,
  });
  fixture.env.RELAY_TEST_PROCESS_GROUP_ALIVE_EPERM = String(pgid);
  fixture.env.RELAY_TEST_PROCESS_GROUP_STATES = JSON.stringify([{ pgid, stat: "Z" }]);

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 5);
  assert.equal(result.status, "interrupted");
  assert.equal(fs.existsSync(leasePath), false);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.DISPATCHED);
});

test("reconcile treats host-mismatched leases as stale evidence", async (t) => {
  const fixture = setupRepo({ committedWork: true });
  const child = await spawnSleeper(t);
  const leasePath = writeLease(fixture, {
    pgid: child.pid,
    host: "other-host.example.test",
    startedAt: new Date().toISOString(),
    timeoutS: 60,
  });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 4);
  assert.equal(result.status, "recovered");
  assert.equal(fs.existsSync(leasePath), false);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.REVIEW_PENDING);
  assert.equal(isPgidAlive(child.pid), true);
});

test("reconcile treats host-mismatched leases without work as stale retry evidence", async (t) => {
  const fixture = setupRepo();
  const child = await spawnSleeper(t);
  const leasePath = writeLease(fixture, {
    pgid: child.pid,
    host: "other-host.example.test",
    startedAt: new Date().toISOString(),
    timeoutS: 60,
  });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 5);
  assert.equal(result.status, "interrupted");
  assert.equal(fs.existsSync(leasePath), false);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.DISPATCHED);
  assert.equal(isPgidAlive(child.pid), true);
});

test("reconcile treats corrupt leases with committed work as stale evidence", () => {
  const fixture = setupRepo({ committedWork: true });
  const leasePath = path.join(fixture.runDir, "lease.json");
  fs.writeFileSync(leasePath, "{\"pid\":", "utf-8");

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 4);
  assert.equal(result.status, "recovered");
  assert.equal(result.leaseStatus, "corrupt");
  assert.match(result.leaseError, /invalid run lease/);
  assert.equal(fs.existsSync(leasePath), false);
  const manifest = readManifest(fixture.manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  const stateRecovery = events.find((event) => event.event === EVENTS.STATE_RECOVERY);
  assert.equal(stateRecovery.failure_class, "corrupt_run_lease");
  assert.match(stateRecovery.failure_reason, /invalid run lease/);
});

test("reconcile treats corrupt leases without work as stale retry evidence", () => {
  const fixture = setupRepo();
  const leasePath = path.join(fixture.runDir, "lease.json");
  fs.writeFileSync(leasePath, "{\"pid\":", "utf-8");

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 5);
  assert.equal(result.status, "interrupted");
  assert.equal(result.leaseStatus, "corrupt");
  assert.match(result.leaseError, /invalid run lease/);
  assert.equal(fs.existsSync(leasePath), false);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.DISPATCHED);
  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(events.at(-1).event, EVENTS.DISPATCH_INTERRUPTED);
  assert.equal(events.at(-1).failure_class, "corrupt_run_lease");
  assert.match(events.at(-1).failure_reason, /invalid run lease/);
});

test("reconcile row 3 kills a timed-out live lease and journals interruption", async (t) => {
  const fixture = setupRepo();
  const child = await spawnSleeper(t);
  const leasePath = writeLease(fixture, {
    pgid: child.pid,
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    timeoutS: 1,
  });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 3);
  assert.equal(result.status, "timed_out_killed");
  assert.equal(fs.existsSync(leasePath), false);
  await waitFor(() => !isPgidAlive(child.pid), { message: `pgid ${child.pid} dead` });
  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(events.at(-1).event, EVENTS.DISPATCH_INTERRUPTED);
  assert.equal(events.at(-1).reason, "reconcile_timeout");
});

test("reconcile row 3 journals timeout kill after a prior dispatch interruption tail", async (t) => {
  const fixture = setupRepo();
  const child = await spawnSleeper(t);
  const leasePath = writeLease(fixture, {
    pgid: child.pid,
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    timeoutS: 1,
  });
  appendRunEvent(fixture.repoRoot, fixture.runId, {
    event: EVENTS.DISPATCH_INTERRUPTED,
    state_from: STATES.DISPATCHED,
    state_to: STATES.DISPATCHED,
    reason: "dispatch_supervisor_interrupted",
    executor_pid: child.pid,
    executor_pgid: child.pid,
    executor_terminated: false,
    worktree: fixture.worktreePath,
  });
  const beforeEvents = readRunEvents(fixture.repoRoot, fixture.runId);

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 3);
  assert.equal(result.status, "timed_out_killed");
  assert.equal(result.journaled, true);
  assert.equal(fs.existsSync(leasePath), false);
  await waitFor(() => !isPgidAlive(child.pid), { message: `pgid ${child.pid} dead` });
  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(events.length, beforeEvents.length + 1);
  assert.equal(events.at(-1).event, EVENTS.DISPATCH_INTERRUPTED);
  assert.equal(events.at(-1).reason, "reconcile_timeout");
  assert.equal(events.at(-1).executor_terminated, true);
});

test("reconcile row 3 keeps the lease when a timed-out process group ignores SIGTERM", async (t) => {
  const fixture = setupRepo();
  const child = await spawnSigtermIgnoringSleeper(t);
  const leasePath = writeLease(fixture, {
    pgid: child.pid,
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    timeoutS: 1,
  });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 3);
  assert.equal(result.status, "timed_out_unsettled");
  assert.equal(result.nextAction, "kill_executor_or_wait");
  assert.equal(result.killConfirmed, false);
  assert.equal(fs.existsSync(leasePath), true);
  assert.equal(isPgidAlive(child.pid), true);
  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(events.at(-1).event, EVENTS.DISPATCH_INTERRUPTED);
  assert.equal(events.at(-1).reason, "reconcile_timeout_unsettled");
  assert.equal(events.at(-1).executor_terminated, false);
});

test("reconcile row 4 byte-preserves recovery for an expired lease with a dead supervisor pid", () => {
  const fixture = setupRepo({ committedWork: true });
  const leasePath = writeLease(fixture, {
    pid: 999999,
    pgid: 999999,
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    timeoutS: 1,
  });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 4);
  assert.equal(result.status, "recovered");
  assert.equal(fs.existsSync(leasePath), false);
  const manifest = readManifest(fixture.manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.git.pr_number, 281);
  const remoteBranch = execFileSync("git", ["ls-remote", "--heads", "origin", fixture.branch], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  assert.match(remoteBranch, new RegExp(`refs/heads/${fixture.branch}$`));
  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.ok(events.some((event) => event.event === EVENTS.STATE_RECOVERY && event.reason === "reconcile_dead_work"));
  assert.ok(events.some((event) => event.event === EVENTS.RECOVER_COMMIT));

  const second = parseJsonResult(runReconcile(fixture));
  assert.equal(second.row, 1);
  assert.equal(second.state, STATES.REVIEW_PENDING);
});

test("reconcile row 4 leaves dispatched runs retryable when recover-commit fails", () => {
  const fixture = setupRepo({
    committedWork: true,
    ghState: { failPrList: "simulated pr list outage" },
  });
  writeLease(fixture, {
    pid: 999999,
    pgid: 999999,
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    timeoutS: 1,
  });

  const first = runReconcile(fixture);
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /pr_list_failed/);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.DISPATCHED);

  const second = runReconcile(fixture);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /pr_list_failed/);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.DISPATCHED);
});

test("reconcile row 4 preserves delayed-publication internal review policy", () => {
  const fixture = setupRepo({
    committedWork: true,
    publishPolicy: "after-internal-review",
  });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 4);
  assert.equal(result.status, "recovered");
  assert.equal(result.state, STATES.INTERNAL_REVIEW_PENDING);
  assert.equal(result.nextAction, "run_internal_review");
  assert.equal(result.recovery.prNumber, null);
  const manifest = readManifest(fixture.manifestPath).data;
  assert.equal(manifest.state, STATES.INTERNAL_REVIEW_PENDING);
  assert.equal(manifest.next_action, "run_internal_review");
  assert.equal(manifest.git.pr_number, null);
  assert.deepEqual(fs.readFileSync(fixture.ghLogPath, "utf-8").trim(), "");
});

test("reconcile row 4 with result file stamps execution evidence and passes preflight", () => {
  const fixture = setupRepo({
    committedWork: true,
    resultFile: true,
    executionEvidence: false,
  });
  const resultFile = path.join(fixture.runDir, "dispatch-result.txt");
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  assert.equal(fs.existsSync(evidencePath), false);

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 4);
  assert.equal(result.status, "recovered");
  assert.equal(result.executionEvidence.stamped, true);
  assert.equal(fs.existsSync(evidencePath), true);

  const recoveredHead = readManifest(fixture.manifestPath).data.git.head_sha;
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  const expected = buildExecutionEvidence({
    headSha: recoveredHead,
    testCommand: undefined,
    resultFilePath: resultFile,
    executor: "codex",
    recordedAt: evidence.recorded_at,
    testExitCode: 0,
  });
  assert.deepEqual(evidence, expected);
  assert.equal(evidence.recorded_by, "dispatch-orchestrator-v1");
  assert.equal(evidence.test_command, "unspecified");
  assert.equal(evidence.test_result_hash, hashFileSha256(resultFile));
  assert.equal(evidence.test_result_summary, "codex result.txt hashed");
  assert.equal(evidence.test_exit_code, 0);

  const preflight = buildExecutionEvidencePreflight({
    runDir: fixture.runDir,
    reviewedHead: recoveredHead,
  });
  assert.equal(preflight.status, "pass");
  assert.equal(preflight.qualityExecutionStatus, "pass");
  assert.equal(preflight.nextAction, "invoke_primary_reviewer");
});

test("reconcile row 4 without result file does not stamp execution evidence", () => {
  const fixture = setupRepo({
    committedWork: true,
    executionEvidence: false,
  });
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  assert.equal(fs.existsSync(evidencePath), false);

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 4);
  assert.equal(result.status, "recovered");
  assert.equal(result.executionEvidence, null);
  assert.equal(fs.existsSync(evidencePath), false);

  const recoveredHead = readManifest(fixture.manifestPath).data.git.head_sha;
  const preflight = buildExecutionEvidencePreflight({
    runDir: fixture.runDir,
    reviewedHead: recoveredHead,
  });
  assert.equal(preflight.status, "blocked");
  assert.equal(preflight.qualityExecutionStatus, "missing");
  assert.equal(preflight.nextAction, "repair_execution_evidence");
});

test("reconcile row 4 leaves pre-existing evidence at the recovered head untouched", () => {
  const fixture = setupRepo({
    committedWork: true,
    resultFile: true,
    executionEvidence: false,
  });
  const recoveredHead = execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  }).trim();
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  const existingEvidence = {
    schema_version: 1,
    head_sha: recoveredHead,
    test_command: "node --test tests/relay-dispatch/scripts/reconcile-run.test.js",
    test_result_hash: "a".repeat(64),
    test_result_summary: "operator-preserved evidence",
    test_exit_code: 0,
    recorded_at: "2026-07-10T00:00:00.000Z",
    recorded_by: "recover-commit-operator-v1",
  };
  const existingBytes = `${JSON.stringify(existingEvidence, null, 2)}\n`;
  fs.writeFileSync(evidencePath, existingBytes, "utf-8");

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 4);
  assert.equal(result.status, "recovered");
  assert.equal(result.executionEvidence.skipped, "evidence_already_bound");
  assert.equal(fs.readFileSync(evidencePath, "utf-8"), existingBytes);
});

test("reconcile row 5 treats an empty dispatch result as no completion evidence", () => {
  const fixture = setupRepo({ resultFile: true, resultFileContent: "" });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 5);
  assert.equal(result.status, "interrupted");
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.DISPATCHED);
});

test("reconcile ignores stale legacy result_file when Phase 2 dispatch result path exists", () => {
  const fixture = setupRepo({ oldShapePaths: true });
  const record = readManifest(fixture.manifestPath);
  const legacyResultFile = record.data.paths.result_file;
  try {
    fs.writeFileSync(legacyResultFile, "stale result from previous attempt\n", "utf-8");
    record.data.paths.dispatch_result = path.join(fixture.runDir, "dispatch-result.txt");
    writeManifest(fixture.manifestPath, record.data, record.body);

    const result = parseJsonResult(runReconcile(fixture));

    assert.equal(result.row, 5);
    assert.equal(result.status, "interrupted");
    assert.equal(readManifest(fixture.manifestPath).data.state, STATES.DISPATCHED);
    assert.deepEqual(fs.readFileSync(fixture.ghLogPath, "utf-8").trim(), "");
  } finally {
    fs.rmSync(legacyResultFile, { force: true });
  }
});

test("reconcile row 5 journals interrupted once for dead old-shape runs with no work", () => {
  const fixture = setupRepo({ oldShapePaths: true });

  const first = parseJsonResult(runReconcile(fixture));
  assert.equal(first.row, 5);
  assert.equal(first.status, "interrupted");
  assert.match(first.resumeCommand, /dispatch\.js --manifest/);
  const firstEvents = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(firstEvents.at(-1).event, EVENTS.DISPATCH_INTERRUPTED);
  assert.equal(firstEvents.at(-1).reason, "reconcile_dead_no_work");
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.DISPATCHED);

  const second = parseJsonResult(runReconcile(fixture));
  assert.equal(second.row, 5);
  const secondEvents = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(secondEvents.length, firstEvents.length);
});

test("reconcile dry-run reports the exact row and planned actions without mutation", () => {
  const fixture = setupRepo({ resultFile: true });

  const result = parseJsonResult(runReconcile(fixture, ["--dry-run"]));

  assert.equal(result.row, 4);
  assert.deepEqual(result.plannedActions, [
    "remove_lease_if_present",
    "transition_to_review_pending",
    "run_recover_commit_if_needed",
  ]);
  assert.equal(fs.existsSync(getEventsPath(fixture.repoRoot, fixture.runId)), false);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.DISPATCHED);
});

// --- Escalated-timeout salvage (row 6, #949) ---------------------------------

function remoteBranchSha(fixture) {
  const raw = execFileSync("git", ["ls-remote", "--heads", fixture.originRoot, fixture.branch], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  return raw ? raw.split(/\s+/)[0] : null;
}

function pushBranchToOrigin(fixture) {
  execFileSync("git", ["-C", fixture.worktreePath, "push", "origin", fixture.branch], {
    encoding: "utf-8",
    stdio: "pipe",
  });
}

function addLocalCommit(fixture, name) {
  fs.writeFileSync(path.join(fixture.worktreePath, name), `${name}\n`, "utf-8");
  execFileSync("git", ["-C", fixture.worktreePath, "add", name], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", fixture.worktreePath, "commit", "-m", `local ${name}`], { encoding: "utf-8", stdio: "pipe" });
  return execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
}

// A separate clone force-pushes a divergent commit to the branch, leaving the
// worktree's remote-tracking ref stale so --force-with-lease must reject.
function forcePushDivergentToOrigin(fixture) {
  const sidecar = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-reconcile-sidecar-")));
  execFileSync("git", ["clone", "--quiet", fixture.originRoot, sidecar], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", sidecar, "config", "user.name", "Sidecar"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", sidecar, "config", "user.email", "sidecar@example.com"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", sidecar, "checkout", fixture.branch], { encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(sidecar, "divergent.txt"), "divergent remote\n", "utf-8");
  execFileSync("git", ["-C", sidecar, "add", "divergent.txt"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", sidecar, "commit", "-m", "divergent remote commit"], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["-C", sidecar, "push", "--force", "origin", fixture.branch], { encoding: "utf-8", stdio: "pipe" });
  return execFileSync("git", ["-C", sidecar, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
}

test("reconcile salvages an escalated-timeout run with committed-but-unpushed work", () => {
  const fixture = setupRepo({
    manifestState: STATES.ESCALATED,
    committedWork: true,
    resultFile: true,
    resultFileContent: "", // 0-byte dispatch result must not block the salvage
    dispatchResultFailureClass: "total_timeout",
  });
  const leasePath = writeLease(fixture, {
    pid: 999999,
    pgid: 999999,
    startedAt: new Date().toISOString(),
    timeoutS: 60,
  });
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 6);
  assert.equal(result.rowName, "salvage_committed_unpushed");
  assert.equal(result.status, "salvaged");
  assert.notEqual(result.row, 1);
  assert.equal(result.state, STATES.REVIEW_PENDING);
  assert.equal(result.forceWithLease, true);
  assert.ok(result.unpushedCommits >= 1);
  assert.equal(result.executionEvidence.rebranded, true);

  // Real remote ref: the force-with-lease push landed the committed HEAD on origin.
  assert.equal(remoteBranchSha(fixture), fixture.committedHead);
  // Stale non-live lease removed.
  assert.equal(fs.existsSync(leasePath), false);

  // Manifest recovered to review_pending, with the audit reason recorded.
  const manifest = readManifest(fixture.manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.next_action, "run_review");
  assert.equal(manifest.git.head_sha, fixture.committedHead);
  assert.equal(manifest.last_force.to_state, STATES.REVIEW_PENDING);
  assert.match(manifest.last_force.reason, /salvaged committed-unpushed/);

  // Evidence rebound to the salvaged HEAD (existing placeholder rebranded).
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  assert.equal(evidence.head_sha, fixture.committedHead);
  assert.equal(evidence.recorded_by, "reconcile-salvage-rebrand");

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  const recovery = events.find((event) => event.event === EVENTS.STATE_RECOVERY);
  assert.ok(recovery);
  assert.equal(recovery.state_from, STATES.ESCALATED);
  assert.equal(recovery.state_to, STATES.REVIEW_PENDING);
  assert.match(recovery.reason, /salvaged committed-unpushed/);
});

test("reconcile salvage stamps operator-verified evidence from --test-result-file", () => {
  const fixture = setupRepo({
    manifestState: STATES.ESCALATED,
    committedWork: true,
    dispatchResultFailureClass: "total_timeout",
    executionEvidence: false,
  });
  const resultFile = path.join(fixture.runDir, "operator-tests.txt");
  fs.writeFileSync(resultFile, "PASS: 42 targeted tests\n", "utf-8");
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);

  const result = parseJsonResult(runReconcile(fixture, ["--test-result-file", resultFile]));

  assert.equal(result.row, 6);
  assert.equal(result.status, "salvaged");
  assert.equal(result.executionEvidence.verified, true);
  assert.equal(result.executionEvidence.recordedBy, "reconcile-salvage-operator-v1");
  assert.equal(remoteBranchSha(fixture), fixture.committedHead);

  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  assert.equal(evidence.head_sha, fixture.committedHead);
  assert.equal(evidence.recorded_by, "reconcile-salvage-operator-v1");
  assert.equal(evidence.test_result_hash, hashFileSha256(resultFile));
  assert.equal(evidence.test_exit_code, 0);

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.ok(events.some((event) => event.event === EVENTS.OPERATOR_EXECUTION_EVIDENCE));
});

test("reconcile surfaces an escalated-timeout run with a dirty worktree instead of salvaging", () => {
  const fixture = setupRepo({
    manifestState: STATES.ESCALATED,
    committedWork: true,
    dispatchResultFailureClass: "total_timeout",
  });
  fs.writeFileSync(path.join(fixture.worktreePath, "dirty.txt"), "uncommitted change\n", "utf-8");

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 6);
  assert.equal(result.status, "dirty_surfaced");
  assert.equal(result.hasReviewableDirt, true);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.ESCALATED);
  assert.equal(remoteBranchSha(fixture), null);
});

test("reconcile refuses to salvage an escalated-timeout run while the supervisor lease is live", async (t) => {
  const fixture = setupRepo({
    manifestState: STATES.ESCALATED,
    committedWork: true,
    dispatchResultFailureClass: "total_timeout",
  });
  const child = await spawnSleeper(t);
  const leasePath = writeLease(fixture, {
    pid: child.pid,
    pgid: child.pid,
    startedAt: new Date().toISOString(),
    timeoutS: 60,
  });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 6);
  assert.equal(result.status, "still_owned");
  assert.equal(fs.existsSync(leasePath), true);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.ESCALATED);
  assert.equal(remoteBranchSha(fixture), null);
  assert.equal(isPgidAlive(child.pid), true);
});

test("reconcile dry-run prints the salvage plan without mutating", () => {
  const fixture = setupRepo({
    manifestState: STATES.ESCALATED,
    committedWork: true,
    dispatchResultFailureClass: "total_timeout",
  });
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  const evidenceBefore = fs.readFileSync(evidencePath, "utf-8");

  const result = parseJsonResult(runReconcile(fixture, ["--dry-run"]));

  assert.equal(result.row, 6);
  assert.equal(result.status, "dry_run");
  assert.equal(result.pushTarget, `origin/${fixture.branch}`);
  assert.equal(result.forceWithLease, true);
  assert.equal(result.targetState, STATES.REVIEW_PENDING);
  assert.equal(result.evidenceVerified, false);
  assert.deepEqual(result.plannedActions, [
    `push_force_with_lease:origin/${fixture.branch}`,
    "remove_lease_if_present",
    "write_replaceable_placeholder_evidence",
    "force_transition_escalated_to_review_pending",
  ]);
  // No push, no state change, no evidence write.
  assert.equal(remoteBranchSha(fixture), null);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.ESCALATED);
  assert.equal(fs.readFileSync(evidencePath, "utf-8"), evidenceBefore);
});

test("reconcile surfaces an escalated-timeout salvage when the remote moved beyond the lease", () => {
  const fixture = setupRepo({
    manifestState: STATES.ESCALATED,
    committedWork: true,
    dispatchResultFailureClass: "total_timeout",
  });
  // Publish once (stale remote-tracking ref), advance locally so there is something
  // to push, then let a third party force-push a divergent commit we never fetched.
  pushBranchToOrigin(fixture);
  addLocalCommit(fixture, "local-extra.txt");
  const divergentHead = forcePushDivergentToOrigin(fixture);
  assert.equal(remoteBranchSha(fixture), divergentHead);

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 6);
  assert.equal(result.status, "push_rejected");
  assert.equal(result.forceWithLeaseRejected, true);
  // Remote not overwritten; manifest not transitioned.
  assert.equal(remoteBranchSha(fixture), divergentHead);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.ESCALATED);
});

test("reconcile leaves a non-timeout escalated run at the row 1 noop", () => {
  const fixture = setupRepo({
    manifestState: STATES.ESCALATED,
    committedWork: true,
    dispatchResultFailureClass: "no_result",
  });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 1);
  assert.equal(result.status, "noop");
  assert.equal(result.state, STATES.ESCALATED);
  assert.equal(remoteBranchSha(fixture), null);
});

test("reconcile leaves an escalated-timeout run with nothing to salvage at the row 1 noop", () => {
  const fixture = setupRepo({
    manifestState: STATES.ESCALATED,
    committedWork: false,
    dispatchResultFailureClass: "total_timeout",
  });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 1);
  assert.equal(result.status, "noop");
  assert.equal(result.state, STATES.ESCALATED);
  assert.equal(remoteBranchSha(fixture), null);
});

test("reconcile blocks escalated-timeout salvage when reviewer_swap_count invariant rejects", () => {
  const fixture = setupRepo({
    manifestState: STATES.ESCALATED,
    committedWork: true,
    dispatchResultFailureClass: "total_timeout",
    executionEvidence: false,
  });
  const record = readManifest(fixture.manifestPath);
  record.data.review = { ...(record.data.review || {}), reviewer_swap_count: 1 };
  writeManifest(fixture.manifestPath, record.data, record.body);

  const leasePath = writeLease(fixture, {
    pid: 999999,
    pgid: 999999,
    startedAt: new Date().toISOString(),
    timeoutS: 60,
  });
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  const remoteBefore = remoteBranchSha(fixture);

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 6);
  assert.equal(result.status, "invariant_blocked");
  assert.equal(result.nextAction, "manual_close_run");
  assert.ok(result.invariantError && result.invariantError.length > 0);
  assert.match(result.invariantError, /reviewer_swap_count/);

  // No side effects: remote ref, lease, evidence, and manifest all untouched.
  assert.equal(remoteBranchSha(fixture), remoteBefore);
  assert.equal(fs.existsSync(leasePath), true);
  assert.equal(fs.existsSync(evidencePath), false);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.ESCALATED);

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(events.some((event) => event.event === EVENTS.STATE_RECOVERY), false);
});

test("reconcile dry-run reports invariant_blocked without side effects when swap count rejects", () => {
  const fixture = setupRepo({
    manifestState: STATES.ESCALATED,
    committedWork: true,
    dispatchResultFailureClass: "total_timeout",
    executionEvidence: false,
  });
  const record = readManifest(fixture.manifestPath);
  record.data.review = { ...(record.data.review || {}), reviewer_swap_count: 1 };
  writeManifest(fixture.manifestPath, record.data, record.body);

  const leasePath = writeLease(fixture, {
    pid: 999999,
    pgid: 999999,
    startedAt: new Date().toISOString(),
    timeoutS: 60,
  });
  const evidencePath = path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME);
  const remoteBefore = remoteBranchSha(fixture);

  const result = parseJsonResult(runReconcile(fixture, ["--dry-run"]));

  assert.equal(result.row, 6);
  assert.equal(result.status, "invariant_blocked");
  assert.equal(result.nextAction, "manual_close_run");
  assert.ok(result.invariantError && result.invariantError.length > 0);

  assert.equal(remoteBranchSha(fixture), remoteBefore);
  assert.equal(fs.existsSync(leasePath), true);
  assert.equal(fs.existsSync(evidencePath), false);
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.ESCALATED);
});
