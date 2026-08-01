const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  STATES,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { appendRunEvent, EVENTS } = require("../../../skills/relay-dispatch/scripts/relay-events");
const {
  findInflightRunsForIssue,
  formatInflightCollisionError,
  inferIssueFromPromptOrBranch,
} = require("../../../skills/relay-dispatch/scripts/manifest/inflight-runs");
const { createRunRecord } = require("../../../skills/relay-dispatch/scripts/run-store");
const { getRunDir } = require("../../../skills/relay-dispatch/scripts/manifest/paths");

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-inflight-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Inflight Test"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "inflight@example.com"], { cwd: repoRoot, stdio: "pipe" });
  return repoRoot;
}

function newRunRelayHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
}

function writeRunWithState({
  repoRoot,
  issueNumber,
  state,
  timestamp = new Date(),
  worktreePath = "/tmp/fake-worktree",
}) {
  const runId = createRunId({ issueNumber, branch: `issue-${issueNumber}`, timestamp });
  const layout = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: `issue-${issueNumber}`,
    baseBranch: "main",
    issueNumber,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  if (state && state !== STATES.DRAFT) {
    manifest = { ...manifest, state, next_action: "test_fixture" };
  }
  writeManifest(layout.manifestPath, manifest);
  return { runId, manifestPath: layout.manifestPath };
}

function writeVnextRun({ repoRoot, issueNumber, facts = [], corruptFacts = null }) {
  const runId = createRunId({ issueNumber, branch: `issue-${issueNumber}` });
  const runDir = getRunDir(repoRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const canonical = fs.realpathSync(runDir);
  const donePath = path.join(canonical, "done-criteria.md");
  fs.writeFileSync(donePath, "done\n");
  createRunRecord({ runDir: canonical, record: {
    version: 3,
    run_id: runId,
    repo: { root: repoRoot, remote: "owner/repo" },
    git: { branch: `issue-${issueNumber}`, base_branch: "main", worktree: repoRoot, start_sha: "a".repeat(40) },
    contract: { done_criteria_path: donePath, done_criteria_sha256: crypto.createHash("sha256").update("done\n").digest("hex") },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
    parent: null,
    ownership_digest: null,
    created_at: new Date().toISOString(),
  } });
  const eventsPath = path.join(canonical, "events.jsonl");
  if (corruptFacts !== null) fs.writeFileSync(eventsPath, corruptFacts);
  else if (facts.length) fs.writeFileSync(eventsPath, `${facts.map((fact) => JSON.stringify({ ...fact, run_id: runId })).join("\n")}\n`);
  return { runId, runDir: canonical };
}

test("inferIssueFromPromptOrBranch: matches issue-N in branch", () => {
  assert.equal(inferIssueFromPromptOrBranch("issue-408", null), 408);
  assert.equal(inferIssueFromPromptOrBranch("feature/issue-99", null), 99);
});

test("inferIssueFromPromptOrBranch: falls back to prompt when branch lacks issue", () => {
  assert.equal(inferIssueFromPromptOrBranch("feature-x", "implement issue-42 fixes"), 42);
});

test("inferIssueFromPromptOrBranch: returns null when neither matches", () => {
  assert.equal(inferIssueFromPromptOrBranch("feature-x", "some prompt"), null);
  assert.equal(inferIssueFromPromptOrBranch(null, null), null);
  assert.equal(inferIssueFromPromptOrBranch("", ""), null);
});

test("findInflightRunsForIssue: returns empty when no manifests exist", () => {
  process.env.RELAY_HOME = newRunRelayHome();
  const repoRoot = setupRepo();
  assert.deepEqual(findInflightRunsForIssue(repoRoot, 408), []);
});

test("findInflightRunsForIssue: discovers run.json-only crash residue with no legacy manifest", () => {
  process.env.RELAY_HOME = newRunRelayHome();
  const repoRoot = setupRepo();
  const child = writeVnextRun({ repoRoot, issueNumber: 409 });
  const result = findInflightRunsForIssue(repoRoot, 409);
  assert.equal(result.length, 1);
  assert.equal(result[0].runId, child.runId);
  assert.equal(result[0].source, "vnext");
  assert.equal(result[0].state, "no_attempt");
  assert.equal(result[0].manifestPath, null);
});

test("findInflightRunsForIssue: malformed vNext facts fail closed and dedupe a forged legacy terminal manifest", () => {
  process.env.RELAY_HOME = newRunRelayHome();
  const repoRoot = setupRepo();
  const child = writeVnextRun({ repoRoot, issueNumber: 410, corruptFacts: "not-json\n" });
  writeManifest(path.join(path.dirname(getRunDir(repoRoot, child.runId)), `${child.runId}.md`), {
    run_id: child.runId, state: STATES.MERGED, git: { working_branch: "issue-410" },
  });
  const result = findInflightRunsForIssue(repoRoot, 410);
  assert.equal(result.length, 1);
  assert.equal(result[0].runId, child.runId);
  assert.equal(result[0].state, "operator_attention");
  assert.match(result[0].reason, /invalid fact journal/);
});

test("findInflightRunsForIssue: skips vNext only after a conflict-free durable terminal fold", () => {
  process.env.RELAY_HOME = newRunRelayHome();
  const repoRoot = setupRepo();
  const closed = writeVnextRun({ repoRoot, issueNumber: 411, facts: [{
    event_id: "closed-1", type: "run_closed", at: new Date().toISOString(), actor: "operator",
    payload: { reason: "done", operator: "operator", last_sha: "a".repeat(40), pr_number: null },
  }] });
  assert.ok(closed.runId);
  assert.deepEqual(findInflightRunsForIssue(repoRoot, 411), []);

  writeVnextRun({ repoRoot, issueNumber: 412, corruptFacts: "{\"partial\":" });
  const torn = findInflightRunsForIssue(repoRoot, 412);
  assert.equal(torn.length, 1);
  assert.equal(torn[0].state, "operator_attention");
});

test("findInflightRunsForIssue: returns non-terminal runs for the matching issue", () => {
  process.env.RELAY_HOME = newRunRelayHome();
  const repoRoot = setupRepo();
  const { runId } = writeRunWithState({ repoRoot, issueNumber: 408, state: STATES.DISPATCHED });
  const result = findInflightRunsForIssue(repoRoot, 408);
  assert.equal(result.length, 1);
  assert.equal(result[0].runId, runId);
  assert.equal(result[0].state, STATES.DISPATCHED);
  assert.equal(result[0].worktreePath, "/tmp/fake-worktree");
});

test("findInflightRunsForIssue: skips terminal runs (merged/closed)", () => {
  process.env.RELAY_HOME = newRunRelayHome();
  const repoRoot = setupRepo();
  writeRunWithState({ repoRoot, issueNumber: 408, state: STATES.MERGED });
  writeRunWithState({ repoRoot, issueNumber: 408, state: STATES.CLOSED });
  assert.deepEqual(findInflightRunsForIssue(repoRoot, 408), []);
});

test("findInflightRunsForIssue: only matches the specific issue prefix", () => {
  process.env.RELAY_HOME = newRunRelayHome();
  const repoRoot = setupRepo();
  writeRunWithState({ repoRoot, issueNumber: 408, state: STATES.DISPATCHED });
  writeRunWithState({ repoRoot, issueNumber: 4080, state: STATES.DISPATCHED });
  writeRunWithState({ repoRoot, issueNumber: 99, state: STATES.DISPATCHED });
  const result = findInflightRunsForIssue(repoRoot, 408);
  assert.equal(result.length, 1);
  assert.ok(result[0].runId.startsWith("issue-408-"));
});

test("findInflightRunsForIssue: populates lastEventAt from events.jsonl tail", () => {
  process.env.RELAY_HOME = newRunRelayHome();
  const repoRoot = setupRepo();
  const { runId } = writeRunWithState({ repoRoot, issueNumber: 408, state: STATES.DISPATCHED });
  appendRunEvent(repoRoot, runId, {
    event: EVENTS.DISPATCH_START,
    state_from: STATES.DRAFT,
    state_to: STATES.DISPATCHED,
    ts: "2026-05-02T13:00:00.000Z",
  });
  const result = findInflightRunsForIssue(repoRoot, 408);
  assert.equal(result[0].lastEventAt, "2026-05-02T13:00:00.000Z");
});

test("findInflightRunsForIssue: returns empty for falsy/non-numeric issueNumber", () => {
  process.env.RELAY_HOME = newRunRelayHome();
  const repoRoot = setupRepo();
  writeRunWithState({ repoRoot, issueNumber: 408, state: STATES.DISPATCHED });
  assert.deepEqual(findInflightRunsForIssue(repoRoot, null), []);
  assert.deepEqual(findInflightRunsForIssue(repoRoot, "bad"), []);
  assert.deepEqual(findInflightRunsForIssue(repoRoot, 0), []);
});

test("formatInflightCollisionError: includes runId, state, worktree, manifest in output", () => {
  const inflightRuns = [{
    runId: "issue-408-20260502130000000-deadbeef",
    state: "dispatched",
    manifestPath: "/relay/runs/slug/issue-408-20260502130000000-deadbeef.md",
    worktreePath: "/tmp/wt/foo",
    lastEventAt: "2026-05-02T13:00:00.000Z",
  }];
  const message = formatInflightCollisionError(inflightRuns, { issueNumber: 408 });
  assert.match(message, /issue-408/);
  assert.match(message, /issue-408-20260502130000000-deadbeef/);
  assert.match(message, /dispatched/);
  assert.match(message, /\/tmp\/wt\/foo/);
  assert.match(message, /\/relay\/runs\/slug\/issue-408-/);
  assert.match(message, /--allow-conflicting-run/);
});

test("formatInflightCollisionError: handles missing optional fields", () => {
  const inflightRuns = [{
    runId: "issue-99-x",
    state: "dispatched",
    manifestPath: "/m",
    worktreePath: null,
    lastEventAt: null,
  }];
  const message = formatInflightCollisionError(inflightRuns, { issueNumber: 99 });
  assert.match(message, /worktree:\s+\(unset\)/);
  assert.match(message, /last_event:\s+\(none\)/);
});
