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
const { findManifestByRunId, resolveManifestRecord } = require("./relay-resolver");

const CLOSE_RUN_SCRIPT = path.join(__dirname, "close-run.js");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureFixtureRubric(runDir, rubricPath) {
  if (
    typeof rubricPath !== "string"
    || rubricPath.trim() === ""
    || path.isAbsolute(rubricPath)
    || rubricPath.split(/[\\/]+/).includes("..")
  ) {
    return;
  }
  const fullPath = path.join(runDir, rubricPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, "rubric:\n  factors:\n    - name: resolver fixture\n", "utf-8");
}

function writeManifestRecord(repoRoot, options = {}) {
  const {
  runId,
  storedRunId = runId,
  branch = "issue-42",
  issueNumber = 42,
  state = STATES.REVIEW_PENDING,
  prNumber,
  grandfathered = true,
  rubricPath,
  cleanupPolicy = "on_close",
  updatedAt = "2026-04-03T00:00:00.000Z",
  } = options;
  const { manifestPath, runDir } = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber,
    worktreePath: path.join(repoRoot, "wt", branch),
    orchestrator: "codex",
    executor: "codex",
    reviewer: "claude",
    cleanupPolicy,
  });

  manifest.anchor.rubric_grandfathered = grandfathered;
  if (rubricPath !== undefined) {
    manifest.anchor.rubric_path = rubricPath;
  }
  ensureFixtureRubric(runDir, rubricPath);

  if (state !== STATES.DRAFT) {
    manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  }
  if ([
    STATES.REVIEW_PENDING,
    STATES.CHANGES_REQUESTED,
    STATES.READY_TO_MERGE,
    STATES.ESCALATED,
    STATES.MERGED,
    STATES.CLOSED,
  ].includes(state)) {
    manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  }
  if (state === STATES.CHANGES_REQUESTED) {
    manifest = updateManifestState(manifest, STATES.CHANGES_REQUESTED, "re_dispatch_requested_changes");
  }
  if ([STATES.READY_TO_MERGE, STATES.MERGED].includes(state)) {
    manifest = updateManifestState(manifest, STATES.READY_TO_MERGE, "await_explicit_merge");
  }
  if (state === STATES.ESCALATED) {
    manifest = updateManifestState(manifest, STATES.ESCALATED, "inspect_review_failure");
  }
  if (state === STATES.MERGED) {
    manifest = updateManifestState(manifest, STATES.MERGED, "manual_cleanup_required");
  }
  if (state === STATES.CLOSED) {
    manifest = updateManifestState(manifest, STATES.CLOSED, "done");
  }

  manifest.run_id = storedRunId;
  if (Object.prototype.hasOwnProperty.call(options, "prNumber")) {
    manifest.git.pr_number = prNumber;
  }
  manifest.timestamps.updated_at = updatedAt;
  manifest.timestamps.created_at = updatedAt;
  writeManifest(manifestPath, manifest);
  return manifestPath;
}

test("findManifestByRunId rejects invalid run_id selectors before scanning manifests", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-find-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));

  assert.throws(
    () => findManifestByRunId(repoRoot, "../victim-run"),
    /may not contain '\.\.' segments/
  );
  assert.throws(
    () => findManifestByRunId(repoRoot, "issue-42\\20260412000000000"),
    /may not contain '\\\\'/
  );
});

test("resolveManifestRecord rejects non-conforming run_id selectors", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-shape-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "issue-42",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
  });

  assert.throws(
    () => resolveManifestRecord({ repoRoot, runId: "Issue-42-20260412000000000" }),
    /shape emitted by createRunId/
  );
});

test("resolveManifestRecord rejects manifests whose stored run_id is invalid", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-invalid-manifest-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "issue-42",
      timestamp: new Date("2026-04-03T00:05:00.000Z"),
    }),
    storedRunId: "../victim-run",
    updatedAt: "2026-04-03T00:05:00.000Z",
  });

  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "issue-42" }),
    /has invalid run_id: run_id must be a single path segment/
  );
});

test("resolveManifestRecord returns the fresh non-terminal manifest on a reused branch instead of stale merged state", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-reused-branch-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-auth",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    branch: "feature-auth",
    state: STATES.MERGED,
    rubricPath: "stale-rubric.yaml",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  const freshRunId = createRunId({
    branch: "feature-auth",
    timestamp: new Date("2026-04-03T00:10:00.000Z"),
  });
  const freshPath = writeManifestRecord(repoRoot, {
    runId: freshRunId,
    branch: "feature-auth",
    grandfathered: false,
    rubricPath: "fresh-rubric.yaml",
    updatedAt: "2026-04-03T00:10:00.000Z",
  });

  const match = resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 });
  assert.equal(match.manifestPath, freshPath);
  assert.equal(match.data.run_id, freshRunId);
  assert.equal(match.data.anchor.rubric_path, "fresh-rubric.yaml");
  assert.notEqual(match.data.anchor.rubric_grandfathered, true);
});

test("resolveManifestRecord rejects stale terminal-only branch reuse and names the fresh-dispatch recovery", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-terminal-only-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const staleRunId = createRunId({
    branch: "feature-auth",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  writeManifestRecord(repoRoot, {
    runId: staleRunId,
    branch: "feature-auth",
    state: STATES.MERGED,
    rubricPath: "stale-rubric.yaml",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 }),
    (error) => {
      assert.match(error.message, /No relay manifest found for branch 'feature-auth' \+ pr '120'/);
      assert.match(error.message, new RegExp(staleRunId));
      assert.match(error.message, /Only terminal branch matches exist/);
      assert.match(error.message, /Create a fresh dispatch for this branch before retrying/);
      return true;
    }
  );
});

test("resolveManifestRecord recovers from terminal-only branch reuse after a fresh dispatch", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-terminal-recovery-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-auth",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    branch: "feature-auth",
    state: STATES.CLOSED,
    rubricPath: "stale-rubric.yaml",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 }),
    /Create a fresh dispatch/
  );

  const freshRunId = createRunId({
    branch: "feature-auth",
    timestamp: new Date("2026-04-03T00:15:00.000Z"),
  });
  const freshPath = writeManifestRecord(repoRoot, {
    runId: freshRunId,
    branch: "feature-auth",
    grandfathered: false,
    rubricPath: "fresh-rubric.yaml",
    updatedAt: "2026-04-03T00:15:00.000Z",
  });

  const match = resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 });
  assert.equal(match.manifestPath, freshPath);
  assert.equal(match.data.run_id, freshRunId);
});

test("resolveManifestRecord rejects ambiguous non-terminal branch matches and recovers with explicit selectors", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-ambiguous-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const firstRunId = createRunId({
    branch: "feature-foo",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const secondRunId = createRunId({
    branch: "feature-foo",
    timestamp: new Date("2026-04-03T00:10:00.000Z"),
  });
  const firstPath = writeManifestRecord(repoRoot, {
    runId: firstRunId,
    branch: "feature-foo",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  const secondPath = writeManifestRecord(repoRoot, {
    runId: secondRunId,
    branch: "feature-foo",
    state: STATES.CHANGES_REQUESTED,
    updatedAt: "2026-04-03T00:10:00.000Z",
  });

  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-foo", prNumber: 120 }),
    (error) => {
      assert.match(error.message, /Ambiguous relay manifest/);
      assert.match(error.message, /2 candidates/);
      assert.match(error.message, new RegExp(firstRunId));
      assert.match(error.message, new RegExp(secondRunId));
      assert.match(error.message, /Pass --manifest <path> or --run-id <id> explicitly/);
      return true;
    }
  );

  const runIdMatch = resolveManifestRecord({ repoRoot, runId: secondRunId });
  assert.equal(runIdMatch.manifestPath, secondPath);
  const manifestMatch = resolveManifestRecord({ repoRoot, manifestPath: firstPath });
  assert.equal(manifestMatch.manifestPath, firstPath);
});

test("resolveManifestRecord rejects stored pr_number mismatch and recovers with explicit run_id", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-pr-mismatch-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = createRunId({
    branch: "feature-auth",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const manifestPath = writeManifestRecord(repoRoot, {
    runId,
    branch: "feature-auth",
    prNumber: 100,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 }),
    (error) => {
      assert.match(error.message, /No relay manifest found for branch 'feature-auth' \+ pr '120'/);
      assert.match(error.message, new RegExp(runId));
      assert.match(error.message, /pr=100/);
      assert.match(error.message, /Pass --run-id <id> or --manifest <path> explicitly/);
      return true;
    }
  );

  const recovered = resolveManifestRecord({ repoRoot, runId });
  assert.equal(recovered.manifestPath, manifestPath);
});

test("resolveManifestRecord keeps escalated stored-pr mismatches recoverable via explicit selectors", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-escalated-pr-mismatch-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = createRunId({
    branch: "feature-auth",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const manifestPath = writeManifestRecord(repoRoot, {
    runId,
    branch: "feature-auth",
    state: STATES.ESCALATED,
    prNumber: 100,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  // Anti-theater: this still enters the branch+PR miss path, but the manifest has a stored PR.
  // The #165 fix must stay scoped to stale `escalated + pr_number: unset` fallback only.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 }),
    (error) => {
      assert.match(error.message, /No relay manifest found for branch 'feature-auth' \+ pr '120'/);
      assert.match(error.message, new RegExp(runId));
      assert.match(error.message, /state=escalated, pr=100/);
      assert.match(error.message, /Pass --run-id <id> or --manifest <path> explicitly/);
      assert.doesNotMatch(error.message, /Only terminal branch matches exist/);
      assert.doesNotMatch(error.message, /Create a fresh dispatch for this branch before retrying/);
      return true;
    }
  );

  const recovered = resolveManifestRecord({ repoRoot, runId });
  assert.equal(recovered.manifestPath, manifestPath);
});

test("resolveManifestRecord preserves dispatch-before-PR fallback for a single non-terminal manifest without stored pr_number", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-pr-fallback-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const manifestPath = writeManifestRecord(repoRoot, {
    runId,
    branch: "issue-42",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  const match = resolveManifestRecord({ repoRoot, branch: "issue-42", prNumber: 120 });
  assert.equal(match.manifestPath, manifestPath);
  assert.equal(match.data.run_id, runId);
});

test("resolveManifestRecord rejects stale escalated branch fallback and names close-run plus --run-id recovery", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-escalated-stale-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = createRunId({
    branch: "feature-auth",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const closeCommand = `node skills/relay-dispatch/scripts/close-run.js --repo ${JSON.stringify(repoRoot)} --run-id ${JSON.stringify(runId)} --reason ${JSON.stringify("stale_escalated_run")}`;
  writeManifestRecord(repoRoot, {
    runId,
    branch: "feature-auth",
    state: STATES.ESCALATED,
    cleanupPolicy: "manual",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  // Anti-theater: before #165, `filterByPr(branchMatches, 120)` returned no match and the old
  // single-record branch fallback rebound this stale `escalated + pr_number: unset` manifest to PR 120.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 }),
    (error) => {
      assert.match(error.message, /No relay manifest found for branch 'feature-auth' \+ pr '120'/);
      assert.match(error.message, new RegExp(runId));
      assert.match(error.message, /state=escalated, pr=unset/);
      assert.match(error.message, new RegExp(escapeRegExp(closeCommand)));
      assert.match(error.message, new RegExp(escapeRegExp(`--run-id ${JSON.stringify(runId)}`)));
      return true;
    }
  );
});

test("resolveManifestRecord keeps escalated manifests addressable by matching pr_number", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-escalated-pr-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = createRunId({
    branch: "feature-auth",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const manifestPath = writeManifestRecord(repoRoot, {
    runId,
    branch: "feature-auth",
    state: STATES.ESCALATED,
    prNumber: 120,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  // Anti-theater: this is the preserved branch+PR selector. Even after #165 blocks stale branch-only
  // fallback, a true `filterByPr(branchMatches, 120)` match must still return the escalated manifest.
  const match = resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 });
  assert.equal(match.manifestPath, manifestPath);
  assert.equal(match.data.state, STATES.ESCALATED);
  assert.equal(match.data.git.pr_number, 120);
});

test("resolveManifestRecord keeps escalated manifests addressable by explicit selectors", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-escalated-explicit-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = createRunId({
    branch: "issue-42",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const manifestPath = writeManifestRecord(repoRoot, {
    runId,
    branch: "issue-42",
    state: STATES.ESCALATED,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  // Anti-theater: legitimate escalated recovery is explicit. `--run-id` and `--manifest` never relied
  // on the stale branch+PR fallback, so the #165 exclusion must not strand an operator resuming the run.
  const runIdMatch = resolveManifestRecord({ repoRoot, runId });
  assert.equal(runIdMatch.manifestPath, manifestPath);
  assert.equal(runIdMatch.data.state, STATES.ESCALATED);

  const manifestMatch = resolveManifestRecord({ repoRoot, manifestPath });
  assert.equal(manifestMatch.manifestPath, manifestPath);
  assert.equal(manifestMatch.data.state, STATES.ESCALATED);
});

test("resolveManifestRecord recovers from stale escalated fallback after close-run and fresh dispatch", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-escalated-recovery-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const staleRunId = createRunId({
    branch: "feature-auth",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const staleManifestPath = writeManifestRecord(repoRoot, {
    runId: staleRunId,
    branch: "feature-auth",
    state: STATES.ESCALATED,
    cleanupPolicy: "manual",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  // Anti-theater: before #165, this first branch+PR lookup would have silently selected `staleRunId`,
  // so the operator never reached the close-run / re-dispatch recovery flow exercised below.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 }),
    new RegExp(escapeRegExp(`--run-id ${JSON.stringify(staleRunId)}`))
  );

  execFileSync("node", [
    CLOSE_RUN_SCRIPT,
    "--repo", repoRoot,
    "--run-id", staleRunId,
    "--reason", "stale_escalated_run",
    "--json",
  ], { encoding: "utf-8" });

  const staleManifest = readManifest(staleManifestPath).data;
  assert.equal(staleManifest.state, STATES.CLOSED);

  const freshRunId = createRunId({
    branch: "feature-auth",
    timestamp: new Date("2026-04-03T00:15:00.000Z"),
  });
  const freshPath = writeManifestRecord(repoRoot, {
    runId: freshRunId,
    branch: "feature-auth",
    cleanupPolicy: "manual",
    updatedAt: "2026-04-03T00:15:00.000Z",
  });

  const match = resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 });
  assert.equal(match.manifestPath, freshPath);
  assert.equal(match.data.run_id, freshRunId);
});
