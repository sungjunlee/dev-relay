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
  validateTransition,
  updateManifestState,
  writeManifest,
} = require("./relay-manifest");
const { findManifestByRunId, resolveManifestRecord } = require("./relay-resolver");

const CLOSE_RUN_SCRIPT = path.join(__dirname, "close-run.js");
const EXACT_PR_COLLISION_PR = 40;
const NON_TERMINAL_BRANCH_PR_STATES = [
  STATES.DISPATCHED,
  STATES.REVIEW_PENDING,
  STATES.CHANGES_REQUESTED,
  STATES.READY_TO_MERGE,
  STATES.ESCALATED,
];
const BRANCH_PR_CASES = [
  { label: "pr_number:null", prNumber: undefined },
  { label: "pr_number:matches", prNumber: 120 },
  { label: "pr_number:mismatch", prNumber: 100 },
];

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

function assertExplicitSelectorsResolve(repoRoot, manifestPath, runId, expectedState) {
  const runIdMatch = resolveManifestRecord({ repoRoot, runId });
  assert.equal(runIdMatch.manifestPath, manifestPath);
  assert.equal(runIdMatch.data.state, expectedState);

  const manifestMatch = resolveManifestRecord({ repoRoot, manifestPath });
  assert.equal(manifestMatch.manifestPath, manifestPath);
  assert.equal(manifestMatch.data.state, expectedState);
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
    state: STATES.DISPATCHED,
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
    state: STATES.DISPATCHED,
    grandfathered: false,
    rubricPath: "fresh-rubric.yaml",
    updatedAt: "2026-04-03T00:15:00.000Z",
  });

  const match = resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 });
  assert.equal(match.manifestPath, freshPath);
  assert.equal(match.data.run_id, freshRunId);
});

test("resolveManifestRecord covers the stored-pr terminal exact-PR collision matrix", async (t) => {
  const cases = [
    {
      label: "merged + matching stored pr + no fresh dispatch",
      terminalState: STATES.MERGED,
      freshPrNumber: null,
      expected: "terminal-only-rejection",
      // Anti-theater: pre-#170, relay-resolver.js:185 (`matches = filterByPr(branchMatches, 40);`)
      // returned the merged manifest because branchMatches was terminal-inclusive.
    },
    {
      label: "merged + matching stored pr + fresh dispatched + pr unset",
      terminalState: STATES.MERGED,
      freshPrNumber: undefined,
      expected: "fresh-dispatched-null-pr",
      // Anti-theater: pre-#170, relay-resolver.js:185 returned the merged manifest before the
      // dispatched+null branch fallback could recover the fresh run.
    },
    {
      label: "merged + matching stored pr + fresh dispatched + matching pr",
      terminalState: STATES.MERGED,
      freshPrNumber: EXACT_PR_COLLISION_PR,
      expected: "fresh-dispatched-matching-pr",
      // Anti-theater: pre-#170, filterByPr(branchMatches, 40) kept both manifests and raised
      // ambiguity. The #170 call-site fix intentionally drops the terminal sibling first, so the
      // fresh dispatched manifest wins instead of surfacing ambiguity for a stale collision.
    },
    {
      label: "closed + matching stored pr + no fresh dispatch",
      terminalState: STATES.CLOSED,
      freshPrNumber: null,
      expected: "terminal-only-rejection",
      // Anti-theater: pre-#170, relay-resolver.js:185 returned the closed manifest because
      // branchMatches still included terminal records on the exact-PR selector path.
    },
    {
      label: "closed + matching stored pr + fresh dispatched + pr unset",
      terminalState: STATES.CLOSED,
      freshPrNumber: undefined,
      expected: "fresh-dispatched-null-pr",
      // Anti-theater: pre-#170, relay-resolver.js:185 returned the stale closed manifest before
      // the dispatched+null fallback could rebind resolution to the fresh run.
    },
    {
      label: "closed + matching stored pr + fresh dispatched + matching pr",
      terminalState: STATES.CLOSED,
      freshPrNumber: EXACT_PR_COLLISION_PR,
      expected: "fresh-dispatched-matching-pr",
      // Anti-theater: pre-#170, filterByPr(branchMatches, 40) surfaced both manifests and stopped
      // in ambiguity. Post-#170, terminal siblings are excluded before exact-PR matching.
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.label, () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-stored-pr-collision-"));
      process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
      const staleRunId = createRunId({
        branch: "feature-x",
        timestamp: new Date("2026-04-03T00:00:00.000Z"),
      });
      writeManifestRecord(repoRoot, {
        runId: staleRunId,
        branch: "feature-x",
        state: testCase.terminalState,
        prNumber: EXACT_PR_COLLISION_PR,
        updatedAt: "2026-04-03T00:00:00.000Z",
      });

      let freshPath = null;
      if (testCase.expected !== "terminal-only-rejection") {
        const freshRunId = createRunId({
          branch: "feature-x",
          timestamp: new Date("2026-04-03T00:15:00.000Z"),
        });
        freshPath = writeManifestRecord(repoRoot, {
          runId: freshRunId,
          branch: "feature-x",
          state: STATES.DISPATCHED,
          ...(testCase.freshPrNumber === undefined ? {} : { prNumber: testCase.freshPrNumber }),
          updatedAt: "2026-04-03T00:15:00.000Z",
        });
      }

      if (testCase.expected === "terminal-only-rejection") {
        assert.throws(
          () => resolveManifestRecord({ repoRoot, branch: "feature-x", prNumber: EXACT_PR_COLLISION_PR }),
          (error) => {
            assert.match(error.message, /No relay manifest found for branch 'feature-x' \+ pr '40'/);
            assert.match(error.message, new RegExp(staleRunId));
            assert.match(error.message, /Only terminal branch matches exist/);
            assert.match(error.message, /Create a fresh dispatch for this branch before retrying/);
            return true;
          }
        );
        return;
      }

      const match = resolveManifestRecord({ repoRoot, branch: "feature-x", prNumber: EXACT_PR_COLLISION_PR });
      assert.equal(match.manifestPath, freshPath);
      assert.equal(match.data.state, STATES.DISPATCHED);
      assert.equal(
        match.data.git.pr_number,
        testCase.expected === "fresh-dispatched-matching-pr" ? EXACT_PR_COLLISION_PR : null
      );
    });
  }
});

test("resolveManifestRecord keeps terminal manifests with stored PR mismatches explicit-only", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-terminal-pr-mismatch-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const staleRunId = createRunId({
    branch: "feature-x",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const stalePath = writeManifestRecord(repoRoot, {
    runId: staleRunId,
    branch: "feature-x",
    state: STATES.MERGED,
    prNumber: EXACT_PR_COLLISION_PR,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-x", prNumber: EXACT_PR_COLLISION_PR + 1 }),
    (error) => {
      assert.match(error.message, /No relay manifest found for branch 'feature-x' \+ pr '41'/);
      assert.match(error.message, new RegExp(staleRunId));
      assert.match(error.message, /state=merged, pr=40/);
      assert.match(error.message, /Only terminal branch matches exist/);
      assert.match(error.message, /Create a fresh dispatch for this branch before retrying/);
      return true;
    }
  );

  assertExplicitSelectorsResolve(repoRoot, stalePath, staleRunId, STATES.MERGED);
});

test("resolveManifestRecord keeps merged and closed manifests reachable via explicit selectors", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-terminal-explicit-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const mergedRunId = createRunId({
    branch: "feature-merged",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const mergedPath = writeManifestRecord(repoRoot, {
    runId: mergedRunId,
    branch: "feature-merged",
    state: STATES.MERGED,
    prNumber: EXACT_PR_COLLISION_PR,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  const closedRunId = createRunId({
    branch: "feature-closed",
    timestamp: new Date("2026-04-03T00:10:00.000Z"),
  });
  const closedPath = writeManifestRecord(repoRoot, {
    runId: closedRunId,
    branch: "feature-closed",
    state: STATES.CLOSED,
    prNumber: EXACT_PR_COLLISION_PR + 2,
    updatedAt: "2026-04-03T00:10:00.000Z",
  });

  assertExplicitSelectorsResolve(repoRoot, mergedPath, mergedRunId, STATES.MERGED);
  assertExplicitSelectorsResolve(repoRoot, closedPath, closedRunId, STATES.CLOSED);
});

test("resolveManifestRecord exercises the #170 stale-terminal recovery flow end-to-end", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-terminal-e2e-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const staleRunId = createRunId({
    branch: "feature-z",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  writeManifestRecord(repoRoot, {
    runId: staleRunId,
    branch: "feature-z",
    state: STATES.MERGED,
    prNumber: 42,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  // Anti-theater: pre-#170, relay-resolver.js:185 silently returned this merged manifest, so the
  // operator never hit the fresh-dispatch recovery path. #170 closes the fourth rung in the
  // #149 -> #165 -> #168 -> #170 ladder; per memory/feedback_rubric_fail_closed.md's
  // end-to-end-recovery meta-rule, assert the stale terminal is rejected, close-run cannot help,
  // and a fresh dispatched run resolves cleanly on the same branch.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-z", prNumber: 42 }),
    (error) => {
      assert.match(error.message, /Only terminal branch matches exist/);
      assert.match(error.message, /Create a fresh dispatch for this branch before retrying/);
      assert.match(error.message, new RegExp(staleRunId));
      assert.doesNotMatch(error.message, /Close the stale .* run/);
      return true;
    }
  );

  assert.throws(
    () => validateTransition(STATES.MERGED, STATES.CLOSED),
    /Invalid relay state transition: merged -> closed/
  );
  assert.throws(
    () => validateTransition(STATES.CLOSED, STATES.CLOSED),
    /Invalid relay state transition: closed -> closed/
  );

  const freshRunId = createRunId({
    branch: "feature-z",
    timestamp: new Date("2026-04-03T00:15:00.000Z"),
  });
  const freshPath = writeManifestRecord(repoRoot, {
    runId: freshRunId,
    branch: "feature-z",
    state: STATES.DISPATCHED,
    updatedAt: "2026-04-03T00:15:00.000Z",
  });

  const match = resolveManifestRecord({ repoRoot, branch: "feature-z", prNumber: 42 });
  assert.equal(match.manifestPath, freshPath);
  assert.equal(match.data.run_id, freshRunId);
  assert.equal(match.data.state, STATES.DISPATCHED);
  assert.equal(match.data.git.pr_number, null);
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
      assert.match(error.message, /state=review_pending, pr=unset/);
      assert.match(error.message, /state=changes_requested, pr=unset/);
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
    state: STATES.DISPATCHED,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  const match = resolveManifestRecord({ repoRoot, branch: "issue-42", prNumber: 120 });
  assert.equal(match.manifestPath, manifestPath);
  assert.equal(match.data.run_id, runId);
});

test("resolveManifestRecord enumerates the non-terminal state x pr_number branch+PR matrix", async (t) => {
  for (const state of NON_TERMINAL_BRANCH_PR_STATES) {
    for (const { label, prNumber: storedPrNumber } of BRANCH_PR_CASES) {
      await t.test(`${state} + ${label}`, () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-matrix-"));
        process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
        const runId = createRunId({
          branch: "matrix-branch",
          timestamp: new Date("2026-04-03T00:00:00.000Z"),
        });
        const manifestPath = writeManifestRecord(repoRoot, {
          runId,
          branch: "matrix-branch",
          state,
          ...(storedPrNumber === undefined ? {} : { prNumber: storedPrNumber }),
          updatedAt: "2026-04-03T00:00:00.000Z",
        });

        if (storedPrNumber === undefined) {
          if (state === STATES.DISPATCHED) {
            // Anti-theater: pre-#168, relay-resolver.js:179-180 was the single legitimate null-pr fallback.
            const match = resolveManifestRecord({ repoRoot, branch: "matrix-branch", prNumber: 120 });
            assert.equal(match.manifestPath, manifestPath);
            assert.equal(match.data.state, state);
            return;
          }

          // Anti-theater: pre-#168, relay-resolver.js:179-180 silently rebound stale non-dispatched null-pr
          // manifests on reused branches because the fallback was blacklist-shaped instead of whitelist-shaped.
          // Round 2 (#168 reviewer feedback): every stale non-dispatched null-pr state must name close-run.js
          // + --run-id recovery in the error message, not just escalated.
          const expectedCloseReason = `stale_${state}_run`;
          assert.throws(
            () => resolveManifestRecord({ repoRoot, branch: "matrix-branch", prNumber: 120 }),
            (error) => {
              assert.match(error.message, /No relay manifest found for branch 'matrix-branch' \+ pr '120'/);
              assert.match(error.message, new RegExp(runId));
              assert.match(error.message, new RegExp(`state=${escapeRegExp(state)}, pr=unset`));
              assert.match(error.message, new RegExp(`Close the stale ${escapeRegExp(state)} run`));
              assert.match(error.message, new RegExp(escapeRegExp(`--reason ${JSON.stringify(expectedCloseReason)}`)));
              assert.match(error.message, new RegExp(escapeRegExp(`--run-id ${JSON.stringify(runId)}`)));
              return true;
            }
          );
          assertExplicitSelectorsResolve(repoRoot, manifestPath, runId, state);
          return;
        }

        if (storedPrNumber === 120) {
          // Anti-theater: pre-#168, relay-resolver.js:177 still owned the exact-PR path. Narrowing fallback
          // must not change the direct filterByPr selector for manifests that already carry the PR number.
          const match = resolveManifestRecord({ repoRoot, branch: "matrix-branch", prNumber: 120 });
          assert.equal(match.manifestPath, manifestPath);
          assert.equal(match.data.state, state);
          assert.equal(match.data.git.pr_number, 120);
          return;
        }

        // Anti-theater: pre-#168, relay-resolver.js:177-182 would miss the stored PR and then still consider
        // branch fallback. Mismatched stored PRs must stay explicit-only for every non-terminal state.
        assert.throws(
          () => resolveManifestRecord({ repoRoot, branch: "matrix-branch", prNumber: 120 }),
          (error) => {
            assert.match(error.message, /No relay manifest found for branch 'matrix-branch' \+ pr '120'/);
            assert.match(error.message, new RegExp(runId));
            assert.match(error.message, /pr=100/);
            return true;
          }
        );
        assertExplicitSelectorsResolve(repoRoot, manifestPath, runId, state);
      });
    }
  }
});

test("resolveManifestRecord surfaces pre-whitelist ambiguity when stale escalated and stale review_pending null-pr manifests share a branch", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-ambiguity-order-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const escalatedRunId = createRunId({
    branch: "feature-auth",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const reviewPendingRunId = createRunId({
    branch: "feature-auth",
    timestamp: new Date("2026-04-03T00:10:00.000Z"),
  });
  writeManifestRecord(repoRoot, {
    runId: escalatedRunId,
    branch: "feature-auth",
    state: STATES.ESCALATED,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  writeManifestRecord(repoRoot, {
    runId: reviewPendingRunId,
    branch: "feature-auth",
    state: STATES.REVIEW_PENDING,
    updatedAt: "2026-04-03T00:10:00.000Z",
  });

  // Anti-theater: pre-#168, relay-resolver.js:181-182 counted ambiguity after pruning the stale escalated
  // candidate, so branch+PR resolution silently returned the remaining stale review_pending manifest.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 }),
    (error) => {
      assert.match(error.message, /Ambiguous relay manifest/);
      assert.match(error.message, /2 candidates/);
      assert.match(error.message, new RegExp(escalatedRunId));
      assert.match(error.message, /state=escalated, pr=unset/);
      assert.match(error.message, new RegExp(reviewPendingRunId));
      assert.match(error.message, /state=review_pending, pr=unset/);
      return true;
    }
  );
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
  assertExplicitSelectorsResolve(repoRoot, manifestPath, runId, STATES.ESCALATED);
});

test("resolveManifestRecord recovers from stale review_pending fallback after close-run and fresh dispatch", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-review-pending-recovery-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const staleRunId = createRunId({
    branch: "feature-auth",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const staleManifestPath = writeManifestRecord(repoRoot, {
    runId: staleRunId,
    branch: "feature-auth",
    state: STATES.REVIEW_PENDING,
    cleanupPolicy: "manual",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  // Anti-theater: pre-#168, relay-resolver.js:179-180 rebound this stale review_pending + pr_number:null
  // manifest to PR 120, so the operator never reached the close-run recovery path exercised below.
  // Round 2 (#168 reviewer feedback): the stale-candidate recovery message must name close-run.js
  // for every stale non-dispatched non-terminal state, not just escalated.
  const expectedCloseCommand = `node skills/relay-dispatch/scripts/close-run.js --repo ${JSON.stringify(repoRoot)} --run-id ${JSON.stringify(staleRunId)} --reason ${JSON.stringify("stale_review_pending_run")}`;
  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 }),
    (error) => {
      assert.match(error.message, new RegExp(staleRunId));
      assert.match(error.message, /Close the stale review_pending run/);
      assert.match(error.message, new RegExp(escapeRegExp(expectedCloseCommand)));
      assert.match(error.message, new RegExp(escapeRegExp(`--run-id ${JSON.stringify(staleRunId)}`)));
      return true;
    }
  );

  execFileSync("node", [
    CLOSE_RUN_SCRIPT,
    "--repo", repoRoot,
    "--run-id", staleRunId,
    "--reason", "stale_review_pending_run",
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
    state: STATES.DISPATCHED,
    cleanupPolicy: "manual",
    updatedAt: "2026-04-03T00:15:00.000Z",
  });

  const match = resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 });
  assert.equal(match.manifestPath, freshPath);
  assert.equal(match.data.run_id, freshRunId);
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
    state: STATES.DISPATCHED,
    cleanupPolicy: "manual",
    updatedAt: "2026-04-03T00:15:00.000Z",
  });

  const match = resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 });
  assert.equal(match.manifestPath, freshPath);
  assert.equal(match.data.run_id, freshRunId);
});
