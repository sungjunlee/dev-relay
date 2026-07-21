const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RELAY_FLEET_SCRIPT = path.join(REPO_ROOT, "skills", "relay-fleet", "scripts", "relay-fleet.js");
const REAL_DISPATCH_SCRIPT = path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "dispatch.js");
const TEST_OWNERSHIP = Object.freeze({
  sprint: "backlog/sprints/2026-07-relay-fleet.md",
  track: "2026-07-relay-fleet",
  component: "relay-fleet",
});

const {
  buildRedispatchArgs,
  getFleetLeafReplacementPath,
  getFleetLeavesStorePath,
  getFleetRuntimePath,
  reconcileFleet,
} = require(RELAY_FLEET_SCRIPT);
const {
  getFleetsDir,
  getFleetIssueLockPath,
  getFleetManifestPath,
  getManifestPath,
  getRunDir,
} = require("../../../skills/relay-dispatch/scripts/manifest/paths");
const {
  acquireManifestLock,
  createManifestSkeleton,
  readManifest,
  releaseManifestLock,
  writeManifest,
  writeManifestUnlocked,
} = require("../../../skills/relay-dispatch/scripts/manifest/store");
const {
  STATES: RUN_STATES,
  updateManifestState,
} = require("../../../skills/relay-dispatch/scripts/manifest/lifecycle");
const {
  DISPATCH_STATUS,
  STATES: FLEET_STATES,
  acquireIssueLock,
  createFleetManifest,
  readFleetManifest,
  releaseIssueLock,
  updateFleetManifest,
  updateFleetState,
} = require("../../../skills/relay-dispatch/scripts/manifest/fleet");
const {
  getRequestPath,
  persistRequestContract,
} = require("../../../skills/relay-ready/scripts/relay-request");
const { readManifestOwnership } = require("../../../skills/relay-merge/scripts/sprint-owner");
const { writeFakeSprintStateBinary } = require("../../relay-dispatch/scripts/test-support");

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Fleet Skill Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-fleet-skill@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  const sprintPath = path.join(repoRoot, TEST_OWNERSHIP.sprint);
  fs.mkdirSync(path.dirname(sprintPath), { recursive: true });
  fs.writeFileSync(sprintPath, "# Relay fleet sprint fixture\n", "utf-8");
  execFileSync("git", ["add", "README.md", TEST_OWNERSHIP.sprint], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
}

function setupRepo(prefix = "relay-fleet-skill-") {
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  process.env.RELAY_HOME = relayHome;
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  initGitRepo(repoRoot);
  const sprintStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-sprint-state-"));
  const sprintStateLog = path.join(sprintStateDir, "invocations.jsonl");
  const sprintStateBin = writeFakeSprintStateBinary(sprintStateDir, {
    invocationLog: sprintStateLog,
  });
  process.env.RELAY_SPRINT_STATE_BIN = sprintStateBin;
  return { relayHome, repoRoot, sprintStateBin, sprintStateLog };
}

function addBareOrigin(repoRoot) {
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-origin-"));
  execFileSync("git", ["init", "--bare", remoteRoot], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteRoot], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return remoteRoot;
}

function writeRealDispatchTestBins(binDir) {
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
if (args[0] !== "exec") {
  process.stderr.write("unsupported fake codex invocation\\n");
  process.exit(1);
}
const cwd = args[args.indexOf("-C") + 1];
const output = args[args.indexOf("-o") + 1];
const fileName = fs.existsSync(path.join(cwd, "first.txt")) ? "resume.txt" : "first.txt";
fs.writeFileSync(path.join(cwd, fileName), fileName + "\\n", "utf-8");
execFileSync("git", ["-C", cwd, "add", fileName], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "fake " + fileName], { stdio: "pipe" });
fs.writeFileSync(output, "ok\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);

  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "list") process.exit(0);
if (args[0] === "pr" && args[1] === "create") {
  process.stdout.write("https://example.test/acme/dev-relay/pull/957\\n");
  process.exit(0);
}
process.stderr.write("unexpected fake gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function makeLeaf(repoRoot, index, overrides = {}) {
  const leafRef = overrides.leaf_ref || `leaf-${String(index).padStart(2, "0")}`;
  const issueNumber = overrides.issue_number || (480 + index);
  const promptFile = path.join(repoRoot, `${leafRef}.prompt.md`);
  const rubricFile = path.join(repoRoot, `${leafRef}.rubric.yaml`);
  const doneCriteriaFile = path.join(repoRoot, `${leafRef}.done.md`);
  fs.writeFileSync(promptFile, `Implement ${leafRef}\n`, "utf-8");
  fs.writeFileSync(rubricFile, "rubric:\n  size_class: S\n", "utf-8");
  fs.writeFileSync(doneCriteriaFile, `Done criteria for ${leafRef}\n`, "utf-8");
  return {
    leaf_ref: leafRef,
    issue_number: issueNumber,
    branch: `issue-${issueNumber}-${leafRef}`,
    prompt_file: promptFile,
    rubric_file: rubricFile,
    done_criteria_file: doneCriteriaFile,
    ownership: TEST_OWNERSHIP,
    // No default request_id: leaves without one are exempt from the
    // relay-ready lineage check (validateLeafLineage). Tests that exercise
    // lineage pass their own request_id explicitly, backed by a real
    // persisted request artifact via persistFixtureRequest below.
    leaf_id: overrides.leaf_id || leafRef,
    ...overrides,
  };
}

// Persists a real single-leaf relay-ready request artifact so fleet leaves can
// reference a request_id/leaf_id pair that validateLeafLineage will resolve.
function persistFixtureRequest(repoRoot, requestId, leafId) {
  persistRequestContract(repoRoot, {
    source: { kind: "manual" },
    request_text: `Fixture request for ${leafId}`,
    handoff: {
      leaf_id: leafId,
      title: `Fixture leaf ${leafId}`,
      goal: `Implement ${leafId}`,
      done_criteria_markdown: `- ${leafId} is done`,
    },
  }, { requestId });
  return getRequestPath(repoRoot, requestId);
}

function writeLeavesFile(repoRoot, leaves) {
  const leavesFile = path.join(repoRoot, "fleet-leaves.json");
  writeJson(leavesFile, { leaves });
  return leavesFile;
}

function writePersistedFleetLeaves(repoRoot, fleetId, leaves) {
  writeJson(getFleetLeavesStorePath(repoRoot, fleetId), { fleet_id: fleetId, leaves });
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

test("buildRedispatchArgs pairs immutable fleet ID with typed ownership", () => {
  const { repoRoot } = setupRepo("relay-fleet-redispatch-owner-args-");
  const fleetId = "fleet-957-redispatch-owner";
  const args = buildRedispatchArgs({
    repoRoot,
    fleetId,
    runId: "issue-957-20260721010101000-a1b2c3d4",
    leaf: { leaf_ref: "leaf-a", ownership: TEST_OWNERSHIP },
    options: { dispatchScript: "/dispatch.js" },
  });

  assert.equal(flagValue(args, "--fleet-id"), fleetId);
  assert.deepEqual(JSON.parse(flagValue(args, "--ownership-json")), TEST_OWNERSHIP);
});

test("buildRedispatchArgs forwards leaf timeout, executor, and sandbox overrides", () => {
  const { repoRoot } = setupRepo("relay-fleet-redispatch-leaf-args-");
  const args = buildRedispatchArgs({
    repoRoot,
    fleetId: "fleet-redispatch-leaf-args",
    runId: "issue-908-20260713010101000-a1b2c3d4",
    leaf: { leaf_ref: "leaf-a", ownership: TEST_OWNERSHIP, timeout: "5400", executor: "codex", sandbox: "workspace-write" },
    options: {
      dispatchScript: "/dispatch.js",
      executor: "claude",
      sandbox: "danger-full-access",
    },
  });

  assert.equal(flagValue(args, "--timeout"), "5400");
  assert.equal(flagValue(args, "--executor"), "codex");
  assert.equal(flagValue(args, "--sandbox"), "workspace-write");
});

test("buildRedispatchArgs prefers a leaf timeout over the fleet timeout", () => {
  const { repoRoot } = setupRepo("relay-fleet-redispatch-timeout-precedence-");
  const args = buildRedispatchArgs({
    repoRoot,
    fleetId: "fleet-redispatch-timeout-precedence",
    runId: "issue-908-20260713010101000-a1b2c3d4",
    leaf: { leaf_ref: "leaf-a", ownership: TEST_OWNERSHIP, timeout: "5400" },
    options: { dispatchScript: "/dispatch.js", timeout: "1800" },
  });

  assert.equal(flagValue(args, "--timeout"), "5400");
});

test("buildRedispatchArgs omits timeout when neither leaf nor fleet defines it", () => {
  const { repoRoot } = setupRepo("relay-fleet-redispatch-timeout-omitted-");
  const args = buildRedispatchArgs({
    repoRoot,
    fleetId: "fleet-redispatch-timeout-omitted",
    runId: "issue-908-20260713010101000-a1b2c3d4",
    leaf: { leaf_ref: "leaf-a", ownership: TEST_OWNERSHIP },
    options: { dispatchScript: "/dispatch.js" },
  });

  assert.equal(args.includes("--timeout"), false);
});

test("buildRedispatchArgs mirrors leaf register on redispatch", () => {
  const { repoRoot } = setupRepo("relay-fleet-redispatch-register-");
  const args = buildRedispatchArgs({
    repoRoot,
    fleetId: "fleet-redispatch-register",
    runId: "issue-908-20260713010101000-a1b2c3d4",
    leaf: { leaf_ref: "leaf-a", ownership: TEST_OWNERSHIP, register: true },
    options: { dispatchScript: "/dispatch.js", register: false },
  });

  assert.equal(args.includes("--register"), true);
});

function advanceFleetManifestState(repoRoot, fleetId, targetState) {
  const transitionPath = [
    FLEET_STATES.DRAFT,
    FLEET_STATES.DISPATCHING,
    FLEET_STATES.DISPATCHED,
    FLEET_STATES.REVIEWING,
    FLEET_STATES.MERGING,
    FLEET_STATES.CLOSED,
  ];
  const currentState = readFleetManifest(repoRoot, fleetId).data.fleet_state;
  const currentIndex = transitionPath.indexOf(currentState);
  const targetIndex = transitionPath.indexOf(targetState);
  if (currentIndex === -1 || targetIndex === -1 || currentIndex > targetIndex) {
    throw new Error(`Cannot advance fleet fixture state: ${currentState} -> ${targetState}`);
  }
  for (const nextState of transitionPath.slice(currentIndex + 1, targetIndex + 1)) {
    updateFleetManifest(repoRoot, fleetId, (fleet) => updateFleetState(fleet, nextState));
  }
  return readFleetManifest(repoRoot, fleetId).data;
}

function writeFleetUpdatedAt(repoRoot, fleetId, updatedAt) {
  const record = readFleetManifest(repoRoot, fleetId);
  writeManifest(record.manifestPath, {
    ...record.data,
    timestamps: {
      ...record.data.timestamps,
      updated_at: updatedAt,
    },
  }, record.body);
}

function writeChildRun(repoRoot, {
  runId,
  branch,
  issueNumber,
  leafId,
  fleetId,
  ownership = TEST_OWNERSHIP,
  state = RUN_STATES.REVIEW_PENDING,
}) {
  fs.mkdirSync(getRunDir(repoRoot, runId), { recursive: true });
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber,
    worktreePath: path.join(repoRoot, "wt", runId),
    fleetId,
    leafId,
    ownership,
  });
  const rubricPath = path.join(getRunDir(repoRoot, runId), "rubric.yaml");
  fs.writeFileSync(rubricPath, "rubric:\n  size_class: S\n", "utf-8");
  manifest = {
    ...manifest,
    anchor: {
      ...(manifest.anchor || {}),
      rubric_path: "rubric.yaml",
    },
  };
  manifest = updateManifestState(manifest, RUN_STATES.DISPATCHED, "await_dispatch_result");
  if (state === RUN_STATES.REVIEW_PENDING) {
    manifest = updateManifestState(manifest, RUN_STATES.REVIEW_PENDING, "await_review");
  } else if (state === RUN_STATES.READY_TO_MERGE) {
    manifest = updateManifestState(manifest, RUN_STATES.REVIEW_PENDING, "await_review");
    manifest = updateManifestState(manifest, RUN_STATES.READY_TO_MERGE, "ready");
  } else if (state === RUN_STATES.ESCALATED) {
    manifest = updateManifestState(manifest, RUN_STATES.ESCALATED, "escalated");
  } else if (state === RUN_STATES.CLOSED) {
    manifest = updateManifestState(manifest, RUN_STATES.CLOSED, "closed");
  }
  writeManifest(getManifestPath(repoRoot, runId), manifest);
  return runId;
}

function writeRunLeaseFixture(repoRoot, runId, {
  pid = process.pid,
  host = os.hostname(),
  startedAt = new Date().toISOString(),
  timeoutS = 3600,
} = {}) {
  writeJson(path.join(getRunDir(repoRoot, runId), "lease.json"), {
    pid,
    pgid: 2147483647,
    host,
    started_at: startedAt,
    timeout_s: timeoutS,
  });
}

function writeDispatchLogs(repoRoot, runId, { stdout = null, stderr = null } = {}) {
  const runDir = getRunDir(repoRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  if (stdout !== null) {
    fs.writeFileSync(path.join(runDir, "dispatch-stdout.log"), stdout, "utf-8");
  }
  if (stderr !== null) {
    fs.writeFileSync(path.join(runDir, "dispatch-stderr.log"), stderr, "utf-8");
  }
}

function waitFor(predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch {}
      if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function captureChildResult(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
  return new Promise((resolve) => {
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function writeReadMarkerPreload(tmpDir) {
  const preloadPath = path.join(tmpDir, "mark-read.js");
  fs.writeFileSync(preloadPath, `const fs = require("node:fs");
const path = require("node:path");
const originalReadFileSync = fs.readFileSync;

fs.readFileSync = function readFileSyncWithMarker(filePath) {
  const result = originalReadFileSync.apply(this, arguments);
  const watchedPath = process.env.RELAY_FLEET_MARK_READ_PATH;
  const markerPath = process.env.RELAY_FLEET_READ_MARKER_PATH;
  if (watchedPath && markerPath && path.resolve(String(filePath)) === path.resolve(watchedPath)) {
    fs.writeFileSync(markerPath, "read\\n", "utf-8");
  }
  return result;
};
`, "utf-8");
  return preloadPath;
}

function holdFleetChildLock(repoRoot, fleetId) {
  const lockPath = path.join(getFleetsDir(repoRoot), "locks", `fleet-${fleetId}-children.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  writeJson(lockPath, {
    fleet_id: fleetId,
    pid: process.pid,
    hostname: os.hostname(),
    acquired_at: new Date().toISOString(),
  });
  return lockPath;
}

function writeFleetChildLockWorker(tmpDir) {
  const workerPath = path.join(tmpDir, "fleet-child-lock-worker.js");
  fs.writeFileSync(workerPath, `const fs = require("node:fs");
const { withFleetChildLock } = require(process.env.RELAY_FLEET_SCRIPT);
const waitArray = new Int32Array(new SharedArrayBuffer(4));
const owner = String(process.pid);

withFleetChildLock(process.env.RELAY_FLEET_REPO, process.env.RELAY_FLEET_ID, () => {
  let ownsMarker = false;
  try {
    fs.writeFileSync(process.env.RELAY_FLEET_ACTIVE_MARKER, owner, { flag: "wx" });
    ownsMarker = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    fs.appendFileSync(process.env.RELAY_FLEET_OVERLAP_LOG, owner + "\\n", "utf-8");
  }
  Atomics.wait(waitArray, 0, 0, Number(process.env.RELAY_FLEET_HOLD_MS || 800));
  if (ownsMarker) {
    try {
      if (fs.readFileSync(process.env.RELAY_FLEET_ACTIVE_MARKER, "utf-8") === owner) {
        fs.unlinkSync(process.env.RELAY_FLEET_ACTIVE_MARKER);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
});
`, "utf-8");
  return workerPath;
}

function runFleet(args, { relayHome, env = {}, timeout = 30000 } = {}) {
  const result = spawnSync(process.execPath, [RELAY_FLEET_SCRIPT, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
      RELAY_SOURCE_ROOT: REPO_ROOT,
      ...env,
    },
    timeout,
  });
  return result;
}

function writeFakeDispatchScript(tmpDir) {
  const scriptPath = path.join(tmpDir, "fake-dispatch.js");
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const sourceRoot = process.env.RELAY_SOURCE_ROOT;
const {
  getManifestPath,
  getRunDir,
} = require(path.join(sourceRoot, "skills", "relay-dispatch", "scripts", "manifest", "paths"));
const {
  createManifestSkeleton,
  readManifest,
  writeManifest,
} = require(path.join(sourceRoot, "skills", "relay-dispatch", "scripts", "manifest", "store"));
const {
  STATES,
  updateManifestState,
} = require(path.join(sourceRoot, "skills", "relay-dispatch", "scripts", "manifest", "lifecycle"));
const {
  acquireIssueLock,
  releaseIssueLock,
} = require(path.join(sourceRoot, "skills", "relay-dispatch", "scripts", "manifest", "fleet"));

const args = process.argv.slice(2);
const repoRoot = args[0];
function get(flag, fallback = null) {
  const flags = Array.isArray(flag) ? flag : [flag];
  for (const item of flags) {
    const index = args.indexOf(item);
    if (index !== -1) return args[index + 1] || fallback;
  }
  return fallback;
}
function has(flag) {
  return args.includes(flag);
}
function issueFromBranch(branch) {
  const match = String(branch || "").match(/issue-(\\d+)/);
  return match ? Number(match[1]) : null;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function appendLog(record) {
  if (!process.env.FAKE_DISPATCH_LOG) return;
  fs.appendFileSync(process.env.FAKE_DISPATCH_LOG, JSON.stringify({
    ...record,
    detachedChild: process.env.FAKE_DETACHED_CHILD === "1",
  }) + "\\n", "utf-8");
}
function transitionFromDispatched(manifest, state) {
  if (state === "review_pending") {
    return updateManifestState(manifest, STATES.REVIEW_PENDING, "await_review");
  }
  if (state === "escalated") {
    return updateManifestState(manifest, STATES.ESCALATED, "fleet_fake_escalated");
  }
  if (state === "closed") {
    return updateManifestState(manifest, STATES.CLOSED, "fleet_fake_closed");
  }
  return manifest;
}
async function main() {
  const manifestInput = get("--manifest");
  const branch = get(["--branch", "-b"]);
  const leafId = get("--leaf-id");
  const fleetId = get("--fleet-id");
  const ownership = JSON.parse(get("--ownership-json"));
  const dryRun = has("--dry-run");
  const config = process.env.FAKE_DISPATCH_CONFIG
    ? JSON.parse(fs.readFileSync(process.env.FAKE_DISPATCH_CONFIG, "utf-8"))
    : {};
  if (manifestInput) {
    const record = readManifest(manifestInput);
    const runId = record.data.run_id;
    const plan = config[runId] || {};
    appendLog({ event: "spawn", runId, manifest: manifestInput, dryRun, args });
    if (plan.delay_after_manifest_ms) {
      await sleep(plan.delay_after_manifest_ms);
    }
    if (plan.exit_code && plan.exit_code !== 0) {
      process.stderr.write("fake resume dispatch failure\\n");
      process.exit(plan.exit_code);
    }
    let manifest = updateManifestState(record.data, STATES.DISPATCHED, "fleet_fake_redispatch");
    if (plan.run_state !== "dispatched") {
      manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "await_review");
    }
    writeManifest(manifestInput, manifest, record.body);
    process.stdout.write(JSON.stringify({
      status: "ok",
      runId,
      manifestPath: manifestInput,
      fleetId: record.data.fleet_id || null,
    }) + "\\n");
    return;
  }
  const plan = config[branch] || {};
  const issueNumber = issueFromBranch(branch);
  const runId = plan.run_id || \`issue-\${issueNumber}-2026051401010\${String(Math.abs(branch.length) % 10)}000-a1b2c3d4\`;
  const manifestPath = getManifestPath(repoRoot, runId);
  const runDir = getRunDir(repoRoot, runId);
  appendLog({ event: "spawn", branch, leafId, fleetId, dryRun, args });
  if (has("--detach") && plan.fail_before_manifest) {
    if (plan.json_failure_error) {
      process.stdout.write(JSON.stringify({
        status: "failed",
        error: plan.json_failure_error,
      }) + "\\n");
    } else {
      process.stderr.write(plan.stderr || plan.fail_before_manifest_stderr || "fake pre-manifest failure\\n");
    }
    process.exit(plan.exit_code || 17);
  }
  if (has("--detach") && process.env.FAKE_DETACHED_CHILD !== "1" && plan.fail_parent_after_run_id) {
    process.stdout.write(JSON.stringify({
      status: "detached",
      runId,
      manifestPath,
      runDir,
      fleetId,
      ownership,
      branch,
      ...(plan.json_failure_error ? { error: plan.json_failure_error } : {}),
    }) + "\\n");
    if (plan.stderr || !plan.json_failure_error) {
      process.stderr.write(plan.stderr || "fake parent dispatch failure after run id\\n");
    }
    process.exit(plan.exit_code || 17);
  }
  if (has("--detach") && process.env.FAKE_DETACHED_CHILD !== "1") {
    const childArgs = process.argv.slice(1).filter((arg) => arg !== "--detach");
    const child = spawn(process.execPath, childArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FAKE_DETACHED_CHILD: "1",
      },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    process.stdout.write(JSON.stringify({
      status: "detached",
      runId,
      manifestPath,
      runDir,
      stdoutLog: path.join(runDir, "dispatch-stdout.log"),
      stderrLog: path.join(runDir, "dispatch-stderr.log"),
      supervisorPid: child.pid,
      reconcileCommand: \`node skills/relay-dispatch/scripts/reconcile-run.js --repo . --run-id \${runId}\`,
    }) + "\\n");
    return;
  }
  if (plan.delay_before_manifest_ms) {
    await sleep(plan.delay_before_manifest_ms);
  }
  if (plan.fail_before_manifest) {
    if (plan.json_failure_error) {
      process.stdout.write(JSON.stringify({
        status: "failed",
        error: plan.json_failure_error,
      }) + "\\n");
    } else {
      process.stderr.write(plan.stderr || plan.fail_before_manifest_stderr || "fake pre-manifest failure\\n");
    }
    process.exit(plan.exit_code || 17);
  }
  if (!dryRun && plan.create_manifest !== false) {
    fs.mkdirSync(runDir, { recursive: true });
    let manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch,
      baseBranch: "main",
      issueNumber,
      worktreePath: path.join(repoRoot, "worktrees", branch),
      executor: "fake",
      requestId: get("--request-id"),
      leafId,
      doneCriteriaPath: get("--done-criteria-file"),
      fleetId,
      ownership,
    });
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\\n  size_class: S\\n", "utf-8");
    manifest = {
      ...manifest,
      anchor: {
        ...(manifest.anchor || {}),
        rubric_path: "rubric.yaml",
      },
    };
    manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
    if (plan.run_state !== "dispatched") {
      manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "await_review");
    }
    writeManifest(manifestPath, manifest);
  }
  let lock = null;
  if (plan.hold_issue_lock_ms) {
    lock = acquireIssueLock({ repoRoot, issueNumber, fleetId, runId });
    await sleep(plan.hold_issue_lock_ms);
  }
  if (plan.delay_after_manifest_ms) {
    await sleep(plan.delay_after_manifest_ms);
  }
  if (plan.transition_after_delay_to && fs.existsSync(manifestPath)) {
    const record = readManifest(manifestPath);
    if (record.data.state === STATES.DISPATCHED) {
      writeManifest(manifestPath, transitionFromDispatched(record.data, plan.transition_after_delay_to), record.body);
    }
  }
  if (lock) releaseIssueLock(lock);
  if (plan.exit_code && plan.exit_code !== 0) {
    process.stderr.write("fake dispatch failure after manifest\\n");
    process.exit(plan.exit_code);
  }
  process.stdout.write(JSON.stringify({
    status: dryRun ? "dry-run" : "ok",
    runId,
    manifestPath,
    runDir,
    fleetId,
    branch,
  }) + "\\n");
}
main().catch((error) => {
  process.stderr.write(String(error.stack || error.message || error) + "\\n");
  process.exit(1);
});
`, "utf-8");
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeFakeReviewScript(tmpDir) {
  const scriptPath = path.join(tmpDir, "fake-review.js");
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const sourceRoot = process.env.RELAY_SOURCE_ROOT;
const {
  getManifestPath,
} = require(path.join(sourceRoot, "skills", "relay-dispatch", "scripts", "manifest", "paths"));
const {
  readManifest,
  writeManifest,
} = require(path.join(sourceRoot, "skills", "relay-dispatch", "scripts", "manifest", "store"));
const {
  STATES,
  updateManifestState,
} = require(path.join(sourceRoot, "skills", "relay-dispatch", "scripts", "manifest", "lifecycle"));

const args = process.argv.slice(2);
function get(flag, fallback = null) {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] || fallback);
}
function appendLog(record) {
  if (!process.env.FAKE_REVIEW_LOG) return;
  fs.appendFileSync(process.env.FAKE_REVIEW_LOG, JSON.stringify(record) + "\\n", "utf-8");
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitForFile(filePath, { timeoutMs = 20000, intervalMs = 20 } = {}) {
  const started = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(\`timed out waiting for release file: \${filePath}\`);
    }
    await sleep(intervalMs);
  }
}
function nextPlan(basePlan, runId) {
  if (!Array.isArray(basePlan.sequence)) return basePlan;
  const countDir = process.env.FAKE_REVIEW_COUNT_DIR || path.dirname(process.env.FAKE_REVIEW_CONFIG || ".");
  fs.mkdirSync(countDir, { recursive: true });
  const countPath = path.join(countDir, runId + ".count");
  const index = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf-8")) : 0;
  fs.writeFileSync(countPath, String(index + 1), "utf-8");
  return { ...basePlan, ...(basePlan.sequence[index] || basePlan.sequence[basePlan.sequence.length - 1] || {}) };
}
const repoRoot = get("--repo");
const runId = get("--run-id");
const config = process.env.FAKE_REVIEW_CONFIG
  ? JSON.parse(fs.readFileSync(process.env.FAKE_REVIEW_CONFIG, "utf-8"))
  : {};
const plan = nextPlan(config[runId] || {}, runId);
appendLog({ event: "spawn", runId, args });
const manifestPath = getManifestPath(repoRoot, runId);
const record = readManifest(manifestPath);
let manifest = record.data;
async function main() {
if (plan.wait_for_file) {
  await waitForFile(plan.wait_for_file);
}
if (plan.delay_ms) {
  await sleep(plan.delay_ms);
}
if (!plan.stall) {
  const verdict = plan.verdict || "lgtm";
  if (!plan.omit_review_fields) {
    manifest = {
      ...manifest,
      review: {
        ...(manifest.review || {}),
        rounds: Number(manifest.review?.rounds || 0) + 1,
        latest_verdict: verdict,
      },
    };
  }
  if (plan.to_state === "ready_to_merge" || plan.to_state === undefined) {
    manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "fleet_fake_review_pass");
  } else if (plan.to_state === "escalated") {
    manifest = updateManifestState(manifest, STATES.ESCALATED, "fleet_fake_review_escalated");
  } else if (plan.to_state === "changes_requested") {
    manifest = updateManifestState(manifest, STATES.CHANGES_REQUESTED, "fleet_fake_review_changes_requested");
  }
  writeManifest(manifestPath, manifest, record.body);
}
process.stdout.write(JSON.stringify({ ok: true, runId, stalled: Boolean(plan.stall) }) + "\\n");
process.exit(plan.exit_code || 0);
}
main().catch((error) => {
  process.stderr.write(String(error.stack || error.message || error) + "\\n");
  process.exit(1);
});
`, "utf-8");
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeFakeFinalizeScript(tmpDir) {
  const scriptPath = path.join(tmpDir, "fake-finalize.js");
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const sourceRoot = process.env.RELAY_SOURCE_ROOT;
const { readManifest, writeManifest } = require(path.join(sourceRoot, "skills", "relay-dispatch", "scripts", "manifest", "store"));
const { STATES, updateManifestState } = require(path.join(sourceRoot, "skills", "relay-dispatch", "scripts", "manifest", "lifecycle"));

const args = process.argv.slice(2);
function get(flag, fallback = null) {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] || fallback);
}
function appendLog(record) {
  if (!process.env.FAKE_FINALIZE_LOG) return;
  fs.appendFileSync(process.env.FAKE_FINALIZE_LOG, JSON.stringify(record) + "\\n", "utf-8");
}
const manifestPath = get("--manifest");
const config = process.env.FAKE_FINALIZE_CONFIG
  ? JSON.parse(fs.readFileSync(process.env.FAKE_FINALIZE_CONFIG, "utf-8"))
  : {};
const record = readManifest(manifestPath);
const runId = record.data.run_id;
const plan = config[runId] || {};
appendLog({ event: "spawn", runId, args });
if (plan.fail) {
  process.stderr.write(plan.error || "fake merge failed");
  process.exit(plan.exit_code || 17);
}
if (!args.includes("--dry-run")) {
  const merged = updateManifestState(record.data, STATES.MERGED, "done");
  writeManifest(manifestPath, merged, record.body);
}
process.stdout.write(JSON.stringify({ ok: true, runId, state: args.includes("--dry-run") ? record.data.state : STATES.MERGED }) + "\\n");
`, "utf-8");
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

test("relay-fleet default invocation drives two leaves through review, serial merge, and closes the fleet", () => {
  const { relayHome, repoRoot, sprintStateLog } = setupRepo("relay-fleet-drive-green-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drive-green-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const reviewLog = path.join(tmpDir, "review.log");
  const finalizeLog = path.join(tmpDir, "finalize.log");
  const leaves = [
    makeLeaf(repoRoot, 1, { issue_number: 560 }),
    makeLeaf(repoRoot, 2, { issue_number: 561 }),
  ];
  const leavesFile = writeLeavesFile(repoRoot, leaves);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-drive-green",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_DISPATCH_LOG: dispatchLog,
      FAKE_REVIEW_LOG: reviewLog,
      FAKE_FINALIZE_LOG: finalizeLog,
    },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.summary.fleet_state, FLEET_STATES.CLOSED);
  assert.equal(payload.summary.by_run_state[RUN_STATES.MERGED], 2);
  assert.equal(readFleetManifest(repoRoot, "fleet-drive-green").data.fleet_state, FLEET_STATES.CLOSED);
  assert.equal(readJsonLines(dispatchLog).filter((entry) => !entry.detachedChild).length, 2);
  assert.equal(readJsonLines(reviewLog).length, 2);
  assert.equal(readJsonLines(finalizeLog).length, 2);
  const persisted = JSON.parse(fs.readFileSync(
    getFleetLeavesStorePath(repoRoot, "fleet-drive-green"),
    "utf-8"
  ));
  assert.deepEqual(persisted.leaves.map((leaf) => leaf.ownership), [TEST_OWNERSHIP, TEST_OWNERSHIP]);
  for (const child of payload.summary.children) {
    const manifest = readManifest(getManifestPath(repoRoot, child.run_id)).data;
    assert.deepEqual(manifest.ownership, TEST_OWNERSHIP);
    assert.deepEqual(readManifestOwnership(manifest), {
      sprint: TEST_OWNERSHIP.sprint,
      track: TEST_OWNERSHIP.track,
      component: TEST_OWNERSHIP.component,
      source: "fleet",
    });
  }
  const sprintStateInvocations = readJsonLines(sprintStateLog);
  assert.equal(sprintStateInvocations.length, 1);
  assert.deepEqual(sprintStateInvocations[0].slice(0, 3), ["--json", "--track", TEST_OWNERSHIP.track]);
  assert.equal(
    fs.realpathSync(sprintStateInvocations[0][3]),
    fs.realpathSync(path.join(repoRoot, "backlog"))
  );
});

test("relay-fleet rejects missing and mixed ownership before manifest or dispatch side effects", () => {
  for (const fixture of [
    {
      name: "missing",
      mutate(leaves) { delete leaves[0].ownership; },
      pattern: /ownership.*must be an object/i,
    },
    {
      name: "mixed",
      mutate(leaves) {
        leaves[1].ownership = {
          sprint: "backlog/sprints/2026-07-other-track.md",
          track: "2026-07-other-track",
          component: "other-track",
        };
      },
      pattern: /mixed-track fleet rejected before dispatch.*leaf-01=.*leaf-02=/i,
    },
    {
      name: "contradictory",
      mutate(leaves) {
        leaves[1].ownership = { ...TEST_OWNERSHIP, component: "other-component" };
      },
      pattern: /contradictory ownership within track.*leaf-01=.*leaf-02=/i,
    },
    {
      name: "sprint-track-mismatch",
      mutate(leaves) {
        leaves[0].ownership = {
          ...TEST_OWNERSHIP,
          track: "individually-valid-wrong-track",
          component: "merge-finalize",
        };
      },
      pattern: /ownership.*is contradictory: track .* must equal the sprint filename basename/i,
    },
    {
      name: "prefixed-relative-sprint",
      mutate(leaves) {
        leaves[0].ownership = {
          ...TEST_OWNERSHIP,
          sprint: `other/${TEST_OWNERSHIP.sprint}`,
        };
      },
      pattern: /must identify one markdown file under backlog\/sprints\//i,
    },
    {
      name: "repeated-sprint-marker",
      mutate(leaves) {
        leaves[0].ownership = {
          ...TEST_OWNERSHIP,
          sprint: `/tmp/backlog/sprints/nested/${TEST_OWNERSHIP.sprint}`,
        };
      },
      pattern: /must identify one markdown file under backlog\/sprints\//i,
    },
  ]) {
    const { relayHome, repoRoot } = setupRepo(`relay-fleet-owner-${fixture.name}-`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-owner-fake-"));
    const dispatchScript = writeFakeDispatchScript(tmpDir);
    const dispatchLog = path.join(tmpDir, "dispatch.log");
    const leaves = [makeLeaf(repoRoot, 1), makeLeaf(repoRoot, 2)];
    fixture.mutate(leaves);
    const leavesFile = writeLeavesFile(repoRoot, leaves);
    const fleetId = `fleet-owner-${fixture.name}`;

    const result = runFleet([
      "--repo", repoRoot,
      "--fleet-id", fleetId,
      "--leaves-file", leavesFile,
      "--dispatch-script", dispatchScript,
      "--dry-run",
      "--json",
    ], { relayHome, env: { FAKE_DISPATCH_LOG: dispatchLog } });

    assert.notEqual(result.status, 0, fixture.name);
    assert.match(result.stderr, fixture.pattern, fixture.name);
    assert.equal(fs.existsSync(getFleetManifestPath(repoRoot, fleetId)), false, fixture.name);
    assert.equal(fs.existsSync(dispatchLog), false, fixture.name);
  }
});

test("relay-fleet rejects a canonical missing sprint before fleet or dispatch side effects", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-owner-missing-sprint-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-owner-missing-sprint-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const leaf = makeLeaf(repoRoot, 1, {
    leaf_ref: "leaf-missing-sprint",
    issue_number: 957,
  });
  const leavesFile = writeLeavesFile(repoRoot, [leaf]);
  const fleetId = "fleet-owner-missing-sprint";
  fs.unlinkSync(path.join(repoRoot, TEST_OWNERSHIP.sprint));

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], { relayHome, env: { FAKE_DISPATCH_LOG: dispatchLog } });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /leaf 'leaf-missing-sprint' ownership\.sprint.*2026-07-relay-fleet.*existing regular file.*backlog\/sprints/i
  );
  assert.equal(fs.existsSync(getFleetManifestPath(repoRoot, fleetId)), false);
  assert.equal(fs.existsSync(getFleetLeavesStorePath(repoRoot, fleetId)), false);
  assert.equal(fs.existsSync(getFleetIssueLockPath(repoRoot, leaf.issue_number)), false);
  assert.equal(fs.existsSync(dispatchLog), false);
});

test("relay-fleet rejects stale sprint-state component ownership before fleet or dispatch side effects", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-owner-stale-component-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-owner-stale-component-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const sprintStateLog = path.join(tmpDir, "sprint-state-invocations.jsonl");
  const sprintStateBin = writeFakeSprintStateBinary(tmpDir, {
    component: "merge-finalize",
    invocationLog: sprintStateLog,
  });
  const leaf = makeLeaf(repoRoot, 1, {
    leaf_ref: "leaf-stale-component",
    issue_number: 957,
  });
  const leavesFile = writeLeavesFile(repoRoot, [leaf]);
  const fleetId = "fleet-owner-stale-component";

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], {
    relayHome,
    env: { RELAY_SPRINT_STATE_BIN: sprintStateBin, FAKE_DISPATCH_LOG: dispatchLog },
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /leaf 'leaf-stale-component' ownership.*relay-fleet.*does not match trusted dev-backlog sprint-state owner.*merge-finalize/i
  );
  assert.equal(readJsonLines(sprintStateLog).length, 1);
  assert.equal(fs.existsSync(getFleetManifestPath(repoRoot, fleetId)), false);
  assert.equal(fs.existsSync(getFleetLeavesStorePath(repoRoot, fleetId)), false);
  assert.equal(fs.existsSync(getFleetIssueLockPath(repoRoot, leaf.issue_number)), false);
  assert.equal(fs.existsSync(dispatchLog), false);
});

test("relay-fleet rejects an outside-target sprint symlink before fleet or dispatch side effects", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-owner-symlink-escape-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-owner-symlink-escape-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const leaf = makeLeaf(repoRoot, 1, {
    leaf_ref: "leaf-symlink-escape",
    issue_number: 957,
  });
  const leavesFile = writeLeavesFile(repoRoot, [leaf]);
  const fleetId = "fleet-owner-symlink-escape";
  const sprintPath = path.join(repoRoot, TEST_OWNERSHIP.sprint);
  const outsideTarget = path.join(tmpDir, "outside-sprint.md");
  fs.writeFileSync(outsideTarget, "# Outside sprint target\n", "utf-8");
  fs.unlinkSync(sprintPath);
  fs.symlinkSync(outsideTarget, sprintPath);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], { relayHome, env: { FAKE_DISPATCH_LOG: dispatchLog } });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /leaf 'leaf-symlink-escape' ownership\.sprint.*must resolve to an existing regular file within.*backlog\/sprints/i
  );
  assert.equal(fs.existsSync(getFleetManifestPath(repoRoot, fleetId)), false);
  assert.equal(fs.existsSync(getFleetLeavesStorePath(repoRoot, fleetId)), false);
  assert.equal(fs.existsSync(getFleetIssueLockPath(repoRoot, leaf.issue_number)), false);
  assert.equal(fs.existsSync(dispatchLog), false);
});

test("relay-fleet rejects an external sprints-root symlink before fleet or dispatch side effects", () => {
  const { relayHome, repoRoot, sprintStateLog } = setupRepo("relay-fleet-owner-root-symlink-escape-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-owner-root-symlink-escape-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const leaf = makeLeaf(repoRoot, 1, {
    leaf_ref: "leaf-root-symlink-escape",
    issue_number: 957,
  });
  const leavesFile = writeLeavesFile(repoRoot, [leaf]);
  const fleetId = "fleet-owner-root-symlink-escape";
  const sprintsRoot = path.join(repoRoot, "backlog", "sprints");
  const outsideSprintsRoot = path.join(tmpDir, "outside-sprints");
  fs.mkdirSync(outsideSprintsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(outsideSprintsRoot, path.basename(TEST_OWNERSHIP.sprint)),
    "# Outside sprint root target\n",
    "utf-8"
  );
  fs.rmSync(sprintsRoot, { recursive: true, force: true });
  fs.symlinkSync(outsideSprintsRoot, sprintsRoot, "dir");

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], { relayHome, env: { FAKE_DISPATCH_LOG: dispatchLog } });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /leaf 'leaf-root-symlink-escape' ownership\.sprint.*existing regular file within.*direct child.*sprints root must resolve within repository/i
  );
  assert.equal(fs.existsSync(getFleetManifestPath(repoRoot, fleetId)), false);
  assert.equal(fs.existsSync(getFleetLeavesStorePath(repoRoot, fleetId)), false);
  assert.equal(fs.existsSync(getFleetIssueLockPath(repoRoot, leaf.issue_number)), false);
  assert.equal(fs.existsSync(dispatchLog), false);
  assert.deepEqual(readJsonLines(sprintStateLog), []);
});

test("relay-fleet rejects child manifest ownership drift without rewriting it", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-owner-drift-");
  const fleetId = "fleet-owner-drift";
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 590, leaf_ref: "leaf-drift" });
  const runId = "issue-590-20260721010101000-a1b2c3d4";
  const driftedOwnership = {
    sprint: "backlog/sprints/2026-07-other-track.md",
    track: "2026-07-other-track",
    component: "other-track",
  };
  writeChildRun(repoRoot, {
    runId,
    branch: leaf.branch,
    issueNumber: leaf.issue_number,
    leafId: leaf.leaf_id,
    fleetId,
    ownership: driftedOwnership,
  });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  advanceFleetManifestState(repoRoot, fleetId, FLEET_STATES.DISPATCHED);
  writePersistedFleetLeaves(repoRoot, fleetId, [leaf]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--resume",
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ownership drift.*leaf-drift.*refusing to rewrite/i);
  assert.deepEqual(readManifest(getManifestPath(repoRoot, runId)).data.ownership, driftedOwnership);
});

test("relay-fleet keeps terminal missing-owner legacy inspection allowed without backfill", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-owner-terminal-legacy-");
  const fleetId = "fleet-owner-terminal-legacy";
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 591, leaf_ref: "leaf-legacy", leaf_id: "leaf-legacy" });
  const runId = "issue-591-20260721010101000-a1b2c3d4";
  writeChildRun(repoRoot, {
    runId,
    branch: leaf.branch,
    issueNumber: leaf.issue_number,
    leafId: leaf.leaf_id,
    fleetId,
    state: RUN_STATES.CLOSED,
  });
  const childManifestPath = getManifestPath(repoRoot, runId);
  const childRecord = readManifest(childManifestPath);
  const { ownership: _legacyOwnership, ...legacyManifest } = childRecord.data;
  writeManifest(childManifestPath, legacyManifest, childRecord.body);
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  advanceFleetManifestState(repoRoot, fleetId, FLEET_STATES.DISPATCHED);
  const { ownership: _persistedOwnership, ...legacyLeaf } = leaf;
  writePersistedFleetLeaves(repoRoot, fleetId, [legacyLeaf]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--resume",
    "--json",
  ], { relayHome });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout).summary.fleet_state, FLEET_STATES.CLOSED);
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.ownership, undefined);
});

test("relay-fleet rejects terminal existing-owner drift against the persisted leaf", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-owner-terminal-drift-");
  const fleetId = "fleet-owner-terminal-drift";
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 593, leaf_ref: "leaf-terminal-drift" });
  const runId = "issue-593-20260721010101000-a1b2c3d4";
  const driftedOwnership = { ...TEST_OWNERSHIP, component: "other-component" };
  writeChildRun(repoRoot, {
    runId,
    branch: leaf.branch,
    issueNumber: leaf.issue_number,
    leafId: leaf.leaf_id,
    fleetId,
    ownership: driftedOwnership,
    state: RUN_STATES.CLOSED,
  });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  advanceFleetManifestState(repoRoot, fleetId, FLEET_STATES.DISPATCHED);
  writePersistedFleetLeaves(repoRoot, fleetId, [leaf]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--resume",
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ownership drift.*leaf-terminal-drift.*refusing to rewrite/i);
  assert.deepEqual(readManifest(getManifestPath(repoRoot, runId)).data.ownership, driftedOwnership);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(getFleetLeavesStorePath(repoRoot, fleetId), "utf-8")).leaves[0].ownership,
    TEST_OWNERSHIP
  );
});

test("relay-fleet requires explicit ownership to migrate an active legacy child, then backfills both stores", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-owner-active-legacy-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-owner-active-legacy-fake-"));
  const fleetId = "fleet-owner-active-legacy";
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 592, leaf_ref: "leaf-legacy", leaf_id: "leaf-legacy" });
  const runId = "issue-592-20260721010101000-a1b2c3d4";
  writeChildRun(repoRoot, {
    runId,
    branch: leaf.branch,
    issueNumber: leaf.issue_number,
    leafId: leaf.leaf_id,
    fleetId,
  });
  const childManifestPath = getManifestPath(repoRoot, runId);
  const childRecord = readManifest(childManifestPath);
  const { ownership: _legacyOwnership, ...legacyManifest } = childRecord.data;
  writeManifest(childManifestPath, legacyManifest, childRecord.body);
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  advanceFleetManifestState(repoRoot, fleetId, FLEET_STATES.DISPATCHED);
  const { ownership: _persistedOwnership, ...legacyLeaf } = leaf;
  writePersistedFleetLeaves(repoRoot, fleetId, [legacyLeaf]);

  const blocked = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--resume",
    "--json",
  ], { relayHome });

  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /legacy ownership is missing.*--leaves-file.*backfill/i);
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.ownership, undefined);

  const migrated = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", writeLeavesFile(repoRoot, [leaf]),
    "--review-script", writeFakeReviewScript(tmpDir),
    "--finalize-script", writeFakeFinalizeScript(tmpDir),
    "--json",
  ], { relayHome });

  assert.equal(migrated.status, 0, `${migrated.stderr}\n${migrated.stdout}`);
  assert.deepEqual(readManifest(getManifestPath(repoRoot, runId)).data.ownership, TEST_OWNERSHIP);
  const persisted = JSON.parse(fs.readFileSync(getFleetLeavesStorePath(repoRoot, fleetId), "utf-8"));
  assert.deepEqual(persisted.leaves.map((entry) => entry.ownership), [TEST_OWNERSHIP]);
});

test("relay-fleet documents the explicit active legacy migration and terminal inspection contract", () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, "skills", "relay-fleet", "SKILL.md"), "utf-8");
  const migrationReference = fs.readFileSync(
    path.join(REPO_ROOT, "skills", "relay-fleet", "references", "sprint-to-leaves.md"),
    "utf-8"
  );

  for (const content of [skill, migrationReference]) {
    assert.match(content, /active pre-ownership fleet/i);
    assert.match(content, /validated single-track `--leaves-file`/i);
    assert.match(content, /terminal legacy children.*inspectable without backfill/i);
  }
});

test("relay-fleet preflights every legacy ownership backfill before writing the first child", async () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-owner-backfill-preflight-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-owner-backfill-preflight-hook-"));
  const preloadPath = writeReadMarkerPreload(tmpDir);
  const markerPath = path.join(tmpDir, "later-manifest-read.flag");
  const fleetId = "fleet-owner-backfill-preflight";
  const leaves = [
    makeLeaf(repoRoot, 1, {
      issue_number: 595,
      leaf_ref: "leaf-first",
      leaf_id: "leaf-first",
    }),
    makeLeaf(repoRoot, 2, {
      issue_number: 594,
      leaf_ref: "leaf-later",
      leaf_id: "leaf-later",
    }),
  ];
  const runIds = [
    "issue-595-20260721010101000-a1b2c3d4",
    "issue-594-20260721010101000-a1b2c3d4",
  ];

  for (let index = 0; index < leaves.length; index += 1) {
    const leaf = leaves[index];
    const runId = runIds[index];
    writeChildRun(repoRoot, {
      runId,
      branch: leaf.branch,
      issueNumber: leaf.issue_number,
      leafId: leaf.leaf_id,
      fleetId,
    });
    const manifestPath = getManifestPath(repoRoot, runId);
    const record = readManifest(manifestPath);
    const { ownership: _legacyOwnership, ...legacyManifest } = record.data;
    writeManifest(manifestPath, {
      ...legacyManifest,
      timestamps: {
        ...legacyManifest.timestamps,
        created_at: "2026-07-21T01:01:01.000Z",
      },
    }, record.body);
  }

  createFleetManifest(repoRoot, {
    fleetId,
    children: leaves.map((leaf, index) => ({
      leaf_ref: leaf.leaf_ref,
      run_id: runIds[index],
      dispatch_status: DISPATCH_STATUS.DISPATCHED,
    })),
  });
  advanceFleetManifestState(repoRoot, fleetId, FLEET_STATES.DISPATCHED);
  writePersistedFleetLeaves(repoRoot, fleetId, leaves.map((leaf) => {
    const { ownership: _persistedOwnership, ...legacyLeaf } = leaf;
    return legacyLeaf;
  }));

  const firstManifestPath = getManifestPath(repoRoot, runIds[0]);
  const laterManifestPath = getManifestPath(repoRoot, runIds[1]);
  const firstLock = acquireManifestLock(firstManifestPath);
  const child = spawn(process.execPath, [
    RELAY_FLEET_SCRIPT,
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", writeLeavesFile(repoRoot, leaves),
    "--json",
  ], {
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
      RELAY_SOURCE_ROOT: REPO_ROOT,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(" "),
      RELAY_FLEET_MARK_READ_PATH: laterManifestPath,
      RELAY_FLEET_READ_MARKER_PATH: markerPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childResult = captureChildResult(child);
  const driftedOwnership = {
    sprint: "backlog/sprints/2026-07-other-track.md",
    track: "2026-07-other-track",
    component: "other-track",
  };

  try {
    await waitFor(() => fs.existsSync(markerPath));
    const laterRecord = readManifest(laterManifestPath);
    writeManifest(laterManifestPath, {
      ...laterRecord.data,
      ownership: driftedOwnership,
    }, laterRecord.body);
  } finally {
    releaseManifestLock(firstLock);
  }

  const result = await childResult;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ownership drift.*leaf-later.*refusing to rewrite/i);
  assert.equal(readManifest(firstManifestPath).data.ownership, undefined);
  assert.deepEqual(readManifest(laterManifestPath).data.ownership, driftedOwnership);
});

test("relay-fleet legacy ownership backfill preserves a concurrent child manifest transition", async () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-owner-backfill-race-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-owner-backfill-race-hook-"));
  const preloadPath = writeReadMarkerPreload(tmpDir);
  const markerPath = path.join(tmpDir, "manifest-read.flag");
  const fleetId = "fleet-owner-backfill-race";
  const leaf = makeLeaf(repoRoot, 1, {
    issue_number: 593,
    leaf_ref: "leaf-legacy",
    leaf_id: "leaf-legacy",
  });
  const runId = "issue-593-20260721010101000-a1b2c3d4";
  writeChildRun(repoRoot, {
    runId,
    branch: leaf.branch,
    issueNumber: leaf.issue_number,
    leafId: leaf.leaf_id,
    fleetId,
  });
  const childManifestPath = getManifestPath(repoRoot, runId);
  const childRecord = readManifest(childManifestPath);
  const { ownership: _legacyOwnership, ...legacyManifest } = childRecord.data;
  writeManifest(childManifestPath, legacyManifest, childRecord.body);
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  advanceFleetManifestState(repoRoot, fleetId, FLEET_STATES.DISPATCHED);
  const { ownership: _persistedOwnership, ...legacyLeaf } = leaf;
  writePersistedFleetLeaves(repoRoot, fleetId, [legacyLeaf]);

  const lock = acquireManifestLock(childManifestPath);
  const child = spawn(process.execPath, [
    RELAY_FLEET_SCRIPT,
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", writeLeavesFile(repoRoot, [leaf]),
    "--finalize-script", writeFakeFinalizeScript(tmpDir),
    "--json",
  ], {
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
      RELAY_SOURCE_ROOT: REPO_ROOT,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(" "),
      RELAY_FLEET_MARK_READ_PATH: childManifestPath,
      RELAY_FLEET_READ_MARKER_PATH: markerPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childResult = captureChildResult(child);

  try {
    await waitFor(() => fs.existsSync(markerPath));
    const current = readManifest(childManifestPath);
    const transitioned = updateManifestState(
      {
        ...current.data,
        review: {
          ...(current.data.review || {}),
          rounds: 2,
          latest_verdict: "concurrent-review-pass",
        },
      },
      RUN_STATES.READY_TO_MERGE,
      "concurrent_review_complete"
    );
    writeManifestUnlocked(childManifestPath, transitioned, current.body);
  } finally {
    releaseManifestLock(lock);
  }

  const result = await childResult;
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const migrated = readManifest(childManifestPath).data;
  assert.equal(migrated.state, RUN_STATES.MERGED);
  assert.equal(migrated.review.rounds, 2);
  assert.equal(migrated.review.latest_verdict, "concurrent-review-pass");
  assert.deepEqual(migrated.ownership, TEST_OWNERSHIP);
});

test("relay-fleet re-run with the same leaves file reconciles and continues without re-dispatching", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-drive-rerun-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drive-rerun-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const reviewLog = path.join(tmpDir, "review.log");
  const finalizeLog = path.join(tmpDir, "finalize.log");
  const reviewConfig = path.join(tmpDir, "review-config.json");
  const leaves = [
    makeLeaf(repoRoot, 1, {
      issue_number: 562,
      branch: "issue-562-leaf-a",
      leaf_ref: "leaf-a",
      leaf_id: "leaf-a",
    }),
    makeLeaf(repoRoot, 2, {
      issue_number: 563,
      branch: "issue-563-leaf-b",
      leaf_ref: "leaf-b",
      leaf_id: "leaf-b",
    }),
  ];
  const runA = "issue-562-20260516010101000-a1b2c3d4";
  const runB = "issue-563-20260516010101000-a1b2c3d4";
  const dispatchConfig = path.join(tmpDir, "dispatch-config.json");
  writeJson(dispatchConfig, {
    [leaves[0].branch]: { run_id: runA },
    [leaves[1].branch]: { run_id: runB },
  });
  writeJson(reviewConfig, { [runA]: { stall: true }, [runB]: { to_state: "ready_to_merge" } });
  const leavesFile = writeLeavesFile(repoRoot, leaves);

  const stalled = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-drive-rerun",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_DISPATCH_CONFIG: dispatchConfig,
      FAKE_DISPATCH_LOG: dispatchLog,
      FAKE_REVIEW_CONFIG: reviewConfig,
      FAKE_REVIEW_LOG: reviewLog,
      FAKE_FINALIZE_LOG: finalizeLog,
    },
  });

  assert.notEqual(stalled.status, 0, `${stalled.stderr}\n${stalled.stdout}`);
  assert.equal(readFleetManifest(repoRoot, "fleet-drive-rerun").data.fleet_state, FLEET_STATES.REVIEWING);
  assert.equal(readJsonLines(dispatchLog).filter((entry) => !entry.detachedChild).length, 2);

  writeJson(reviewConfig, { [runA]: { to_state: "ready_to_merge" }, [runB]: { to_state: "ready_to_merge" } });
  const resumed = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-drive-rerun",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_DISPATCH_CONFIG: dispatchConfig,
      FAKE_DISPATCH_LOG: dispatchLog,
      FAKE_REVIEW_CONFIG: reviewConfig,
      FAKE_REVIEW_LOG: reviewLog,
      FAKE_FINALIZE_LOG: finalizeLog,
    },
  });

  assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
  const payload = JSON.parse(resumed.stdout);
  assert.equal(payload.summary.fleet_state, FLEET_STATES.CLOSED);
  assert.equal(readJsonLines(dispatchLog).filter((entry) => !entry.detachedChild).length, 2);
  assert.equal(readManifest(getManifestPath(repoRoot, runA)).data.state, RUN_STATES.MERGED);
  assert.equal(readManifest(getManifestPath(repoRoot, runB)).data.state, RUN_STATES.MERGED);
});

test("relay-fleet re-run with the same leaves file recreates a missing persisted leaves store", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-drive-missing-leaves-store-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drive-missing-leaves-store-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 570, leaf_ref: "leaf-a", leaf_id: "leaf-a" });
  const leavesFile = writeLeavesFile(repoRoot, [leaf]);
  const fleetId = "fleet-missing-leaves-store";
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: null, dispatch_status: DISPATCH_STATUS.PENDING }],
  });
  const leavesStorePath = getFleetLeavesStorePath(repoRoot, fleetId);
  assert.equal(fs.existsSync(leavesStorePath), false);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_LOG: dispatchLog },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.summary.fleet_state, FLEET_STATES.CLOSED);
  assert.equal(fs.existsSync(leavesStorePath), true);
  const persistedLeaves = JSON.parse(fs.readFileSync(leavesStorePath, "utf-8")).leaves;
  assert.deepEqual(persistedLeaves.map((entry) => entry.leaf_ref), ["leaf-a"]);
  assert.equal(readJsonLines(dispatchLog).filter((entry) => !entry.detachedChild).length, 1);
});

test("relay-fleet re-run with a different leaves file fails closed without changing the manifest", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-drive-mismatch-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drive-mismatch-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const leavesFile = writeLeavesFile(repoRoot, [
    makeLeaf(repoRoot, 1, { issue_number: 564, leaf_ref: "leaf-a", leaf_id: "leaf-a" }),
  ]);

  const first = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-drive-mismatch",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], { relayHome });

  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const before = fs.readFileSync(getFleetManifestPath(repoRoot, "fleet-drive-mismatch"), "utf-8");
  const changedLeavesFile = writeLeavesFile(repoRoot, [
    makeLeaf(repoRoot, 1, { issue_number: 564, leaf_ref: "leaf-a", leaf_id: "leaf-a" }),
    makeLeaf(repoRoot, 2, { issue_number: 565, leaf_ref: "leaf-b", leaf_id: "leaf-b" }),
  ]);

  const second = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-drive-mismatch",
    "--leaves-file", changedLeavesFile,
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], { relayHome });

  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /differs from persisted fleet leaves/);
  assert.equal(fs.readFileSync(getFleetManifestPath(repoRoot, "fleet-drive-mismatch"), "utf-8"), before);
});

test("relay-fleet re-run with different leaves fails closed when the persisted leaves store is missing", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-drive-missing-leaves-mismatch-");
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 571, leaf_ref: "leaf-a", leaf_id: "leaf-a" });
  const fleetId = "fleet-missing-leaves-mismatch";
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: null, dispatch_status: DISPATCH_STATUS.PENDING }],
  });
  const before = fs.readFileSync(getFleetManifestPath(repoRoot, fleetId), "utf-8");
  const changedLeavesFile = writeLeavesFile(repoRoot, [
    leaf,
    makeLeaf(repoRoot, 2, { issue_number: 572, leaf_ref: "leaf-b", leaf_id: "leaf-b" }),
  ]);
  const leavesStorePath = getFleetLeavesStorePath(repoRoot, fleetId);
  assert.equal(fs.existsSync(leavesStorePath), false);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", changedLeavesFile,
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /leaf_ref set differs from fleet manifest children/);
  assert.equal(fs.existsSync(leavesStorePath), false);
  assert.equal(fs.readFileSync(getFleetManifestPath(repoRoot, fleetId), "utf-8"), before);
});

test("relay-fleet replacement matrix byte-preserves identical persisted leaves", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-replace-identical-");
  const fleetId = "fleet-replace-identical";
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 572, leaf_ref: "leaf-a", leaf_id: "leaf-a" });
  const leavesFile = writeLeavesFile(repoRoot, [leaf]);
  const runId = writeChildRun(repoRoot, {
    runId: "issue-572-20260517010101000-a1b2c3d4",
    branch: leaf.branch,
    issueNumber: leaf.issue_number,
    leafId: leaf.leaf_id,
    fleetId,
    state: RUN_STATES.CLOSED,
  });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  advanceFleetManifestState(repoRoot, fleetId, FLEET_STATES.CLOSED);
  writePersistedFleetLeaves(repoRoot, fleetId, [leaf]);
  const manifestBefore = fs.readFileSync(getFleetManifestPath(repoRoot, fleetId), "utf-8");
  const storeBefore = fs.readFileSync(getFleetLeavesStorePath(repoRoot, fleetId), "utf-8");

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--json",
  ], { relayHome });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.replaced_children, []);
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(getFleetManifestPath(repoRoot, fleetId), "utf-8"), manifestBefore);
  assert.equal(fs.readFileSync(getFleetLeavesStorePath(repoRoot, fleetId), "utf-8"), storeBefore);
});

test("relay-fleet replacement matrix replaces only run_id-null pre-manifest failed children", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-replace-premanifest-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-replace-premanifest-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const fleetId = "fleet-replace-premanifest";
  const oldLeaf = makeLeaf(repoRoot, 1, {
    issue_number: 573,
    leaf_ref: "leaf-old",
    leaf_id: "leaf-old",
    branch: "issue-573-leaf-old",
  });
  const newLeaf = makeLeaf(repoRoot, 2, {
    issue_number: oldLeaf.issue_number,
    leaf_ref: "leaf-new",
    leaf_id: "leaf-new",
    branch: "issue-573-leaf-new",
  });
  const leavesFile = writeLeavesFile(repoRoot, [newLeaf]);
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{
      leaf_ref: oldLeaf.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
      last_error: "old pre-manifest failure",
    }],
  });
  writePersistedFleetLeaves(repoRoot, fleetId, [oldLeaf]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_LOG: dispatchLog },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /relay-fleet replaced child in fleet 'fleet-replace-premanifest': leaf-old -> leaf-new/);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.replaced_children, [{
    old_leaf_ref: "leaf-old",
    new_leaf_ref: "leaf-new",
    issue_number: oldLeaf.issue_number,
  }]);
  const dispatchEntries = readJsonLines(dispatchLog).filter((entry) => !entry.detachedChild);
  assert.equal(dispatchEntries.length, 1);
  assert.equal(dispatchEntries[0].branch, newLeaf.branch);
  assert.equal(dispatchEntries[0].leafId, newLeaf.leaf_id);
  const manifestChildren = readFleetManifest(repoRoot, fleetId).data.children;
  assert.equal(manifestChildren.some((child) => child.leaf_ref === oldLeaf.leaf_ref), false);
  const newChild = manifestChildren.find((child) => child.leaf_ref === newLeaf.leaf_ref);
  assert.ok(newChild);
  assert.equal(newChild.dispatch_status, DISPATCH_STATUS.DISPATCHED);
  assert.equal(Object.hasOwn(newChild, "last_error"), false);
  const persistedLeaves = JSON.parse(fs.readFileSync(getFleetLeavesStorePath(repoRoot, fleetId), "utf-8")).leaves;
  assert.deepEqual(persistedLeaves.map((leaf) => leaf.leaf_ref), [newLeaf.leaf_ref]);
});

test("relay-fleet replacement matrix rejects a changed leaf that keeps the same leaf_ref", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-replace-sameref-");
  const fleetId = "fleet-replace-sameref";
  const oldLeaf = makeLeaf(repoRoot, 1, {
    issue_number: 581,
    leaf_ref: "leaf-old",
    leaf_id: "leaf-old",
    branch: "issue-581-leaf-old",
  });
  const respecifiedLeaf = makeLeaf(repoRoot, 2, {
    issue_number: oldLeaf.issue_number,
    leaf_ref: oldLeaf.leaf_ref,
    leaf_id: oldLeaf.leaf_id,
    branch: "issue-581-leaf-respecified",
  });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{
      leaf_ref: oldLeaf.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
      last_error: "old pre-manifest failure",
    }],
  });
  writePersistedFleetLeaves(repoRoot, fleetId, [oldLeaf]);
  const manifestPath = getFleetManifestPath(repoRoot, fleetId);
  const leavesStorePath = getFleetLeavesStorePath(repoRoot, fleetId);
  const manifestBefore = fs.readFileSync(manifestPath, "utf-8");
  const storeBefore = fs.readFileSync(leavesStorePath, "utf-8");
  const leavesFile = writeLeavesFile(repoRoot, [respecifiedLeaf]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0);
  assert.equal(
    JSON.parse(result.stderr).error,
    `--leaves-file differs from persisted fleet leaves for '${fleetId}'; refusing to overwrite an existing fleet`
  );
  assert.equal(fs.readFileSync(manifestPath, "utf-8"), manifestBefore);
  assert.equal(fs.readFileSync(leavesStorePath, "utf-8"), storeBefore);
});

test("relay-fleet replacement matrix rejects a replacement leaf_ref that collides with an unchanged sibling", () => {
  for (const replaceableFirst of [true, false]) {
    const { relayHome, repoRoot } = setupRepo(`relay-fleet-replace-collision-${replaceableFirst ? "first" : "last"}-`);
    const fleetId = `fleet-replace-collision-${replaceableFirst ? "first" : "last"}`;
    const oldLeaf = makeLeaf(repoRoot, 1, {
      issue_number: 578,
      leaf_ref: "leaf-old",
      leaf_id: "leaf-old",
      branch: "issue-578-leaf-old",
    });
    const unchangedLeaf = makeLeaf(repoRoot, 2, {
      issue_number: 579,
      leaf_ref: "leaf-unchanged",
      leaf_id: "leaf-unchanged",
      branch: "issue-579-leaf-unchanged",
    });
    const collidingLeaf = makeLeaf(repoRoot, 3, {
      issue_number: oldLeaf.issue_number,
      leaf_ref: unchangedLeaf.leaf_ref,
      leaf_id: unchangedLeaf.leaf_id,
      branch: "issue-578-leaf-collision",
    });
    const replaceableChild = {
      leaf_ref: oldLeaf.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
      last_error: "old pre-manifest failure",
    };
    const unchangedChild = {
      leaf_ref: unchangedLeaf.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.PENDING,
    };
    createFleetManifest(repoRoot, {
      fleetId,
      children: replaceableFirst
        ? [replaceableChild, unchangedChild]
        : [unchangedChild, replaceableChild],
    });
    writePersistedFleetLeaves(repoRoot, fleetId, [oldLeaf, unchangedLeaf]);
    const manifestPath = getFleetManifestPath(repoRoot, fleetId);
    const leavesStorePath = getFleetLeavesStorePath(repoRoot, fleetId);
    const manifestBefore = fs.readFileSync(manifestPath, "utf-8");
    const storeBefore = fs.readFileSync(leavesStorePath, "utf-8");
    const leavesFile = writeLeavesFile(repoRoot, [collidingLeaf, unchangedLeaf]);

    const result = runFleet([
      "--repo", repoRoot,
      "--fleet-id", fleetId,
      "--leaves-file", leavesFile,
      "--json",
    ], { relayHome });

    assert.notEqual(result.status, 0);
    assert.equal(
      JSON.parse(result.stderr).error,
      `--leaves-file differs from persisted fleet leaves for '${fleetId}'; refusing to overwrite an existing fleet`
    );
    assert.equal(fs.readFileSync(manifestPath, "utf-8"), manifestBefore);
    assert.equal(fs.readFileSync(leavesStorePath, "utf-8"), storeBefore);
  }
});

test("relay-fleet replacement rejects swap and rename-chain targets so stale leaf keys keep their specifications", () => {
  const scenarios = [
    { name: "swap", refs: ["leaf-a", "leaf-b"], incomingRefs: ["leaf-b", "leaf-a"] },
    {
      name: "chain",
      refs: ["leaf-a", "leaf-b", "leaf-c"],
      incomingRefs: ["leaf-b", "leaf-c", "leaf-a"],
    },
  ];

  for (const scenario of scenarios) {
    const { relayHome, repoRoot } = setupRepo(`relay-fleet-replace-${scenario.name}-`);
    const fleetId = `fleet-replace-${scenario.name}`;
    const persistedLeaves = scenario.refs.map((leafRef, index) => makeLeaf(repoRoot, index + 1, {
      issue_number: 590 + index,
      leaf_ref: leafRef,
      leaf_id: leafRef,
      branch: `issue-${590 + index}-${leafRef}-original`,
    }));
    const incomingLeaves = scenario.incomingRefs.map((leafRef, index) => makeLeaf(repoRoot, index + 10, {
      issue_number: 590 + index,
      leaf_ref: leafRef,
      leaf_id: leafRef,
      branch: `issue-${590 + index}-${leafRef}-replacement`,
    }));
    createFleetManifest(repoRoot, {
      fleetId,
      children: persistedLeaves.map((leaf) => ({
        leaf_ref: leaf.leaf_ref,
        run_id: null,
        dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
        last_error: `old failure for ${leaf.leaf_ref}`,
      })),
    });
    writePersistedFleetLeaves(repoRoot, fleetId, persistedLeaves);
    const manifestPath = getFleetManifestPath(repoRoot, fleetId);
    const leavesStorePath = getFleetLeavesStorePath(repoRoot, fleetId);
    const manifestBefore = fs.readFileSync(manifestPath, "utf-8");
    const storeBefore = fs.readFileSync(leavesStorePath, "utf-8");
    const leavesFile = writeLeavesFile(repoRoot, incomingLeaves);

    const result = runFleet([
      "--repo", repoRoot,
      "--fleet-id", fleetId,
      "--leaves-file", leavesFile,
      "--json",
    ], { relayHome });

    assert.notEqual(result.status, 0);
    assert.equal(
      JSON.parse(result.stderr).error,
      `--leaves-file differs from persisted fleet leaves for '${fleetId}'; refusing to overwrite an existing fleet`
    );
    assert.equal(fs.readFileSync(manifestPath, "utf-8"), manifestBefore);
    assert.equal(fs.readFileSync(leavesStorePath, "utf-8"), storeBefore);
    assert.deepEqual(
      JSON.parse(storeBefore).leaves.map((leaf) => [leaf.issue_number, leaf.leaf_ref, leaf.branch]),
      persistedLeaves.map((leaf) => [leaf.issue_number, leaf.leaf_ref, leaf.branch])
    );
  }
});

test("relay-fleet replacement matrix fails closed when a manifest-only run-bearing child is omitted", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-replace-manifest-only-run-");
  const fleetId = "fleet-replace-manifest-only-run";
  const oldLeaf = makeLeaf(repoRoot, 1, {
    issue_number: 580,
    leaf_ref: "leaf-old",
    leaf_id: "leaf-old",
    branch: "issue-580-leaf-old",
  });
  const newLeaf = makeLeaf(repoRoot, 2, {
    issue_number: oldLeaf.issue_number,
    leaf_ref: "leaf-new",
    leaf_id: "leaf-new",
    branch: "issue-580-leaf-new",
  });
  const runId = writeChildRun(repoRoot, {
    runId: "issue-581-20260517010101000-a1b2c3d4",
    branch: "issue-581-leaf-run-bearing",
    issueNumber: 581,
    leafId: "leaf-run-bearing",
    fleetId,
  });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [
      {
        leaf_ref: oldLeaf.leaf_ref,
        run_id: null,
        dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
        last_error: "old pre-manifest failure",
      },
      {
        leaf_ref: "leaf-run-bearing",
        run_id: runId,
        dispatch_status: DISPATCH_STATUS.DISPATCHED,
      },
    ],
  });
  writePersistedFleetLeaves(repoRoot, fleetId, [oldLeaf]);
  const manifestPath = getFleetManifestPath(repoRoot, fleetId);
  const leavesStorePath = getFleetLeavesStorePath(repoRoot, fleetId);
  const manifestBefore = fs.readFileSync(manifestPath, "utf-8");
  const storeBefore = fs.readFileSync(leavesStorePath, "utf-8");
  const leavesFile = writeLeavesFile(repoRoot, [newLeaf]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0);
  assert.equal(
    JSON.parse(result.stderr).error,
    `--leaves-file differs from persisted fleet leaves for '${fleetId}'; refusing to overwrite an existing fleet`
  );
  assert.equal(fs.readFileSync(manifestPath, "utf-8"), manifestBefore);
  assert.equal(fs.readFileSync(leavesStorePath, "utf-8"), storeBefore);
});

test("relay-fleet replacement rechecks eligibility after a concurrent child transition", async () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-replace-transition-race-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-replace-transition-race-hook-"));
  const preloadPath = writeReadMarkerPreload(tmpDir);
  const markerPath = path.join(tmpDir, "manifest-read.flag");
  const fleetId = "fleet-replace-transition-race";
  const oldLeaf = makeLeaf(repoRoot, 1, {
    issue_number: 581,
    leaf_ref: "leaf-old",
    leaf_id: "leaf-old",
    branch: "issue-581-leaf-old",
  });
  const newLeaf = makeLeaf(repoRoot, 2, {
    issue_number: oldLeaf.issue_number,
    leaf_ref: "leaf-new",
    leaf_id: "leaf-new",
    branch: "issue-581-leaf-new",
  });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{
      leaf_ref: oldLeaf.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
      last_error: "old pre-manifest failure",
    }],
  });
  writePersistedFleetLeaves(repoRoot, fleetId, [oldLeaf]);
  const manifestPath = getFleetManifestPath(repoRoot, fleetId);
  const leavesStorePath = getFleetLeavesStorePath(repoRoot, fleetId);
  const leavesFile = writeLeavesFile(repoRoot, [newLeaf]);
  const childLockPath = holdFleetChildLock(repoRoot, fleetId);
  const child = spawn(process.execPath, [
    RELAY_FLEET_SCRIPT,
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--json",
  ], {
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
      RELAY_SOURCE_ROOT: REPO_ROOT,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(" "),
      RELAY_FLEET_MARK_READ_PATH: manifestPath,
      RELAY_FLEET_READ_MARKER_PATH: markerPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childResult = captureChildResult(child);

  await waitFor(() => fs.existsSync(markerPath));
  updateFleetManifest(repoRoot, fleetId, (fleet) => ({
    ...fleet,
    children: fleet.children.map((entry) => entry.leaf_ref === oldLeaf.leaf_ref
      ? { ...entry, dispatch_status: DISPATCH_STATUS.DISPATCHING }
      : entry),
  }));
  fs.unlinkSync(childLockPath);

  const result = await childResult;
  assert.notEqual(result.status, 0);
  assert.equal(
    JSON.parse(result.stderr).error,
    `--leaves-file differs from persisted fleet leaves for '${fleetId}'; refusing to overwrite an existing fleet`
  );
  assert.deepEqual(readFleetManifest(repoRoot, fleetId).data.children, [{
    leaf_ref: oldLeaf.leaf_ref,
    run_id: null,
    dispatch_status: DISPATCH_STATUS.DISPATCHING,
    last_error: "old pre-manifest failure",
  }]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(leavesStorePath, "utf-8")).leaves.map((leaf) => leaf.leaf_ref),
    [oldLeaf.leaf_ref]
  );
});

test("relay-fleet stale dispatch selection cannot recreate a replaced child", async () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-replace-stale-selection-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-replace-stale-selection-hook-"));
  const preloadPath = writeReadMarkerPreload(tmpDir);
  const markerPath = path.join(tmpDir, "lock-read.flag");
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const fleetId = "fleet-replace-stale-selection";
  const oldLeaf = makeLeaf(repoRoot, 1, {
    issue_number: 582,
    leaf_ref: "leaf-old",
    leaf_id: "leaf-old",
    branch: "issue-582-leaf-old",
  });
  const newLeaf = makeLeaf(repoRoot, 2, {
    issue_number: oldLeaf.issue_number,
    leaf_ref: "leaf-new",
    leaf_id: "leaf-new",
    branch: "issue-582-leaf-new",
  });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{
      leaf_ref: oldLeaf.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
      last_error: "old pre-manifest failure",
    }],
  });
  writePersistedFleetLeaves(repoRoot, fleetId, [oldLeaf]);
  const oldLeavesFile = writeLeavesFile(repoRoot, [oldLeaf]);
  const childLockPath = holdFleetChildLock(repoRoot, fleetId);
  const child = spawn(process.execPath, [
    RELAY_FLEET_SCRIPT,
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", oldLeavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], {
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
      RELAY_SOURCE_ROOT: REPO_ROOT,
      FAKE_DISPATCH_LOG: dispatchLog,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(" "),
      RELAY_FLEET_MARK_READ_PATH: childLockPath,
      RELAY_FLEET_READ_MARKER_PATH: markerPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childResult = captureChildResult(child);

  await waitFor(() => fs.existsSync(markerPath));
  updateFleetManifest(repoRoot, fleetId, (fleet) => ({
    ...fleet,
    children: [{
      leaf_ref: newLeaf.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.PENDING,
    }],
  }));
  writePersistedFleetLeaves(repoRoot, fleetId, [newLeaf]);
  fs.unlinkSync(childLockPath);

  const result = await childResult;
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout).children[0].status, "skipped_replaced");
  assert.equal(fs.existsSync(dispatchLog), false);
  assert.deepEqual(readFleetManifest(repoRoot, fleetId).data.children, [{
    leaf_ref: newLeaf.leaf_ref,
    run_id: null,
    dispatch_status: DISPATCH_STATUS.PENDING,
  }]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(getFleetLeavesStorePath(repoRoot, fleetId), "utf-8")).leaves.map((leaf) => leaf.leaf_ref),
    [newLeaf.leaf_ref]
  );
});

test("fleet child lock fences two concurrent stale-lock reapers", async () => {
  const { repoRoot } = setupRepo("relay-fleet-stale-lock-reapers-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-stale-lock-reapers-hook-"));
  const workerPath = writeFleetChildLockWorker(tmpDir);
  const preloadPath = path.join(tmpDir, "delay-stale-lock-read.js");
  const readMarker = path.join(tmpDir, "stale-read.flag");
  const activeMarker = path.join(tmpDir, "callback-active.flag");
  const overlapLog = path.join(tmpDir, "callback-overlap.log");
  const fleetId = "fleet-stale-lock-reapers";
  const lockPath = path.join(getFleetsDir(repoRoot), "locks", `fleet-${fleetId}-children.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  writeJson(lockPath, {
    fleet_id: fleetId,
    pid: 2147483647,
    hostname: os.hostname(),
    acquired_at: new Date(0).toISOString(),
  });
  fs.writeFileSync(preloadPath, `const fs = require("node:fs");
const path = require("node:path");
const waitArray = new Int32Array(new SharedArrayBuffer(4));
const originalReadFileSync = fs.readFileSync;
let delayed = false;

fs.readFileSync = function delayedStaleLockRead(filePath) {
  const result = originalReadFileSync.apply(this, arguments);
  if (!delayed && path.resolve(String(filePath)) === path.resolve(process.env.RELAY_FLEET_DELAY_READ_PATH)) {
    delayed = true;
    fs.writeFileSync(process.env.RELAY_FLEET_DELAY_READ_MARKER, "read\\n", "utf-8");
    Atomics.wait(waitArray, 0, 0, 400);
  }
  return result;
};
`, "utf-8");

  const commonEnv = {
    ...process.env,
    RELAY_FLEET_SCRIPT,
    RELAY_FLEET_REPO: repoRoot,
    RELAY_FLEET_ID: fleetId,
    RELAY_FLEET_ACTIVE_MARKER: activeMarker,
    RELAY_FLEET_OVERLAP_LOG: overlapLog,
    RELAY_FLEET_HOLD_MS: "800",
  };
  const first = spawn(process.execPath, [workerPath], {
    env: {
      ...commonEnv,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(" "),
      RELAY_FLEET_DELAY_READ_PATH: lockPath,
      RELAY_FLEET_DELAY_READ_MARKER: readMarker,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const firstResult = captureChildResult(first);
  await waitFor(() => fs.existsSync(readMarker));

  const second = spawn(process.execPath, [workerPath], {
    env: commonEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const secondResult = captureChildResult(second);
  const [firstDone, secondDone] = await Promise.all([firstResult, secondResult]);

  assert.equal(firstDone.status, 0, firstDone.stderr);
  assert.equal(secondDone.status, 0, secondDone.stderr);
  assert.equal(fs.existsSync(overlapLog), false);
});

test("fleet child lock recovers a truncated canonical lock without overlapping callbacks", async () => {
  const { repoRoot } = setupRepo("relay-fleet-truncated-child-lock-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-truncated-child-lock-worker-"));
  const workerPath = writeFleetChildLockWorker(tmpDir);
  const activeMarker = path.join(tmpDir, "callback-active.flag");
  const overlapLog = path.join(tmpDir, "callback-overlap.log");
  const fleetId = "fleet-truncated-child-lock";
  const lockPath = path.join(getFleetsDir(repoRoot), "locks", `fleet-${fleetId}-children.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '{"fleet_id":', "utf-8");

  const commonEnv = {
    ...process.env,
    RELAY_FLEET_SCRIPT,
    RELAY_FLEET_REPO: repoRoot,
    RELAY_FLEET_ID: fleetId,
    RELAY_FLEET_ACTIVE_MARKER: activeMarker,
    RELAY_FLEET_OVERLAP_LOG: overlapLog,
    RELAY_FLEET_HOLD_MS: "400",
  };
  const first = spawn(process.execPath, [workerPath], {
    env: commonEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const firstResult = captureChildResult(first);
  await waitFor(() => fs.existsSync(activeMarker));
  const second = spawn(process.execPath, [workerPath], {
    env: commonEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const secondResult = captureChildResult(second);
  const [firstDone, secondDone] = await Promise.all([firstResult, secondResult]);

  assert.equal(firstDone.status, 0, firstDone.stderr);
  assert.equal(secondDone.status, 0, secondDone.stderr);
  assert.equal(fs.existsSync(overlapLog), false);
  assert.equal(fs.existsSync(lockPath), false);
});

test("relay-fleet replacement matrix rolls back manifest when persisted leaves rewrite fails", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-replace-rollback-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-replace-rollback-fake-"));
  const preloadScript = path.join(tmpDir, "fail-leaves-store-rename.js");
  fs.writeFileSync(preloadScript, `const fs = require("node:fs");
const path = require("node:path");
const originalRenameSync = fs.renameSync;

fs.renameSync = function renameSyncWithLeavesStoreFailure(sourcePath, destPath) {
  const failDest = process.env.RELAY_FLEET_FAIL_RENAME_DEST;
  if (failDest && path.resolve(destPath) === path.resolve(failDest)) {
    throw new Error("simulated leaves store write failure");
  }
  return originalRenameSync.apply(this, arguments);
};
`, "utf-8");

  const fleetId = "fleet-replace-rollback";
  const oldLeaf = makeLeaf(repoRoot, 1, {
    issue_number: 577,
    leaf_ref: "leaf-old",
    leaf_id: "leaf-old",
    branch: "issue-577-leaf-old",
  });
  const newLeaf = makeLeaf(repoRoot, 2, {
    issue_number: oldLeaf.issue_number,
    leaf_ref: "leaf-new",
    leaf_id: "leaf-new",
    branch: "issue-577-leaf-new",
  });
  const leavesFile = writeLeavesFile(repoRoot, [newLeaf]);
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{
      leaf_ref: oldLeaf.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
      last_error: "old pre-manifest failure",
    }],
  });
  writePersistedFleetLeaves(repoRoot, fleetId, [oldLeaf]);
  const manifestPath = getFleetManifestPath(repoRoot, fleetId);
  const leavesStorePath = getFleetLeavesStorePath(repoRoot, fleetId);
  const manifestBefore = fs.readFileSync(manifestPath, "utf-8");
  const storeBefore = fs.readFileSync(leavesStorePath, "utf-8");
  const nodeOptions = [
    process.env.NODE_OPTIONS,
    `--require=${preloadScript}`,
  ].filter(Boolean).join(" ");

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--json",
  ], {
    relayHome,
    env: {
      NODE_OPTIONS: nodeOptions,
      RELAY_FLEET_FAIL_RENAME_DEST: leavesStorePath,
    },
  });

  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).error, "simulated leaves store write failure");
  assert.equal(fs.readFileSync(manifestPath, "utf-8"), manifestBefore);
  assert.equal(fs.readFileSync(leavesStorePath, "utf-8"), storeBefore);
});

test("relay-fleet persisted-only resume dispatches the replacement after an interrupted manifest rename", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-replace-crash-recovery-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-replace-crash-recovery-hook-"));
  const preloadPath = path.join(tmpDir, "kill-before-leaves-rename.js");
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const fleetId = "fleet-replace-crash-recovery";
  const oldLeaf = makeLeaf(repoRoot, 1, {
    issue_number: 598,
    leaf_ref: "leaf-old",
    leaf_id: "leaf-old",
    branch: "issue-598-leaf-old",
  });
  const newLeaf = makeLeaf(repoRoot, 2, {
    issue_number: oldLeaf.issue_number,
    leaf_ref: "leaf-new",
    leaf_id: "leaf-new",
    branch: "issue-598-leaf-new",
  });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{
      leaf_ref: oldLeaf.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
      last_error: "old pre-manifest failure",
    }],
  });
  writePersistedFleetLeaves(repoRoot, fleetId, [oldLeaf]);
  const leavesFile = writeLeavesFile(repoRoot, [newLeaf]);
  const leavesStorePath = getFleetLeavesStorePath(repoRoot, fleetId);
  const journalPath = getFleetLeafReplacementPath(repoRoot, fleetId);
  fs.writeFileSync(preloadPath, `const fs = require("node:fs");
const path = require("node:path");
const originalRenameSync = fs.renameSync;

fs.renameSync = function killBeforeLeavesRename(sourcePath, destPath) {
  if (path.resolve(String(destPath)) === path.resolve(process.env.RELAY_FLEET_KILL_RENAME_DEST)) {
    process.kill(process.pid, "SIGKILL");
  }
  return originalRenameSync.apply(this, arguments);
};
`, "utf-8");

  const interrupted = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--json",
  ], {
    relayHome,
    env: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(" "),
      RELAY_FLEET_KILL_RENAME_DEST: leavesStorePath,
    },
  });

  assert.equal(interrupted.signal, "SIGKILL");
  assert.equal(fs.existsSync(journalPath), true);
  assert.deepEqual(readFleetManifest(repoRoot, fleetId).data.children, [{
    leaf_ref: newLeaf.leaf_ref,
    run_id: null,
    dispatch_status: DISPATCH_STATUS.PENDING,
  }]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(leavesStorePath, "utf-8")).leaves.map((leaf) => leaf.leaf_ref),
    [oldLeaf.leaf_ref]
  );

  const recovered = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_LOG: dispatchLog },
  });

  assert.equal(recovered.status, 0, `${recovered.stderr}\n${recovered.stdout}`);
  assert.equal(fs.existsSync(journalPath), false);
  assert.deepEqual(JSON.parse(recovered.stdout).replaced_children, [{
    old_leaf_ref: oldLeaf.leaf_ref,
    new_leaf_ref: newLeaf.leaf_ref,
    issue_number: oldLeaf.issue_number,
  }]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(leavesStorePath, "utf-8")).leaves.map((leaf) => leaf.leaf_ref),
    [newLeaf.leaf_ref]
  );
  const dispatchEntries = readJsonLines(dispatchLog).filter((entry) => !entry.detachedChild);
  assert.equal(dispatchEntries.length, 1);
  assert.equal(dispatchEntries[0].branch, newLeaf.branch);
});

test("relay-fleet replacement matrix fails closed when a divergent child has a run id", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-replace-runid-denied-");
  const fleetId = "fleet-replace-runid-denied";
  const oldLeaf = makeLeaf(repoRoot, 1, {
    issue_number: 574,
    leaf_ref: "leaf-old",
    leaf_id: "leaf-old",
    branch: "issue-574-leaf-old",
  });
  const newLeaf = makeLeaf(repoRoot, 2, {
    issue_number: oldLeaf.issue_number,
    leaf_ref: "leaf-new",
    leaf_id: "leaf-new",
    branch: "issue-574-leaf-new",
  });
  const runId = writeChildRun(repoRoot, {
    runId: "issue-574-20260517010101000-a1b2c3d4",
    branch: oldLeaf.branch,
    issueNumber: oldLeaf.issue_number,
    leafId: oldLeaf.leaf_id,
    fleetId,
  });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: oldLeaf.leaf_ref, run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  writePersistedFleetLeaves(repoRoot, fleetId, [oldLeaf]);
  const manifestBefore = fs.readFileSync(getFleetManifestPath(repoRoot, fleetId), "utf-8");
  const storeBefore = fs.readFileSync(getFleetLeavesStorePath(repoRoot, fleetId), "utf-8");
  const leavesFile = writeLeavesFile(repoRoot, [newLeaf]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0);
  assert.equal(
    JSON.parse(result.stderr).error,
    "--leaves-file differs from persisted fleet leaves for 'fleet-replace-runid-denied'; refusing to overwrite an existing fleet"
  );
  assert.equal(fs.readFileSync(getFleetManifestPath(repoRoot, fleetId), "utf-8"), manifestBefore);
  assert.equal(fs.readFileSync(getFleetLeavesStorePath(repoRoot, fleetId), "utf-8"), storeBefore);
});

test("relay-fleet replacement matrix fails closed when a divergent run_id-null child is dispatching", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-replace-dispatching-denied-");
  const fleetId = "fleet-replace-dispatching-denied";
  const oldLeaf = makeLeaf(repoRoot, 1, {
    issue_number: 575,
    leaf_ref: "leaf-old",
    leaf_id: "leaf-old",
    branch: "issue-575-leaf-old",
  });
  const newLeaf = makeLeaf(repoRoot, 2, {
    issue_number: oldLeaf.issue_number,
    leaf_ref: "leaf-new",
    leaf_id: "leaf-new",
    branch: "issue-575-leaf-new",
  });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: oldLeaf.leaf_ref, run_id: null, dispatch_status: DISPATCH_STATUS.DISPATCHING }],
  });
  writePersistedFleetLeaves(repoRoot, fleetId, [oldLeaf]);
  const manifestBefore = fs.readFileSync(getFleetManifestPath(repoRoot, fleetId), "utf-8");
  const storeBefore = fs.readFileSync(getFleetLeavesStorePath(repoRoot, fleetId), "utf-8");
  const leavesFile = writeLeavesFile(repoRoot, [newLeaf]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--leaves-file", leavesFile,
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0);
  assert.equal(
    JSON.parse(result.stderr).error,
    "--leaves-file differs from persisted fleet leaves for 'fleet-replace-dispatching-denied'; refusing to overwrite an existing fleet"
  );
  assert.equal(fs.readFileSync(getFleetManifestPath(repoRoot, fleetId), "utf-8"), manifestBefore);
  assert.equal(fs.readFileSync(getFleetLeavesStorePath(repoRoot, fleetId), "utf-8"), storeBefore);
});

test("relay-fleet replacement matrix leaves fleet-id-only invocation on persisted leaves unchanged", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-replace-fleet-id-only-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-replace-fleet-id-only-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const fleetId = "fleet-replace-fleet-id-only";
  const leaf = makeLeaf(repoRoot, 1, {
    issue_number: 576,
    leaf_ref: "leaf-old",
    leaf_id: "leaf-old",
    branch: "issue-576-leaf-old",
  });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{
      leaf_ref: leaf.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
      last_error: "old pre-manifest failure",
    }],
  });
  writePersistedFleetLeaves(repoRoot, fleetId, [leaf]);
  const storeBefore = fs.readFileSync(getFleetLeavesStorePath(repoRoot, fleetId), "utf-8");

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_LOG: dispatchLog },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.replaced_children, []);
  const dispatchEntries = readJsonLines(dispatchLog).filter((entry) => !entry.detachedChild);
  assert.equal(dispatchEntries.length, 1);
  assert.equal(dispatchEntries[0].branch, leaf.branch);
  assert.equal(fs.readFileSync(getFleetLeavesStorePath(repoRoot, fleetId), "utf-8"), storeBefore);
});

test("relay-fleet with only fleet-id continues ready children through merge and close", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-drive-fleet-id-only-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drive-fleet-id-only-fake-"));
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const finalizeLog = path.join(tmpDir, "finalize.log");
  const runId = writeChildRun(repoRoot, {
    runId: "issue-566-20260516010101000-a1b2c3d4",
    branch: "issue-566-leaf-a",
    issueNumber: 566,
    leafId: "leaf-a",
    fleetId: "fleet-id-only",
    state: RUN_STATES.READY_TO_MERGE,
  });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-id-only",
    children: [{ leaf_ref: "leaf-a", run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  advanceFleetManifestState(repoRoot, "fleet-id-only", FLEET_STATES.REVIEWING);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-id-only",
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_FINALIZE_LOG: finalizeLog },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.summary.fleet_state, FLEET_STATES.CLOSED);
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.state, RUN_STATES.MERGED);
  assert.deepEqual(readJsonLines(finalizeLog).map((entry) => entry.runId), [runId]);
});

test("relay-fleet with only fleet-id and no manifest fails closed with nothing to continue", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-drive-no-manifest-");

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-missing",
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nothing to continue/);
});

test("relay-fleet --resume is accepted as a deprecated alias of the default drive", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-drive-resume-alias-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drive-resume-alias-fake-"));
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const runId = writeChildRun(repoRoot, {
    runId: "issue-567-20260516010101000-a1b2c3d4",
    branch: "issue-567-leaf-a",
    issueNumber: 567,
    leafId: "leaf-a",
    fleetId: "fleet-resume-alias",
    state: RUN_STATES.READY_TO_MERGE,
  });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-resume-alias",
    children: [{ leaf_ref: "leaf-a", run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  advanceFleetManifestState(repoRoot, "fleet-resume-alias", FLEET_STATES.REVIEWING);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-resume-alias",
    "--resume",
    "--finalize-script", finalizeScript,
    "--json",
  ], { relayHome });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout).summary.fleet_state, FLEET_STATES.CLOSED);
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.state, RUN_STATES.MERGED);
});

test("relay-fleet closes with nonzero attention when one child escalates and the rest merge", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-drive-escalated-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drive-escalated-fake-"));
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const finalizeLog = path.join(tmpDir, "finalize.log");
  const readyRun = writeChildRun(repoRoot, {
    runId: "issue-568-20260516010101000-a1b2c3d4",
    branch: "issue-568-leaf-a",
    issueNumber: 568,
    leafId: "leaf-a",
    fleetId: "fleet-escalated",
    state: RUN_STATES.READY_TO_MERGE,
  });
  const escalatedRun = writeChildRun(repoRoot, {
    runId: "issue-569-20260516010101000-a1b2c3d4",
    branch: "issue-569-leaf-b",
    issueNumber: 569,
    leafId: "leaf-b",
    fleetId: "fleet-escalated",
    state: RUN_STATES.ESCALATED,
  });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-escalated",
    children: [
      { leaf_ref: "leaf-a", run_id: readyRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-b", run_id: escalatedRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
    ],
  });
  advanceFleetManifestState(repoRoot, "fleet-escalated", FLEET_STATES.REVIEWING);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-escalated",
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_FINALIZE_LOG: finalizeLog },
  });

  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.summary.fleet_state, FLEET_STATES.CLOSED);
  assert.equal(readManifest(getManifestPath(repoRoot, readyRun)).data.state, RUN_STATES.MERGED);
  assert.equal(readManifest(getManifestPath(repoRoot, escalatedRun)).data.state, RUN_STATES.ESCALATED);
  assert.equal(payload.operator_attention.some((item) => item.run_id === escalatedRun && item.reason === "escalated"), true);
  assert.deepEqual(readJsonLines(finalizeLog).map((entry) => entry.runId), [readyRun]);
});

test("relay-fleet keeps merge_blocked fleets open and later re-runs close after operator unblocks", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-drive-merge-blocked-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drive-merge-blocked-fake-"));
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const finalizeConfig = path.join(tmpDir, "finalize-config.json");
  const runA = writeChildRun(repoRoot, {
    runId: "issue-570-20260516010101000-a1b2c3d4",
    branch: "issue-570-leaf-a",
    issueNumber: 570,
    leafId: "leaf-a",
    fleetId: "fleet-merge-blocked",
    state: RUN_STATES.READY_TO_MERGE,
  });
  const runB = writeChildRun(repoRoot, {
    runId: "issue-571-20260516010101000-a1b2c3d4",
    branch: "issue-571-leaf-b",
    issueNumber: 571,
    leafId: "leaf-b",
    fleetId: "fleet-merge-blocked",
    state: RUN_STATES.READY_TO_MERGE,
  });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-merge-blocked",
    children: [
      { leaf_ref: "leaf-a", run_id: runA, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-b", run_id: runB, dispatch_status: DISPATCH_STATUS.DISPATCHED },
    ],
  });
  advanceFleetManifestState(repoRoot, "fleet-merge-blocked", FLEET_STATES.REVIEWING);
  writeJson(finalizeConfig, { [runB]: { fail: true, error: "fake blocked merge" } });

  const blocked = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-merge-blocked",
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_FINALIZE_CONFIG: finalizeConfig },
  });

  assert.equal(blocked.status, 1, `${blocked.stderr}\n${blocked.stdout}`);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.summary.fleet_state, FLEET_STATES.MERGING);
  assert.equal(readFleetManifest(repoRoot, "fleet-merge-blocked").data.fleet_state, FLEET_STATES.MERGING);
  assert.equal(readManifest(getManifestPath(repoRoot, runA)).data.state, RUN_STATES.MERGED);
  assert.equal(readManifest(getManifestPath(repoRoot, runB)).data.state, RUN_STATES.MERGE_BLOCKED);
  assert.equal(blockedPayload.operator_attention.some((item) => item.run_id === runB && item.reason === "merge_blocked"), true);

  const record = readManifest(getManifestPath(repoRoot, runB));
  writeManifest(
    getManifestPath(repoRoot, runB),
    updateManifestState(record.data, RUN_STATES.READY_TO_MERGE, "operator_unblocked"),
    record.body
  );
  writeJson(finalizeConfig, {});
  const resumed = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-merge-blocked",
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_FINALIZE_CONFIG: finalizeConfig },
  });

  assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
  const resumedPayload = JSON.parse(resumed.stdout);
  assert.equal(resumedPayload.summary.fleet_state, FLEET_STATES.CLOSED);
  assert.equal(readManifest(getManifestPath(repoRoot, runB)).data.state, RUN_STATES.MERGED);
});

test("relay-fleet rejects duplicate issue listed twice in the same fleet", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-dupe-");
  const dispatchScript = writeFakeDispatchScript(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-")));
  const leavesFile = writeLeavesFile(repoRoot, [
    makeLeaf(repoRoot, 1, { issue_number: 481, leaf_ref: "leaf-a", leaf_id: "leaf-a" }),
    makeLeaf(repoRoot, 2, { issue_number: 481, leaf_ref: "leaf-b", leaf_id: "leaf-b" }),
  ]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-duplicate",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate issue_number 481/);
  assert.equal(fs.existsSync(getFleetManifestPath(repoRoot, "fleet-duplicate")), false);
});

test("relay-fleet honors a racing fleet issue lock before spawning the duplicate child", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-race-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const logPath = path.join(tmpDir, "dispatch.log");
  const leavesFile = writeLeavesFile(repoRoot, [makeLeaf(repoRoot, 1, { issue_number: 482 })]);
  const lock = acquireIssueLock({
    repoRoot,
    issueNumber: 482,
    fleetId: "fleet-other",
    runId: "issue-482-20260514010101000-a1b2c3d4",
  });

  try {
    const result = runFleet([
      "--repo", repoRoot,
      "--fleet-id", "fleet-race",
      "--leaves-file", leavesFile,
      "--dispatch-script", dispatchScript,
      "--json",
    ], {
      relayHome,
      env: { FAKE_DISPATCH_LOG: logPath },
    });

    assert.notEqual(result.status, 0);
    const fleet = readFleetManifest(repoRoot, "fleet-race").data;
    assert.equal(fleet.children.length, 1);
    assert.equal(fleet.children[0].leaf_ref, "leaf-01");
    assert.equal(fleet.children[0].run_id, null);
    assert.equal(fleet.children[0].dispatch_status, DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST);
    assert.match(fleet.children[0].last_error, /Refusing to dispatch: fleet issue lock is already held/);
    assert.equal(readJsonLines(logPath).length, 0);
  } finally {
    releaseIssueLock(lock);
  }
});

test("relay-fleet records and resumes a child dispatch that fails before manifest creation", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-premanifest-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const configPath = path.join(tmpDir, "config.json");
  const failedLeaf = makeLeaf(repoRoot, 1, { issue_number: 483, leaf_ref: "leaf-failed", leaf_id: "leaf-failed" });
  const healthyLeaf = makeLeaf(repoRoot, 2, { issue_number: 484, leaf_ref: "leaf-healthy", leaf_id: "leaf-healthy" });
  const leavesFile = writeLeavesFile(repoRoot, [failedLeaf, healthyLeaf]);
  writeJson(configPath, { [failedLeaf.branch]: { fail_before_manifest: true } });

  const failed = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-premanifest",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_CONFIG: configPath },
  });

  assert.notEqual(failed.status, 0);
  const failedPayload = JSON.parse(failed.stdout);
  const failedSummaryChild = failedPayload.summary.children.find((child) => child.leaf_ref === failedLeaf.leaf_ref);
  assert.equal(failedSummaryChild.last_error, "fake pre-manifest failure");
  const afterFailed = readFleetManifest(repoRoot, "fleet-premanifest").data.children;
  const failedChild = afterFailed.find((child) => child.leaf_ref === failedLeaf.leaf_ref);
  const healthyChild = afterFailed.find((child) => child.leaf_ref === healthyLeaf.leaf_ref);
  assert.equal(failedChild.dispatch_status, DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST);
  assert.equal(failedChild.last_error, "fake pre-manifest failure");
  assert.equal(healthyChild.dispatch_status, DISPATCH_STATUS.DISPATCHED);
  assert.equal(Object.hasOwn(healthyChild, "last_error"), false);

  const statusJson = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-premanifest",
    "--status",
    "--json",
  ], { relayHome });
  assert.equal(statusJson.status, 0, statusJson.stderr);
  const statusPayload = JSON.parse(statusJson.stdout);
  assert.equal(
    statusPayload.summary.children.find((child) => child.leaf_ref === failedLeaf.leaf_ref).last_error,
    "fake pre-manifest failure"
  );

  const statusText = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-premanifest",
    "--status",
  ], { relayHome });
  assert.equal(statusText.status, 0, statusText.stderr);
  assert.match(
    statusText.stdout,
    /leaf-failed \| run_id=null \| dispatch_status=dispatch_failed_pre_manifest \| run_state=no_run_manifest \| last_error=fake pre-manifest failure/
  );

  writeJson(configPath, {});
  const resumed = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-premanifest",
    "--resume",
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_CONFIG: configPath },
  });

  assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
  const child = readFleetManifest(repoRoot, "fleet-premanifest").data.children
    .find((entry) => entry.leaf_ref === failedLeaf.leaf_ref);
  assert.equal(child.dispatch_status, DISPATCH_STATUS.DISPATCHED);
  assert.match(child.run_id, /^issue-483-/);
  assert.equal(Object.hasOwn(child, "last_error"), false);
  assert.equal(readManifest(getManifestPath(repoRoot, child.run_id)).data.state, RUN_STATES.MERGED);
  assert.equal(readFleetManifest(repoRoot, "fleet-premanifest").data.fleet_state, FLEET_STATES.CLOSED);
});

test("relay-fleet records last_error when dispatch returns a run id but exits nonzero", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-runid-failure-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const configPath = path.join(tmpDir, "config.json");
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 485 });
  const leavesFile = writeLeavesFile(repoRoot, [leaf]);
  writeJson(configPath, {
    [leaf.branch]: {
      fail_parent_after_run_id: true,
      stderr: "fake parent failure after run id\nsecond line\n",
      exit_code: 19,
    },
  });

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-runid-failure",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_CONFIG: configPath },
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.children[0].status, "dispatched_with_child_failure");
  assert.equal(payload.children[0].error, null);
  assert.match(payload.children[0].run_id, /^issue-485-/);
  const child = readFleetManifest(repoRoot, "fleet-runid-failure").data.children[0];
  assert.match(child.run_id, /^issue-485-/);
  assert.equal(child.dispatch_status, DISPATCH_STATUS.PENDING);
  assert.equal(child.last_error, "fake parent failure after run id second line");
  assert.equal(payload.summary.children[0].last_error, "fake parent failure after run id second line");
});

test("relay-fleet records dispatch JSON error payloads as last_error when stderr is empty", () => {
  const preManifestSetup = setupRepo("relay-fleet-json-premanifest-");
  const preManifestTmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const preManifestDispatchScript = writeFakeDispatchScript(preManifestTmp);
  const preManifestConfig = path.join(preManifestTmp, "config.json");
  const preManifestLeaf = makeLeaf(preManifestSetup.repoRoot, 1, { issue_number: 486 });
  const preManifestLeavesFile = writeLeavesFile(preManifestSetup.repoRoot, [preManifestLeaf]);
  writeJson(preManifestConfig, {
    [preManifestLeaf.branch]: {
      fail_before_manifest: true,
      json_failure_error: "json pre-manifest validation failure",
    },
  });

  const preManifestResult = runFleet([
    "--repo", preManifestSetup.repoRoot,
    "--fleet-id", "fleet-json-premanifest",
    "--leaves-file", preManifestLeavesFile,
    "--dispatch-script", preManifestDispatchScript,
    "--json",
  ], {
    relayHome: preManifestSetup.relayHome,
    env: { FAKE_DISPATCH_CONFIG: preManifestConfig },
  });

  assert.notEqual(preManifestResult.status, 0);
  const preManifestPayload = JSON.parse(preManifestResult.stdout);
  assert.equal(preManifestPayload.children[0].status, "dispatch_failed_pre_manifest");
  const preManifestChild = readFleetManifest(preManifestSetup.repoRoot, "fleet-json-premanifest").data.children[0];
  assert.equal(preManifestChild.run_id, null);
  assert.equal(preManifestChild.dispatch_status, DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST);
  assert.equal(preManifestChild.last_error, "json pre-manifest validation failure");
  assert.equal(preManifestPayload.summary.children[0].last_error, "json pre-manifest validation failure");

  const runIdSetup = setupRepo("relay-fleet-json-runid-failure-");
  const runIdTmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const runIdDispatchScript = writeFakeDispatchScript(runIdTmp);
  const runIdConfig = path.join(runIdTmp, "config.json");
  const runIdLeaf = makeLeaf(runIdSetup.repoRoot, 1, { issue_number: 487 });
  const runIdLeavesFile = writeLeavesFile(runIdSetup.repoRoot, [runIdLeaf]);
  writeJson(runIdConfig, {
    [runIdLeaf.branch]: {
      fail_parent_after_run_id: true,
      json_failure_error: "json run id launch failure",
      exit_code: 19,
    },
  });

  const runIdResult = runFleet([
    "--repo", runIdSetup.repoRoot,
    "--fleet-id", "fleet-json-runid-failure",
    "--leaves-file", runIdLeavesFile,
    "--dispatch-script", runIdDispatchScript,
    "--json",
  ], {
    relayHome: runIdSetup.relayHome,
    env: { FAKE_DISPATCH_CONFIG: runIdConfig },
  });

  assert.notEqual(runIdResult.status, 0);
  const runIdPayload = JSON.parse(runIdResult.stdout);
  assert.equal(runIdPayload.children[0].status, "dispatched_with_child_failure");
  assert.match(runIdPayload.children[0].run_id, /^issue-487-/);
  const runIdChild = readFleetManifest(runIdSetup.repoRoot, "fleet-json-runid-failure").data.children[0];
  assert.match(runIdChild.run_id, /^issue-487-/);
  assert.equal(runIdChild.dispatch_status, DISPATCH_STATUS.PENDING);
  assert.equal(runIdChild.last_error, "json run id launch failure");
  assert.equal(runIdPayload.summary.children[0].last_error, "json run id launch failure");
});

test("relay-fleet text summary states same-command retry contract only for pre-manifest failures", () => {
  const failedSetup = setupRepo("relay-fleet-retry-summary-failed-");
  const failedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const failedDispatchScript = writeFakeDispatchScript(failedTmp);
  const failedConfig = path.join(failedTmp, "config.json");
  const failedLeaf = makeLeaf(failedSetup.repoRoot, 1, { issue_number: 486, leaf_ref: "leaf-summary-failed" });
  const failedLeavesFile = writeLeavesFile(failedSetup.repoRoot, [failedLeaf]);
  writeJson(failedConfig, { [failedLeaf.branch]: { fail_before_manifest: true } });

  const failed = runFleet([
    "--repo", failedSetup.repoRoot,
    "--fleet-id", "fleet-retry-summary",
    "--leaves-file", failedLeavesFile,
    "--dispatch-script", failedDispatchScript,
  ], {
    relayHome: failedSetup.relayHome,
    env: { FAKE_DISPATCH_CONFIG: failedConfig },
  });

  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /relay-fleet needs attention: fleet=fleet-retry-summary children=1/);
  assert.match(failed.stdout, /leaf-summary-failed/);
  assert.match(failed.stdout, /re-run/);
  assert.match(failed.stdout, /same command/);
  assert.match(failed.stdout, /--fleet-id fleet-retry-summary/);

  const cleanSetup = setupRepo("relay-fleet-retry-summary-clean-");
  const cleanTmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const cleanDispatchScript = writeFakeDispatchScript(cleanTmp);
  const cleanReviewScript = writeFakeReviewScript(cleanTmp);
  const cleanFinalizeScript = writeFakeFinalizeScript(cleanTmp);
  const cleanLeavesFile = writeLeavesFile(cleanSetup.repoRoot, [
    makeLeaf(cleanSetup.repoRoot, 1, { issue_number: 487, leaf_ref: "leaf-summary-clean" }),
  ]);

  const clean = runFleet([
    "--repo", cleanSetup.repoRoot,
    "--fleet-id", "fleet-retry-summary-clean",
    "--leaves-file", cleanLeavesFile,
    "--dispatch-script", cleanDispatchScript,
    "--review-script", cleanReviewScript,
    "--finalize-script", cleanFinalizeScript,
  ], { relayHome: cleanSetup.relayHome });

  assert.equal(clean.status, 0, `${clean.stderr}\n${clean.stdout}`);
  assert.doesNotMatch(clean.stdout, /re-run/);
});

test("relay-fleet launches leaf dispatch with --detach and leaves child progress independent of the fleet supervisor", async () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-detach-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const configPath = path.join(tmpDir, "config.json");
  const logPath = path.join(tmpDir, "dispatch.log");
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 802 });
  const leavesFile = writeLeavesFile(repoRoot, [leaf]);
  writeJson(configPath, {
    [leaf.branch]: {
      delay_before_manifest_ms: 900,
      delay_after_manifest_ms: 5000,
      run_state: "dispatched",
      transition_after_delay_to: "review_pending",
    },
  });

  const started = Date.now();
  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-detach",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_DISPATCH_CONFIG: configPath,
      FAKE_DISPATCH_LOG: logPath,
    },
    timeout: 15000,
  });
  const elapsedMs = Date.now() - started;

  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.children[0].status, "dispatch_poll_timeout");
  assert.ok(elapsedMs < 12000, `fleet should not wait for detached child tail delay; elapsed=${elapsedMs}`);
  const logs = readJsonLines(logPath);
  assert.ok(logs.some((entry) => entry.args.includes("--detach")), "fleet must pass --detach to dispatch.js");
  assert.ok(logs.some((entry) => entry.detachedChild), "fake detached child must start outside the fleet launcher");
  const fleet = readFleetManifest(repoRoot, "fleet-detach").data;
  const child = fleet.children[0];
  assert.equal(child.dispatch_status, DISPATCH_STATUS.DISPATCHING);
  assert.match(child.run_id, /^issue-802-/);
  const manifestPath = getManifestPath(repoRoot, child.run_id);
  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, RUN_STATES.DISPATCHED);

  await waitFor(() => readManifest(manifestPath).data.state === RUN_STATES.REVIEW_PENDING, {
    timeoutMs: 12000,
    intervalMs: 100,
  });
});

test("relay-fleet keeps live incomplete detached dispatches retry-safe", async () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-incomplete-detach-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const configPath = path.join(tmpDir, "config.json");
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 803 });
  const leavesFile = writeLeavesFile(repoRoot, [leaf]);
  writeJson(configPath, {
    [leaf.branch]: {
      delay_after_manifest_ms: 1500,
      run_state: "dispatched",
      transition_after_delay_to: "review_pending",
    },
  });

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-incomplete-detach",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_DISPATCH_CONFIG: configPath,
      RELAY_FLEET_DISPATCH_POLL_TIMEOUT_MS: "300",
    },
  });

  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.children[0].status, "dispatch_poll_timeout");
  const fleet = readFleetManifest(repoRoot, "fleet-incomplete-detach").data;
  const child = fleet.children[0];
  assert.equal(child.dispatch_status, DISPATCH_STATUS.DISPATCHING);
  assert.match(child.run_id, /^issue-803-/);
  assert.ok(fs.existsSync(getFleetRuntimePath(repoRoot, "fleet-incomplete-detach")));

  const manifestPath = getManifestPath(repoRoot, child.run_id);
  await waitFor(() => readManifest(manifestPath).data.state === RUN_STATES.REVIEW_PENDING, {
    timeoutMs: 5000,
    intervalMs: 50,
  });
});

test("relay-fleet never row-4 reconciles a live unexpired lease, including at poll-budget exhaustion", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-live-lease-budget-");
  const fleetId = "fleet-live-lease-budget";
  const runId = "issue-876-20260710010101000-a1b2c3d4";
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 876, leaf_ref: "leaf-live-lease" });
  writeChildRun(repoRoot, {
    runId,
    branch: leaf.branch,
    issueNumber: leaf.issue_number,
    leafId: leaf.leaf_id,
    fleetId,
    state: RUN_STATES.DISPATCHED,
  });
  const runDir = getRunDir(repoRoot, runId);
  const resultPath = path.join(runDir, "dispatch-result.txt");
  fs.writeFileSync(resultPath, "mid-work snapshot that must not be recovered\n", "utf-8");
  fs.writeFileSync(path.join(runDir, "lease.json"), `${JSON.stringify({
    pid: process.pid,
    pgid: 999999,
    host: os.hostname(),
    started_at: new Date().toISOString(),
    timeout_s: 3600,
  }, null, 2)}\n`, "utf-8");
  fs.mkdirSync(path.dirname(getFleetLeavesStorePath(repoRoot, fleetId)), { recursive: true });
  writePersistedFleetLeaves(repoRoot, fleetId, [leaf]);
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHING }],
  });
  advanceFleetManifestState(repoRoot, fleetId, FLEET_STATES.DISPATCHING);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--resume",
    "--json",
  ], {
    relayHome,
    env: { RELAY_FLEET_DISPATCH_POLL_TIMEOUT_MS: "300" },
    timeout: 30000,
  });

  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dispatch_children[0].status, "dispatch_still_running");
  assert.equal(payload.dispatch_children[0].reconcile.rowName, "lease_live_within_timeout");
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.state, RUN_STATES.DISPATCHED);
  assert.equal(fs.readFileSync(resultPath, "utf-8"), "mid-work snapshot that must not be recovered\n");
  assert.equal(
    readFleetManifest(repoRoot, fleetId).data.children[0].dispatch_status,
    DISPATCH_STATUS.DISPATCHING
  );
});

test("relay-fleet treats detached terminal child states as failed dispatch outcomes", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-terminal-detach-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-terminal-detach-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const configPath = path.join(tmpDir, "config.json");
  const escalatedLeaf = makeLeaf(repoRoot, 1, { issue_number: 805 });
  const closedLeaf = makeLeaf(repoRoot, 2, { issue_number: 806 });
  const leavesFile = writeLeavesFile(repoRoot, [escalatedLeaf, closedLeaf]);
  writeJson(configPath, {
    [escalatedLeaf.branch]: {
      delay_before_manifest_ms: 100,
      run_state: "dispatched",
      transition_after_delay_to: "escalated",
    },
    [closedLeaf.branch]: {
      delay_before_manifest_ms: 100,
      run_state: "dispatched",
      transition_after_delay_to: "closed",
    },
  });

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-terminal-detach",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_CONFIG: configPath },
  });

  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.deepEqual(output.children.map((child) => [child.leaf_ref, child.status, child.run_state]), [
    [escalatedLeaf.leaf_ref, "dispatch_terminal_failure", RUN_STATES.ESCALATED],
    [closedLeaf.leaf_ref, "dispatch_terminal_failure", RUN_STATES.CLOSED],
  ]);
  assert.equal(output.summary.by_dispatch_status[DISPATCH_STATUS.PENDING], 2);
  assert.equal(output.summary.by_run_state[RUN_STATES.ESCALATED], 1);
  assert.equal(output.summary.by_run_state[RUN_STATES.CLOSED], 1);

  const fleet = readFleetManifest(repoRoot, "fleet-terminal-detach").data;
  assert.deepEqual(fleet.children.map((child) => child.dispatch_status), [
    DISPATCH_STATUS.PENDING,
    DISPATCH_STATUS.PENDING,
  ]);
});

test("relay-fleet --resume polls existing dispatching detached child runs before returning ok", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-resume-detached-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-resume-detached-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const reviewLog = path.join(tmpDir, "review.log");
  const fleetId = "fleet-resume-detached";
  const runId = "issue-804-20260515010101000-a1b2c3d4";
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 804 });

  writeChildRun(repoRoot, {
    runId,
    branch: leaf.branch,
    issueNumber: leaf.issue_number,
    leafId: leaf.leaf_id,
    fleetId,
    state: RUN_STATES.DISPATCHED,
  });
  fs.writeFileSync(path.join(getRunDir(repoRoot, runId), "dispatch-result.txt"), "executor finished before supervisor death\n", "utf-8");
  const leavesStorePath = getFleetLeavesStorePath(repoRoot, fleetId);
  fs.mkdirSync(path.dirname(leavesStorePath), { recursive: true });
  writeJson(leavesStorePath, { fleet_id: fleetId, leaves: [leaf] });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHING }],
  });
  advanceFleetManifestState(repoRoot, fleetId, FLEET_STATES.DISPATCHING);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--resume",
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_REVIEW_LOG: reviewLog },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dispatch_children.length, 1);
  assert.equal(payload.dispatch_children[0].status, "dispatched");
  assert.equal(payload.dispatch_children[0].reconcile.rowName, "dead_with_result_or_work");
  assert.equal(readJsonLines(reviewLog).length, 1);
  const child = readFleetManifest(repoRoot, fleetId).data.children[0];
  assert.equal(child.dispatch_status, DISPATCH_STATUS.DISPATCHED);
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.state, RUN_STATES.MERGED);
  assert.equal(readFleetManifest(repoRoot, fleetId).data.fleet_state, FLEET_STATES.CLOSED);
});

test("relay-fleet keeps manifest consistent when child 3 of 5 fails before manifest creation", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-partial-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const configPath = path.join(tmpDir, "config.json");
  const leaves = Array.from({ length: 5 }, (_, index) => makeLeaf(repoRoot, index + 1, {
    issue_number: 490 + index,
  }));
  writeJson(configPath, { [leaves[2].branch]: { fail_before_manifest: true } });
  const leavesFile = writeLeavesFile(repoRoot, leaves);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-partial",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--parallel", "5",
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_CONFIG: configPath },
  });

  assert.notEqual(result.status, 0);
  const fleet = readFleetManifest(repoRoot, "fleet-partial").data;
  assert.equal(fleet.children.length, 5);
  assert.equal(
    fleet.children.filter((child) => child.dispatch_status === DISPATCH_STATUS.DISPATCHED).length,
    4
  );
  assert.equal(
    fleet.children.find((child) => child.leaf_ref === "leaf-03").dispatch_status,
    DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST
  );
  assert.equal(fleet.fleet_state, FLEET_STATES.DISPATCHING);
});

test("relay-fleet continues ready siblings after an initial partial fan-out failure", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-partial-drive-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-partial-drive-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const dispatchConfig = path.join(tmpDir, "dispatch-config.json");
  const reviewLog = path.join(tmpDir, "review.log");
  const finalizeLog = path.join(tmpDir, "finalize.log");
  const readyRunId = "issue-590-20260516010101000-a1b2c3d4";
  const leaves = [
    makeLeaf(repoRoot, 1, {
      issue_number: 590,
      branch: "issue-590-leaf-ready",
      leaf_ref: "leaf-ready",
      leaf_id: "leaf-ready",
    }),
    makeLeaf(repoRoot, 2, {
      issue_number: 591,
      branch: "issue-591-leaf-blocked",
      leaf_ref: "leaf-blocked",
      leaf_id: "leaf-blocked",
    }),
  ];
  writeJson(dispatchConfig, {
    [leaves[0].branch]: { run_id: readyRunId },
    [leaves[1].branch]: { fail_before_manifest: true },
  });
  const leavesFile = writeLeavesFile(repoRoot, leaves);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-partial-drive",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--parallel", "2",
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_DISPATCH_CONFIG: dispatchConfig,
      FAKE_REVIEW_LOG: reviewLog,
      FAKE_FINALIZE_LOG: finalizeLog,
    },
  });

  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(readManifest(getManifestPath(repoRoot, readyRunId)).data.state, RUN_STATES.MERGED);
  assert.deepEqual(readJsonLines(reviewLog).map((entry) => entry.runId), [readyRunId]);
  assert.deepEqual(readJsonLines(finalizeLog).map((entry) => entry.runId), [readyRunId]);
  assert.equal(payload.summary.fleet_state, FLEET_STATES.MERGING);
  assert.equal(payload.summary.by_run_state[RUN_STATES.MERGED], 1);
  assert.equal(
    payload.operator_attention.some((item) => {
      return item.leaf_ref === "leaf-blocked"
        && item.reason === DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST;
    }),
    true
  );
});

test("relay-fleet resume re-adopts orphan child via fleet_id back-pointer", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-orphan-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const runId = "issue-501-20260514010101000-a1b2c3d4";
  createFleetManifest(repoRoot, {
    fleetId: "fleet-orphan",
    children: [{ leaf_ref: "leaf-01", run_id: null, dispatch_status: DISPATCH_STATUS.PENDING }],
  });
  writeChildRun(repoRoot, {
    runId,
    branch: "issue-501-leaf-01",
    issueNumber: 501,
    leafId: "leaf-01",
    fleetId: "fleet-orphan",
    state: RUN_STATES.READY_TO_MERGE,
  });

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-orphan",
    "--resume",
    "--dispatch-script", dispatchScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], { relayHome });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const child = readFleetManifest(repoRoot, "fleet-orphan").data.children[0];
  assert.equal(child.run_id, runId);
  assert.equal(child.dispatch_status, DISPATCH_STATUS.DISPATCHED);
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.state, RUN_STATES.MERGED);
});

test("relay-fleet reconcile adopts orphan in-flight dispatched run as dispatching", () => {
  const { repoRoot } = setupRepo("relay-fleet-orphan-dispatching-");
  const fleetId = "fleet-orphan-dispatching";
  const runId = "issue-807-20260515010101000-a1b2c3d4";
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 807 });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: null, dispatch_status: DISPATCH_STATUS.DISPATCHING }],
  });
  writeChildRun(repoRoot, {
    runId,
    branch: leaf.branch,
    issueNumber: leaf.issue_number,
    leafId: leaf.leaf_id,
    fleetId,
    state: RUN_STATES.DISPATCHED,
  });

  reconcileFleet(repoRoot, fleetId, [leaf]);

  const child = readFleetManifest(repoRoot, fleetId).data.children[0];
  assert.equal(child.run_id, runId);
  assert.equal(child.dispatch_status, DISPATCH_STATUS.DISPATCHING);
});

test("relay-fleet reconcile records last_error for interrupted pre-manifest dispatches", () => {
  const { repoRoot } = setupRepo("relay-fleet-reconcile-premanifest-error-");
  const fleetId = "fleet-reconcile-premanifest-error";
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 809 });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: null, dispatch_status: DISPATCH_STATUS.DISPATCHING }],
  });

  reconcileFleet(repoRoot, fleetId, [leaf]);

  const child = readFleetManifest(repoRoot, fleetId).data.children[0];
  assert.equal(child.run_id, null);
  assert.equal(child.dispatch_status, DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST);
  assert.equal(child.last_error, "dispatch interrupted before creating a run manifest");
});

test("relay-fleet reconcile does not let stale run records replace current child run", () => {
  const { repoRoot } = setupRepo("relay-fleet-stale-record-");
  const fleetId = "fleet-stale-record";
  const staleRunId = "issue-808-20260514010101000-a1b2c3d4";
  const currentRunId = "issue-808-20260515010101000-a1b2c3d4";
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 808 });
  writeChildRun(repoRoot, {
    runId: staleRunId,
    branch: leaf.branch,
    issueNumber: leaf.issue_number,
    leafId: leaf.leaf_id,
    fleetId,
    state: RUN_STATES.READY_TO_MERGE,
  });
  writeChildRun(repoRoot, {
    runId: currentRunId,
    branch: leaf.branch,
    issueNumber: leaf.issue_number,
    leafId: leaf.leaf_id,
    fleetId,
    state: RUN_STATES.DISPATCHED,
  });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: currentRunId, dispatch_status: DISPATCH_STATUS.DISPATCHING }],
  });

  reconcileFleet(repoRoot, fleetId, [leaf]);

  const child = readFleetManifest(repoRoot, fleetId).data.children[0];
  assert.equal(child.run_id, currentRunId);
  assert.equal(child.dispatch_status, DISPATCH_STATUS.DISPATCHING);
});

test("SIGINT during fan-out leaves a consistent fleet manifest and resume recovers", async () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-sigint-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const configPath = path.join(tmpDir, "config.json");
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 502 });
  const leavesFile = writeLeavesFile(repoRoot, [leaf]);
  writeJson(configPath, { [leaf.branch]: { delay_before_manifest_ms: 5000 } });

  const child = spawn(process.execPath, [
    RELAY_FLEET_SCRIPT,
    "--repo", repoRoot,
    "--fleet-id", "fleet-sigint",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], {
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
      RELAY_SOURCE_ROOT: REPO_ROOT,
      FAKE_DISPATCH_CONFIG: configPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitFor(() => {
    const manifestPath = getFleetManifestPath(repoRoot, "fleet-sigint");
    return fs.existsSync(manifestPath)
      && readFleetManifest(repoRoot, "fleet-sigint").data.children[0]?.dispatch_status === DISPATCH_STATUS.DISPATCHING;
  });
  child.kill("SIGINT");
  await new Promise((resolve) => child.on("close", resolve));

  const afterInterrupt = readFleetManifest(repoRoot, "fleet-sigint").data;
  assert.equal(afterInterrupt.children.length, 1);
  assert.ok([
    DISPATCH_STATUS.DISPATCHING,
    DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
  ].includes(afterInterrupt.children[0].dispatch_status));

  writeJson(configPath, {});
  const resumed = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-sigint",
    "--resume",
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_CONFIG: configPath },
  });

  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(
    readFleetManifest(repoRoot, "fleet-sigint").data.children[0].dispatch_status,
    DISPATCH_STATUS.DISPATCHED
  );
});

test("resume while a child subprocess is still running does not double-dispatch", async () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-running-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const logPath = path.join(tmpDir, "dispatch.log");
  const configPath = path.join(tmpDir, "config.json");
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 503 });
  const leavesFile = writeLeavesFile(repoRoot, [leaf]);
  writeJson(configPath, { [leaf.branch]: { delay_after_manifest_ms: 1000 } });

  const first = spawn(process.execPath, [
    RELAY_FLEET_SCRIPT,
    "--repo", repoRoot,
    "--fleet-id", "fleet-running",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
      RELAY_SOURCE_ROOT: REPO_ROOT,
      FAKE_DISPATCH_CONFIG: configPath,
      FAKE_DISPATCH_LOG: logPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitFor(() => readJsonLines(logPath).filter((entry) => !entry.detachedChild).length === 1);
  await waitFor(() => readFleetManifest(repoRoot, "fleet-running").data.children[0]?.dispatch_status === DISPATCH_STATUS.DISPATCHING);

  const resumed = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-running",
    "--resume",
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_DISPATCH_CONFIG: configPath,
      FAKE_DISPATCH_LOG: logPath,
    },
  });

  assert.match(String(resumed.stderr || ""), /^$/);
  const resumedPayload = JSON.parse(resumed.stdout);
  if (resumed.status === 0) {
    assert.equal(resumedPayload.summary.fleet_state, FLEET_STATES.CLOSED);
  } else {
    assert.equal(resumed.status, 1, `${resumed.stderr}\n${resumed.stdout}`);
    assert.equal(resumedPayload.ok, false);
    assert.notEqual(resumedPayload.summary.fleet_state, FLEET_STATES.CLOSED);
  }
  assert.equal(readJsonLines(logPath).filter((entry) => !entry.detachedChild).length, 1);
  await new Promise((resolve) => first.on("close", resolve));
});

test("relay-fleet --dry-run fans out to dispatch dry-run without writing a fleet manifest", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-dry-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const logPath = path.join(tmpDir, "dispatch.log");
  const leaves = [
    makeLeaf(repoRoot, 1, {
      issue_number: 504,
      publish_policy: "after-internal-review",
    }),
    makeLeaf(repoRoot, 2, { issue_number: 505 }),
  ];
  const leavesFile = writeLeavesFile(repoRoot, leaves);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-dry",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--publish-policy", "immediate",
    "--dry-run",
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_LOG: logPath },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.children.length, 2);
  assert.equal(fs.existsSync(getFleetManifestPath(repoRoot, "fleet-dry")), false);
  const dispatchEntries = readJsonLines(logPath);
  assert.equal(dispatchEntries.every((entry) => entry.dryRun && entry.fleetId === "fleet-dry"), true);
  const dispatchByBranch = new Map(dispatchEntries.map((entry) => [entry.branch, entry]));
  const policyFor = (entry) => {
    const index = entry.args.indexOf("--publish-policy");
    return index === -1 ? null : entry.args[index + 1];
  };
  assert.equal(policyFor(dispatchByBranch.get("issue-504-leaf-01")), "after-internal-review");
  assert.equal(policyFor(dispatchByBranch.get("issue-505-leaf-02")), "immediate");
});

test("relay-fleet --review fans out foreground review-runner once per review_pending child", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-review-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-review-fake-"));
  const reviewScript = writeFakeReviewScript(tmpDir);
  const logPath = path.join(tmpDir, "review.log");
  const configPath = path.join(tmpDir, "review-config.json");
  const runA = "issue-520-20260515010101000-a1b2c3d4";
  const runB = "issue-521-20260515010101000-a1b2c3d4";
  writeChildRun(repoRoot, {
    runId: runA,
    branch: "issue-520-leaf-a",
    issueNumber: 520,
    leafId: "leaf-a",
    fleetId: "fleet-review",
    state: RUN_STATES.REVIEW_PENDING,
  });
  writeChildRun(repoRoot, {
    runId: runB,
    branch: "issue-521-leaf-b",
    issueNumber: 521,
    leafId: "leaf-b",
    fleetId: "fleet-review",
    state: RUN_STATES.READY_TO_MERGE,
  });
  writeJson(configPath, { [runA]: { to_state: "ready_to_merge" } });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-review",
    children: [
      { leaf_ref: "leaf-a", run_id: runA, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-b", run_id: runB, dispatch_status: DISPATCH_STATUS.DISPATCHED },
    ],
  });
  advanceFleetManifestState(repoRoot, "fleet-review", FLEET_STATES.DISPATCHED);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-review",
    "--review",
    "--review-script", reviewScript,
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_REVIEW_CONFIG: configPath,
      FAKE_REVIEW_LOG: logPath,
    },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.summary.fleet_state, FLEET_STATES.REVIEWING);
  assert.equal(payload.reviewed_children.length, 1);
  assert.equal(payload.reviewed_children[0].run_id, runA);
  assert.equal(payload.skipped_children.some((child) => child.run_id === runB && child.run_state === RUN_STATES.READY_TO_MERGE), true);
  assert.equal(readJsonLines(logPath).length, 1);
  assert.equal(readManifest(getManifestPath(repoRoot, runA)).data.state, RUN_STATES.READY_TO_MERGE);
});

test("relay-fleet --review fails closed when review-runner exits without advancing manifest", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-review-stall-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-review-stall-fake-"));
  const reviewScript = writeFakeReviewScript(tmpDir);
  const configPath = path.join(tmpDir, "review-config.json");
  const runId = "issue-522-20260515010101000-a1b2c3d4";
  writeChildRun(repoRoot, {
    runId,
    branch: "issue-522-leaf-a",
    issueNumber: 522,
    leafId: "leaf-a",
    fleetId: "fleet-review-stall",
    state: RUN_STATES.REVIEW_PENDING,
  });
  writeJson(configPath, { [runId]: { stall: true } });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-review-stall",
    children: [{ leaf_ref: "leaf-a", run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  advanceFleetManifestState(repoRoot, "fleet-review-stall", FLEET_STATES.DISPATCHED);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-review-stall",
    "--review",
    "--review-script", reviewScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_REVIEW_CONFIG: configPath },
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.reviewed_children[0].status, "review_stalled");
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.state, RUN_STATES.REVIEW_PENDING);
});

test("relay-fleet --review treats child state transitions as manifest progress", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-review-state-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-review-state-fake-"));
  const reviewScript = writeFakeReviewScript(tmpDir);
  const configPath = path.join(tmpDir, "review-config.json");
  const runId = "issue-523-20260515010101000-a1b2c3d4";
  writeChildRun(repoRoot, {
    runId,
    branch: "issue-523-leaf-a",
    issueNumber: 523,
    leafId: "leaf-a",
    fleetId: "fleet-review-state",
    state: RUN_STATES.REVIEW_PENDING,
  });
  writeJson(configPath, { [runId]: { to_state: "ready_to_merge", omit_review_fields: true } });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-review-state",
    children: [{ leaf_ref: "leaf-a", run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  advanceFleetManifestState(repoRoot, "fleet-review-state", FLEET_STATES.DISPATCHED);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-review-state",
    "--review",
    "--review-script", reviewScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_REVIEW_CONFIG: configPath },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.reviewed_children[0].status, "complete");
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.state, RUN_STATES.READY_TO_MERGE);
});

test("relay-fleet --review redispatches a child absent from persisted leaves with fleet options", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-review-loop-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-review-loop-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const reviewLog = path.join(tmpDir, "review.log");
  const configPath = path.join(tmpDir, "review-config.json");
  const runId = "issue-524-20260515010101000-a1b2c3d4";
  writeChildRun(repoRoot, {
    runId,
    branch: "issue-524-leaf-a",
    issueNumber: 524,
    leafId: "leaf-a",
    fleetId: "fleet-review-loop",
    state: RUN_STATES.REVIEW_PENDING,
  });
  writeJson(configPath, {
    [runId]: {
      sequence: [
        { to_state: "changes_requested", verdict: "changes_requested" },
        { to_state: "ready_to_merge", verdict: "lgtm" },
      ],
    },
  });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-review-loop",
    children: [{ leaf_ref: "leaf-a", run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  writePersistedFleetLeaves(repoRoot, "fleet-review-loop", []);
  advanceFleetManifestState(repoRoot, "fleet-review-loop", FLEET_STATES.DISPATCHED);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-review-loop",
    "--review",
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--timeout", "2700",
    "--executor", "claude",
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_DISPATCH_LOG: dispatchLog,
      FAKE_REVIEW_CONFIG: configPath,
      FAKE_REVIEW_LOG: reviewLog,
      FAKE_REVIEW_COUNT_DIR: tmpDir,
    },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.reviewed_children[0].status, "complete");
  assert.deepEqual(payload.reviewed_children[0].steps.map((step) => step.phase), ["review", "redispatch", "review"]);
  assert.equal(readJsonLines(dispatchLog).length, 1);
  const redispatchArgs = readJsonLines(dispatchLog)[0].args;
  assert.match(redispatchArgs.join(" "), /--manifest/);
  assert.equal(flagValue(redispatchArgs, "--timeout"), "2700");
  assert.equal(flagValue(redispatchArgs, "--executor"), "claude");
  assert.equal(readJsonLines(reviewLog).length, 2);
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.state, RUN_STATES.READY_TO_MERGE);
});

test("relay-fleet --resume re-enters the review loop for changes_requested children", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-review-resume-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-review-resume-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const reviewLog = path.join(tmpDir, "review.log");
  const configPath = path.join(tmpDir, "review-config.json");
  const runId = "issue-525-20260515010101000-a1b2c3d4";
  writeChildRun(repoRoot, {
    runId,
    branch: "issue-525-leaf-a",
    issueNumber: 525,
    leafId: "leaf-a",
    fleetId: "fleet-review-resume",
    state: RUN_STATES.REVIEW_PENDING,
  });
  const record = readManifest(getManifestPath(repoRoot, runId));
  writeManifest(getManifestPath(repoRoot, runId), updateManifestState(record.data, RUN_STATES.CHANGES_REQUESTED, "retry"), record.body);
  writeJson(configPath, { [runId]: { to_state: "ready_to_merge", verdict: "lgtm" } });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-review-resume",
    children: [{ leaf_ref: "leaf-a", run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  writePersistedFleetLeaves(repoRoot, "fleet-review-resume", [
    makeLeaf(repoRoot, 1, { leaf_ref: "leaf-a", issue_number: 525, timeout: 5400 }),
  ]);
  advanceFleetManifestState(repoRoot, "fleet-review-resume", FLEET_STATES.REVIEWING);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-review-resume",
    "--resume",
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_DISPATCH_LOG: dispatchLog,
      FAKE_REVIEW_CONFIG: configPath,
      FAKE_REVIEW_LOG: reviewLog,
    },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.reviewed_children[0].status, "complete");
  assert.deepEqual(payload.reviewed_children[0].steps.map((step) => step.phase), ["redispatch", "review"]);
  assert.equal(readJsonLines(dispatchLog).length, 1);
  assert.equal(flagValue(readJsonLines(dispatchLog)[0].args, "--timeout"), "5400");
  assert.equal(readJsonLines(reviewLog).length, 1);
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.state, RUN_STATES.MERGED);
  assert.equal(payload.summary.fleet_state, FLEET_STATES.CLOSED);
});

test("relay-fleet redispatch pairs immutable ownership with fleet ID for real dispatch", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-real-redispatch-owner-");
  addBareOrigin(repoRoot);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-real-redispatch-owner-"));
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir);
  writeRealDispatchTestBins(binDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const reviewConfigPath = path.join(tmpDir, "review-config.json");
  const fleetId = "fleet-957-real-redispatch-owner";
  const leaf = makeLeaf(repoRoot, 1, {
    issue_number: 957,
    leaf_ref: "leaf-owner",
    leaf_id: "leaf-owner",
    branch: "issue-957-real-redispatch-owner",
  });
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RELAY_HOME: relayHome,
  };

  const initial = spawnSync(process.execPath, [
    REAL_DISPATCH_SCRIPT,
    repoRoot,
    "--branch", leaf.branch,
    "--prompt-file", leaf.prompt_file,
    "--rubric-file", leaf.rubric_file,
    "--leaf-id", leaf.leaf_id,
    "--fleet-id", fleetId,
    "--ownership-json", JSON.stringify(leaf.ownership),
    "--json",
  ], { cwd: repoRoot, encoding: "utf-8", env });
  assert.equal(initial.status, 0, `${initial.stderr}\n${initial.stdout}`);
  const initialPayload = JSON.parse(initial.stdout);
  const manifestPath = initialPayload.manifestPath;
  const runId = initialPayload.runId;
  const initialRecord = readManifest(manifestPath);
  assert.equal(initialRecord.data.state, RUN_STATES.REVIEW_PENDING);
  writeManifest(
    manifestPath,
    updateManifestState(initialRecord.data, RUN_STATES.CHANGES_REQUESTED, "ownership_redispatch_test"),
    initialRecord.body
  );
  fs.writeFileSync(
    path.join(getRunDir(repoRoot, runId), "review-round-1-redispatch.md"),
    "Apply the requested ownership-safe correction.\n",
    "utf-8"
  );

  createFleetManifest(repoRoot, {
    fleetId,
    children: [{ leaf_ref: leaf.leaf_ref, run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  writePersistedFleetLeaves(repoRoot, fleetId, [leaf]);
  advanceFleetManifestState(repoRoot, fleetId, FLEET_STATES.DISPATCHED);

  const driftedOwnership = { ...leaf.ownership, component: "other-component" };
  const rejectedArgs = buildRedispatchArgs({
    repoRoot,
    fleetId,
    runId,
    leaf: { ...leaf, ownership: driftedOwnership },
    options: { dispatchScript: REAL_DISPATCH_SCRIPT },
  });
  const rejected = spawnSync(process.execPath, rejectedArgs, {
    cwd: repoRoot,
    encoding: "utf-8",
    env,
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /cannot change immutable manifest\.ownership/);
  assert.deepEqual(readManifest(manifestPath).data.ownership, leaf.ownership);
  assert.equal(fs.existsSync(path.join(initialPayload.worktree, "resume.txt")), false);

  writeJson(reviewConfigPath, { [runId]: { to_state: "ready_to_merge", verdict: "lgtm" } });
  const resumed = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--review",
    "--dispatch-script", REAL_DISPATCH_SCRIPT,
    "--review-script", reviewScript,
    "--json",
  ], {
    relayHome,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_REVIEW_CONFIG: reviewConfigPath,
    },
  });

  assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
  const resumedPayload = JSON.parse(resumed.stdout);
  assert.deepEqual(resumedPayload.reviewed_children[0].steps.map((step) => step.phase), ["redispatch", "review"]);
  const resumedManifest = readManifest(manifestPath).data;
  assert.equal(resumedManifest.state, RUN_STATES.READY_TO_MERGE);
  assert.equal(resumedManifest.fleet_id, fleetId);
  assert.deepEqual(resumedManifest.ownership, leaf.ownership);
  assert.equal(fs.existsSync(path.join(initialPayload.worktree, "resume.txt")), true);
});

test("relay-fleet --resume keeps pre-manifest dispatch failures visible during review resume", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-review-resume-failure-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-review-resume-failure-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const configPath = path.join(tmpDir, "review-config.json");
  const runId = "issue-527-20260515010101000-a1b2c3d4";
  writeChildRun(repoRoot, {
    runId,
    branch: "issue-527-leaf-a",
    issueNumber: 527,
    leafId: "leaf-a",
    fleetId: "fleet-review-resume-failure",
    state: RUN_STATES.REVIEW_PENDING,
  });
  const record = readManifest(getManifestPath(repoRoot, runId));
  writeManifest(getManifestPath(repoRoot, runId), updateManifestState(record.data, RUN_STATES.CHANGES_REQUESTED, "retry"), record.body);
  writeJson(configPath, { [runId]: { to_state: "ready_to_merge", verdict: "lgtm" } });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-review-resume-failure",
    children: [
      { leaf_ref: "leaf-a", run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-b", run_id: null, dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST },
    ],
  });
  advanceFleetManifestState(repoRoot, "fleet-review-resume-failure", FLEET_STATES.REVIEWING);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-review-resume-failure",
    "--resume",
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_REVIEW_CONFIG: configPath },
  });

  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.reviewed_children[0].status, "complete");
  assert.equal(payload.operator_attention.some((item) => item.leaf_ref === "leaf-b"), true);
});

test("relay-fleet --resume skips a still-running review subprocess", async () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-review-running-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-review-running-fake-"));
  const reviewScript = writeFakeReviewScript(tmpDir);
  const reviewLog = path.join(tmpDir, "review.log");
  const configPath = path.join(tmpDir, "review-config.json");
  const runId = "issue-526-20260515010101000-a1b2c3d4";
  writeChildRun(repoRoot, {
    runId,
    branch: "issue-526-leaf-a",
    issueNumber: 526,
    leafId: "leaf-a",
    fleetId: "fleet-review-running",
    state: RUN_STATES.REVIEW_PENDING,
  });
  // Instead of a fixed sleep to simulate "still running", the fake review
  // subprocess blocks on the presence of this release file. That keeps it
  // alive deterministically for as long as this test needs, regardless of
  // how long process startup / scheduling takes under a loaded test runner
  // (see #754: a fixed delay_ms budget could elapse before the `resumed`
  // child even finished starting up under full-suite parallel load, so the
  // review subprocess would already be done and the liveness check would
  // never observe it as running).
  const releasePath = path.join(tmpDir, "release.flag");
  writeJson(configPath, { [runId]: { to_state: "ready_to_merge", wait_for_file: releasePath } });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-review-running",
    children: [{ leaf_ref: "leaf-a", run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  advanceFleetManifestState(repoRoot, "fleet-review-running", FLEET_STATES.DISPATCHED);

  const first = spawn(process.execPath, [
    RELAY_FLEET_SCRIPT,
    "--repo", repoRoot,
    "--fleet-id", "fleet-review-running",
    "--review",
    "--review-script", reviewScript,
    "--json",
  ], {
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
      RELAY_SOURCE_ROOT: REPO_ROOT,
      FAKE_REVIEW_CONFIG: configPath,
      FAKE_REVIEW_LOG: reviewLog,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitFor(() => readJsonLines(reviewLog).length === 1);
  // The review subprocess having logged its own "spawn" event only proves
  // it is executing; it does not prove the parent `first` process has
  // finished registering the child's pid in the fleet runtime file yet.
  // `resumed`'s liveness check reads exactly that runtime file, so wait for
  // the registration itself rather than inferring it indirectly.
  const runtimePath = getFleetRuntimePath(repoRoot, "fleet-review-running");
  await waitFor(() => {
    if (!fs.existsSync(runtimePath)) return false;
    const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf-8"));
    return runtime.children?.["leaf-a"]?.phase === "review";
  });

  const resumed = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-review-running",
    "--resume",
    "--review-script", reviewScript,
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_REVIEW_CONFIG: configPath,
      FAKE_REVIEW_LOG: reviewLog,
    },
  });

  assert.equal(resumed.status, 1);
  const payload = JSON.parse(resumed.stdout);
  assert.equal(payload.reviewed_children[0].status, "skipped_running");
  assert.equal(readJsonLines(reviewLog).length, 1);

  // Let the still-running review subprocess finish now that the resume
  // assertions above are done.
  fs.writeFileSync(releasePath, "go\n", "utf-8");
  await new Promise((resolve) => first.on("close", resolve));
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.state, RUN_STATES.READY_TO_MERGE);
});

test("relay-fleet review drive treats live leases as running across review, publish, and redispatch guards", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-live-lease-guards-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-live-lease-guards-fake-"));
  const fleetId = "fleet-live-lease-guards";
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
  const dispatchLog = path.join(tmpDir, "dispatch.log");
  const reviewLog = path.join(tmpDir, "review.log");
  const missingPublishScript = path.join(tmpDir, "must-not-run-publish.js");
  const liveReviewRun = "issue-927-20260711010101000-a1b2c3d4";
  const livePublishRun = "issue-928-20260711010101000-a1b2c3d4";
  const liveRedispatchRun = "issue-929-20260711010101000-a1b2c3d4";
  const deadReviewRun = "issue-930-20260711010101000-a1b2c3d4";
  const foreignRedispatchRun = "issue-931-20260711010101000-a1b2c3d4";

  function createRun(runId, leafRef, issueNumber, state) {
    const manifestPath = getManifestPath(repoRoot, runId);
    const initialState = state === RUN_STATES.PUBLISH_PENDING
      ? RUN_STATES.DISPATCHED
      : RUN_STATES.REVIEW_PENDING;
    writeChildRun(repoRoot, {
      runId,
      branch: `issue-${issueNumber}-${leafRef}`,
      issueNumber,
      leafId: leafRef,
      fleetId,
      state: initialState,
    });
    if (state === RUN_STATES.CHANGES_REQUESTED) {
      const record = readManifest(manifestPath);
      writeManifest(
        manifestPath,
        updateManifestState(record.data, RUN_STATES.CHANGES_REQUESTED, "retry"),
        record.body
      );
    } else if (state === RUN_STATES.PUBLISH_PENDING) {
      const record = readManifest(manifestPath);
      let manifest = record.data;
      manifest = updateManifestState(manifest, RUN_STATES.INTERNAL_REVIEW_PENDING, "await_internal_review");
      manifest = updateManifestState(manifest, RUN_STATES.PUBLISH_PENDING, "await_publish");
      writeManifest(manifestPath, manifest, record.body);
    }
  }

  createRun(liveReviewRun, "leaf-live-review", 927, RUN_STATES.REVIEW_PENDING);
  createRun(livePublishRun, "leaf-live-publish", 928, RUN_STATES.PUBLISH_PENDING);
  createRun(liveRedispatchRun, "leaf-live-redispatch", 929, RUN_STATES.CHANGES_REQUESTED);
  createRun(deadReviewRun, "leaf-dead-review", 930, RUN_STATES.REVIEW_PENDING);
  createRun(foreignRedispatchRun, "leaf-foreign-redispatch", 931, RUN_STATES.CHANGES_REQUESTED);

  writeRunLeaseFixture(repoRoot, liveReviewRun);
  writeRunLeaseFixture(repoRoot, livePublishRun);
  writeRunLeaseFixture(repoRoot, liveRedispatchRun);
  writeRunLeaseFixture(repoRoot, deadReviewRun, { pid: 2147483647 });
  writeRunLeaseFixture(repoRoot, foreignRedispatchRun, { host: "foreign.example.invalid" });

  createFleetManifest(repoRoot, {
    fleetId,
    children: [
      { leaf_ref: "leaf-live-review", run_id: liveReviewRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-live-publish", run_id: livePublishRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      {
        leaf_ref: "leaf-live-redispatch",
        run_id: liveRedispatchRun,
        dispatch_status: DISPATCH_STATUS.DISPATCHED,
        last_error: "operator-resumed",
      },
      { leaf_ref: "leaf-dead-review", run_id: deadReviewRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-foreign-redispatch", run_id: foreignRedispatchRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
    ],
  });
  advanceFleetManifestState(repoRoot, fleetId, FLEET_STATES.DISPATCHED);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--review",
    "--dispatch-script", dispatchScript,
    "--publish-script", missingPublishScript,
    "--review-script", reviewScript,
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_DISPATCH_LOG: dispatchLog,
      FAKE_REVIEW_LOG: reviewLog,
    },
  });

  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  const byLeaf = new Map(payload.reviewed_children.map((child) => [child.leaf_ref, child]));
  const guardedPhases = {
    "leaf-live-review": "review",
    "leaf-live-publish": "publish",
    "leaf-live-redispatch": "redispatch",
  };
  for (const [leafRef, phase] of Object.entries(guardedPhases)) {
    assert.equal(byLeaf.get(leafRef).status, "skipped_running");
    assert.equal(byLeaf.get(leafRef).steps[0].status, "skipped_running");
    assert.equal(byLeaf.get(leafRef).steps[0].phase, phase);
  }
  assert.equal(byLeaf.get("leaf-dead-review").status, "complete");
  assert.equal(byLeaf.get("leaf-foreign-redispatch").status, "complete");
  assert.deepEqual(readJsonLines(dispatchLog).map((entry) => entry.runId), [foreignRedispatchRun]);
  assert.deepEqual(
    readJsonLines(reviewLog).map((entry) => entry.runId).sort(),
    [deadReviewRun, foreignRedispatchRun].sort()
  );
  assert.equal(
    readFleetManifest(repoRoot, fleetId).data.children
      .find((child) => child.leaf_ref === "leaf-live-redispatch").last_error,
    "operator-resumed"
  );
});

test("relay-fleet status uses live local leases while dead and foreign leases remain stuck", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-lease-attention-");
  const fleetId = "fleet-lease-attention";
  const runs = {
    live: "issue-932-20260711010101000-a1b2c3d4",
    dead: "issue-933-20260711010101000-a1b2c3d4",
    foreign: "issue-934-20260711010101000-a1b2c3d4",
    registry: "issue-935-20260711010101000-a1b2c3d4",
  };

  for (const [kind, runId] of Object.entries(runs)) {
    writeChildRun(repoRoot, {
      runId,
      branch: `issue-${runId.slice(6, 9)}-leaf-${kind}`,
      issueNumber: Number(runId.slice(6, 9)),
      leafId: `leaf-${kind}`,
      fleetId,
      state: RUN_STATES.DISPATCHED,
    });
  }
  writeRunLeaseFixture(repoRoot, runs.live);
  writeRunLeaseFixture(repoRoot, runs.dead, { pid: 2147483647 });
  writeRunLeaseFixture(repoRoot, runs.foreign, { host: "foreign.example.invalid" });
  fs.mkdirSync(path.dirname(getFleetRuntimePath(repoRoot, fleetId)), { recursive: true });
  writeJson(getFleetRuntimePath(repoRoot, fleetId), {
    fleet_id: fleetId,
    children: {
      "leaf-registry": { pid: process.pid, phase: "dispatch", run_id: runs.registry },
    },
  });
  createFleetManifest(repoRoot, {
    fleetId,
    children: Object.entries(runs).map(([kind, runId]) => ({
      leaf_ref: `leaf-${kind}`,
      run_id: runId,
      dispatch_status: DISPATCH_STATUS.DISPATCHED,
    })),
  });

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--status",
    "--json",
  ], { relayHome });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const attention = JSON.parse(result.stdout).operator_attention;
  const stuckLeaves = attention
    .filter((item) => item.reason === "stuck_child")
    .map((item) => item.leaf_ref)
    .sort();
  assert.deepEqual(stuckLeaves, ["leaf-dead", "leaf-foreign"]);
});

test("relay-fleet pre-manifest fan-out liveness remains registry-only without a run id", () => {
  const { repoRoot } = setupRepo("relay-fleet-pre-manifest-liveness-");
  const fleetId = "fleet-pre-manifest-liveness";
  const liveLeaf = makeLeaf(repoRoot, 1, { leaf_ref: "leaf-live-registry", issue_number: 936 });
  const missingLeaf = makeLeaf(repoRoot, 2, { leaf_ref: "leaf-no-registry", issue_number: 937 });
  createFleetManifest(repoRoot, {
    fleetId,
    children: [liveLeaf, missingLeaf].map((leaf) => ({
      leaf_ref: leaf.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.DISPATCHING,
    })),
  });
  fs.mkdirSync(path.dirname(getFleetRuntimePath(repoRoot, fleetId)), { recursive: true });
  writeJson(getFleetRuntimePath(repoRoot, fleetId), {
    fleet_id: fleetId,
    children: {
      [liveLeaf.leaf_ref]: { pid: process.pid, phase: "dispatch" },
    },
  });

  const fleet = reconcileFleet(repoRoot, fleetId, [liveLeaf, missingLeaf]);
  const byLeaf = new Map(fleet.children.map((child) => [child.leaf_ref, child]));
  assert.equal(byLeaf.get(liveLeaf.leaf_ref).dispatch_status, DISPATCH_STATUS.DISPATCHING);
  assert.equal(byLeaf.get(liveLeaf.leaf_ref).run_id, null);
  assert.equal(
    byLeaf.get(missingLeaf.leaf_ref).dispatch_status,
    DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST
  );
});

test("relay-fleet --status without --fleet-id lists every repo fleet in deterministic text rows", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-list-text-");
  const otherRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-list-other-"));
  initGitRepo(otherRepoRoot);
  createFleetManifest(otherRepoRoot, { fleetId: "fleet-other-repo" });

  const escalatedRun = "issue-871-20260710010101000-a1b2c3d4";
  writeChildRun(repoRoot, {
    runId: escalatedRun,
    branch: "issue-871-fleet-listing",
    issueNumber: 871,
    leafId: "leaf-terminal",
    fleetId: "fleet-zeta",
    state: RUN_STATES.ESCALATED,
  });
  createFleetManifest(repoRoot, { fleetId: "fleet-alpha" });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-zeta",
    children: [
      { leaf_ref: "leaf-terminal", run_id: escalatedRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-pending", run_id: null, dispatch_status: DISPATCH_STATUS.PENDING },
    ],
  });
  advanceFleetManifestState(repoRoot, "fleet-zeta", FLEET_STATES.REVIEWING);
  writeFleetUpdatedAt(repoRoot, "fleet-alpha", "2026-07-09T01:00:00.000Z");
  writeFleetUpdatedAt(repoRoot, "fleet-zeta", "2026-07-10T02:00:00.000Z");

  const alphaPath = getFleetManifestPath(repoRoot, "fleet-alpha");
  const zetaPath = getFleetManifestPath(repoRoot, "fleet-zeta");
  const before = new Map([
    [alphaPath, fs.readFileSync(alphaPath, "utf-8")],
    [zetaPath, fs.readFileSync(zetaPath, "utf-8")],
  ]);
  const result = runFleet(["--repo", repoRoot, "--status"], { relayHome });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, [
    "Fleets: 2",
    "fleet_id | fleet_state | children_terminal/children_total | updated_at",
    "fleet-alpha | draft | 0/0 | 2026-07-09T01:00:00.000Z",
    "fleet-zeta | reviewing | 1/2 | 2026-07-10T02:00:00.000Z",
    "",
  ].join("\n"));
  assert.doesNotMatch(result.stdout, /fleet-other-repo/);
  for (const [manifestPath, content] of before) {
    assert.equal(fs.readFileSync(manifestPath, "utf-8"), content);
  }
});

test("relay-fleet --status --json without --fleet-id emits the stable listing fields", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-list-json-");
  const closedRun = "issue-872-20260710010101000-a1b2c3d4";
  writeChildRun(repoRoot, {
    runId: closedRun,
    branch: "issue-872-fleet-hygiene",
    issueNumber: 872,
    leafId: "leaf-closed",
    fleetId: "fleet-alpha",
    state: RUN_STATES.CLOSED,
  });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-beta",
    children: [{ leaf_ref: "leaf-pending", run_id: null, dispatch_status: DISPATCH_STATUS.PENDING }],
  });
  createFleetManifest(repoRoot, {
    fleetId: "fleet-alpha",
    children: [{ leaf_ref: "leaf-closed", run_id: closedRun, dispatch_status: DISPATCH_STATUS.DISPATCHED }],
  });
  writeFleetUpdatedAt(repoRoot, "fleet-alpha", "2026-07-10T03:00:00.000Z");
  writeFleetUpdatedAt(repoRoot, "fleet-beta", "2026-07-10T04:00:00.000Z");

  const result = runFleet(["--repo", repoRoot, "--status", "--json"], { relayHome });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    {
      fleet_id: "fleet-alpha",
      fleet_state: "draft",
      children_total: 1,
      children_terminal: 1,
      updated_at: "2026-07-10T03:00:00.000Z",
    },
    {
      fleet_id: "fleet-beta",
      fleet_state: "draft",
      children_total: 1,
      children_terminal: 0,
      updated_at: "2026-07-10T04:00:00.000Z",
    },
  ]);
});

test("relay-fleet --status --fleet-id byte-preserves single-fleet text and JSON detail", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-detail-bytes-");
  const created = createFleetManifest(repoRoot, {
    fleetId: "fleet-detail",
    children: [{ leaf_ref: "leaf-pending", run_id: null, dispatch_status: DISPATCH_STATUS.PENDING }],
  });
  const summary = {
    fleet_id: "fleet-detail",
    fleet_state: "draft",
    total_children: 1,
    by_dispatch_status: { pending: 1 },
    by_run_state: { no_run_manifest: 1 },
    children: [{
      leaf_ref: "leaf-pending",
      run_id: null,
      dispatch_status: "pending",
      run_state: "no_run_manifest",
      manifest_path: null,
      pr_number: null,
      base_branch: null,
      review_round: null,
      error: null,
    }],
  };

  const textResult = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-detail",
    "--status",
  ], { relayHome });
  assert.equal(textResult.status, 0, textResult.stderr);
  assert.equal(textResult.stdout, [
    "Fleet: fleet-detail",
    "State: draft",
    "Children: 1",
    'Dispatch status: {"pending":1}',
    'Run state: {"no_run_manifest":1}',
    "Child states:",
    "  - leaf-pending | run_id=null | dispatch_status=pending | run_state=no_run_manifest",
    "",
  ].join("\n"));

  const jsonResult = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-detail",
    "--status",
    "--json",
  ], { relayHome });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  assert.equal(jsonResult.stdout, `${JSON.stringify({
    ok: true,
    fleet_id: "fleet-detail",
    fleetManifestPath: created.manifestPath,
    summary,
    operator_attention: [],
  }, null, 2)}\n`);
});

test("relay-fleet --status without --fleet-id returns clean empty text and JSON listings", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-list-empty-");
  const fleetsDir = getFleetsDir(repoRoot);
  assert.equal(fs.existsSync(fleetsDir), false);

  const textResult = runFleet(["--repo", repoRoot, "--status"], { relayHome });
  assert.equal(textResult.status, 0, textResult.stderr);
  assert.equal(textResult.stdout, "No fleets found for repository.\n");
  assert.equal(fs.existsSync(fleetsDir), false);

  const jsonResult = runFleet(["--repo", repoRoot, "--status", "--json"], { relayHome });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  assert.equal(jsonResult.stdout, "[]\n");
  assert.equal(fs.existsSync(fleetsDir), false);
});

test("relay-fleet non-status modes without --fleet-id preserve the missing-argument error", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-list-required-");
  for (const modeArgs of [[], ["--resume"], ["--review"], ["--dry-run"]]) {
    const result = runFleet(["--repo", repoRoot, ...modeArgs], { relayHome });
    assert.equal(result.status, 1, `mode ${modeArgs.join(" ")} unexpectedly succeeded`);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Error: --fleet-id is required\n");
  }
});

test("relay-fleet repo listing marks a corrupt manifest row and continues", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-list-corrupt-");
  createFleetManifest(repoRoot, { fleetId: "fleet-alpha" });
  writeFleetUpdatedAt(repoRoot, "fleet-alpha", "2026-07-10T05:00:00.000Z");
  const corruptPath = getFleetManifestPath(repoRoot, "fleet-corrupt");
  fs.writeFileSync(corruptPath, "---\nfleet_id: 'fleet-corrupt'\n", "utf-8");
  const before = fs.readFileSync(corruptPath, "utf-8");

  const jsonResult = runFleet(["--repo", repoRoot, "--status", "--json"], { relayHome });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  assert.deepEqual(JSON.parse(jsonResult.stdout), [
    {
      fleet_id: "fleet-alpha",
      fleet_state: "draft",
      children_total: 0,
      children_terminal: 0,
      updated_at: "2026-07-10T05:00:00.000Z",
    },
    {
      fleet_id: "fleet-corrupt",
      fleet_state: "error",
      children_total: null,
      children_terminal: null,
      updated_at: null,
      error: "fleet-corrupt.md: Invalid manifest: missing closing frontmatter marker",
    },
  ]);

  const textResult = runFleet(["--repo", repoRoot, "--status"], { relayHome });
  assert.equal(textResult.status, 0, textResult.stderr);
  assert.match(
    textResult.stdout,
    /fleet-corrupt \| error \| -\/- \| - \| error=fleet-corrupt\.md: Invalid manifest: missing closing frontmatter marker/,
  );
  assert.equal(fs.readFileSync(corruptPath, "utf-8"), before);
});

test("relay-fleet help documents repo-wide status and conditional --fleet-id", () => {
  const result = runFleet(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /relay-fleet\.js --repo <path> --status \[--json\]/);
  assert.match(result.stdout, /Fleet manifest id \(required except repo-wide --status\)/);
});

test("relay-fleet --status prints derived summary without writing the fleet manifest", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-status-");
  const dispatchedRun = "issue-510-20260514010101000-a1b2c3d4";
  const escalatedRun = "issue-511-20260514010101000-a1b2c3d4";
  for (const [runId, state] of [[dispatchedRun, RUN_STATES.DISPATCHED], [escalatedRun, RUN_STATES.ESCALATED]]) {
    fs.mkdirSync(getRunDir(repoRoot, runId), { recursive: true });
    let manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch: `issue-${runId.slice(6, 9)}-status`,
      baseBranch: "main",
      issueNumber: Number(runId.slice(6, 9)),
      worktreePath: path.join(repoRoot, "wt", runId),
      fleetId: "fleet-status",
      leafId: runId === dispatchedRun ? "leaf-dispatched" : "leaf-escalated",
    });
    manifest = updateManifestState(manifest, RUN_STATES.DISPATCHED, "await_dispatch_result");
    if (state === RUN_STATES.ESCALATED) {
      manifest = updateManifestState(manifest, RUN_STATES.ESCALATED, "inspect_dispatch_failure");
    }
    writeManifest(getManifestPath(repoRoot, runId), manifest);
  }
  const created = createFleetManifest(repoRoot, {
    fleetId: "fleet-status",
    children: [
      { leaf_ref: "leaf-dispatched", run_id: dispatchedRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-escalated", run_id: escalatedRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-failed", run_id: null, dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST },
    ],
  });
  const before = fs.readFileSync(created.manifestPath, "utf-8");

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-status",
    "--status",
    "--json",
  ], { relayHome });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.summary.total_children, 3);
  assert.equal(payload.summary.by_dispatch_status[DISPATCH_STATUS.DISPATCHED], 2);
  assert.equal(payload.summary.by_dispatch_status[DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST], 1);
  assert.equal(payload.summary.by_run_state[RUN_STATES.DISPATCHED], 1);
  assert.equal(payload.summary.by_run_state[RUN_STATES.ESCALATED], 1);
  assert.equal(payload.summary.by_run_state.no_run_manifest, 1);
  assert.equal(
    Object.hasOwn(payload.summary.children.find((child) => child.leaf_ref === "leaf-failed"), "last_error"),
    false
  );

  const textResult = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-status",
    "--status",
  ], { relayHome });

  assert.equal(textResult.status, 0, textResult.stderr);
  assert.match(textResult.stdout, /Child states:/);
  assert.match(
    textResult.stdout,
    new RegExp(`leaf-dispatched \\| run_id=${dispatchedRun} \\| dispatch_status=dispatched \\| run_state=dispatched`),
  );
  assert.match(
    textResult.stdout,
    new RegExp(`leaf-escalated \\| run_id=${escalatedRun} \\| dispatch_status=dispatched \\| run_state=escalated`),
  );
  assert.equal(
    textResult.stdout.split("\n").find((line) => line.includes("leaf-failed")),
    "  - leaf-failed | run_id=null | dispatch_status=dispatch_failed_pre_manifest | run_state=no_run_manifest"
  );
  assert.doesNotMatch(textResult.stdout, /last_error=/);
  assert.match(textResult.stdout, /Needs operator attention:/);
  assert.match(textResult.stdout, new RegExp(`leaf-escalated: escalated \\(${escalatedRun}\\)`));
  assert.equal(fs.readFileSync(created.manifestPath, "utf-8"), before);
});

function writeFakeGhDefaultBranch(tmpDir, defaultBranchName) {
  const ghPath = path.join(tmpDir, "fake-gh-default-branch.js");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ defaultBranchRef: { name: ${JSON.stringify(defaultBranchName)} } }));
  process.exit(0);
}
process.stderr.write("unsupported fake gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return ghPath;
}

test("relay-fleet rejects a depends_on entry that names another leaf in the same leaves file", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-dep-same-wave-");
  const dispatchScript = writeFakeDispatchScript(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-")));
  const leavesFile = writeLeavesFile(repoRoot, [
    makeLeaf(repoRoot, 1, { issue_number: 540, leaf_ref: "leaf-a", leaf_id: "leaf-a" }),
    makeLeaf(repoRoot, 2, { issue_number: 541, leaf_ref: "leaf-b", leaf_id: "leaf-b", depends_on: ["leaf-a"] }),
  ]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-dep-same-wave",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /same-wave dependency/);
  assert.equal(fs.existsSync(getFleetManifestPath(repoRoot, "fleet-dep-same-wave")), false);
});

test("relay-fleet rejects a depends_on entry that references the leaf itself", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-dep-self-");
  const dispatchScript = writeFakeDispatchScript(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-")));
  const leavesFile = writeLeavesFile(repoRoot, [
    makeLeaf(repoRoot, 1, { issue_number: 542, leaf_ref: "leaf-a", leaf_id: "leaf-a", depends_on: ["leaf-a"] }),
  ]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-dep-self",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /references itself/);
  assert.equal(fs.existsSync(getFleetManifestPath(repoRoot, "fleet-dep-self")), false);
});

test("relay-fleet accepts a depends_on entry that references a leaf outside this leaves file", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-dep-external-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const logPath = path.join(tmpDir, "dispatch.log");
  const leavesFile = writeLeavesFile(repoRoot, [
    makeLeaf(repoRoot, 1, {
      issue_number: 543,
      leaf_ref: "leaf-c",
      leaf_id: "leaf-c",
      depends_on: ["leaf-dispatched-in-an-earlier-wave"],
    }),
  ]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-dep-external",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--dry-run",
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_LOG: logPath },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.children.length, 1);
  assert.equal(payload.children[0].status, "dry_run");
});

test("relay-fleet --dry-run fails closed when request_id does not resolve to a relay-ready request artifact", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-lineage-missing-");
  const dispatchScript = writeFakeDispatchScript(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-")));
  const leavesFile = writeLeavesFile(repoRoot, [
    makeLeaf(repoRoot, 1, {
      issue_number: 544,
      leaf_ref: "leaf-d",
      leaf_id: "leaf-d",
      request_id: "req-does-not-exist-000",
    }),
  ]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-lineage-missing",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--dry-run",
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not resolve to a relay-ready request artifact/);
  assert.equal(fs.existsSync(getFleetManifestPath(repoRoot, "fleet-lineage-missing")), false);
});

test("relay-fleet --dry-run fails closed when leaf_id is not among the request's leaf handoffs", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-lineage-mismatch-");
  const dispatchScript = writeFakeDispatchScript(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-")));
  persistFixtureRequest(repoRoot, "req-lineage-mismatch", "leaf-real");
  const leavesFile = writeLeavesFile(repoRoot, [
    makeLeaf(repoRoot, 1, {
      issue_number: 545,
      leaf_ref: "leaf-e",
      leaf_id: "leaf-not-in-request",
      request_id: "req-lineage-mismatch",
    }),
  ]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-lineage-mismatch",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--dry-run",
    "--json",
  ], { relayHome });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not among the leaf handoffs persisted for request/);
});

test("relay-fleet --dry-run succeeds when request_id and leaf_id resolve to a persisted request artifact", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-lineage-ok-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const logPath = path.join(tmpDir, "dispatch.log");
  persistFixtureRequest(repoRoot, "req-lineage-ok", "leaf-f");
  const leavesFile = writeLeavesFile(repoRoot, [
    makeLeaf(repoRoot, 1, {
      issue_number: 546,
      leaf_ref: "leaf-f",
      leaf_id: "leaf-f",
      request_id: "req-lineage-ok",
    }),
  ]);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-lineage-ok",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--dry-run",
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_LOG: logPath },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.children[0].status, "dry_run");
});

test("relay-fleet --status surfaces missing_pr, merge_blocked, high_review_rounds, stale_base, and stuck_child alongside the existing reasons, with a healthy child producing none", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-status-debt-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-status-debt-fake-"));
  const fleetId = "fleet-status-debt";

  // Existing reasons, reused from the fixtures above: dispatch_failed_pre_manifest
  // (no run_id) and escalated/changes_requested/missing_manifest need a run_id.
  const escalatedRun = "issue-550-20260601010101000-a1b2c3d4";
  const changesRequestedRun = "issue-551-20260601010101000-a1b2c3d4";
  const missingManifestRun = "issue-552-20260601010101000-a1b2c3d4";
  // New reasons.
  const missingPrRun = "issue-553-20260601010101000-a1b2c3d4";
  const mergeBlockedRun = "issue-554-20260601010101000-a1b2c3d4";
  const highReviewRoundsRun = "issue-555-20260601010101000-a1b2c3d4";
  const staleBaseRun = "issue-556-20260601010101000-a1b2c3d4";
  const stuckChildRun = "issue-557-20260601010101000-a1b2c3d4";
  const healthyRun = "issue-558-20260601010101000-a1b2c3d4";

  function makeChildManifest(runId, leafId, { patch = (manifest) => manifest } = {}) {
    fs.mkdirSync(getRunDir(repoRoot, runId), { recursive: true });
    let manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch: `${leafId}-branch`,
      baseBranch: "main",
      issueNumber: Number(runId.slice(6, 9)),
      worktreePath: path.join(repoRoot, "wt", runId),
      fleetId,
      leafId,
    });
    // Any transition into review_pending requires a satisfied rubric anchor
    // (see lifecycle.js validateTransitionInvariants); write one up front so
    // every fixture below can freely reach review_pending regardless of which
    // attention reason it exercises.
    fs.writeFileSync(path.join(getRunDir(repoRoot, runId), "rubric.yaml"), "rubric:\n  size_class: S\n", "utf-8");
    manifest = { ...manifest, anchor: { ...(manifest.anchor || {}), rubric_path: "rubric.yaml" } };
    manifest = updateManifestState(manifest, RUN_STATES.DISPATCHED, "await_dispatch_result");
    manifest = patch(manifest);
    writeManifest(getManifestPath(repoRoot, runId), manifest);
    return runId;
  }

  makeChildManifest(escalatedRun, "leaf-escalated", {
    patch: (manifest) => updateManifestState(manifest, RUN_STATES.ESCALATED, "inspect_dispatch_failure"),
  });
  makeChildManifest(changesRequestedRun, "leaf-changes-requested", {
    patch: (manifest) => {
      manifest = updateManifestState(manifest, RUN_STATES.REVIEW_PENDING, "await_review");
      return updateManifestState(manifest, RUN_STATES.CHANGES_REQUESTED, "retry");
    },
  });
  // missing-manifest: fleet child references a run_id whose manifest file was never written.

  makeChildManifest(missingPrRun, "leaf-missing-pr", {
    patch: (manifest) => updateManifestState(manifest, RUN_STATES.REVIEW_PENDING, "await_review"),
  });
  makeChildManifest(mergeBlockedRun, "leaf-merge-blocked", {
    patch: (manifest) => {
      manifest = updateManifestState(manifest, RUN_STATES.REVIEW_PENDING, "await_review");
      manifest = updateManifestState(manifest, RUN_STATES.READY_TO_MERGE, "ready");
      manifest = updateManifestState(manifest, RUN_STATES.MERGE_BLOCKED, "merge_failed");
      return { ...manifest, git: { ...manifest.git, pr_number: 601 } };
    },
  });
  makeChildManifest(highReviewRoundsRun, "leaf-high-review-rounds", {
    patch: (manifest) => {
      manifest = updateManifestState(manifest, RUN_STATES.REVIEW_PENDING, "await_review");
      return {
        ...manifest,
        git: { ...manifest.git, pr_number: 602 },
        review: { ...manifest.review, rounds: 3 },
      };
    },
  });
  makeChildManifest(staleBaseRun, "leaf-stale-base", {
    patch: (manifest) => {
      manifest = updateManifestState(manifest, RUN_STATES.REVIEW_PENDING, "await_review");
      return {
        ...manifest,
        git: { ...manifest.git, pr_number: 603, base_branch: "develop" },
      };
    },
  });
  makeChildManifest(stuckChildRun, "leaf-stuck-child", {
    patch: (manifest) => ({
      ...manifest,
      git: { ...manifest.git, pr_number: 604 },
    }),
  });
  makeChildManifest(healthyRun, "leaf-healthy", {
    patch: (manifest) => {
      manifest = updateManifestState(manifest, RUN_STATES.REVIEW_PENDING, "await_review");
      manifest = updateManifestState(manifest, RUN_STATES.READY_TO_MERGE, "ready");
      manifest = updateManifestState(manifest, RUN_STATES.MERGED, "merged");
      return { ...manifest, git: { ...manifest.git, pr_number: 605 } };
    },
  });

  createFleetManifest(repoRoot, {
    fleetId,
    children: [
      { leaf_ref: "leaf-dispatch-failed", run_id: null, dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST },
      { leaf_ref: "leaf-escalated", run_id: escalatedRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-changes-requested", run_id: changesRequestedRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-missing-manifest", run_id: missingManifestRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-missing-pr", run_id: missingPrRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-merge-blocked", run_id: mergeBlockedRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-high-review-rounds", run_id: highReviewRoundsRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-stale-base", run_id: staleBaseRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-stuck-child", run_id: stuckChildRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-healthy", run_id: healthyRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
    ],
  });

  const fakeGh = writeFakeGhDefaultBranch(tmpDir, "main");

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--status",
    "--json",
  ], { relayHome, env: { RELAY_GH_BIN: fakeGh } });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  const attention = payload.operator_attention;

  function has(leafRef, reason) {
    return attention.some((item) => item.leaf_ref === leafRef && item.reason === reason);
  }

  // Existing reasons still fire, byte-identical.
  assert.equal(has("leaf-dispatch-failed", DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST), true);
  assert.equal(has("leaf-escalated", "escalated"), true);
  assert.equal(has("leaf-changes-requested", "changes_requested"), true);
  assert.equal(has("leaf-missing-manifest", "missing_manifest"), true);

  // New reasons.
  assert.equal(has("leaf-missing-pr", "missing_pr"), true);
  assert.equal(has("leaf-merge-blocked", "merge_blocked"), true);
  assert.equal(has("leaf-high-review-rounds", "high_review_rounds"), true);
  assert.equal(has("leaf-stale-base", "stale_base"), true);
  assert.equal(has("leaf-stuck-child", "stuck_child"), true);

  // The healthy child (terminal, PR stamped, rounds below threshold, base
  // branch matches default, not eligible for stuck_child) produces zero items.
  assert.equal(attention.some((item) => item.leaf_ref === "leaf-healthy"), false);
});

test("relay-fleet stuck_child operator_attention derives next_action/detail from review_preflight_failed (#901)", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-stuck-preflight-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-stuck-preflight-fake-"));
  const fleetId = "fleet-stuck-preflight";
  const {
    formatStatusText: formatText,
  } = require(RELAY_FLEET_SCRIPT);

  function makeChildManifest(runId, leafId, { patch = (manifest) => manifest } = {}) {
    fs.mkdirSync(getRunDir(repoRoot, runId), { recursive: true });
    let manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch: `${leafId}-branch`,
      baseBranch: "main",
      issueNumber: Number(runId.slice(6, 9)),
      worktreePath: path.join(repoRoot, "wt", runId),
      fleetId,
      leafId,
    });
    fs.writeFileSync(path.join(getRunDir(repoRoot, runId), "rubric.yaml"), "rubric:\n  size_class: S\n", "utf-8");
    manifest = { ...manifest, anchor: { ...(manifest.anchor || {}), rubric_path: "rubric.yaml" } };
    manifest = updateManifestState(manifest, RUN_STATES.DISPATCHED, "await_dispatch_result");
    manifest = patch(manifest);
    writeManifest(getManifestPath(repoRoot, runId), manifest);
    return runId;
  }

  function writePreflightEvent(runId, event) {
    const eventsPath = path.join(getRunDir(repoRoot, runId), "events.jsonl");
    fs.writeFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
  }

  const enrichedRun = "issue-901-20260710010101000-a1b2c3d4";
  const supersededRun = "issue-902-20260710010101000-a1b2c3d4";
  const bareRun = "issue-903-20260710010101000-a1b2c3d4";
  const legacyEventRun = "issue-904-20260710010101000-a1b2c3d4";
  const multiReasonRun = "issue-905-20260710010101000-a1b2c3d4";
  const mergeOnlyRun = "issue-906-20260710010101000-a1b2c3d4";

  makeChildManifest(enrichedRun, "leaf-enriched", {
    patch: (manifest) => ({
      ...manifest,
      git: { ...manifest.git, pr_number: 901 },
    }),
  });
  writePreflightEvent(enrichedRun, {
    event: "review_preflight_failed",
    round: 1,
    reason: "branch is 2 commits behind origin/main; rebase and re-run",
    next_action: "rebase_and_rerun",
    preflight_type: "behind_base",
  });

  makeChildManifest(supersededRun, "leaf-superseded", {
    patch: (manifest) => {
      manifest = updateManifestState(manifest, RUN_STATES.REVIEW_PENDING, "await_review");
      return {
        ...manifest,
        git: { ...manifest.git, pr_number: 902 },
        review: { ...manifest.review, rounds: 1 },
      };
    },
  });
  writePreflightEvent(supersededRun, {
    event: "review_preflight_failed",
    round: 1,
    reason: "stale artifact: recorded at old, reviewed at new",
    next_action: "repair_execution_evidence",
    preflight_type: "execution_evidence_fail",
  });

  // No events.jsonl — bare stuck_child, fail-open.
  makeChildManifest(bareRun, "leaf-bare", {
    patch: (manifest) => ({
      ...manifest,
      git: { ...manifest.git, pr_number: 903 },
    }),
  });

  // Older event without next_action → detail only, key absent.
  makeChildManifest(legacyEventRun, "leaf-legacy-event", {
    patch: (manifest) => ({
      ...manifest,
      git: { ...manifest.git, pr_number: 904 },
    }),
  });
  writePreflightEvent(legacyEventRun, {
    event: "review_preflight_failed",
    round: 1,
    reason: "pre-261 run, no artifact",
    preflight_type: "execution_evidence_missing",
  });

  // stuck_child + merge_blocked: enrich ONLY the stuck_child item.
  makeChildManifest(multiReasonRun, "leaf-multi", {
    patch: (manifest) => {
      manifest = updateManifestState(manifest, RUN_STATES.REVIEW_PENDING, "await_review");
      manifest = updateManifestState(manifest, RUN_STATES.READY_TO_MERGE, "ready");
      manifest = updateManifestState(manifest, RUN_STATES.MERGE_BLOCKED, "merge_failed");
      return { ...manifest, git: { ...manifest.git, pr_number: 905 } };
    },
  });
  writePreflightEvent(multiReasonRun, {
    event: "review_preflight_failed",
    round: 1,
    reason: "branch is 1 commit behind origin/main; rebase and re-run",
    next_action: "rebase_and_rerun",
    preflight_type: "behind_base",
  });

  // Non-stuck attention reason stays byte-identical even if a preflight event exists.
  makeChildManifest(mergeOnlyRun, "leaf-merge-only", {
    patch: (manifest) => {
      manifest = updateManifestState(manifest, RUN_STATES.REVIEW_PENDING, "await_review");
      manifest = updateManifestState(manifest, RUN_STATES.READY_TO_MERGE, "ready");
      manifest = updateManifestState(manifest, RUN_STATES.MERGE_BLOCKED, "merge_failed");
      // Mark terminal-for-fleet-review so stuck_child does not fire: MERGED.
      // Wait — we need merge_blocked without stuck_child. MERGE_BLOCKED is not
      // terminal for fleet review, so stuck_child would also fire. Keep a live
      // runtime pid so stuck_child is suppressed.
      return { ...manifest, git: { ...manifest.git, pr_number: 906 } };
    },
  });
  writePreflightEvent(mergeOnlyRun, {
    event: "review_preflight_failed",
    round: 1,
    reason: "should not attach to merge_blocked",
    next_action: "rebase_and_rerun",
    preflight_type: "behind_base",
  });
  // Keep a live runtime child so leaf-merge-only is not stuck_child.
  const { getFleetRuntimePath } = require(RELAY_FLEET_SCRIPT);
  const runtimePath = getFleetRuntimePath(repoRoot, fleetId);
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, `${JSON.stringify({
    children: { "leaf-merge-only": { pid: process.pid, started_at: new Date().toISOString() } },
  }, null, 2)}\n`, "utf-8");

  createFleetManifest(repoRoot, {
    fleetId,
    children: [
      { leaf_ref: "leaf-enriched", run_id: enrichedRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-superseded", run_id: supersededRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-bare", run_id: bareRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-legacy-event", run_id: legacyEventRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-multi", run_id: multiReasonRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-merge-only", run_id: mergeOnlyRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
    ],
  });

  const fakeGh = writeFakeGhDefaultBranch(tmpDir, "main");
  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--status",
    "--json",
  ], { relayHome, env: { RELAY_GH_BIN: fakeGh } });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  const attention = payload.operator_attention;

  function item(leafRef, reason) {
    return attention.find((entry) => entry.leaf_ref === leafRef && entry.reason === reason);
  }

  // Matrix row 1: newer preflight event → next_action + detail.
  const enriched = item("leaf-enriched", "stuck_child");
  assert.ok(enriched);
  assert.equal(enriched.next_action, "rebase_and_rerun");
  assert.equal(enriched.detail, "branch is 2 commits behind origin/main; rebase and re-run");

  // Matrix row 2: superseded (round <= review.rounds) → no attachment.
  const superseded = item("leaf-superseded", "stuck_child");
  assert.ok(superseded);
  assert.equal(Object.prototype.hasOwnProperty.call(superseded, "next_action"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(superseded, "detail"), false);

  // Matrix row 3: missing events → bare stuck_child, no crash.
  const bare = item("leaf-bare", "stuck_child");
  assert.ok(bare);
  assert.deepEqual(bare, { leaf_ref: "leaf-bare", run_id: bareRun, reason: "stuck_child" });

  // Matrix row 4: event without next_action → detail only, key ABSENT.
  const legacy = item("leaf-legacy-event", "stuck_child");
  assert.ok(legacy);
  assert.equal(legacy.detail, "pre-261 run, no artifact");
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, "next_action"), false);

  // Enrich ONLY stuck_child when multiple reasons fire on the same child.
  const multiStuck = item("leaf-multi", "stuck_child");
  const multiMerge = item("leaf-multi", "merge_blocked");
  assert.ok(multiStuck);
  assert.ok(multiMerge);
  assert.equal(multiStuck.next_action, "rebase_and_rerun");
  assert.equal(multiStuck.detail, "branch is 1 commit behind origin/main; rebase and re-run");
  assert.deepEqual(multiMerge, {
    leaf_ref: "leaf-multi",
    run_id: multiReasonRun,
    reason: "merge_blocked",
  });

  // Non-stuck reasons stay byte-identical even with a preflight event on disk.
  const mergeOnly = item("leaf-merge-only", "merge_blocked");
  assert.ok(mergeOnly);
  assert.deepEqual(mergeOnly, {
    leaf_ref: "leaf-merge-only",
    run_id: mergeOnlyRun,
    reason: "merge_blocked",
  });
  assert.equal(item("leaf-merge-only", "stuck_child"), undefined);

  // formatStatusText: enriched inline; plain items byte-identical.
  const plainLine = "  - leaf-bare: stuck_child (issue-903-20260710010101000-a1b2c3d4)";
  const enrichedLine = "  - leaf-enriched: stuck_child (issue-901-20260710010101000-a1b2c3d4) → next: rebase_and_rerun — branch is 2 commits behind origin/main; rebase and re-run";
  const detailOnlyLine = "  - leaf-legacy-event: stuck_child (issue-904-20260710010101000-a1b2c3d4) — pre-261 run, no artifact";
  const text = formatText(payload.summary, attention);
  assert.match(text, new RegExp(`^${plainLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(text, new RegExp(`^${enrichedLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(text, new RegExp(`^${detailOnlyLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  // Plain merge_blocked line unchanged from pre-#901 shape.
  assert.match(text, /  - leaf-merge-only: merge_blocked \(issue-906-20260710010101000-a1b2c3d4\)/);

  // Unreadable events fail open (corrupt JSONL does not crash).
  const corruptRun = "issue-907-20260710010101000-a1b2c3d4";
  makeChildManifest(corruptRun, "leaf-corrupt", {
    patch: (manifest) => ({
      ...manifest,
      git: { ...manifest.git, pr_number: 907 },
    }),
  });
  fs.writeFileSync(path.join(getRunDir(repoRoot, corruptRun), "events.jsonl"), "{not-json\n", "utf-8");
  createFleetManifest(repoRoot, {
    fleetId: "fleet-stuck-corrupt",
    children: [
      { leaf_ref: "leaf-corrupt", run_id: corruptRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
    ],
  });
  const corruptResult = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-stuck-corrupt",
    "--status",
    "--json",
  ], { relayHome, env: { RELAY_GH_BIN: fakeGh } });
  assert.equal(corruptResult.status, 0, `${corruptResult.stderr}\n${corruptResult.stdout}`);
  const corruptAttention = JSON.parse(corruptResult.stdout).operator_attention;
  const corruptItem = corruptAttention.find((entry) => entry.reason === "stuck_child");
  assert.deepEqual(corruptItem, {
    leaf_ref: "leaf-corrupt",
    run_id: corruptRun,
    reason: "stuck_child",
  });

  // Direct unit pin: formatStatusText plain item is byte-identical to the
  // historical one-line shape (no next/detail suffix).
  const plainOnly = formatText(
    { fleet_id: "x", fleet_state: "draft", total_children: 0, by_dispatch_status: {}, by_run_state: {}, children: [] },
    [{ leaf_ref: "leaf-a", run_id: "run-a", reason: "stuck_child" }]
  );
  assert.match(plainOnly, /^  - leaf-a: stuck_child \(run-a\)$/m);
  assert.doesNotMatch(plainOnly, /→ next:/);
  assert.doesNotMatch(plainOnly, / — /);
});

test("relay-fleet stalled_executor operator_attention pins the six-row matrix (#931)", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-stalled-executor-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-stalled-fake-"));
  const fleetId = "fleet-stalled-executor";
  const {
    formatStatusText: formatText,
    parseArgs,
  } = require(RELAY_FLEET_SCRIPT);

  const agedStartedAt = new Date(Date.now() - 42 * 60 * 1000).toISOString();
  const freshStartedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const longStderr = `Connection lost, reconnecting to agentn.global.api5.cursor.sh ${"x".repeat(200)}`;
  const expectedStderrTail = longStderr.slice(0, 120);

  const runs = {
    stalled: "issue-931-20260711010101000-a1b2c3d4",
    stalledEmptyStderr: "issue-932-20260711010101000-a1b2c3d4",
    underThreshold: "issue-933-20260711010101000-a1b2c3d4",
    nonEmptyStdout: "issue-934-20260711010101000-a1b2c3d4",
    deadLease: "issue-935-20260711010101000-a1b2c3d4",
    missingLease: "issue-936-20260711010101000-a1b2c3d4",
    unreadableStdout: "issue-937-20260711010101000-a1b2c3d4",
    terminal: "issue-938-20260711010101000-a1b2c3d4",
    compose: "issue-939-20260711010101000-a1b2c3d4",
    healthy: "issue-940-20260711010101000-a1b2c3d4",
  };

  for (const [kind, runId] of Object.entries(runs)) {
    const state = kind === "terminal"
      ? RUN_STATES.READY_TO_MERGE
      : (kind === "compose" || kind === "healthy")
        ? RUN_STATES.REVIEW_PENDING
        : RUN_STATES.DISPATCHED;
    writeChildRun(repoRoot, {
      runId,
      branch: `issue-${runId.slice(6, 9)}-leaf-${kind}`,
      issueNumber: Number(runId.slice(6, 9)),
      leafId: `leaf-${kind}`,
      fleetId,
      state,
    });
    if (kind === "compose") {
      const manifestPath = getManifestPath(repoRoot, runId);
      const data = readManifest(manifestPath).data;
      writeManifest(manifestPath, {
        ...data,
        review: { ...data.review, rounds: 3 },
        git: { ...data.git, pr_number: 939 },
      });
    }
    if (kind === "terminal" || kind === "healthy") {
      const manifestPath = getManifestPath(repoRoot, runId);
      const data = readManifest(manifestPath).data;
      writeManifest(manifestPath, {
        ...data,
        git: { ...data.git, pr_number: kind === "terminal" ? 938 : 940 },
      });
    }
  }

  // Row 1: live + 0-byte + aged → stalled_executor with stderr tail (truncated 120).
  writeRunLeaseFixture(repoRoot, runs.stalled, { startedAt: agedStartedAt });
  writeDispatchLogs(repoRoot, runs.stalled, { stdout: "", stderr: `${longStderr}\n` });

  // Row 1b: empty stderr omits the tail clause.
  writeRunLeaseFixture(repoRoot, runs.stalledEmptyStderr, { startedAt: agedStartedAt });
  writeDispatchLogs(repoRoot, runs.stalledEmptyStderr, { stdout: "", stderr: "" });

  // Row 2: live + 0-byte + under threshold → none.
  writeRunLeaseFixture(repoRoot, runs.underThreshold, { startedAt: freshStartedAt });
  writeDispatchLogs(repoRoot, runs.underThreshold, { stdout: "" });

  // Row 3: live + non-empty stdout → none regardless of age.
  writeRunLeaseFixture(repoRoot, runs.nonEmptyStdout, { startedAt: agedStartedAt });
  writeDispatchLogs(repoRoot, runs.nonEmptyStdout, { stdout: "hello\n" });

  // Row 4: dead lease → stuck_child owns it; no stalled_executor.
  writeRunLeaseFixture(repoRoot, runs.deadLease, { pid: 2147483647, startedAt: agedStartedAt });
  writeDispatchLogs(repoRoot, runs.deadLease, { stdout: "" });

  // Row 4b: missing lease → no stalled_executor.
  writeDispatchLogs(repoRoot, runs.missingLease, { stdout: "" });

  // Row 5: unreadable/unresolvable stdout (broken symlink) → fail-open, no crash.
  writeRunLeaseFixture(repoRoot, runs.unreadableStdout, { startedAt: agedStartedAt });
  fs.symlinkSync(
    "/nonexistent/relay-fleet-stalled-stdout",
    path.join(getRunDir(repoRoot, runs.unreadableStdout), "dispatch-stdout.log")
  );

  // Row 6: terminal run state → no stalled_executor even with live+0-byte+aged.
  writeRunLeaseFixture(repoRoot, runs.terminal, { startedAt: agedStartedAt });
  writeDispatchLogs(repoRoot, runs.terminal, { stdout: "" });

  // Additive: stalled_executor composes with high_review_rounds.
  writeRunLeaseFixture(repoRoot, runs.compose, { startedAt: agedStartedAt });
  writeDispatchLogs(repoRoot, runs.compose, { stdout: "", stderr: "Connection lost\n" });

  // Healthy busy child (live lease, recent, non-empty stdout) → no stall item.
  writeRunLeaseFixture(repoRoot, runs.healthy, { startedAt: freshStartedAt });
  writeDispatchLogs(repoRoot, runs.healthy, { stdout: "progress\n" });

  createFleetManifest(repoRoot, {
    fleetId,
    children: Object.entries(runs).map(([kind, runId]) => ({
      leaf_ref: `leaf-${kind}`,
      run_id: runId,
      dispatch_status: DISPATCH_STATUS.DISPATCHED,
    })),
  });

  const fakeGh = writeFakeGhDefaultBranch(tmpDir, "main");
  const leaseBefore = fs.readFileSync(
    path.join(getRunDir(repoRoot, runs.stalled), "lease.json"),
    "utf-8"
  );
  const fleetBefore = fs.readFileSync(getFleetManifestPath(repoRoot, fleetId), "utf-8");

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--status",
    "--json",
  ], {
    relayHome,
    env: {
      RELAY_GH_BIN: fakeGh,
      // Keep default 15m; fixtures use 42m / 5m wall ages.
    },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  const attention = payload.operator_attention;

  function item(leafRef, reason) {
    return attention.find((entry) => entry.leaf_ref === leafRef && entry.reason === reason);
  }
  function reasonsFor(leafRef) {
    return attention.filter((entry) => entry.leaf_ref === leafRef).map((entry) => entry.reason).sort();
  }

  // Row 1: exact detail format with truncated stderr tail.
  const stalled = item("leaf-stalled", "stalled_executor");
  assert.ok(stalled);
  assert.equal(stalled.detail, `stdout 0 bytes for 42m; stderr tail: ${expectedStderrTail}`);
  assert.equal(expectedStderrTail.length, 120);

  // Empty stderr → no "; stderr tail:" clause.
  const stalledEmpty = item("leaf-stalledEmptyStderr", "stalled_executor");
  assert.ok(stalledEmpty);
  assert.equal(stalledEmpty.detail, "stdout 0 bytes for 42m");
  assert.equal(stalledEmpty.detail.includes("stderr"), false);

  // Rows 2–6: no stalled_executor.
  assert.equal(item("leaf-underThreshold", "stalled_executor"), undefined);
  assert.equal(item("leaf-nonEmptyStdout", "stalled_executor"), undefined);
  assert.equal(item("leaf-deadLease", "stalled_executor"), undefined);
  assert.equal(item("leaf-missingLease", "stalled_executor"), undefined);
  assert.equal(item("leaf-unreadableStdout", "stalled_executor"), undefined);
  assert.equal(item("leaf-terminal", "stalled_executor"), undefined);
  assert.equal(item("leaf-healthy", "stalled_executor"), undefined);

  // Dead lease is owned by stuck_child, not stalled_executor.
  assert.ok(item("leaf-deadLease", "stuck_child"));
  assert.equal(reasonsFor("leaf-deadLease").includes("stalled_executor"), false);

  // Additive composition.
  assert.deepEqual(reasonsFor("leaf-compose"), ["high_review_rounds", "stalled_executor"]);
  assert.equal(
    item("leaf-compose", "stalled_executor").detail,
    "stdout 0 bytes for 42m; stderr tail: Connection lost"
  );
  assert.deepEqual(item("leaf-compose", "high_review_rounds"), {
    leaf_ref: "leaf-compose",
    run_id: runs.compose,
    reason: "high_review_rounds",
  });

  // Non-stall children keep attention byte-identical (no spurious stall items).
  assert.equal(attention.some((entry) => entry.leaf_ref === "leaf-healthy"), false);
  assert.equal(attention.some((entry) => entry.leaf_ref === "leaf-underThreshold"), false);
  assert.equal(attention.some((entry) => entry.leaf_ref === "leaf-nonEmptyStdout"), false);

  // formatStatusText: one-line enriched rendering (#901 style).
  const text = formatText(payload.summary, attention);
  const stalledLine = `  - leaf-stalled: stalled_executor (${runs.stalled}) — stdout 0 bytes for 42m; stderr tail: ${expectedStderrTail}`;
  assert.match(text, new RegExp(`^${stalledLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(
    text,
    new RegExp(
      `^  - leaf-stalledEmptyStderr: stalled_executor \\(${runs.stalledEmptyStderr}\\) — stdout 0 bytes for 42m$`,
      "m"
    )
  );

  // Visibility only: --status mutates neither lease nor fleet manifest.
  assert.equal(
    fs.readFileSync(path.join(getRunDir(repoRoot, runs.stalled), "lease.json"), "utf-8"),
    leaseBefore
  );
  assert.equal(fs.readFileSync(getFleetManifestPath(repoRoot, fleetId), "utf-8"), fleetBefore);

  // No kill/signal path in the stall heuristic source.
  const source = fs.readFileSync(RELAY_FLEET_SCRIPT, "utf-8");
  const stallRegion = source.slice(
    source.indexOf("// Visibility only (#931"),
    source.indexOf("// New reasons are independent")
  );
  assert.match(stallRegion, /Visibility only/);
  assert.doesNotMatch(stallRegion, /process\.kill|terminateProcessGroup|SIGTERM|SIGKILL/);

  // Env-only threshold override; no CLI flag.
  const help = runFleet(["--help"], { relayHome });
  assert.doesNotMatch(help.stdout + help.stderr, /STALL|stall-threshold|stall_threshold/i);
  assert.equal(
    Object.prototype.hasOwnProperty.call(parseArgs(["--repo", ".", "--fleet-id", "x", "--status"]), "stallThreshold"),
    false
  );

  // Threshold override: shrink so a 5m-old empty stdout becomes stalled.
  const overrideResult = runFleet([
    "--repo", repoRoot,
    "--fleet-id", fleetId,
    "--status",
    "--json",
  ], {
    relayHome,
    env: {
      RELAY_GH_BIN: fakeGh,
      RELAY_FLEET_STALL_THRESHOLD_MS: "60000",
    },
  });
  assert.equal(overrideResult.status, 0, `${overrideResult.stderr}\n${overrideResult.stdout}`);
  const overrideAttention = JSON.parse(overrideResult.stdout).operator_attention;
  assert.ok(overrideAttention.some(
    (entry) => entry.leaf_ref === "leaf-underThreshold" && entry.reason === "stalled_executor"
  ));
});
