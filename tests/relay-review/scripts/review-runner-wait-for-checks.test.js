// Issue #950 Half 1: review-runner --wait-for-checks + pending-checks marker.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
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
const { readRunEvents } = require("../../../skills/relay-dispatch/scripts/relay-events");
const {
  DEFAULT_ENFORCEMENT_RUBRIC,
  createEnforcementFixture,
} = require("../../relay-dispatch/scripts/test-support");
const { EXECUTION_EVIDENCE_FILENAME } = require("../../../skills/relay-review/scripts/review-runner/execution-evidence");
const {
  parseWaitForChecksSeconds,
  pollChecksUntilSettled,
} = require("../../../skills/relay-review/scripts/review-runner/check-wait");
const { writeFakeGhScript } = require("../fixtures/fake-gh");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "review-runner.js");
const RECOVER_STATE_SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "recover-state.js");
const POLL_INTERVAL_MS = "3";

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
    recorded_at: "2026-07-11T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  }, null, 2)}\n`, "utf-8");
}

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wait-checks-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wait-checks-origin-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["init", "--bare", remoteRoot], { stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Wait Test"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-wait@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteRoot], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, stdio: "pipe" });

  const runId = "issue-950-20260711010000000";
  const worktreePath = path.join(repoRoot, "wt", "issue-950");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", "issue-950"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(worktreePath, "marker.txt"), "worktree\n", "utf-8");

  const { manifestPath, runDir } = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot, runId, branch: "issue-950", baseBranch: "main", issueNumber: 950,
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

  const doneCriteriaPath = path.join(repoRoot, "done-criteria.md");
  const diffPath = path.join(repoRoot, "pr.diff");
  fs.writeFileSync(doneCriteriaPath, "# Done Criteria\n\n- Add smoke.txt\n", "utf-8");
  fs.writeFileSync(diffPath, "diff --git a/smoke.txt b/smoke.txt\n+ok\n", "utf-8");
  return { repoRoot, worktreePath, manifestPath, runId, runDir, doneCriteriaPath, diffPath, headSha };
}

function writeVerdict(repoRoot, name, verdict) {
  const filePath = path.join(repoRoot, name);
  fs.writeFileSync(filePath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");
  return filePath;
}

function changesRequestedVerdict(repoRoot) {
  return writeVerdict(repoRoot, "changes.json", {
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
  });
}

function passVerdict(repoRoot) {
  return writeVerdict(repoRoot, "pass.json", {
    verdict: "pass",
    summary: "All done criteria are satisfied.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  });
}

function installGh(repoRoot, { checksTimeline, checks } = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wait-gh-bin-"));
  const ghPath = path.join(binDir, "gh");
  const logPath = path.join(binDir, "gh-calls.log");
  const checksStatePath = path.join(binDir, "checks-state.json");
  writeFakeGhScript({
    ghPath,
    logPath,
    checksStatePath,
    fixture: {
      body: "## Test PR\n\nFixture body.\n",
      headRefOid: "a".repeat(40),
      headRefName: "issue-950",
      number: 123,
      title: "Wait-for-checks PR",
      statusCheckRollup: [{ name: "unit", conclusion: "SUCCESS", status: "COMPLETED" }],
      checksTimeline,
      checks,
    },
  });
  return { binDir, ghPath, logPath };
}

function runReview({ repoRoot, runId, doneCriteriaPath, diffPath, reviewFile, ghBinDir, waitForChecks }) {
  const args = [
    SCRIPT, "--repo", repoRoot, "--run-id", runId, "--pr", "123",
    "--done-criteria-file", doneCriteriaPath, "--diff-file", diffPath,
    "--review-file", reviewFile, "--no-comment",
  ];
  if (waitForChecks !== undefined) args.push("--wait-for-checks", String(waitForChecks));
  args.push("--json");
  const stdout = execFileSync("node", args, {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${ghBinDir}${path.delimiter}${process.env.PATH || ""}`,
      RELAY_REVIEW_CHECK_POLL_INTERVAL_MS: POLL_INTERVAL_MS,
    },
  });
  return JSON.parse(stdout);
}

function readGhCalls(logPath) {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8").trim().split("\n") : [];
}

// ---- Helper unit test: deterministic durations/states without spawning processes ----

test("pollChecksUntilSettled waits while pending then settles when the check flips (DC #1)", () => {
  const clock = { t: 0 };
  const timeline = [
    [{ name: "unit", bucket: "pending" }],
    [{ name: "unit", bucket: "pending" }],
    [{ name: "unit", bucket: "pass" }],
  ];
  let call = 0;
  const outcome = pollChecksUntilSettled(
    { repoPath: ".", prNumber: 1, budgetSeconds: 60, intervalMs: 1000 },
    {
      now: () => clock.t,
      sleep: (ms) => { clock.t += ms; },
      fetchChecks: () => timeline[Math.min(call++, timeline.length - 1)],
    }
  );
  assert.equal(outcome.pending, false, "settled once the check leaves pending");
  assert.equal(outcome.polls, 3);
  assert.deepEqual(outcome.checks, [{ name: "unit", bucket: "pass" }]);
  assert.equal(outcome.pendingCheckNames.length, 0);
  assert.equal(outcome.waitedMs, 2000, "two 1s sleeps between three polls");
  assert.equal(outcome.budgetExhausted, false);
});

test("pollChecksUntilSettled proceeds with pending states when the budget is exhausted (DC #2)", () => {
  const clock = { t: 0 };
  const outcome = pollChecksUntilSettled(
    { repoPath: ".", prNumber: 1, budgetSeconds: 2, intervalMs: 1000 },
    {
      now: () => clock.t,
      sleep: (ms) => { clock.t += ms; },
      fetchChecks: () => [{ name: "unit", bucket: "pending" }, { name: "lint", bucket: "pass" }],
    }
  );
  assert.equal(outcome.pending, true, "still pending at budget exhaustion");
  assert.equal(outcome.budgetExhausted, true);
  assert.deepEqual(outcome.pendingCheckNames, ["unit"]);
  assert.equal(outcome.waitedMs, 2000);
});

test("parseWaitForChecksSeconds: absent flag -> null, valid -> number, invalid -> throw", () => {
  assert.equal(parseWaitForChecksSeconds(undefined), null);
  assert.equal(parseWaitForChecksSeconds(null), null);
  assert.equal(parseWaitForChecksSeconds("30"), 30);
  assert.equal(parseWaitForChecksSeconds("0"), 0);
  assert.throws(() => parseWaitForChecksSeconds("soon"), /non-negative number of seconds/);
  assert.throws(() => parseWaitForChecksSeconds("-5"), /non-negative number of seconds/);
});

// ---- End-to-end review-runner rounds through the fake gh ----

test("review-runner --wait-for-checks waits then proceeds when the check flips to pass (DC #1, #8a)", () => {
  const { repoRoot, manifestPath, runId, runDir, doneCriteriaPath, diffPath, headSha } = setupRepo();
  const reviewFile = passVerdict(repoRoot);
  const { binDir, logPath } = installGh(repoRoot, {
    checksTimeline: [
      { checks: [{ name: "unit", bucket: "pending" }] },
      { checks: [{ name: "unit", bucket: "pending" }] },
      { checks: [{ name: "unit", bucket: "pass" }] },
    ],
  });

  const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, reviewFile, ghBinDir: binDir, waitForChecks: 60 });

  assert.ok(result.checkWait, "checkWait recorded in round output");
  assert.equal(result.checkWait.proceeded_with_pending, false, "settled before proceeding");
  assert.equal(result.checkWait.budget_exhausted, false);
  assert.deepEqual(result.checkWait.checks, [{ name: "unit", bucket: "pass" }]);
  assert.ok(result.checkWait.polls >= 3, `polled until the check flipped (got ${result.checkWait.polls})`);
  assert.equal(typeof result.checkWait.waited_ms, "number");
  assert.equal(result.reviewHeadSha, headSha);

  const artifact = JSON.parse(fs.readFileSync(path.join(runDir, "review-round-1-check-wait.json"), "utf-8"));
  assert.deepEqual(artifact.checks, [{ name: "unit", bucket: "pass" }]);

  const pollCalls = readGhCalls(logPath).filter((line) => line.startsWith("pr checks 123 --json name,bucket"));
  assert.ok(pollCalls.length >= 3, "gh pr checks polled repeatedly");

  // Settled (not pending) -> no pending-checks marker even though the verdict is a pass round.
  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.review.pending_checks_marker, undefined, "no marker when checks settled green");
});

test("review-runner --wait-for-checks records still-pending states and no new failure when the budget is exhausted (DC #2, #8b)", () => {
  const { repoRoot, manifestPath, runId, runDir, doneCriteriaPath, diffPath, headSha } = setupRepo();
  const reviewFile = changesRequestedVerdict(repoRoot);
  const { binDir } = installGh(repoRoot, {
    checks: [{ name: "unit", bucket: "pending" }],
  });

  const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, reviewFile, ghBinDir: binDir, waitForChecks: 0 });

  assert.equal(result.checkWait.proceeded_with_pending, true);
  assert.equal(result.checkWait.budget_exhausted, true);
  assert.deepEqual(result.checkWait.pending_checks, ["unit"]);
  assert.equal(result.nextState, STATES.CHANGES_REQUESTED, "round still applies its verdict (no new failure mode)");

  const artifact = JSON.parse(fs.readFileSync(path.join(runDir, "review-round-1-check-wait.json"), "utf-8"));
  assert.equal(artifact.proceeded_with_pending, true);
  assert.deepEqual(artifact.pending_checks, ["unit"]);

  // DC #3: changes_requested + proceeded-with-pending -> marker anchored to reviewed head.
  const manifest = readManifest(manifestPath).data;
  const marker = manifest.review.pending_checks_marker;
  assert.ok(marker, "pending-checks marker written");
  assert.equal(marker.head_sha, headSha, "marker anchored to the reviewed head");
  assert.deepEqual(marker.pending_checks, ["unit"]);
  assert.equal(marker.round, 1);
});

test("review-runner --wait-for-checks does NOT write the marker when checks settle green (DC #3)", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = changesRequestedVerdict(repoRoot);
  const { binDir } = installGh(repoRoot, { checks: [{ name: "unit", bucket: "pass" }] });

  const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, reviewFile, ghBinDir: binDir, waitForChecks: 5 });

  assert.equal(result.checkWait.proceeded_with_pending, false);
  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.review.pending_checks_marker, undefined, "no marker when checks are green");
});

test("review-runner without --wait-for-checks is byte-identical: no poll, no artifact, no marker, no field (DC #4, #8c)", () => {
  const { repoRoot, manifestPath, runId, runDir, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = changesRequestedVerdict(repoRoot);
  const { binDir, logPath } = installGh(repoRoot, { checks: [{ name: "unit", bucket: "pending" }] });

  const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, reviewFile, ghBinDir: binDir });

  assert.equal("checkWait" in result, false, "no checkWait field without the flag");
  assert.equal(fs.existsSync(path.join(runDir, "review-round-1-check-wait.json")), false, "no check-wait artifact");
  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.review.pending_checks_marker, undefined, "no marker without the flag");
  const pollCalls = readGhCalls(logPath).filter((line) => line.startsWith("pr checks"));
  assert.equal(pollCalls.length, 0, "gh pr checks never polled without the flag");
});

// Simulate the same-head re-entry that the recover-state --require-pr-body-change route
// performs after a pending round: land back in review_pending at the same head WITHOUT
// consuming the pending-checks marker (that route never touches it).
function reenterReviewPendingPreservingMarker(manifestPath) {
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    state: STATES.REVIEW_PENDING,
    next_action: "run_review",
  }, record.body);
}

// The marker must be single-use / always-current: once a real changes_requested lands at
// the same head with settled (green) checks, the stale marker is cleared so the
// checks-green recovery route can no longer replay the earlier procedural block (#950 R2).
test("pending-checks marker is single-use: a later green changes_requested at the same head clears it and recover-state then refuses", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath, headSha } = setupRepo();

  // Round 1: proceed with a pending check + changes_requested -> marker stamped at head H.
  const round1Gh = installGh(repoRoot, { checks: [{ name: "unit", bucket: "pending" }] });
  const round1 = runReview({
    repoRoot, runId, doneCriteriaPath, diffPath,
    reviewFile: changesRequestedVerdict(repoRoot), ghBinDir: round1Gh.binDir, waitForChecks: 0,
  });
  assert.equal(round1.checkWait.proceeded_with_pending, true);
  const afterRound1 = readManifest(manifestPath).data;
  assert.ok(afterRound1.review.pending_checks_marker, "round 1 stamps the pending-checks marker");
  assert.equal(afterRound1.review.pending_checks_marker.head_sha, headSha);

  // Same-head re-entry (PR-body route) preserves the marker without consuming it.
  reenterReviewPendingPreservingMarker(manifestPath);
  assert.ok(
    readManifest(manifestPath).data.review.pending_checks_marker,
    "same-head re-entry does not consume the marker"
  );

  // Round 2: same head H, but checks are now green and a REAL changes_requested lands.
  // The stale marker must be cleared because this round did NOT proceed on pending checks.
  const round2Gh = installGh(repoRoot, { checks: [{ name: "unit", bucket: "pass" }] });
  const round2 = runReview({
    repoRoot, runId, doneCriteriaPath, diffPath,
    reviewFile: changesRequestedVerdict(repoRoot), ghBinDir: round2Gh.binDir, waitForChecks: 5,
  });
  assert.equal(round2.checkWait.proceeded_with_pending, false, "round 2 saw settled green checks");
  assert.equal(round2.nextState, STATES.CHANGES_REQUESTED, "round 2 applies a real changes_requested");
  const afterRound2 = readManifest(manifestPath).data;
  assert.equal(
    afterRound2.review.pending_checks_marker, undefined,
    "the green changes_requested round clears the stale marker (single-use)"
  );

  // With the marker cleared, the checks-green recovery route can no longer replay: it
  // refuses because no pending-checks marker is anchored to the reviewed head.
  const recover = spawnSync("node", [
    RECOVER_STATE_SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--to", STATES.REVIEW_PENDING,
    "--reason", "attempting checks-green replay after the marker was cleared",
    "--allow-same-head",
    "--require-checks-green",
    "--json",
  ], {
    encoding: "utf-8",
    env: { ...process.env, PATH: `${round2Gh.binDir}${path.delimiter}${process.env.PATH || ""}` },
  });
  assert.notEqual(recover.status, 0, "recover-state refuses without a marker");
  assert.match(recover.stderr, /no pending-checks marker/);
  assert.equal(
    readManifest(manifestPath).data.state, STATES.CHANGES_REQUESTED,
    "refused recovery leaves the run in changes_requested"
  );
});
