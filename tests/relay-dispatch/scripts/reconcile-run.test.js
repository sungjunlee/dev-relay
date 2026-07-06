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
const { EVENTS, readRunEvents } = require("../../../skills/relay-dispatch/scripts/relay-events");
const { EXECUTION_EVIDENCE_FILENAME } = require("../../../skills/relay-dispatch/scripts/execution-evidence");

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

  if (committedWork) {
    fs.writeFileSync(path.join(worktreePath, "reconciled.txt"), "committed before crash\n", "utf-8");
    execFileSync("git", ["-C", worktreePath, "add", "reconciled.txt"], { encoding: "utf-8", stdio: "pipe" });
    execFileSync("git", ["-C", worktreePath, "commit", "-m", "Executor work before crash"], { encoding: "utf-8", stdio: "pipe" });
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
  fs.writeFileSync(path.join(layout.runDir, EXECUTION_EVIDENCE_FILENAME), JSON.stringify({
    schema_version: 1,
    head_sha: dispatchHead,
    test_command: "node --test tests/relay-dispatch/scripts/*.test.js",
    test_result_hash: "unspecified",
    test_result_summary: "unspecified",
    recorded_at: "2026-05-01T01:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  }, null, 2));

  const ghPath = writeFakeGh(binDir, statePath, ghLogPath, ghState);
  const env = {
    ...process.env,
    RELAY_HOME: relayHome,
    RELAY_GH_BIN: ghPath,
    RELAY_TEST_GH_STATE: statePath,
    RELAY_TEST_GH_LOG: ghLogPath,
  };
  return { repoRoot, relayHome, runId, manifestPath: layout.manifestPath, runDir: layout.runDir, worktreePath, branch, statePath, ghLogPath, env };
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

test("reconcile row 2 reports a live lease within timeout", async (t) => {
  const fixture = setupRepo();
  const child = await spawnSleeper(t);
  const leasePath = writeLease(fixture, {
    pgid: child.pid,
    startedAt: new Date().toISOString(),
    timeoutS: 60,
  });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 2);
  assert.equal(result.status, "running");
  assert.equal(result.lease.pgid, child.pid);
  assert.ok(result.remaining_s > 0);
  assert.equal(fs.existsSync(leasePath), true);
  assert.equal(isPgidAlive(child.pid), true);
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

test("reconcile row 4 recovers dead runs with committed work via recover-commit", () => {
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

test("reconcile row 5 treats an empty dispatch result as no completion evidence", () => {
  const fixture = setupRepo({ resultFile: true, resultFileContent: "" });

  const result = parseJsonResult(runReconcile(fixture));

  assert.equal(result.row, 5);
  assert.equal(result.status, "interrupted");
  assert.equal(readManifest(fixture.manifestPath).data.state, STATES.DISPATCHED);
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
