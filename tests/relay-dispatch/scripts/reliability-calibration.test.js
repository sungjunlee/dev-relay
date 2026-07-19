const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCalibrationReport,
} = require("../../../skills/relay-dispatch/scripts/reliability/calibration");

function manifest(runId, taskClass, assurance, overrides = {}) {
  return {
    data: {
      run_id: runId,
      state: overrides.state || "ready_to_merge",
      policy: { review_assurance: assurance },
      review: { rounds: overrides.rounds || 1 },
      advisory: {
        guidance: {
          task_profile_summary: {
            task_class: taskClass,
            behavior_path: assurance === "compact" ? "lightweight" : "full",
          },
        },
      },
    },
  };
}

function verdict({
  round = 1,
  contract = "pass",
  surface = "pass",
  verification = "pass",
  issues = [],
  scores = [],
} = {}) {
  return {
    round,
    verdict: {
      verdict: issues.length ? "changes_requested" : "pass",
      contract_status: contract,
      quality_review_status: surface,
      quality_execution_status: verification,
      issues,
      rubric_scores: scores,
    },
  };
}

function materialIssue(overrides = {}) {
  return {
    title: "Material defect",
    confidence: "high",
    lineage: "new",
    factor: null,
    ...overrides,
  };
}

test("calibration records behavior path and assurance while separating verification from rubric value", () => {
  const manifests = [
    manifest("compact-docs", "documentation", "compact"),
    manifest("standard-code", "code", "standard", { rounds: 2 }),
  ];
  const verdictsByRun = new Map([
    ["compact-docs", [verdict({ verification: "pass" })]],
    ["standard-code", [
      verdict({
        round: 1,
        issues: [materialIssue({ factor: "API clarity" })],
        scores: [{
          factor: "API clarity",
          tier: "quality",
          status: "fail",
        }],
      }),
      verdict({
        round: 2,
        scores: [{
          factor: "API clarity",
          tier: "quality",
          status: "pass",
        }],
      }),
    ]],
  ]);

  const report = buildCalibrationReport({
    manifests,
    events: [],
    verdictsByRun,
  });

  assert.deepEqual(report.by_run["compact-docs"], {
    task_class: "documentation",
    behavior_path: "lightweight",
    assurance_tier: "compact",
    rubric_mode: "none",
    outcome_quality: {
      contract: "pass",
      user_surface: "pass",
      pass: true,
    },
    verification: { status: "pass" },
    harness_friction: {
      stalls: 0,
      recovery_actions: 0,
      manual_interventions: 0,
      total: 0,
    },
    review_yield: { material_findings: 0 },
    rubric_value: {
      earned_factors: 0,
      decision_changing_factors: 0,
    },
    safety_boundary_violations: [],
  });
  assert.equal(report.by_run["standard-code"].rubric_value.earned_factors, 1);
  assert.equal(report.by_run["standard-code"].rubric_value.decision_changing_factors, 1);
  assert.equal(report.by_run["compact-docs"].rubric_value.decision_changing_factors, 0);
});

test("calibration covers representative task classes and makes promotion decisions per class", () => {
  const requiredClasses = [
    "code",
    "design",
    "documentation",
    "operations_security",
    "data_change",
  ];
  const manifests = [];
  const verdictsByRun = new Map();

  for (const taskClass of requiredClasses) {
    const runId = `${taskClass}-full`;
    manifests.push(manifest(runId, taskClass, "standard"));
    verdictsByRun.set(runId, [verdict()]);
  }
  for (let index = 1; index <= 3; index += 1) {
    const fullRun = `code-full-${index}`;
    const lightRun = `code-light-${index}`;
    manifests.push(manifest(fullRun, "code", "standard"));
    manifests.push(manifest(lightRun, "code", "compact"));
    verdictsByRun.set(fullRun, [verdict()]);
    verdictsByRun.set(lightRun, [verdict()]);
  }

  const report = buildCalibrationReport({
    manifests,
    events: [],
    verdictsByRun,
  });

  assert.deepEqual(report.coverage.missing_task_classes, []);
  assert.ok(report.coverage.no_rubric_runs >= requiredClasses.length);
  assert.equal(
    report.promotion_decisions.code.status,
    "promote_lightweight_candidate"
  );
  assert.equal(
    report.promotion_decisions.design.status,
    "continue_calibration"
  );
  assert.equal(report.by_task_class.code.paths.lightweight.sample_size, 3);
  assert.equal(report.by_task_class.code.paths.full.sample_size, 4);
});

test("a single lightweight safety violation rolls back its task class", () => {
  const manifests = [];
  const verdictsByRun = new Map();
  for (let index = 1; index <= 3; index += 1) {
    for (const [pathName, assurance] of [["full", "standard"], ["light", "compact"]]) {
      const runId = `design-${pathName}-${index}`;
      manifests.push(manifest(runId, "design", assurance));
      verdictsByRun.set(runId, [verdict()]);
    }
  }

  const report = buildCalibrationReport({
    manifests,
    verdictsByRun,
    events: [{
      run_id: "design-light-2",
      event: "safety_boundary_violation",
      boundary: "stale_sha",
    }],
  });

  assert.equal(report.promotion_decisions.design.status, "rollback_lightweight");
  assert.deepEqual(
    report.by_run["design-light-2"].safety_boundary_violations,
    ["stale_sha"]
  );
});

test("success without required observation is an immediate lightweight rollback", () => {
  const manifests = [
    manifest("unobserved-light", "documentation", "compact"),
  ];

  const report = buildCalibrationReport({
    manifests,
    events: [],
    verdictsByRun: new Map(),
  });

  assert.deepEqual(
    report.by_run["unobserved-light"].safety_boundary_violations,
    ["success_without_required_observation"]
  );
  assert.equal(
    report.promotion_decisions.documentation.status,
    "rollback_lightweight"
  );
});

test("full-path adversarial defects block lightweight promotion for that class", () => {
  const manifests = [];
  const verdictsByRun = new Map();
  for (let index = 1; index <= 3; index += 1) {
    const fullRun = `security-full-${index}`;
    const lightRun = `security-light-${index}`;
    manifests.push(manifest(fullRun, "operations_security", "hardened"));
    manifests.push(manifest(lightRun, "operations_security", "compact"));
    verdictsByRun.set(fullRun, [verdict()]);
    verdictsByRun.set(lightRun, [verdict()]);
  }

  const report = buildCalibrationReport({
    manifests,
    verdictsByRun,
    events: [{
      run_id: "security-full-2",
      event: "advisory_review",
      status: "success",
      required_count: 1,
    }],
  });

  assert.equal(
    report.promotion_decisions.operations_security.status,
    "retain_full"
  );
  assert.deepEqual(
    report.promotion_decisions.operations_security.reasons,
    ["full_path_found_unique_material_defects"]
  );
});

test("higher lightweight material finding trend retains the full path", () => {
  const manifests = [];
  const verdictsByRun = new Map();
  for (let index = 1; index <= 3; index += 1) {
    const fullRun = `docs-full-${index}`;
    const lightRun = `docs-light-${index}`;
    manifests.push(manifest(fullRun, "documentation", "standard"));
    manifests.push(manifest(lightRun, "documentation", "compact"));
    verdictsByRun.set(fullRun, [verdict()]);
    verdictsByRun.set(lightRun, index === 2
      ? [verdict({ issues: [materialIssue()] }), verdict({ round: 2 })]
      : [verdict()]);
  }

  const report = buildCalibrationReport({ manifests, events: [], verdictsByRun });

  assert.equal(
    report.promotion_decisions.documentation.status,
    "retain_full"
  );
  assert.deepEqual(
    report.promotion_decisions.documentation.reasons,
    ["lightweight_material_finding_trend_is_higher"]
  );
});

test("legacy mechanism report distinguishes unique defects from friction-only use", () => {
  const manifests = [
    manifest("extra-round", "code", "standard", { rounds: 2 }),
    manifest("advisory-only", "operations_security", "hardened"),
  ];
  const verdictsByRun = new Map([
    ["extra-round", [
      verdict(),
      verdict({
        round: 2,
        issues: [materialIssue({ lineage: "newly_scoreable" })],
      }),
    ]],
    ["advisory-only", [verdict()]],
  ]);
  const events = [{
    run_id: "advisory-only",
    event: "advisory_review",
    status: "success",
    required_count: 0,
    advisory_count: 0,
  }];

  const report = buildCalibrationReport({ manifests, events, verdictsByRun });

  assert.equal(
    report.legacy_mechanisms.additional_review_rounds.unique_material_defects,
    1
  );
  assert.equal(
    report.legacy_mechanisms.additional_review_rounds.decision,
    "retain"
  );
  assert.equal(report.legacy_mechanisms.adversarial_review.uses, 1);
  assert.equal(
    report.legacy_mechanisms.adversarial_review.decision,
    "deletion_candidate"
  );
});
