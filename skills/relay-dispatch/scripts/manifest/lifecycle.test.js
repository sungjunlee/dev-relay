const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  forceUpdateManifestState,
  validateTransitionInvariants,
  forceTransitionState,
  validateTransition,
} = require("./lifecycle");
const { ensureRunLayout } = require("./paths");

const EXPECTED_TRANSITIONS = Object.freeze({
  [STATES.DRAFT]: new Set([STATES.DISPATCHED, STATES.CLOSED]),
  [STATES.DISPATCHED]: new Set([STATES.REVIEW_PENDING, STATES.ESCALATED, STATES.CLOSED]),
  [STATES.REVIEW_PENDING]: new Set([STATES.CHANGES_REQUESTED, STATES.READY_TO_MERGE, STATES.ESCALATED, STATES.CLOSED]),
  [STATES.CHANGES_REQUESTED]: new Set([STATES.DISPATCHED, STATES.CLOSED]),
  [STATES.READY_TO_MERGE]: new Set([STATES.MERGED, STATES.CLOSED]),
  [STATES.ESCALATED]: new Set([STATES.REVIEW_PENDING, STATES.CLOSED]),
  [STATES.MERGED]: new Set(),
  [STATES.CLOSED]: new Set(),
});

function initGitRepo(repoRoot, actor = "Relay Lifecycle Test") {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", actor], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-lifecycle@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
}

function createRubricBackedManifest({ runId, rubricPath = "rubric.yaml" } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lifecycle-repo-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot);
  const { runDir } = ensureRunLayout(repoRoot, runId);
  fs.writeFileSync(path.join(runDir, rubricPath), "rubric:\n  factors:\n    - name: lifecycle\n", "utf-8");
  return {
    run_id: runId,
    state: STATES.DISPATCHED,
    anchor: { rubric_path: rubricPath },
    paths: { repo_root: repoRoot },
    timestamps: {},
  };
}

function createMissingRubricManifest({ runId, rubricPath = "rubric.yaml" } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lifecycle-missing-rubric-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot);
  ensureRunLayout(repoRoot, runId);
  return {
    run_id: runId,
    state: STATES.DISPATCHED,
    anchor: { rubric_path: rubricPath },
    paths: { repo_root: repoRoot },
    timestamps: {},
  };
}

function createLegacyGrandfatherManifest({ runId, rubricGrandfathered } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lifecycle-grandfather-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  initGitRepo(repoRoot);
  const { runDir } = ensureRunLayout(repoRoot, runId);
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: lifecycle\n", "utf-8");

  return {
    run_id: runId,
    state: STATES.DISPATCHED,
    anchor: {
      rubric_path: "rubric.yaml",
      rubric_grandfathered: rubricGrandfathered,
    },
    paths: { repo_root: repoRoot },
    timestamps: {},
  };
}

test("manifest/lifecycle validateTransition enforces the full state matrix", () => {
  const states = Object.values(STATES);
  for (const fromState of states) {
    for (const toState of states) {
      const allowed = EXPECTED_TRANSITIONS[fromState].has(toState);
      if (allowed) {
        assert.doesNotThrow(
          () => validateTransition(fromState, toState),
          `${fromState} -> ${toState} should stay allowed`
        );
      } else {
        assert.throws(
          () => validateTransition(fromState, toState),
          new RegExp(`Invalid relay state transition: ${fromState} -> ${toState}`),
          `${fromState} -> ${toState} should stay rejected`
        );
      }
    }
  }
});

test("manifest/lifecycle validateTransitionInvariants only gates dispatched -> review_pending", () => {
  const states = Object.values(STATES);
  for (const fromState of states) {
    for (const toState of states) {
      if (fromState === STATES.DISPATCHED && toState === STATES.REVIEW_PENDING) continue;
      if (fromState === STATES.ESCALATED && toState === STATES.REVIEW_PENDING) continue;
      assert.doesNotThrow(
        () => validateTransitionInvariants({}, fromState, toState),
        `${fromState} -> ${toState} should remain invariant-free`
      );
    }
  }

  assert.throws(
    () => validateTransitionInvariants(
      createMissingRubricManifest({
        runId: "issue-188-20260418091011123-a1b2c3d4",
      }),
      STATES.DISPATCHED,
      STATES.REVIEW_PENDING
    ),
    /rubric file is missing/
  );
});

test("manifest/lifecycle validateTransitionInvariants gates escalated -> review_pending on reviewer_swap_count", () => {
  assert.doesNotThrow(() => validateTransitionInvariants(
    { review: { reviewer_swap_count: 0 } },
    STATES.ESCALATED,
    STATES.REVIEW_PENDING
  ));
  assert.doesNotThrow(() => validateTransitionInvariants(
    {},
    STATES.ESCALATED,
    STATES.REVIEW_PENDING
  ));
  assert.throws(
    () => validateTransitionInvariants(
      { review: { reviewer_swap_count: 1 } },
      STATES.ESCALATED,
      STATES.REVIEW_PENDING
    ),
    /reviewer_swap_count=1 \(max 1 per run\)/
  );
});

test("manifest/lifecycle validateTransitionInvariants accepts rubric-backed gates and rejects legacy grandfather fields", () => {
  assert.doesNotThrow(() => validateTransitionInvariants(
    createRubricBackedManifest({
      runId: "issue-188-20260418091011123-a1b2c3d4",
    }),
    STATES.DISPATCHED,
    STATES.REVIEW_PENDING
  ));

  assert.throws(
    () => validateTransitionInvariants(
      createLegacyGrandfatherManifest({
        runId: "issue-188-20260418091011124-a1b2c3d4",
        rubricGrandfathered: false,
      }),
      STATES.DISPATCHED,
      STATES.REVIEW_PENDING
    ),
    /anchor\.rubric_grandfathered is no longer supported/
  );

  assert.throws(
    () => validateTransitionInvariants(
      createLegacyGrandfatherManifest({
        runId: "issue-188-20260418091011125-a1b2c3d4",
        rubricGrandfathered: true,
      }),
      STATES.DISPATCHED,
      STATES.REVIEW_PENDING
    ),
    /anchor\.rubric_grandfathered is no longer supported/
  );
});

test("manifest/lifecycle forceTransitionState keeps recovery edges but still enforces invariant and enum gates", () => {
  const updated = forceTransitionState(
    { state: STATES.CHANGES_REQUESTED, timestamps: {} },
    STATES.REVIEW_PENDING,
    "run_review"
  );
  assert.equal(updated.state, STATES.REVIEW_PENDING);
  assert.equal(updated.next_action, "run_review");

  assert.throws(
    () => forceTransitionState(
      createMissingRubricManifest({
        runId: "issue-188-20260418091011125-a1b2c3d4",
      }),
      STATES.REVIEW_PENDING,
      "run_review"
    ),
    /rubric file is missing/
  );

  assert.throws(
    () => forceTransitionState({ state: STATES.CHANGES_REQUESTED, timestamps: {} }, "not_a_state", "???"),
    /Unknown relay state/
  );
  assert.throws(
    () => forceTransitionState({ state: "bogus", timestamps: {} }, STATES.REVIEW_PENDING, "run_review"),
    /Unknown relay state/
  );
});

test("manifest/lifecycle forceUpdateManifestState annotates last_force while bypassing the transition matrix", () => {
  const updated = forceUpdateManifestState(
    { state: STATES.ESCALATED, timestamps: {} },
    STATES.MERGED,
    "manual_cleanup_required",
    { reason: "operator override", operator: "Relay Lifecycle Test" }
  );

  assert.equal(updated.state, STATES.MERGED);
  assert.equal(updated.next_action, "manual_cleanup_required");
  assert.equal(updated.last_force.from_state, STATES.ESCALATED);
  assert.equal(updated.last_force.to_state, STATES.MERGED);
  assert.equal(updated.last_force.reason, "operator override");
  assert.equal(updated.last_force.operator, "Relay Lifecycle Test");

  assert.throws(
    () => forceUpdateManifestState(
      { state: STATES.ESCALATED, timestamps: {} },
      STATES.MERGED,
      "manual_cleanup_required",
      { reason: "   " }
    ),
    /forceUpdateManifestState requires reason/
  );
});
