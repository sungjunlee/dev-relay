"use strict";

// relay-orca reconstructible bridge receipt (#945 D1). A minimal, versioned
// identity/mapping record — NOT a second state machine. It carries ONLY the program
// identity and the outcome→Orca/relay mapping; it must never record child lifecycle
// states, PR/issue status, Done Criteria text, completion flags, prompts, or terminal
// output. Atomic persistence (a temp file in the same directory, then rename) is
// performed by the top-level script; this module stays pure (no subprocess, no fs
// mutation) so plan.js's frozen lib source-scan keeps passing. It only shapes,
// orders, validates, and parses the receipt object.

const SCHEMA_VERSION = 1;

// The authority disclaimer carried verbatim in the receipt's `note` field AND in
// references/receipt-and-status.md (D1). This exact sentence is the reviewer anchor.
const RECEIPT_NOTE = "This receipt is reconstructible coordination metadata, not a source of truth.";

// Verbatim top-level key set (D1). `note` is included per D1.
const RECEIPT_KEYS = Object.freeze([
  "schema",
  "program_id",
  "source",
  "repo",
  "runtime_id",
  "tasks",
  "terminals_created",
  "created_at",
  "updated_at",
  "note",
]);

const TASK_KEYS = Object.freeze([
  "outcome_id",
  "task_id",
  "kind",
  "wave",
  "orca_task_id",
  "dispatch_id",
  "assignee",
  "relay_ids",
]);

const RELAY_ID_KEYS = Object.freeze(["request", "run", "fleet"]);

// #946 D5 stop record — appended ONLY by `stop`, and ONLY these two bounded fields:
// `stopped_at` (ISO-8601) and `stop_reason` (operator-provided, ≤256 chars). They are
// NOT part of RECEIPT_KEYS, so a receipt that never stopped serializes byte-identically
// to before (run/status receipts are unchanged). validateReceipt ignores extra keys, so
// a stopped receipt still loads for `status`/`resume`. The cap keeps a pathological
// operator reason from inflating the receipt.
const STOP_KEYS = Object.freeze(["stopped_at", "stop_reason"]);
const STOP_REASON_MAX = 256;

// #947 additive record fields — appended ONLY when present, AFTER the canonical
// RECEIPT_KEYS block and the optional stop record. They are NOT part of RECEIPT_KEYS, so a
// receipt that never carried them serializes byte-identically to before (existing
// #944/#945/#946 receipts and their assertions are unchanged). validateReceipt ignores
// extra keys, so a receipt carrying them still loads for status/resume. Each is written
// only at a pinned run/resume/flag point:
//   - follow_ups     : proposed follow-ups, written ONLY by `status --gates --record-proposals`
//   - decisions      : decision records, written ONLY via the run/resume --resolve-decision flag
//   - authorizations : authorization records, written ONLY via the run/resume --record-authorization flag
//   - counters       : optional explicit budget counters (otherwise derived from the mapping)
//   - events         : bounded coordination events, including runtime_rebound
const ADDITIVE_RECORD_KEYS = Object.freeze(["follow_ups", "decisions", "authorizations", "counters", "events"]);

// An additive record field is "present" (worth serializing) when it is a non-empty array
// or a non-empty object. Absent/empty → skipped, preserving byte-identity with a receipt
// that never carried it.
function additivePresent(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

function boundStopReason(value) {
  if (typeof value !== "string" || value === "") return "";
  return value.length <= STOP_REASON_MAX ? value : value.slice(0, STOP_REASON_MAX);
}

function relayIds(source) {
  const raw = source && typeof source === "object" ? source : {};
  const normalizeId = (value) => (typeof value === "string" && value.length > 0 ? value : null);
  return {
    request: normalizeId(raw.request),
    run: normalizeId(raw.run),
    fleet: normalizeId(raw.fleet),
  };
}

// Map one run-report task entry into a receipt task entry. Identity + mapping only.
function receiptTaskEntry(reportTask) {
  return {
    outcome_id: reportTask.outcome_id,
    task_id: reportTask.task_id,
    kind: reportTask.kind,
    wave: reportTask.wave,
    orca_task_id: reportTask.orca_task_id ?? null,
    dispatch_id: reportTask.dispatch_id ?? null,
    assignee: reportTask.assignee ?? null,
    relay_ids: relayIds(reportTask.relay_ids),
  };
}

// Build the receipt mapping from the live run report. Timestamps are stamped by the
// top-level persistence step (created_at preserved across writes), so they start null.
function buildReceiptMapping({ program_id, source, repo, runtimeId, tasks, terminalsCreated }) {
  if (!repo || typeof repo.slug !== "string" || typeof repo.root !== "string") {
    throw new Error("buildReceiptMapping requires repo { slug, root } strings");
  }
  return {
    schema: SCHEMA_VERSION,
    program_id,
    source: source ?? null,
    repo: { slug: repo.slug, root: repo.root },
    runtime_id: runtimeId ?? null,
    tasks: (tasks || []).map(receiptTaskEntry),
    terminals_created: Array.isArray(terminalsCreated) ? terminalsCreated.slice() : [],
    created_at: null,
    updated_at: null,
    note: RECEIPT_NOTE,
  };
}

// Emit the receipt with EXACTLY RECEIPT_KEYS in order, each task with TASK_KEYS in
// order, so the serialized bytes are deterministic regardless of build order.
function orderReceipt(receipt) {
  const ordered = {};
  RECEIPT_KEYS.forEach((key) => {
    ordered[key] = receipt[key];
  });
  ordered.repo = { slug: receipt.repo.slug, root: receipt.repo.root };
  ordered.tasks = (receipt.tasks || []).map((task) => {
    const entry = {};
    TASK_KEYS.forEach((key) => {
      entry[key] = task[key];
    });
    entry.relay_ids = relayIds(task.relay_ids);
    return entry;
  });
  return ordered;
}

function serializeReceipt(receipt) {
  return `${JSON.stringify(orderReceipt(receipt), null, 2)}\n`;
}

// #946 D5: serialize a receipt that MAY carry a bounded stop record. The stop keys are
// appended AFTER the canonical RECEIPT_KEYS block ONLY when present, so a receipt with no
// stop record serializes byte-identically to serializeReceipt (existing #944/#945
// receipts are unchanged). This is the only writer that emits `stopped_at`/`stop_reason`.
function serializeReceiptWithStop(receipt) {
  const ordered = orderReceipt(receipt);
  STOP_KEYS.forEach((key) => {
    if (receipt[key] !== undefined) ordered[key] = receipt[key];
  });
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// #947: serialize a receipt that MAY carry a bounded stop record AND/OR the additive
// #947 record fields. Both blocks are appended AFTER the canonical RECEIPT_KEYS block and
// ONLY when present, so a receipt carrying neither serializes byte-identically to
// serializeReceipt (and one carrying only a stop record serializes byte-identically to
// serializeReceiptWithStop). This keeps every existing receipt assertion intact while
// letting the pinned run/resume/status write points persist their additive records.
function serializeReceiptWithRecords(receipt) {
  const ordered = orderReceipt(receipt);
  STOP_KEYS.forEach((key) => {
    if (receipt[key] !== undefined) ordered[key] = receipt[key];
  });
  ADDITIVE_RECORD_KEYS.forEach((key) => {
    if (additivePresent(receipt[key])) ordered[key] = receipt[key];
  });
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function validateTask(task) {
  if (!task || typeof task !== "object") return "a task entry is not an object";
  for (const key of TASK_KEYS) {
    if (!(key in task)) return `task entry missing required key ${key}`;
  }
  const ids = task.relay_ids;
  if (!ids || typeof ids !== "object") return "task relay_ids must be an object";
  for (const key of RELAY_ID_KEYS) {
    if (!(key in ids)) return `task relay_ids missing required key ${key}`;
  }
  return null;
}

// Structural validation for a parsed receipt (D8 RECEIPT_CORRUPT). Returns null when
// valid, or a short reason string when the schema is wrong or a required key is absent.
function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return "receipt is not a JSON object";
  if (receipt.schema !== SCHEMA_VERSION) return `receipt schema must be ${SCHEMA_VERSION}, got ${JSON.stringify(receipt.schema)}`;
  for (const key of RECEIPT_KEYS) {
    if (!(key in receipt)) return `receipt missing required key ${key}`;
  }
  if (!receipt.repo || typeof receipt.repo !== "object" || typeof receipt.repo.slug !== "string") {
    return "receipt.repo.slug must be a string";
  }
  if (typeof receipt.repo.root !== "string") return "receipt.repo.root must be a string";
  if (!Array.isArray(receipt.tasks)) return "receipt.tasks must be an array";
  for (const task of receipt.tasks) {
    const taskError = validateTask(task);
    if (taskError) return taskError;
  }
  return null;
}

// Parse + validate receipt text. Returns { ok, receipt } or { ok:false, reason }.
function parseReceipt(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `receipt is not valid JSON: ${error.message}` };
  }
  const structuralError = validateReceipt(value);
  if (structuralError) return { ok: false, reason: structuralError };
  return { ok: true, receipt: value };
}

module.exports = {
  SCHEMA_VERSION,
  RECEIPT_NOTE,
  RECEIPT_KEYS,
  TASK_KEYS,
  RELAY_ID_KEYS,
  STOP_KEYS,
  STOP_REASON_MAX,
  ADDITIVE_RECORD_KEYS,
  boundStopReason,
  additivePresent,
  buildReceiptMapping,
  receiptTaskEntry,
  orderReceipt,
  serializeReceipt,
  serializeReceiptWithStop,
  serializeReceiptWithRecords,
  validateReceipt,
  parseReceipt,
};
