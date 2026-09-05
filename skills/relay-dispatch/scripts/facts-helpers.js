"use strict";

/** Schema and payload validation helpers for the facts journal. */

const MAX_FACT_BYTES = 64 * 1024;
const SHA1_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const VERIFICATION_STATUSES = new Set(["passed", "failed", "incomplete", "not_declared"]);
const REVIEW_VERDICTS = new Set(["pass", "lgtm", "changes_requested", "escalated"]);

const PAYLOAD_SCHEMAS = Object.freeze({
  attempt_started: {
    required: [
      "executor", "model", "start_sha", "host_kind", "host_handle",
      "stdout_path", "stderr_path", "result_path", "timeout_ms",
    ],
  },
  attempt_finished: {
    required: [
      "status", "start_sha", "final_sha", "tree_sha", "result_path",
      "exit_code", "verification_status",
    ],
  },
  attempt_interrupted: {
    required: ["last_known_sha", "reason", "host_liveness", "reviewable_work"],
  },
  verification_recorded: {
    required: [
      "head_sha", "tree_sha", "done_criteria_sha256", "command",
      "verification_request_sha256", "declared_command_count", "completed_command_count",
      "result_path", "result_sha256", "exit_code", "status", "operator",
    ],
  },
  lock_acquired: {
    required: ["lock_id", "operation", "host", "pid", "process_started_at"],
  },
  lock_released: {
    required: ["lock_id", "operation", "outcome"],
  },
  pull_request_recorded: {
    required: ["pr_number", "repo", "head_ref", "base_ref", "head_sha", "created_by_relay"],
  },
  review_recorded: {
    required: [
      "round", "verdict", "reviewed_sha", "done_criteria_sha256",
      "reviewer", "review_artifact", "override",
    ], optional: ["base_sha", "executed_runtime", "escalation_kind", "retry_of_event_id", "resolution_of_event_id"],
  },
  review_escalation_resolved: {
    required: ["actor", "reason", "disposition", "escalated_review_event_id"],
  },
  // Optional above so historical journals stay readable; required below on every append this runtime makes.
  recovery_applied: {
    required: [
      "rule", "observed_event_id", "before_sha", "after_sha",
      "side_effects", "reason", "operator",
    ],
  },
  merge_recorded: {
    required: [
      "pr_number", "reviewed_source_sha", "pr_head_sha", "result_target_sha",
      "method", "operator", "override_reason", "operation_id",
      "authorization_id", "observation_nonce", "done_criteria_sha256",
    ],
  },
  run_closed: {
    required: ["reason", "operator", "last_sha", "pr_number"],
  },
});

// Fields that are schema-optional so historical journals keep parsing, but that this runtime must
// never append without. Enforced on the append path only; readers stay tolerant of older facts.
const APPEND_REQUIRED_EVIDENCE = Object.freeze({
  review_recorded: Object.freeze(["base_sha", "executed_runtime"]),
});

const ATTEMPT_TYPES = new Set([
  "attempt_started",
  "attempt_finished",
  "attempt_interrupted",
  "lock_acquired",
  "lock_released",
]);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  throw error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label, { allowFutureFields = false, optional = [] } = {}) {
  if (!isPlainObject(value)) fail("INVALID_FACT", `${label} must be an object`);
  const expected = new Set([...keys, ...optional]);
  if (!allowFutureFields) {
    for (const key of Object.keys(value)) {
      if (!expected.has(key)) fail("INVALID_FACT", `${label}.${key} is not allowed`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("INVALID_FACT", `${label}.${key} is required`);
    }
  }
}

function string(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !value.trim()) {
    fail("INVALID_FACT", `${label} must be a non-empty string${nullable ? " or null" : ""}`);
  }
}

function integer(value, label, { minimum = Number.MIN_SAFE_INTEGER, nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isInteger(value) || value < minimum) {
    fail("INVALID_FACT", `${label} must be an integer >= ${minimum}${nullable ? " or null" : ""}`);
  }
}

function sha(value, label, { nullable = false, sha256 = false } = {}) {
  if (nullable && value === null) return;
  const pattern = sha256 ? SHA256_RE : SHA1_RE;
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("INVALID_FACT", `${label} must be a ${sha256 ? "SHA-256" : "SHA-1"} digest`);
  }
}

function boolean(value, label) {
  if (typeof value !== "boolean") fail("INVALID_FACT", `${label} must be boolean`);
}

function validateOverride(value, label, { allowFutureFields = false } = {}) {
  if (value === null) return;
  exactKeys(value, ["class", "reason", "operator"], label, { allowFutureFields });
  string(value.class, `${label}.class`);
  string(value.reason, `${label}.reason`);
  string(value.operator, `${label}.operator`);
}

function validatePayload(type, payload, { allowFutureFields = false, appending = false } = {}) {
  const schema = PAYLOAD_SCHEMAS[type];
  exactKeys(payload, schema.required, `fact.payload(${type})`, { allowFutureFields, optional: schema.optional });
  // Evidence fields stay optional when reading history written before they existed, but a fact this
  // runtime appends must carry them, so a verdict can never be recorded without its runtime binding.
  if (appending) {
    for (const field of APPEND_REQUIRED_EVIDENCE[type] || []) {
      if (payload[field] === undefined) fail("INVALID_FACT", `payload.${field} is required when appending ${type}`);
    }
  }
  switch (type) {
    case "attempt_started":
      string(payload.executor, "payload.executor");
      string(payload.model, "payload.model", { nullable: true });
      sha(payload.start_sha, "payload.start_sha");
      string(payload.host_kind, "payload.host_kind");
      string(payload.host_handle, "payload.host_handle");
      for (const field of ["stdout_path", "stderr_path", "result_path"]) {
        string(payload[field], `payload.${field}`);
      }
      integer(payload.timeout_ms, "payload.timeout_ms", { minimum: 1 });
      break;
    case "attempt_finished":
      if (!new Set(["completed", "failed", "cancelled"]).has(payload.status)) {
        fail("INVALID_FACT", "payload.status is invalid");
      }
      sha(payload.start_sha, "payload.start_sha");
      sha(payload.final_sha, "payload.final_sha");
      sha(payload.tree_sha, "payload.tree_sha");
      string(payload.result_path, "payload.result_path");
      integer(payload.exit_code, "payload.exit_code");
      if (!VERIFICATION_STATUSES.has(payload.verification_status)) {
        fail("INVALID_FACT", "payload.verification_status is invalid");
      }
      break;
    case "attempt_interrupted":
      sha(payload.last_known_sha, "payload.last_known_sha");
      string(payload.reason, "payload.reason");
      if (!new Set(["live", "dead", "unknown"]).has(payload.host_liveness)) {
        fail("INVALID_FACT", "payload.host_liveness is invalid");
      }
      boolean(payload.reviewable_work, "payload.reviewable_work");
      break;
    case "verification_recorded":
      sha(payload.head_sha, "payload.head_sha");
      sha(payload.tree_sha, "payload.tree_sha");
      sha(payload.done_criteria_sha256, "payload.done_criteria_sha256", { sha256: true });
      string(payload.command, "payload.command");
      sha(payload.verification_request_sha256, "payload.verification_request_sha256", { sha256: true });
      integer(payload.declared_command_count, "payload.declared_command_count", { minimum: 1 });
      integer(payload.completed_command_count, "payload.completed_command_count", { minimum: 0 });
      if (payload.completed_command_count > payload.declared_command_count) {
        fail("INVALID_FACT", "completed_command_count must not exceed declared_command_count");
      }
      string(payload.result_path, "payload.result_path");
      sha(payload.result_sha256, "payload.result_sha256", { sha256: true });
      integer(payload.exit_code, "payload.exit_code", { minimum: 0, nullable: true });
      if (!new Set(["passed", "failed", "incomplete"]).has(payload.status)) {
        fail("INVALID_FACT", "payload.status is invalid");
      }
      if (
        payload.status === "passed"
        && (payload.exit_code !== 0 || payload.completed_command_count !== payload.declared_command_count)
      ) {
        fail("INVALID_FACT", "passed verification requires exit_code=0 and all declared commands completed");
      }
      if (payload.status === "failed" && (payload.exit_code === null || payload.exit_code === 0)) {
        fail("INVALID_FACT", "failed verification requires a nonzero exit_code");
      }
      if (
        payload.status === "incomplete"
        && (payload.exit_code !== null || payload.completed_command_count >= payload.declared_command_count)
      ) {
        fail("INVALID_FACT", "incomplete verification requires exit_code=null and incomplete command execution");
      }
      string(payload.operator, "payload.operator");
      break;
    case "lock_acquired":
      string(payload.lock_id, "payload.lock_id");
      string(payload.operation, "payload.operation");
      string(payload.host, "payload.host");
      integer(payload.pid, "payload.pid", { minimum: 1, nullable: true });
      if (payload.process_started_at !== null) {
        string(payload.process_started_at, "payload.process_started_at");
        if (Number.isNaN(Date.parse(payload.process_started_at))) {
          fail("INVALID_FACT", "payload.process_started_at must be ISO-8601 or null");
        }
      }
      break;
    case "lock_released":
      string(payload.lock_id, "payload.lock_id");
      string(payload.operation, "payload.operation");
      string(payload.outcome, "payload.outcome");
      break;
    case "pull_request_recorded":
      integer(payload.pr_number, "payload.pr_number", { minimum: 1 });
      for (const field of ["repo", "head_ref", "base_ref"]) string(payload[field], `payload.${field}`);
      sha(payload.head_sha, "payload.head_sha");
      boolean(payload.created_by_relay, "payload.created_by_relay");
      break;
    case "review_recorded":
      integer(payload.round, "payload.round", { minimum: 1 });
      if (!REVIEW_VERDICTS.has(payload.verdict)) fail("INVALID_FACT", "payload.verdict is invalid");
      sha(payload.reviewed_sha, "payload.reviewed_sha");
      if (payload.base_sha !== undefined) sha(payload.base_sha, "payload.base_sha");
      sha(payload.done_criteria_sha256, "payload.done_criteria_sha256", { sha256: true });
      string(payload.reviewer, "payload.reviewer");
      string(payload.review_artifact, "payload.review_artifact");
      if (payload.escalation_kind !== undefined
        && !new Set(["runtime_failure", "reviewer"]).has(payload.escalation_kind)) {
        fail("INVALID_FACT", "payload.escalation_kind is invalid");
      }
      if (payload.retry_of_event_id !== undefined) string(payload.retry_of_event_id, "payload.retry_of_event_id");
      if (payload.resolution_of_event_id !== undefined) string(payload.resolution_of_event_id, "payload.resolution_of_event_id");
      if (payload.retry_of_event_id !== undefined && payload.resolution_of_event_id !== undefined) {
        fail("INVALID_FACT", "review_recorded cannot carry both retry and resolution bindings");
      }
      if (appending) {
        if (payload.verdict === "escalated" && payload.escalation_kind === undefined) {
          fail("INVALID_FACT", "payload.escalation_kind is required when appending escalated review_recorded");
        }
        if (payload.verdict !== "escalated" && payload.escalation_kind !== undefined) {
          fail("INVALID_FACT", "payload.escalation_kind is only allowed for escalated review_recorded");
        }
      }
      if (payload.executed_runtime !== undefined) {
        exactKeys(payload.executed_runtime, ["digest", "executable"], "payload.executed_runtime");
        sha(payload.executed_runtime.digest, "payload.executed_runtime.digest", { sha256: true });
        exactKeys(payload.executed_runtime.executable, ["path", "dev", "ino", "size", "sha256"], "payload.executed_runtime.executable");
        string(payload.executed_runtime.executable.path, "payload.executed_runtime.executable.path");
        for (const key of ["dev", "ino", "size"]) integer(payload.executed_runtime.executable[key], `payload.executed_runtime.executable.${key}`, { minimum: 0 });
        sha(payload.executed_runtime.executable.sha256, "payload.executed_runtime.executable.sha256", { sha256: true });
      }
      validateOverride(payload.override, "payload.override", { allowFutureFields });
      break;
    case "review_escalation_resolved":
      string(payload.actor, "payload.actor");
      string(payload.reason, "payload.reason");
      if (!new Set(["re_review", "redispatch"]).has(payload.disposition)) {
        fail("INVALID_FACT", "payload.disposition is invalid");
      }
      string(payload.escalated_review_event_id, "payload.escalated_review_event_id");
      break;
    case "recovery_applied":
      string(payload.rule, "payload.rule");
      string(payload.observed_event_id, "payload.observed_event_id");
      sha(payload.before_sha, "payload.before_sha", { nullable: true });
      sha(payload.after_sha, "payload.after_sha", { nullable: true });
      if (!Array.isArray(payload.side_effects)) fail("INVALID_FACT", "payload.side_effects must be an array");
      payload.side_effects.forEach((entry, index) => string(entry, `payload.side_effects[${index}]`));
      string(payload.reason, "payload.reason");
      string(payload.operator, "payload.operator");
      break;
    case "merge_recorded":
      integer(payload.pr_number, "payload.pr_number", { minimum: 1 });
      sha(payload.reviewed_source_sha, "payload.reviewed_source_sha");
      sha(payload.pr_head_sha, "payload.pr_head_sha");
      sha(payload.result_target_sha, "payload.result_target_sha");
      if (!new Set(["squash", "merge", "rebase", "external"]).has(payload.method)) {
        fail("INVALID_FACT", "payload.method is invalid");
      }
      string(payload.operator, "payload.operator");
      string(payload.override_reason, "payload.override_reason", { nullable: true });
      string(payload.operation_id, "payload.operation_id");
      string(payload.authorization_id, "payload.authorization_id");
      string(payload.observation_nonce, "payload.observation_nonce");
      sha(payload.done_criteria_sha256, "payload.done_criteria_sha256", { sha256: true });
      break;
    case "run_closed":
      string(payload.reason, "payload.reason");
      string(payload.operator, "payload.operator");
      sha(payload.last_sha, "payload.last_sha", { nullable: true });
      integer(payload.pr_number, "payload.pr_number", { minimum: 1, nullable: true });
      break;
    default:
      fail("UNKNOWN_FACT_TYPE", `unknown fact type: ${type}`);
  }
}

function validateFact(fact, { allowUnknown = false, allowFutureFields = false, appending = false } = {}) {
  if (!isPlainObject(fact)) fail("INVALID_FACT", "fact must be an object");
  const type = fact.type;
  if (!Object.prototype.hasOwnProperty.call(PAYLOAD_SCHEMAS, type)) {
    if (allowUnknown) return { known: false, fact };
    fail("UNKNOWN_FACT_TYPE", `unknown fact type: ${String(type)}`);
  }
  const envelope = ["event_id", "run_id", "type", "at", "actor", "payload"];
  if (ATTEMPT_TYPES.has(type)) envelope.splice(3, 0, "attempt_id");
  exactKeys(fact, envelope, "fact", { allowFutureFields });
  string(fact.event_id, "fact.event_id");
  string(fact.run_id, "fact.run_id");
  string(fact.type, "fact.type");
  string(fact.actor, "fact.actor");
  if (ATTEMPT_TYPES.has(type)) string(fact.attempt_id, "fact.attempt_id");
  if (typeof fact.at !== "string" || Number.isNaN(Date.parse(fact.at))) {
    fail("INVALID_FACT", "fact.at must be an ISO-8601 timestamp");
  }
  validatePayload(type, fact.payload, { allowFutureFields, appending });
  if (type === "verification_recorded" && fact.actor !== fact.payload.operator) {
    fail("INVALID_FACT", "verification_recorded actor must equal payload.operator");
  }
  if (type === "review_escalation_resolved" && fact.actor !== fact.payload.actor) {
    fail("INVALID_FACT", "review_escalation_resolved actor must equal payload.actor");
  }
  return { known: true, fact };
}

module.exports = {
  ATTEMPT_TYPES,
  MAX_FACT_BYTES,
  PAYLOAD_SCHEMAS,
  fail,
  validateFact,
  validatePayload,
};
