"use strict";

// Pure validation and receipt-object update logic for explicit relay run mapping intake.
// The entry script supplies the accepted program and already-read manifest records. This
// module never performs live reconciliation and never persists anything itself.
const { decisionEntry, exitCodeFor } = require("./resume-reasons");

const MAPPABLE_KINDS = new Set(["relay_run", "tracker_reconciliation"]);

function reject(reasonCode, message) {
  return {
    ok: false,
    decision: decisionEntry(reasonCode, message),
    exitCode: exitCodeFor(reasonCode),
    mappings: [],
  };
}

function programOutcomes(program) {
  return program && Array.isArray(program.outcomes) ? program.outcomes : [];
}

function declaredIssue(outcome) {
  return outcome && outcome.issue !== undefined && outcome.issue !== null ? outcome.issue : null;
}

function issuesEqual(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
}

// Validate category-by-category so the documented order is deterministic across a batch:
// target, manifest existence, tracker issue, then duplicate/contradictory mappings.
function validateRelayRunMappings({ receipt, program, requested, manifests }) {
  const tasks = Array.isArray(receipt && receipt.tasks) ? receipt.tasks : [];
  const outcomes = programOutcomes(program);
  const manifestList = Array.isArray(manifests) ? manifests : [];
  const prepared = [];

  for (const mapping of requested || []) {
    const task = tasks.find((entry) => entry.outcome_id === mapping.outcome_id) || null;
    const outcome = outcomes.find((entry) => entry && entry.id === mapping.outcome_id) || null;
    const issue = declaredIssue(outcome);
    if (!task || !MAPPABLE_KINDS.has(task.kind) || issue === null) {
      return reject(
        "RESUME_MAP_TARGET_INVALID",
        `outcome ${mapping.outcome_id} is not a receipt target that accepts relay run mapping with a declared issue`,
      );
    }
    prepared.push({ ...mapping, task, issue, manifest: null });
  }

  for (const mapping of prepared) {
    mapping.manifest = manifestList.find((entry) => entry.run_id === mapping.run_id) || null;
    if (!mapping.manifest) {
      return reject(
        "RESUME_MAP_RUN_NOT_FOUND",
        `relay run manifest ${mapping.run_id} was not found by exact filename stem under the repository runs root`,
      );
    }
  }

  for (const mapping of prepared) {
    const manifestIssue = mapping.manifest.parsed && mapping.manifest.parsed.issue_number;
    if (!issuesEqual(manifestIssue, mapping.issue)) {
      return reject(
        "RESUME_MAP_ISSUE_MISMATCH",
        `relay run ${mapping.run_id} issue ${manifestIssue} does not match outcome ${mapping.outcome_id} issue ${mapping.issue}`,
      );
    }
  }

  const runOwner = new Map();
  const targetRun = new Map();
  for (const mapping of prepared) {
    const existing = mapping.task.relay_ids && mapping.task.relay_ids.run;
    const owner = tasks.find((task) => (
      task.outcome_id !== mapping.outcome_id
      && task.relay_ids
      && task.relay_ids.run === mapping.run_id
    ));
    const requestedOwner = runOwner.get(mapping.run_id);
    const requestedForTarget = targetRun.get(mapping.outcome_id);
    if ((existing && existing !== mapping.run_id)
      || owner
      || (requestedOwner && requestedOwner !== mapping.outcome_id)
      || (requestedForTarget && requestedForTarget !== mapping.run_id)) {
      return reject(
        "RESUME_CONFLICTING_MAPPING",
        `relay run ${mapping.run_id} conflicts with an existing or requested mapping for outcome ${mapping.outcome_id}`,
      );
    }
    targetRun.set(mapping.outcome_id, mapping.run_id);
    runOwner.set(mapping.run_id, mapping.outcome_id);
  }

  return {
    ok: true,
    decision: null,
    exitCode: 0,
    mappings: [...targetRun].map(([outcome_id, run_id]) => ({ outcome_id, run_id })),
  };
}

function applyRelayRunMappings(receipt, mappings) {
  let changed = false;
  const taskByOutcome = new Map((receipt.tasks || []).map((task) => [task.outcome_id, task]));
  (mappings || []).forEach((mapping) => {
    const task = taskByOutcome.get(mapping.outcome_id);
    if (task.relay_ids.run !== mapping.run_id) {
      task.relay_ids.run = mapping.run_id;
      changed = true;
    }
  });
  return changed;
}

module.exports = { MAPPABLE_KINDS, validateRelayRunMappings, applyRelayRunMappings };
