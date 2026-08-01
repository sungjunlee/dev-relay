const fs = require("fs");
const path = require("path");
const { assertRunLockHeld } = require("./host");
const {
  fsyncDirectory,
  readRunRecord,
} = require("./run-store");

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
    ],
  },
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

function exactKeys(value, keys, label, { allowFutureFields = false } = {}) {
  if (!isPlainObject(value)) fail("INVALID_FACT", `${label} must be an object`);
  const expected = new Set(keys);
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

function validatePayload(type, payload, { allowFutureFields = false } = {}) {
  const schema = PAYLOAD_SCHEMAS[type];
  exactKeys(payload, schema.required, `fact.payload(${type})`, { allowFutureFields });
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
      sha(payload.done_criteria_sha256, "payload.done_criteria_sha256", { sha256: true });
      string(payload.reviewer, "payload.reviewer");
      string(payload.review_artifact, "payload.review_artifact");
      validateOverride(payload.override, "payload.override", { allowFutureFields });
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
      if (!new Set(["squash", "merge", "rebase"]).has(payload.method)) {
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

function validateFact(fact, { allowUnknown = false, allowFutureFields = false } = {}) {
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
  validatePayload(type, fact.payload, { allowFutureFields });
  return { known: true, fact };
}

function canonicalFactLine(fact) {
  validateFact(fact);
  const line = `${JSON.stringify(fact)}\n`;
  if (Buffer.byteLength(line) > MAX_FACT_BYTES) {
    fail("FACT_TOO_LARGE", `fact exceeds ${MAX_FACT_BYTES} bytes`);
  }
  return line;
}

function factFromHostAudit({ runId, eventId, at, actor, audit }) {
  if (!audit || !new Set(["lock_acquired", "lock_released"]).has(audit.type)) {
    fail("INVALID_FACT", "host audit type must be lock_acquired or lock_released");
  }
  const source = audit.payload || {};
  const payload = audit.type === "lock_acquired"
    ? {
      lock_id: source.lock_id,
      operation: source.operation,
      host: source.host,
      pid: source.pid,
      process_started_at: source.process_started_at,
    }
    : {
      lock_id: source.lock_id,
      operation: source.operation,
      outcome: source.outcome,
    };
  const fact = {
    event_id: eventId,
    run_id: runId,
    attempt_id: audit.attempt_id,
    type: audit.type,
    at,
    actor,
    payload,
  };
  validateFact(fact);
  return fact;
}

function canonicalJournal(eventsPath) {
  if (typeof eventsPath !== "string" || !path.isAbsolute(eventsPath)) {
    fail("UNTRUSTED_FACT_JOURNAL", "eventsPath must be absolute");
  }
  const runDir = fs.realpathSync(path.dirname(eventsPath));
  const canonical = path.join(runDir, "events.jsonl");
  if (eventsPath !== canonical) {
    fail(
      "UNTRUSTED_FACT_JOURNAL",
      `fact journal must be the canonical run-local ${canonical}`,
    );
  }
  const runRecord = readRunRecord({ runDir });
  return { eventsPath: canonical, runDir, runRecord };
}

function requireLockHeld(lockContext, eventsPath) {
  try {
    assertRunLockHeld(lockContext, { eventsPath });
  } catch (error) {
    fail(
      "RUN_LOCK_REQUIRED",
      `a verified per-run lock capability is required: ${error.message}`,
      { cause: error },
    );
  }
}

function assertRegularOrMissing(filePath, fsModule = fs) {
  try {
    const stat = fsModule.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail("UNTRUSTED_FACT_JOURNAL", `${filePath} must be a regular non-symlink file`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function appendFact({ eventsPath, fact, lockContext, fsModule = fs }) {
  const journal = canonicalJournal(eventsPath);
  requireLockHeld(lockContext, journal.eventsPath);
  if (fact.run_id !== journal.runRecord.run_id) {
    fail(
      "RUN_ID_MISMATCH",
      `fact.run_id ${fact.run_id} does not match immutable run_id ${journal.runRecord.run_id}`,
    );
  }
  const line = canonicalFactLine(fact);
  const bytes = Buffer.from(line, "utf8");
  assertRegularOrMissing(journal.eventsPath, fsModule);
  const journalExisted = fsModule.existsSync(journal.eventsPath);
  const existing = readFacts({ eventsPath: journal.eventsPath, fsModule });
  if (existing.tailIncomplete) {
    fail("EVENT_TAIL_INCOMPLETE", "repair the torn event tail before appending");
  }
  const existingFact = existing.facts.find((entry) => entry.event_id === fact.event_id);
  if (existingFact) {
    if (JSON.stringify(existingFact) === JSON.stringify(fact)) return existingFact;
    fail("DUPLICATE_EVENT_ID", `conflicting duplicate event_id ${fact.event_id}`);
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fsModule.openSync(
    journal.eventsPath,
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    const written = fsModule.writeSync(fd, bytes, 0, bytes.length);
    if (written !== bytes.length) fail("FACT_SHORT_WRITE", `wrote ${written}/${bytes.length} fact bytes`);
    fsModule.fsyncSync(fd);
  } finally {
    fsModule.closeSync(fd);
  }
  if (!journalExisted) fsyncDirectory(journal.runDir, fsModule);
  return fact;
}

function readFacts({ eventsPath }) {
  const journal = canonicalJournal(eventsPath);
  let bytes;
  let fd;
  try {
    fd = fs.openSync(
      journal.eventsPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const before = fs.fstatSync(fd);
    if (!before.isFile()) {
      fail("UNTRUSTED_FACT_JOURNAL", `${eventsPath} must be a regular non-symlink file`);
    }
    bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      fail("UNTRUSTED_FACT_JOURNAL", `${eventsPath} changed identity while being read`);
    }
  } catch (error) {
    if (error.code === "ENOENT") return { facts: [], tailIncomplete: false, tailBytes: Buffer.alloc(0) };
    if (error.code === "ELOOP") {
      fail("UNTRUSTED_FACT_JOURNAL", `${eventsPath} must be a regular non-symlink file`);
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const finalNewline = bytes.lastIndexOf(0x0a);
  const tailIncomplete = bytes.length > 0 && finalNewline !== bytes.length - 1;
  const completeBytes = finalNewline === -1 ? Buffer.alloc(0) : bytes.subarray(0, finalNewline + 1);
  const tailBytes = tailIncomplete ? bytes.subarray(finalNewline + 1) : Buffer.alloc(0);
  const lines = completeBytes.toString("utf8").split("\n").slice(0, -1);
  const facts = [];
  const ids = new Map();
  lines.forEach((line, index) => {
    if (!line) fail("MALFORMED_FACT_JOURNAL", `empty fact at line ${index + 1}`);
    let fact;
    try {
      fact = JSON.parse(line);
    } catch (error) {
      fail("MALFORMED_FACT_JOURNAL", `invalid JSON at line ${index + 1}: ${error.message}`);
    }
    const result = validateFact(fact, {
      allowUnknown: true,
      allowFutureFields: true,
    });
    if (fact.run_id !== journal.runRecord.run_id) {
      fail(
        "RUN_ID_MISMATCH",
        `fact at line ${index + 1} does not match immutable run_id ${journal.runRecord.run_id}`,
      );
    }
    if (typeof fact.event_id === "string") {
      const prior = ids.get(fact.event_id);
      if (prior !== undefined) {
        if (prior === JSON.stringify(fact)) return;
        fail("DUPLICATE_EVENT_ID", `conflicting duplicate event_id ${fact.event_id}`);
      }
      ids.set(fact.event_id, JSON.stringify(fact));
    }
    facts.push(fact);
  });
  return { facts, tailIncomplete, tailBytes };
}

function safeTimestamp(value) {
  return String(value || new Date().toISOString()).replace(/[^0-9A-Za-z.-]/g, "-");
}

function repairTornTail({
  eventsPath,
  lockContext,
  at = new Date().toISOString(),
  fsModule = fs,
  fault = null,
}) {
  const journal = canonicalJournal(eventsPath);
  requireLockHeld(lockContext, journal.eventsPath);
  const read = readFacts({ eventsPath: journal.eventsPath });
  if (!read.tailIncomplete) return { repaired: false, quarantinePath: null };
  const prefix = `${journal.eventsPath}.corrupt-tail.${safeTimestamp(at)}`;
  let quarantinePath;
  let quarantineFd;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const suffix = attempt === 0 ? "" : `.${attempt}`;
    const candidate = `${prefix}${suffix}`;
    try {
      quarantineFd = fsModule.openSync(
        candidate,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      quarantinePath = candidate;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  if (quarantineFd === undefined) {
    fail("QUARANTINE_COLLISION", "could not allocate a unique torn-tail quarantine artifact");
  }
  try {
    fault?.("quarantine_open");
    fsModule.writeFileSync(quarantineFd, read.tailBytes);
    fault?.("quarantine_write");
    fsModule.fsyncSync(quarantineFd);
    fault?.("quarantine_fsync");
  } finally {
    fsModule.closeSync(quarantineFd);
  }
  fsyncDirectory(journal.runDir, fsModule);
  fault?.("quarantine_dir_fsync");
  const bytes = fsModule.readFileSync(journal.eventsPath);
  fault?.("journal_read");
  const truncateAt = bytes.lastIndexOf(0x0a) + 1;
  const fd = fsModule.openSync(journal.eventsPath, fs.constants.O_RDWR);
  try {
    fsModule.ftruncateSync(fd, truncateAt);
    fault?.("journal_truncate");
    fsModule.fsyncSync(fd);
    fault?.("journal_fsync");
  } finally {
    fsModule.closeSync(fd);
  }
  fsyncDirectory(journal.runDir, fsModule);
  fault?.("journal_dir_fsync");
  return { repaired: true, quarantinePath };
}

module.exports = {
  ATTEMPT_TYPES,
  MAX_FACT_BYTES,
  PAYLOAD_SCHEMAS,
  appendFact,
  canonicalFactLine,
  factFromHostAudit,
  readFacts,
  repairTornTail,
  validateFact,
};
