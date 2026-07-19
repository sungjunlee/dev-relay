const UNIQUE_LINEAGE = new Set(["new", "newly_scoreable"]);

function mechanismDecision(uses, uniqueDefects) {
  if (!uses) return "insufficient_evidence";
  return uniqueDefects > 0 ? "retain" : "deletion_candidate";
}

function buildLegacyMechanisms(entries, events) {
  const extraRoundRuns = entries.filter((entry) => entry.records.length > 1);
  const extraRoundDefects = extraRoundRuns.reduce(
    (sum, entry) => sum + entry.issues.filter((issue) => (
      issue.round > 1 && UNIQUE_LINEAGE.has(issue.lineage)
    )).length,
    0
  );
  const rubricRuns = entries.filter((entry) => entry.record.rubric_mode === "earned");
  const rubricDefects = rubricRuns.reduce(
    (sum, entry) => sum + entry.record.rubric_value.decision_changing_factors,
    0
  );
  const advisoryEvents = events.filter((event) => event?.event === "advisory_review");
  const advisoryDefects = advisoryEvents.reduce(
    (sum, event) => sum + Number(event.required_count || 0),
    0
  );
  return {
    additional_review_rounds: {
      uses: extraRoundRuns.length,
      friction_units: extraRoundRuns.reduce((sum, entry) => sum + entry.records.length - 1, 0),
      unique_material_defects: extraRoundDefects,
      decision: mechanismDecision(extraRoundRuns.length, extraRoundDefects),
    },
    earned_rubric: {
      uses: rubricRuns.length,
      friction_units: rubricRuns.reduce(
        (sum, entry) => sum + entry.record.rubric_value.earned_factors,
        0
      ),
      unique_material_defects: rubricDefects,
      decision: mechanismDecision(rubricRuns.length, rubricDefects),
    },
    adversarial_review: {
      uses: advisoryEvents.length,
      friction_units: advisoryEvents.length,
      unique_material_defects: advisoryDefects,
      decision: mechanismDecision(advisoryEvents.length, advisoryDefects),
    },
  };
}

module.exports = { buildLegacyMechanisms };
