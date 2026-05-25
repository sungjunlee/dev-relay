const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
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
const { buildDefaultRelayPolicy } = require("../../../skills/relay-dispatch/scripts/relay-policy");
const { appendRunEvent, EVENTS, readRunEvents } = require("../../../skills/relay-dispatch/scripts/relay-events");
const {
  DEFAULT_ENFORCEMENT_RUBRIC,
  createEnforcementFixture,
} = require("../../../skills/relay-dispatch/scripts/test-support");
const { EXECUTION_EVIDENCE_FILENAME } = require("../../../skills/relay-review/scripts/review-runner/execution-evidence");
const { finishAdvisoryReview } = require("../../../skills/relay-review/scripts/review-runner/advisory");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "review-runner.js");

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

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

function passVerdict() {
  return {
    verdict: "pass",
    summary: "All done criteria are satisfied.",
    contract_status: "pass",
    quality_review_status: "pass",
    quality_execution_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: defaultRubricScores(),
    scope_drift: { creep: [], missing: [] },
  };
}

function changesRequestedVerdict() {
  return {
    ...passVerdict(),
    verdict: "changes_requested",
    summary: "One required fix remains.",
    contract_status: "fail",
    next_action: "changes_requested",
    issues: [{
      title: "Primary required fix",
      body: "Primary reviewer requested this change.",
      file: "README.md",
      line: 1,
      category: "contract",
      severity: "high",
    }],
  };
}

function setupRepo({
  reviewAssurance = "standard",
  strictEvidence = false,
  roles = { orchestrator: "codex", executor: "codex", reviewer: "codex" },
  modelPolicy = "allow-opencode-advisory",
} = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-advisory-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-advisory-origin-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  if (modelPolicy === "allow-opencode-advisory") {
    fs.writeFileSync(path.join(process.env.RELAY_HOME, "policy.json"), JSON.stringify({
      ...buildDefaultRelayPolicy(),
      profile: "allow-opencode-advisory",
      managed_cli: ["codex", "claude", "mirror"],
      allowed_model_routes: [{
        route: "opencode-go/*",
        phases: ["advisory_review"],
        reviewers: ["opencode"],
      }, {
        route: "mirror/*",
        phases: ["review"],
        reviewers: ["mirror"],
      }],
    }, null, 2), "utf-8");
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["init", "--bare", remoteRoot], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review Advisory Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteRoot], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const runId = "issue-429-20260505010000000";
  const worktreePath = path.join(repoRoot, "wt", "issue-429");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", "issue-429"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const headSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();
  const { manifestPath, runDir } = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-429",
    baseBranch: "main",
    issueNumber: 429,
    worktreePath,
    orchestrator: roles.orchestrator,
    executor: roles.executor,
    reviewer: roles.reviewer,
    reviewAssurance,
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest.anchor = createEnforcementFixture({
    repoRoot,
    runId,
    state: "loaded",
    rubricContent: DEFAULT_ENFORCEMENT_RUBRIC,
  }).anchor;
  manifest = { ...manifest, git: { ...(manifest.git || {}), pr_number: 429, head_sha: headSha } };
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  writeManifest(manifestPath, manifest);
  fs.writeFileSync(path.join(runDir, EXECUTION_EVIDENCE_FILENAME), `${JSON.stringify({
    schema_version: 1,
    head_sha: headSha,
    test_command: "node --test",
    test_result_hash: strictEvidence ? "a".repeat(64) : "unspecified",
    test_result_summary: "pass",
    ...(strictEvidence ? { test_exit_code: 0 } : {}),
    recorded_at: "2026-05-05T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  }, null, 2)}\n`, "utf-8");
  const doneCriteriaPath = path.join(repoRoot, "done-criteria.md");
  const diffPath = path.join(repoRoot, "pr.diff");
  fs.writeFileSync(doneCriteriaPath, "# Done Criteria\n\n- Add advisory lane\n", "utf-8");
  fs.writeFileSync(diffPath, "diff --git a/README.md b/README.md\n+advisory\n", "utf-8");
  return { repoRoot, manifestPath, runDir, runId, doneCriteriaPath, diffPath };
}

function writePrimaryReviewer(repoRoot, verdict, { logPath = null, delayMs = 0 } = {}) {
  const filePath = path.join(repoRoot, "primary-reviewer.js");
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require("fs");
const logPath = ${JSON.stringify(logPath)};
if (logPath) fs.appendFileSync(logPath, "primary-start " + Date.now() + "\\n");
setTimeout(() => {
  if (logPath) fs.appendFileSync(logPath, "primary-end " + Date.now() + "\\n");
  process.stdout.write(${JSON.stringify(JSON.stringify(verdict))});
}, ${Number(delayMs)});
`, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeFakeOpencode(repoRoot, { delayMs = 0, logPath = null, invalidJson = false, mutate = false, requiredFinding = false } = {}) {
  const filePath = path.join(repoRoot, "fake-opencode.js");
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const logPath = ${JSON.stringify(logPath)};
if (logPath) fs.appendFileSync(logPath, "advisory-start " + Date.now() + "\\n");
if (${mutate ? "true" : "false"}) fs.writeFileSync(path.join(process.cwd(), "advisory-mutated.txt"), "bad\\n", "utf-8");
setTimeout(() => {
  if (${invalidJson ? "true" : "false"}) {
    process.stdout.write("not json");
  } else {
    process.stdout.write(JSON.stringify({
      profile: "blindspot",
      summary: "One advisory blind spot.",
      required_findings: ${requiredFinding ? `[{ title: "Required hardened fix", body: "Must fix before merge.", file: "README.md", line: 1, severity: "P2", category: "bypass", confidence: 0.9 }]` : "[]"},
      advisory_findings: [{
        title: "Advisory-only test gap",
        body: "This should be recorded but not merged into primary redispatch.",
        file: "README.md",
        line: 1,
        severity: "P3",
        category: "test-gap",
        confidence: 0.8
      }],
      duplicate_or_low_confidence: []
    }));
  }
  if (logPath) fs.appendFileSync(logPath, "advisory-end " + Date.now() + "\\n");
}, ${Number(delayMs)});
`, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function waitForEvent(repoRoot, runId, predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = readRunEvents(repoRoot, runId).find(predicate);
    if (event) return event;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return null;
}

function runReview({
  repoRoot,
  runId,
  doneCriteriaPath,
  diffPath,
  primaryScript,
  opencodeScript,
  advisoryReviewer = "opencode",
  reviewer = "codex",
  extraArgs = [],
}) {
  return JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer", reviewer,
    "--reviewer-script", primaryScript,
    ...(advisoryReviewer ? ["--advisory-reviewer", advisoryReviewer] : []),
    "--no-comment",
    "--json",
    ...extraArgs,
  ], {
    encoding: "utf-8",
    env: { ...process.env, RELAY_OPENCODE_BIN: opencodeScript },
  }));
}

test("review-runner records successful opencode advisory review without gating primary pass", () => {
  const { repoRoot, manifestPath, runDir, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot);

  const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript });
  const manifest = readManifest(manifestPath).data;
  const event = readRunEvents(repoRoot, runId).find((record) => record.event === "advisory_review");

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.status, "success");
  assert.equal(result.advisoryReview.advisory_count, 1);
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.ok(fs.existsSync(path.join(runDir, "review-round-1-advisory-opencode.json")));
  assert.equal(event.status, "success");
  assert.equal(event.profile, "blindspot");
  assert.equal(event.advisory_artifact_hash, hashFile(path.join(runDir, "review-round-1-advisory-opencode.json")));
  assert.equal(event.reviewer_policy.read_only.enforcement_level, "prompt-only");
  assert.match(event.reviewer_policy.read_only.warnings.join("\n"), /not prevent writes/i);
});

test("review-runner uses manifest routing advisory defaults without changing the primary reviewer", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  writeManifest(manifestPath, {
    ...record.data,
    routing: {
      version: 1,
      selected: {
        advisory_review: { reviewer: "opencode", profile: "blindspot" },
        sidecar: { kind: "docs-sync", executor: "opencode" },
      },
    },
  }, record.body);
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot);

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    advisoryReviewer: null,
  });
  const manifest = readManifest(manifestPath).data;

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.reviewer, "codex");
  assert.equal(result.advisoryReview.reviewer, "opencode");
  assert.equal(result.advisoryReview.source, "routing");
  assert.equal(manifest.review.last_reviewer, "codex");
  assert.deepEqual(manifest.roles, { orchestrator: "codex", executor: "codex", reviewer: "codex" });
});

test("review-runner denies disallowed advisory model before spawning advisory reviewer", () => {
  const { repoRoot, runId, doneCriteriaPath, diffPath } = setupRepo({ modelPolicy: "default" });
  const logPath = path.join(repoRoot, "advisory-policy.log");
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { logPath });

  assert.throws(
    () => runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript }),
    /phase=advisory_review.*reviewer=opencode|reviewer=opencode.*phase=advisory_review/
  );
  assert.equal(fs.existsSync(logPath), false);
});

test("prepare-only with advisory flags writes only the primary prompt bundle", () => {
  const { repoRoot, runDir, runId, doneCriteriaPath, diffPath } = setupRepo();

  const result = JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--advisory-reviewer", "opencode",
    "--prepare-only",
    "--json",
  ], {
    encoding: "utf-8",
    env: { ...process.env, RELAY_OPENCODE_BIN: path.join(repoRoot, "missing-opencode") },
  }));

  assert.equal(result.prepareOnly, true);
  assert.equal(result.advisoryReview, undefined);
  assert.equal(fs.existsSync(path.join(runDir, "review-round-1-advisory-opencode-prompt.md")), false);
  assert.equal(fs.existsSync(path.join(runDir, "advisory-worktrees")), false);
  assert.equal(readRunEvents(repoRoot, runId).some((record) => record.event === "advisory_review"), false);
});

test("advisory review is scheduled before the primary reviewer completes", () => {
  const { repoRoot, runDir, runId, doneCriteriaPath, diffPath } = setupRepo();
  const logPath = path.join(repoRoot, "review-order.log");
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict(), { logPath, delayMs: 1500 });
  const opencodeScript = writeFakeOpencode(repoRoot, { logPath });

  runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript });
  const lines = fs.readFileSync(logPath, "utf-8").trim().split(/\n/);
  const primaryEnd = Number(lines.find((line) => line.startsWith("primary-end")).split(" ")[1]);
  const request = JSON.parse(fs.readFileSync(
    path.join(runDir, "review-round-1-advisory-opencode-request.json"),
    "utf-8"
  ));

  assert.ok(lines.some((line) => line.startsWith("primary-end")));
  assert.ok(request.startedAt < primaryEnd);
});

test("standard review applies the primary verdict after advisory grace and records late advisory as metrics-only", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { delayMs: 3000 });

  const startedAt = Date.now();
  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    extraArgs: ["--advisory-grace", "0.05"],
  });
  const reviewElapsedMs = Date.now() - startedAt;

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(readManifest(manifestPath).data.state, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.status, "deferred");
  assert.ok(reviewElapsedMs < 4500, `review should return before late advisory completes, elapsed=${reviewElapsedMs}ms`);

  const event = waitForEvent(repoRoot, runId, (record) => record.event === "advisory_review", { timeoutMs: 7000 });
  assert.ok(event, "late advisory event should be attached to the run");
  assert.equal(event.status, "success");
  assert.equal(event.consumed_by_phase, "metrics");
  assert.equal(event.phase_decision_waited, true);
  assert.equal(event.frontier_step_replaced, false);
  assert.ok(event.elapsed_ms >= 3000);
  assert.ok(event.critical_path_wait_ms <= 75);
});

test("standard review applies the primary verdict when advisory times out during grace", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { delayMs: 1500 });

  const result = runReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    primaryScript,
    opencodeScript,
    extraArgs: ["--advisory-timeout", "1", "--advisory-grace", "2"],
  });
  const event = readRunEvents(repoRoot, runId).find((record) => record.event === "advisory_review");

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(readManifest(manifestPath).data.state, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.status, "timeout");
  assert.match(result.advisoryReview.failureReason, /exceeded 1s timeout/);
  assert.equal(event.status, "timeout");
  assert.equal(event.consumed_by_phase, "review");
});

test("hardened advisory finish does not expose success before event provenance is written", async () => {
  const { repoRoot, manifestPath, runDir, runId } = setupRepo({
    reviewAssurance: "hardened",
    strictEvidence: true,
  });
  const manifest = readManifest(manifestPath).data;
  const artifactPath = path.join(runDir, "review-round-1-advisory-opencode.json");
  const resultPath = path.join(runDir, "review-round-1-advisory-opencode-result.json");
  fs.writeFileSync(artifactPath, `${JSON.stringify({
    profile: "blindspot",
    summary: "No required findings.",
    required_findings: [],
    advisory_findings: [{
      title: "Advisory note",
      body: "Recorded after the primary path.",
      file: "README.md",
      line: 1,
      severity: "P3",
      category: "test-gap",
      confidence: 0.8,
    }],
    duplicate_or_low_confidence: [],
  }, null, 2)}\n`, "utf-8");
  const result = {
    artifactHash: hashFile(artifactPath),
    artifactPath,
    advisory_count: 1,
    duplicate_low_confidence_count: 0,
    failureReason: null,
    profile: "blindspot",
    rawResponsePath: null,
    required_count: 0,
    reviewer: "opencode",
    status: "success",
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");

  const advisoryRun = {
    headSha: manifest.git.head_sha,
    profile: "blindspot",
    resultPath,
    reviewerName: "opencode",
    round: 1,
    runId,
    runRepoPath: repoRoot,
    startedAt: Date.now(),
  };
  const unbound = await finishAdvisoryReview({
    advisoryRun,
    requireEventBoundSuccess: true,
    waitMs: 0,
  });

  assert.equal(unbound.status, "failed");
  assert.match(unbound.failureReason, /not bound to a successful advisory_review event/);

  appendRunEvent(repoRoot, runId, {
    event: EVENTS.ADVISORY_REVIEW,
    state_from: STATES.REVIEW_PENDING,
    state_to: STATES.REVIEW_PENDING,
    head_sha: manifest.git.head_sha,
    round: 1,
    reviewer: "opencode",
    profile: "blindspot",
    status: "success",
    artifact_path: artifactPath,
    advisory_artifact_hash: result.artifactHash,
    raw_response_path: null,
    failure_reason: null,
    required_count: 0,
    advisory_count: 1,
    duplicate_low_confidence_count: 0,
  });
  const bound = await finishAdvisoryReview({
    advisoryRun,
    requireEventBoundSuccess: true,
    waitMs: 0,
  });

  assert.equal(bound.status, "success");
});

test("invalid advisory JSON is recorded as advisory failure while primary pass still applies", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { invalidJson: true });

  const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript });
  const event = readRunEvents(repoRoot, runId).find((record) => record.event === "advisory_review");

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(readManifest(manifestPath).data.state, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.status, "failed");
  assert.match(result.advisoryReview.failureReason, /valid JSON|exited with code 1/);
  assert.equal(event.status, "failed");
});

test("advisory worktree mutation is captured without escalating the manifest", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot, { mutate: true });

  const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript });
  const event = readRunEvents(repoRoot, runId).find((record) => record.event === "advisory_review");

  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(readManifest(manifestPath).data.state, STATES.READY_TO_MERGE);
  assert.equal(result.advisoryReview.status, "policy_violation");
  assert.match(event.artifact_path, /policy-violation\.txt$/);
});

test("advisory findings do not alter primary redispatch output", () => {
  const { repoRoot, runId, doneCriteriaPath, diffPath } = setupRepo();
  const primaryScript = writePrimaryReviewer(repoRoot, changesRequestedVerdict());
  const opencodeScript = writeFakeOpencode(repoRoot);

  const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript });
  const redispatch = fs.readFileSync(result.redispatchPath, "utf-8");

  assert.equal(result.nextState, STATES.CHANGES_REQUESTED);
  assert.match(redispatch, /Primary required fix/);
  assert.doesNotMatch(redispatch, /Advisory-only test gap/);
});

test("hardened review assurance blocks a primary pass without advisory evidence", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo({
    reviewAssurance: "hardened",
    strictEvidence: true,
  });
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());

  assert.throws(
    () => execFileSync("node", [
      SCRIPT,
      "--repo", repoRoot,
      "--run-id", runId,
      "--pr", "429",
      "--done-criteria-file", doneCriteriaPath,
      "--diff-file", diffPath,
      "--reviewer", "codex",
      "--reviewer-script", primaryScript,
      "--no-comment",
      "--json",
    ], { encoding: "utf-8" }),
    /policy\.review_assurance=hardened requires --advisory-reviewer/
  );

  assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING);
});

test("hardened assurance is generic for Codex-only and non-Codex role bindings", async (t) => {
  for (const entry of [
    {
      label: "codex-only",
      roles: { orchestrator: "codex", executor: "codex", reviewer: "codex" },
      reviewer: "codex",
    },
    {
      label: "non-codex-fixture",
      roles: { orchestrator: "atlas", executor: "forge", reviewer: "mirror" },
      reviewer: "mirror",
      extraArgs: ["--reviewer-model", "mirror/local-reviewer"],
    },
  ]) {
    await t.test(entry.label, () => {
      const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo({
        reviewAssurance: "hardened",
        strictEvidence: true,
        roles: entry.roles,
      });
      const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
      const opencodeScript = writeFakeOpencode(repoRoot);

      const result = runReview({
        repoRoot,
        runId,
        doneCriteriaPath,
        diffPath,
        primaryScript,
        opencodeScript,
        reviewer: entry.reviewer,
        extraArgs: entry.extraArgs || [],
      });
      const manifest = readManifest(manifestPath).data;

      assert.equal(result.nextState, STATES.READY_TO_MERGE);
      assert.equal(manifest.state, STATES.READY_TO_MERGE);
      assert.deepEqual(manifest.roles, entry.roles);
      assert.equal(manifest.policy.review_assurance, "hardened");
      assert.equal(manifest.review.last_reviewer, entry.reviewer);
    });
  }
});

test("Codex-only assurance regression is documented as generic policy coverage", () => {
  const notes = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "skills", "relay-review", "references", "runner-notes.md"),
    "utf-8"
  );

  assert.match(notes, /Codex-only operation regression/i);
  assert.match(notes, /policy\.review_assurance=hardened/i);
  assert.match(notes, /not a Codex-only policy special case/i);
});

test("production assurance code does not branch on Codex executor and reviewer identity", () => {
  const productionFiles = [
    "skills/relay-review/scripts/review-runner.js",
    "skills/relay-review/scripts/review-runner/assurance.js",
    "skills/relay-merge/scripts/review-gate.js",
    "skills/relay-merge/scripts/gate-check.js",
    "skills/relay-merge/scripts/finalize-run.js",
    "skills/relay-dispatch/scripts/relay-manifest.js",
    "skills/relay-dispatch/scripts/manifest/store.js",
  ];

  const forbiddenBranch = new RegExp([
    String.raw`(?:executor|roles\.executor)[\s\S]{0,80}(?:["']codex["'])`,
    String.raw`[\s\S]{0,160}(?:reviewer|roles\.reviewer)[\s\S]{0,80}(?:["']codex["'])`,
    "|",
    String.raw`(?:reviewer|roles\.reviewer)[\s\S]{0,80}(?:["']codex["'])`,
    String.raw`[\s\S]{0,160}(?:executor|roles\.executor)[\s\S]{0,80}(?:["']codex["'])`,
  ].join(""), "i");

  for (const relativePath of productionFiles) {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", relativePath), "utf-8");
    assert.doesNotMatch(source, forbiddenBranch, relativePath);
  }
});

test("hardened review assurance blocks advisory failures and required findings", async (t) => {
  for (const entry of [
    { label: "invalid json", options: { invalidJson: true }, expected: /Hardened advisory review did not complete successfully/ },
    { label: "required finding", options: { requiredFinding: true }, expected: /Hardened advisory review reported required findings/ },
  ]) {
    await t.test(entry.label, () => {
      const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo({
        reviewAssurance: "hardened",
        strictEvidence: true,
      });
      const primaryScript = writePrimaryReviewer(repoRoot, passVerdict());
      const opencodeScript = writeFakeOpencode(repoRoot, entry.options);

      const result = runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript });

      assert.equal(result.nextState, STATES.CHANGES_REQUESTED);
      assert.equal(readManifest(manifestPath).data.state, STATES.CHANGES_REQUESTED);
      assert.match(fs.readFileSync(result.verdictPath, "utf-8"), entry.expected);
    });
  }
});

test("hardened manual review pass requires an audit reason", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo({
    reviewAssurance: "hardened",
    strictEvidence: true,
  });
  const reviewFile = path.join(repoRoot, "manual-verdict.json");
  fs.writeFileSync(reviewFile, JSON.stringify(passVerdict()), "utf-8");
  const opencodeScript = writeFakeOpencode(repoRoot);

  const result = JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--advisory-reviewer", "opencode",
    "--no-comment",
    "--json",
  ], {
    encoding: "utf-8",
    env: { ...process.env, RELAY_OPENCODE_BIN: opencodeScript },
  }));

  assert.equal(result.nextState, STATES.CHANGES_REQUESTED);
  assert.equal(readManifest(manifestPath).data.state, STATES.CHANGES_REQUESTED);
  assert.match(fs.readFileSync(result.verdictPath, "utf-8"), /Manual review verdict requires an audit reason/);
});
