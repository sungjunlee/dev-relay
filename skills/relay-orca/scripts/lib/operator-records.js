"use strict";

// Apply the #947 additive OPERATOR records to a receipt mapping (D4/D5). Pure: no I/O —
// the atomic receipt persistence lives in the top-level run/resume scripts, which also
// supply the `resolved_at` timestamp. This module only carries forward existing additive
// records across a run's receipt rewrite and upserts the operator-flag record. A decision
// or authorization record is written ONLY when the caller passes an explicit operator flag
// (run/resume never fabricate one automatically).
const { buildDecisionRecord, buildAuthorizationRecord } = require("./decision-records");

const CARRY_FORWARD_KEYS = Object.freeze(["follow_ups", "decisions", "authorizations", "counters", "events"]);

// Upsert a record into an array field by `id` (replace same-id, else append). Preserves
// order for a stable, reproducible serialization.
function upsertById(list, record) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const index = arr.findIndex((entry) => entry && entry.id === record.id);
  if (index >= 0) arr[index] = record;
  else arr.push(record);
  return arr;
}

// Carry forward the additive record fields from a prior receipt into a freshly-built
// mapping (run rewrites the receipt from a fresh orchestration each invocation, so without
// this a previously-recorded decision/authorization/follow-up would be lost). resume
// operates on the live receipt object in place, so it passes no priorReceipt.
function carryForward(mapping, priorReceipt) {
  if (!priorReceipt || typeof priorReceipt !== "object") return;
  CARRY_FORWARD_KEYS.forEach((key) => {
    if (mapping[key] === undefined && priorReceipt[key] !== undefined) mapping[key] = priorReceipt[key];
  });
}

// Apply operator records to `mapping`. `decision` (when present) is
// { id, resolution, resolver, resolvedAt, gateDef }; `authorization` is { id, authorizer }.
// Returns the mutated mapping.
function applyOperatorRecords(mapping, { priorReceipt = null, decision = null, authorization = null } = {}) {
  carryForward(mapping, priorReceipt);
  if (decision && decision.id) {
    mapping.decisions = upsertById(mapping.decisions, buildDecisionRecord(decision));
  }
  if (authorization && authorization.id) {
    mapping.authorizations = upsertById(mapping.authorizations, buildAuthorizationRecord(authorization));
  }
  return mapping;
}

module.exports = { CARRY_FORWARD_KEYS, upsertById, carryForward, applyOperatorRecords };
