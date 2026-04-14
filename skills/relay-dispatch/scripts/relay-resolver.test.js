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
const ACTIVE_CLOSE_RUN_STATES = [
  STATES.DRAFT,
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

function assertSanitizedRunIdLeak(error, manifestPath, unsafeRunId) {
  assert.match(error.message, new RegExp(escapeRegExp(path.basename(manifestPath, ".md"))));
  assert.doesNotMatch(error.message, new RegExp(escapeRegExp(unsafeRunId)));
}

function writeFreshDispatchedManifest(repoRoot, branch, updatedAt = "2026-04-03T00:15:00.000Z") {
  const runId = createRunId({
    branch,
    timestamp: new Date(updatedAt),
  });
  const manifestPath = writeManifestRecord(repoRoot, {
    runId,
    branch,
    state: STATES.DISPATCHED,
    cleanupPolicy: "manual",
    updatedAt,
  });
  return { runId, manifestPath };
}

function tamperManifestState(manifestPath, stateValue) {
  const record = readManifest(manifestPath);
  const manifest = record.data;
  if (stateValue === undefined) {
    delete manifest.state;
  } else {
    manifest.state = stateValue;
  }
  writeManifest(manifestPath, manifest, record.body);
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

test("resolveManifestRecord sanitizes tampered run_id in stale-fallback recovery text", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-safe-stale-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const manifestPath = writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-auth",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    storedRunId: "../victim",
    branch: "feature-auth",
    state: STATES.REVIEW_PENDING,
    cleanupPolicy: "manual",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  // Anti-theater: without the #174 safeFormatRunId hardening at relay-resolver.js:191-208 and
  // buildNoManifestError candidate rendering at :232-240, this stale-fallback branch reused the
  // raw stored run_id in operator-facing close-run text. Sibling-field enumeration + end-to-end
  // recovery meta-rules, memory/feedback_rubric_fail_closed.md; #171/#174.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 120 }),
    (error) => {
      assert.match(error.message, /Close the stale review_pending run/);
      assertSanitizedRunIdLeak(error, manifestPath, "../victim");
      return true;
    }
  );
});

test("resolveManifestRecord sanitizes tampered run_id in mixed-state recovery text", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-safe-mixed-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const staleManifestPath = writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-auth",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    storedRunId: "../victim",
    branch: "feature-auth",
    state: STATES.MERGED,
    prNumber: 123,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-auth",
      timestamp: new Date("2026-04-03T00:10:00.000Z"),
    }),
    branch: "feature-auth",
    state: STATES.REVIEW_PENDING,
    updatedAt: "2026-04-03T00:10:00.000Z",
  });

  // Anti-theater: before the #174 mixed-state builder at relay-resolver.js:254-272 switched to
  // safeFormatRunId, the new ambiguity path echoed the tampered stored run_id verbatim. Sibling-field
  // enumeration meta-rule, memory/feedback_rubric_fail_closed.md; #171/#174.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 123 }),
    (error) => {
      assert.match(error.message, /Create a fresh dispatch for branch 'feature-auth'/);
      assertSanitizedRunIdLeak(error, staleManifestPath, "../victim");
      return true;
    }
  );
});

test("resolveManifestRecord sanitizes tampered run_id in terminal-only rejection text", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-safe-terminal-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const staleManifestPath = writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-auth",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    storedRunId: "../victim",
    branch: "feature-auth",
    state: STATES.MERGED,
    prNumber: 123,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  // Anti-theater: without the #174 safe candidate rendering in relay-resolver.js:232-240, the
  // terminal-only rejection still leaked the tampered stored run_id in the candidate list. Call-site
  // extension + sibling-field enumeration meta-rules, memory/feedback_rubric_fail_closed.md; #170/#174.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-auth", prNumber: 123 }),
    (error) => {
      assert.match(error.message, /Only terminal branch matches exist/);
      assertSanitizedRunIdLeak(error, staleManifestPath, "../victim");
      return true;
    }
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
      callerPrNumber: EXACT_PR_COLLISION_PR,
      freshState: null,
      freshPrNumber: null,
      expected: { type: "terminal-only-rejection" },
      // Anti-theater: pre-#170, relay-resolver.js:185 (`matches = filterByPr(branchMatches, 40);`)
      // returned the merged manifest because branchMatches was terminal-inclusive.
    },
    {
      label: "merged + matching stored pr + fresh dispatched + pr unset",
      terminalState: STATES.MERGED,
      callerPrNumber: EXACT_PR_COLLISION_PR,
      freshState: STATES.DISPATCHED,
      freshPrNumber: undefined,
      expected: {
        type: "match",
        state: STATES.DISPATCHED,
        prNumber: null,
      },
      // Anti-theater: pre-#170, relay-resolver.js:185 returned the merged manifest before the
      // dispatched+null branch fallback could recover the fresh run.
    },
    {
      label: "merged + matching stored pr + fresh dispatched + matching pr",
      terminalState: STATES.MERGED,
      callerPrNumber: EXACT_PR_COLLISION_PR,
      freshState: STATES.DISPATCHED,
      freshPrNumber: EXACT_PR_COLLISION_PR,
      expected: {
        type: "match",
        state: STATES.DISPATCHED,
        prNumber: EXACT_PR_COLLISION_PR,
      },
      // Anti-theater: pre-#170, filterByPr(branchMatches, 40) kept both manifests and raised
      // ambiguity. The #170 call-site fix intentionally drops the terminal sibling first, so the
      // fresh dispatched manifest wins instead of surfacing ambiguity for a stale collision.
    },
    {
      label: "merged + matching stored pr + fresh review_pending + matching pr",
      terminalState: STATES.MERGED,
      callerPrNumber: EXACT_PR_COLLISION_PR,
      freshState: STATES.REVIEW_PENDING,
      freshPrNumber: EXACT_PR_COLLISION_PR,
      expected: {
        type: "match",
        state: STATES.REVIEW_PENDING,
        prNumber: EXACT_PR_COLLISION_PR,
      },
      // The round-2 ambiguity guard must stay scoped to exact-PR misses. When the fresh
      // review_pending manifest carries the caller PR, the non-terminal exact-PR selector
      // still wins directly.
    },
    {
      label: "merged + matching stored pr + fresh review_pending + pr unset",
      terminalState: STATES.MERGED,
      callerPrNumber: EXACT_PR_COLLISION_PR,
      freshState: STATES.REVIEW_PENDING,
      freshPrNumber: undefined,
      expected: {
        type: "mixed-state-recovery",
        freshState: STATES.REVIEW_PENDING,
        freshPrLabel: "unset",
      },
      // Anti-theater: before the #174 mixed-state recovery builder at relay-resolver.js:391-394,
      // this exact-PR miss either fell into stale review_pending fallback or surfaced a generic
      // ambiguity that suggested unreachable actions. End-to-end recovery meta-rule,
      // memory/feedback_rubric_fail_closed.md; #170/#174.
    },
    {
      label: "merged + matching stored pr + fresh dispatched + pr unset + caller pr miss",
      terminalState: STATES.MERGED,
      callerPrNumber: 99,
      freshState: STATES.DISPATCHED,
      freshPrNumber: undefined,
      expected: {
        type: "match",
        state: STATES.DISPATCHED,
        prNumber: null,
      },
      // Preserve the #168 whitelist fallback: when exact-PR matching misses entirely,
      // dispatched+null must still rebind to the fresh run.
    },
    {
      label: "closed + matching stored pr + no fresh dispatch",
      terminalState: STATES.CLOSED,
      callerPrNumber: EXACT_PR_COLLISION_PR,
      freshState: null,
      freshPrNumber: null,
      expected: { type: "terminal-only-rejection" },
      // Anti-theater: pre-#170, relay-resolver.js:185 returned the closed manifest because
      // branchMatches still included terminal records on the exact-PR selector path.
    },
    {
      label: "closed + matching stored pr + fresh dispatched + pr unset",
      terminalState: STATES.CLOSED,
      callerPrNumber: EXACT_PR_COLLISION_PR,
      freshState: STATES.DISPATCHED,
      freshPrNumber: undefined,
      expected: {
        type: "match",
        state: STATES.DISPATCHED,
        prNumber: null,
      },
      // Anti-theater: pre-#170, relay-resolver.js:185 returned the stale closed manifest before
      // the dispatched+null fallback could rebind resolution to the fresh run.
    },
    {
      label: "closed + matching stored pr + fresh dispatched + matching pr",
      terminalState: STATES.CLOSED,
      callerPrNumber: EXACT_PR_COLLISION_PR,
      freshState: STATES.DISPATCHED,
      freshPrNumber: EXACT_PR_COLLISION_PR,
      expected: {
        type: "match",
        state: STATES.DISPATCHED,
        prNumber: EXACT_PR_COLLISION_PR,
      },
      // Anti-theater: pre-#170, filterByPr(branchMatches, 40) surfaced both manifests and stopped
      // in ambiguity. Post-#170, terminal siblings are excluded before exact-PR matching.
    },
    {
      label: "closed + matching stored pr + fresh review_pending + matching pr",
      terminalState: STATES.CLOSED,
      callerPrNumber: EXACT_PR_COLLISION_PR,
      freshState: STATES.REVIEW_PENDING,
      freshPrNumber: EXACT_PR_COLLISION_PR,
      expected: {
        type: "match",
        state: STATES.REVIEW_PENDING,
        prNumber: EXACT_PR_COLLISION_PR,
      },
      // The fresh review_pending manifest remains authoritative when it carries the caller PR,
      // even with a stale closed sibling on the same branch.
    },
    {
      label: "closed + matching stored pr + fresh review_pending + pr unset",
      terminalState: STATES.CLOSED,
      callerPrNumber: EXACT_PR_COLLISION_PR,
      freshState: STATES.REVIEW_PENDING,
      freshPrNumber: undefined,
      expected: {
        type: "mixed-state-recovery",
        freshState: STATES.REVIEW_PENDING,
        freshPrLabel: "unset",
      },
      // Anti-theater: before the #174 mixed-state recovery builder at relay-resolver.js:391-394,
      // this closed+review_pending post-stamp miss also surfaced the wrong recovery path. End-to-end
      // recovery meta-rule, memory/feedback_rubric_fail_closed.md; #170/#174.
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
      let freshRunId = null;
      if (testCase.freshState) {
        freshRunId = createRunId({
          branch: "feature-x",
          timestamp: new Date("2026-04-03T00:15:00.000Z"),
        });
        freshPath = writeManifestRecord(repoRoot, {
          runId: freshRunId,
          branch: "feature-x",
          state: testCase.freshState,
          ...(testCase.freshPrNumber === undefined ? {} : { prNumber: testCase.freshPrNumber }),
          updatedAt: "2026-04-03T00:15:00.000Z",
        });
      }

      if (testCase.expected.type === "terminal-only-rejection") {
        assert.throws(
          () => resolveManifestRecord({ repoRoot, branch: "feature-x", prNumber: testCase.callerPrNumber }),
          (error) => {
            assert.match(
              error.message,
              new RegExp(`No relay manifest found for branch 'feature-x' \\+ pr '${testCase.callerPrNumber}'`)
            );
            assert.match(error.message, new RegExp(staleRunId));
            assert.match(error.message, /Only terminal branch matches exist/);
            assert.match(error.message, /Create a fresh dispatch for this branch before retrying/);
            return true;
          }
        );
        return;
      }

      if (testCase.expected.type === "mixed-state-recovery") {
        assert.throws(
          () => resolveManifestRecord({ repoRoot, branch: "feature-x", prNumber: testCase.callerPrNumber }),
          (error) => {
            assert.match(error.message, /Mixed relay manifest reuse detected/);
            assert.match(error.message, new RegExp(staleRunId));
            assert.match(
              error.message,
              new RegExp(`state=${escapeRegExp(testCase.terminalState)}, pr=${EXACT_PR_COLLISION_PR}`)
            );
            assert.match(error.message, new RegExp(freshRunId));
            assert.match(
              error.message,
              new RegExp(
                `state=${escapeRegExp(testCase.expected.freshState)}, pr=${testCase.expected.freshPrLabel}`
              )
            );
            assert.match(error.message, /Create a fresh dispatch for branch 'feature-x'/);
            assert.doesNotMatch(error.message, /close-run\.js --run-id/);
            assert.doesNotMatch(error.message, /--run-id/);
            return true;
          }
        );
        return;
      }

      const match = resolveManifestRecord({ repoRoot, branch: "feature-x", prNumber: testCase.callerPrNumber });
      assert.equal(match.manifestPath, freshPath);
      assert.equal(match.data.state, testCase.expected.state);
      assert.equal(match.data.git.pr_number, testCase.expected.prNumber);
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

test("resolveManifestRecord includeTerminal:true returns a single merged manifest on standalone --pr", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-pr-only-include-terminal-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = createRunId({
    branch: "feature-pr-only",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const manifestPath = writeManifestRecord(repoRoot, {
    runId,
    branch: "feature-pr-only",
    state: STATES.MERGED,
    prNumber: EXACT_PR_COLLISION_PR,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  const match = resolveManifestRecord({
    repoRoot,
    prNumber: EXACT_PR_COLLISION_PR,
    includeTerminal: true,
  });
  assert.equal(match.manifestPath, manifestPath);
  assert.equal(match.data.run_id, runId);
  assert.equal(match.data.state, STATES.MERGED);
});

test("resolveManifestRecord includeTerminal:true keeps standalone --pr ambiguous across multiple merged matches", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-pr-only-include-terminal-ambiguous-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const firstRunId = createRunId({
    branch: "feature-pr-only-a",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const secondRunId = createRunId({
    branch: "feature-pr-only-b",
    timestamp: new Date("2026-04-03T00:10:00.000Z"),
  });
  writeManifestRecord(repoRoot, {
    runId: firstRunId,
    branch: "feature-pr-only-a",
    state: STATES.MERGED,
    prNumber: EXACT_PR_COLLISION_PR,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  writeManifestRecord(repoRoot, {
    runId: secondRunId,
    branch: "feature-pr-only-b",
    state: STATES.MERGED,
    prNumber: EXACT_PR_COLLISION_PR,
    updatedAt: "2026-04-03T00:10:00.000Z",
  });

  assert.throws(
    () => resolveManifestRecord({
      repoRoot,
      prNumber: EXACT_PR_COLLISION_PR,
      includeTerminal: true,
    }),
    (error) => {
      assert.match(error.message, /Ambiguous relay manifest for pr '40'/);
      assert.match(error.message, new RegExp(firstRunId));
      assert.match(error.message, new RegExp(secondRunId));
      return true;
    }
  );
});

test("resolveManifestRecord includeTerminal:false rejects standalone --pr terminal-only matches with actionable recovery and clean recovery chain", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-pr-only-terminal-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const staleRunId = createRunId({
    branch: "feature-pr-only",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const stalePath = writeManifestRecord(repoRoot, {
    runId: staleRunId,
    storedRunId: "../stale-run",
    branch: "feature-pr-only",
    state: STATES.MERGED,
    prNumber: EXACT_PR_COLLISION_PR,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  // Anti-theater: before the #174 standalone --pr hardening at relay-resolver.js:369-371, this
  // selector ran `filterByPr(allRecords, 40)` and silently returned the merged manifest. Call-site
  // extension meta-rule, memory/feedback_rubric_fail_closed.md; #170/#174.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, prNumber: EXACT_PR_COLLISION_PR, includeTerminal: false }),
    (error) => {
      assert.match(error.message, /No relay manifest found for pr '40'/);
      assert.match(error.message, /PR candidates:/);
      assert.match(error.message, /state=merged, pr=40/);
      assert.match(error.message, /Only terminal PR matches exist/);
      assert.match(error.message, /create a fresh dispatch that records this PR before retrying/i);
      assert.match(error.message, /pass --run-id <id> or --manifest <path> to target an existing terminal run explicitly/i);
      assert.doesNotMatch(error.message, /close-run/i);
      assert.doesNotMatch(error.message, /existing active run/i);
      assertSanitizedRunIdLeak(error, stalePath, "../stale-run");
      return true;
    }
  );
  // Recovery must hinge on a fresh dispatch that actually records the caller PR. A fresh null-pr
  // run on any branch is invisible to standalone --pr and must keep rejecting.
  writeFreshDispatchedManifest(repoRoot, "feature-pr-only", "2026-04-03T00:15:00.000Z");
  assert.throws(
    () => resolveManifestRecord({ repoRoot, prNumber: EXACT_PR_COLLISION_PR, includeTerminal: false }),
    /Only terminal PR matches exist/
  );

  // Once a fresh non-terminal manifest carries the same stored PR, standalone --pr resolves cleanly
  // to that active run while keeping the stale merged sibling explicit-only.
  const freshRunId = createRunId({
    branch: "feature-pr-only",
    timestamp: new Date("2026-04-03T00:30:00.000Z"),
  });
  const freshPath = writeManifestRecord(repoRoot, {
    runId: freshRunId,
    branch: "feature-pr-only",
    state: STATES.DISPATCHED,
    prNumber: EXACT_PR_COLLISION_PR,
    updatedAt: "2026-04-03T00:30:00.000Z",
  });

  const recovered = resolveManifestRecord({ repoRoot, prNumber: EXACT_PR_COLLISION_PR, includeTerminal: false });
  assert.equal(recovered.manifestPath, freshPath);
  assert.equal(recovered.data.run_id, freshRunId);
  assert.equal(recovered.data.state, STATES.DISPATCHED);
});

test("resolveManifestRecord rejects standalone --pr closed-only matches with the same terminal-only recovery shape", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-pr-only-closed-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const stalePath = writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-pr-only-closed",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    storedRunId: "../closed-run",
    branch: "feature-pr-only-closed",
    state: STATES.CLOSED,
    prNumber: EXACT_PR_COLLISION_PR,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  // Anti-theater: before #174, standalone --pr fed filterByPr(allRecords, 40), so the terminal
  // exact-PR selector returned closed manifests too instead of fail-closing on every terminal state.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, prNumber: EXACT_PR_COLLISION_PR }),
    (error) => {
      assert.match(error.message, /No relay manifest found for pr '40'/);
      assert.match(error.message, /PR candidates:/);
      assert.match(error.message, /state=closed, pr=40/);
      assert.match(error.message, /Only terminal PR matches exist/);
      assert.match(error.message, /create a fresh dispatch that records this PR before retrying/i);
      assert.match(error.message, /pass --run-id <id> or --manifest <path> to target an existing terminal run explicitly/i);
      assert.doesNotMatch(error.message, /close-run/i);
      assert.doesNotMatch(error.message, /existing active run/i);
      assertSanitizedRunIdLeak(error, stalePath, "../closed-run");
      return true;
    }
  );
});

test("resolveManifestRecord rejects standalone --pr when a stale terminal PR match shares a branch with a fresh null-pr run", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-pr-only-mixed-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-pr-only",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    branch: "feature-pr-only",
    state: STATES.MERGED,
    prNumber: 123,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  const freshRunId = createRunId({
    branch: "feature-pr-only",
    timestamp: new Date("2026-04-03T00:10:00.000Z"),
  });
  const freshPath = writeManifestRecord(repoRoot, {
    runId: freshRunId,
    branch: "feature-pr-only",
    state: STATES.READY_TO_MERGE,
    updatedAt: "2026-04-03T00:10:00.000Z",
  });

  // Anti-theater: before the #174 standalone --pr hardening at relay-resolver.js:369-371, the
  // stale merged exact-PR match shadowed the fresh non-terminal sibling because the call site was
  // terminal-inclusive. Call-site extension meta-rule, memory/feedback_rubric_fail_closed.md; #170/#174.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, prNumber: 123 }),
    /No relay manifest found for pr '123'/
  );
  assertExplicitSelectorsResolve(repoRoot, freshPath, freshRunId, STATES.READY_TO_MERGE);
});

test("resolveManifestRecord standalone --pr lets the cross-branch dispatched exact-PR match win over a stale merged sibling", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-pr-only-cross-branch-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-stale",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    branch: "feature-stale",
    state: STATES.MERGED,
    prNumber: EXACT_PR_COLLISION_PR,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  const freshRunId = createRunId({
    branch: "feature-fresh",
    timestamp: new Date("2026-04-03T00:10:00.000Z"),
  });
  const freshPath = writeManifestRecord(repoRoot, {
    runId: freshRunId,
    branch: "feature-fresh",
    state: STATES.DISPATCHED,
    prNumber: EXACT_PR_COLLISION_PR,
    updatedAt: "2026-04-03T00:10:00.000Z",
  });

  // Anti-theater: before #174, standalone --pr stayed terminal-inclusive and this exact-PR lookup
  // was ambiguous across both branches. Dispatched wins now because merged is filtered out before
  // the standalone --pr ambiguity check.
  const match = resolveManifestRecord({ repoRoot, prNumber: EXACT_PR_COLLISION_PR });
  assert.equal(match.manifestPath, freshPath);
  assert.equal(match.data.run_id, freshRunId);
  assert.equal(match.data.state, STATES.DISPATCHED);
});

test("resolveManifestRecord preserves standalone --pr for active exact-PR matches", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-pr-only-active-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = createRunId({
    branch: "feature-pr-only",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const manifestPath = writeManifestRecord(repoRoot, {
    runId,
    branch: "feature-pr-only",
    state: STATES.DISPATCHED,
    prNumber: 123,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  // Anti-theater: the #174 narrowing at relay-resolver.js:369-371 must stay exact-PR preserving for
  // active runs; otherwise the call-site extension fix would over-correct and strand legitimate resume
  // by PR. Call-site extension meta-rule, memory/feedback_rubric_fail_closed.md; #174.
  const match = resolveManifestRecord({ repoRoot, prNumber: 123 });
  assert.equal(match.manifestPath, manifestPath);
  assert.equal(match.data.run_id, runId);
  assert.equal(match.data.state, STATES.DISPATCHED);
});

test("resolveManifestRecord branch+PR fails closed when a bogus exact-PR sibling shares a branch with a fresh dispatched null-pr sibling", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-issue-177-branch-pr-bogus-fresh-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const stalePath = writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-x",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    branch: "feature-x",
    state: STATES.MERGED,
    prNumber: 123,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  tamperManifestState(stalePath, "bogus");
  writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-x",
      timestamp: new Date("2026-04-03T00:10:00.000Z"),
    }),
    branch: "feature-x",
    state: STATES.DISPATCHED,
    updatedAt: "2026-04-03T00:10:00.000Z",
  });

  // Pre-fix bypass at relay-resolver.js:~95 (filterByBranch excludeTerminal admitted unknown state
  // via !BRANCH_ONLY_TERMINAL_STATES.has); returned the stale bogus record in the iteration-6
  // codex challenge on 501eb8e.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-x", prNumber: 123 }),
    (error) => {
      assert.match(error.message, /No relay manifest found for branch 'feature-x' \+ pr '123'/);
      assert.match(error.message, /invalid state 'bogus'/);
      return true;
    }
  );
});

test("resolveManifestRecord branch+PR fails closed when a bogus exact-PR sibling is the only branch match", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-issue-177-branch-pr-bogus-only-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const stalePath = writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-x",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    branch: "feature-x",
    state: STATES.MERGED,
    prNumber: 123,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  tamperManifestState(stalePath, "bogus");

  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-x", prNumber: 123 }),
    (error) => {
      assert.match(error.message, /No relay manifest found for branch 'feature-x' \+ pr '123'/);
      assert.match(error.message, /invalid state 'bogus'/);
      return true;
    }
  );
});

test("resolveManifestRecord branch+PR fails closed when an exact-PR sibling is missing state", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-issue-177-branch-pr-missing-state-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const stalePath = writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-x",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    branch: "feature-x",
    state: STATES.MERGED,
    prNumber: 123,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  tamperManifestState(stalePath, undefined);

  // `undefined` is not in KNOWN_NON_TERMINAL_STATES either, so exact-PR branch resolution must
  // fail closed instead of rebinding to the stale manifest.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-x", prNumber: 123 }),
    (error) => {
      assert.match(error.message, /No relay manifest found for branch 'feature-x' \+ pr '123'/);
      assert.match(error.message, /invalid state 'unknown'/);
      return true;
    }
  );
});

test("resolveManifestRecord standalone --pr fails closed when a bogus PR match coexists with a fresh null-pr sibling", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-issue-177-pr-only-bogus-fresh-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const stalePath = writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-stale",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    branch: "feature-stale",
    state: STATES.MERGED,
    prNumber: 123,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  tamperManifestState(stalePath, "bogus");
  writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-fresh",
      timestamp: new Date("2026-04-03T00:10:00.000Z"),
    }),
    branch: "feature-fresh",
    state: STATES.DISPATCHED,
    updatedAt: "2026-04-03T00:10:00.000Z",
  });

  // Pre-fix bypass at relay-resolver.js:~82 (filterOutTerminal admitted unknown state via
  // !isTerminalState); returned the stale bogus record in the iteration-6 codex challenge on 501eb8e.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, prNumber: 123 }),
    (error) => {
      assert.match(error.message, /No relay manifest found for pr '123'/);
      assert.match(error.message, /invalid state 'bogus'/);
      return true;
    }
  );
});

test("resolveManifestRecord standalone --pr fails closed when a bogus PR match is the only candidate", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-issue-177-pr-only-bogus-only-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const stalePath = writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-pr-only",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    branch: "feature-pr-only",
    state: STATES.MERGED,
    prNumber: 123,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  tamperManifestState(stalePath, "bogus");

  assert.throws(
    () => resolveManifestRecord({ repoRoot, prNumber: 123 }),
    (error) => {
      assert.match(error.message, /No relay manifest found for pr '123'/);
      assert.match(error.message, /invalid state 'bogus'/);
      return true;
    }
  );
});

test("resolveManifestRecord standalone --pr fails closed when a PR match is missing state", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-issue-177-pr-only-missing-state-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const stalePath = writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-pr-only",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    branch: "feature-pr-only",
    state: STATES.MERGED,
    prNumber: 123,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  tamperManifestState(stalePath, undefined);

  // `undefined` is not in KNOWN_NON_TERMINAL_STATES either, so standalone --pr must reject it
  // instead of treating the missing state like a non-terminal exact-PR match.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, prNumber: 123 }),
    (error) => {
      assert.match(error.message, /No relay manifest found for pr '123'/);
      assert.match(error.message, /invalid state 'unknown'/);
      return true;
    }
  );
});

test("resolveManifestRecord preserves valid dispatched exact-PR resolution at branch+PR and standalone --pr sites", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-issue-177-dispatched-preserve-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = createRunId({
    branch: "feature-x",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const manifestPath = writeManifestRecord(repoRoot, {
    runId,
    branch: "feature-x",
    state: STATES.DISPATCHED,
    prNumber: 123,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });

  const branchMatch = resolveManifestRecord({ repoRoot, branch: "feature-x", prNumber: 123 });
  assert.equal(branchMatch.manifestPath, manifestPath);
  assert.equal(branchMatch.data.state, STATES.DISPATCHED);

  const prMatch = resolveManifestRecord({ repoRoot, prNumber: 123 });
  assert.equal(prMatch.manifestPath, manifestPath);
  assert.equal(prMatch.data.state, STATES.DISPATCHED);
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

test("resolveManifestRecord names fresh dispatch for mixed terminal plus review_pending reuse and that recovery resolves cleanly", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-mixed-e2e-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-mixed",
      timestamp: new Date("2026-04-03T00:00:00.000Z"),
    }),
    branch: "feature-mixed",
    state: STATES.MERGED,
    prNumber: 123,
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  writeManifestRecord(repoRoot, {
    runId: createRunId({
      branch: "feature-mixed",
      timestamp: new Date("2026-04-03T00:10:00.000Z"),
    }),
    branch: "feature-mixed",
    state: STATES.REVIEW_PENDING,
    updatedAt: "2026-04-03T00:10:00.000Z",
  });

  // Anti-theater: without the #174 mixed-state recovery branch at relay-resolver.js:381-394 and the
  // fresh-dispatch reachability preference at :340-355, this path either suggested unreachable
  // commands or re-opened ambiguity after the operator followed the documented recovery. End-to-end
  // recovery meta-rule, memory/feedback_rubric_fail_closed.md; #163/#170/#174.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-mixed", prNumber: 123 }),
    (error) => {
      assert.match(error.message, /Create a fresh dispatch for branch 'feature-mixed'/);
      assert.match(error.message, /close-run is a no-op/);
      assert.doesNotMatch(error.message, /close-run\.js --run-id/);
      assert.doesNotMatch(error.message, /--run-id/);
      return true;
    }
  );

  const { manifestPath: freshPath, runId: freshRunId } = writeFreshDispatchedManifest(
    repoRoot,
    "feature-mixed",
    "2026-04-03T00:20:00.000Z"
  );
  const match = resolveManifestRecord({ repoRoot, branch: "feature-mixed", prNumber: 123 });
  assert.equal(match.manifestPath, freshPath);
  assert.equal(match.data.run_id, freshRunId);
  assert.equal(match.data.state, STATES.DISPATCHED);
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

test("resolveManifestRecord rejects stale fallback candidates with invalid states instead of suggesting impossible close-run reasons", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-invalid-state-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = createRunId({
    branch: "feature-invalid",
    timestamp: new Date("2026-04-03T00:00:00.000Z"),
  });
  const manifestPath = writeManifestRecord(repoRoot, {
    runId,
    branch: "feature-invalid",
    state: STATES.REVIEW_PENDING,
    cleanupPolicy: "manual",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  const manifest = readManifest(manifestPath).data;
  manifest.state = "bogus";
  writeManifest(manifestPath, manifest);

  // Anti-theater: before the #174 invalid-state guard at relay-resolver.js:195-208, this path
  // interpolated `stale_bogus_run` into the suggested command even though close-run would reject the
  // manifest state. End-to-end recovery meta-rule, memory/feedback_rubric_fail_closed.md; #172/#174.
  assert.throws(
    () => resolveManifestRecord({ repoRoot, branch: "feature-invalid", prNumber: 120 }),
    (error) => {
      assert.match(error.message, /invalid state 'bogus'/);
      assert.doesNotMatch(error.message, /stale_bogus_run/);
      assert.doesNotMatch(error.message, /close-run\.js --run-id/);
      return true;
    }
  );
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

test("close-run remains reachable across active states named in stale-fallback recovery contracts", async (t) => {
  for (const state of ACTIVE_CLOSE_RUN_STATES) {
    await t.test(state, () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resolver-close-state-"));
      process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
      const branch = `feature-${state}`;
      const runId = createRunId({
        branch,
        timestamp: new Date("2026-04-03T00:00:00.000Z"),
      });
      const manifestPath = writeManifestRecord(repoRoot, {
        runId,
        branch,
        state,
        cleanupPolicy: "manual",
        updatedAt: "2026-04-03T00:00:00.000Z",
      });

      if (state !== STATES.DISPATCHED) {
        const expectedReason = `stale_${state}_run`;
        // Anti-theater: the #174 state whitelist in relay-resolver.js:195-208 must keep recommending
        // only close-run commands that the real state machine accepts. End-to-end recovery meta-rule,
        // memory/feedback_rubric_fail_closed.md; #163/#172/#174.
        assert.throws(
          () => resolveManifestRecord({ repoRoot, branch, prNumber: 120 }),
          (error) => {
            assert.match(error.message, new RegExp(escapeRegExp(`--reason ${JSON.stringify(expectedReason)}`)));
            assert.match(error.message, new RegExp(escapeRegExp(`--run-id ${JSON.stringify(runId)}`)));
            return true;
          }
        );
      } else {
        // Anti-theater: dispatched is the whitelist baseline. It does not emit stale-fallback recovery
        // text because relay-resolver.js:354-355 returns it directly, but close-run must still accept
        // the state so the #172 whitelist stays behaviorally true end to end.
        const match = resolveManifestRecord({ repoRoot, branch, prNumber: 120 });
        assert.equal(match.manifestPath, manifestPath);
      }

      const raw = execFileSync("node", [
        CLOSE_RUN_SCRIPT,
        "--repo", repoRoot,
        "--run-id", runId,
        "--reason", `stale_${state}_run`,
        "--json",
      ], { encoding: "utf-8" });
      const result = JSON.parse(raw);
      assert.equal(result.previousState, state);
      assert.equal(result.state, STATES.CLOSED);
      assert.equal(readManifest(manifestPath).data.state, STATES.CLOSED);

      const { manifestPath: freshPath, runId: freshRunId } = writeFreshDispatchedManifest(
        repoRoot,
        branch,
        "2026-04-03T00:15:00.000Z"
      );
      const match = resolveManifestRecord({ repoRoot, branch, prNumber: 120 });
      assert.equal(match.manifestPath, freshPath);
      assert.equal(match.data.run_id, freshRunId);
      assert.equal(match.data.state, STATES.DISPATCHED);
    });
  }
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
