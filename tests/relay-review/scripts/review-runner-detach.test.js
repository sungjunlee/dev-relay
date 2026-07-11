// Issue #951: review-runner --detach (crash-only review rounds, dispatch.js symmetry).
// Covers DC #6: (a) receipt shape + prompt return, (b) invoker-kill survival,
// (c) lease shape + sentinel, (d) verdict-persisted/apply-missing --review-file recovery.
// Every flavor asserts real run-dir files and the final manifest state, not mocked spawns.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  ensureRunLayout,
  updateManifestState,
  writeManifest,
  readManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const {
  DEFAULT_ENFORCEMENT_RUBRIC,
  createEnforcementFixture,
} = require("../../relay-dispatch/scripts/test-support");
const { EXECUTION_EVIDENCE_FILENAME } = require("../../../skills/relay-review/scripts/review-runner/execution-evidence");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "review-runner.js");

function defaultRubricScores() {
  return [{
    factor: "Default enforcement rubric",
    target: ">= 1/1",
    observed: "1/1",
    status: "pass",
    tier: "contract",
    notes: "The enforcement fixture rubric remained satisfied.",
  }];
}

function writeExecutionEvidence(runDir, headSha) {
  fs.writeFileSync(path.join(runDir, EXECUTION_EVIDENCE_FILENAME), `${JSON.stringify({
    schema_version: 1,
    head_sha: headSha,
    test_command: "unspecified",
    test_result_hash: "unspecified",
    test_result_summary: "unspecified",
    recorded_at: "2026-07-12T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  }, null, 2)}\n`, "utf-8");
}

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-detach-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-detach-origin-"));
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["init", "--bare", remoteRoot], { stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Detach Test"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-detach@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteRoot], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, stdio: "pipe" });

  const runId = "issue-951-20260712010000000";
  const worktreePath = path.join(repoRoot, "wt", "issue-951");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", "issue-951"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(worktreePath, "marker.txt"), "worktree\n", "utf-8");

  // ensureRunLayout + getRunDir resolve under RELAY_HOME, so set it before laying the run out.
  const priorRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = relayHome;
  const { manifestPath, runDir } = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot, runId, branch: "issue-951", baseBranch: "main", issueNumber: 951,
    worktreePath, orchestrator: "codex", executor: "codex", reviewer: "claude",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor = createEnforcementFixture({
    repoRoot, runId, state: "loaded", rubricContent: DEFAULT_ENFORCEMENT_RUBRIC,
  }).anchor;
  const headSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  manifest = { ...manifest, git: { ...(manifest.git || {}), pr_number: 123, head_sha: headSha } };
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  writeManifest(manifestPath, manifest);
  writeExecutionEvidence(runDir, headSha);
  if (priorRelayHome === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = priorRelayHome;

  const doneCriteriaPath = path.join(repoRoot, "done-criteria.md");
  const diffPath = path.join(repoRoot, "pr.diff");
  fs.writeFileSync(doneCriteriaPath, "# Done Criteria\n\n- Add smoke.txt\n", "utf-8");
  fs.writeFileSync(diffPath, "diff --git a/smoke.txt b/smoke.txt\n+ok\n", "utf-8");
  return { repoRoot, relayHome, worktreePath, manifestPath, runId, runDir, doneCriteriaPath, diffPath, headSha };
}

const CHANGES_REQUESTED_VERDICT = {
  verdict: "changes_requested",
  summary: "Contract drift found.",
  contract_status: "fail",
  quality_review_status: "not_run",
  quality_execution_status: "pass",
  next_action: "changes_requested",
  issues: [{
    title: "Missing contract item", body: "smoke.txt not present.",
    file: "src/index.js", line: 10, category: "contract", severity: "high", confidence: "high",
  }],
  rubric_scores: defaultRubricScores(),
  scope_drift: { creep: [], missing: [] },
};

// A real reviewer subprocess (not --review-file): sleeps `delayMs`, then emits the verdict
// on stdout. The delay keeps the detached round in-flight while the invoker is killed.
function writeReviewerScript(repoRoot, name, verdict, { delayMs = 0 } = {}) {
  const filePath = path.join(repoRoot, name);
  const body = `#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write(${JSON.stringify(JSON.stringify(verdict))});
}, ${Number(delayMs)});
`;
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeVerdictFile(repoRoot, name, verdict) {
  const filePath = path.join(repoRoot, name);
  fs.writeFileSync(filePath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");
  return filePath;
}

function detachEnv(relayHome) {
  return { ...process.env, RELAY_HOME: relayHome };
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let done = false;
    try { done = await predicate(); } catch { done = false; }
    if (done) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function killPgidQuietly(pgid) {
  if (!pgid) return;
  try { process.kill(-pgid, "SIGKILL"); } catch {}
}

// ---- DC #6a: receipt shape + prompt return -------------------------------

test("--detach prints a receipt and returns before the round finishes (DC #6a)", async () => {
  const { repoRoot, relayHome, manifestPath, runId, runDir, doneCriteriaPath, diffPath } = setupRepo();
  // 2.5s reviewer delay: the parent must return long before the round applies its verdict.
  const reviewerScript = writeReviewerScript(repoRoot, "reviewer-slow.js", CHANGES_REQUESTED_VERDICT, { delayMs: 2500 });

  const started = Date.now();
  const launched = spawnSync(process.execPath, [
    SCRIPT, "--repo", repoRoot, "--run-id", runId, "--pr", "123",
    "--done-criteria-file", doneCriteriaPath, "--diff-file", diffPath,
    "--reviewer-script", reviewerScript, "--no-comment", "--detach", "--json",
  ], { encoding: "utf-8", env: detachEnv(relayHome), timeout: 15000 });
  const elapsedMs = Date.now() - started;

  assert.equal(launched.status, 0, `${launched.stderr}\n${launched.stdout}`);
  assert.ok(elapsedMs < 2500, `parent returned before the reviewer delay elapsed (got ${elapsedMs}ms)`);

  const receipt = JSON.parse(launched.stdout);
  assert.equal(receipt.status, "detached");
  assert.equal(receipt.runId, runId);
  assert.equal(receipt.round, 1);
  assert.equal(Number.isInteger(receipt.pid) && receipt.pid > 0, true, "receipt carries a pid");
  assert.equal(Number.isInteger(receipt.pgid) && receipt.pgid > 0, true, "receipt carries a pgid");
  assert.equal(receipt.sentinelPath, path.join(runDir, "review-round-1.done"));
  assert.equal(receipt.leasePath, path.join(runDir, "lease.json"));
  assert.equal(receipt.manifestPath, manifestPath);
  assert.equal(typeof receipt.logPath, "string");
  assert.match(receipt.recoverCommand, /--review-file/);
  assert.match(receipt.recoverCommand, /--manual-review-reason/);

  // The round still completes end-to-end after the parent returned.
  await waitFor(() => fs.existsSync(receipt.sentinelPath), { message: "completion sentinel" });
  await waitFor(() => readManifest(manifestPath).data.state === STATES.CHANGES_REQUESTED, {
    message: "manifest verdict applied by the detached round",
  });
  const sentinel = JSON.parse(fs.readFileSync(receipt.sentinelPath, "utf-8"));
  assert.equal(sentinel.status, "complete");
  assert.equal(sentinel.round, 1);
  assert.ok(fs.existsSync(path.join(runDir, "review-round-1-verdict.json")), "verdict artifact persisted");
});

// ---- DC #6b: invoker-kill survival ---------------------------------------

test("the round applies the verdict even when the invoker is SIGKILLed right after the receipt (DC #6b)", async () => {
  const { repoRoot, relayHome, manifestPath, runId, runDir, doneCriteriaPath, diffPath } = setupRepo();
  const reviewerScript = writeReviewerScript(repoRoot, "reviewer-kill.js", CHANGES_REQUESTED_VERDICT, { delayMs: 2500 });

  const parent = spawn(process.execPath, [
    SCRIPT, "--repo", repoRoot, "--run-id", runId, "--pr", "123",
    "--done-criteria-file", doneCriteriaPath, "--diff-file", diffPath,
    "--reviewer-script", reviewerScript, "--no-comment", "--detach", "--json",
  ], { env: detachEnv(relayHome) });

  let stdout = "";
  parent.stdout.on("data", (chunk) => { stdout += chunk; });
  let receipt = null;
  try {
    await waitFor(() => {
      try { receipt = JSON.parse(stdout); return Boolean(receipt.runId); } catch { return false; }
    }, { message: "detach receipt on the parent's stdout" });

    // The detached supervisor is its own process-group leader, so killing the invoker
    // (parent) does not touch it. The round must still be running (2.5s reviewer delay).
    assert.equal(receipt.status, "detached");
    assert.ok(pidAlive(receipt.pid), "detached supervisor alive before the invoker dies");
    parent.kill("SIGKILL");
    await waitFor(() => !pidAlive(parent.pid), { message: "invoker process to die" });
    assert.ok(pidAlive(receipt.pid), "detached supervisor outlives the SIGKILLed invoker");

    // Despite the invoker crash, the round persists the verdict and applies it to the manifest.
    await waitFor(() => fs.existsSync(receipt.sentinelPath), { message: "completion sentinel after invoker kill" });
    await waitFor(() => readManifest(manifestPath).data.state === STATES.CHANGES_REQUESTED, {
      message: "manifest verdict applied after invoker kill",
    });
    const manifest = readManifest(manifestPath).data;
    assert.equal(manifest.state, STATES.CHANGES_REQUESTED);
    assert.ok(fs.existsSync(path.join(runDir, "review-round-1-verdict.json")), "verdict artifact persisted");
  } finally {
    try { parent.kill("SIGKILL"); } catch {}
    killPgidQuietly(receipt?.pgid);
  }
});

// ---- DC #6c: lease shape + completion sentinel ---------------------------

test("the detached round writes a run-dir lease (pid/pgid/host/started_at) and a completion sentinel (DC #6c)", async () => {
  const { repoRoot, relayHome, manifestPath, runId, runDir, doneCriteriaPath, diffPath } = setupRepo();
  const reviewerScript = writeReviewerScript(repoRoot, "reviewer-lease.js", CHANGES_REQUESTED_VERDICT, { delayMs: 1500 });

  const launched = spawnSync(process.execPath, [
    SCRIPT, "--repo", repoRoot, "--run-id", runId, "--pr", "123",
    "--done-criteria-file", doneCriteriaPath, "--diff-file", diffPath,
    "--reviewer-script", reviewerScript, "--no-comment", "--detach", "--json",
  ], { encoding: "utf-8", env: detachEnv(relayHome), timeout: 15000 });
  assert.equal(launched.status, 0, `${launched.stderr}\n${launched.stdout}`);
  const receipt = JSON.parse(launched.stdout);

  // The receipt is written after the lease, so the lease file is present the moment the
  // parent returns. Read the absolute leasePath from the receipt (the run dir resolves
  // under the child's RELAY_HOME, not this test process's).
  assert.equal(receipt.leasePath, path.join(runDir, "lease.json"));
  assert.ok(fs.existsSync(receipt.leasePath), "lease.json present in the run dir");
  const lease = JSON.parse(fs.readFileSync(receipt.leasePath, "utf-8"));
  assert.equal(Number.isInteger(lease.pid) && lease.pid > 0, true, "lease carries pid");
  assert.equal(Number.isInteger(lease.pgid) && lease.pgid > 0, true, "lease carries pgid");
  assert.equal(lease.pgid, receipt.pgid, "lease pgid matches the receipt's owned pgid");
  assert.equal(lease.host, os.hostname(), "lease carries host");
  assert.ok(lease.started_at && !Number.isNaN(Date.parse(lease.started_at)), "lease carries an ISO started_at");

  // A sentinel appears on completion (analogous to the gate .done sentinel).
  await waitFor(() => fs.existsSync(receipt.sentinelPath), { message: "completion sentinel" });
  const sentinel = JSON.parse(fs.readFileSync(receipt.sentinelPath, "utf-8"));
  assert.equal(sentinel.status, "complete");
  assert.equal(sentinel.runId, runId);
  assert.equal(sentinel.round, 1);
  assert.equal(sentinel.exitCode, 0);
  await waitFor(() => readManifest(manifestPath).data.state === STATES.CHANGES_REQUESTED, {
    message: "manifest verdict applied",
  });
});

// ---- DC #6d: verdict-persisted / apply-missing recovery via --review-file --

test("a persisted verdict with no manifest apply is recoverable via the documented --review-file path (DC #6d)", () => {
  const { repoRoot, relayHome, manifestPath, runId, runDir, doneCriteriaPath, diffPath } = setupRepo();

  // Simulate a kill between verdict persistence and manifest apply: the raw reviewer
  // response is on disk (review-round-1-raw-response.txt) but the manifest is untouched.
  const persistedResponse = path.join(runDir, "review-round-1-raw-response.txt");
  fs.writeFileSync(persistedResponse, `${JSON.stringify(CHANGES_REQUESTED_VERDICT, null, 2)}\n`, "utf-8");
  assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING, "manifest apply did not happen yet");

  // Documented one-command recovery: re-run the round with the persisted verdict + provenance.
  const recovered = JSON.parse(execFileSync(process.execPath, [
    SCRIPT, "--repo", repoRoot, "--run-id", runId, "--pr", "123",
    "--done-criteria-file", doneCriteriaPath, "--diff-file", diffPath,
    "--review-file", persistedResponse,
    "--manual-review-reason", "reapply persisted verdict after detached-round kill",
    "--no-comment", "--json",
  ], { encoding: "utf-8", env: detachEnv(relayHome) }));

  assert.equal(recovered.appliedVerdict, "changes_requested");
  assert.equal(recovered.nextState, STATES.CHANGES_REQUESTED);
  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.CHANGES_REQUESTED, "verdict applied to the manifest via recovery");
  assert.equal(manifest.review.manual_review_reason, "reapply persisted verdict after detached-round kill");
});

// ---- DC #5: incompatible-combination rejection ---------------------------

test("--detach is rejected with --prepare-only and with --review-file (DC #5)", () => {
  const { repoRoot, relayHome, runId, doneCriteriaPath, diffPath } = setupRepo();
  const verdictFile = writeVerdictFile(repoRoot, "verdict.json", CHANGES_REQUESTED_VERDICT);

  const prepareOnly = spawnSync(process.execPath, [
    SCRIPT, "--repo", repoRoot, "--run-id", runId, "--pr", "123",
    "--done-criteria-file", doneCriteriaPath, "--diff-file", diffPath,
    "--detach", "--prepare-only", "--json",
  ], { encoding: "utf-8", env: detachEnv(relayHome) });
  assert.notEqual(prepareOnly.status, 0, "--detach + --prepare-only is rejected");
  assert.match(prepareOnly.stderr, /--detach cannot be combined with --prepare-only/);

  const reviewFile = spawnSync(process.execPath, [
    SCRIPT, "--repo", repoRoot, "--run-id", runId, "--pr", "123",
    "--done-criteria-file", doneCriteriaPath, "--diff-file", diffPath,
    "--review-file", verdictFile, "--detach", "--json",
  ], { encoding: "utf-8", env: detachEnv(relayHome) });
  assert.notEqual(reviewFile.status, 0, "--detach + --review-file is rejected");
  assert.match(reviewFile.stderr, /--detach cannot be combined with --review-file/);
});
