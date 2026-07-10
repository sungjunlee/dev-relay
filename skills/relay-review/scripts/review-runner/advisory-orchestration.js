const { STATES } = require("../../../relay-dispatch/scripts/manifest/lifecycle");
const { classifyPostDecisionPhase } = require("../../../relay-dispatch/scripts/advisory-timing");
const { ADAPTER_PHASES } = require("../../../relay-dispatch/scripts/agent-adapters");
const { assertRelayPolicyGate } = require("../../../relay-dispatch/scripts/relay-policy-gate");
const { buildAdvisoryPrompt } = require("./advisory-prompt");
const {
  finishAdvisoryReview,
  buildAdvisoryReviewerPolicy,
  parseNonNegativeSeconds,
  parsePositiveSeconds,
  resolveAdvisoryModel,
  startAdvisoryReview,
  validateAdvisoryProfile,
  writeAdvisoryDecision,
} = require("./advisory");
const { resolveReviewerScript } = require("./reviewer-invoke");

// finishAdvisoryReview polls with early return (see advisory.js), so this
// ceiling is only fully paid when the event genuinely never lands (the
// fail-closed failure path). 10s covers pathological parallel-runner load,
// mirroring DEFAULT_ADVISORY_GRACE_SECONDS = 10 in advisory.js.
const DEFAULT_HARDENED_EVENT_BINDING_WAIT_MS = 10000;
const ADVISORY_TRIGGERS = new Set(["every_round", "on_pass"]);
const ADVISORY_PROFILE_DEFAULTS = Object.freeze({
  blindspot: Object.freeze({ trigger: "every_round", gating: false, timeoutSeconds: 900 }),
  adversarial: Object.freeze({ trigger: "on_pass", gating: true, timeoutSeconds: 1800 }),
});

function resolveHardenedBindingWaitMs(env = process.env) {
  const raw = Number(env.RELAY_ADVISORY_EVENT_BINDING_WAIT_MS || DEFAULT_HARDENED_EVENT_BINDING_WAIT_MS);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_HARDENED_EVENT_BINDING_WAIT_MS;
}

function resolveAdvisoryTimeoutSeconds(explicitTimeoutArg, profile) {
  return parsePositiveSeconds(
    explicitTimeoutArg,
    advisoryProfileDefaults(profile).timeoutSeconds,
  );
}

function resolveSettlementTimeoutSeconds(explicitTimeoutArg, lanes) {
  if (explicitTimeoutArg !== undefined && explicitTimeoutArg !== null && explicitTimeoutArg !== "") {
    return parsePositiveSeconds(explicitTimeoutArg);
  }
  return Math.max(
    ...lanes.map((lane) => advisoryProfileDefaults(lane.profile).timeoutSeconds),
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasAdvisoryConfigValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function advisoryProfileDefaults(profile) {
  return ADVISORY_PROFILE_DEFAULTS[profile] || ADVISORY_PROFILE_DEFAULTS.blindspot;
}

function normalizeTrigger(value, profile) {
  const trigger = nonEmptyString(value) || advisoryProfileDefaults(profile).trigger;
  if (!ADVISORY_TRIGGERS.has(trigger)) {
    throw new Error(`advisory lane trigger must be one of: ${Array.from(ADVISORY_TRIGGERS).join(", ")}`);
  }
  return trigger;
}

function normalizeGating(value, profile) {
  if (value === undefined || value === null) return advisoryProfileDefaults(profile).gating;
  if (typeof value !== "boolean") {
    throw new Error("advisory lane gating must be a boolean");
  }
  return value;
}

function normalizeLaneList(value, source) {
  if (!hasAdvisoryConfigValue(value)) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`advisory lane ${index + 1} from ${source} must be an object`);
    }
    const reviewer = nonEmptyString(entry.reviewer);
    if (!reviewer) {
      throw new Error(`advisory lane ${index + 1} from ${source} requires reviewer`);
    }
    const profile = validateAdvisoryProfile(entry.profile || "blindspot");
    return {
      index: index + 1,
      reviewer,
      model: nonEmptyString(entry.model || entry.reviewer_model),
      modelResolution: isPlainObject(entry.model_resolution) ? entry.model_resolution : null,
      profile,
      trigger: normalizeTrigger(entry.trigger, profile),
      gating: normalizeGating(entry.gating, profile),
      source,
    };
  });
}

function matchingPlannedLane(plannedLanes, lane, index) {
  const sameIndex = plannedLanes[index];
  if (sameIndex?.reviewer === lane.reviewer) return sameIndex;
  return plannedLanes.find((planned) => planned.reviewer === lane.reviewer) || null;
}

function withCliOverrides(lanes, {
  advisoryProfileArg,
  advisoryReviewerModel,
  plannedLanes = [],
}) {
  return lanes.map((lane, index) => {
    const planned = matchingPlannedLane(plannedLanes, lane, index);
    const selectedModel = advisoryReviewerModel || lane.model || planned?.model || null;
    const modelFromPlan = !advisoryReviewerModel && planned?.model && selectedModel === planned.model;
    return {
      ...lane,
      model: selectedModel,
      modelResolution: lane.modelResolution || (modelFromPlan ? planned?.modelResolution || null : null),
      profile: validateAdvisoryProfile(advisoryProfileArg || lane.profile || "blindspot"),
    };
  });
}

function assignArtifactReviewerNames(lanes) {
  const counts = new Map();
  for (const lane of lanes) {
    counts.set(lane.reviewer, (counts.get(lane.reviewer) || 0) + 1);
  }
  const seen = new Map();
  return lanes.map((lane) => {
    const seenCount = (seen.get(lane.reviewer) || 0) + 1;
    seen.set(lane.reviewer, seenCount);
    return {
      ...lane,
      artifactReviewerName: counts.get(lane.reviewer) > 1 && seenCount > 1
        ? `${lane.reviewer}-lane${lane.index}`
        : lane.reviewer,
    };
  });
}

function resolveAdvisoryConfig({
  advisoryGraceArg,
  advisoryProfileArg,
  advisoryReviewerArg,
  advisoryReviewerModel,
  advisoryTimeoutArg,
  data,
  routePlan = null,
}) {
  const plannedRaw = routePlan?.phases?.advisory_review;
  const routedRaw = data?.routing?.selected?.advisory_review;
  const plannedLanes = normalizeLaneList(plannedRaw, "route_plan");
  let lanes = [];
  let source = null;
  if (advisoryReviewerArg) {
    lanes = normalizeLaneList({
      reviewer: advisoryReviewerArg,
      model: advisoryReviewerModel,
      profile: advisoryProfileArg || "blindspot",
    }, "cli");
    source = "cli";
  } else if (Array.isArray(routedRaw)) {
    // An explicit lane array in manifest routing is a selection even when
    // empty: [] means "no advisory lanes", never fall through to the plan.
    lanes = normalizeLaneList(routedRaw, "routing");
    source = "routing";
  } else if (hasAdvisoryConfigValue(routedRaw)) {
    lanes = normalizeLaneList(routedRaw, "routing");
    source = "routing";
  } else if (plannedLanes.length) {
    lanes = plannedLanes;
    source = "route_plan";
  }

  if (!lanes.length && (advisoryProfileArg || advisoryReviewerModel || advisoryTimeoutArg || advisoryGraceArg)) {
    throw new Error("--advisory-reviewer is required when advisory options are supplied and no manifest routing advisory reviewer is selected");
  }

  lanes = assignArtifactReviewerNames(withCliOverrides(lanes, {
    advisoryProfileArg,
    advisoryReviewerModel,
    plannedLanes,
  }));
  const first = lanes[0] || {};

  return {
    graceSeconds: lanes.length ? parseNonNegativeSeconds(advisoryGraceArg) : null,
    lanes,
    model: first.model || null,
    modelResolution: first.modelResolution || null,
    profile: first.profile || null,
    reviewer: first.reviewer || null,
    source: lanes.length ? source : null,
    // Raw CLI/route override (if any). Per-lane request budgets resolve via
    // resolveAdvisoryTimeoutSeconds(timeoutSecondsArg, lane.profile).
    timeoutSecondsArg: advisoryTimeoutArg,
    timeoutSeconds: lanes.length
      ? resolveSettlementTimeoutSeconds(advisoryTimeoutArg, lanes)
      : null,
  };
}

function resultListForOutput(results) {
  return results.length === 1 ? results[0] : results;
}

function advisoryResultList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function advisoryResultKey(value) {
  return [
    Number(value?.lane_index || value?.laneIndex || 0),
    value?.trigger || "every_round",
    value?.reviewer || "unknown-reviewer",
    value?.profile || "blindspot",
  ].join(":");
}

function setResultAdvisory(result, value) {
  const list = advisoryResultList(value);
  if (list.length > 0 || Array.isArray(value)) {
    result.advisoryReviews = list;
    result.advisoryReview = list[0];
  }
}

function upsertResultAdvisory(result, value) {
  const incoming = advisoryResultList(value);
  if (!incoming.length && !Array.isArray(value)) return;
  const existing = Array.isArray(result.advisoryReviews)
    ? result.advisoryReviews
    : advisoryResultList(result.advisoryReview);
  const byKey = new Map(existing.map((entry) => [advisoryResultKey(entry), entry]));
  for (const entry of incoming) byKey.set(advisoryResultKey(entry), entry);
  setResultAdvisory(result, Array.from(byKey.values()));
}

function advisoryWarningsFor(results) {
  return (results || [])
    .filter((entry) => entry && entry.status && entry.status !== "success" && entry.status !== "deferred")
    .map((entry) => (
      `Advisory review warning: ${entry.reviewer || "unknown reviewer"} ` +
      `(${entry.trigger || "every_round"}, profile=${entry.profile || "blindspot"}) ` +
      `status=${entry.status}: ${entry.failureReason || "no failure reason recorded"}`
    ));
}

function appendAdvisoryRunsForTrigger({ advisoryRuns = [], result, startOptions, trigger }) {
  const started = startConfiguredAdvisory({ ...startOptions, trigger });
  upsertResultAdvisory(result, started.resultAdvisory);
  return advisoryRuns.concat(started.advisoryRuns || []);
}

function preflightConfiguredAdvisoryLane({ data, lane, runRepoPath }) {
  const advisoryModel = resolveAdvisoryModel(data, lane.reviewer, lane.model, { repoRoot: runRepoPath });
  const reviewerPolicy = buildAdvisoryReviewerPolicy(lane.reviewer);
  let policyDecision;
  try {
    policyDecision = assertRelayPolicyGate({
      repoRoot: runRepoPath,
      phase: "advisory_review",
      reviewer: lane.reviewer,
      model: advisoryModel,
    });
  } catch (error) {
    error.adapterCapability = reviewerPolicy;
    throw error;
  }
  const reviewerScript = resolveReviewerScript(lane.reviewer, null, { phase: ADAPTER_PHASES.ADVISORY_REVIEW });
  return {
    advisoryModel,
    lane,
    policyDecision,
    reviewerPolicy,
    reviewerScript,
  };
}

function preflightConfiguredAdvisoryLanes({ config, data, runRepoPath }) {
  return (config.lanes || []).map((lane) => preflightConfiguredAdvisoryLane({ data, lane, runRepoPath }));
}

function startConfiguredAdvisory({
  branch,
  config,
  data,
  diffText,
  doneCriteria,
  doneCriteriaSource,
  issueNumber,
  prNumber,
  reviewedHeadSha,
  reviewRepoPath,
  round,
  rubricLoad,
  runDir,
  runRepoPath,
  trigger = "every_round",
}) {
  const lanePreflights = preflightConfiguredAdvisoryLanes({ config, data, runRepoPath })
    .filter(({ lane }) => lane.trigger === trigger);
  if (!lanePreflights.length) return { advisoryRuns: [], resultAdvisory: undefined };
  const advisoryRuns = [];
  const resultAdvisories = [];
  for (const { advisoryModel, lane, policyDecision, reviewerPolicy, reviewerScript } of lanePreflights) {
    const promptText = buildAdvisoryPrompt({
      branch,
      diffText,
      doneCriteria,
      doneCriteriaSource,
      issueNumber,
      prNumber,
      profile: lane.profile,
      round,
      rubricLoad,
    });
    const advisoryRun = startAdvisoryReview({
      artifactReviewerName: lane.artifactReviewerName,
      gating: lane.gating,
      headSha: reviewedHeadSha,
      laneIndex: lane.index,
      profile: lane.profile,
      promptText,
      reviewerModel: advisoryModel,
      modelResolution: lane.modelResolution || null,
      reviewerName: lane.reviewer,
      reviewerPolicy,
      reviewerScript,
      policyDecision,
      reviewRepoPath,
      round,
      runDir,
      runId: data.run_id,
      runRepoPath,
      source: lane.source,
      state: data.state,
      timeoutSeconds: resolveAdvisoryTimeoutSeconds(config.timeoutSecondsArg, lane.profile),
      trigger: lane.trigger,
    });
    advisoryRuns.push(advisoryRun);
    resultAdvisories.push({
      gating: lane.gating,
      lane_index: lane.index,
      model: advisoryModel,
      profile: lane.profile,
      reviewer: lane.reviewer,
      source: lane.source,
      status: "running",
      trigger: lane.trigger,
      policy_decision: policyDecision,
    });
  }
  return {
    advisoryRuns,
    resultAdvisory: resultListForOutput(resultAdvisories),
  };
}

function advisorySettlementWaitMs(config, hardenedAssurance) {
  return (hardenedAssurance ? config.timeoutSeconds : config.graceSeconds) * 1000;
}

function createAdvisorySettlementDeadline({ config, hardenedAssurance, now = Date.now() }) {
  return now + Math.max(0, advisorySettlementWaitMs(config, hardenedAssurance));
}

function remainingAdvisorySettlementWaitMs({ config, hardenedAssurance, settlementDeadlineMs = null }) {
  if (Number.isFinite(settlementDeadlineMs)) {
    return Math.max(0, settlementDeadlineMs - Date.now());
  }
  return advisorySettlementWaitMs(config, hardenedAssurance);
}

async function settleOneAdvisoryForVerdict({ advisoryRun, config, currentState, hardenedAssurance, settlementDeadlineMs = null, verdict }) {
  const waitStartedAt = Date.now();
  const waitMs = remainingAdvisorySettlementWaitMs({ config, hardenedAssurance, settlementDeadlineMs });
  const decisionState = verdict.verdict === "changes_requested"
    ? STATES.CHANGES_REQUESTED
    : verdict.verdict === "escalated"
      ? STATES.ESCALATED
      : currentState === STATES.INTERNAL_REVIEW_PENDING
        ? STATES.PUBLISH_PENDING
        : STATES.READY_TO_MERGE;
  let advisoryResult = await finishAdvisoryReview({
    advisoryRun,
    consumedByPhase: "review",
    criticalPathWaitMs: 0,
    resultDeadlineMs: settlementDeadlineMs,
    waitMs,
  });
  const criticalPathWaitMs = Date.now() - waitStartedAt;
  if (advisoryResult?.status === "deferred") {
    const consumedByPhase = classifyPostDecisionPhase(decisionState);
    writeAdvisoryDecision(advisoryRun, {
      consumedByPhase,
      criticalPathWaitMs,
      nextState: decisionState,
      phaseDecisionWaited: criticalPathWaitMs > 0,
    });
    advisoryResult = {
      ...advisoryResult,
      consumedByPhase,
      criticalPathWaitMs,
      phaseDecisionWaited: criticalPathWaitMs > 0,
    };
  } else {
    writeAdvisoryDecision(advisoryRun, {
      consumedByPhase: "review",
      criticalPathWaitMs,
      nextState: decisionState,
      phaseDecisionWaited: criticalPathWaitMs > 0,
    });
    advisoryResult = {
      ...advisoryResult,
      consumedByPhase: "review",
      criticalPathWaitMs,
      phaseDecisionWaited: criticalPathWaitMs > 0,
    };
  }
  if (hardenedAssurance && advisoryResult?.status === "success") {
    advisoryResult = await finishAdvisoryReview({
      advisoryRun,
      consumedByPhase: "review",
      criticalPathWaitMs,
      requireEventBoundSuccess: true,
      resultDeadlineMs: settlementDeadlineMs,
      waitMs: resolveHardenedBindingWaitMs(),
    });
    advisoryResult = {
      ...advisoryResult,
      consumedByPhase: "review",
      criticalPathWaitMs,
      phaseDecisionWaited: criticalPathWaitMs > 0,
    };
  }
  return {
    advisoryResult,
    resultAdvisory: { ...advisoryResult, source: advisoryRun.source },
  };
}

async function settleAdvisoryForVerdict({ advisoryRun = null, advisoryRuns = null, config, currentState, hardenedAssurance, settlementDeadlineMs = null, verdict }) {
  const runs = advisoryRuns || (advisoryRun ? [advisoryRun] : []);
  if (!runs.length) return { advisoryResult: null, advisoryResults: [], resultAdvisory: undefined };
  const settled = [];
  for (const run of runs) {
    settled.push(await settleOneAdvisoryForVerdict({
      advisoryRun: run,
      config,
      currentState,
      hardenedAssurance,
      settlementDeadlineMs,
      verdict,
    }));
  }
  const advisoryResults = settled.map((entry) => entry.advisoryResult);
  const resultAdvisories = settled.map((entry) => entry.resultAdvisory);
  return {
    advisoryResult: advisoryResults[0] || null,
    advisoryResults,
    resultAdvisory: resultListForOutput(resultAdvisories),
  };
}

async function settleConfiguredAdvisories({ advisoryRuns, config, currentState, hardenedAssurance, priorAdvisoryResults = [], result, settlementDeadlineMs = null, verdict }) {
  const settled = await settleAdvisoryForVerdict({
    advisoryRuns,
    config,
    currentState,
    hardenedAssurance,
    settlementDeadlineMs,
    verdict,
  });
  const advisoryResults = advisoryResultList(priorAdvisoryResults).concat(settled.advisoryResults);
  upsertResultAdvisory(result, settled.resultAdvisory);
  result.advisoryWarnings = advisoryWarningsFor(advisoryResults);
  return {
    ...settled,
    advisoryResult: advisoryResults[0] || null,
    advisoryResults,
    resultAdvisory: resultListForOutput(advisoryResults),
  };
}

module.exports = {
  ADVISORY_PROFILE_DEFAULTS,
  appendAdvisoryRunsForTrigger,
  createAdvisorySettlementDeadline,
  preflightConfiguredAdvisoryLanes,
  resolveAdvisoryConfig,
  resolveAdvisoryTimeoutSeconds,
  resolveHardenedBindingWaitMs,
  settleConfiguredAdvisories,
  settleAdvisoryForVerdict,
  startConfiguredAdvisory,
};
