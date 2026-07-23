"use strict";

// Pure proof for a runtime-id rebind. The caller supplies the fresh live reads;
// this module never reads, writes, or invokes a subprocess. A proof is complete
// only when the live task inventory is exactly the receipt inventory and every row
// carries both the exact coordination marker and materialized spec identity.
const { coordinationMarkerFor } = require("./coordination-marker");
const { programSegment: defaultProgramSegment } = require("./program-segment");

const SPEC_FIELDS = Object.freeze(["spec", "task_spec", "specification"]);

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function failure(reason) {
  return { complete: false, reason, verified_rows: [] };
}

function parseSpec(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (!nonEmpty(value)) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function specCandidates(task) {
  return SPEC_FIELDS
    .filter((field) => Object.prototype.hasOwnProperty.call(task, field))
    .map((field) => parseSpec(task[field]));
}

function exactSpecIdentity(task, expectedSegment, expectedOutcome, expectedProgramId) {
  const specs = specCandidates(task);
  if (specs.length === 0 || specs.some((spec) => !spec)) return false;
  return specs.every((spec) => {
    if (spec.marker !== "relay-orca" || spec.outcome_id !== expectedOutcome) return false;
    const segment = spec.program_segment ?? spec.programSegment;
    const programId = spec.program_id ?? spec.programId;
    if (segment !== expectedSegment) return false;
    if (programId !== undefined && programId !== expectedProgramId) return false;
    return true;
  });
}

function proveRuntimeRebind({ receipt, programId, liveRuntimeId, tasks, programSegment = defaultProgramSegment }) {
  if (!receipt || typeof receipt !== "object" || !nonEmpty(programId)) return failure("receipt or program identity is unavailable");
  if (!nonEmpty(receipt.runtime_id) || !nonEmpty(liveRuntimeId) || receipt.runtime_id === liveRuntimeId) {
    return failure("runtime ids do not describe a rebind");
  }
  if (!Array.isArray(tasks)) return failure("live task-list is ambiguous");
  if (typeof programSegment !== "function") return failure("program segment encoder is unavailable");

  const expected = (receipt.tasks || []).filter((task) => task && nonEmpty(task.orca_task_id));
  if (expected.length === 0) return failure("receipt has no recorded Orca task ids");
  const expectedById = new Map();
  for (const task of expected) {
    if (!nonEmpty(task.outcome_id) || expectedById.has(task.orca_task_id)) return failure("receipt task inventory is ambiguous");
    expectedById.set(task.orca_task_id, task);
  }

  const liveById = new Map();
  for (const task of tasks) {
    if (!task || typeof task !== "object" || !nonEmpty(task.id) || liveById.has(task.id)) {
      return failure("live task-list is ambiguous");
    }
    liveById.set(task.id, task);
  }
  if (liveById.size !== expectedById.size) return failure("live task inventory is not an exact match");

  const segment = programSegment(programId);
  const verifiedRows = [];
  for (const [orcaTaskId, receiptTask] of expectedById) {
    const liveTask = liveById.get(orcaTaskId);
    if (!liveTask) return failure("a receipt-recorded Orca task is missing from the live task-list");
    const marker = coordinationMarkerFor(programId, receiptTask.outcome_id, programSegment);
    if (liveTask.task_title !== marker) return failure("live task coordination marker does not match");
    if (!exactSpecIdentity(liveTask, segment, receiptTask.outcome_id, programId)) return failure("live task spec identity does not match");
    verifiedRows.push({ orca_task_id: orcaTaskId, outcome_id: receiptTask.outcome_id });
  }

  return {
    complete: true,
    old_runtime_id: receipt.runtime_id,
    new_runtime_id: liveRuntimeId,
    verified_rows: verifiedRows,
  };
}

module.exports = { proveRuntimeRebind, parseSpec, exactSpecIdentity };
