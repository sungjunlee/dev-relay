const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildReadinessDecision,
} = require("../../../skills/relay/scripts/run-preflight");

const {
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  updateManifestState,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay", "scripts", "run-preflight.js");

test("route decision treats bypass as ready_single without changing the bypass branch", () => {
  const decision = buildReadinessDecision({
    readiness_score: { clarity: "high", granularity: "high", verifiability: "high" },
    bypass: true,
    next_action: "proceed",
    signals_summary: "Ready: bypass conditions passed.",
    task_shape: { strength: "none", strong: false, signals: [] },
  }, { promptAllowed: false });

  assert.equal(decision.route_decision, "ready_single");
  assert.equal(decision.recommended_branch, "bypass");
  assert.equal(decision.branch_labels.bypass.action, "proceed_to_step_2");
});

test("route decision treats proceed without bypass as ready_light in non-interactive mode", () => {
  const decision = buildReadinessDecision({
    readiness_score: { clarity: "high", granularity: "high", verifiability: "high" },
    bypass: false,
    next_action: "proceed",
    signals_summary: "Not bypassed: next action proceed.",
    task_shape: { strength: "none", strong: false, signals: [] },
  }, { promptAllowed: false });

  assert.equal(decision.route_decision, "ready_light");
  assert.equal(decision.recommended_branch, "ready-light");
  assert.equal(decision.prompt_summary, null);
  assert.equal(decision.branch_labels["ready-light"].action, "proceed_to_step_2_light_planning");
});

test("route decision keeps high-risk proceed without bypass on readiness prompt path", () => {
  const decision = buildReadinessDecision({
    readiness_score: { clarity: "high", granularity: "high", verifiability: "high" },
    bypass: false,
    next_action: "proceed",
    signals_summary: "Gaps: high-risk keyword.",
    task_shape: { strength: "none", strong: false, signals: [] },
    risk: { high: true, signals: ["high_risk_keyword"] },
  }, { promptAllowed: false });

  assert.equal(decision.route_decision, "readiness_prompt");
  assert.equal(decision.recommended_branch, "noninteractive-fail");
  assert.equal(decision.branch_labels["noninteractive-fail"].event_payload.risk.high, true);
});

test("route decision keeps qa_needed on the existing prompt or noninteractive-fail path", () => {
  const interactive = buildReadinessDecision({
    readiness_score: { clarity: "medium", granularity: "medium", verifiability: "low" },
    bypass: false,
    next_action: "qa_needed",
    signals_summary: "Gaps: verifiability=low.",
    task_shape: { strength: "none", strong: false, signals: [] },
  }, { promptAllowed: true });
  const noninteractive = buildReadinessDecision({
    readiness_score: { clarity: "medium", granularity: "medium", verifiability: "low" },
    bypass: false,
    next_action: "qa_needed",
    signals_summary: "Gaps: verifiability=low.",
    task_shape: { strength: "none", strong: false, signals: [] },
  }, { promptAllowed: false });

  assert.equal(interactive.route_decision, "readiness_prompt");
  assert.equal(interactive.recommended_branch, "prompt");
  assert.equal(interactive.prompt_summary, "Gaps: verifiability=low.");
  assert.equal(noninteractive.route_decision, "readiness_prompt");
  assert.equal(noninteractive.recommended_branch, "noninteractive-fail");
});

test("route decision exposes needs_split for strong task-shape signals", () => {
  const decision = buildReadinessDecision({
    readiness_score: { clarity: "medium", granularity: "low", verifiability: "high" },
    bypass: false,
    next_action: "qa_needed",
    signals_summary: "Gaps: granularity=low, task-shape decomposition.",
    task_shape: {
      strength: "strong",
      strong: true,
      signals: [{ condition: "broad_scope_language", evidence: "foundation" }],
    },
  }, { promptAllowed: false });

  assert.equal(decision.route_decision, "needs_split");
  assert.equal(decision.recommended_branch, "noninteractive-fail");
  assert.equal(decision.branch_labels["noninteractive-fail"].event_payload.route_decision, "needs_split");
});

function setupReadyRun({ liveHead = "abc123", reviewedSha = "abc123", manifestHead = "abc123" } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-preflight-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");

  const runId = createRunId({
    branch: "issue-691",
    timestamp: new Date("2026-06-08T00:00:00.000Z"),
  });
  const { manifestPath } = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-691",
    baseBranch: "main",
    issueNumber: 691,
    worktreePath: repoRoot,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest.git.pr_number = 691;
  manifest.git.head_sha = manifestHead;
  manifest.anchor.rubric_path = "rubric.yaml";
  fs.writeFileSync(path.join(ensureRunLayout(repoRoot, runId).runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: ready drift\n", "utf-8");
  manifest.review = {
    ...(manifest.review || {}),
    rounds: 1,
    latest_verdict: "lgtm",
    last_reviewed_sha: reviewedSha,
  };
  manifest = updateManifestState(
    updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result"),
    STATES.REVIEW_PENDING,
    "run_review"
  );
  manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  writeManifest(manifestPath, manifest);

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-preflight-gh-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    number: 691,
    headRefName: "issue-691",
    headRefOid: ${JSON.stringify(liveHead)}
  }));
  process.exit(0);
}
process.stderr.write("unexpected gh args: " + args.join(" "));
process.exit(2);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);

  return { repoRoot, runId, manifestPath, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } };
}

function runReviewPreflight(fixture) {
  return JSON.parse(execFileSync("node", [
    SCRIPT,
    "--stage", "review",
    "--repo", fixture.repoRoot,
    "--run-id", fixture.runId,
    "--pr", "691",
    "--json",
  ], {
    encoding: "utf-8",
    env: fixture.env,
  }));
}

test("review preflight reports unchanged ready_to_merge PR as merge-ready", () => {
  const fixture = setupReadyRun({ liveHead: "abc123", reviewedSha: "abc123", manifestHead: "abc123" });

  const result = runReviewPreflight(fixture);

  assert.equal(result.snapshot.state, STATES.READY_TO_MERGE);
  assert.equal(result.ready_status.status, "merge_ready");
  assert.equal(result.ready_status.pr_number, 691);
  assert.equal(result.ready_status.old_sha, "abc123");
  assert.equal(result.ready_status.new_sha, "abc123");
  assert.equal(result.ready_status.next_action, "proceed_to_merge");
});

test("review preflight reports ready_to_merge PR with live HEAD drift as stale-ready", () => {
  const fixture = setupReadyRun({ liveHead: "def456", reviewedSha: "abc123", manifestHead: "abc123" });

  const result = runReviewPreflight(fixture);

  assert.equal(result.snapshot.state, STATES.READY_TO_MERGE);
  assert.equal(result.ready_status.status, "stale_ready");
  assert.equal(result.ready_status.pr_number, 691);
  assert.equal(result.ready_status.old_sha, "abc123");
  assert.equal(result.ready_status.new_sha, "def456");
  assert.equal(result.ready_status.reviewed_sha, "abc123");
  assert.equal(result.ready_status.manifest_head_sha, "abc123");
  assert.equal(result.ready_status.next_action, "recover_ready_to_review_pending_then_rerun_review");
});
