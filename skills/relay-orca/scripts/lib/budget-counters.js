"use strict";

// Budget counters + `budget:` gate expression parsing (#947 D5). Pure: no I/O.
//
// The three counters — tasks_created, dispatches_performed, waves_dispatched — are the
// ones the #944/#946 write points already imply, so they are DERIVED from the receipt's
// own identity/mapping (never a second state machine): a recorded orca_task_id means the
// task was created, a recorded dispatch_id means it was dispatched, and the distinct
// dispatched waves are the waves dispatched. An explicit receipt `counters` object (if a
// future write point adds one) takes precedence; otherwise the derived values are used.

const COUNTER_NAMES = Object.freeze(["tasks_created", "dispatches_performed", "waves_dispatched"]);

function deriveCounters(receipt) {
  const tasks = Array.isArray(receipt && receipt.tasks) ? receipt.tasks : [];
  const dispatchedWaves = new Set();
  let created = 0;
  let dispatched = 0;
  tasks.forEach((task) => {
    if (task && task.orca_task_id) created += 1;
    if (task && task.dispatch_id) {
      dispatched += 1;
      dispatchedWaves.add(task.wave);
    }
  });
  return { tasks_created: created, dispatches_performed: dispatched, waves_dispatched: dispatchedWaves.size };
}

// Effective counters: an explicit receipt.counters value overrides the derived one per
// counter (integer only), so an operator/future write point can pin a counter without
// losing the receipt-derived default for the others.
function effectiveCounters(receipt) {
  const derived = deriveCounters(receipt);
  const explicit = receipt && receipt.counters && typeof receipt.counters === "object" ? receipt.counters : {};
  const out = {};
  COUNTER_NAMES.forEach((name) => {
    out[name] = Number.isInteger(explicit[name]) ? explicit[name] : derived[name];
  });
  return out;
}

// Parse a `budget:` gate reference into { counter, ceiling }. Accepted forms (spaces
// tolerated): `<counter>:<int>`, `<counter><=<int>`, `<counter> <= <int>`,
// `<counter>=<int>`. The counter name is the leading identifier; the ceiling is the
// trailing non-negative integer. Returns null when either part is missing/invalid so the
// evaluator can fail closed (unevaluable) rather than guess a ceiling.
function parseBudgetRef(ref) {
  if (typeof ref !== "string") return null;
  const match = ref.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:<=|:|=)\s*(\d+)$/);
  if (!match) return null;
  return { counter: match[1], ceiling: Number(match[2]) };
}

module.exports = { COUNTER_NAMES, deriveCounters, effectiveCounters, parseBudgetRef };
