"use strict";

const { reject } = require("./reasons");
const { assertSupportedKind, assertPreparedFleet, routeFor, defaultEvidenceFor } = require("./task-kinds");
const { normalizeDependsOn, edgesFor, assertAcyclic, computeLevels, declaredLevels, groupIntoWaves } = require("./waves");

const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;

// Ownership invariants surfaced in every plan (D10): Orca supervises operators,
// relay owns implementation, lifecycle signals are not completion authority.
const INVARIANTS = Object.freeze({
  orca_workers_are_operators: "Orca workers are relay OPERATORS, not direct code workers",
  relay_owns_worktrees: "relay owns implementation worktrees and durable run manifests",
  lifecycle_not_completion: "Orca task status and worker_done are lifecycle signals, NOT completion authority",
  max_depth: "coordinator -> relay/fleet operator -> relay executor/reviewer",
  nested_relay_orca: "forbidden",
});

function unwrapProgram(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    reject("INVALID_INPUT", "accepted program must be a JSON object");
  }
  const program = input.program && typeof input.program === "object" ? input.program : input;
  if (typeof program.id !== "string" || program.id.trim() === "") {
    reject("INVALID_INPUT", "program.id is required and must be a non-empty string");
  }
  if (program.nested === true || program.parent_program_kind === "relay_orca") {
    reject("NESTED_RELAY_ORCA", "this program declares itself nested under another relay-orca program");
  }
  return program;
}

function resolveConcurrency(program, override) {
  const raw = override !== undefined ? override : program.concurrency;
  const value = raw === undefined || raw === null ? DEFAULT_CONCURRENCY : raw;
  if (!Number.isInteger(value) || value < 1) {
    reject("INVALID_INPUT", `concurrency must be an integer >= 1 (got ${JSON.stringify(value)})`);
  }
  if (value > MAX_CONCURRENCY) {
    reject("CONCURRENCY_EXCEEDED", `concurrency ${value} exceeds the hard maximum of ${MAX_CONCURRENCY}`);
  }
  return value;
}

function assertExitGates(program) {
  const gates = program.exit_gates;
  if (!Array.isArray(gates) || gates.filter((gate) => typeof gate === "string" && gate.trim()).length === 0) {
    reject("MISSING_EXIT_GATES", "program.exit_gates must list at least one non-empty exit gate");
  }
}

function assertOutcomes(program) {
  if (!Array.isArray(program.outcomes) || program.outcomes.length === 0) {
    reject("INVALID_INPUT", "program.outcomes must be a non-empty array");
  }
}

function slug(id) {
  return String(id).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function taskIdOf(outcomeId) {
  const normalized = slug(outcomeId);
  if (!normalized) reject("INVALID_INPUT", `outcome id ${JSON.stringify(outcomeId)} does not yield a stable task id`);
  return `orca-task-${normalized}`;
}

function assertDepthAndNesting(outcome) {
  const route = outcome.route || (outcome.recommended_route && outcome.recommended_route.operator);
  if (route === "relay-orca" || route === "relay_orca") {
    reject("NESTED_RELAY_ORCA", `outcome ${outcome.id} routes to relay-orca; nested relay-orca is forbidden`);
  }
  if (outcome.spawns_operators === true || outcome.sub_program || Array.isArray(outcome.orchestrates)) {
    reject("EXCESSIVE_DEPTH", `outcome ${outcome.id} declares sub-orchestration; depth beyond coordinator -> operator -> executor/reviewer is forbidden`);
  }
  if (outcome.depth !== undefined && outcome.depth !== null) {
    if (typeof outcome.depth !== "number" || !Number.isFinite(outcome.depth)) {
      reject("INVALID_INPUT", `outcome ${outcome.id} has invalid depth ${JSON.stringify(outcome.depth)} (expected a finite number)`);
    }
    if (outcome.depth > 1) {
      reject("EXCESSIVE_DEPTH", `outcome ${outcome.id} declares depth ${outcome.depth}; a single operator layer is the maximum`);
    }
  }
}

function assertAcceptedOutcomes(outcome) {
  const accepted = outcome.accepted_outcomes;
  const cleaned = Array.isArray(accepted) ? accepted.filter((item) => typeof item === "string" && item.trim()) : [];
  if (cleaned.length === 0) {
    reject("VAGUE_INTENT", `outcome ${outcome.id} has no accepted outcomes; raw/vague intent cannot be planned`);
  }
}

function validateOutcome(outcome, seenIds, seenTaskIds) {
  if (!outcome || typeof outcome !== "object" || typeof outcome.id !== "string" || outcome.id.trim() === "") {
    reject("INVALID_INPUT", "each outcome must be an object with a non-empty string id");
  }
  if (seenIds.has(outcome.id)) reject("DUPLICATE_OUTCOME_ID", `duplicate outcome id ${outcome.id}`);
  seenIds.add(outcome.id);
  const taskId = taskIdOf(outcome.id);
  if (seenTaskIds.has(taskId)) reject("DUPLICATE_OUTCOME_ID", `outcome ${outcome.id} collides on task id ${taskId}`);
  seenTaskIds.add(taskId);
  assertDepthAndNesting(outcome);
  assertSupportedKind(outcome);
  assertAcceptedOutcomes(outcome);
  assertPreparedFleet(outcome);
  return taskId;
}

function buildTask(outcome, taskId, waveIndex, taskIdByOutcome) {
  const deps = normalizeDependsOn(outcome);
  const evidence = Array.isArray(outcome.expected_evidence) && outcome.expected_evidence.length
    ? outcome.expected_evidence.slice()
    : defaultEvidenceFor(outcome.task_kind);
  return {
    task_id: taskId,
    outcome_id: outcome.id,
    title: typeof outcome.title === "string" ? outcome.title : null,
    issue: outcome.issue ?? null,
    kind: outcome.task_kind,
    wave: waveIndex,
    depends_on: deps.map((dep) => taskIdByOutcome.get(dep)).sort(),
    recommended_route: routeFor(outcome.task_kind),
    decision_gate: outcome.decision_gate ?? null,
    expected_evidence: evidence,
  };
}

function compileProgram(input, options = {}) {
  const program = unwrapProgram(input);
  const concurrency = resolveConcurrency(program, options.concurrency);
  assertExitGates(program);
  assertOutcomes(program);

  const seenIds = new Set();
  const seenTaskIds = new Set();
  const taskIdByOutcome = new Map();
  program.outcomes.forEach((outcome) => taskIdByOutcome.set(outcome.id, validateOutcome(outcome, seenIds, seenTaskIds)));

  const edges = edgesFor(program.outcomes);
  assertAcyclic(program.outcomes, edges);
  const declared = declaredLevels(program.outcomes, edges);
  const levels = declared || computeLevels(program.outcomes, edges);
  const waves = groupIntoWaves(program.outcomes, (id) => levels.get(id), taskIdOf);
  const waveByTaskId = new Map();
  waves.forEach((entry) => entry.task_ids.forEach((taskId) => waveByTaskId.set(taskId, entry.wave)));

  const tasks = program.outcomes
    .map((outcome) => {
      const taskId = taskIdByOutcome.get(outcome.id);
      return buildTask(outcome, taskId, waveByTaskId.get(taskId), taskIdByOutcome);
    })
    .sort((a, b) => a.task_id.localeCompare(b.task_id));

  return {
    ok: true,
    program_id: program.id,
    source: program.source ?? null,
    repo: program.repo ?? null,
    tracker: program.tracker ?? null,
    concurrency,
    exit_gates: program.exit_gates.filter((gate) => typeof gate === "string" && gate.trim()),
    decision_gates: Array.isArray(program.decision_gates) ? program.decision_gates : [],
    invariants: INVARIANTS,
    waves,
    tasks,
  };
}

module.exports = { compileProgram, DEFAULT_CONCURRENCY, MAX_CONCURRENCY, INVARIANTS };
