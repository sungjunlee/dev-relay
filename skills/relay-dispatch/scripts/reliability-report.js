#!/usr/bin/env node

const path = require("path");
const { STATES, listManifestRecords } = require("./relay-manifest");
const { readAllRunEvents } = require("./relay-events");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--stale-hours", "--json", "--help", "-h"];

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: reliability-report.js [--repo <path>] [--stale-hours <hours>] [--json]");
  process.exit(0);
}

function getArg(flag, fallback) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return fallback;
  const value = args[index + 1];
  return KNOWN_FLAGS.includes(value) ? fallback : value;
}

function hasFlag(flag) {
  return args.includes(flag);
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

function main() {
  const repoRoot = path.resolve(getArg("--repo", "."));
  const staleHours = parseHours(getArg("--stale-hours", "72"));
  const now = Date.now();
  const manifests = listManifestRecords(repoRoot);
  const events = readAllRunEvents(repoRoot);

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

  const report = {
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
    factor_analysis: buildFactorAnalysis(events),
  };

  if (hasFlag("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Relay reliability report: ${repoRoot}`);
  console.log(`  same_run_resume_success_rate: ${report.metrics.same_run_resume_success_rate ?? "n/a"}`);
  console.log(`  fresh_review_merge_block_rate: ${report.metrics.fresh_review_merge_block_rate ?? "n/a"}`);
  console.log(`  max_rounds_enforcement_rate: ${report.metrics.max_rounds_enforcement_rate ?? "n/a"}`);
  console.log(`  median_rounds_to_ready: ${report.metrics.median_rounds_to_ready ?? "n/a"}`);
  console.log(`  stale_open_runs_72h: ${report.metrics.stale_open_runs_72h}`);
  console.log(`  most_stuck_factor: ${report.factor_analysis.most_stuck_factor ?? "n/a"}`);
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
