const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
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
