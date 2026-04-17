const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildSkipComment, evaluateReviewGate } = require("./review-gate");
const {
  createGrandfatheredRubricAnchor,
  registerGrandfatheredRubricMigration,
} = require("../../relay-dispatch/scripts/test-support");

function createRubricStateFixture(state) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-gate-"));
  const runId = "issue-40-20260403070000000";
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const manifestData = {
    run_id: runId,
    anchor: {},
    review: {
      last_reviewed_sha: "abc123",
    },
  };

  if (state === "loaded") {
    manifestData.anchor.rubric_path = "rubric.yaml";
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: gate\n", "utf-8");
  } else if (state === "missing") {
    manifestData.anchor.rubric_path = "rubric.yaml";
  } else if (state === "outside_run_dir") {
    manifestData.anchor.rubric_path = "../escape.yaml";
  } else if (state === "empty") {
    manifestData.anchor.rubric_path = "rubric.yaml";
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "  \n", "utf-8");
  } else if (state === "invalid") {
    manifestData.anchor.rubric_path = "rubric-dir";
    fs.mkdirSync(path.join(runDir, "rubric-dir"), { recursive: true });
  } else if (state === "malformed") {
    manifestData.anchor.rubric_path = "rubric.yaml/child";
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: malformed\n", "utf-8");
  } else if (state === "symlink_escape") {
    manifestData.anchor.rubric_path = "rubric.yaml";
    const siblingTarget = path.join(runDir, "rubric-copy.yaml");
    fs.writeFileSync(siblingTarget, "rubric:\n  factors:\n    - name: symlink\n", "utf-8");
    fs.symlinkSync(siblingTarget, path.join(runDir, "rubric.yaml"));
  } else if (state === "grandfathered") {
    manifestData.anchor.rubric_grandfathered = createGrandfatheredRubricAnchor({
      actor: "review-gate-test",
    });
    registerGrandfatheredRubricMigration(runId, {
      applied_at: manifestData.anchor.rubric_grandfathered.applied_at,
      reason: manifestData.anchor.rubric_grandfathered.reason,
    });
  }

  return { runDir, manifestData };
}

function evaluatePassWithRubricState(state) {
  const { runDir, manifestData } = createRubricStateFixture(state);
  return evaluateReviewGate({
    prNumber: 40,
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: PASS\nRounds: 1",
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [
      {
        oid: "abc123",
        committedDate: "2026-04-03T07:00:00Z",
      },
    ],
    manifestData,
    runDir,
  });
}

[
  {
    state: "missing",
    status: "missing_rubric_file",
    rubricStatus: "missing",
  },
  {
    state: "outside_run_dir",
    status: "invalid_rubric_path",
    rubricStatus: "outside_run_dir",
  },
  {
    state: "empty",
    status: "empty_rubric_file",
    rubricStatus: "empty",
  },
  {
    state: "invalid",
    status: "invalid_rubric_file",
    rubricStatus: "not_file",
  },
  {
    state: "malformed",
    status: "invalid_rubric_file",
    rubricStatus: "unreadable",
  },
  {
    state: "symlink_escape",
    status: "invalid_rubric_path",
    rubricStatus: "symlink_escape",
  },
  {
    state: "not_set",
    status: "missing_rubric_path",
    rubricStatus: "missing_path",
  },
].forEach(({ state, status, rubricStatus }) => {
  test(`evaluateReviewGate checks rubric state before accepting PASS verdict when state is ${state}`, () => {
    const result = evaluatePassWithRubricState(state);

    assert.equal(result.status, status);
    assert.equal(result.rubricStatus, rubricStatus);
    assert.equal(result.readyToMerge, false);
  });
});

test("evaluateReviewGate still accepts PASS when rubric state is loaded", () => {
  const result = evaluatePassWithRubricState("loaded");

  assert.equal(result.status, "lgtm");
  assert.equal(result.rubricStatus, "satisfied");
  assert.equal(result.readyToMerge, true);
});

test("evaluateReviewGate still accepts PASS when rubric state is grandfathered", () => {
  const result = evaluatePassWithRubricState("grandfathered");

  assert.equal(result.status, "lgtm");
  assert.equal(result.rubricStatus, "grandfathered");
  assert.equal(result.rubricGrandfathered, true);
  assert.equal(result.grandfatherProvenance.actor, "review-gate-test");
  assert.equal(result.readyToMerge, true);
});

test("buildSkipComment preserves grandfather provenance in the audit comment", () => {
  const comment = buildSkipComment("hotfix", {
    rubricStatus: "grandfathered",
    grandfatherProvenance: {
      from_migration: "rubric-mandatory.yaml",
      applied_at: "2026-04-17T08:00:05.000Z",
      actor: "Relay Merge Test",
      reason: "pre-rubric run needed merge after a hotfix",
    },
  });

  assert.match(comment, /rubric_status: grandfathered/);
  assert.match(comment, /rubric_grandfathered\.from_migration: rubric-mandatory\.yaml/);
  assert.match(comment, /rubric_grandfathered\.applied_at: 2026-04-17T08:00:05\.000Z/);
  assert.match(comment, /rubric_grandfathered\.actor: Relay Merge Test/);
  assert.match(comment, /rubric_grandfathered\.reason: pre-rubric run needed merge after a hotfix/);
});
