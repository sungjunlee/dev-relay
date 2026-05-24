const fs = require("fs");
const path = require("path");
const { getActorName } = require("./manifest/store");
const { ensureRunLayout, getEventsPath, getRunsDir } = require("./manifest/paths");
const {
  appendTextFileWithoutFollowingSymlinks,
  readTextFileWithoutFollowingSymlinks,
} = require("./manifest/rubric");

// EVENTS covers write-time names that land in ~/.relay/runs/<slug>/<run-id>/events.jsonl
// through appendRunEvent, recover-commit's appendRecoveryEvent wrapper, or the three
// helper writers in this module. Out of scope: relay-ready/scripts/relay-request.js
// writes a separate ~/.relay/requests/ artifact log, and worktree-runtime.js emits
// pluggable logger metadata rather than journal entries. Historical-only journal names
// (manual_recovery, manual_state_correction, manual_state_override) are intentionally
// absent: current producer code no longer emits them, and readRunEvents remains tolerant
// because validation is write-only.
const EVENTS = Object.freeze({
  ADVISORY_REVIEW: "advisory_review",
  // Consumer: /relay records the user's explicit proceed-anyway choice after a failed readiness probe.
  BYPASS_OVERRIDE_BY_USER: "bypass_override_by_user",
  CLEANUP_RESULT: "cleanup_result",
  CLOSE: "close",
  CONFLICTING_RUN_OVERRIDE: "conflicting_run_override",
  DISPATCH_RESULT: "dispatch_result",
  DISPATCH_START: "dispatch_start",
  ENVIRONMENT_DRIFT: "environment_drift",
  ESCALATION_DECISION: "escalation_decision",
  EXECUTION_EVIDENCE_REBRANDED: "execution_evidence_rebranded",
  FORCE_FINALIZE: "force_finalize",
  GUIDANCE_SELECTED: "guidance_selected",
  ITERATION_SCORE: "iteration_score",
  MERGE_BLOCKED: "merge_blocked",
  MERGE_FINALIZE: "merge_finalize",
  MODEL_HINTS_UPDATED: "model_hints_updated",
  PR_BODY_SNAPSHOT_FAILED: "pr_body_snapshot_failed",
  PR_NUMBER_STAMPED: "pr_number_stamped",
  // Consumer: /relay records an interactive abort when readiness gaps should stop the run.
  READINESS_CHECK_FAILED: "readiness_check_failed",
  // Consumer: /relay records a non-interactive readiness failure that cannot ask the chain prompt.
  READINESS_CHECK_FAILED_NONTTY: "readiness_check_failed_nontty",
  // Consumer: /relay-ready probe CLI records deterministic readiness scores before /relay routing.
  READINESS_PROBE: "readiness_probe",
  RECOVER_COMMIT: "recover_commit",
  RECOVER_COMMIT_FAILED: "recover_commit_failed",
  REVIEW_APPLY: "review_apply",
  REVIEW_INVOKE: "review_invoke",
  REVIEWER_SWAP: "reviewer_swap",
  RUBRIC_QUALITY: "rubric_quality",
  SCORE_DIVERGENCE: "score_divergence",
  SIDECAR_FAILED: "sidecar_failed",
  SIDECAR_RESULT: "sidecar_result",
  SIDECAR_START: "sidecar_start",
  SKIP_REVIEW: "skip_review",
  STATE_RECOVERY: "state_recovery",
});

const EVENT_VALUES = Object.freeze(Object.values(EVENTS));

function validateKnownEventName(eventName) {
  if (!EVENT_VALUES.includes(eventName)) {
    throw new Error(
      `Unknown relay event name "${String(eventName)}"; expected one of: ${EVENT_VALUES.join(", ")}`
    );
  }
}

function appendEventLine(repoRoot, runId, record) {
  const eventsPath = getEventsPath(repoRoot, runId);
  appendEventLineToPath(eventsPath, record);
}

function appendEventLineToPath(eventsPath, record) {
  if (typeof eventsPath !== "string" || !eventsPath.trim()) {
    throw new Error("eventsPath is required to append a relay event");
  }

  validateKnownEventName(record?.event);
  const resolvedEventsPath = path.resolve(eventsPath);
  try {
    fs.mkdirSync(path.dirname(resolvedEventsPath), { recursive: true });
    appendTextFileWithoutFollowingSymlinks(resolvedEventsPath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new Error(
        `Refusing to append to symlinked events.jsonl at ${resolvedEventsPath}: ${error.message}`
      );
    }
    throw error;
  }
}

const ALLOWED_ITERATION_STATUSES = new Set(["pass", "fail", "not_run"]);
const ALLOWED_SCORE_TIERS = new Set(["contract", "quality"]);
const ALLOWED_RUBRIC_GRADES = new Set(["A", "B", "C", "D"]);
const ALLOWED_TASK_SIZES = new Set(["S", "M", "L", "XL"]);

function normalizeEventValue(value) {
  return value === undefined ? null : value;
}

function appendRunEvent(repoRoot, runId, eventData) {
  if (!runId) {
    throw new Error("run_id is required to append a relay event");
  }
  if (!String(eventData?.event || "").trim()) {
    throw new Error("event is required to append a relay event");
  }

  ensureRunLayout(repoRoot, runId);
  const record = {
    ts: eventData.ts || new Date().toISOString(),
    event: eventData.event,
    actor: getActorName(repoRoot),
    run_id: runId,
    state_from: normalizeEventValue(eventData.state_from),
    state_to: normalizeEventValue(eventData.state_to),
    head_sha: normalizeEventValue(eventData.head_sha),
    round: normalizeEventValue(eventData.round),
    reason: normalizeEventValue(eventData.reason),
    ...(eventData.origin !== undefined
      ? { origin: normalizeEventValue(eventData.origin) }
      : {}),
    ...(eventData.override_class !== undefined
      ? { override_class: normalizeEventValue(eventData.override_class) }
      : {}),
    ...(eventData.affected_head_sha !== undefined
      ? { affected_head_sha: normalizeEventValue(eventData.affected_head_sha) }
      : {}),
    ...(eventData.prior_state !== undefined
      ? { prior_state: normalizeEventValue(eventData.prior_state) }
      : {}),
    ...(eventData.required_reason !== undefined
      ? { required_reason: normalizeEventValue(eventData.required_reason) }
      : {}),
    ...(eventData.operator_initiated !== undefined
      ? { operator_initiated: eventData.operator_initiated === true }
      : {}),
    ...(eventData.independent_attestation !== undefined
      ? { independent_attestation: normalizeEventValue(eventData.independent_attestation) }
      : {}),
    ...(eventData.reviewer !== undefined
      ? { reviewer: normalizeEventValue(eventData.reviewer) }
      : {}),
    ...(eventData.rubric_status !== undefined
      ? { rubric_status: normalizeEventValue(eventData.rubric_status) }
      : {}),
    ...(eventData.last_reviewed_sha !== undefined
      ? { last_reviewed_sha: normalizeEventValue(eventData.last_reviewed_sha) }
      : {}),
    ...(eventData.previous_head_sha !== undefined
      ? { previous_head_sha: normalizeEventValue(eventData.previous_head_sha) }
      : {}),
    ...(eventData.new_head_sha !== undefined
      ? { new_head_sha: normalizeEventValue(eventData.new_head_sha) }
      : {}),
    ...(eventData.pr_number !== undefined
      ? { pr_number: normalizeEventValue(eventData.pr_number) }
      : {}),
    ...(eventData.pr_body_only !== undefined
      ? { pr_body_only: eventData.pr_body_only === true }
      : {}),
    ...(eventData.commit_sha !== undefined
      ? { commit_sha: normalizeEventValue(eventData.commit_sha) }
      : {}),
    ...(eventData.branch !== undefined
      ? { branch: normalizeEventValue(eventData.branch) }
      : {}),
    ...(eventData.bootstrap_exempt !== undefined
      ? { bootstrap_exempt: eventData.bootstrap_exempt === true }
      : {}),
    ...(eventData.executor !== undefined
      ? { executor: normalizeEventValue(eventData.executor) }
      : {}),
    ...(eventData.kind !== undefined
      ? { kind: normalizeEventValue(eventData.kind) }
      : {}),
    ...(eventData.model !== undefined
      ? { model: normalizeEventValue(eventData.model) }
      : {}),
    ...(eventData.provider !== undefined
      ? { provider: normalizeEventValue(eventData.provider) }
      : {}),
    ...(eventData.executor_network !== undefined
      ? { executor_network: normalizeEventValue(eventData.executor_network) }
      : {}),
    ...(eventData.failure_class !== undefined
      ? { failure_class: normalizeEventValue(eventData.failure_class) }
      : {}),
    ...(eventData.execution_evidence_path !== undefined
      ? { execution_evidence_path: normalizeEventValue(eventData.execution_evidence_path) }
      : {}),
    ...(eventData.execution_evidence_hash !== undefined
      ? { execution_evidence_hash: normalizeEventValue(eventData.execution_evidence_hash) }
      : {}),
    ...(eventData.before !== undefined
      ? { before: normalizeEventValue(eventData.before) }
      : {}),
    ...(eventData.after !== undefined
      ? { after: normalizeEventValue(eventData.after) }
      : {}),
    ...(eventData.from_reviewer !== undefined
      ? { from_reviewer: normalizeEventValue(eventData.from_reviewer) }
      : {}),
    ...(eventData.to_reviewer !== undefined
      ? { to_reviewer: normalizeEventValue(eventData.to_reviewer) }
      : {}),
    ...(eventData.reviewer_swap_count !== undefined
      ? { reviewer_swap_count: normalizeEventValue(eventData.reviewer_swap_count) }
      : {}),
    ...(eventData.trigger !== undefined
      ? { trigger: normalizeEventValue(eventData.trigger) }
      : {}),
    ...(eventData.factors !== undefined
      ? { factors: normalizeEventValue(eventData.factors) }
      : {}),
    ...(eventData.traces !== undefined
      ? { traces: normalizeEventValue(eventData.traces) }
      : {}),
    ...(eventData.lineage_summary !== undefined
      ? { lineage_summary: normalizeEventValue(eventData.lineage_summary) }
      : {}),
    ...(eventData.decision !== undefined
      ? { decision: normalizeEventValue(eventData.decision) }
      : {}),
    ...(eventData.guidance_packs !== undefined
      ? { guidance_packs: normalizeEventValue(eventData.guidance_packs) }
      : {}),
    ...(eventData.task_profile_summary !== undefined
      ? { task_profile_summary: normalizeEventValue(eventData.task_profile_summary) }
      : {}),
    ...(eventData.guidance_source !== undefined
      ? { guidance_source: normalizeEventValue(eventData.guidance_source) }
      : {}),
    ...(eventData.guidance_artifact_path !== undefined
      ? { guidance_artifact_path: normalizeEventValue(eventData.guidance_artifact_path) }
      : {}),
    ...(eventData.profile !== undefined
      ? { profile: normalizeEventValue(eventData.profile) }
      : {}),
    ...(eventData.status !== undefined
      ? { status: normalizeEventValue(eventData.status) }
      : {}),
    ...(eventData.artifact_path !== undefined
      ? { artifact_path: normalizeEventValue(eventData.artifact_path) }
      : {}),
    ...(eventData.advisory_artifact_hash !== undefined
      ? { advisory_artifact_hash: normalizeEventValue(eventData.advisory_artifact_hash) }
      : {}),
    ...(eventData.output_path !== undefined
      ? { output_path: normalizeEventValue(eventData.output_path) }
      : {}),
    ...(eventData.raw_response_path !== undefined
      ? { raw_response_path: normalizeEventValue(eventData.raw_response_path) }
      : {}),
    ...(eventData.required_count !== undefined
      ? { required_count: normalizeEventValue(eventData.required_count) }
      : {}),
    ...(eventData.advisory_count !== undefined
      ? { advisory_count: normalizeEventValue(eventData.advisory_count) }
      : {}),
    ...(eventData.duplicate_low_confidence_count !== undefined
      ? { duplicate_low_confidence_count: normalizeEventValue(eventData.duplicate_low_confidence_count) }
      : {}),
    ...(eventData.elapsed_ms !== undefined
      ? { elapsed_ms: normalizeEventValue(eventData.elapsed_ms) }
      : {}),
    ...(eventData.failure_reason !== undefined
      ? { failure_reason: normalizeEventValue(eventData.failure_reason) }
      : {}),
    ...(eventData.sidecar_id !== undefined
      ? { sidecar_id: normalizeEventValue(eventData.sidecar_id) }
      : {}),
    ...(eventData.trust_level !== undefined
      ? { trust_level: normalizeEventValue(eventData.trust_level) }
      : {}),
  };

  appendEventLine(repoRoot, runId, record);
  return record;
}

function appendIterationScore(repoRoot, runId, { round, scores } = {}) {
  if (!runId) {
    throw new Error("run_id is required");
  }
  if (!Array.isArray(scores) || scores.length === 0) {
    throw new Error("scores must be a non-empty array");
  }

  for (const [index, score] of scores.entries()) {
    const location = `scores[${index}]`;
    if (typeof score?.factor !== "string" || !score.factor.trim()) {
      throw new Error(`${location}.factor is required`);
    }
    if (typeof score.target !== "string") {
      throw new Error(`${location}.target is required`);
    }
    if (typeof score.observed !== "string") {
      throw new Error(`${location}.observed is required`);
    }
    if (typeof score.met !== "boolean") {
      throw new Error(`${location}.met must be boolean`);
    }
    if (!ALLOWED_ITERATION_STATUSES.has(score.status)) {
      throw new Error(`${location}.status must be one of: pass, fail, not_run`);
    }
    for (const key of ["score", "target_score"]) {
      if (score[key] !== undefined && score[key] !== null && (typeof score[key] !== "number" || !Number.isFinite(score[key]))) {
        throw new Error(`${location}.${key} must be a finite number or null`);
      }
      if (typeof score[key] === "number" && (score[key] < 0 || score[key] > 10)) {
        throw new Error(`${location}.${key} must be between 0 and 10`);
      }
    }
  }

  ensureRunLayout(repoRoot, runId);
  const record = {
    ts: new Date().toISOString(),
    event: EVENTS.ITERATION_SCORE,
    actor: getActorName(repoRoot),
    run_id: runId,
    round,
    scores: scores.map((score) => ({
      factor: score.factor,
      target: score.target,
      observed: score.observed,
      ...(typeof score.score === "number" && Number.isFinite(score.score) ? { score: score.score } : {}),
      ...(typeof score.target_score === "number" && Number.isFinite(score.target_score) ? { target_score: score.target_score } : {}),
      met: score.met,
      status: score.status,
      ...(ALLOWED_SCORE_TIERS.has(score.tier) ? { tier: score.tier } : {}),
    })),
  };

  appendEventLine(repoRoot, runId, record);
  return record;
}

function appendRubricQuality(repoRoot, runId, data = {}) {
  if (!runId) {
    throw new Error("run_id is required");
  }
  if (!ALLOWED_RUBRIC_GRADES.has(data.grade)) {
    throw new Error("grade must be one of: A, B, C, D");
  }
  for (const field of ["prerequisites", "contract_factors", "quality_factors", "substantive_total"]) {
    if (typeof data[field] !== "number" || Number.isNaN(data[field])) {
      throw new Error(`${field} must be a number`);
    }
  }
  for (const field of ["quality_ratio", "auto_coverage"]) {
    if (typeof data[field] !== "number" || Number.isNaN(data[field])) {
      throw new Error(`${field} must be a number`);
    }
  }
  if (!Array.isArray(data.risk_signals)) {
    throw new Error("risk_signals must be an array of strings");
  }
  data.risk_signals.forEach((signal, index) => {
    if (typeof signal !== "string") {
      throw new Error(`risk_signals[${index}] must be a string`);
    }
  });
  if (!ALLOWED_TASK_SIZES.has(data.task_size)) {
    throw new Error("task_size must be one of: S, M, L, XL");
  }

  ensureRunLayout(repoRoot, runId);
  const record = {
    ts: new Date().toISOString(),
    event: EVENTS.RUBRIC_QUALITY,
    actor: getActorName(repoRoot),
    run_id: runId,
    grade: data.grade,
    prerequisites: data.prerequisites,
    contract_factors: data.contract_factors,
    quality_factors: data.quality_factors,
    substantive_total: data.substantive_total,
    quality_ratio: data.quality_ratio,
    auto_coverage: data.auto_coverage,
    risk_signals: [...data.risk_signals],
    task_size: data.task_size,
  };

  appendEventLine(repoRoot, runId, record);
  return record;
}

function appendScoreDivergence(repoRoot, runId, { round, divergences } = {}) {
  if (!runId) {
    throw new Error("run_id is required");
  }
  if (!Array.isArray(divergences) || divergences.length === 0) {
    throw new Error("divergences must be a non-empty array");
  }

  divergences.forEach((entry, index) => {
    const location = `divergences[${index}]`;
    if (typeof entry?.factor !== "string" || !entry.factor.trim()) {
      throw new Error(`${location}.factor is required`);
    }
    if (typeof entry.executor !== "string") {
      throw new Error(`${location}.executor must be a string`);
    }
    if (typeof entry.reviewer !== "string") {
      throw new Error(`${location}.reviewer must be a string`);
    }
    if (typeof entry.delta !== "number" || Number.isNaN(entry.delta)) {
      throw new Error(`${location}.delta must be a number`);
    }
    if (!ALLOWED_SCORE_TIERS.has(entry.tier)) {
      throw new Error(`${location}.tier must be one of: contract, quality`);
    }
  });

  ensureRunLayout(repoRoot, runId);
  const record = {
    ts: new Date().toISOString(),
    event: EVENTS.SCORE_DIVERGENCE,
    actor: getActorName(repoRoot),
    run_id: runId,
    round,
    divergences: divergences.map((entry) => ({
      factor: entry.factor,
      executor: entry.executor,
      reviewer: entry.reviewer,
      delta: entry.delta,
      tier: entry.tier,
    })),
  };

  appendEventLine(repoRoot, runId, record);
  return record;
}

function readRunEvents(repoRoot, runId) {
  const eventsPath = getEventsPath(repoRoot, runId);
  // Do NOT short-circuit on fs.existsSync — existsSync follows symlinks, so a
  // dangling symlink at eventsPath would return false and we'd silently
  // return []. That's exactly the fail-open class #157/#197 prohibit. Let
  // the safe reader handle the symlink check; distinguish ENOENT (truly
  // missing) from ELOOP (symlink refused) in the catch.
  let rawText;
  try {
    rawText = readTextFileWithoutFollowingSymlinks(eventsPath);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    if (error.code === "ELOOP") {
      throw new Error(
        `Refusing to read symlinked events.jsonl at ${eventsPath}: ${error.message}`
      );
    }
    throw error;
  }
  return rawText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readAllRunEvents(repoRoot) {
  const runsDir = getRunsDir(repoRoot);
  if (!fs.existsSync(runsDir)) return [];

  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readRunEvents(repoRoot, entry.name));
}

module.exports = {
  appendEventLineToPath,
  appendIterationScore,
  appendRubricQuality,
  appendRunEvent,
  appendScoreDivergence,
  EVENTS,
  readAllRunEvents,
  readRunEvents,
};
