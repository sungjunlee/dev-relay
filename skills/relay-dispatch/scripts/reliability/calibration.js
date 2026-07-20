const { buildLegacyMechanisms } = require("./legacy-mechanisms");
const {
  normalizedText,
  taskClassFor,
  TASK_CLASSES,
} = require("./task-class");
const RECOVERY_EVENTS = new Set([
  "recover_commit",
  "execution_evidence_rebranded",
  "state_recovery",
]);
const MANUAL_EVENTS = new Set([
  "bypass_override_by_user",
  "force_finalize",
  "conflicting_run_override",
]);
const UNIQUE_LINEAGE = new Set(["new", "newly_scoreable"]);

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

function average(values) {
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function recordsFor(verdictsByRun, runId) {
  const records = verdictsByRun instanceof Map
    ? verdictsByRun.get(runId)
    : verdictsByRun?.[runId];
  return [...(records || [])].sort((left, right) => Number(left.round) - Number(right.round));
}

function materialIssues(records) {
  return records.flatMap(({ round, verdict }) => (
    (verdict?.issues || [])
      .filter((issue) => issue?.confidence !== "low")
      .map((issue) => ({ round: Number(round), ...issue }))
  ));
}

function qualityFactorSummary(records) {
  const factors = new Map();
  for (const { verdict } of records) {
    for (const score of verdict?.rubric_scores || []) {
      if (score?.tier !== "quality" || !String(score.factor || "").trim()) continue;
      const factor = String(score.factor).trim();
      if (!factors.has(factor)) factors.set(factor, { failed: false });
      if (score.status === "fail") factors.get(factor).failed = true;
    }
  }
  return {
    earned: factors.size,
    decisionChanging: [...factors.values()].filter((factor) => factor.failed).length,
  };
}

function safetyViolations(events) {
  return events
    .filter((event) => (
      event?.event === "safety_boundary_violation"
      || event?.safety_boundary_violation === true
    ))
    .map((event) => normalizedText(event.boundary || event.violation_type) || "unknown");
}

function frictionFor(events) {
  const stalls = events.filter((event) => (
    event?.event === "dispatch_result"
    && (event.state_to === "escalated" || event.failure_class)
  )).length;
  const recoveryActions = events.filter((event) => RECOVERY_EVENTS.has(event?.event)).length;
  const manualInterventions = events.filter((event) => (
    MANUAL_EVENTS.has(event?.event) || event?.override_class
  )).length;
  return {
    stalls,
    recovery_actions: recoveryActions,
    manual_interventions: manualInterventions,
    total: stalls + recoveryActions + manualInterventions,
  };
}

function comparisonEligibility(profile) {
  const floor = normalizedText(profile.minimum_review_assurance);
  if (floor === "compact") return "included";
  if (floor === "standard" || floor === "hardened") {
    return "excluded_non_compact_floor";
  }
  return "excluded_unknown_floor";
}

function runRecord(manifest, events, verdictsByRun) {
  const data = manifest?.data || manifest || {};
  const runId = data.run_id;
  const profile = data?.advisory?.guidance?.task_profile_summary || {};
  const assurance = normalizedText(data?.policy?.review_assurance || profile.review_assurance) || "standard";
  const behaviorPath = assurance === "compact" ? "lightweight" : "full";
  const records = recordsFor(verdictsByRun, runId);
  const latest = records.at(-1)?.verdict || {};
  const factors = qualityFactorSummary(records);
  const issues = materialIssues(records);
  const runEvents = events.filter((event) => event?.run_id === runId);
  const violations = safetyViolations(runEvents);
  if (
    ["ready_to_merge", "merged"].includes(data.state)
    && (!latest.contract_status || !latest.quality_review_status)
  ) {
    violations.push("success_without_required_observation");
  }
  if (
    ["ready_to_merge", "merged"].includes(data.state)
    && data?.git?.head_sha
    && data?.review?.last_reviewed_sha
    && data.git.head_sha !== data.review.last_reviewed_sha
  ) {
    violations.push("stale_sha");
  }
  const record = {
    task_class: taskClassFor(profile),
    behavior_path: behaviorPath,
    assurance_tier: assurance,
    comparison_eligibility: comparisonEligibility(profile),
    rubric_mode: factors.earned > 0 ? "earned" : "none",
    outcome_quality: {
      contract: latest.contract_status || "not_observed",
      user_surface: latest.quality_review_status || "not_observed",
      pass: latest.contract_status === "pass" && latest.quality_review_status === "pass",
    },
    verification: { status: latest.quality_execution_status || "not_observed" },
    harness_friction: frictionFor(runEvents),
    review_yield: { material_findings: issues.length },
    rubric_value: {
      earned_factors: factors.earned,
      decision_changing_factors: factors.decisionChanging,
    },
    safety_boundary_violations: [...new Set(violations)],
  };
  return {
    runId,
    record,
    records,
    issues,
    adversarialUniqueDefects: runEvents
      .filter((event) => event?.event === "advisory_review")
      .reduce((sum, event) => sum + Number(event.required_count || 0), 0),
  };
}

function summarizePath(entries, observedSampleSize = entries.length) {
  const records = entries.map((entry) => entry.record);
  return {
    sample_size: records.length,
    observed_sample_size: observedSampleSize,
    excluded_sample_size: observedSampleSize - records.length,
    outcome_quality_pass_rate: ratio(
      records.filter((record) => record.outcome_quality.pass).length,
      records.length
    ),
    verification_pass_rate: ratio(
      records.filter((record) => record.verification.status === "pass").length,
      records.length
    ),
    avg_harness_friction: average(records.map((record) => record.harness_friction.total)),
    material_findings: records.reduce(
      (sum, record) => sum + record.review_yield.material_findings,
      0
    ),
    material_finding_rate: ratio(
      records.reduce((sum, record) => sum + record.review_yield.material_findings, 0),
      records.length
    ),
    rubric_value_decisions: records.reduce(
      (sum, record) => sum + record.rubric_value.decision_changing_factors,
      0
    ),
    safety_boundary_violations: records.reduce(
      (sum, record) => sum + record.safety_boundary_violations.length,
      0
    ),
    rubric_modes: {
      earned: records.filter((record) => record.rubric_mode === "earned").length,
      none: records.filter((record) => record.rubric_mode === "none").length,
    },
  };
}

function uniqueMechanismDefects(entry) {
  const laterReviewDefects = entry.issues.filter((issue) => (
    issue.round > 1 && UNIQUE_LINEAGE.has(issue.lineage)
  )).length;
  return laterReviewDefects
    + entry.record.rubric_value.decision_changing_factors
    + entry.adversarialUniqueDefects;
}

function promotionDecision(
  full,
  lightweight,
  fullEntries,
  minimumSampleSize,
  lightweightSafetyViolations
) {
  if (
    lightweightSafetyViolations > 0
    || full.safety_boundary_violations > 0
  ) {
    return { status: "rollback_lightweight", reasons: ["safety_boundary_violation"] };
  }
  const insufficientReasons = [];
  if (full.sample_size < minimumSampleSize) {
    insufficientReasons.push("insufficient_comparable_full_samples");
  }
  if (lightweight.sample_size < minimumSampleSize) {
    insufficientReasons.push("insufficient_comparable_lightweight_samples");
  }
  if (insufficientReasons.length > 0) {
    return { status: "continue_calibration", reasons: insufficientReasons };
  }
  if (lightweight.outcome_quality_pass_rate < full.outcome_quality_pass_rate) {
    return { status: "retain_full", reasons: ["lightweight_outcome_trend_is_lower"] };
  }
  if (lightweight.material_finding_rate > full.material_finding_rate) {
    return { status: "retain_full", reasons: ["lightweight_material_finding_trend_is_higher"] };
  }
  if (fullEntries.reduce((sum, entry) => sum + uniqueMechanismDefects(entry), 0) > 0) {
    return { status: "retain_full", reasons: ["full_path_found_unique_material_defects"] };
  }
  if (lightweight.avg_harness_friction > full.avg_harness_friction) {
    return { status: "retain_full", reasons: ["lightweight_harness_friction_is_higher"] };
  }
  return { status: "promote_lightweight_candidate", reasons: ["quality_preserved_with_no_more_friction"] };
}

function buildCalibrationReport({
  manifests = [],
  events = [],
  verdictsByRun = new Map(),
  minimumSampleSize = 3,
}) {
  const entries = manifests
    .map((manifest) => runRecord(manifest, events, verdictsByRun))
    .filter((entry) => entry.runId);
  const byRun = Object.fromEntries(entries.map(({ runId, record }) => [runId, record]));
  const byTaskClass = {};
  const promotionDecisions = {};
  for (const taskClass of TASK_CLASSES) {
    const classEntries = entries.filter((entry) => entry.record.task_class === taskClass);
    const observedFullEntries = classEntries.filter(
      (entry) => entry.record.behavior_path === "full"
    );
    const observedLightEntries = classEntries.filter(
      (entry) => entry.record.behavior_path === "lightweight"
    );
    const fullEntries = observedFullEntries.filter(
      (entry) => entry.record.comparison_eligibility === "included"
    );
    const lightEntries = observedLightEntries.filter(
      (entry) => entry.record.comparison_eligibility === "included"
    );
    const full = summarizePath(fullEntries, observedFullEntries.length);
    const lightweight = summarizePath(lightEntries, observedLightEntries.length);
    byTaskClass[taskClass] = { paths: { full, lightweight } };
    promotionDecisions[taskClass] = promotionDecision(
      full,
      lightweight,
      fullEntries,
      minimumSampleSize,
      observedLightEntries.reduce(
        (sum, entry) => sum + entry.record.safety_boundary_violations.length,
        0
      )
    );
  }
  const coverageCounts = Object.fromEntries(TASK_CLASSES.map((taskClass) => [
    taskClass,
    entries.filter((entry) => entry.record.task_class === taskClass).length,
  ]));
  return {
    minimum_sample_size_per_path: minimumSampleSize,
    coverage: {
      by_task_class: coverageCounts,
      missing_task_classes: TASK_CLASSES.filter((taskClass) => coverageCounts[taskClass] === 0),
      no_rubric_runs: entries.filter((entry) => entry.record.rubric_mode === "none").length,
    },
    by_run: byRun,
    by_task_class: byTaskClass,
    promotion_decisions: promotionDecisions,
    legacy_mechanisms: buildLegacyMechanisms(entries, events),
  };
}

module.exports = {
  buildCalibrationReport,
  TASK_CLASSES,
};
