const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const MERGE_QUEUE_SCRIPT = path.join(REPO_ROOT, "skills", "relay-fleet", "scripts", "merge-queue.js");

const {
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
  createFleetManifest,
  readFleetManifest,
  writeFleetManifest,
} = require("../../../skills/relay-dispatch/scripts/manifest/fleet");

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Fleet Merge Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-fleet-merge@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
}

function setupRepo(prefix = "relay-fleet-merge-") {
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  process.env.RELAY_HOME = relayHome;
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  initGitRepo(repoRoot);
  return { relayHome, repoRoot };
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeReadyRun(repoRoot, { runId, branch, issueNumber, leafId, fleetId }) {
  fs.mkdirSync(getRunDir(repoRoot, runId), { recursive: true });
  fs.writeFileSync(path.join(getRunDir(repoRoot, runId), "rubric.yaml"), "rubric:\n  size_class: S\n", "utf-8");
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
  manifest = {
    ...manifest,
    git: {
      ...(manifest.git || {}),
      head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    anchor: {
      ...(manifest.anchor || {}),
      rubric_path: "rubric.yaml",
    },
    review: {
      ...(manifest.review || {}),
      rounds: 1,
    },
  };
  manifest = updateManifestState(manifest, RUN_STATES.DISPATCHED, "await_dispatch_result");
  manifest = updateManifestState(manifest, RUN_STATES.REVIEW_PENDING, "await_review");
  manifest = updateManifestState(manifest, RUN_STATES.READY_TO_MERGE, "ready");
  writeManifest(getManifestPath(repoRoot, runId), manifest);
  return runId;
}

function createReviewingFleet(repoRoot, fleetId, children) {
  createFleetManifest(repoRoot, { fleetId, children });
  let fleet = readFleetManifest(repoRoot, fleetId).data;
  fleet.fleet_state = FLEET_STATES.REVIEWING;
  writeFleetManifest(repoRoot, fleet);
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

function runMergeQueue(args, { relayHome, env = {}, timeout = 10000 } = {}) {
  return spawnSync(process.execPath, [MERGE_QUEUE_SCRIPT, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      RELAY_HOME: relayHome,
      RELAY_SOURCE_ROOT: REPO_ROOT,
      ...env,
    },
    timeout,
  });
}

test("merge-queue serially finalizes ready fleet children in manifest order", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-merge-green-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-merge-fake-"));
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const logPath = path.join(tmpDir, "finalize.log");
  const runA = writeReadyRun(repoRoot, {
    runId: "issue-530-20260516010101000-a1b2c3d4",
    branch: "issue-530-a",
    issueNumber: 530,
    leafId: "leaf-a",
    fleetId: "fleet-merge-green",
  });
  const runB = writeReadyRun(repoRoot, {
    runId: "issue-531-20260516010101000-a1b2c3d4",
    branch: "issue-531-b",
    issueNumber: 531,
    leafId: "leaf-b",
    fleetId: "fleet-merge-green",
  });
  createReviewingFleet(repoRoot, "fleet-merge-green", [
    { leaf_ref: "leaf-a", run_id: runA, dispatch_status: DISPATCH_STATUS.DISPATCHED },
    { leaf_ref: "leaf-b", run_id: runB, dispatch_status: DISPATCH_STATUS.DISPATCHED },
  ]);

  const result = runMergeQueue([
    "--repo", repoRoot,
    "--fleet-id", "fleet-merge-green",
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: { FAKE_FINALIZE_LOG: logPath },
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.results.length, 2);
  assert.deepEqual(readJsonLines(logPath).map((entry) => entry.runId), [runA, runB]);
  assert.equal(readFleetManifest(repoRoot, "fleet-merge-green").data.fleet_state, FLEET_STATES.MERGING);
  assert.equal(readManifest(getManifestPath(repoRoot, runA)).data.state, RUN_STATES.MERGED);
  assert.equal(readManifest(getManifestPath(repoRoot, runB)).data.state, RUN_STATES.MERGED);
});

test("merge-queue stops at first merge failure and marks that child merge_blocked", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-merge-red-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-merge-red-fake-"));
  const finalizeScript = writeFakeFinalizeScript(tmpDir);
  const logPath = path.join(tmpDir, "finalize.log");
  const configPath = path.join(tmpDir, "finalize-config.json");
  const runA = writeReadyRun(repoRoot, {
    runId: "issue-532-20260516010101000-a1b2c3d4",
    branch: "issue-532-a",
    issueNumber: 532,
    leafId: "leaf-a",
    fleetId: "fleet-merge-red",
  });
  const runB = writeReadyRun(repoRoot, {
    runId: "issue-533-20260516010101000-a1b2c3d4",
    branch: "issue-533-b",
    issueNumber: 533,
    leafId: "leaf-b",
    fleetId: "fleet-merge-red",
  });
  const runC = writeReadyRun(repoRoot, {
    runId: "issue-534-20260516010101000-a1b2c3d4",
    branch: "issue-534-c",
    issueNumber: 534,
    leafId: "leaf-c",
    fleetId: "fleet-merge-red",
  });
  writeJson(configPath, { [runB]: { fail: true, error: "fake stale base" } });
  createReviewingFleet(repoRoot, "fleet-merge-red", [
    { leaf_ref: "leaf-a", run_id: runA, dispatch_status: DISPATCH_STATUS.DISPATCHED },
    { leaf_ref: "leaf-b", run_id: runB, dispatch_status: DISPATCH_STATUS.DISPATCHED },
    { leaf_ref: "leaf-c", run_id: runC, dispatch_status: DISPATCH_STATUS.DISPATCHED },
  ]);

  const result = runMergeQueue([
    "--repo", repoRoot,
    "--fleet-id", "fleet-merge-red",
    "--finalize-script", finalizeScript,
    "--json",
  ], {
    relayHome,
    env: {
      FAKE_FINALIZE_CONFIG: configPath,
      FAKE_FINALIZE_LOG: logPath,
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.results[1].status, "merge_blocked");
  assert.deepEqual(readJsonLines(logPath).map((entry) => entry.runId), [runA, runB]);
  assert.equal(readManifest(getManifestPath(repoRoot, runA)).data.state, RUN_STATES.MERGED);
  assert.equal(readManifest(getManifestPath(repoRoot, runB)).data.state, RUN_STATES.MERGE_BLOCKED);
  assert.equal(readManifest(getManifestPath(repoRoot, runC)).data.state, RUN_STATES.READY_TO_MERGE);
  assert.equal(payload.operator_attention.some((item) => item.run_id === runB && item.reason === RUN_STATES.MERGE_BLOCKED), true);
});

test("merge-queue treats an empty ready queue as complete when no child needs attention", () => {
  const { relayHome, repoRoot } = setupRepo("relay-fleet-merge-empty-");
  const runId = writeReadyRun(repoRoot, {
    runId: "issue-535-20260516010101000-a1b2c3d4",
    branch: "issue-535-a",
    issueNumber: 535,
    leafId: "leaf-a",
    fleetId: "fleet-merge-empty",
  });
  const record = readManifest(getManifestPath(repoRoot, runId));
  writeManifest(getManifestPath(repoRoot, runId), updateManifestState(record.data, RUN_STATES.MERGED, "done"), record.body);
  createReviewingFleet(repoRoot, "fleet-merge-empty", [
    { leaf_ref: "leaf-a", run_id: runId, dispatch_status: DISPATCH_STATUS.DISPATCHED },
  ]);

  const result = runMergeQueue([
    "--repo", repoRoot,
    "--fleet-id", "fleet-merge-empty",
    "--json",
  ], { relayHome });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.queued_children, []);
  assert.deepEqual(payload.results, []);
});
