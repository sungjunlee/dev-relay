#!/usr/bin/env node

const path = require("path");
const { STATES } = require("./manifest/lifecycle");
const { listManifestRecords } = require("./manifest/store");
const { getArg, hasFlag } = require("./cli-args");
const { readAllRunEvents } = require("./relay-events");

const args = process.argv.slice(2);
const RESERVED = { reservedFlags: ["-h"] };

if (hasFlag(args, ["--help", "-h"])) {
  console.log(
    "Usage: reliability-report.js [--repo <path>] [--stale-hours <hours>] " +
    "[--json] [--by-actor] [--by-role] [--by-acting-reviewer]"
  );
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

function hasRecordedReviewActivity(data) {
  return (
    Number(data?.review?.rounds || 0) > 0
    || (typeof data?.review?.last_reviewer === "string" && data.review.last_reviewer.trim())
    || (typeof data?.review?.last_reviewed_sha === "string" && data.review.last_reviewed_sha.trim())
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
    if (event.event !== "iteration_score" || !event.run_id || !Array.isArray(event.scores)) continue;
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
  const divergenceEvents = events.filter((event) => event.event === "score_divergence" && Array.isArray(event.divergences));
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
  const rubricQualityEvents = events.filter((event) => event.event === "rubric_quality");

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
    if (event.event !== "iteration_score" || !event.run_id) continue;
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

function buildModelPerPhase(events) {
  const phaseBuckets = {
    dispatch: new Map(),
    review: new Map(),
  };

  for (const event of events) {
    let phase = null;
    if (event.event === "dispatch_start") {
      phase = "dispatch";
    } else if (event.event === "review_invoke") {
      phase = "review";
    }
    if (!phase || !Object.prototype.hasOwnProperty.call(event, "model")) continue;

    const key = event.model === null ? "null" : String(event.model);
    phaseBuckets[phase].set(key, (phaseBuckets[phase].get(key) || 0) + 1);
  }

  const hasData = [...phaseBuckets.dispatch.values(), ...phaseBuckets.review.values()].length > 0;
  if (!hasData) return null;

  return Object.fromEntries(
    Object.entries(phaseBuckets).map(([phase, counts]) => [
      phase,
      Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    ])
  );
}

function buildReport({ repoRoot, staleHours, now, manifests, events }) {
  const resumeStarts = events.filter((event) => (
    event.event === "dispatch_start" && event.state_from === STATES.CHANGES_REQUESTED
  ));
  const resumeSuccesses = events.filter((event) => (
    event.event === "dispatch_result" &&
    event.state_to === STATES.REVIEW_PENDING &&
    String(event.reason || "").startsWith("same_run_resume:")
  ));

  const mergeGateOutcomes = events.filter((event) => (
    event.event === "merge_blocked" || event.event === "merge_finalize"
  ));
  const mergeBlocks = mergeGateOutcomes.filter((event) => event.event === "merge_blocked");

  const reviewRuns = new Map();
  for (const manifest of manifests) {
    reviewRuns.set(manifest.data.run_id, Number(manifest.data.review?.max_rounds || 20));
  }
  const maxRoundsCompliant = new Set();
  for (const [runId, maxRounds] of reviewRuns.entries()) {
    const runEvents = events.filter((event) => event.run_id === runId && event.event === "review_apply");
    const overflow = runEvents.some((event) => Number(event.round || 0) > maxRounds);
    if (!overflow) {
      maxRoundsCompliant.add(runId);
    }
  }

  const readyRounds = manifests
    .filter(({ data }) => [STATES.READY_TO_MERGE, STATES.MERGED].includes(data.state))
    .map(({ data }) => Number(data.review?.rounds || 0))
    .filter((value) => value > 0);

  const staleOpenRuns = manifests.filter(({ data }) => {
    if ([STATES.MERGED, STATES.CLOSED].includes(data.state)) return false;
    const updatedAt = Date.parse(data.timestamps?.updated_at || data.timestamps?.created_at || 0);
    if (!updatedAt) return false;
    return updatedAt <= now - staleHours * 60 * 60 * 1000;
  });

  return {
    repoRoot,
    staleHours,
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
    },
    model_per_phase: buildModelPerPhase(events),
    factor_analysis: buildFactorAnalysis(events),
    rubric_insights: buildRubricInsights(events, manifests),
  };
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

// `review_apply` events without a `reviewer` field are system-emitted state
// transitions (e.g., review-runner.js's `max_rounds_exceeded` escalation), not
// rounds any reviewer actually performed. Filtering them here prevents phantom
// round counts in the "unknown" bucket. Runs whose only review_apply events
// lack a reviewer still surface as data-integrity signals via
// `summary.missing_review_apply_run_ids` (since `hasRecordedReviewActivity`
// will report the run as missing reviewer-tagged events). Events that carry
// an explicit but empty/whitespace reviewer fall through to
// `normalizeRoleName` and land in "unknown" so real corrupt-value cases stay
// visible.
function buildActingReviewerReports({ repoRoot, staleHours, now, manifests, events }) {
  const reviewApplyEvents = events.filter((event) => (
    event.event === "review_apply"
    && event.run_id
    && event.reviewer !== undefined
    && event.reviewer !== null
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
  const repoRoot = path.resolve(getArg(args, "--repo", ".", RESERVED));
  const staleHours = parseHours(getArg(args, "--stale-hours", "72", RESERVED));
  const now = Date.now();
  const manifests = listManifestRecords(repoRoot);
  const events = readAllRunEvents(repoRoot);
  const report = buildReport({ repoRoot, staleHours, now, manifests, events });

  if (hasFlag(args, "--by-actor")) {
    report.by_actor = buildActorReports({ repoRoot, staleHours, now, manifests, events });
  }
  if (hasFlag(args, "--by-role")) {
    report.by_role = buildRoleReports({ repoRoot, staleHours, now, manifests, events });
  }
  if (hasFlag(args, "--by-acting-reviewer")) {
    report.by_acting_reviewer = buildActingReviewerReports({ repoRoot, staleHours, now, manifests, events });
  }

  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Relay reliability report: ${repoRoot}`);
  console.log(`  same_run_resume_success_rate: ${report.metrics.same_run_resume_success_rate ?? "n/a"}`);
  console.log(`  fresh_review_merge_block_rate: ${report.metrics.fresh_review_merge_block_rate ?? "n/a"}`);
  console.log(`  max_rounds_enforcement_rate: ${report.metrics.max_rounds_enforcement_rate ?? "n/a"}`);
  console.log(`  median_rounds_to_ready: ${report.metrics.median_rounds_to_ready ?? "n/a"}`);
  console.log(`  stale_open_runs_72h: ${report.metrics.stale_open_runs_72h}`);
  if (report.model_per_phase) {
    console.log(`  model_per_phase: ${JSON.stringify(report.model_per_phase)}`);
  }
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
  if (hasFlag(args, "--by-actor")) {
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
  if (hasFlag(args, "--by-role")) {
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
  if (hasFlag(args, "--by-acting-reviewer")) {
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
