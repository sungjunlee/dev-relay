// canary: bare-string `event: "..."` fixture literals AND reader assertions in this file are deliberate canaries against EVENTS schema drift; do not port to EVENTS.X (see #313).
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
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
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { getRequestPath } = require("../../../skills/relay-ready/scripts/relay-request");
const {
  appendIterationScore,
  appendRubricQuality,
  appendRunEvent,
  appendScoreDivergence,
} = require("../../../skills/relay-dispatch/scripts/relay-events");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "reliability-report.js");

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

function setManifestGuidance(repoRoot, runId, guidancePacks) {
  const { manifestPath } = ensureRunLayout(repoRoot, runId);
  const manifest = readManifest(manifestPath).data;
  manifest.advisory = {
    ...(manifest.advisory || {}),
    guidance: {
      guidance_packs: guidancePacks,
      task_profile_summary: {
        size: "M",
        change_type: "feature",
        domains: ["relay-dispatch"],
        risk_tags: [],
        execution_mode: "standard",
      },
      artifact_path: "guidance-metadata.json",
      source: "prompt",
      updated_at: new Date().toISOString(),
    },
  };
  writeManifest(manifestPath, manifest);
}

function setManifestSource(repoRoot, runId, source) {
  const { manifestPath } = ensureRunLayout(repoRoot, runId);
  const manifest = readManifest(manifestPath).data;
  if (source === undefined) {
    delete manifest.source;
  } else {
    manifest.source = source;
  }
  writeManifest(manifestPath, manifest);
}

function setManifestDispatch(repoRoot, runId, dispatch) {
  const { manifestPath } = ensureRunLayout(repoRoot, runId);
  const manifest = readManifest(manifestPath).data;
  if (dispatch === undefined) {
    delete manifest.dispatch;
  } else {
    manifest.dispatch = dispatch;
  }
  writeManifest(manifestPath, manifest);
}

function appendSidecarStart(repoRoot, runId, {
  sidecarId,
  kind = "context-recap",
  executor = "codex",
  model = undefined,
  provider = undefined,
} = {}) {
  const event = {
    event: "sidecar_start",
    sidecar_id: sidecarId,
    kind,
    executor,
  };
  if (model !== undefined) event.model = model;
  if (provider !== undefined) event.provider = provider;
  appendRunEvent(repoRoot, runId, event);
}

function appendSidecarResult(repoRoot, runId, {
  sidecarId,
  kind = "context-recap",
} = {}) {
  appendRunEvent(repoRoot, runId, {
    event: "sidecar_result",
    sidecar_id: sidecarId,
    kind,
    output_path: `sidecars/${sidecarId}/output.md`,
    trust_level: "advisory",
  });
}

function appendSidecarFailed(repoRoot, runId, {
  sidecarId,
  kind = "context-recap",
} = {}) {
  appendRunEvent(repoRoot, runId, {
    event: "sidecar_failed",
    sidecar_id: sidecarId,
    kind,
    failure_reason: "sidecar exited non-zero",
  });
}

function appendRawRunEvent(repoRoot, runId, eventData) {
  const { runDir } = ensureRunLayout(repoRoot, runId);
  fs.appendFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
    ts: "2026-05-24T00:00:00.000Z",
    actor: "Relay Test",
    run_id: runId,
    state_from: null,
    state_to: null,
    head_sha: null,
    round: null,
    reason: null,
    ...eventData,
  })}\n`, "utf-8");
}

function writeSidecarOutput(repoRoot, runId, sidecarId, content) {
  const { runDir } = ensureRunLayout(repoRoot, runId);
  const outputDir = path.join(runDir, "sidecars", sidecarId);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "output.md"), content, "utf-8");
}

function writeRequestArtifact(repoRoot, requestId, { leafCount, leafOrder }) {
  initGitRepo(repoRoot);
  const requestPath = getRequestPath(repoRoot, requestId);
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  writeManifest(requestPath, {
    request_id: requestId,
    state: "relay_ready",
    leaf_count: leafCount,
    decomposition: {
      leaf_order: leafOrder,
      dependencies: {},
    },
    timestamps: {
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T00:00:00.000Z",
    },
  }, "# Relay Intake Request\n");
  return requestPath;
}

function writeSidecarOutputAt(repoRoot, runId, outputPathRelative, content) {
  const { runDir } = ensureRunLayout(repoRoot, runId);
  const outputPath = path.join(runDir, outputPathRelative);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, "utf-8");
}

function writeReviewVerdict(repoRoot, runId, round, issues, overrides = {}) {
  const { runDir } = ensureRunLayout(repoRoot, runId);
  fs.writeFileSync(
    path.join(runDir, `review-round-${round}-verdict.json`),
    JSON.stringify({ verdict: "changes_requested", issues, ...overrides }, null, 2),
    "utf-8"
  );
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

test("reliability-report aggregates review lineage by run and round", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-lineage-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runId = createRunId({ branch: "run-lineage", timestamp: new Date("2026-04-12T00:01:00.000Z") });

  writeRun(repoRoot, {
    runId,
    state: STATES.CHANGES_REQUESTED,
    rounds: 2,
    updatedAt: recentTs,
  });
  writeReviewVerdict(repoRoot, runId, 1, [
    { title: "Repeat", body: "Repeat.", file: "a.js", line: 1, category: "contract", severity: "high", lineage: "repeat" },
    { title: "Stale", body: "Stale.", file: "b.js", line: 2, category: "contract", severity: "high", lineage: "stale" },
    { title: "Legacy", body: "Legacy.", file: "c.js", line: 3, category: "contract", severity: "high" },
  ]);
  writeReviewVerdict(repoRoot, runId, 2, [
    { title: "Deepening", body: "Deepening.", file: "d.js", line: 4, category: "quality", severity: "medium", lineage: "deepening" },
    { title: "New", body: "New.", file: "e.js", line: 5, category: "quality", severity: "medium", lineage: "new" },
    { title: "Scoreable", body: "Scoreable.", file: "f.js", line: 6, category: "quality", severity: "medium", lineage: "newly_scoreable" },
  ]);

  const report = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" }));

  assert.deepEqual(report.review_lineage.totals, {
    deepening: 1,
    repeat: 1,
    stale: 1,
    new: 1,
    newly_scoreable: 1,
    unknown: 1,
  });
  assert.deepEqual(report.review_lineage.by_run[runId].totals, report.review_lineage.totals);
  assert.deepEqual(report.review_lineage.by_run[runId].rounds["1"], {
    deepening: 0,
    repeat: 1,
    stale: 1,
    new: 0,
    newly_scoreable: 0,
    unknown: 1,
  });
  assert.deepEqual(report.review_lineage.by_round["2"], {
    deepening: 1,
    repeat: 0,
    stale: 0,
    new: 1,
    newly_scoreable: 1,
    unknown: 0,
  });
});

test("reliability-report keeps round_cost stable for legacy runs without optional artifacts", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-round-cost-legacy-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runId = createRunId({ branch: "run-legacy-round-cost", timestamp: new Date("2026-04-12T00:02:00.000Z") });

  writeRun(repoRoot, {
    runId,
    state: STATES.READY_TO_MERGE,
    rounds: 2,
    updatedAt: recentTs,
  });

  const report = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" }));
  const text = execFileSync("node", [SCRIPT, "--repo", repoRoot], { encoding: "utf-8" });

  assert.deepEqual(report.round_cost.review_rounds, {
    sample_size: 1,
    average: 2,
    median: 2,
    max: 2,
    by_run: {
      [runId]: 2,
    },
  });
  assert.deepEqual(report.round_cost.request_linkage, {
    linked_runs: 0,
    unlinked_runs: 1,
    by_request: {},
    by_run: {
      [runId]: {
        request_id: null,
        leaf_id: null,
        leaf_count: null,
      },
    },
  });
  assert.deepEqual(report.round_cost.evidence_preflight_failures, {
    total: 0,
    by_type: {},
    by_status: {},
    by_run: {},
  });
  assert.equal(report.round_cost.reviewer_rounds_avoided_by_preflight, null);
  assert.match(text, /round_cost:/);
  assert.match(text, /avg_review_rounds=2 median_review_rounds=2/);
  assert.match(text, /reviewer_rounds_avoided_by_preflight=n\/a/);
});

test("reliability-report aggregates round_cost linkage, preflight, lineage, and escalation signals", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-round-cost-linked-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runId = createRunId({ branch: "run-round-cost", timestamp: new Date("2026-04-12T00:03:00.000Z") });
  const requestId = "req-20260412000300000";

  writeRequestArtifact(repoRoot, requestId, {
    leafCount: 2,
    leafOrder: ["leaf-a", "leaf-b"],
  });
  writeRun(repoRoot, {
    runId,
    state: STATES.CHANGES_REQUESTED,
    rounds: 3,
    updatedAt: recentTs,
  });
  setManifestSource(repoRoot, runId, {
    request_id: requestId,
    leaf_id: "leaf-a",
  });
  setManifestGuidance(repoRoot, runId, ["surgical-change", "verification-evidence"]);

  writeReviewVerdict(repoRoot, runId, 1, [
    { title: "Repeat", body: "Repeat.", file: "a.js", line: 1, category: "contract", severity: "high", lineage: "repeat" },
  ], {
    quality_execution_status: "missing",
    quality_execution_reason: "execution-evidence.json missing",
  });
  writeReviewVerdict(repoRoot, runId, 2, [
    { title: "Deepening", body: "Deepening.", file: "b.js", line: 2, category: "quality", severity: "medium", lineage: "deepening" },
  ], {
    quality_execution_status: "fail",
    quality_execution_reason: "stale artifact: recorded at a, reviewed at b",
  });
  writeReviewVerdict(repoRoot, runId, 3, [
    { title: "New", body: "New.", file: "c.js", line: 3, category: "quality", severity: "medium", lineage: "new" },
  ], {
    quality_execution_status: "pass",
  });

  appendRawRunEvent(repoRoot, runId, {
    event: "review_preflight_failed",
    round: 4,
    preflight_type: "execution_evidence_missing",
    quality_execution_status: "missing",
    reviewer_rounds_avoided: 1,
  });
  appendRunEvent(repoRoot, runId, {
    event: "escalation_decision",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.CHANGES_REQUESTED,
    round: 2,
    trigger: "flip_flop",
    decision: "escalate",
    factors: ["Evidence"],
    traces: [{ factor: "Evidence", trace: ["pass", "fail", "pass"] }],
    lineage_summary: { deepening: 0, repeat: 1, stale: 0, new: 0, newly_scoreable: 0, unknown: 0 },
  });
  appendRunEvent(repoRoot, runId, {
    event: "escalation_decision",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.CHANGES_REQUESTED,
    round: 3,
    trigger: "flip_flop",
    decision: "continue",
    factors: ["Evidence"],
    traces: [{ factor: "Evidence", trace: ["fail", "pass", "fail"] }],
    lineage_summary: { deepening: 1, repeat: 0, stale: 0, new: 0, newly_scoreable: 0, unknown: 0 },
  });

  const report = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" }));
  const text = execFileSync("node", [SCRIPT, "--repo", repoRoot], { encoding: "utf-8" });

  assert.deepEqual(report.round_cost.review_rounds, {
    sample_size: 1,
    average: 3,
    median: 3,
    max: 3,
    by_run: {
      [runId]: 3,
    },
  });
  assert.deepEqual(report.round_cost.request_linkage.by_request, {
    [requestId]: {
      leaf_count: 2,
      linked_runs: 1,
      linked_leaf_count: 1,
      linked_leaves: ["leaf-a"],
    },
  });
  assert.deepEqual(report.round_cost.request_linkage.by_run[runId], {
    request_id: requestId,
    leaf_id: "leaf-a",
    leaf_count: 2,
  });
  assert.deepEqual(report.round_cost.task_guidance, {
    available_runs: 1,
    by_size: { M: 1 },
    by_execution_mode: { standard: 1 },
    guidance_packs: {
      "surgical-change": 1,
      "verification-evidence": 1,
    },
    by_run: {
      [runId]: {
        task_profile_summary: {
          size: "M",
          change_type: "feature",
          domains: ["relay-dispatch"],
          risk_tags: [],
          execution_mode: "standard",
        },
        guidance_packs: ["surgical-change", "verification-evidence"],
      },
    },
  });
  assert.deepEqual(report.round_cost.evidence_preflight_failures, {
    total: 3,
    by_type: {
      execution_evidence_missing: 2,
      execution_evidence_stale: 1,
    },
    by_status: {
      fail: 1,
      missing: 2,
    },
    by_run: {
      [runId]: {
        total: 3,
        by_type: {
          execution_evidence_missing: 2,
          execution_evidence_stale: 1,
        },
        by_status: {
          fail: 1,
          missing: 2,
        },
      },
    },
  });
  assert.deepEqual(report.round_cost.lineage_totals, {
    deepening: 1,
    repeat: 1,
    stale: 0,
    new: 1,
    newly_scoreable: 0,
    unknown: 0,
  });
  assert.deepEqual(report.round_cost.escalation_decisions, {
    total: 2,
    by_decision: {
      continue: 1,
      escalate: 1,
    },
    by_trigger: {
      flip_flop: 2,
    },
    factor_flip: {
      total: 2,
      continue: 1,
      escalate: 1,
    },
  });
  assert.deepEqual(report.round_cost.reviewer_rounds_avoided_by_preflight, {
    total: 1,
    by_type: {
      execution_evidence_missing: 1,
    },
    by_run: {
      [runId]: 1,
    },
  });
  assert.match(text, /round_cost:/);
  assert.match(text, /avg_review_rounds=3 median_review_rounds=3/);
  assert.match(text, /evidence_preflight_failures=3/);
  assert.match(text, /reviewer_rounds_avoided_by_preflight=1/);
  assert.match(text, /factor_flip: total=2 continue=1 escalate=1/);
});

test("reliability-report summarizes override audit events without treating legacy shapes as corrupt", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-override-audit-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const forceRun = createRunId({ branch: "force-finalize", timestamp: new Date("2026-05-24T00:00:00.000Z") });
  const rebrandRun = createRunId({ branch: "rebrand-evidence", timestamp: new Date("2026-05-24T00:00:01.000Z") });
  const legacyRun = createRunId({ branch: "legacy-override", timestamp: new Date("2026-05-24T00:00:02.000Z") });
  const malformedRun = createRunId({ branch: "malformed-override", timestamp: new Date("2026-05-24T00:00:03.000Z") });

  for (const runId of [forceRun, rebrandRun, legacyRun, malformedRun]) {
    writeRun(repoRoot, {
      runId,
      state: STATES.REVIEW_PENDING,
      rounds: 1,
      updatedAt: recentTs,
    });
  }

  appendRunEvent(repoRoot, forceRun, {
    event: "force_finalize",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.MERGED,
    override_class: "force_finalize_nonready",
    affected_head_sha: "a".repeat(40),
    prior_state: STATES.REVIEW_PENDING,
    required_reason: "operator verified by hand",
    operator_initiated: true,
  });
  appendRunEvent(repoRoot, rebrandRun, {
    event: "execution_evidence_rebranded",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.REVIEW_PENDING,
    override_class: "execution_evidence_rebrand",
    affected_head_sha: "b".repeat(40),
    prior_state: STATES.REVIEW_PENDING,
    required_reason: "evidence needed new head sha",
    operator_initiated: true,
  });
  appendRawRunEvent(repoRoot, legacyRun, {
    event: "force_finalize",
    state_from: STATES.READY_TO_MERGE,
    state_to: STATES.MERGED,
    reason: "legacy force finalize before override audit fields",
  });
  appendRawRunEvent(repoRoot, malformedRun, {
    event: "force_finalize",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.MERGED,
    override_class: "force_finalize_nonready",
    affected_head_sha: "",
    required_reason: null,
    operator_initiated: false,
  });

  const report = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" }));
  const text = execFileSync("node", [SCRIPT, "--repo", repoRoot], { encoding: "utf-8" });

  assert.deepEqual(report.override_audit, {
    total_events: 4,
    current_shape_events: 3,
    legacy_shape_events: 1,
    malformed_current_shape_events: 1,
    by_override_class: {
      execution_evidence_rebrand: 1,
      force_finalize_nonready: 2,
      unknown: 1,
    },
    by_operator_initiated: {
      false: 1,
      true: 2,
      unknown: 1,
    },
    field_presence: {
      affected_head_sha: { present: 2, missing: 2 },
      required_reason: { present: 2, missing: 2 },
    },
    affected_transitions: {
      "ready_to_merge->merged": 1,
      "review_pending->merged": 2,
      "review_pending->review_pending": 1,
    },
    findings: [{
      run_id: malformedRun,
      event: "force_finalize",
      override_class: "force_finalize_nonready",
      missing_fields: ["affected_head_sha", "required_reason"],
    }],
  });
  assert.match(text, /override_audit:/);
  assert.match(text, /total_events=4 current_shape=3 legacy_shape=1 malformed=1/);
  assert.match(text, /by_override_class: force_finalize_nonready=2, execution_evidence_rebrand=1, unknown=1/);
  assert.match(text, /findings: 1 malformed current-shape event/);
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

test("reliability-report derives guidance pack insights from guidance events and manifest metadata", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-guidance-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runEventPass = createRunId({ branch: "run-guidance-event-pass", timestamp: new Date("2026-04-12T02:05:00.000Z") });
  const runEventChanges = createRunId({ branch: "run-guidance-event-changes", timestamp: new Date("2026-04-12T02:05:01.000Z") });
  const runEventMixed = createRunId({ branch: "run-guidance-event-mixed", timestamp: new Date("2026-04-12T02:05:02.000Z") });
  const runManifestOnly = createRunId({ branch: "run-guidance-manifest-only", timestamp: new Date("2026-04-12T02:05:03.000Z") });
  const runLegacy = createRunId({ branch: "run-guidance-legacy", timestamp: new Date("2026-04-12T02:05:04.000Z") });

  writeRun(repoRoot, {
    runId: runEventPass,
    state: STATES.READY_TO_MERGE,
    rounds: 1,
    updatedAt: recentTs,
  });
  writeRun(repoRoot, {
    runId: runEventChanges,
    state: STATES.CHANGES_REQUESTED,
    rounds: 3,
    updatedAt: recentTs,
  });
  writeRun(repoRoot, {
    runId: runEventMixed,
    state: STATES.READY_TO_MERGE,
    rounds: 2,
    updatedAt: recentTs,
  });
  writeRun(repoRoot, {
    runId: runManifestOnly,
    state: STATES.READY_TO_MERGE,
    rounds: 5,
    updatedAt: recentTs,
  });
  writeRun(repoRoot, {
    runId: runLegacy,
    state: STATES.READY_TO_MERGE,
    rounds: 4,
    updatedAt: recentTs,
  });
  setManifestGuidance(repoRoot, runManifestOnly, ["surgical-change"]);

  appendRunEvent(repoRoot, runEventPass, {
    event: "guidance_selected",
    state_from: STATES.DRAFT,
    state_to: STATES.DISPATCHED,
    guidance_packs: ["surgical-change", "verification-evidence"],
    guidance_source: "prompt",
  });
  appendRunEvent(repoRoot, runEventChanges, {
    event: "guidance_selected",
    state_from: STATES.DRAFT,
    state_to: STATES.DISPATCHED,
    guidance_packs: ["surgical-change"],
    guidance_source: "prompt",
  });
  appendRunEvent(repoRoot, runEventMixed, {
    event: "guidance_selected",
    state_from: STATES.DRAFT,
    state_to: STATES.DISPATCHED,
    guidance_packs: ["simplify-pass"],
    guidance_source: "prompt",
  });

  appendRunEvent(repoRoot, runEventPass, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.READY_TO_MERGE,
    round: 1,
    reviewer: "codex",
    reason: "pass",
  });
  appendRunEvent(repoRoot, runEventChanges, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.CHANGES_REQUESTED,
    round: 3,
    reviewer: "codex",
    reason: "changes_requested",
  });
  appendRunEvent(repoRoot, runEventMixed, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.CHANGES_REQUESTED,
    round: 1,
    reviewer: "codex",
    reason: "changes_requested",
  });
  appendRunEvent(repoRoot, runEventMixed, {
    event: "review_apply",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.READY_TO_MERGE,
    round: 2,
    reviewer: "codex",
    reason: "pass",
  });

  appendIterationScore(repoRoot, runEventPass, {
    round: 1,
    scores: [
      { factor: "Coverage", target: ">= 8", observed: "8", met: true, status: "pass" },
      { factor: "Docs", target: ">= 8", observed: "8", met: true, status: "pass" },
    ],
  });
  appendIterationScore(repoRoot, runEventChanges, {
    round: 1,
    scores: [
      { factor: "Coverage", target: ">= 8", observed: "5", met: false, status: "fail" },
      { factor: "Docs", target: ">= 8", observed: "5", met: false, status: "fail" },
    ],
  });
  appendIterationScore(repoRoot, runEventMixed, {
    round: 2,
    scores: [
      { factor: "Refactor", target: ">= 8", observed: "8", met: true, status: "pass" },
    ],
  });
  appendScoreDivergence(repoRoot, runEventPass, {
    round: 1,
    divergences: [
      { factor: "Coverage", executor: "9", reviewer: "7", delta: 2, tier: "contract" },
    ],
  });
  appendScoreDivergence(repoRoot, runEventChanges, {
    round: 3,
    divergences: [
      { factor: "Docs", executor: "5", reviewer: "6", delta: -1, tier: "quality" },
    ],
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(report.guidance_pack_insights, {
    status: "available",
    packs: {
      "simplify-pass": {
        usage_count: 1,
        avg_review_rounds: 2,
        changes_requested_rate: 1,
        stuck_factors: [
          {
            factor: "Refactor",
            appearances: 1,
            met_rate: 1,
            avg_rounds_to_met: 2,
          },
        ],
        executor_reviewer_divergence: {
          occurrences: 0,
          avg_delta: null,
          hotspots: [],
        },
      },
      "surgical-change": {
        usage_count: 3,
        avg_review_rounds: 3,
        changes_requested_rate: 0.3333,
        stuck_factors: [
          {
            factor: "Coverage",
            appearances: 2,
            met_rate: 0.5,
            avg_rounds_to_met: 1,
          },
          {
            factor: "Docs",
            appearances: 2,
            met_rate: 0.5,
            avg_rounds_to_met: 1,
          },
        ],
        executor_reviewer_divergence: {
          occurrences: 2,
          avg_delta: 0.5,
          hotspots: [
            {
              factor_pattern: "Coverage",
              occurrences: 1,
              avg_delta: 2,
              recommendation: "Executor scores trend higher than review; tighten examples or add automation.",
            },
            {
              factor_pattern: "Docs",
              occurrences: 1,
              avg_delta: -1,
              recommendation: "Reviewer scores trend higher than executor; check whether the factor is underspecified.",
            },
          ],
        },
      },
      "verification-evidence": {
        usage_count: 1,
        avg_review_rounds: 1,
        changes_requested_rate: 0,
        stuck_factors: [
          {
            factor: "Coverage",
            appearances: 1,
            met_rate: 1,
            avg_rounds_to_met: 1,
          },
          {
            factor: "Docs",
            appearances: 1,
            met_rate: 1,
            avg_rounds_to_met: 1,
          },
        ],
        executor_reviewer_divergence: {
          occurrences: 1,
          avg_delta: 2,
          hotspots: [
            {
              factor_pattern: "Coverage",
              occurrences: 1,
              avg_delta: 2,
              recommendation: "Executor scores trend higher than review; tighten examples or add automation.",
            },
          ],
        },
      },
    },
  });
});

test("reliability-report renders no guidance data available for empty and legacy runs", () => {
  const emptyRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-guidance-empty-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(emptyRepoRoot);

  const emptyJson = JSON.parse(execFileSync("node", [SCRIPT, "--repo", emptyRepoRoot, "--json"], { encoding: "utf-8" }));
  const emptyText = execFileSync("node", [SCRIPT, "--repo", emptyRepoRoot], { encoding: "utf-8" });

  assert.deepEqual(emptyJson.guidance_pack_insights, {
    status: "no guidance data available",
    packs: {},
  });
  assert.match(emptyText, /guidance_pack_insights: no guidance data available/);

  const legacyRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-guidance-legacy-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runLegacy = createRunId({ branch: "run-guidance-legacy-only", timestamp: new Date("2026-04-12T02:06:00.000Z") });

  writeRun(legacyRepoRoot, {
    runId: runLegacy,
    state: STATES.READY_TO_MERGE,
    rounds: 1,
    updatedAt: recentTs,
  });

  const legacyJson = JSON.parse(execFileSync("node", [SCRIPT, "--repo", legacyRepoRoot, "--json"], { encoding: "utf-8" }));
  const legacyText = execFileSync("node", [SCRIPT, "--repo", legacyRepoRoot], { encoding: "utf-8" });

  assert.deepEqual(legacyJson.guidance_pack_insights, {
    status: "no guidance data available",
    packs: {},
  });
  assert.match(legacyText, /guidance_pack_insights: no guidance data available/);
});

test("reliability-report emits canonical empty sidecar insights for legacy repos", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-sidecar-empty-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot);

  const report = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" }));
  const text = execFileSync("node", [SCRIPT, "--repo", repoRoot], { encoding: "utf-8" });

  assert.deepEqual(report.sidecar_insights, {
    total_invocations: 0,
    by_kind: {},
    by_executor: {},
    by_model: {},
    by_provider: {},
    failure_rate: null,
    predicted_findings_match_rate: null,
    predicted_findings_runs_examined: 0,
  });
  assert.match(text, /sidecar_insights: no sidecar runs available/);
});

test("reliability-report counts sidecar usage and outcomes by kind and executor", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-sidecar-counts-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runA = createRunId({ branch: "run-sidecar-a", timestamp: new Date("2026-04-12T02:07:00.000Z") });
  const runB = createRunId({ branch: "run-sidecar-b", timestamp: new Date("2026-04-12T02:07:01.000Z") });

  writeRun(repoRoot, { runId: runA, state: STATES.REVIEW_PENDING, rounds: 1, updatedAt: recentTs });
  writeRun(repoRoot, { runId: runB, state: STATES.REVIEW_PENDING, rounds: 1, updatedAt: recentTs });

  appendSidecarStart(repoRoot, runA, { sidecarId: "sc-1", kind: "context-recap", executor: "codex", model: "gpt-5", provider: "openai" });
  appendSidecarResult(repoRoot, runA, { sidecarId: "sc-1", kind: "context-recap" });
  appendSidecarStart(repoRoot, runA, { sidecarId: "sc-2", kind: "context-recap", executor: "codex", model: "gpt-5", provider: "openai" });
  appendSidecarFailed(repoRoot, runA, { sidecarId: "sc-2", kind: "context-recap" });
  appendSidecarStart(repoRoot, runB, { sidecarId: "sc-3", kind: "review-hints", executor: "claude", model: "sonnet", provider: "anthropic" });
  appendSidecarResult(repoRoot, runB, { sidecarId: "sc-3", kind: "review-hints" });

  const report = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" }));
  const text = execFileSync("node", [SCRIPT, "--repo", repoRoot], { encoding: "utf-8" });

  assert.equal(report.sidecar_insights.total_invocations, 3);
  assert.deepEqual(report.sidecar_insights.by_kind, {
    "context-recap": { invocations: 2, successes: 1, failures: 1 },
    "review-hints": { invocations: 1, successes: 1, failures: 0 },
  });
  assert.deepEqual(report.sidecar_insights.by_executor, {
    claude: { invocations: 1, successes: 1, failures: 0 },
    codex: { invocations: 2, successes: 1, failures: 1 },
  });
  assert.deepEqual(report.sidecar_insights.by_model, {
    "gpt-5": { invocations: 2 },
    sonnet: { invocations: 1 },
  });
  assert.deepEqual(report.sidecar_insights.by_provider, {
    anthropic: { invocations: 1 },
    openai: { invocations: 2 },
  });
  assert.equal(report.sidecar_insights.failure_rate, 0.3333);
  assert.match(text, /sidecar_insights:/);
  assert.match(text, /total_invocations: 3/);
  assert.match(text, /failure_rate: 0\.3333/);
  assert.match(text, /by_kind: context-recap=2/);
  assert.doesNotMatch(text, /predicted_findings_match_rate:/);
});

test("reliability-report aggregates advisory and sidecar critical-path impact", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-critical-path-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runA = createRunId({ branch: "run-critical-a", timestamp: new Date("2026-04-12T02:12:00.000Z") });
  const runB = createRunId({ branch: "run-critical-b", timestamp: new Date("2026-04-12T02:12:01.000Z") });

  writeRun(repoRoot, { runId: runA, state: STATES.READY_TO_MERGE, rounds: 1, updatedAt: recentTs });
  writeRun(repoRoot, { runId: runB, state: STATES.CHANGES_REQUESTED, rounds: 1, updatedAt: recentTs });

  appendRunEvent(repoRoot, runA, {
    event: "advisory_review",
    state_from: "review_pending",
    state_to: "review_pending",
    head_sha: "a".repeat(40),
    round: 1,
    reviewer: "opencode",
    status: "success",
    elapsed_ms: 120,
    advisory_elapsed_ms: 120,
    critical_path_wait_ms: 40,
    consumed_by_phase: "review",
    phase_decision_waited: true,
    frontier_step_replaced: false,
  });
  appendRunEvent(repoRoot, runA, {
    event: "sidecar_result",
    sidecar_id: "sc-late",
    kind: "docs-sync",
    output_path: "sidecars/sc-late/output.md",
    trust_level: "advisory",
    elapsed_ms: 300,
    sidecar_elapsed_ms: 300,
    critical_path_wait_ms: 50,
    consumed_by_phase: "metrics",
    phase_decision_waited: true,
    frontier_step_replaced: false,
  });
  appendRunEvent(repoRoot, runB, {
    event: "advisory_review",
    state_from: "review_pending",
    state_to: "review_pending",
    head_sha: "b".repeat(40),
    round: 1,
    reviewer: "opencode",
    status: "success",
    elapsed_ms: 80,
    advisory_elapsed_ms: 80,
    critical_path_wait_ms: 0,
    consumed_by_phase: "redispatch",
    phase_decision_waited: false,
    frontier_step_replaced: false,
  });

  const report = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" }));

  assert.deepEqual(report.advisory_sidecar_timing.by_consumed_phase, {
    metrics: 1,
    redispatch: 1,
    review: 1,
  });
  assert.equal(report.advisory_sidecar_timing.consumed_before_decision, 1);
  assert.equal(report.advisory_sidecar_timing.metrics_only_late_artifacts, 1);
  assert.equal(report.advisory_sidecar_timing.redispatch_artifacts, 1);
  assert.equal(report.advisory_sidecar_timing.median_critical_path_wait_ms, 40);
  assert.equal(report.advisory_sidecar_timing.phase_decision_waited, 2);
  assert.equal(report.advisory_sidecar_timing.frontier_step_replaced, 0);
});

test("reliability-report keeps sidecar insights only on the top-level report", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-sidecar-top-level-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runId = createRunId({ branch: "run-sidecar-top-level", timestamp: new Date("2026-04-12T02:07:30.000Z") });

  writeRun(repoRoot, { runId, state: STATES.REVIEW_PENDING, rounds: 1, updatedAt: recentTs });
  appendSidecarStart(repoRoot, runId, { sidecarId: "sc-top", kind: "context-recap", executor: "codex" });

  const report = JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo",
    repoRoot,
    "--json",
    "--by-actor",
    "--by-role",
    "--by-dispatch",
    "--by-acting-reviewer",
  ], { encoding: "utf-8" }));

  assert.equal(report.sidecar_insights.total_invocations, 1);
  for (const scopedReport of Object.values(report.by_actor)) {
    assert.equal("sidecar_insights" in scopedReport, false);
  }
  for (const roleReport of Object.values(report.by_role)) {
    for (const scopedReport of Object.values(roleReport)) {
      assert.equal("sidecar_insights" in scopedReport, false);
    }
  }
  for (const dimensionReport of Object.values(report.by_dispatch)) {
    for (const scopedReport of Object.values(dimensionReport)) {
      assert.equal("sidecar_insights" in scopedReport, false);
    }
  }
});

test("reliability-report buckets sidecar starts without model or provider as unknown", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-sidecar-unknown-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runId = createRunId({ branch: "run-sidecar-unknown", timestamp: new Date("2026-04-12T02:08:00.000Z") });

  writeRun(repoRoot, { runId, state: STATES.REVIEW_PENDING, rounds: 1, updatedAt: recentTs });
  appendSidecarStart(repoRoot, runId, {
    sidecarId: "sc-unknown",
    kind: "context-recap",
    executor: "codex",
    model: undefined,
    provider: undefined,
  });

  const report = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" }));

  assert.deepEqual(report.sidecar_insights.by_model, { unknown: { invocations: 1 } });
  assert.deepEqual(report.sidecar_insights.by_provider, { unknown: { invocations: 1 } });
});

test("reliability-report estimates sidecar prediction matches from output and review verdict titles", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-sidecar-prediction-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runId = createRunId({ branch: "run-sidecar-prediction", timestamp: new Date("2026-04-12T02:09:00.000Z") });

  writeRun(repoRoot, { runId, state: STATES.CHANGES_REQUESTED, rounds: 1, updatedAt: recentTs });
  appendSidecarStart(repoRoot, runId, { sidecarId: "sc-predict", kind: "context-recap", executor: "codex" });
  appendSidecarResult(repoRoot, runId, { sidecarId: "sc-predict", kind: "context-recap" });
  writeSidecarOutput(repoRoot, runId, "sc-predict", "The recap warned about missing retry budget coverage before review.");
  writeReviewVerdict(repoRoot, runId, 1, [
    { title: "Missing retry budget coverage", body: "Add tests.", file: "test.js", line: 12, category: "contract", severity: "high" },
    { title: "Document timeout behavior", body: "Document it.", file: "README.md", line: 4, category: "contract", severity: "medium" },
  ]);

  const report = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" }));

  assert.equal(report.sidecar_insights.predicted_findings_runs_examined, 1);
  assert.ok(report.sidecar_insights.predicted_findings_match_rate >= 0.5);
});

test("reliability-report counts sidecar output substrings of review titles as predictions", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-sidecar-title-substring-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runId = createRunId({ branch: "run-sidecar-title-substring", timestamp: new Date("2026-04-12T02:09:30.000Z") });

  writeRun(repoRoot, { runId, state: STATES.CHANGES_REQUESTED, rounds: 1, updatedAt: recentTs });
  appendSidecarStart(repoRoot, runId, { sidecarId: "sc-substring", kind: "context-recap", executor: "codex" });
  appendSidecarResult(repoRoot, runId, { sidecarId: "sc-substring", kind: "context-recap" });
  writeSidecarOutput(repoRoot, runId, "sc-substring", "The sidecar flagged output_path before review.");
  writeReviewVerdict(repoRoot, runId, 1, [
    { title: "Review verdict omits output_path validation", body: "Track output_path.", file: "report.js", line: 7, category: "contract", severity: "high" },
    { title: "Require branch cleanup audit", body: "Audit cleanup.", file: "cleanup.js", line: 3, category: "quality", severity: "medium" },
  ]);

  const report = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" }));

  assert.equal(report.sidecar_insights.predicted_findings_runs_examined, 1);
  assert.equal(report.sidecar_insights.predicted_findings_match_rate, 0.5);
});

test("reliability-report reads sidecar output via event.output_path indirection", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-sidecar-output-path-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runId = createRunId({ branch: "run-sidecar-output-path", timestamp: new Date("2026-04-12T02:09:45.000Z") });
  const sidecarId = "sc-custom-output";
  const outputPath = `sidecars/${sidecarId}/custom-output.md`;

  writeRun(repoRoot, { runId, state: STATES.CHANGES_REQUESTED, rounds: 1, updatedAt: recentTs });
  appendSidecarStart(repoRoot, runId, { sidecarId, kind: "context-recap", executor: "codex" });
  appendRunEvent(repoRoot, runId, {
    event: "sidecar_result",
    sidecar_id: sidecarId,
    kind: "context-recap",
    output_path: outputPath,
    trust_level: "advisory",
  });
  writeSidecarOutputAt(repoRoot, runId, outputPath, "The sidecar predicted missing custom output path coverage.");
  writeReviewVerdict(repoRoot, runId, 1, [
    { title: "Missing custom output path coverage", body: "Read event output_path.", file: "report.js", line: 7, category: "contract", severity: "high" },
  ]);

  const report = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" }));

  assert.equal(report.sidecar_insights.predicted_findings_runs_examined, 1);
  assert.ok(report.sidecar_insights.predicted_findings_match_rate > 0);
});

test("reliability-report keeps sidecar prediction null when results have no review verdicts", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-sidecar-prediction-null-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runId = createRunId({ branch: "run-sidecar-prediction-null", timestamp: new Date("2026-04-12T02:10:00.000Z") });

  writeRun(repoRoot, { runId, state: STATES.REVIEW_PENDING, rounds: 1, updatedAt: recentTs });
  appendSidecarStart(repoRoot, runId, { sidecarId: "sc-result", kind: "context-recap", executor: "codex" });
  appendSidecarResult(repoRoot, runId, { sidecarId: "sc-result", kind: "context-recap" });
  writeSidecarOutput(repoRoot, runId, "sc-result", "This output has no verdict to compare against.");

  const report = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" }));

  assert.equal(report.sidecar_insights.predicted_findings_match_rate, null);
  assert.equal(report.sidecar_insights.predicted_findings_runs_examined, 0);
});

test("reliability-report skips unreadable or corrupted sidecar outputs during prediction", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-sidecar-corrupt-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runMissingOutput = createRunId({ branch: "run-sidecar-missing-output", timestamp: new Date("2026-04-12T02:10:59.000Z") });
  const runDirOutput = createRunId({ branch: "run-sidecar-dir-output", timestamp: new Date("2026-04-12T02:11:00.000Z") });
  const runNullOutput = createRunId({ branch: "run-sidecar-null-output", timestamp: new Date("2026-04-12T02:11:01.000Z") });

  writeRun(repoRoot, { runId: runMissingOutput, state: STATES.CHANGES_REQUESTED, rounds: 1, updatedAt: recentTs });
  appendSidecarStart(repoRoot, runMissingOutput, { sidecarId: "sc-missing", kind: "context-recap", executor: "codex" });
  appendSidecarResult(repoRoot, runMissingOutput, { sidecarId: "sc-missing", kind: "context-recap" });
  writeReviewVerdict(repoRoot, runMissingOutput, 1, [
    { title: "Missing output is skipped", body: "Skip.", file: "x.js", line: 1, category: "contract", severity: "high" },
  ]);

  writeRun(repoRoot, { runId: runDirOutput, state: STATES.CHANGES_REQUESTED, rounds: 1, updatedAt: recentTs });
  appendSidecarStart(repoRoot, runDirOutput, { sidecarId: "sc-dir", kind: "context-recap", executor: "codex" });
  appendSidecarResult(repoRoot, runDirOutput, { sidecarId: "sc-dir", kind: "context-recap" });
  fs.mkdirSync(path.join(ensureRunLayout(repoRoot, runDirOutput).runDir, "sidecars", "sc-dir", "output.md"), { recursive: true });
  writeReviewVerdict(repoRoot, runDirOutput, 1, [
    { title: "Directory output skipped", body: "Skip.", file: "x.js", line: 1, category: "contract", severity: "high" },
  ]);

  writeRun(repoRoot, { runId: runNullOutput, state: STATES.CHANGES_REQUESTED, rounds: 1, updatedAt: recentTs });
  appendSidecarStart(repoRoot, runNullOutput, { sidecarId: "sc-null", kind: "context-recap", executor: "codex" });
  appendSidecarResult(repoRoot, runNullOutput, { sidecarId: "sc-null", kind: "context-recap" });
  writeSidecarOutput(repoRoot, runNullOutput, "sc-null", "\u0000\u0000\u0000");
  writeReviewVerdict(repoRoot, runNullOutput, 1, [
    { title: "Null output skipped", body: "Skip.", file: "x.js", line: 1, category: "contract", severity: "high" },
  ]);

  const report = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" }));

  assert.equal(report.sidecar_insights.total_invocations, 3);
  assert.equal(report.sidecar_insights.predicted_findings_match_rate, null);
  assert.equal(report.sidecar_insights.predicted_findings_runs_examined, 0);
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

test("reliability-report includes dispatch reliability metrics in the top-level report", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-dispatch-metrics-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Test");
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runRecovered = createRunId({ branch: "run-recovered", timestamp: new Date("2026-04-12T10:00:00.000Z") });
  const runPlain = createRunId({ branch: "run-plain", timestamp: new Date("2026-04-12T10:00:01.000Z") });

  writeRun(repoRoot, {
    runId: runRecovered,
    state: STATES.REVIEW_PENDING,
    rounds: 1,
    updatedAt: recentTs,
  });
  writeRun(repoRoot, {
    runId: runPlain,
    state: STATES.REVIEW_PENDING,
    rounds: 1,
    updatedAt: recentTs,
  });

  appendRunEvent(repoRoot, runRecovered, {
    event: "dispatch_result",
    state_from: STATES.DISPATCHED,
    state_to: STATES.REVIEW_PENDING,
    reason: "new_dispatch:completed",
    failure_class: "timeout",
  });
  appendRunEvent(repoRoot, runRecovered, {
    event: "dispatch_result",
    state_from: STATES.DISPATCHED,
    state_to: STATES.ESCALATED,
    reason: "new_dispatch:dispatch_failed",
  });
  appendRunEvent(repoRoot, runPlain, {
    event: "dispatch_result",
    state_from: STATES.DISPATCHED,
    state_to: STATES.REVIEW_PENDING,
    reason: "new_dispatch:completed",
  });
  appendRunEvent(repoRoot, runPlain, {
    event: "dispatch_result",
    state_from: STATES.DISPATCHED,
    state_to: STATES.REVIEW_PENDING,
    reason: "new_dispatch:completed",
  });
  appendRunEvent(repoRoot, runRecovered, {
    event: "recover_commit",
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.REVIEW_PENDING,
    reason: "completed-uncommitted recovery",
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.equal(report.metrics.dispatch_timeout_rate, 0.25);
  assert.equal(report.metrics.dispatch_failure_rate, 0.25);
  assert.equal(report.metrics.recover_commit_rate, 0.5);
  assert.equal(report.metrics.pass_rate, 0);
});

test("reliability-report keeps dispatch reliability metrics null when denominators are empty", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-dispatch-empty-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Test");

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.equal(report.metrics.dispatch_timeout_rate, null);
  assert.equal(report.metrics.dispatch_failure_rate, null);
  assert.equal(report.metrics.recover_commit_rate, null);
  assert.equal(report.metrics.pass_rate, null);
});

test("reliability-report computes non-zero pass_rate when runs reach merged/ready_to_merge", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-pass-rate-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Test");
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runMerged = createRunId({ branch: "run-merged", timestamp: new Date("2026-04-12T10:10:00.000Z") });
  const runReady = createRunId({ branch: "run-ready", timestamp: new Date("2026-04-12T10:10:01.000Z") });
  const runOpen = createRunId({ branch: "run-open", timestamp: new Date("2026-04-12T10:10:02.000Z") });

  writeRun(repoRoot, { runId: runMerged, state: STATES.MERGED, rounds: 2, updatedAt: recentTs });
  writeRun(repoRoot, { runId: runReady, state: STATES.READY_TO_MERGE, rounds: 1, updatedAt: recentTs });
  writeRun(repoRoot, { runId: runOpen, state: STATES.REVIEW_PENDING, rounds: 1, updatedAt: recentTs });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.equal(report.metrics.pass_rate, Number((2 / 3).toFixed(4)));
});

test("reliability-report --by-dispatch groups by executor, model, and provider", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-by-dispatch-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Test");
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runA = createRunId({ branch: "run-a", timestamp: new Date("2026-04-12T10:05:00.000Z") });
  const runB = createRunId({ branch: "run-b", timestamp: new Date("2026-04-12T10:05:01.000Z") });
  const runC = createRunId({ branch: "run-c", timestamp: new Date("2026-04-12T10:05:02.000Z") });

  for (const runId of [runA, runB, runC]) {
    writeRun(repoRoot, {
      runId,
      state: STATES.REVIEW_PENDING,
      rounds: 1,
      updatedAt: recentTs,
    });
  }

  setManifestDispatch(repoRoot, runA, {
    last_executor: "codex",
    last_model: "gpt-5",
    last_provider: "openai",
  });
  setManifestDispatch(repoRoot, runB, {
    last_executor: "claude",
    last_model: "claude-sonnet-4",
    last_provider: "anthropic",
  });
  setManifestDispatch(repoRoot, runC, {
    last_executor: "opencode",
    last_model: "openai/gpt-5",
    last_provider: "openai",
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json", "--by-dispatch"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.deepEqual(Object.keys(report.by_dispatch.executor).sort(), ["claude", "codex", "opencode"]);
  assert.equal(report.by_dispatch.executor.codex.totals.manifests, 1);
  assert.equal(report.by_dispatch.provider.openai.totals.manifests, 2);
  assert.equal(report.by_dispatch.provider.anthropic.totals.manifests, 1);
  assert.equal(report.by_dispatch.model["openai/gpt-5"].totals.manifests, 1);
});

test("reliability-report --by-dispatch buckets missing dispatch fields as unknown", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-report-by-dispatch-unknown-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot, "Relay Test");
  const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const runLegacy = createRunId({ branch: "run-legacy", timestamp: new Date("2026-04-12T10:10:00.000Z") });
  const runNullDispatch = createRunId({ branch: "run-null-dispatch", timestamp: new Date("2026-04-12T10:10:01.000Z") });

  writeRun(repoRoot, {
    runId: runLegacy,
    state: STATES.REVIEW_PENDING,
    rounds: 1,
    updatedAt: recentTs,
  });
  writeRun(repoRoot, {
    runId: runNullDispatch,
    state: STATES.REVIEW_PENDING,
    rounds: 1,
    updatedAt: recentTs,
  });
  setManifestDispatch(repoRoot, runLegacy, undefined);
  setManifestDispatch(repoRoot, runNullDispatch, {
    last_executor: null,
    last_model: null,
    last_provider: "",
  });

  const stdout = execFileSync("node", [SCRIPT, "--repo", repoRoot, "--json", "--by-dispatch"], { encoding: "utf-8" });
  const report = JSON.parse(stdout);

  assert.equal(report.by_dispatch.executor.unknown.totals.manifests, 2);
  assert.equal(report.by_dispatch.model.unknown.totals.manifests, 2);
  assert.equal(report.by_dispatch.provider.unknown.totals.manifests, 2);
  assert.equal(report.by_dispatch.executor.unknown.metrics.dispatch_timeout_rate, null);
  assert.equal(report.by_dispatch.executor.unknown.metrics.dispatch_failure_rate, null);
  assert.equal(report.by_dispatch.executor.unknown.metrics.recover_commit_rate, 0);
});

test("reliability-report --help mentions --by-dispatch", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--help"], {
    encoding: "utf-8",
    stdio: "pipe",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--by-dispatch/);
  assert.match(result.stdout, /executor\/model\/provider/);
});
