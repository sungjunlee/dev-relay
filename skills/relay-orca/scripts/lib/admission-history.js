"use strict";

// Pure admission filtering for explicitly supplied, already-verified closure proofs.
// Filesystem and proof recomputation live at the top-level probe boundary. This module
// only classifies the one live task/gate snapshot, so no durable fact can become an
// authority merely by being present in a context file.
const {
  canonicalIntegrationQuestion,
  canonicalGateKey,
  gateId,
  inspectCanonicalGates,
} = require("./integration-lifecycle");

const ACTIVE_STATUSES = new Set(["pending", "ready", "dispatched", "blocked"]);
const TERMINAL_STATUSES = new Set(["completed", "failed"]);
const LEGACY_MESSAGE = "v0 admits only one active program per runtime and never adopts pre-existing state";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function failure(reasonCode, message) {
  return { ok: false, reasonCode, message };
}

function stableId(row, keys, label) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return failure("AMBIGUOUS_GLOBAL_STATE", `${label} row is not an object`);
  }
  const supplied = keys.filter((key) => key in row).map((key) => row[key]);
  if (supplied.some((value) => value !== null && !nonEmpty(value))) {
    return failure("AMBIGUOUS_GLOBAL_STATE", `${label} has a malformed stable id`);
  }
  const ids = [...new Set(supplied.filter(nonEmpty))];
  if (ids.length !== 1) return failure("AMBIGUOUS_GLOBAL_STATE", `${label} must have exactly one stable id`);
  return { ok: true, id: ids[0] };
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return failure("AMBIGUOUS_GLOBAL_STATE", "task-list tasks are not an array");
  const rows = [];
  const ids = new Set();
  for (const task of tasks) {
    const identified = stableId(task, ["id", "task_id", "taskId"], "task");
    if (!identified.ok) return identified;
    if (ids.has(identified.id)) return failure("AMBIGUOUS_GLOBAL_STATE", `task ${identified.id} appears more than once`);
    ids.add(identified.id);
    if (!nonEmpty(task.status) || (!TERMINAL_STATUSES.has(task.status) && !ACTIVE_STATUSES.has(task.status))) {
      return failure("AMBIGUOUS_GLOBAL_STATE", `task ${identified.id} has an unknown or missing status`);
    }
    rows.push({ ...task, id: identified.id });
  }
  rows.sort((left, right) => left.id.localeCompare(right.id));
  return { ok: true, rows, byId: new Map(rows.map((task) => [task.id, task])) };
}

function taskLink(gate) {
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    return failure("AMBIGUOUS_GLOBAL_STATE", "gate row is not an object");
  }
  const links = ["task_id", "task", "taskId"].filter((key) => key in gate).map((key) => gate[key]);
  if ("blocks" in gate) {
    if (!Array.isArray(gate.blocks)) return failure("AMBIGUOUS_GLOBAL_STATE", "gate blocks is not an array");
    links.push(...gate.blocks);
  }
  if (links.some((value) => !nonEmpty(value))) return failure("AMBIGUOUS_GLOBAL_STATE", "gate has a malformed task link");
  const ids = [...new Set(links)];
  if (ids.length !== 1) return failure("AMBIGUOUS_GLOBAL_STATE", "gate must link to exactly one task");
  return { ok: true, taskId: ids[0] };
}

function normalizeGates(gates) {
  if (!Array.isArray(gates)) return failure("AMBIGUOUS_GLOBAL_STATE", "gate-list gates are not an array");
  const rows = [];
  const ids = new Set();
  for (const gate of gates) {
    const identified = stableId(gate, ["id", "gate_id", "gateId"], "gate");
    if (!identified.ok) return identified;
    if (ids.has(identified.id)) return failure("AMBIGUOUS_GLOBAL_STATE", `gate ${identified.id} appears more than once`);
    ids.add(identified.id);
    const linked = taskLink(gate);
    if (!linked.ok) return linked;
    rows.push({ ...gate, id: identified.id, taskId: linked.taskId });
  }
  rows.sort((left, right) => left.id.localeCompare(right.id));
  return { ok: true, rows, byId: new Map(rows.map((gate) => [gate.id, gate])) };
}

function unwrapProgram(value) {
  return value && value.program && typeof value.program === "object" ? value.program : value;
}

function exactOutcome(program, outcomeId) {
  const candidate = unwrapProgram(program);
  const outcomes = candidate && Array.isArray(candidate.outcomes) ? candidate.outcomes : [];
  const matches = outcomes.filter((outcome) => outcome && outcome.id === outcomeId);
  return matches.length === 1 ? matches[0] : null;
}

function proofIndexes(contexts, gates, segment) {
  const taskOwners = new Map();
  const gateOwners = new Map();
  const seenPrograms = new Set();
  const ordered = contexts.slice().sort((left, right) => {
    const program = String(left.program.id).localeCompare(String(right.program.id));
    return program || String(left.contextPath).localeCompare(String(right.contextPath));
  });

  for (const context of ordered) {
    const programId = context.program.id;
    if (seenPrograms.has(programId)) return failure("AMBIGUOUS_GLOBAL_STATE", `prior-program context ${programId} is duplicated or contradictory`);
    seenPrograms.add(programId);
    const proof = context.proof;
    // A recomputed proof that describes a known failed/pending lifecycle is not
    // authority for any exemption, but its live residue is still a valid blocking
    // state and must be reported through exit 34. Loader failures and identity
    // contradictions never reach this branch; they fail closed as exit 35.
    if (!proof || proof.ok !== true) continue;
    const receiptTasks = Array.isArray(context.receipt.tasks) ? context.receipt.tasks : [];
    const proofTasks = new Set(proof.orca_task_ids || []);
    for (const taskId of proofTasks) {
      const entries = receiptTasks.filter((entry) => entry && entry.orca_task_id === taskId);
      if (entries.length !== 1) return failure("AMBIGUOUS_GLOBAL_STATE", `prior-program proof ${programId} has an ambiguous task mapping`);
      const entry = entries[0];
      if (!exactOutcome(context.program, entry.outcome_id)) {
        return failure("AMBIGUOUS_GLOBAL_STATE", `prior-program proof ${programId} maps an unaccepted outcome`);
      }
      if (taskOwners.has(taskId)) return failure("AMBIGUOUS_GLOBAL_STATE", `task ${taskId} is covered by multiple prior-program proofs`);
      taskOwners.set(taskId, { context, taskId, outcomeId: entry.outcome_id });
    }

    const proofGates = new Set(proof.integration_gate_ids || []);
    for (const entry of receiptTasks.filter((candidate) => candidate && candidate.kind === "integration_gate")) {
      const outcome = exactOutcome(context.program, entry.outcome_id);
      if (!outcome) return failure("AMBIGUOUS_GLOBAL_STATE", `prior-program proof ${programId} has an invalid integration mapping`);
      let identity;
      try {
        identity = canonicalGateKey({
          taskId: entry.orca_task_id,
          question: canonicalIntegrationQuestion(programId, entry.outcome_id, segment),
        });
      } catch {
        return failure("AMBIGUOUS_GLOBAL_STATE", `prior-program proof ${programId} has an unavailable canonical gate identity`);
      }
      const inspected = inspectCanonicalGates(gates, identity);
      if (!inspected.ok || inspected.state === "missing" || !inspected.gate) continue;
      const physicalId = gateId(inspected.gate);
      if (!physicalId || !proofGates.has(physicalId)) continue;
      if (gateOwners.has(physicalId)) return failure("AMBIGUOUS_GLOBAL_STATE", `gate ${physicalId} is covered by multiple prior-program proofs`);
      gateOwners.set(physicalId, { context, taskId: entry.orca_task_id });
    }
  }
  return { ok: true, taskOwners, gateOwners };
}

function classifyHistoricalState({ tasks, gates, contexts, programSegment: segment }) {
  const normalizedTasks = normalizeTasks(tasks);
  if (!normalizedTasks.ok) return normalizedTasks;
  const normalizedGates = normalizeGates(gates);
  if (!normalizedGates.ok) return normalizedGates;
  const indexes = proofIndexes(contexts, normalizedGates.rows, segment);
  if (!indexes.ok) return indexes;

  let blockingTasks = 0;
  for (const task of normalizedTasks.rows) {
    const owner = indexes.taskOwners.get(task.id);
    const marker = owner && `relay-orca: ${segment(owner.context.program.id)}/${owner.outcomeId}`;
    const exempt = Boolean(owner && task.status === "completed" && taskDisplay(task) === marker);
    if (!exempt) blockingTasks += 1;
  }

  let blockingGates = 0;
  for (const gate of normalizedGates.rows) {
    const owner = indexes.gateOwners.get(gate.id);
    const taskOwner = indexes.taskOwners.get(gate.taskId);
    const exempt = Boolean(owner && taskOwner && owner.taskId === gate.taskId && taskOwner.context === owner.context
      && normalizedTasks.byId.get(gate.taskId)?.status === "completed"
      && taskDisplay(normalizedTasks.byId.get(gate.taskId)) === `relay-orca: ${segment(taskOwner.context.program.id)}/${taskOwner.outcomeId}`);
    if (!exempt) blockingGates += 1;
  }

  if (blockingTasks > 0 || blockingGates > 0) {
    return {
      ok: false,
      reasonCode: "EXISTING_ORCHESTRATION_STATE",
      message: `existing orchestration state rejected (active_tasks=${blockingTasks}, gates=${blockingGates}); ${LEGACY_MESSAGE}`,
      activeTasks: blockingTasks,
      blockingGates,
    };
  }
  return { ok: true, activeTasks: 0, blockingGates: 0 };
}

function taskDisplay(task) {
  return [task && task.task_title, task && task.display_name, task && task.title].find(nonEmpty) || "";
}

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  normalizeTasks,
  normalizeGates,
  classifyHistoricalState,
  taskDisplay,
};
