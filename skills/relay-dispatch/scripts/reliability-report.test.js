// canary: bare-string `event: "..."` fixture literals AND reader assertions in this file are deliberate canaries against EVENTS schema drift; do not port to EVENTS.X (see #313).
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");
const {
  appendIterationScore,
  appendRubricQuality,
  appendRunEvent,
  appendScoreDivergence,
} = require("./relay-events");

const SCRIPT = path.join(__dirname, "reliability-report.js");

function initGitRepo(repoRoot, actor = "Relay Test") {
  if (fs.existsSync(path.join(repoRoot, ".git"))) {
    return;
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", actor], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay@example.com"], { cwd: repoRoot, stdio: "pipe" });
}

function setGitActor(repoRoot, actor) {
  execFileSync("git", ["config", "user.name", actor], { cwd: repoRoot, stdio: "pipe" });
}

function writeRun(repoRoot, {
  runId,
  state,
  rounds,
  updatedAt,
  reviewer = "codex",
  lastReviewer = null,
  lastReviewedSha = null,
  bootstrapExempt = null,
}) {
  initGitRepo(repoRoot);
  const manifestPath = ensureRunLayout(repoRoot, runId).manifestPath;
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: `issue-${runId}`,
    baseBranch: "main",
    issueNumber: 42,
    worktreePath: path.join(repoRoot, "wt", runId),
    orchestrator: "codex",
    executor: "codex",
    reviewer,
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  if (state !== STATES.DISPATCHED) {
    manifest.anchor.rubric_path = "rubric.yaml";
    fs.writeFileSync(path.join(ensureRunLayout(repoRoot, runId).runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: reliability-report\n", "utf-8");
    manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  }
  if (state === STATES.READY_TO_MERGE || state === STATES.MERGED) {
    manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  }
  if (state === STATES.MERGED) {
    manifest = updateManifestState(manifest, STATES.MERGED, "done");
  }
  manifest.review.rounds = rounds;
  manifest.review.last_reviewer = lastReviewer;
  manifest.review.last_reviewed_sha = lastReviewedSha;
  if (bootstrapExempt) {
    manifest.bootstrap_exempt = bootstrapExempt;
  }
  manifest.timestamps.created_at = updatedAt;
  manifest.timestamps.updated_at = updatedAt;
  writeManifest(manifestPath, manifest);
}

function setRubric(repoRoot, runId, rubricContent, rubricPath = "rubric.yaml") {
  const { manifestPath, runDir } = ensureRunLayout(repoRoot, runId);
  fs.writeFileSync(path.join(runDir, rubricPath), rubricContent, "utf-8");
  const manifest = readManifest(manifestPath).data;
  manifest.anchor.rubric_path = rubricPath;
  writeManifest(manifestPath, manifest);
}

function setRubricAnchor(repoRoot, runId, rubricPath) {
  const { manifestPath } = ensureRunLayout(repoRoot, runId);
  const manifest = readManifest(manifestPath).data;
  manifest.anchor.rubric_path = rubricPath;
  writeManifest(manifestPath, manifest);
}

function unsetRubricAnchor(repoRoot, runId) {
  const { manifestPath } = ensureRunLayout(repoRoot, runId);
  const manifest = readManifest(manifestPath).data;
  delete manifest.anchor.rubric_path;
  writeManifest(manifestPath, manifest);
}

function buildQualitativeRubric({
  withName = "Hinted factor",
  withoutName = "Unhinted factor",
  extraWithName = null,
  includeWithout = true,
} = {}) {
  const lines = [
    "rubric:",
    "  factors:",
    `    - name: ${withName}`,
    "      tier: contract",
    "      type: automated",
    "      fix_hint: \"Apply the focused repair\"",
  ];
  if (extraWithName) {
    lines.push(
      `    - name: ${extraWithName}`,
      "      tier: contract",
      "      type: automated",
      "      fix_hint: \"Add the missing focused guard\""
    );
  }
  if (includeWithout) {
    lines.push(
      `    - name: ${withoutName}`,
      "      tier: quality",
      "      type: evaluated"
    );
  }
  return lines.join("\n");
}

function appendScore(repoRoot, runId, round, factor, met = true) {
  appendIterationScore(repoRoot, runId, {
    round,
    scores: [
      {
        factor,
        target: ">= 8",
        observed: met ? "8" : "5",
        met,
        status: met ? "pass" : "fail",
      },
    ],
  });
}

test("reliability-report derives the core scorecard from manifests and events", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago
  const staleTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
  const runReady = createRunId({ branch: "run-ready", timestamp: new Date("2026-04-12T00:00:00.000Z") });
  const runMerged = createRunId({ branch: "run-merged", timestamp: new Date("2026-04-12T00:00:01.000Z") });
  const runStaleOpen = createRunId({ branch: "run-stale-open", timestamp: new Date("2026-04-12T00:00:02.000Z") });
  writeRun(repoRoot, {
    runId: runReady,
    state: STATES.READY_TO_MERGE,
    rounds: 2,
    updatedAt: recentTs,
  });
  writeRun(repoRoot, {
    runId: runMerged,
    state: STATES.MERGED,
    rounds: 4,
    updatedAt: recentTs,
    bootstrapExempt: {
      enabled: true,
      artifact_path: "execution-evidence.json",
      writer_pr: 267,
      reason: "run predates artifact writer",
    },
  });
  writeRun(repoRoot, {
    runId: runStaleOpen,
    state: STATES.REVIEW_PENDING,
    rounds: 1,
    updatedAt: staleTs,
  });

  appendRunEvent(repoRoot, runReady, {
    event: "dispatch_start",
    state_from: STATES.CHANGES_REQUESTED,
    state_to: STATES.DISPATCHED,
    head_sha: "abc123",
    round: 2,
    reason: "same_run_resume",
  });
  appendRunEvent(repoRoot, runReady, {
    event: "dispatch_result",
    state_from: STATES.DISPATCHED,
    state_to: STATES.REVIEW_PENDING,
    head_sha: "def456",
    round: 2,
    reason: "same_run_resume:completed",
  });
  appendRunEvent(repoRoot, runReady, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.READY_TO_MERGE,
    head_sha: "def456",
    round: 2,
    reason: "pass",
  });
  appendRunEvent(repoRoot, runMerged, {
    event: "merge_blocked",
    state_from: STATES.READY_TO_MERGE,
    state_to: STATES.READY_TO_MERGE,
    head_sha: "aaa111",
    round: 4,
    reason: "stale",
  });
  appendRunEvent(repoRoot, runMerged, {
    event: "merge_finalize",
    state_from: STATES.READY_TO_MERGE,
    state_to: STATES.MERGED,
    head_sha: "bbb222",
    round: 4,
    reason: "squash",
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.equal("by_actor" in report, false);
  assert.equal(report.metrics.same_run_resume_success_rate, 1);
  assert.equal(report.metrics.fresh_review_merge_block_rate, 0.5);
  assert.equal(report.metrics.max_rounds_enforcement_rate, 1);
  assert.equal(report.metrics.median_rounds_to_ready, 3);
  assert.equal(report.metrics.stale_open_runs_72h, 1);
  assert.equal(report.bootstrap_exempt_runs, 1);
});

test("reliability-report aggregates model_per_phase from dispatch and review events", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-models-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runA = createRunId({ branch: "run-model-a", timestamp: new Date("2026-04-12T00:10:00.000Z") });
  const runB = createRunId({ branch: "run-model-b", timestamp: new Date("2026-04-12T00:10:01.000Z") });

  writeRun(repoRoot, {
    runId: runA,
    state: STATES.READY_TO_MERGE,
    rounds: 1,
    updatedAt: recentTs,
  });
  writeRun(repoRoot, {
    runId: runB,
    state: STATES.CHANGES_REQUESTED,
    rounds: 1,
    updatedAt: recentTs,
  });

  appendRunEvent(repoRoot, runA, {
    event: "dispatch_start",
    state_from: STATES.DRAFT,
    state_to: STATES.DISPATCHED,
    head_sha: "aaa111",
    reason: "new_dispatch",
    model: "opus",
  });
  appendRunEvent(repoRoot, runA, {
    event: "review_invoke",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.REVIEW_PENDING,
    head_sha: "aaa111",
    round: 1,
    reason: "codex",
    model: "haiku",
  });
  appendRunEvent(repoRoot, runB, {
    event: "dispatch_start",
    state_from: STATES.DRAFT,
    state_to: STATES.DISPATCHED,
    head_sha: "bbb222",
    reason: "new_dispatch",
    model: null,
  });
  appendRunEvent(repoRoot, runB, {
    event: "review_invoke",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.REVIEW_PENDING,
    head_sha: "bbb222",
    round: 1,
    reason: "codex",
    model: null,
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(report.model_per_phase, {
    dispatch: {
      null: 1,
      opus: 1,
    },
    review: {
      haiku: 1,
      null: 1,
    },
  });
});

test("reliability-report aggregates factor analysis across runs and rounds", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-factors-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runA = createRunId({ branch: "run-a", timestamp: new Date("2026-04-12T01:00:00.000Z") });
  const runB = createRunId({ branch: "run-b", timestamp: new Date("2026-04-12T01:00:01.000Z") });
  const runC = createRunId({ branch: "run-c", timestamp: new Date("2026-04-12T01:00:02.000Z") });

  writeRun(repoRoot, {
    runId: runA,
    state: STATES.CHANGES_REQUESTED,
    rounds: 3,
    updatedAt: recentTs,
  });
  writeRun(repoRoot, {
    runId: runB,
    state: STATES.CHANGES_REQUESTED,
    rounds: 2,
    updatedAt: recentTs,
  });
  writeRun(repoRoot, {
    runId: runC,
    state: STATES.READY_TO_MERGE,
    rounds: 1,
    updatedAt: recentTs,
  });

  appendIterationScore(repoRoot, runA, {
    round: 1,
    scores: [
      { factor: "Coverage", target: ">= 8", observed: "6", met: false, status: "fail" },
      { factor: "Docs", target: ">= 8", observed: "not started", met: false, status: "not_run" },
    ],
  });
  appendIterationScore(repoRoot, runA, {
    round: 2,
    scores: [
      { factor: "Coverage", target: ">= 8", observed: "8", met: true, status: "pass" },
      { factor: "Docs", target: ">= 8", observed: "6", met: false, status: "fail" },
    ],
  });
  appendIterationScore(repoRoot, runA, {
    round: 3,
    scores: [
      { factor: "Docs", target: ">= 8", observed: "8", met: true, status: "pass" },
    ],
  });

  appendIterationScore(repoRoot, runB, {
    round: 1,
    scores: [
      { factor: "Coverage", target: ">= 8", observed: "5", met: false, status: "fail" },
      { factor: "Docs", target: ">= 8", observed: "4", met: false, status: "fail" },
      { factor: "Perf", target: ">= 8", observed: "8", met: true, status: "pass" },
    ],
  });
  appendIterationScore(repoRoot, runB, {
    round: 2,
    scores: [
      { factor: "Coverage", target: ">= 8", observed: "7", met: false, status: "fail" },
    ],
  });

  appendIterationScore(repoRoot, runC, {
    round: 1,
    scores: [
      { factor: "Coverage", target: ">= 8", observed: "9", met: true, status: "pass" },
    ],
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(report.factor_analysis, {
    factors: {
      Coverage: {
        appearances: 3,
        met_rate: 0.6667,
        avg_rounds_to_met: 1.5,
      },
      Docs: {
        appearances: 2,
        met_rate: 0.5,
        avg_rounds_to_met: 3,
      },
      Perf: {
        appearances: 1,
        met_rate: 1,
        avg_rounds_to_met: 1,
      },
    },
    most_stuck_factor: "Docs",
  });
});

test("reliability-report keeps factor analysis backwards compatible without iteration scores", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-empty-factors-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runReady = createRunId({ branch: "run-ready", timestamp: new Date("2026-04-12T02:00:00.000Z") });

  writeRun(repoRoot, {
    runId: runReady,
    state: STATES.READY_TO_MERGE,
    rounds: 2,
    updatedAt: recentTs,
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(report.factor_analysis, {
    factors: {},
    most_stuck_factor: null,
  });
});

test("reliability-report keeps qualitative_signals null below the minimum readable-rubric threshold", () => {
  for (const count of [0, 1, 2]) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), `relay-report-qual-threshold-${count}-`));
    process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
    initGitRepo(repoRoot);
    const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();

    for (let index = 0; index < count; index += 1) {
      const runId = createRunId({
        branch: `run-qual-${count}-${index}`,
        timestamp: new Date(`2026-04-12T02:2${count}:${index.toString().padStart(2, "0")}.000Z`),
      });
      writeRun(repoRoot, {
        runId,
        state: STATES.READY_TO_MERGE,
        rounds: 1,
        updatedAt: recentTs,
      });
      setRubric(repoRoot, runId, buildQualitativeRubric());
      appendScore(repoRoot, runId, 1, "Hinted factor");
      appendScore(repoRoot, runId, 1, "Unhinted factor");
    }

    const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
    const report = JSON.parse(stdout);

    assert.equal(report.qualitative_signals, null);
  }
});

test("reliability-report keeps qualitative_signals null when either cohort has fewer than three contributing manifests", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-qual-small-cohort-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();

  for (let index = 0; index < 3; index += 1) {
    const runId = createRunId({
      branch: `run-small-cohort-${index}`,
      timestamp: new Date(`2026-04-12T02:3${index}:00.000Z`),
    });
    writeRun(repoRoot, {
      runId,
      state: STATES.READY_TO_MERGE,
      rounds: 1,
      updatedAt: recentTs,
    });
    setRubric(repoRoot, runId, buildQualitativeRubric({ includeWithout: index < 2 }));
    appendScore(repoRoot, runId, 1, "Hinted factor");
    if (index < 2) {
      appendScore(repoRoot, runId, 1, "Unhinted factor");
    }
  }

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.equal(report.qualitative_signals, null);
});

test("reliability-report derives qualitative_signals across fix_hint cohorts", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-qual-signals-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runs = [
    {
      runId: createRunId({ branch: "run-qual-a", timestamp: new Date("2026-04-12T02:40:00.000Z") }),
      withRounds: [["Hinted factor", 1]],
      withoutRounds: [["Unhinted factor", 2]],
    },
    {
      runId: createRunId({ branch: "run-qual-b", timestamp: new Date("2026-04-12T02:40:01.000Z") }),
      withRounds: [["Hinted factor", 2]],
      withoutRounds: [["Unhinted factor", 3]],
    },
    {
      runId: createRunId({ branch: "run-qual-c", timestamp: new Date("2026-04-12T02:40:02.000Z") }),
      extraWithName: "Second hinted factor",
      withRounds: [["Hinted factor", 4], ["Second hinted factor", 1]],
      withoutRounds: [["Unhinted factor", 5]],
    },
  ];

  for (const run of runs) {
    writeRun(repoRoot, {
      runId: run.runId,
      state: STATES.READY_TO_MERGE,
      rounds: 5,
      updatedAt: recentTs,
    });
    setRubric(repoRoot, run.runId, buildQualitativeRubric({ extraWithName: run.extraWithName }));
    for (const [factor, round] of run.withRounds) {
      appendScore(repoRoot, run.runId, round, factor);
    }
    for (const [factor, round] of run.withoutRounds) {
      appendScore(repoRoot, run.runId, round, factor);
    }
  }

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(report.qualitative_signals, {
    with: {
      sample_size: 3,
      avg_first_met_round: 2,
    },
    without: {
      sample_size: 3,
      avg_first_met_round: 3.3333,
    },
    delta: -1.3333,
  });
});

test("reliability-report silently skips missing or malformed rubric anchors for qualitative_signals", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-qual-skip-rubrics-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runValid = createRunId({ branch: "run-valid", timestamp: new Date("2026-04-12T02:50:00.000Z") });
  const runUnset = createRunId({ branch: "run-unset", timestamp: new Date("2026-04-12T02:50:01.000Z") });
  const runUnreadable = createRunId({ branch: "run-unreadable", timestamp: new Date("2026-04-12T02:50:02.000Z") });
  const runMalformed = createRunId({ branch: "run-malformed", timestamp: new Date("2026-04-12T02:50:03.000Z") });

  for (const runId of [runValid, runUnset, runUnreadable, runMalformed]) {
    writeRun(repoRoot, {
      runId,
      state: STATES.READY_TO_MERGE,
      rounds: 1,
      updatedAt: recentTs,
    });
  }

  setRubric(repoRoot, runValid, buildQualitativeRubric());
  unsetRubricAnchor(repoRoot, runUnset);
  setRubricAnchor(repoRoot, runUnreadable, "missing-rubric.yaml");
  setRubric(repoRoot, runMalformed, "rubric:\n  factors: [not parsed\n");

  appendScore(repoRoot, runValid, 1, "Hinted factor");
  appendScore(repoRoot, runValid, 1, "Unhinted factor");
  appendScore(repoRoot, runUnset, 1, "Skipped unset anchor");
  appendScore(repoRoot, runUnreadable, 1, "Skipped unreadable anchor");
  appendScore(repoRoot, runMalformed, 1, "Skipped malformed rubric");

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.equal(report.qualitative_signals, null);
  assert.deepEqual(Object.keys(report.factor_analysis.factors).sort(), [
    "Hinted factor",
    "Skipped malformed rubric",
    "Skipped unreadable anchor",
    "Skipped unset anchor",
    "Unhinted factor",
  ]);
});

test("reliability-report keeps rubric_insights null-safe when new events are absent", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-empty-insights-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runReady = createRunId({ branch: "run-ready", timestamp: new Date("2026-04-12T02:10:00.000Z") });

  writeRun(repoRoot, {
    runId: runReady,
    state: STATES.READY_TO_MERGE,
    rounds: 1,
    updatedAt: recentTs,
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(report.rubric_insights, {
    quality_grade_distribution: null,
    avg_quality_ratio: null,
    tier_effectiveness: null,
    divergence_hotspots: null,
    auto_vs_eval_correlation: null,
  });
});

test("reliability-report derives rubric grade distribution and average quality ratio", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-rubric-quality-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runA = createRunId({ branch: "run-a", timestamp: new Date("2026-04-12T03:00:00.000Z") });
  const runB = createRunId({ branch: "run-b", timestamp: new Date("2026-04-12T03:00:01.000Z") });

  writeRun(repoRoot, {
    runId: runA,
    state: STATES.READY_TO_MERGE,
    rounds: 2,
    updatedAt: recentTs,
  });
  writeRun(repoRoot, {
    runId: runB,
    state: STATES.CHANGES_REQUESTED,
    rounds: 3,
    updatedAt: recentTs,
  });

  appendRubricQuality(repoRoot, runA, {
    grade: "A",
    prerequisites: 2,
    contract_factors: 2,
    quality_factors: 2,
    substantive_total: 4,
    quality_ratio: 0.5,
    auto_coverage: 0.75,
    risk_signals: [],
    task_size: "M",
  });
  appendRubricQuality(repoRoot, runB, {
    grade: "C",
    prerequisites: 2,
    contract_factors: 2,
    quality_factors: 1,
    substantive_total: 3,
    quality_ratio: 0.3333,
    auto_coverage: 0.25,
    risk_signals: ["low_quality_ratio"],
    task_size: "M",
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(report.rubric_insights.quality_grade_distribution, {
    A: 1,
    B: 0,
    C: 1,
    D: 0,
  });
  assert.equal(report.rubric_insights.avg_quality_ratio, 0.4166);
  assert.deepEqual(report.rubric_insights.auto_vs_eval_correlation, {
    high_auto_runs: {
      avg_rounds: 2,
      success_rate: 1,
    },
    low_auto_runs: {
      avg_rounds: 3,
      success_rate: 0,
    },
  });
});

test("reliability-report derives tier effectiveness from tiered iteration scores", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-tier-effectiveness-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runA = createRunId({ branch: "run-a", timestamp: new Date("2026-04-12T04:00:00.000Z") });
  const runB = createRunId({ branch: "run-b", timestamp: new Date("2026-04-12T04:00:01.000Z") });

  writeRun(repoRoot, {
    runId: runA,
    state: STATES.CHANGES_REQUESTED,
    rounds: 2,
    updatedAt: recentTs,
  });
  writeRun(repoRoot, {
    runId: runB,
    state: STATES.READY_TO_MERGE,
    rounds: 1,
    updatedAt: recentTs,
  });

  appendIterationScore(repoRoot, runA, {
    round: 1,
    scores: [
      { factor: "Coverage", target: ">= 8", observed: "5", met: false, status: "fail", tier: "contract" },
      { factor: "Docs", target: ">= 8", observed: "8", met: true, status: "pass", tier: "quality" },
    ],
  });
  appendIterationScore(repoRoot, runA, {
    round: 2,
    scores: [
      { factor: "Coverage", target: ">= 8", observed: "8", met: true, status: "pass", tier: "contract" },
    ],
  });
  appendIterationScore(repoRoot, runB, {
    round: 1,
    scores: [
      { factor: "Latency", target: "< 200ms", observed: "180ms", met: true, status: "pass", tier: "contract" },
      { factor: "Architecture", target: ">= 8", observed: "6", met: false, status: "fail", tier: "quality" },
    ],
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(report.rubric_insights.tier_effectiveness, {
    contract: {
      avg_met_rate: 1,
      avg_rounds_to_met: 1.5,
    },
    quality: {
      avg_met_rate: 0.5,
      avg_rounds_to_met: 1,
    },
  });
});

test("reliability-report derives divergence hotspots from score_divergence events", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-divergence-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runA = createRunId({ branch: "run-a", timestamp: new Date("2026-04-12T05:00:00.000Z") });

  writeRun(repoRoot, {
    runId: runA,
    state: STATES.CHANGES_REQUESTED,
    rounds: 2,
    updatedAt: recentTs,
  });

  appendScoreDivergence(repoRoot, runA, {
    round: 1,
    divergences: [
      { factor: "Coverage", executor: "9", reviewer: "6", delta: 3, tier: "contract" },
      { factor: "Coverage", executor: "8", reviewer: "6", delta: 2, tier: "contract" },
      { factor: "Docs", executor: "5", reviewer: "7", delta: -2, tier: "quality" },
    ],
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(report.rubric_insights.divergence_hotspots, [
    {
      factor_pattern: "Coverage",
      occurrences: 2,
      avg_delta: 2.5,
      recommendation: "Executor scores trend higher than review; tighten examples or add automation.",
    },
    {
      factor_pattern: "Docs",
      occurrences: 1,
      avg_delta: -2,
      recommendation: "Reviewer scores trend higher than executor; check whether the factor is underspecified.",
    },
  ]);
});

test("reliability-report populates only available rubric insight subfields", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-partial-insights-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runA = createRunId({ branch: "run-a", timestamp: new Date("2026-04-12T05:10:00.000Z") });

  writeRun(repoRoot, {
    runId: runA,
    state: STATES.READY_TO_MERGE,
    rounds: 1,
    updatedAt: recentTs,
  });

  appendRubricQuality(repoRoot, runA, {
    grade: "B",
    prerequisites: 1,
    contract_factors: 1,
    quality_factors: 1,
    substantive_total: 2,
    quality_ratio: 0.5,
    auto_coverage: 1,
    risk_signals: [],
    task_size: "S",
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(report.rubric_insights.quality_grade_distribution, {
    A: 0,
    B: 1,
    C: 0,
    D: 0,
  });
  assert.equal(report.rubric_insights.avg_quality_ratio, 0.5);
  assert.equal(report.rubric_insights.tier_effectiveness, null);
  assert.equal(report.rubric_insights.divergence_hotspots, null);
  assert.deepEqual(report.rubric_insights.auto_vs_eval_correlation, {
    high_auto_runs: {
      avg_rounds: 1,
      success_rate: 1,
    },
    low_auto_runs: {
      avg_rounds: null,
      success_rate: null,
    },
  });
});

test("reliability-report adds run-level grouping when --by-actor is set", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-by-actor-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Alice");
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runAlice = createRunId({ branch: "run-alice", timestamp: new Date("2026-04-12T06:00:00.000Z") });
  const runBob = createRunId({ branch: "run-bob", timestamp: new Date("2026-04-12T06:00:01.000Z") });

  setGitActor(repoRoot, "Alice");
  writeRun(repoRoot, {
    runId: runAlice,
    state: STATES.READY_TO_MERGE,
    rounds: 2,
    updatedAt: recentTs,
  });
  appendIterationScore(repoRoot, runAlice, {
    round: 1,
    scores: [
      { factor: "Coverage", target: ">= 8", observed: "8", met: true, status: "pass" },
    ],
  });

  setGitActor(repoRoot, "Bob");
  writeRun(repoRoot, {
    runId: runBob,
    state: STATES.CHANGES_REQUESTED,
    rounds: 3,
    updatedAt: recentTs,
  });
  appendIterationScore(repoRoot, runBob, {
    round: 1,
    scores: [
      { factor: "Docs", target: ">= 8", observed: "5", met: false, status: "fail" },
    ],
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json", "--by-actor"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(Object.keys(report.by_actor), ["Alice", "Bob"]);
  assert.equal(report.by_actor.Alice.totals.manifests, 1);
  assert.equal(report.by_actor.Alice.totals.events, 1);
  assert.equal(report.by_actor.Alice.metrics.median_rounds_to_ready, 2);
  assert.equal(report.by_actor.Alice.factor_analysis.most_stuck_factor, "Coverage");
  assert.equal(report.by_actor.Bob.totals.manifests, 1);
  assert.equal(report.by_actor.Bob.totals.events, 1);
  assert.equal(report.by_actor.Bob.metrics.median_rounds_to_ready, null);
  assert.equal(report.by_actor.Bob.factor_analysis.most_stuck_factor, "Docs");
});

test("reliability-report adds role-level grouping when --by-role is set", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-by-role-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Test");
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runCodex = createRunId({ branch: "run-codex", timestamp: new Date("2026-04-12T07:00:00.000Z") });
  const runClaude = createRunId({ branch: "run-claude", timestamp: new Date("2026-04-12T07:00:01.000Z") });

  writeRun(repoRoot, {
    runId: runCodex,
    state: STATES.READY_TO_MERGE,
    rounds: 1,
    updatedAt: recentTs,
  });
  writeRun(repoRoot, {
    runId: runClaude,
    state: STATES.CHANGES_REQUESTED,
    rounds: 2,
    updatedAt: recentTs,
  });

  const codexManifestPath = ensureRunLayout(repoRoot, runCodex).manifestPath;
  const claudeManifestPath = ensureRunLayout(repoRoot, runClaude).manifestPath;
  const codexRecord = readManifest(codexManifestPath);
  const claudeRecord = readManifest(claudeManifestPath);

  writeManifest(codexManifestPath, {
    ...codexRecord.data,
    roles: {
      ...codexRecord.data.roles,
      orchestrator: "codex",
      executor: "codex",
      reviewer: "codex",
    },
  }, codexRecord.body);
  writeManifest(claudeManifestPath, {
    ...claudeRecord.data,
    roles: {
      ...claudeRecord.data.roles,
      orchestrator: "codex",
      executor: "claude",
      reviewer: "claude",
    },
  }, claudeRecord.body);
  appendRunEvent(repoRoot, runClaude, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.CHANGES_REQUESTED,
    round: 2,
    reviewer: "claude",
    reason: "changes_requested",
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json", "--by-role"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.equal(report.by_role.orchestrator.codex.totals.manifests, 2);
  assert.equal(report.by_role.executor.codex.totals.manifests, 1);
  assert.equal(report.by_role.executor.claude.totals.manifests, 1);
  assert.equal(report.by_role.executor.claude.totals.events, 1);
  assert.equal(report.by_role.reviewer.codex.totals.manifests, 1);
  assert.equal(report.by_role.reviewer.claude.totals.manifests, 1);
});

test("reliability-report adds acting reviewer grouping without mutating assigned reviewer analytics", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-by-acting-reviewer-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Test");
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runAssignedAndActingCodex = createRunId({
    branch: "run-assigned-and-acting-codex",
    timestamp: new Date("2026-04-12T08:00:00.000Z"),
  });
  const runAssignedCodexActingClaude = createRunId({
    branch: "run-assigned-codex-acting-claude",
    timestamp: new Date("2026-04-12T08:00:01.000Z"),
  });
  const runMixedActingReviewers = createRunId({
    branch: "run-mixed-acting-reviewers",
    timestamp: new Date("2026-04-12T08:00:02.000Z"),
  });
  const runMissingReviewApply = createRunId({
    branch: "run-missing-review-apply",
    timestamp: new Date("2026-04-12T08:00:03.000Z"),
  });

  writeRun(repoRoot, {
    runId: runAssignedAndActingCodex,
    state: STATES.READY_TO_MERGE,
    rounds: 2,
    updatedAt: recentTs,
    reviewer: "codex",
    lastReviewer: "codex",
    lastReviewedSha: "codex222",
  });
  writeRun(repoRoot, {
    runId: runAssignedCodexActingClaude,
    state: STATES.CHANGES_REQUESTED,
    rounds: 1,
    updatedAt: recentTs,
    reviewer: "codex",
    lastReviewer: "claude",
    lastReviewedSha: "claude111",
  });
  writeRun(repoRoot, {
    runId: runMixedActingReviewers,
    state: STATES.READY_TO_MERGE,
    rounds: 2,
    updatedAt: recentTs,
    reviewer: "codex",
    lastReviewer: "claude",
    lastReviewedSha: "mixed222",
  });
  writeRun(repoRoot, {
    runId: runMissingReviewApply,
    state: STATES.CHANGES_REQUESTED,
    rounds: 1,
    updatedAt: recentTs,
    reviewer: "codex",
    lastReviewer: "claude",
    lastReviewedSha: "missing111",
  });

  appendRunEvent(repoRoot, runAssignedAndActingCodex, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.CHANGES_REQUESTED,
    round: 1,
    reviewer: "codex",
    reason: "changes_requested",
  });
  appendRunEvent(repoRoot, runAssignedAndActingCodex, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.READY_TO_MERGE,
    round: 2,
    reviewer: "codex",
    reason: "pass",
  });
  appendRunEvent(repoRoot, runAssignedCodexActingClaude, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.CHANGES_REQUESTED,
    round: 1,
    reviewer: "claude",
    reason: "changes_requested",
  });
  appendRunEvent(repoRoot, runMixedActingReviewers, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.CHANGES_REQUESTED,
    round: 1,
    reviewer: "codex",
    reason: "changes_requested",
  });
  appendRunEvent(repoRoot, runMixedActingReviewers, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.READY_TO_MERGE,
    round: 2,
    reviewer: "claude",
    reason: "pass",
  });

  const stdout = execFileSync(
    "node",
    [SCRIPT, "--repo", repoRoot, "--json", "--by-role", "--by-acting-reviewer"],
    { encoding: "utf-8" }
  );
  const report = JSON.parse(stdout);

  assert.deepEqual(Object.keys(report.by_role.reviewer), ["codex"]);
  assert.deepEqual(Object.keys(report.by_acting_reviewer.reviewers), ["claude", "codex"]);

  assert.equal(report.by_role.reviewer.codex.totals.manifests, 4);

  assert.deepEqual(report.by_acting_reviewer.reviewers.codex.acting_review, {
    review_apply_events: 3,
    review_apply_runs: 2,
    exclusive_review_apply_runs: 1,
    mixed_review_apply_runs: 1,
  });
  assert.equal(report.by_acting_reviewer.reviewers.codex.totals.manifests, 2);

  assert.deepEqual(report.by_acting_reviewer.reviewers.claude.acting_review, {
    review_apply_events: 2,
    review_apply_runs: 2,
    exclusive_review_apply_runs: 1,
    mixed_review_apply_runs: 1,
  });
  assert.equal(report.by_acting_reviewer.reviewers.claude.totals.manifests, 2);

  assert.deepEqual(report.by_acting_reviewer.summary, {
    review_apply_events: 5,
    review_apply_runs: 3,
    multi_reviewer_runs: 1,
    missing_review_apply_runs: 1,
    missing_review_apply_run_ids: [runMissingReviewApply],
  });
});

test("reliability-report keeps missing acting reviewer data explicit in text output", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-acting-reviewer-text-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runActingClaude = createRunId({
    branch: "run-acting-claude",
    timestamp: new Date("2026-04-12T08:10:00.000Z"),
  });
  const runMissingReviewApply = createRunId({
    branch: "run-missing-review-apply",
    timestamp: new Date("2026-04-12T08:10:01.000Z"),
  });

  writeRun(repoRoot, {
    runId: runActingClaude,
    state: STATES.CHANGES_REQUESTED,
    rounds: 1,
    updatedAt: recentTs,
    reviewer: "codex",
    lastReviewer: "claude",
    lastReviewedSha: "claude111",
  });
  writeRun(repoRoot, {
    runId: runMissingReviewApply,
    state: STATES.CHANGES_REQUESTED,
    rounds: 1,
    updatedAt: recentTs,
    reviewer: "codex",
    lastReviewer: "claude",
    lastReviewedSha: "missing111",
  });

  appendRunEvent(repoRoot, runActingClaude, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.CHANGES_REQUESTED,
    round: 1,
    reviewer: "claude",
    reason: "changes_requested",
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--by-acting-reviewer"], { encoding: "utf-8" });

  assert.match(stdout, /by_acting_reviewer:/);
  assert.match(stdout, /claude: review_apply_events=1 review_apply_runs=1 mixed_runs=0 manifests=1 events=1/);
  assert.match(stdout, /summary: review_apply_events=1 review_apply_runs=1 multi_reviewer_runs=0 missing_review_apply_runs=1/);
  assert.match(stdout, new RegExp(`missing_review_apply_run_ids: ${runMissingReviewApply}`));
});

test("reliability-report --by-acting-reviewer skips system-marked review_apply events", () => {
  // New producer shape: review-runner.js marks the `max_rounds_exceeded`
  // escalation path with `origin: "system"` and still omits `reviewer`.
  // The aggregator must exclude those events from acting-reviewer buckets
  // while keeping the run visible via `missing_review_apply_run_ids`.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-acting-system-emitted-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Test");
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runEscalated = createRunId({ branch: "run-escalated", timestamp: new Date("2026-04-12T09:00:00.000Z") });
  const runNormal = createRunId({ branch: "run-normal", timestamp: new Date("2026-04-12T09:00:01.000Z") });

  writeRun(repoRoot, {
    runId: runEscalated,
    state: STATES.ESCALATED,
    rounds: 20,
    updatedAt: recentTs,
    reviewer: "codex",
    lastReviewedSha: "escalated111",
  });
  writeRun(repoRoot, {
    runId: runNormal,
    state: STATES.CHANGES_REQUESTED,
    rounds: 1,
    updatedAt: recentTs,
    reviewer: "codex",
    lastReviewedSha: "normal111",
  });

  // Simulates review-runner.js:149 — no `reviewer` field.
  appendRunEvent(repoRoot, runEscalated, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.ESCALATED,
    round: 20,
    reason: "max_rounds_exceeded",
    origin: "system",
  });
  appendRunEvent(repoRoot, runNormal, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.CHANGES_REQUESTED,
    round: 1,
    reviewer: "codex",
    reason: "changes_requested",
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--json",
    "--by-acting-reviewer",
  ], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  // No "unknown" bucket — the reviewer-less event was skipped.
  assert.deepEqual(Object.keys(report.by_acting_reviewer.reviewers).sort(), ["codex"]);
  assert.equal(report.by_acting_reviewer.reviewers.codex.acting_review.review_apply_events, 1);
  assert.equal(report.by_acting_reviewer.reviewers.codex.acting_review.review_apply_runs, 1);

  // Escalated run surfaces as a missing_review_apply_run (data-integrity signal).
  assert.equal(report.by_acting_reviewer.summary.review_apply_events, 1);
  assert.equal(report.by_acting_reviewer.summary.review_apply_runs, 1);
  assert.equal(report.by_acting_reviewer.summary.missing_review_apply_runs, 1);
  assert.deepEqual(report.by_acting_reviewer.summary.missing_review_apply_run_ids, [runEscalated]);
});

test("reliability-report --by-acting-reviewer still skips legacy reviewer-less review_apply events", () => {
  // Backward compatibility: older events predate `origin: "system"` and only
  // omit `reviewer`. Keep filtering those until stored history ages out.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-acting-legacy-reviewerless-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Test");
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runEscalated = createRunId({ branch: "run-escalated", timestamp: new Date("2026-04-12T09:10:00.000Z") });
  const runNormal = createRunId({ branch: "run-normal", timestamp: new Date("2026-04-12T09:10:01.000Z") });

  writeRun(repoRoot, {
    runId: runEscalated,
    state: STATES.ESCALATED,
    rounds: 20,
    updatedAt: recentTs,
    reviewer: "codex",
    lastReviewedSha: "legacy111",
  });
  writeRun(repoRoot, {
    runId: runNormal,
    state: STATES.CHANGES_REQUESTED,
    rounds: 1,
    updatedAt: recentTs,
    reviewer: "codex",
    lastReviewedSha: "normal222",
  });

  appendRunEvent(repoRoot, runEscalated, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.ESCALATED,
    round: 20,
    reason: "max_rounds_exceeded",
  });
  appendRunEvent(repoRoot, runNormal, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.CHANGES_REQUESTED,
    round: 1,
    reviewer: "codex",
    reason: "changes_requested",
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--json",
    "--by-acting-reviewer",
  ], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(Object.keys(report.by_acting_reviewer.reviewers).sort(), ["codex"]);
  assert.equal(report.by_acting_reviewer.reviewers.codex.acting_review.review_apply_events, 1);
  assert.equal(report.by_acting_reviewer.reviewers.codex.acting_review.review_apply_runs, 1);
  assert.equal(report.by_acting_reviewer.summary.review_apply_events, 1);
  assert.equal(report.by_acting_reviewer.summary.review_apply_runs, 1);
  assert.equal(report.by_acting_reviewer.summary.missing_review_apply_runs, 1);
  assert.deepEqual(report.by_acting_reviewer.summary.missing_review_apply_run_ids, [runEscalated]);
});

test("reliability-report --by-acting-reviewer still routes explicit-but-empty reviewer to unknown bucket", () => {
  // Distinction vs system-emitted events: if the event carries a reviewer
  // field with a corrupt/whitespace value, we DO bucket it (as "unknown") so
  // data-integrity issues remain visible rather than being silently dropped.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-acting-empty-reviewer-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Test");
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runCorrupt = createRunId({ branch: "run-corrupt", timestamp: new Date("2026-04-12T09:15:00.000Z") });

  writeRun(repoRoot, {
    runId: runCorrupt,
    state: STATES.CHANGES_REQUESTED,
    rounds: 1,
    updatedAt: recentTs,
    reviewer: "codex",
    lastReviewedSha: "corrupt111",
  });

  appendRunEvent(repoRoot, runCorrupt, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.CHANGES_REQUESTED,
    round: 1,
    reviewer: "   ",
    reason: "changes_requested",
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--json",
    "--by-acting-reviewer",
  ], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(Object.keys(report.by_acting_reviewer.reviewers), ["unknown"]);
  assert.equal(report.by_acting_reviewer.reviewers.unknown.acting_review.review_apply_events, 1);
  assert.equal(report.by_acting_reviewer.summary.missing_review_apply_runs, 0);
});
