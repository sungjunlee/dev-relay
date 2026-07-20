const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DISPATCH_SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "dispatch.js");
const TEST_OWNERSHIP = Object.freeze({
  sprint: "backlog/sprints/2026-07-relay-fleet.md",
  track: "2026-07-relay-fleet",
  component: "relay-fleet",
});

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
  ALLOWED_TRANSITIONS,
  DISPATCH_STATUS,
  FleetIssueLockError,
  STATES,
  acquireIssueLock,
  createFleetManifest,
  createFleetManifestSkeleton,
  deleteFleetManifest,
  deriveFleetSummary,
  readFleetManifest,
  releaseIssueLock,
  updateFleetState,
  upsertFleetChild,
  validateTransition,
  writeFleetManifest,
} = require("../../../skills/relay-dispatch/scripts/manifest/fleet");

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Fleet Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-fleet@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
}

function setupRepo(prefix = "relay-fleet-") {
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  process.env.RELAY_HOME = relayHome;
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  initGitRepo(repoRoot);
  return { relayHome, repoRoot };
}

function writeNoOpCodex(binDir) {
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-fake\\n");
  process.exit(0);
}
if (args[0] !== "exec") {
  process.stderr.write("unsupported fake codex invocation");
  process.exit(1);
}
const outputIndex = args.indexOf("-o");
if (outputIndex === -1) {
  process.stderr.write("missing -o output path");
  process.exit(1);
}
fs.writeFileSync(args[outputIndex + 1], "ok\\n", "utf-8");
`, "utf-8");
  fs.chmodSync(codexPath, 0o755);
}

function writeRunManifest(repoRoot, { runId, branch, toState }) {
  const manifestPath = getManifestPath(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 477,
    worktreePath: path.join(repoRoot, "wt", branch),
  });
  if (toState === RUN_STATES.DISPATCHED) {
    manifest = updateManifestState(manifest, RUN_STATES.DISPATCHED, "await_dispatch_result");
  } else if (toState === RUN_STATES.ESCALATED) {
    manifest = updateManifestState(manifest, RUN_STATES.DISPATCHED, "await_dispatch_result");
    manifest = updateManifestState(manifest, RUN_STATES.ESCALATED, "inspect_dispatch_failure");
  }
  fs.mkdirSync(getRunDir(repoRoot, runId), { recursive: true });
  writeManifest(manifestPath, manifest);
  return manifestPath;
}

test("fleet manifest CRUD round-trips exact fleet fields and nullable pre-manifest child", () => {
  const { repoRoot } = setupRepo();
  assert.equal(Object.isFrozen(DISPATCH_STATUS), true);

  const created = createFleetManifest(repoRoot, {
    fleetId: "fleet-phase-1",
    children: [
      {
        leaf_ref: "leaf-a",
        run_id: null,
        dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
      },
    ],
  });
  assert.equal(created.manifestPath, getFleetManifestPath(repoRoot, "fleet-phase-1"));

  const readBack = readFleetManifest(repoRoot, "fleet-phase-1");
  assert.deepEqual(Object.keys(readBack.data), ["fleet_id", "fleet_state", "children", "timestamps"]);
  assert.equal(readBack.data.fleet_id, "fleet-phase-1");
  assert.equal(readBack.data.fleet_state, STATES.DRAFT);
  assert.deepEqual(readBack.data.children, [{
    leaf_ref: "leaf-a",
    run_id: null,
    dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
  }]);

  const updated = upsertFleetChild(readBack.data, {
    leaf_ref: "leaf-b",
    run_id: null,
    dispatch_status: DISPATCH_STATUS.PENDING,
  });
  writeFleetManifest(repoRoot, updated);
  assert.equal(readFleetManifest(repoRoot, "fleet-phase-1").data.children.length, 2);
  assert.equal(deleteFleetManifest(repoRoot, "fleet-phase-1"), true);
  assert.equal(fs.existsSync(created.manifestPath), false);
});

test("fleet state machine accepts every valid pair and rejects every invalid pair", () => {
  const states = Object.values(STATES);
  for (const fromState of states) {
    for (const toState of states) {
      if (ALLOWED_TRANSITIONS[fromState].has(toState)) {
        assert.doesNotThrow(() => validateTransition(fromState, toState), `${fromState} -> ${toState}`);
      } else {
        assert.throws(
          () => validateTransition(fromState, toState),
          /Invalid relay fleet state transition/,
          `${fromState} -> ${toState}`
        );
      }
    }
  }

  assert.throws(() => validateTransition("bad", STATES.DRAFT), /Unknown relay fleet state/);
  assert.throws(() => validateTransition(STATES.DRAFT, "bad"), /Unknown relay fleet state/);
});

test("updateFleetState applies the draft-dispatching-dispatched-reviewing-merging-closed chain", () => {
  let fleet = createFleetManifestSkeleton({ fleetId: "fleet-state-chain" });
  fleet = updateFleetState(fleet, STATES.DISPATCHING);
  assert.equal(fleet.fleet_state, STATES.DISPATCHING);
  fleet = updateFleetState(fleet, STATES.DISPATCHED);
  assert.equal(fleet.fleet_state, STATES.DISPATCHED);
  fleet = updateFleetState(fleet, STATES.REVIEWING);
  assert.equal(fleet.fleet_state, STATES.REVIEWING);
  fleet = updateFleetState(fleet, STATES.REVIEWING);
  assert.equal(fleet.fleet_state, STATES.REVIEWING);
  fleet = updateFleetState(fleet, STATES.MERGING);
  assert.equal(fleet.fleet_state, STATES.MERGING);
  fleet = updateFleetState(fleet, STATES.MERGING);
  assert.equal(fleet.fleet_state, STATES.MERGING);
  fleet = updateFleetState(fleet, STATES.CLOSED);
  assert.equal(fleet.fleet_state, STATES.CLOSED);
  assert.throws(() => updateFleetState(fleet, STATES.DRAFT), /Invalid relay fleet state transition/);
});

test("deriveFleetSummary computes mixed child state from fleet children plus child manifests", () => {
  const { repoRoot } = setupRepo("relay-fleet-summary-");
  const dispatchedRun = "issue-477-20260514010101000-a1b2c3d4";
  const escalatedRun = "issue-477-20260514010102000-a1b2c3d4";
  const missingRun = "issue-477-20260514010103000-a1b2c3d4";
  writeRunManifest(repoRoot, {
    runId: dispatchedRun,
    branch: "issue-477-dispatched",
    toState: RUN_STATES.DISPATCHED,
  });
  writeRunManifest(repoRoot, {
    runId: escalatedRun,
    branch: "issue-477-escalated",
    toState: RUN_STATES.ESCALATED,
  });

  const fleet = createFleetManifestSkeleton({
    fleetId: "fleet-summary",
    children: [
      { leaf_ref: "leaf-dispatched", run_id: dispatchedRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      { leaf_ref: "leaf-escalated", run_id: escalatedRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
      {
        leaf_ref: "leaf-pre-manifest",
        run_id: null,
        dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
      },
      { leaf_ref: "leaf-missing", run_id: missingRun, dispatch_status: DISPATCH_STATUS.DISPATCHED },
    ],
  });

  const summary = deriveFleetSummary(repoRoot, fleet);
  assert.equal(summary.total_children, 4);
  assert.deepEqual(summary.by_dispatch_status, {
    [DISPATCH_STATUS.DISPATCHED]: 3,
    [DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST]: 1,
  });
  assert.equal(summary.by_run_state[RUN_STATES.DISPATCHED], 1);
  assert.equal(summary.by_run_state[RUN_STATES.ESCALATED], 1);
  assert.equal(summary.by_run_state.no_run_manifest, 1);
  assert.equal(summary.by_run_state.missing_manifest, 1);
  assert.equal(summary.children.find((child) => child.leaf_ref === "leaf-pre-manifest").run_id, null);
});

test("child manifest skeleton writes fleet_id on first manifest write when supplied", () => {
  const { repoRoot } = setupRepo("relay-fleet-back-pointer-");
  const runId = "issue-477-20260514020202000-a1b2c3d4";
  const manifestPath = getManifestPath(repoRoot, runId);
  const manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-477-back-pointer",
    baseBranch: "main",
    issueNumber: 477,
    worktreePath: path.join(repoRoot, "wt"),
    fleetId: "fleet-back-pointer",
  });
  fs.mkdirSync(getRunDir(repoRoot, runId), { recursive: true });
  writeManifest(manifestPath, manifest);

  assert.equal(readManifest(manifestPath).data.fleet_id, "fleet-back-pointer");

  const nonFleet = createManifestSkeleton({
    repoRoot,
    runId: "issue-478-20260514020203000-a1b2c3d4",
    branch: "issue-478-no-fleet",
    baseBranch: "main",
    issueNumber: 478,
    worktreePath: path.join(repoRoot, "wt-2"),
  });
  assert.equal(Object.prototype.hasOwnProperty.call(nonFleet, "fleet_id"), false);
});

test("fleet issue lock blocks concurrent same-issue acquisition and releases cleanly", () => {
  const { repoRoot } = setupRepo("relay-fleet-lock-");
  const first = acquireIssueLock({
    repoRoot,
    issueNumber: 477,
    fleetId: "fleet-one",
    runId: "issue-477-20260514030303000-a1b2c3d4",
  });
  assert.equal(fs.existsSync(first.lockPath), true);
  assert.throws(
    () => acquireIssueLock({
      repoRoot,
      issueNumber: 477,
      fleetId: "fleet-two",
      runId: "issue-477-20260514030304000-a1b2c3d4",
    }),
    FleetIssueLockError
  );
  assert.equal(releaseIssueLock(first), true);

  const second = acquireIssueLock({
    repoRoot,
    issueNumber: 477,
    fleetId: "fleet-two",
    runId: "issue-477-20260514030304000-a1b2c3d4",
  });
  assert.equal(releaseIssueLock(second), true);
});

test("fleet issue lock recovers stale holders", () => {
  const { repoRoot } = setupRepo("relay-fleet-stale-lock-");
  const lockPath = getFleetIssueLockPath(repoRoot, 477);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    issue_number: 477,
    fleet_id: "fleet-stale",
    run_id: null,
    pid: process.pid,
    hostname: os.hostname(),
    acquired_at: "2000-01-01T00:00:00.000Z",
    stale_after_ms: 1,
    token: "stale-token",
  }), "utf-8");

  const lock = acquireIssueLock({
    repoRoot,
    issueNumber: 477,
    fleetId: "fleet-fresh",
    runId: "issue-477-20260514040404000-a1b2c3d4",
    staleMs: 1,
    now: () => new Date("2026-05-14T00:00:00.000Z"),
  });
  const record = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  assert.equal(record.fleet_id, "fleet-fresh");
  assert.equal(releaseIssueLock(lock), true);
});

test("fleet issue lock recovers unreadable stale lock files by mtime", () => {
  const { repoRoot } = setupRepo("relay-fleet-corrupt-stale-lock-");
  const lockPath = getFleetIssueLockPath(repoRoot, 477);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "{not-json", "utf-8");
  const oldDate = new Date("2000-01-01T00:00:00.000Z");
  fs.utimesSync(lockPath, oldDate, oldDate);

  const lock = acquireIssueLock({
    repoRoot,
    issueNumber: 477,
    fleetId: "fleet-fresh",
    runId: "issue-477-20260514040405000-a1b2c3d4",
    staleMs: 1,
    now: () => new Date("2026-05-14T00:00:00.000Z"),
  });

  const record = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  assert.equal(record.fleet_id, "fleet-fresh");
  assert.equal(releaseIssueLock(lock), true);
});

test("dispatch --fleet-id writes the child back-pointer and releases the issue lock", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-dispatch-");
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fleet-bin-"));
  writeNoOpCodex(binDir);
  const rubricPath = path.join(os.tmpdir(), `relay-fleet-rubric-${Date.now()}.yaml`);
  fs.writeFileSync(rubricPath, "rubric:\n  size_class: S\n", "utf-8");

  const result = spawnSync(process.execPath, [
    DISPATCH_SCRIPT,
    repoRoot,
    "-b", "issue-477-fleet-dispatch",
    "-p", "issue-477 fleet dispatch",
    "--executor", "codex",
    "--rubric-file", rubricPath,
    "--fleet-id", "fleet-dispatch",
    "--ownership-json", JSON.stringify(TEST_OWNERSHIP),
    "--timeout", "5",
    "--json",
  ], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      RELAY_HOME: relayHome,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const manifest = readManifest(payload.manifestPath).data;
  assert.equal(manifest.fleet_id, "fleet-dispatch");
  assert.deepEqual(manifest.ownership, TEST_OWNERSHIP);
  assert.equal(payload.fleetId, "fleet-dispatch");
  assert.equal(fs.existsSync(getFleetIssueLockPath(repoRoot, 477)), false);
});

test("dispatch --fleet-id refuses an active same-issue fleet lock before executor spawn", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-dispatch-lock-");
  const lock = acquireIssueLock({
    repoRoot,
    issueNumber: 477,
    fleetId: "fleet-held",
    runId: "issue-477-20260514050505000-a1b2c3d4",
  });
  const rubricPath = path.join(os.tmpdir(), `relay-fleet-rubric-lock-${Date.now()}.yaml`);
  fs.writeFileSync(rubricPath, "rubric:\n  size_class: S\n", "utf-8");

  try {
    const result = spawnSync(process.execPath, [
      DISPATCH_SCRIPT,
      repoRoot,
      "-b", "issue-477-fleet-locked",
      "-p", "issue-477 fleet dispatch",
      "--executor", "codex",
      "--rubric-file", rubricPath,
      "--fleet-id", "fleet-blocked",
      "--ownership-json", JSON.stringify(TEST_OWNERSHIP),
      "--timeout", "5",
      "--json",
    ], {
      encoding: "utf-8",
      env: {
        ...process.env,
        RELAY_HOME: relayHome,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fleet issue lock is already held/);
    assert.equal(result.stderr.includes("codex CLI not found"), false);
  } finally {
    releaseIssueLock(lock);
  }
});
