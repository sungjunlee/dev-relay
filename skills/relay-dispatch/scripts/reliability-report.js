#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { STATES } = require("./manifest/lifecycle");
const { getRunDir } = require("./manifest/paths");
const { readTextFileWithoutFollowingSymlinks } = require("./manifest/rubric");
const { listManifestRecords } = require("./manifest/store");
const { modeLabel, readArg, schemaHasFlag } = require("./cli-args");
const { EVENTS, readAllRunEvents } = require("./relay-events");
const { extractAllFactors } = require("../../relay-plan/scripts/tdd-flavor");

const args = process.argv.slice(2);
const CLI_ARG_OPTIONS = { commandName: "reliability-report", reservedFlags: ["-h"] };
const hasCliFlag = (flag) => schemaHasFlag(args, flag, CLI_ARG_OPTIONS);
const NO_GUIDANCE_DATA_TEXT = "no guidance data available";
const LINEAGE_VALUES = ["deepening", "repeat", "stale", "new", "newly_scoreable", "unknown"];

if (hasCliFlag(["--help", "-h"])) {
  console.log(
    "Usage: reliability-report.js [--repo <path>] [--stale-hours <hours>] " +
    "[--json] [--by-actor] [--by-role] [--by-acting-reviewer] [--by-dispatch]"
  );
  console.log("\nOptions:");
  console.log(`  --repo <path>           ${modeLabel("--repo")} Repository root (default: .)`);
  console.log(`  --stale-hours <hours>   ${modeLabel("--stale-hours")} Stale open-run threshold (default: 72)`);
  console.log(`  --json                  ${modeLabel("--json")} Output JSON`);
  console.log(`  --by-actor              ${modeLabel("--by-actor")} Include actor breakdown`);
  console.log(`  --by-role               ${modeLabel("--by-role")} Include role breakdown`);
  console.log(`  --by-acting-reviewer    ${modeLabel("--by-acting-reviewer")} Include acting reviewer breakdown`);
  console.log(`  --by-dispatch           ${modeLabel("--by-dispatch")} Include executor/model/provider breakdown`);
  process.exit(0);
}

function parseHours(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--stale-hours must be a non-negative number");
  }
  return parsed;
}

function ratio(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function average(values) {
  if (!values.length) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number((total / values.length).toFixed(4));
}

function normalizeActorName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function normalizeRoleName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

const normalizeDispatchKey = normalizeRoleName;

function normalizeGuidancePacks(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const entry of value) {
    const pack = typeof entry === "string" ? entry.trim() : "";
    if (pack && !result.includes(pack)) {
      result.push(pack);
    }
  }
  return result;
}

function hasRecordedReviewActivity(data) {
  return (
    Number(data?.review?.rounds || 0) > 0
    || (typeof data?.review?.last_reviewer === "string" && data.review.last_reviewer.trim())
    || (typeof data?.review?.last_reviewed_sha === "string" && data.review.last_reviewed_sha.trim())
  );
}

function isSystemReviewApplyEvent(event) {
  return event?.event === EVENTS.REVIEW_APPLY && event?.origin === "system";
}

function isLegacyReviewerlessReviewApplyEvent(event) {
  return (
    event?.event === EVENTS.REVIEW_APPLY
    && (event?.reviewer === undefined || event?.reviewer === null)
  );
}

function buildEmptyRubricInsights() {
  return {
    quality_grade_distribution: null,
    avg_quality_ratio: null,
    tier_effectiveness: null,
    divergence_hotspots: null,
    auto_vs_eval_correlation: null,
  };
}

function normalizeAutoCoverageRatio(event) {
  const autoCoverage = Number(event?.auto_coverage);
  if (!Number.isFinite(autoCoverage)) return null;
  if (autoCoverage >= 0 && autoCoverage <= 1) {
    return autoCoverage;
  }

  const totalChecks = Number(event?.prerequisites || 0)
    + Number(event?.contract_factors || 0)
    + Number(event?.quality_factors || 0);
  if (!Number.isFinite(totalChecks) || totalChecks <= 0) {
    return null;
  }
  return Number((autoCoverage / totalChecks).toFixed(4));
}

function buildTierEffectiveness(events) {
  const runFactors = new Map();

  for (const event of events) {
    if (event.event !== EVENTS.ITERATION_SCORE || !event.run_id || !Array.isArray(event.scores)) continue;
    const round = Number(event.round);
    const roundNumber = Number.isFinite(round) ? round : null;

    if (!runFactors.has(event.run_id)) {
      runFactors.set(event.run_id, new Map());
    }

    const factorsForRun = runFactors.get(event.run_id);
    for (const score of event.scores) {
      const tier = typeof score?.tier === "string" ? score.tier : null;
      const factor = typeof score?.factor === "string" ? score.factor.trim() : "";
      if (!factor || (tier !== "contract" && tier !== "quality")) continue;

      const key = `${tier}\u0000${factor}`;
      if (!factorsForRun.has(key)) {
        factorsForRun.set(key, {
          tier,
          met: false,
          firstMetRound: null,
        });
      }

      if (score.met === true) {
        const current = factorsForRun.get(key);
        current.met = true;
        if (roundNumber !== null && (current.firstMetRound === null || roundNumber < current.firstMetRound)) {
          current.firstMetRound = roundNumber;
        }
      }
    }
  }

  const aggregate = {
    contract: { appearances: 0, metRuns: 0, roundsToMet: [] },
    quality: { appearances: 0, metRuns: 0, roundsToMet: [] },
  };

  for (const factorsForRun of runFactors.values()) {
    for (const state of factorsForRun.values()) {
      aggregate[state.tier].appearances += 1;
      if (state.met) {
        aggregate[state.tier].metRuns += 1;
        if (state.firstMetRound !== null) {
          aggregate[state.tier].roundsToMet.push(state.firstMetRound);
        }
      }
    }
  }

  if (aggregate.contract.appearances === 0 && aggregate.quality.appearances === 0) {
    return null;
  }

  return {
    contract: {
      avg_met_rate: ratio(aggregate.contract.metRuns, aggregate.contract.appearances),
      avg_rounds_to_met: average(aggregate.contract.roundsToMet),
    },
    quality: {
      avg_met_rate: ratio(aggregate.quality.metRuns, aggregate.quality.appearances),
      avg_rounds_to_met: average(aggregate.quality.roundsToMet),
    },
  };
}

function buildDivergenceHotspots(events) {
  const divergenceEvents = events.filter((event) => event.event === EVENTS.SCORE_DIVERGENCE && Array.isArray(event.divergences));
  if (divergenceEvents.length === 0) return null;

  const grouped = new Map();
  for (const event of divergenceEvents) {
    for (const entry of event.divergences) {
      const factor = typeof entry?.factor === "string" ? entry.factor.trim() : "";
      const delta = Number(entry?.delta);
      if (!factor || !Number.isFinite(delta)) continue;

      if (!grouped.has(factor)) {
        grouped.set(factor, {
          occurrences: 0,
          deltas: [],
        });
      }
      const current = grouped.get(factor);
      current.occurrences += 1;
      current.deltas.push(delta);
    }
  }

  if (grouped.size === 0) return null;

  return [...grouped.entries()]
    .map(([factorPattern, summary]) => {
      const avgDelta = average(summary.deltas);
      let recommendation = "Review scoring examples for this factor.";
      if (avgDelta !== null && avgDelta >= 0.5) {
        recommendation = "Executor scores trend higher than review; tighten examples or add automation.";
      } else if (avgDelta !== null && avgDelta <= -0.5) {
        recommendation = "Reviewer scores trend higher than executor; check whether the factor is underspecified.";
      }

      return {
        factor_pattern: factorPattern,
        occurrences: summary.occurrences,
        avg_delta: avgDelta,
        recommendation,
      };
    })
    .sort((left, right) => (
      right.occurrences - left.occurrences
      || Math.abs(right.avg_delta || 0) - Math.abs(left.avg_delta || 0)
      || left.factor_pattern.localeCompare(right.factor_pattern)
    ));
}

function buildAutoVsEvalCorrelation(rubricQualityEvents, manifests) {
  const manifestsByRun = new Map(
    manifests
      .filter((manifest) => manifest?.data?.run_id)
      .map((manifest) => [manifest.data.run_id, manifest.data])
  );

  const latestQualityByRun = new Map();
  for (const event of rubricQualityEvents) {
    if (event?.run_id) {
      latestQualityByRun.set(event.run_id, event);
    }
  }

  const buckets = {
    high_auto_runs: [],
    low_auto_runs: [],
  };

  for (const [runId, event] of latestQualityByRun.entries()) {
    const manifest = manifestsByRun.get(runId);
    if (!manifest) continue;

    const coverageRatio = normalizeAutoCoverageRatio(event);
    if (coverageRatio === null) continue;

    const bucketName = coverageRatio >= 0.5 ? "high_auto_runs" : "low_auto_runs";
    buckets[bucketName].push({
      rounds: Number(manifest.review?.rounds),
      success: [STATES.READY_TO_MERGE, STATES.MERGED].includes(manifest.state),
    });
  }

  if (buckets.high_auto_runs.length === 0 && buckets.low_auto_runs.length === 0) {
    return null;
  }

  function summarizeBucket(entries) {
    const rounds = entries
      .map((entry) => entry.rounds)
      .filter((value) => Number.isFinite(value) && value >= 0);
    return {
      avg_rounds: average(rounds),
      success_rate: ratio(entries.filter((entry) => entry.success).length, entries.length),
    };
  }

  return {
    high_auto_runs: summarizeBucket(buckets.high_auto_runs),
    low_auto_runs: summarizeBucket(buckets.low_auto_runs),
  };
}

function buildRubricInsights(events, manifests) {
  const insights = buildEmptyRubricInsights();
  const rubricQualityEvents = events.filter((event) => event.event === EVENTS.RUBRIC_QUALITY);

  if (rubricQualityEvents.length > 0) {
    insights.quality_grade_distribution = { A: 0, B: 0, C: 0, D: 0 };
    const qualityRatios = [];

    for (const event of rubricQualityEvents) {
      if (Object.hasOwn(insights.quality_grade_distribution, event.grade)) {
        insights.quality_grade_distribution[event.grade] += 1;
      }
      if (typeof event.quality_ratio === "number" && !Number.isNaN(event.quality_ratio)) {
        qualityRatios.push(event.quality_ratio);
      }
    }

    insights.avg_quality_ratio = average(qualityRatios);
  }

  insights.tier_effectiveness = buildTierEffectiveness(events);
  insights.divergence_hotspots = buildDivergenceHotspots(events);
  insights.auto_vs_eval_correlation = buildAutoVsEvalCorrelation(rubricQualityEvents, manifests);

  return insights;
}

function hasRubricInsights(insights) {
  return Object.values(insights || {}).some((value) => value !== null);
}

function buildFactorAnalysis(events) {
  const factorsByRun = new Map();

  for (const event of events) {
    if (event.event !== EVENTS.ITERATION_SCORE || !event.run_id) continue;
    if (!Array.isArray(event.scores) || event.scores.length === 0) continue;

    const round = Number(event.round);
    const roundNumber = Number.isFinite(round) ? round : null;
    if (!factorsByRun.has(event.run_id)) {
      factorsByRun.set(event.run_id, new Map());
    }

    const runFactors = factorsByRun.get(event.run_id);
    for (const score of event.scores) {
      const factor = typeof score?.factor === "string" ? score.factor.trim() : "";
      if (!factor) continue;

      if (!runFactors.has(factor)) {
        runFactors.set(factor, {
          met: false,
          firstMetRound: null,
        });
      }

      if (score.met === true) {
        const current = runFactors.get(factor);
        current.met = true;
        if (roundNumber !== null && (current.firstMetRound === null || roundNumber < current.firstMetRound)) {
          current.firstMetRound = roundNumber;
        }
      }
    }
  }

  const aggregatedFactors = new Map();
  for (const runFactors of factorsByRun.values()) {
    for (const [factor, state] of runFactors.entries()) {
      if (!aggregatedFactors.has(factor)) {
        aggregatedFactors.set(factor, {
          appearances: 0,
          metRuns: 0,
          roundsToMet: [],
        });
      }

      const summary = aggregatedFactors.get(factor);
      summary.appearances += 1;
      if (state.met) {
        summary.metRuns += 1;
        if (state.firstMetRound !== null) {
          summary.roundsToMet.push(state.firstMetRound);
        }
      }
    }
  }

  const factors = {};
  let mostStuckFactor = null;
  let lowestMetRate = null;

  for (const factor of [...aggregatedFactors.keys()].sort((a, b) => a.localeCompare(b))) {
    const summary = aggregatedFactors.get(factor);
    const metRate = ratio(summary.metRuns, summary.appearances);
    factors[factor] = {
      appearances: summary.appearances,
      met_rate: metRate,
      avg_rounds_to_met: average(summary.roundsToMet),
    };

    if (mostStuckFactor === null || metRate < lowestMetRate) {
      mostStuckFactor = factor;
      lowestMetRate = metRate;
    }
  }

  return {
    factors,
    most_stuck_factor: mostStuckFactor,
  };
}

function factorAnalysisToStuckFactors(factorAnalysis) {
  return Object.entries(factorAnalysis?.factors || {})
    .map(([factor, summary]) => ({
      factor,
      appearances: summary.appearances,
      met_rate: summary.met_rate,
      avg_rounds_to_met: summary.avg_rounds_to_met,
    }))
    .sort((left, right) => (
      (left.met_rate ?? Number.POSITIVE_INFINITY) - (right.met_rate ?? Number.POSITIVE_INFINITY)
      || right.appearances - left.appearances
      || left.factor.localeCompare(right.factor)
    ));
}

function buildGuidanceRunIndex(manifests, events) {
  const packsByRun = new Map();

  function addRunPacks(runId, guidancePacks) {
    if (!runId) return;
    const packs = normalizeGuidancePacks(guidancePacks);
    if (packs.length === 0) return;
    if (!packsByRun.has(runId)) {
      packsByRun.set(runId, new Set());
    }
    const runPacks = packsByRun.get(runId);
    for (const pack of packs) {
      runPacks.add(pack);
    }
  }

  for (const manifest of manifests) {
    addRunPacks(
      manifest?.data?.run_id,
      manifest?.data?.advisory?.guidance?.guidance_packs
    );
  }

  for (const event of events) {
    if (event?.event === EVENTS.GUIDANCE_SELECTED) {
      addRunPacks(event.run_id, event.guidance_packs);
    }
  }

  return packsByRun;
}

function hasChangesRequestedOutcome(manifest, events) {
  if (events.some((event) => (
    event.event === EVENTS.REVIEW_APPLY
    && (
      event.state_to === STATES.CHANGES_REQUESTED
      || event.reason === "changes_requested"
    )
  ))) {
    return true;
  }

  const data = manifest?.data;
  return (
    data?.state === STATES.CHANGES_REQUESTED
    || data?.review?.latest_verdict === "changes_requested"
  );
}

function buildPackDivergenceSummary(events) {
  const divergenceEvents = events.filter((event) => (
    event.event === EVENTS.SCORE_DIVERGENCE
    && Array.isArray(event.divergences)
  ));
  const deltas = [];

  for (const event of divergenceEvents) {
    for (const entry of event.divergences) {
      const delta = Number(entry?.delta);
      if (Number.isFinite(delta)) {
        deltas.push(delta);
      }
    }
  }

  return {
    occurrences: deltas.length,
    avg_delta: average(deltas),
    hotspots: buildDivergenceHotspots(divergenceEvents) || [],
  };
}

function buildGuidancePackInsights(manifests, events) {
  const packsByRun = buildGuidanceRunIndex(manifests, events);
  if (packsByRun.size === 0) {
    return {
      status: NO_GUIDANCE_DATA_TEXT,
      packs: {},
    };
  }

  const manifestsByRun = new Map(
    manifests
      .filter((manifest) => manifest?.data?.run_id)
      .map((manifest) => [manifest.data.run_id, manifest])
  );
  const eventsByRun = new Map();
  for (const event of events) {
    if (!event?.run_id) continue;
    if (!eventsByRun.has(event.run_id)) {
      eventsByRun.set(event.run_id, []);
    }
    eventsByRun.get(event.run_id).push(event);
  }

  const runIdsByPack = new Map();
  for (const [runId, packs] of packsByRun.entries()) {
    for (const pack of packs) {
      if (!runIdsByPack.has(pack)) {
        runIdsByPack.set(pack, new Set());
      }
      runIdsByPack.get(pack).add(runId);
    }
  }

  const packSummaries = {};
  for (const pack of [...runIdsByPack.keys()].sort((left, right) => left.localeCompare(right))) {
    const runIds = runIdsByPack.get(pack);
    const packManifests = [...runIds]
      .map((runId) => manifestsByRun.get(runId))
      .filter(Boolean);
    const packEvents = events.filter((event) => runIds.has(event.run_id));
    const reviewRounds = packManifests
      .map((manifest) => Number(manifest.data?.review?.rounds))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const changesRequestedRuns = [...runIds].filter((runId) => (
      hasChangesRequestedOutcome(
        manifestsByRun.get(runId),
        eventsByRun.get(runId) || []
      )
    ));

    packSummaries[pack] = {
      usage_count: runIds.size,
      avg_review_rounds: average(reviewRounds),
      changes_requested_rate: ratio(changesRequestedRuns.length, runIds.size),
      stuck_factors: factorAnalysisToStuckFactors(buildFactorAnalysis(packEvents)),
      executor_reviewer_divergence: buildPackDivergenceSummary(packEvents),
    };
  }

  return {
    status: "available",
    packs: packSummaries,
  };
}

function normalizeBucketValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function sidecarEventKey(event) {
  const runId = normalizeBucketValue(event?.run_id);
  const sidecarId = normalizeBucketValue(event?.sidecar_id);
  return `${runId}\u0000${sidecarId}`;
}

function incrementInvocationBucket(buckets, key) {
  if (!buckets.has(key)) {
    buckets.set(key, { invocations: 0, successes: 0, failures: 0 });
  }
  buckets.get(key).invocations += 1;
}

function incrementOutcomeBucket(buckets, key, outcome) {
  if (!buckets.has(key)) {
    buckets.set(key, { invocations: 0, successes: 0, failures: 0 });
  }
  buckets.get(key)[outcome] += 1;
}

function sortSummaryObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function incrementCountBucket(buckets, key) {
  const bucketKey = normalizeBucketValue(key);
  buckets.set(bucketKey, (buckets.get(bucketKey) || 0) + 1);
}

function sortCountBuckets(buckets) {
  return sortSummaryObject(buckets.entries());
}

function emptyLineageCounts() {
  return Object.fromEntries(LINEAGE_VALUES.map((value) => [value, 0]));
}

function addLineageCounts(target, source) {
  for (const value of LINEAGE_VALUES) {
    target[value] = Number(target[value] || 0) + Number(source?.[value] || 0);
  }
}

function summarizeIssueLineage(issues) {
  const summary = emptyLineageCounts();
  for (const issue of Array.isArray(issues) ? issues : []) {
    const lineage = LINEAGE_VALUES.includes(issue?.lineage) ? issue.lineage : "unknown";
    summary[lineage] += 1;
  }
  return summary;
}

function reviewRoundNumber(fileName) {
  const match = /^review-round-(\d+)-verdict\.json$/.exec(fileName);
  return match ? Number(match[1]) : null;
}

function readReviewLineageRounds(repoRoot, runId) {
  let entries;
  let runDir;
  try {
    runDir = getRunDir(repoRoot, runId);
    entries = fs.readdirSync(runDir, { withFileTypes: true });
  } catch {
    return {};
  }
  const rounds = {};
  for (const entry of entries) {
    const round = entry.isFile() ? reviewRoundNumber(entry.name) : null;
    if (round === null) continue;
    try {
      const verdict = JSON.parse(readTextFileWithoutFollowingSymlinks(path.join(runDir, entry.name)));
      rounds[String(round)] = summarizeIssueLineage(verdict?.issues);
    } catch {
      // Best-effort analytics must not block the rest of the report.
    }
  }
  return Object.fromEntries(Object.entries(rounds).sort(([left], [right]) => Number(left) - Number(right)));
}

function buildReviewLineageSummary({ repoRoot, manifests }) {
  const totals = emptyLineageCounts();
  const byRun = {};
  const byRound = {};
  for (const manifest of manifests) {
    const runId = manifest?.data?.run_id;
    if (!runId) continue;
    const rounds = readReviewLineageRounds(repoRoot, runId);
    if (Object.keys(rounds).length === 0) continue;
    const runTotals = emptyLineageCounts();
    for (const [round, summary] of Object.entries(rounds)) {
      addLineageCounts(runTotals, summary);
      addLineageCounts(totals, summary);
      if (!byRound[round]) byRound[round] = emptyLineageCounts();
      addLineageCounts(byRound[round], summary);
    }
    byRun[runId] = { totals: runTotals, rounds };
  }
  return { totals, by_run: byRun, by_round: byRound };
}

function buildSidecarOutcomeBuckets(starts, results, failures, fieldName) {
  const buckets = new Map();
  const startBucketsBySidecar = new Map();

  for (const event of starts) {
    const bucketKey = normalizeBucketValue(event?.[fieldName]);
    startBucketsBySidecar.set(sidecarEventKey(event), bucketKey);
    incrementInvocationBucket(buckets, bucketKey);
  }

  for (const event of results) {
    const bucketKey = startBucketsBySidecar.get(sidecarEventKey(event)) || normalizeBucketValue(event?.[fieldName]);
    incrementOutcomeBucket(buckets, bucketKey, "successes");
  }

  for (const event of failures) {
    const bucketKey = startBucketsBySidecar.get(sidecarEventKey(event)) || normalizeBucketValue(event?.[fieldName]);
    incrementOutcomeBucket(buckets, bucketKey, "failures");
  }

  return sortSummaryObject(buckets.entries());
}

const OVERRIDE_AUDIT_EVENT_NAMES = new Set([
  EVENTS.EXECUTION_EVIDENCE_REBRANDED,
  EVENTS.FORCE_FINALIZE,
]);

function hasOwnField(value, fieldName) {
  return Object.prototype.hasOwnProperty.call(value || {}, fieldName);
}

function hasNonEmptyField(value, fieldName) {
  return hasOwnField(value, fieldName) && String(value[fieldName] ?? "").trim() !== "";
}

function isOverrideAuditEvent(event) {
  return Boolean(event?.override_class !== undefined || OVERRIDE_AUDIT_EVENT_NAMES.has(event?.event));
}

function overrideTransitionKey(event) {
  return `${normalizeBucketValue(event?.prior_state || event?.state_from)}->${normalizeBucketValue(event?.state_to)}`;
}

function buildOverrideAuditSummary(events) {
  const auditEvents = events.filter(isOverrideAuditEvent);
  const byOverrideClass = new Map();
  const byOperatorInitiated = new Map();
  const affectedTransitions = new Map();
  const fieldPresence = {
    affected_head_sha: { present: 0, missing: 0 },
    required_reason: { present: 0, missing: 0 },
  };
  const findings = [];
  let currentShapeEvents = 0;
  let legacyShapeEvents = 0;

  for (const event of auditEvents) {
    const currentShape = hasOwnField(event, "override_class");
    if (currentShape) {
      currentShapeEvents += 1;
    } else {
      legacyShapeEvents += 1;
    }

    incrementCountBucket(
      byOverrideClass,
      hasNonEmptyField(event, "override_class") ? event.override_class : "unknown"
    );
    incrementCountBucket(
      byOperatorInitiated,
      typeof event.operator_initiated === "boolean" ? String(event.operator_initiated) : "unknown"
    );
    incrementCountBucket(affectedTransitions, overrideTransitionKey(event));

    const missingFields = [];
    for (const fieldName of Object.keys(fieldPresence)) {
      const presenceKey = hasNonEmptyField(event, fieldName) ? "present" : "missing";
      fieldPresence[fieldName][presenceKey] += 1;
      if (currentShape && presenceKey === "missing") {
        missingFields.push(fieldName);
      }
    }

    if (missingFields.length > 0) {
      findings.push({
        run_id: event.run_id || "unknown",
        event: event.event || "unknown",
        override_class: hasNonEmptyField(event, "override_class") ? event.override_class : "unknown",
        missing_fields: missingFields,
      });
    }
  }

  return {
    total_events: auditEvents.length,
    current_shape_events: currentShapeEvents,
    legacy_shape_events: legacyShapeEvents,
    malformed_current_shape_events: findings.length,
    by_override_class: sortCountBuckets(byOverrideClass),
    by_operator_initiated: sortCountBuckets(byOperatorInitiated),
    field_presence: fieldPresence,
    affected_transitions: sortCountBuckets(affectedTransitions),
    findings,
  };
}

function buildSidecarCountBuckets(starts, fieldName) {
  const buckets = new Map();
  for (const event of starts) {
    const bucketKey = normalizeBucketValue(event?.[fieldName]);
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, { invocations: 0 });
    }
    buckets.get(bucketKey).invocations += 1;
  }
  return sortSummaryObject(buckets.entries());
}

function readReviewIssueTitles(runDir) {
  let entries;
  try {
    entries = fs.readdirSync(runDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const titles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^review-round-\d+-verdict\.json$/.test(entry.name)) continue;
    try {
      const verdictText = readTextFileWithoutFollowingSymlinks(path.join(runDir, entry.name));
      const verdict = JSON.parse(verdictText);
      if (!Array.isArray(verdict?.issues) || verdict.issues.length === 0) continue;
      for (const issue of verdict.issues) {
        const title = typeof issue?.title === "string" ? issue.title.trim() : "";
        if (title) titles.push(title);
      }
    } catch {
      // Best-effort analytics must not block the rest of the report.
    }
  }
  return titles;
}

function readSidecarOutput(repoRoot, runId, outputPathRelative) {
  const outputPath = path.join(getRunDir(repoRoot, runId), outputPathRelative);
  const output = readTextFileWithoutFollowingSymlinks(outputPath);
  if (!output || /\u0000/.test(output)) {
    return null;
  }
  return output;
}

const SIDECAR_TITLE_TOKEN_STOPWORDS = new Set([
  "about",
  "after",
  "before",
  "from",
  "into",
  "missing",
  "should",
  "that",
  "then",
  "this",
  "with",
]);

function issueTitleMatchesSidecarOutput(combinedOutput, title) {
  const normalizedTitle = title.toLowerCase().trim();
  if (!normalizedTitle) return false;
  if (combinedOutput.includes(normalizedTitle)) return true;

  const tokens = normalizedTitle.match(/[a-z0-9_][a-z0-9_.:/-]{2,}/g) || [];
  return tokens.some((token) => (
    !SIDECAR_TITLE_TOKEN_STOPWORDS.has(token)
    && (token.length >= 4 || token.includes("_"))
    && combinedOutput.includes(token)
  ));
}

function computeSidecarPredictionRate({ events, repoRoot }) {
  const resultEventsByRun = new Map();
  for (const event of events) {
    if (event?.event !== EVENTS.SIDECAR_RESULT || !event.run_id || !event.sidecar_id) continue;
    if (!resultEventsByRun.has(event.run_id)) {
      resultEventsByRun.set(event.run_id, []);
    }
    resultEventsByRun.get(event.run_id).push(event);
  }

  let predicted = 0;
  let missed = 0;
  let runsExamined = 0;

  for (const [runId, resultEvents] of resultEventsByRun.entries()) {
    let runDir;
    try {
      runDir = getRunDir(repoRoot, runId);
    } catch {
      continue;
    }

    const issueTitles = readReviewIssueTitles(runDir);
    if (issueTitles.length === 0) continue;

    const outputTexts = [];
    for (const event of resultEvents) {
      try {
        const outputText = readSidecarOutput(repoRoot, runId, event.output_path);
        if (outputText !== null) {
          outputTexts.push(outputText.toLowerCase());
        }
      } catch {
        // Missing, symlinked, directory, or otherwise unreadable output is skipped.
      }
    }
    if (outputTexts.length === 0) continue;

    runsExamined += 1;
    const combinedOutput = outputTexts.join("\n");
    for (const title of issueTitles) {
      if (issueTitleMatchesSidecarOutput(combinedOutput, title)) {
        predicted += 1;
      } else {
        missed += 1;
      }
    }
  }

  return {
    predicted_findings_match_rate: ratio(predicted, predicted + missed),
    predicted_findings_runs_examined: runsExamined,
  };
}

function buildSidecarInsights({ events, repoRoot }) {
  const starts = events.filter((event) => event.event === EVENTS.SIDECAR_START);
  const results = events.filter((event) => event.event === EVENTS.SIDECAR_RESULT);
  const failures = events.filter((event) => event.event === EVENTS.SIDECAR_FAILED);
  const prediction = computeSidecarPredictionRate({ events, repoRoot });

  return {
    total_invocations: starts.length,
    by_kind: buildSidecarOutcomeBuckets(starts, results, failures, "kind"),
    by_executor: buildSidecarOutcomeBuckets(starts, results, failures, "executor"),
    by_model: buildSidecarCountBuckets(starts, "model"),
    by_provider: buildSidecarCountBuckets(starts, "provider"),
    failure_rate: starts.length > 0 ? ratio(failures.length, starts.length) : null,
    predicted_findings_match_rate: prediction.predicted_findings_match_rate,
    predicted_findings_runs_examined: prediction.predicted_findings_runs_examined,
  };
}

const ADVISORY_SIDECAR_TIMING_EVENTS = new Set([
  EVENTS.ADVISORY_REVIEW,
  EVENTS.SIDECAR_RESULT,
  EVENTS.SIDECAR_FAILED,
]);

function eventHasAdvisorySidecarTiming(event) {
  return ADVISORY_SIDECAR_TIMING_EVENTS.has(event?.event)
    && (
      event.consumed_by_phase !== undefined
      || event.critical_path_wait_ms !== undefined
      || event.advisory_elapsed_ms !== undefined
      || event.sidecar_elapsed_ms !== undefined
    );
}

function numericEventField(event, fieldName, fallback = 0) {
  const value = Number(event?.[fieldName]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function buildAdvisorySidecarTiming(events) {
  const timedEvents = events.filter(eventHasAdvisorySidecarTiming);
  const byConsumedPhase = new Map();
  const byArtifactKind = new Map();
  const criticalPathWaits = [];
  let phaseDecisionWaited = 0;
  let frontierStepReplaced = 0;

  for (const event of timedEvents) {
    const consumedPhase = normalizeBucketValue(event.consumed_by_phase);
    incrementCountBucket(byConsumedPhase, consumedPhase);
    incrementCountBucket(byArtifactKind, event.event === EVENTS.ADVISORY_REVIEW ? "advisory_review" : "sidecar");
    criticalPathWaits.push(numericEventField(event, "critical_path_wait_ms"));
    if (event.phase_decision_waited === true) phaseDecisionWaited += 1;
    if (event.frontier_step_replaced === true) frontierStepReplaced += 1;
  }

  const beforeDecision = timedEvents.filter((event) => (
    event.consumed_by_phase === "dispatch" || event.consumed_by_phase === "review"
  )).length;

  return {
    total_artifacts: timedEvents.length,
    by_consumed_phase: sortCountBuckets(byConsumedPhase),
    by_artifact_kind: sortCountBuckets(byArtifactKind),
    consumed_before_decision: beforeDecision,
    metrics_only_late_artifacts: timedEvents.filter((event) => event.consumed_by_phase === "metrics").length,
    redispatch_artifacts: timedEvents.filter((event) => event.consumed_by_phase === "redispatch").length,
    median_critical_path_wait_ms: median(criticalPathWaits),
    phase_decision_waited: phaseDecisionWaited,
    frontier_step_replaced: frontierStepReplaced,
  };
}

function formatSidecarCountSummary(buckets) {
  return Object.entries(buckets || {})
    .sort(([leftKey, left], [rightKey, right]) => (
      (right.invocations || 0) - (left.invocations || 0)
      || leftKey.localeCompare(rightKey)
    ))
    .map(([key, summary]) => `${key}=${summary.invocations || 0}`)
    .join(", ");
}

function resolveManifestRubricPath(manifest) {
  const rubricPath = manifest?.data?.anchor?.rubric_path;
  const runId = manifest?.data?.run_id;
  if (typeof rubricPath !== "string" || !rubricPath.trim() || !manifest?.manifestPath || !runId) {
    return null;
  }

  const runDir = path.join(path.dirname(manifest.manifestPath), runId);
  const resolved = path.resolve(runDir, rubricPath);
  const relative = path.relative(runDir, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function readRubricFactors(manifest) {
  const rubricPath = resolveManifestRubricPath(manifest);
  if (!rubricPath) return null;

  try {
    return extractAllFactors(fs.readFileSync(rubricPath, "utf-8"))
      .filter((factor) => typeof factor?.name === "string" && factor.name.trim())
      .map((factor) => ({
        name: factor.name.trim(),
        fixHintPresent: typeof factor.fix_hint === "string" && factor.fix_hint.trim() !== "",
      }));
  } catch {
    return null;
  }
}

function buildIterationScoreIndex(events) {
  const scoresByRun = new Map();

  for (const event of events) {
    if (event?.event !== EVENTS.ITERATION_SCORE || !event.run_id || !Array.isArray(event.scores)) continue;
    if (!scoresByRun.has(event.run_id)) {
      scoresByRun.set(event.run_id, new Map());
    }

    const round = Number(event.round);
    const roundNumber = Number.isInteger(round) && round >= 1 ? round : null;
    const scoresByFactor = scoresByRun.get(event.run_id);

    for (const score of event.scores) {
      const factor = typeof score?.factor === "string" ? score.factor.trim() : "";
      if (!factor) continue;
      if (!scoresByFactor.has(factor)) {
        scoresByFactor.set(factor, { firstMetRound: null });
      }

      if (score.met === true && roundNumber !== null) {
        const current = scoresByFactor.get(factor);
        if (current.firstMetRound === null || roundNumber < current.firstMetRound) {
          current.firstMetRound = roundNumber;
        }
      }
    }
  }

  return scoresByRun;
}

function buildQualitativeSignals(manifests, events) {
  const scoresByRun = buildIterationScoreIndex(events);
  const withFixHint = { sampleSize: 0, rounds: [] };
  const withoutFixHint = { sampleSize: 0, rounds: [] };
  let contributingManifests = 0;

  for (const manifest of manifests) {
    const runId = manifest?.data?.run_id;
    if (!runId) continue;

    const rubricFactors = readRubricFactors(manifest);
    if (!rubricFactors || rubricFactors.length === 0) continue;

    const scoredFactors = scoresByRun.get(runId);
    if (!scoredFactors) continue;

    let manifestContributed = false;
    let manifestWithFixHint = false;
    let manifestWithoutFixHint = false;

    for (const factor of rubricFactors) {
      const scored = scoredFactors.get(factor.name);
      if (!scored) continue;

      manifestContributed = true;
      if (scored.firstMetRound === null) continue;

      if (factor.fixHintPresent) {
        withFixHint.rounds.push(scored.firstMetRound);
        manifestWithFixHint = true;
      } else {
        withoutFixHint.rounds.push(scored.firstMetRound);
        manifestWithoutFixHint = true;
      }
    }

    if (manifestContributed) {
      contributingManifests += 1;
    }
    if (manifestWithFixHint) {
      withFixHint.sampleSize += 1;
    }
    if (manifestWithoutFixHint) {
      withoutFixHint.sampleSize += 1;
    }
  }

  if (contributingManifests < 3 || withFixHint.sampleSize < 3 || withoutFixHint.sampleSize < 3) {
    return null;
  }

  const withAverage = average(withFixHint.rounds);
  const withoutAverage = average(withoutFixHint.rounds);
  return {
    with: {
      sample_size: withFixHint.sampleSize,
      avg_first_met_round: withAverage,
    },
    without: {
      sample_size: withoutFixHint.sampleSize,
      avg_first_met_round: withoutAverage,
    },
    delta: Number((withAverage - withoutAverage).toFixed(4)),
  };
}

function buildReport({ repoRoot, staleHours, now, manifests, events, includeSidecarInsights = false }) {
  const resumeStarts = events.filter((event) => (
    event.event === EVENTS.DISPATCH_START && event.state_from === STATES.CHANGES_REQUESTED
  ));
  const resumeSuccesses = events.filter((event) => (
    event.event === EVENTS.DISPATCH_RESULT &&
    event.state_to === STATES.REVIEW_PENDING &&
    String(event.reason || "").startsWith("same_run_resume:")
  ));

  const mergeGateOutcomes = events.filter((event) => (
    event.event === EVENTS.MERGE_BLOCKED || event.event === EVENTS.MERGE_FINALIZE
  ));
  const mergeBlocks = mergeGateOutcomes.filter((event) => event.event === EVENTS.MERGE_BLOCKED);

  const reviewRuns = new Map();
  for (const manifest of manifests) {
    reviewRuns.set(manifest.data.run_id, Number(manifest.data.review?.max_rounds || 20));
  }
  const maxRoundsCompliant = new Set();
  for (const [runId, maxRounds] of reviewRuns.entries()) {
    const runEvents = events.filter((event) => event.run_id === runId && event.event === EVENTS.REVIEW_APPLY);
    const overflow = runEvents.some((event) => Number(event.round || 0) > maxRounds);
    if (!overflow) {
      maxRoundsCompliant.add(runId);
    }
  }

  const passedRuns = manifests
    .filter(({ data }) => [STATES.READY_TO_MERGE, STATES.MERGED].includes(data.state));
  const readyRounds = passedRuns
    .map(({ data }) => Number(data.review?.rounds || 0))
    .filter((value) => value > 0);

  const staleOpenRuns = manifests.filter(({ data }) => {
    if ([STATES.MERGED, STATES.CLOSED].includes(data.state)) return false;
    const updatedAt = Date.parse(data.timestamps?.updated_at || data.timestamps?.created_at || 0);
    if (!updatedAt) return false;
    return updatedAt <= now - staleHours * 60 * 60 * 1000;
  });
  const dispatchResults = events.filter((event) => event.event === EVENTS.DISPATCH_RESULT);
  const dispatchTimeouts = dispatchResults.filter((event) => (
    event.failure_class === "timeout" || /timeout/i.test(String(event.reason || ""))
  ));
  const dispatchFailures = dispatchResults.filter((event) => event.state_to === STATES.ESCALATED);
  const recoveredRunIds = new Set(
    events
      .filter((event) => event.event === EVENTS.RECOVER_COMMIT && event.run_id)
      .map((event) => event.run_id)
  );

  const report = {
    repoRoot,
    staleHours,
    bootstrap_exempt_runs: manifests.filter(({ data }) => data?.bootstrap_exempt?.enabled === true).length,
    totals: {
      manifests: manifests.length,
      events: events.length,
      resumeAttempts: resumeStarts.length,
      mergeGateChecks: mergeGateOutcomes.length,
      reviewTrackedRuns: reviewRuns.size,
    },
    metrics: {
      same_run_resume_success_rate: ratio(resumeSuccesses.length, resumeStarts.length),
      fresh_review_merge_block_rate: ratio(mergeBlocks.length, mergeGateOutcomes.length),
      max_rounds_enforcement_rate: ratio(maxRoundsCompliant.size, reviewRuns.size),
      median_rounds_to_ready: median(readyRounds),
      stale_open_runs_72h: staleOpenRuns.length,
      pass_rate: ratio(passedRuns.length, manifests.length),
      dispatch_timeout_rate: ratio(dispatchTimeouts.length, dispatchResults.length),
      dispatch_failure_rate: ratio(dispatchFailures.length, dispatchResults.length),
      recover_commit_rate: ratio(recoveredRunIds.size, manifests.length),
    },
    factor_analysis: buildFactorAnalysis(events),
    rubric_insights: buildRubricInsights(events, manifests),
    qualitative_signals: buildQualitativeSignals(manifests, events),
    guidance_pack_insights: buildGuidancePackInsights(manifests, events),
    review_lineage: buildReviewLineageSummary({ repoRoot, manifests }),
    advisory_sidecar_timing: buildAdvisorySidecarTiming(events),
    override_audit: buildOverrideAuditSummary(events),
  };

  if (includeSidecarInsights) {
    report.sidecar_insights = buildSidecarInsights({ events, repoRoot });
  }

  return report;
}

function buildActorReports({ repoRoot, staleHours, now, manifests, events }) {
  const actorNames = [...new Set(
    manifests.map(({ data }) => normalizeActorName(data?.actor?.name))
  )].sort((left, right) => left.localeCompare(right));

  return Object.fromEntries(actorNames.map((actor) => {
    const actorManifests = manifests.filter(({ data }) => normalizeActorName(data?.actor?.name) === actor);
    const actorRunIds = new Set(
      actorManifests
        .map(({ data }) => data?.run_id)
        .filter(Boolean)
    );
    // Group by manifest actor so run-level metrics stay coherent even when different people touch one run later.
    const actorEvents = events.filter((event) => actorRunIds.has(event.run_id));
    return [actor, buildReport({
      repoRoot,
      staleHours,
      now,
      manifests: actorManifests,
      events: actorEvents,
    })];
  }));
}

function buildRoleReports({ repoRoot, staleHours, now, manifests, events }) {
  const roleKeys = ["orchestrator", "executor", "reviewer"];
  return Object.fromEntries(roleKeys.map((roleKey) => {
    const roleNames = [...new Set(
      manifests.map(({ data }) => normalizeRoleName(data?.roles?.[roleKey]))
    )].sort((left, right) => left.localeCompare(right));

    return [roleKey, Object.fromEntries(roleNames.map((roleName) => {
      const roleManifests = manifests.filter(({ data }) => normalizeRoleName(data?.roles?.[roleKey]) === roleName);
      const roleRunIds = new Set(
        roleManifests
          .map(({ data }) => data?.run_id)
          .filter(Boolean)
      );
      const roleEvents = events.filter((event) => roleRunIds.has(event.run_id));
      return [roleName, buildReport({
        repoRoot,
        staleHours,
        now,
        manifests: roleManifests,
        events: roleEvents,
      })];
    }))];
  }));
}

function buildDispatchDimensionReport({ repoRoot, staleHours, now, manifests, events }, dimension) {
  const fieldName = `last_${dimension}`;
  const names = [...new Set(
    manifests.map(({ data }) => normalizeDispatchKey(data?.dispatch?.[fieldName]))
  )].sort((left, right) => left.localeCompare(right));

  return Object.fromEntries(names.map((name) => {
    const groupManifests = manifests.filter(
      ({ data }) => normalizeDispatchKey(data?.dispatch?.[fieldName]) === name
    );
    const groupRunIds = new Set(
      groupManifests
        .map(({ data }) => data?.run_id)
        .filter(Boolean)
    );
    const groupEvents = events.filter((event) => groupRunIds.has(event.run_id));
    return [name, buildReport({
      repoRoot,
      staleHours,
      now,
      manifests: groupManifests,
      events: groupEvents,
    })];
  }));
}

function buildDispatchReports(opts) {
  return {
    executor: buildDispatchDimensionReport(opts, "executor"),
    model: buildDispatchDimensionReport(opts, "model"),
    provider: buildDispatchDimensionReport(opts, "provider"),
  };
}

function formatCountSummary(buckets) {
  return Object.entries(buckets || {})
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      Number(rightValue || 0) - Number(leftValue || 0)
      || leftKey.localeCompare(rightKey)
    ))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

// `review_apply` can be emitted for a system-forced escalation before any
// reviewer actually runs. New events mark that path with `origin: "system"`;
// legacy events are still reviewer-less. Filtering both shapes here prevents
// phantom round counts in the "unknown" bucket. Runs whose only review_apply
// events are system-emitted or legacy reviewer-less still surface as
// data-integrity signals via `summary.missing_review_apply_run_ids` (since
// `hasRecordedReviewActivity` will report the run as missing reviewer-tagged
// events). Events that carry an explicit but empty/whitespace reviewer fall
// through to `normalizeRoleName` and land in "unknown" so real corrupt-value
// cases stay visible.
function buildActingReviewerReports({ repoRoot, staleHours, now, manifests, events }) {
  const reviewApplyEvents = events.filter((event) => (
    event.event === EVENTS.REVIEW_APPLY
    && event.run_id
    && !isSystemReviewApplyEvent(event)
    && !isLegacyReviewerlessReviewApplyEvent(event)
  ));
  const buckets = new Map();
  const reviewersByRun = new Map();

  for (const event of reviewApplyEvents) {
    const reviewerName = normalizeRoleName(event.reviewer);
    if (!buckets.has(reviewerName)) {
      buckets.set(reviewerName, {
        runIds: new Set(),
        reviewApplyEvents: 0,
        exclusiveRunIds: new Set(),
        mixedRunIds: new Set(),
      });
    }

    const bucket = buckets.get(reviewerName);
    bucket.reviewApplyEvents += 1;
    bucket.runIds.add(event.run_id);

    if (!reviewersByRun.has(event.run_id)) {
      reviewersByRun.set(event.run_id, new Set());
    }
    reviewersByRun.get(event.run_id).add(reviewerName);
  }

  for (const [runId, reviewerNames] of reviewersByRun.entries()) {
    const destination = reviewerNames.size > 1 ? "mixedRunIds" : "exclusiveRunIds";
    for (const reviewerName of reviewerNames) {
      buckets.get(reviewerName)[destination].add(runId);
    }
  }

  const missingRunIds = manifests
    .map(({ data }) => data)
    .filter((data) => data?.run_id && hasRecordedReviewActivity(data) && !reviewersByRun.has(data.run_id))
    .map((data) => data.run_id)
    .sort((left, right) => left.localeCompare(right));

  const reviewerEntries = [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right));

  return {
    reviewers: Object.fromEntries(reviewerEntries.map(([reviewerName, bucket]) => {
      const reviewerManifests = manifests.filter(({ data }) => bucket.runIds.has(data?.run_id));
      const reviewerEvents = events.filter((event) => bucket.runIds.has(event.run_id));
      return [reviewerName, {
        ...buildReport({
          repoRoot,
          staleHours,
          now,
          manifests: reviewerManifests,
          events: reviewerEvents,
        }),
        acting_review: {
          review_apply_events: bucket.reviewApplyEvents,
          review_apply_runs: bucket.runIds.size,
          exclusive_review_apply_runs: bucket.exclusiveRunIds.size,
          mixed_review_apply_runs: bucket.mixedRunIds.size,
        },
      }];
    })),
    summary: {
      review_apply_events: reviewApplyEvents.length,
      review_apply_runs: reviewersByRun.size,
      multi_reviewer_runs: [...reviewersByRun.values()].filter((reviewerNames) => reviewerNames.size > 1).length,
      missing_review_apply_runs: missingRunIds.length,
      missing_review_apply_run_ids: missingRunIds,
    },
  };
}

function main() {
  const repoRoot = path.resolve(readArg(args, "--repo", ".", CLI_ARG_OPTIONS));
  const staleHours = parseHours(readArg(args, "--stale-hours", "72", CLI_ARG_OPTIONS));
  const now = Date.now();
  const manifests = listManifestRecords(repoRoot);
  const events = readAllRunEvents(repoRoot);
  const report = buildReport({ repoRoot, staleHours, now, manifests, events, includeSidecarInsights: true });

  if (hasCliFlag("--by-actor")) {
    report.by_actor = buildActorReports({ repoRoot, staleHours, now, manifests, events });
  }
  if (hasCliFlag("--by-role")) {
    report.by_role = buildRoleReports({ repoRoot, staleHours, now, manifests, events });
  }
  if (hasCliFlag("--by-acting-reviewer")) {
    report.by_acting_reviewer = buildActingReviewerReports({ repoRoot, staleHours, now, manifests, events });
  }
  if (hasCliFlag("--by-dispatch")) {
    report.by_dispatch = buildDispatchReports({ repoRoot, staleHours, now, manifests, events });
  }

  if (hasCliFlag("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Relay reliability report: ${repoRoot}`);
  console.log(`  same_run_resume_success_rate: ${report.metrics.same_run_resume_success_rate ?? "n/a"}`);
  console.log(`  fresh_review_merge_block_rate: ${report.metrics.fresh_review_merge_block_rate ?? "n/a"}`);
  console.log(`  max_rounds_enforcement_rate: ${report.metrics.max_rounds_enforcement_rate ?? "n/a"}`);
  console.log(`  median_rounds_to_ready: ${report.metrics.median_rounds_to_ready ?? "n/a"}`);
  console.log(`  stale_open_runs_72h: ${report.metrics.stale_open_runs_72h}`);
  console.log(`  pass_rate: ${report.metrics.pass_rate ?? "n/a"}`);
  console.log(`  dispatch_timeout_rate: ${report.metrics.dispatch_timeout_rate ?? "n/a"}`);
  console.log(`  dispatch_failure_rate: ${report.metrics.dispatch_failure_rate ?? "n/a"}`);
  console.log(`  recover_commit_rate: ${report.metrics.recover_commit_rate ?? "n/a"}`);
  console.log(`  review_lineage: ${LINEAGE_VALUES.map((value) => `${value}=${report.review_lineage.totals[value]}`).join(", ")}`);
  console.log(`  most_stuck_factor: ${report.factor_analysis.most_stuck_factor ?? "n/a"}`);
  if (hasRubricInsights(report.rubric_insights)) {
    const gradeDistribution = report.rubric_insights.quality_grade_distribution;
    const gradeText = gradeDistribution
      ? `A:${gradeDistribution.A} B:${gradeDistribution.B} C:${gradeDistribution.C} D:${gradeDistribution.D}`
      : "n/a";
    const topHotspot = report.rubric_insights.divergence_hotspots?.[0];
    console.log(`  rubric_grades: ${gradeText}`);
    console.log(`  avg_quality_ratio: ${report.rubric_insights.avg_quality_ratio ?? "n/a"}`);
    console.log(`  top_divergence_hotspot: ${topHotspot ? `${topHotspot.factor_pattern} (${topHotspot.avg_delta})` : "n/a"}`);
  }
  if (report.guidance_pack_insights?.status === NO_GUIDANCE_DATA_TEXT) {
    console.log(`  guidance_pack_insights: ${NO_GUIDANCE_DATA_TEXT}`);
  } else {
    console.log("  guidance_pack_insights:");
    for (const [pack, summary] of Object.entries(report.guidance_pack_insights?.packs || {})) {
      const topStuckFactor = summary.stuck_factors?.[0]?.factor || "n/a";
      console.log(
        `    ${pack}: usage_count=${summary.usage_count} ` +
        `avg_review_rounds=${summary.avg_review_rounds ?? "n/a"} ` +
        `changes_requested_rate=${summary.changes_requested_rate ?? "n/a"} ` +
        `top_stuck_factor=${topStuckFactor} ` +
        `divergence_avg_delta=${summary.executor_reviewer_divergence?.avg_delta ?? "n/a"}`
      );
    }
  }
  if (report.sidecar_insights?.total_invocations === 0) {
    console.log("  sidecar_insights: no sidecar runs available");
  } else {
    console.log("  sidecar_insights:");
    console.log(`    total_invocations: ${report.sidecar_insights.total_invocations}`);
    console.log(`    failure_rate: ${report.sidecar_insights.failure_rate ?? "n/a"}`);
    console.log(`    by_kind: ${formatSidecarCountSummary(report.sidecar_insights.by_kind) || "n/a"}`);
    console.log(`    by_executor: ${formatSidecarCountSummary(report.sidecar_insights.by_executor) || "n/a"}`);
    if (report.sidecar_insights.predicted_findings_match_rate !== null) {
      console.log(`    predicted_findings_match_rate: ${report.sidecar_insights.predicted_findings_match_rate}`);
      console.log(`    predicted_findings_runs_examined: ${report.sidecar_insights.predicted_findings_runs_examined}`);
    }
  }
  if (report.advisory_sidecar_timing?.total_artifacts > 0) {
    console.log("  advisory_sidecar_timing:");
    console.log(`    total_artifacts: ${report.advisory_sidecar_timing.total_artifacts}`);
    console.log(`    median_critical_path_wait_ms: ${report.advisory_sidecar_timing.median_critical_path_wait_ms ?? "n/a"}`);
    console.log(`    consumed_before_decision: ${report.advisory_sidecar_timing.consumed_before_decision}`);
    console.log(`    metrics_only_late_artifacts: ${report.advisory_sidecar_timing.metrics_only_late_artifacts}`);
    console.log(`    redispatch_artifacts: ${report.advisory_sidecar_timing.redispatch_artifacts}`);
  }
  if (report.override_audit?.total_events > 0) {
    const audit = report.override_audit;
    console.log("  override_audit:");
    console.log(
      `    total_events=${audit.total_events} ` +
      `current_shape=${audit.current_shape_events} ` +
      `legacy_shape=${audit.legacy_shape_events} ` +
      `malformed=${audit.malformed_current_shape_events}`
    );
    console.log(`    by_override_class: ${formatCountSummary(audit.by_override_class) || "n/a"}`);
    console.log(`    operator_initiated: ${formatCountSummary(audit.by_operator_initiated) || "n/a"}`);
    console.log(
      `    missing_required_fields: affected_head_sha=${audit.field_presence.affected_head_sha.missing} ` +
      `required_reason=${audit.field_presence.required_reason.missing}`
    );
    console.log(`    affected_transitions: ${formatCountSummary(audit.affected_transitions) || "n/a"}`);
    if (audit.findings.length > 0) {
      console.log(`    findings: ${audit.findings.length} malformed current-shape event(s)`);
    }
  }
  if (hasCliFlag("--by-actor")) {
    const actorEntries = Object.entries(report.by_actor || {});
    console.log("  by_actor:");
    if (actorEntries.length === 0) {
      console.log("    n/a");
    }
    for (const [actor, actorReport] of actorEntries) {
      console.log(
        `    ${actor}: manifests=${actorReport.totals.manifests} events=${actorReport.totals.events} ` +
        `most_stuck_factor=${actorReport.factor_analysis.most_stuck_factor ?? "n/a"}`
      );
    }
  }
  if (hasCliFlag("--by-role")) {
    const roleEntries = Object.entries(report.by_role || {});
    console.log("  by_role:");
    if (roleEntries.length === 0) {
      console.log("    n/a");
    }
    for (const [roleKey, roleReport] of roleEntries) {
      const names = Object.entries(roleReport || {});
      if (names.length === 0) {
        console.log(`    ${roleKey}: n/a`);
        continue;
      }
      for (const [roleName, scopedReport] of names) {
        console.log(
          `    ${roleKey}.${roleName}: manifests=${scopedReport.totals.manifests} events=${scopedReport.totals.events} ` +
          `most_stuck_factor=${scopedReport.factor_analysis.most_stuck_factor ?? "n/a"}`
        );
      }
    }
  }
  if (hasCliFlag("--by-dispatch")) {
    const dispatchEntries = Object.entries(report.by_dispatch || {});
    console.log("  by_dispatch:");
    if (dispatchEntries.length === 0) {
      console.log("    n/a");
    }
    for (const [dimensionKey, dimensionReport] of dispatchEntries) {
      const names = Object.entries(dimensionReport || {});
      if (names.length === 0) {
        console.log(`    ${dimensionKey}: n/a`);
        continue;
      }
      for (const [name, scopedReport] of names) {
        console.log(
          `    ${dimensionKey}.${name}: manifests=${scopedReport.totals.manifests} events=${scopedReport.totals.events} ` +
          `pass_rate=${scopedReport.metrics.pass_rate ?? "n/a"} ` +
          `median_rounds_to_ready=${scopedReport.metrics.median_rounds_to_ready ?? "n/a"} ` +
          `timeout_rate=${scopedReport.metrics.dispatch_timeout_rate ?? "n/a"} ` +
          `failure_rate=${scopedReport.metrics.dispatch_failure_rate ?? "n/a"} ` +
          `recover_commit_rate=${scopedReport.metrics.recover_commit_rate ?? "n/a"}`
        );
      }
    }
  }
  if (hasCliFlag("--by-acting-reviewer")) {
    const actingReviewerEntries = Object.entries(report.by_acting_reviewer?.reviewers || {});
    const actingReviewerSummary = report.by_acting_reviewer?.summary || {};
    console.log("  by_acting_reviewer:");
    if (actingReviewerEntries.length === 0) {
      console.log("    n/a");
    }
    for (const [reviewerName, scopedReport] of actingReviewerEntries) {
      console.log(
        `    ${reviewerName}: review_apply_events=${scopedReport.acting_review.review_apply_events} ` +
        `review_apply_runs=${scopedReport.acting_review.review_apply_runs} ` +
        `mixed_runs=${scopedReport.acting_review.mixed_review_apply_runs} ` +
        `manifests=${scopedReport.totals.manifests} events=${scopedReport.totals.events} ` +
        `most_stuck_factor=${scopedReport.factor_analysis.most_stuck_factor ?? "n/a"}`
      );
    }
    console.log(
      `    summary: review_apply_events=${actingReviewerSummary.review_apply_events ?? 0} ` +
      `review_apply_runs=${actingReviewerSummary.review_apply_runs ?? 0} ` +
      `multi_reviewer_runs=${actingReviewerSummary.multi_reviewer_runs ?? 0} ` +
      `missing_review_apply_runs=${actingReviewerSummary.missing_review_apply_runs ?? 0}`
    );
    if ((actingReviewerSummary.missing_review_apply_run_ids || []).length > 0) {
      console.log(`    missing_review_apply_run_ids: ${actingReviewerSummary.missing_review_apply_run_ids.join(", ")}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
