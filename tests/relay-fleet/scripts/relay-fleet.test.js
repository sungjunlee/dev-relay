const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RELAY_FLEET_SCRIPT = path.join(REPO_ROOT, "skills", "relay-fleet", "scripts", "relay-fleet.js");

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
    request_id: overrides.request_id || "req-20260514010101000",
    leaf_id: overrides.leaf_id || leafRef,
    ...overrides,
  };
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

const sourceRoot = process.env.RELAY_SOURCE_ROOT;
const {
  getManifestPath,
  getRunDir,
} = require(path.join(sourceRoot, "skills", "relay-dispatch", "scripts", "manifest", "paths"));
const {
  createManifestSkeleton,
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
  fs.appendFileSync(process.env.FAKE_DISPATCH_LOG, JSON.stringify(record) + "\\n", "utf-8");
}
async function main() {
  const branch = get(["--branch", "-b"]);
  const leafId = get("--leaf-id");
  const fleetId = get("--fleet-id");
  const dryRun = has("--dry-run");
  const config = process.env.FAKE_DISPATCH_CONFIG
    ? JSON.parse(fs.readFileSync(process.env.FAKE_DISPATCH_CONFIG, "utf-8"))
    : {};
  const plan = config[branch] || {};
  const issueNumber = issueFromBranch(branch);
  appendLog({ event: "spawn", branch, leafId, fleetId, dryRun, args });
  if (plan.delay_before_manifest_ms) {
    await sleep(plan.delay_before_manifest_ms);
  }
  if (plan.fail_before_manifest) {
    process.stderr.write("fake pre-manifest failure\\n");
    process.exit(plan.exit_code || 17);
  }
  const runId = plan.run_id || \`issue-\${issueNumber}-2026051401010\${String(Math.abs(branch.length) % 10)}000-a1b2c3d4\`;
  const manifestPath = getManifestPath(repoRoot, runId);
  const runDir = getRunDir(repoRoot, runId);
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

  assert.equal(result.status, 0, result.stderr);
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

  await waitFor(() => readJsonLines(logPath).length === 1);
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
  assert.equal(readJsonLines(logPath).length, 1);
  await new Promise((resolve) => first.on("close", resolve));
});

test("relay-fleet --dry-run fans out to dispatch dry-run without writing a fleet manifest", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-dry-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-"));
  const dispatchScript = writeFakeDispatchScript(tmpDir);
  const logPath = path.join(tmpDir, "dispatch.log");
  const leaves = [makeLeaf(repoRoot, 1, { issue_number: 504 }), makeLeaf(repoRoot, 2, { issue_number: 505 })];
  const leavesFile = writeLeavesFile(repoRoot, leaves);

  const result = runFleet([
    "--repo", repoRoot,
    "--fleet-id", "fleet-dry",
    "--leaves-file", leavesFile,
    "--dispatch-script", dispatchScript,
    "--dry-run",
    "--json",
  ], {
    relayHome,
    env: { FAKE_DISPATCH_LOG: logPath },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.children.length, 2);
  assert.equal(fs.existsSync(getFleetManifestPath(repoRoot, "fleet-dry")), false);
  assert.equal(readJsonLines(logPath).every((entry) => entry.dryRun && entry.fleetId === "fleet-dry"), true);
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
  assert.equal(fs.readFileSync(created.manifestPath, "utf-8"), before);
});
