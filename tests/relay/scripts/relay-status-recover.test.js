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
  updateManifestState,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { selectIssueRuns } = require("../../../skills/relay/scripts/relay-status");
const { planFor } = require("../../../skills/relay/scripts/relay-recover");

function setupRepo() {
  const previousRelayHome = process.env.RELAY_HOME;
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-status-repo-")));
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-status-home-")));
  process.env.RELAY_HOME = relayHome;
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Status Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-status@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return {
    repoRoot,
    relayHome,
    restore() {
      if (previousRelayHome === undefined) delete process.env.RELAY_HOME;
      else process.env.RELAY_HOME = previousRelayHome;
    },
  };
}

function writeRun(fixture, { issueNumber = 828, state = STATES.DISPATCHED, suffix = "a" } = {}) {
  const runId = createRunId({
    issueNumber,
    branch: `issue-${issueNumber}-${suffix}`,
    timestamp: new Date(`2026-07-08T00:00:0${suffix === "a" ? 0 : 1}.000Z`),
  });
  const layout = ensureRunLayout(fixture.repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot: fixture.repoRoot,
    runId,
    branch: `issue-${issueNumber}-${suffix}`,
    baseBranch: "main",
    issueNumber,
    worktreePath: fixture.repoRoot,
  });
  manifest.anchor.rubric_path = "rubric.yaml";
  if (state !== STATES.DRAFT) {
    manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  }
  writeManifest(layout.manifestPath, manifest);
  fs.writeFileSync(path.join(layout.runDir, "rubric.yaml"), "rubric:\n  size_class: S\n", "utf-8");
  return runId;
}

test("relay-status selects a single active issue run", () => {
  const fixture = setupRepo();
  try {
    const runId = writeRun(fixture);
    const selection = selectIssueRuns(fixture.repoRoot, 828);
    assert.equal(selection.selected_run_id, runId);
    assert.equal(selection.selection_reason, "single_active_run");
    assert.equal(selection.candidates.length, 1);
  } finally {
    fixture.restore();
  }
});

test("relay-status refuses to select an arbitrary active issue run", () => {
  const fixture = setupRepo();
  try {
    writeRun(fixture, { issueNumber: 828, suffix: "a" });
    writeRun(fixture, { issueNumber: 828, suffix: "b" });
    const selection = selectIssueRuns(fixture.repoRoot, 828);
    assert.equal(selection.selected_run_id, null);
    assert.equal(selection.selection_reason, "multiple_active_runs");
    assert.equal(selection.candidates.length, 2);
  } finally {
    fixture.restore();
  }
});

test("relay-recover plans reconcile for dead work but refuses missing worktree", () => {
  const recoverable = planFor({
    run_id: "issue-829-20260708000000000-aaaaaaaa",
    classification: "dead_with_work",
    next_action: { command: "ignored" },
  }, "/tmp/repo");
  assert.equal(recoverable.action, "delegate_reconcile");
  assert.equal(recoverable.safe_to_apply, true);
  assert.ok(recoverable.command.includes("skills/relay-dispatch/scripts/reconcile-run.js"));

  const unsafe = planFor({
    run_id: "issue-829-20260708000000000-bbbbbbbb",
    classification: "missing_worktree",
    next_action: { command: "inspect manually" },
  }, "/tmp/repo");
  assert.equal(unsafe.action, "manual_guidance");
  assert.equal(unsafe.safe_to_apply, false);
  assert.equal(unsafe.guidance, "inspect manually");
});

test("relay-recover refuses to apply running runs", () => {
  for (const classification of ["running_with_output", "running_silent"]) {
    const plan = planFor({
      run_id: "issue-829-20260708000000000-cccccccc",
      classification,
      next_action: { command: "inspect running process" },
    }, "/tmp/repo");
    assert.equal(plan.action, "delegate_reconcile");
    assert.equal(plan.safe_to_apply, false);
  }
});

test("relay-recover gives manual guidance for terminal or unknown runs", () => {
  for (const classification of ["ready_to_merge", "unknown_needs_manual_inspection"]) {
    const plan = planFor({
      run_id: "issue-829-20260708000000000-dddddddd",
      classification,
      next_action: { command: "inspect manually" },
    }, "/tmp/repo");
    assert.equal(plan.action, "manual_guidance");
    assert.equal(plan.safe_to_apply, false);
    assert.equal(plan.guidance, "inspect manually");
  }
});
