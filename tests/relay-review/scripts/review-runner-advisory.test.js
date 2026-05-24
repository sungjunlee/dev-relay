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
const { readRunEvents } = require("../../../skills/relay-dispatch/scripts/relay-events");
const {
  DEFAULT_ENFORCEMENT_RUBRIC,
  createEnforcementFixture,
} = require("../../../skills/relay-dispatch/scripts/test-support");
const { EXECUTION_EVIDENCE_FILENAME } = require("../../../skills/relay-review/scripts/review-runner/execution-evidence");

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

function setupRepo({ reviewAssurance = "standard", strictEvidence = false } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-advisory-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-advisory-origin-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
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
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
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

function writeFakeOpencode(repoRoot, { logPath = null, invalidJson = false, mutate = false, requiredFinding = false } = {}) {
  const filePath = path.join(repoRoot, "fake-opencode.js");
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const logPath = ${JSON.stringify(logPath)};
if (logPath) fs.appendFileSync(logPath, "advisory-start " + Date.now() + "\\n");
if (${mutate ? "true" : "false"}) fs.writeFileSync(path.join(process.cwd(), "advisory-mutated.txt"), "bad\\n", "utf-8");
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
`, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript, extraArgs = [] }) {
  return JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "429",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer", "codex",
    "--reviewer-script", primaryScript,
    "--advisory-reviewer", "opencode",
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

test("advisory review starts before the primary reviewer completes", () => {
  const { repoRoot, runId, doneCriteriaPath, diffPath } = setupRepo();
  const logPath = path.join(repoRoot, "review-order.log");
  const primaryScript = writePrimaryReviewer(repoRoot, passVerdict(), { logPath, delayMs: 1500 });
  const opencodeScript = writeFakeOpencode(repoRoot, { logPath });

  runReview({ repoRoot, runId, doneCriteriaPath, diffPath, primaryScript, opencodeScript });
  const lines = fs.readFileSync(logPath, "utf-8").trim().split(/\n/).map((line) => line.split(" ")[0]);

  assert.ok(lines.indexOf("advisory-start") !== -1);
  assert.ok(lines.indexOf("primary-end") !== -1);
  assert.ok(lines.indexOf("advisory-start") < lines.indexOf("primary-end"));
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
