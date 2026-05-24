const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildSkipComment, evaluateReviewGate } = require("../../../skills/relay-merge/scripts/review-gate");
const {
  createGrandfatheredRubricAnchor,
} = require("../../../skills/relay-dispatch/scripts/test-support");

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
  } else if (state === "grandfathered_true") {
    manifestData.anchor.rubric_path = "rubric.yaml";
    manifestData.anchor.rubric_grandfathered = true;
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: gate\n", "utf-8");
  } else if (state === "grandfathered_false") {
    manifestData.anchor.rubric_path = "rubric.yaml";
    manifestData.anchor.rubric_grandfathered = false;
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: gate\n", "utf-8");
  } else if (state === "grandfathered_object") {
    manifestData.anchor.rubric_path = "rubric.yaml";
    manifestData.anchor.rubric_grandfathered = createGrandfatheredRubricAnchor({
      actor: "review-gate-test",
    });
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: gate\n", "utf-8");
  }

  return { runDir, manifestData };
}

function createHardenedGateFixture({ advisory = "valid", strictEvidence = true } = {}) {
  const { runDir, manifestData } = createRubricStateFixture("loaded");
  const headSha = "a".repeat(40);
  manifestData.policy = { review_assurance: "hardened" };
  manifestData.review.rounds = 1;
  manifestData.review.last_reviewed_sha = headSha;
  if (advisory === "valid" || advisory === "required") {
    fs.writeFileSync(path.join(runDir, "review-round-1-advisory-opencode.json"), JSON.stringify({
      profile: "blindspot",
      summary: "advisory",
      required_findings: advisory === "required" ? [{
        title: "Required",
        body: "Must fix",
        file: "README.md",
        line: 1,
        severity: "P2",
        category: "bypass",
        confidence: 0.9,
      }] : [],
      advisory_findings: [],
      duplicate_or_low_confidence: [],
    }, null, 2), "utf-8");
  } else if (advisory === "invalid") {
    fs.writeFileSync(path.join(runDir, "review-round-1-advisory-opencode.json"), "not json\n", "utf-8");
  } else if (advisory === "forged") {
    fs.writeFileSync(path.join(runDir, "review-round-1-advisory-opencode.json"), "{}\n", "utf-8");
  } else if (advisory === "symlink") {
    const outside = path.join(os.tmpdir(), `relay-review-advisory-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(outside, JSON.stringify({
      profile: "blindspot",
      summary: "advisory",
      required_findings: [],
      advisory_findings: [],
      duplicate_or_low_confidence: [],
    }), "utf-8");
    fs.symlinkSync(outside, path.join(runDir, "review-round-1-advisory-opencode.json"));
  }
  fs.writeFileSync(path.join(runDir, "execution-evidence.json"), JSON.stringify({
    schema_version: 1,
    head_sha: headSha,
    test_command: strictEvidence ? "node --test" : "unspecified",
    test_result_hash: strictEvidence ? "a".repeat(64) : "unspecified",
    test_result_summary: "pass",
    ...(strictEvidence ? { test_exit_code: 0 } : {}),
    recorded_at: "2026-05-05T00:00:00.000Z",
    recorded_by: "dispatch-orchestrator-v1",
  }, null, 2), "utf-8");
  return { headSha, runDir, manifestData };
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

test("evaluateReviewGate enforces hardened advisory and strict execution evidence", async (t) => {
  const cases = [
    { label: "missing advisory", options: { advisory: "missing" }, status: "missing_hardened_advisory" },
    { label: "invalid advisory", options: { advisory: "invalid" }, status: "invalid_hardened_advisory" },
    { label: "forged advisory", options: { advisory: "forged" }, status: "invalid_hardened_advisory" },
    { label: "symlink advisory", options: { advisory: "symlink" }, status: "invalid_hardened_advisory" },
    { label: "required advisory finding", options: { advisory: "required" }, status: "hardened_advisory_required_findings" },
    { label: "weak execution evidence", options: { strictEvidence: false }, status: "hardened_execution_evidence_failed" },
  ];

  for (const entry of cases) {
    await t.test(entry.label, () => {
      const { headSha, runDir, manifestData } = createHardenedGateFixture(entry.options);
      const result = evaluateReviewGate({
        prNumber: 40,
        comments: [
          {
            body: "<!-- relay-review -->\n## Relay Review\nVerdict: PASS\nRounds: 1",
            createdAt: "2026-04-03T08:00:00Z",
          },
        ],
        commits: [
          {
            oid: headSha,
            committedDate: "2026-04-03T07:00:00Z",
          },
        ],
        manifestData,
        runDir,
      });

      assert.equal(result.status, entry.status);
      assert.equal(result.readyToMerge, false);
    });
  }
});

test("evaluateReviewGate accepts hardened PASS when advisory and strict evidence are present", () => {
  const { headSha, runDir, manifestData } = createHardenedGateFixture();
  const result = evaluateReviewGate({
    prNumber: 40,
    comments: [
      {
        body: "<!-- relay-review -->\n## Relay Review\nVerdict: PASS\nRounds: 1",
        createdAt: "2026-04-03T08:00:00Z",
      },
    ],
    commits: [
      {
        oid: headSha,
        committedDate: "2026-04-03T07:00:00Z",
      },
    ],
    manifestData,
    runDir,
  });

  assert.equal(result.status, "lgtm");
  assert.equal(result.readyToMerge, true);
});

test("evaluateReviewGate rejects the legacy grandfather field matrix", async (t) => {
  const cases = [
    { label: "undefined", state: "loaded", expectedStatus: "lgtm", expectedRubricStatus: "satisfied", readyToMerge: true },
    { label: "false", state: "grandfathered_false", expectedStatus: "unsupported_grandfather_field", expectedRubricStatus: "legacy_grandfather_field", readyToMerge: false },
    { label: "true", state: "grandfathered_true", expectedStatus: "unsupported_grandfather_field", expectedRubricStatus: "legacy_grandfather_field", readyToMerge: false },
    { label: "object", state: "grandfathered_object", expectedStatus: "unsupported_grandfather_field", expectedRubricStatus: "legacy_grandfather_field", readyToMerge: false },
  ];

  for (const entry of cases) {
    await t.test(entry.label, () => {
      const result = evaluatePassWithRubricState(entry.state);

      assert.equal(result.status, entry.expectedStatus);
      assert.equal(result.rubricStatus, entry.expectedRubricStatus);
      assert.equal(result.readyToMerge, entry.readyToMerge);
      if (!entry.readyToMerge) {
        assert.match(result.reason, /anchor\.rubric_grandfathered is no longer supported/);
        assert.match(result.reason, /close-run\.js/);
      }
    });
  }
});

test("buildSkipComment records only rubric_status after grandfather retirement", () => {
  const comment = buildSkipComment("hotfix", {
    rubricStatus: "legacy_grandfather_field",
  });

  assert.match(comment, /rubric_status: legacy_grandfather_field/);
  assert.doesNotMatch(comment, /rubric_grandfathered\./);
});
