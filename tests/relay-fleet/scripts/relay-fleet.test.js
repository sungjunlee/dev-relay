const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RELAY_FLEET_SCRIPT = path.join(REPO_ROOT, "skills", "relay-fleet", "scripts", "relay-fleet.js");

const { getFleetRuntimePath } = require(RELAY_FLEET_SCRIPT);
const {
  getFleetIssueLockPath,
  getFleetManifestPath,
  getManifestPath,
  getRunDir,
} = require("../../../skills/relay-dispatch/scripts/manifest/paths");
const {
  createManifestSkeleton,
  readManifest,
  writeManifest,
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
  writeFleetManifest,
} = require("../../../skills/relay-dispatch/scripts/manifest/fleet");
const {
  getRequestPath,
  persistRequestContract,
} = require("../../../skills/relay-ready/scripts/relay-request");

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Fleet Skill Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-fleet-skill@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
}

function setupRepo(prefix = "relay-fleet-skill-") {
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  process.env.RELAY_HOME = relayHome;
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  initGitRepo(repoRoot);
  return { relayHome, repoRoot };
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

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeChildRun(repoRoot, {
  runId,
  branch,
  issueNumber,
  leafId,
  fleetId,
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

function runFleet(args, { relayHome, env = {}, timeout = 10000 } = {}) {
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
async function main() {
  const manifestInput = get("--manifest");
  const branch = get(["--branch", "-b"]);
  const leafId = get("--leaf-id");
  const fleetId = get("--fleet-id");
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
    process.stderr.write("fake pre-manifest failure\\n");
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
    process.stderr.write("fake pre-manifest failure\\n");
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
    if (plan.run_state === "review_pending") {
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
  if (plan.transition_after_delay_to === "review_pending" && fs.existsSync(manifestPath)) {
    const record = readManifest(manifestPath);
    if (record.data.state === STATES.DISPATCHED) {
      writeManifest(manifestPath, updateManifestState(record.data, STATES.REVIEW_PENDING, "await_review"), record.body);
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
  if (plan.to_state === "ready_to_merge") {
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
    assert.deepEqual(fleet.children, [{
      leaf_ref: "leaf-01",
      run_id: null,
      dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
    }]);
    assert.equal(readJsonLines(logPath).length, 0);
  } finally {
    releaseIssueLock(lock);
  }
});

test("relay-fleet records and resumes a child dispatch that fails before manifest creation", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-premanifest-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const configPath = path.join(tmpDir, "config.json");
  const leaf = makeLeaf(repoRoot, 1, { issue_number: 483 });
  const leavesFile = writeLeavesFile(repoRoot, [leaf]);
  writeJson(configPath, { [leaf.branch]: { fail_before_manifest: true } });

  const failed = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-premanifest",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_CONFIG: configPath },
  });

  assert.notEqual(failed.status, 0);
  assert.equal(
    readFleetManifest(repoRoot, "fleet-premanifest").data.children[0].dispatch_status,
    DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST
  );

  writeJson(configPath, {});
  const resumed = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-premanifest",
    "--resume",
    "--dispatch-script", dispatchScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_CONFIG: configPath },
  });

  assert.equal(resumed.status, 0, resumed.stderr);
  const child = readFleetManifest(repoRoot, "fleet-premanifest").data.children[0];
  assert.equal(child.dispatch_status, DISPATCH_STATUS.DISPATCHED);
  assert.match(child.run_id, /^issue-483-/);
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
    timeout: 7000,
  });
  const elapsedMs = Date.now() - started;

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(elapsedMs < 4500, `fleet should not wait for detached child tail delay; elapsed=${elapsedMs}`);
  const logs = readJsonLines(logPath);
  assert.ok(logs.some((entry) => entry.args.includes("--detach")), "fleet must pass --detach to dispatch.js");
  assert.ok(logs.some((entry) => entry.detachedChild), "fake detached child must start outside the fleet launcher");
  const fleet = readFleetManifest(repoRoot, "fleet-detach").data;
  const child = fleet.children[0];
  assert.equal(child.dispatch_status, DISPATCH_STATUS.DISPATCHED);
  assert.match(child.run_id, /^issue-802-/);
  const manifestPath = getManifestPath(repoRoot, child.run_id);
  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, RUN_STATES.DISPATCHED);

  await waitFor(() => readManifest(manifestPath).data.state === RUN_STATES.REVIEW_PENDING, {
    timeoutMs: 8000,
    intervalMs: 100,
  });
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

test("relay-fleet resume re-adopts orphan child via fleet_id back-pointer", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-orphan-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const runId = "issue-501-20260514010101000-a1b2c3d4";
  createFleetManifest(repoRoot, {
    fleetId: "fleet-orphan",
    children: [{ leaf_ref: "leaf-01", run_id: null, dispatch_status: DISPATCH_STATUS.PENDING }],
  });
  const manifestPath = getManifestPath(repoRoot, runId);
  fs.mkdirSync(getRunDir(repoRoot, runId), { recursive: true });
  let childManifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-501-leaf-01",
    baseBranch: "main",
    issueNumber: 501,
    worktreePath: path.join(repoRoot, "wt"),
    leafId: "leaf-01",
    fleetId: "fleet-orphan",
  });
  childManifest = updateManifestState(childManifest, RUN_STATES.DISPATCHED, "await_dispatch_result");
  writeManifest(manifestPath, childManifest);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-orphan",
    "--resume",
    "--dispatch-script", dispatchScript,
    "--json",
  ], { relayHome });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const child = readFleetManifest(repoRoot, "fleet-orphan").data.children[0];
  assert.equal(child.run_id, runId);
  assert.equal(child.dispatch_status, DISPATCH_STATUS.DISPATCHED);
});

test("SIGINT during fan-out leaves a consistent fleet manifest and resume recovers", async () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-sigint-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
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
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_DISPATCH_CONFIG: configPath,
      FAKE_DISPATCH_LOG: logPath,
    },
  });

  assert.equal(resumed.status, 0, resumed.stderr);
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
  let fleet = readFleetManifest(repoRoot, "fleet-review").data;
  fleet.fleet_state = FLEET_STATES.DISPATCHED;
  writeFleetManifest(repoRoot, fleet);

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
  let fleet = readFleetManifest(repoRoot, "fleet-review-stall").data;
  fleet.fleet_state = FLEET_STATES.DISPATCHED;
  writeFleetManifest(repoRoot, fleet);

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
  let fleet = readFleetManifest(repoRoot, "fleet-review-state").data;
  fleet.fleet_state = FLEET_STATES.DISPATCHED;
  writeFleetManifest(repoRoot, fleet);

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

test("relay-fleet --review redispatches changes_requested children and re-reviews to ready_to_merge", () => {
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
  let fleet = readFleetManifest(repoRoot, "fleet-review-loop").data;
  fleet.fleet_state = FLEET_STATES.DISPATCHED;
  writeFleetManifest(repoRoot, fleet);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-review-loop",
    "--review",
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
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
  assert.match(readJsonLines(dispatchLog)[0].args.join(" "), /--manifest/);
  assert.equal(readJsonLines(reviewLog).length, 2);
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.state, RUN_STATES.READY_TO_MERGE);
});

test("relay-fleet --resume re-enters the review loop for changes_requested children", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-review-resume-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-review-resume-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const reviewScript = writeFakeReviewScript(tmpDir);
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
  let fleet = readFleetManifest(repoRoot, "fleet-review-resume").data;
  fleet.fleet_state = FLEET_STATES.REVIEWING;
  writeFleetManifest(repoRoot, fleet);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-review-resume",
    "--resume",
    "--dispatch-script", dispatchScript,
    "--review-script", reviewScript,
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
  assert.equal(readJsonLines(reviewLog).length, 1);
  assert.equal(readManifest(getManifestPath(repoRoot, runId)).data.state, RUN_STATES.READY_TO_MERGE);
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
  let fleet = readFleetManifest(repoRoot, "fleet-review-resume-failure").data;
  fleet.fleet_state = FLEET_STATES.REVIEWING;
  writeFleetManifest(repoRoot, fleet);

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
  let fleet = readFleetManifest(repoRoot, "fleet-review-running").data;
  fleet.fleet_state = FLEET_STATES.DISPATCHED;
  writeFleetManifest(repoRoot, fleet);

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
  assert.match(
    textResult.stdout,
    /leaf-failed \| run_id=null \| dispatch_status=dispatch_failed_pre_manifest \| run_state=no_run_manifest/,
  );
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
