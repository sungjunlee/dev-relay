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
  EXECUTION_EVIDENCE_FILENAME,
  writeExecutionEvidence,
} = require("../../../skills/relay-dispatch/scripts/execution-evidence");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "rebrand-evidence.js");

function setupRepo({ evidence = true, advanceHead = false, withOrigin = false, branchWork = false } = {}) {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-rebrand-evidence-")));
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-")));
  process.env.RELAY_HOME = relayHome;

  let originRoot = null;
  if (withOrigin) {
    originRoot = path.join(repoRoot, "origin.git");
    execFileSync("git", ["init", "--bare", originRoot], { encoding: "utf-8", stdio: "pipe" });
  }

  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Rebrand Evidence Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-rebrand@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  if (withOrigin) {
    execFileSync("git", ["remote", "add", "origin", originRoot], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  }
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  if (withOrigin) {
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
    // Pin bare-origin HEAD so clones check out `main` even when the runner's
    // git init default branch is not main (CI runners often leave HEAD on master).
    execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
      cwd: originRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
    execFileSync("git", ["remote", "set-head", "origin", "main"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
  }

  const branch = "issue-332";
  const worktreePath = path.join(repoRoot, "wt", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  const originalSha = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

  if (branchWork || advanceHead) {
    const fileName = advanceHead ? "correction.txt" : "feature.txt";
    const contents = advanceHead ? "orchestrator correction\n" : "branch work\n";
    const message = advanceHead ? "Orchestrator correction" : "Branch work";
    fs.writeFileSync(path.join(worktreePath, fileName), contents, "utf-8");
    execFileSync("git", ["-C", worktreePath, "add", fileName], { encoding: "utf-8", stdio: "pipe" });
    execFileSync("git", ["-C", worktreePath, "commit", "-m", message], { encoding: "utf-8", stdio: "pipe" });
  }
  if (withOrigin) {
    execFileSync("git", ["-C", worktreePath, "push", "-u", "origin", branch], { encoding: "utf-8", stdio: "pipe" });
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
  return { repoRoot, originRoot, relayHome, runId, manifestPath: layout.manifestPath, runDir: layout.runDir, worktreePath, branch, originalSha, currentSha, env };
}

function advanceBaseOnOrigin(fixture, { conflicting = false } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "relay-rebrand-base-"));
  execFileSync("git", ["clone", fixture.originRoot, scratch], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["checkout", "-B", "main"], { cwd: scratch, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Rebrand Base"], { cwd: scratch, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-rebrand-base@example.com"], { cwd: scratch, encoding: "utf-8", stdio: "pipe" });
  const fileName = conflicting ? "feature.txt" : "base-advance.txt";
  const contents = conflicting ? "base side conflict\n" : "base advanced\n";
  fs.writeFileSync(path.join(scratch, fileName), contents, "utf-8");
  execFileSync("git", ["add", fileName], { cwd: scratch, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "advance base"], { cwd: scratch, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["push", "origin", "main"], { cwd: scratch, encoding: "utf-8", stdio: "pipe" });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: scratch, encoding: "utf-8" }).trim();
  return { scratch, baseSha };
}

function originBranchSha(fixture, branch) {
  return execFileSync("git", ["--git-dir", fixture.originRoot, "rev-parse", `refs/heads/${branch}`], {
    encoding: "utf-8",
  }).trim();
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
  assert.match(fs.readFileSync(SCRIPT, "utf-8"), /const CLI_ARG_OPTIONS = \{/);
  assert.match(fs.readFileSync(SCRIPT, "utf-8"), /reservedFlags:/);
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

test("blank --reason exits before rewriting evidence", () => {
  const fixture = setupRepo({ evidence: true, advanceHead: true });
  const beforeEvidence = readEvidence(fixture);
  const result = runRebrand(fixture, ["--reason", "   ", "--json"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--reason (?:<text> is required|requires a non-empty value)/);
  assert.deepEqual(readEvidence(fixture), beforeEvidence);
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

test("flagless rebrand remains byte-identical to the pre-rebase-onto-base contract", () => {
  const fixture = setupRepo({ evidence: true, advanceHead: true });
  const result = runRebrand(fixture, ["--reason", "orchestrator fixed typo", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "rebranded");
  assert.equal(parsed.rewritten, true);
  assert.equal(parsed.previousSha, fixture.originalSha);
  assert.equal(parsed.newHeadSha, fixture.currentSha);
  assert.equal(parsed.rebaseOntoBase, undefined);
  assert.equal(parsed.oldHeadSha, undefined);
  assert.equal(parsed.base, undefined);

  const evidence = readEvidence(fixture);
  assert.equal(evidence.head_sha, fixture.currentSha);
  assert.equal(evidence.recorded_by, "orchestrator-correction-rebrand");
  assert.equal(evidence.rebrand.reason, "orchestrator fixed typo");
});

test("--rebase-onto-base rebases, force-with-lease pushes, and rebrands in one shot", () => {
  const fixture = setupRepo({ evidence: true, withOrigin: true, branchWork: true });
  const beforeEvidence = readEvidence(fixture);
  assert.equal(beforeEvidence.head_sha, fixture.originalSha);
  const remoteBefore = originBranchSha(fixture, fixture.branch);
  assert.equal(remoteBefore, fixture.currentSha);

  advanceBaseOnOrigin(fixture);
  const reason = `rebase onto origin/main after base advance`;
  const result = runRebrand(fixture, ["--rebase-onto-base", "--reason", reason, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "rebranded");
  assert.equal(parsed.rebaseOntoBase, true);
  assert.equal(parsed.oldHeadSha, fixture.currentSha);
  assert.equal(parsed.base, "origin/main");
  assert.notEqual(parsed.newHeadSha, fixture.currentSha);
  assert.equal(parsed.rewritten, true);
  assert.equal(parsed.previousSha, fixture.originalSha);
  assert.equal(parsed.newHeadSha, parsed.newHeadSha);

  const worktreeHead = execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  assert.equal(worktreeHead, parsed.newHeadSha);
  assert.equal(originBranchSha(fixture, fixture.branch), parsed.newHeadSha);
  assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "status", "--porcelain"], { encoding: "utf-8" }).trim(), "");

  const evidence = readEvidence(fixture);
  assert.equal(evidence.head_sha, parsed.newHeadSha);
  assert.equal(evidence.rebrand.reason, reason);

  const rebrandEvents = readRunEvents(fixture.repoRoot, fixture.runId)
    .filter((entry) => entry.event === "execution_evidence_rebranded");
  assert.equal(rebrandEvents.length, 1);
  assert.equal(rebrandEvents[0].reason, reason);
  assert.equal(rebrandEvents[0].new_head_sha, parsed.newHeadSha);
});

test("--rebase-onto-base aborts on conflict without push or rebrand", () => {
  const fixture = setupRepo({ evidence: true, withOrigin: true, branchWork: true });
  const beforeEvidence = fs.readFileSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME), "utf-8");
  const remoteBefore = originBranchSha(fixture, fixture.branch);

  advanceBaseOnOrigin(fixture, { conflicting: true });
  const result = runRebrand(fixture, [
    "--rebase-onto-base",
    "--reason", "rebase onto origin/main after base advance",
    "--json",
  ]);

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.failure_class, "rebase_conflict");
  assert.equal(parsed.next_action, "resolve_rebase_manually");
  assert.equal(parsed.oldHeadSha, fixture.currentSha);
  assert.equal(parsed.newHeadSha, fixture.currentSha);
  assert.equal(parsed.headRestored, true);
  assert.equal(parsed.worktreeClean, true);
  assert.equal(parsed.pushed, false);
  assert.equal(parsed.rebranded, false);

  const worktreeHead = execFileSync("git", ["-C", fixture.worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  assert.equal(worktreeHead, fixture.currentSha);
  assert.equal(execFileSync("git", ["-C", fixture.worktreePath, "status", "--porcelain"], { encoding: "utf-8" }).trim(), "");
  assert.equal(originBranchSha(fixture, fixture.branch), remoteBefore);
  assert.equal(fs.readFileSync(path.join(fixture.runDir, EXECUTION_EVIDENCE_FILENAME), "utf-8"), beforeEvidence);
  assert.equal(readRunEvents(fixture.repoRoot, fixture.runId).length, 0);
});
