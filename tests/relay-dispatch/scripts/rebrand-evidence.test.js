// canary: bare-string `event === "..."` reader assertions in this file are deliberate canaries against EVENTS schema drift; do not port to EVENTS.X (see #313).
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
  updateManifestState,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { readRunEvents } = require("../../../skills/relay-dispatch/scripts/relay-events");
const {
  COMMAND_FLAGS,
} = require("../../../skills/relay-dispatch/scripts/cli-schema");
const {
  EXECUTION_EVIDENCE_FILENAME,
  writeExecutionEvidence,
} = require("../../../skills/relay-dispatch/scripts/execution-evidence");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "rebrand-evidence.js");

function setupRepo({ evidence = true, advanceHead = false } = {}) {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-rebrand-evidence-")));
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-")));
  process.env.RELAY_HOME = relayHome;

  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Rebrand Evidence Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-rebrand@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const branch = "issue-332";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const originalSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

  if (advanceHead) {
    fs.writeFileSync(path.join(worktreePath, "correction.txt"), "orchestrator correction\n", "utf-8");
    execFileSync("git", ["-C", worktreePath, "add", "correction.txt"], { encoding: "utf-8", stdio: "pipe" });
    execFileSync("git", ["-C", worktreePath, "commit", "-m", "Orchestrator correction"], { encoding: "utf-8", stdio: "pipe" });
  }
  const currentSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

  const runId = createRunId({
    issueNumber: 332,
    branch,
    timestamp: new Date("2026-04-24T01:00:00.000Z"),
  });
  const layout = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 332,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  fs.writeFileSync(path.join(layout.runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: rebrand-evidence\n", "utf-8");
  manifest.anchor.rubric_path = "rubric.yaml";
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  writeManifest(layout.manifestPath, manifest);

  if (evidence) {
    writeExecutionEvidence(layout.runDir, {
      schema_version: 1,
      head_sha: originalSha,
      test_command: "node --test tests/relay-dispatch/scripts/*.test.js",
      test_result_hash: "unspecified",
      test_result_summary: "unspecified",
      recorded_at: "2026-04-24T01:00:00.000Z",
      recorded_by: "dispatch-orchestrator-v1",
    });
  }

  const env = {
    ...process.env,
    RELAY_HOME: relayHome,
  };
  return { repoRoot, relayHome, runId, manifestPath: layout.manifestPath, runDir: layout.runDir, worktreePath, branch, originalSha, currentSha, env };
}

function runRebrand(fixture, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, "--repo", fixture.repoRoot, "--run-id", fixture.runId, ...extraArgs], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    env: fixture.env,
  });
}

function readEvidence(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME), "utf-8"));
}

test("rebrand-evidence flags are registered with the CLI schema", () => {
  assert.deepEqual(COMMAND_FLAGS["rebrand-evidence"], [
    "--repo", "--run-id", "--manifest", "--reason", "--dry-run", "--json", "--help",
  ]);
});

test("happy path rewrites stale evidence to current HEAD and emits one audit event", () => {
  const fixture = setupRepo({ evidence: true, advanceHead: true });
  const result = runRebrand(fixture, ["--reason", "orchestrator fixed typo", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.rewritten, true);
  assert.equal(parsed.previousSha, fixture.originalSha);
  assert.equal(parsed.newHeadSha, fixture.currentSha);

  const evidence = readEvidence(fixture);
  assert.equal(evidence.head_sha, fixture.currentSha);
  assert.equal(evidence.recorded_by, "orchestrator-correction-rebrand");
  assert.equal(evidence.rebrand.previous_head_sha, fixture.originalSha);
  assert.equal(evidence.rebrand.reason, "orchestrator fixed typo");

  const rebrandEvents = readRunEvents(fixture.repoRoot, fixture.runId)
    .filter((entry) => entry.event === "execution_evidence_rebranded");
  assert.equal(rebrandEvents.length, 1);
  assert.equal(rebrandEvents[0].previous_head_sha, fixture.originalSha);
  assert.equal(rebrandEvents[0].new_head_sha, fixture.currentSha);
  assert.equal(rebrandEvents[0].reason, "orchestrator fixed typo");
  assert.equal(rebrandEvents[0].override_class, "execution_evidence_rebrand");
  assert.equal(rebrandEvents[0].affected_head_sha, fixture.currentSha);
  assert.equal(rebrandEvents[0].prior_state, STATES.REVIEW_PENDING);
  assert.equal(rebrandEvents[0].required_reason, "orchestrator fixed typo");
  assert.equal(rebrandEvents[0].operator_initiated, true);
});

test("sha_unchanged exits zero and does not append an event", () => {
  const fixture = setupRepo({ evidence: true, advanceHead: false });
  const beforeEvidence = fs.readFileSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME), "utf-8");
  const result = runRebrand(fixture, ["--reason", "already current", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.skipped, "sha_unchanged");
  assert.equal(fs.readFileSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME), "utf-8"), beforeEvidence);
  assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
});

test("no_existing_evidence exits zero without creating evidence", () => {
  const fixture = setupRepo({ evidence: false, advanceHead: true });
  const result = runRebrand(fixture, ["--reason", "missing historical evidence", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.skipped, "no_existing_evidence");
  assert.equal(fs.existsSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME)), false);
  assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
});

test("missing --reason exits non-zero with a usage hint", () => {
  const fixture = setupRepo({ evidence: true, advanceHead: true });
  const result = runRebrand(fixture, ["--json"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--reason <text> is required/);
  assert.match(result.stderr, /--help/);
  assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
});

test("missing both --run-id and --manifest exits non-zero", () => {
  const fixture = setupRepo({ evidence: true, advanceHead: true });
  const result = spawnSync(process.execPath, [SCRIPT, "--repo", fixture.repoRoot, "--reason", "missing selector", "--json"], {
    cwd: fixture.repoRoot,
    encoding: "utf-8",
    env: fixture.env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Either --run-id or --manifest is required/);
  assert.match(result.stderr, /--help/);
});

test("dry-run previews the rebrand without writing evidence or appending an event", () => {
  const fixture = setupRepo({ evidence: true, advanceHead: true });
  const beforeEvidence = fs.readFileSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME), "utf-8");
  const result = runRebrand(fixture, ["--reason", "preview only", "--dry-run", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "dry_run");
  assert.equal(parsed.plannedMutation.previousHeadSha, fixture.originalSha);
  assert.equal(parsed.plannedMutation.newHeadSha, fixture.currentSha);
  assert.equal(parsed.plannedMutation.recordedBy, "orchestrator-correction-rebrand");
  assert.equal(fs.readFileSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME), "utf-8"), beforeEvidence);
  assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
});
