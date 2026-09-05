const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("util");
const { assertRunLockHeld } = require("./host");
const {
  fsyncDirectory,
  invokeExternalObserver,
  readRunRecord,
} = require("./run-store");

const {
  ATTEMPT_TYPES,
  MAX_FACT_BYTES,
  PAYLOAD_SCHEMAS,
  fail,
  validateFact,
} = require("./facts-helpers");

function canonicalFactLine(fact) {
  validateFact(fact, { appending: true });
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

function readFacts({ eventsPath, fsModule = fs }) {
  const journal = canonicalJournal(eventsPath);
  let bytes;
  let fd;
  try {
    fd = fsModule.openSync(
      journal.eventsPath,
      fs.constants.O_RDONLY
        | (fs.constants.O_NOFOLLOW || 0)
        | (fs.constants.O_NONBLOCK || 0),
    );
    const before = fsModule.fstatSync(fd);
    if (!before.isFile()) {
      fail("UNTRUSTED_FACT_JOURNAL", `${eventsPath} must be a regular non-symlink file`);
    }
    bytes = fsModule.readFileSync(fd);
    const after = fsModule.fstatSync(fd);
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
    if (fd !== undefined) fsModule.closeSync(fd);
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
  const read = readFacts({ eventsPath: journal.eventsPath, fsModule });
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
  const fd = fsModule.openSync(
    journal.eventsPath,
    fs.constants.O_RDWR
      | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const opened = fsModule.fstatSync(fd);
    if (!opened.isFile()) {
      fail("UNTRUSTED_FACT_JOURNAL", `${eventsPath} must remain a regular non-symlink file`);
    }
    const bytes = fsModule.readFileSync(fd);
    fault?.("journal_read");
    const truncateAt = bytes.lastIndexOf(0x0a) + 1;
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

const issuedAuthorizations = new WeakSet(), issuedObservations = new WeakSet();
function validateReviewBinding({ verdict, currentSha, doneCriteriaSha256 }) {
  const valid = Boolean(verdict && verdict.reviewed_sha === currentSha && verdict.done_criteria_sha256 === doneCriteriaSha256);
  return { valid, reason: valid ? null : "review_binding_mismatch" };
}
function safeOperationId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("merge operation id must be a safe path-independent identifier");
  return value;
}
function regularBytes(filePath, label) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error(`${label} changed identity while being read`);
    }
    return { bytes, stat: after };
  } finally {
    fs.closeSync(fd);
  }
}
function immutableJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  try { fs.writeFileSync(filePath, bytes, { flag: "wx", mode: 0o600 }); fsyncDirectory(path.dirname(filePath)); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = regularBytes(filePath, "immutable merge artifact").bytes;
    if (!existing.equals(bytes)) throw new Error("immutable merge artifact conflict");
  }
}
function authKey(runDir, lockContext) {
  assertRunLockHeld(lockContext, { runDir });
  const file = path.join(runDir, ".merge-authorization.key");
  try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: "wx", mode: 0o600 }); fsyncDirectory(runDir); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const opened = regularBytes(file, "merge authorization key"), stat = opened.stat, key = opened.bytes;
  if ((stat.mode & 0o077) || key.length !== 32) throw new Error("merge authorization key permissions are unsafe");
  return key;
}
function authFields(value) {
  return { schema_version: value.schema_version, run_id: value.run_id, operation_id: value.operation_id,
    authorization_id: value.authorization_id, observation_nonce: value.observation_nonce, issued_lock_id: value.issued_lock_id,
    pr_number: value.pr_number, pr_head_sha: value.pr_head_sha, done_criteria_sha256: value.done_criteria_sha256,
    operator: value.operator, github_login: value.github_login, method: value.method, override_reason: value.override_reason };
}
function readAuthorization(runDir, operationId, lockContext) {
  safeOperationId(operationId);
  const durable = JSON.parse(regularBytes(
    path.join(runDir, `merge-authorization-${operationId}.json`),
    "merge authorization",
  ).bytes.toString("utf8"));
  const expected = crypto.createHmac("sha256", authKey(runDir, lockContext)).update(JSON.stringify(authFields(durable))).digest("hex");
  if (!/^[0-9a-f]{64}$/.test(durable.hmac_sha256 || "") || !crypto.timingSafeEqual(Buffer.from(durable.hmac_sha256), Buffer.from(expected))) throw new Error("durable merge authorization HMAC is invalid");
  return durable;
}
async function revalidateExternalFacts({ runDir, lockContext, observer, request, authorize }) {
  const canonical = fs.realpathSync(runDir); assertRunLockHeld(lockContext, { runDir: canonical });
  if (!observer?.command) throw new Error("a fresh external observer argv process is required");
  const input = Object.freeze({ schema_version: 1, run_id: readRunRecord({ runDir: canonical }).run_id, nonce: crypto.randomUUID(), request });
  const observed = invokeExternalObserver({ observer, request: input, timeoutMs: observer.timeoutMs });
  if (!observed || typeof observed !== "object" || observed.nonce !== input.nonce) throw new Error("fresh external observer nonce does not match its immutable request");
  const observationCapability = Object.freeze({ kind: "relay-fresh-observation", nonce: input.nonce,
    facts: Object.freeze({ ...observed }), runDir: canonical, lockContext });
  issuedObservations.add(observationCapability);
  return { decision: await authorize(observed, { lockContext, request: input }), facts: observed, observationCapability };
}
function requireObservation(runDir, lockContext, fresh) {
  const canonical = fs.realpathSync(runDir); assertRunLockHeld(lockContext, { runDir: canonical });
  if (!issuedObservations.has(fresh) || fresh.lockContext !== lockContext || fresh.runDir !== canonical) throw new Error("an issued fresh observation under the current run lock is required");
  return canonical;
}
function issueAuthorization(canonical, lockContext, fresh, durable) {
  const authorization = Object.freeze({ kind: "relay-merge-authorization", authorized: true, actor: durable.operator,
    method: durable.method, headSha: durable.pr_head_sha, doneCriteriaSha256: durable.done_criteria_sha256,
    prNumber: durable.pr_number, operationId: durable.operation_id, observationNonce: fresh.nonce, runDir: canonical,
    lockContext, authorizationId: durable.authorization_id, githubLogin: durable.github_login,
    overrideReason: durable.override_reason });
  issuedAuthorizations.add(authorization); return authorization;
}
function planOperatorMerge({ runDir, lockContext, freshObservation, operatorAction, currentHead, currentDoneCriteriaSha256, verdict, prNumber }) {
  const canonical = requireObservation(runDir, lockContext, freshObservation);
  if (!operatorAction?.actor || !["squash", "merge", "rebase", "external"].includes(operatorAction.method)) throw new Error("an explicit operator merge action is required");
  const external = operatorAction.method === "external";
  let githubLogin = null;
  if (!external && operatorAction.githubLogin !== undefined && operatorAction.githubLogin !== null) {
    githubLogin = String(operatorAction.githubLogin).trim();
    if (!githubLogin || githubLogin.length > 255 || githubLogin.includes("\0") || /[\r\n]/.test(githubLogin)) {
      throw new Error("the optional authenticated GitHub login is invalid");
    }
  }
  if (external ? freshObservation.facts.pr_state !== "MERGED" || !operatorAction.overrideReason?.trim()
    : !validateReviewBinding({ verdict, currentSha: currentHead, doneCriteriaSha256: currentDoneCriteriaSha256 }).valid || !["lgtm", "pass"].includes(verdict?.verdict)) throw new Error("merge review binding is not current");
  if (!Number.isInteger(prNumber) || freshObservation.facts.pr_number !== prNumber || freshObservation.facts.pr_head_sha !== currentHead) throw new Error("merge inputs do not match the fresh locked observation");
  const operationId = operatorAction.operationId === undefined ? crypto.randomUUID() : safeOperationId(operatorAction.operationId);
  const durable = { schema_version: 1, run_id: readRunRecord({ runDir: canonical }).run_id, operation_id: operationId,
    authorization_id: crypto.randomUUID(), observation_nonce: freshObservation.nonce, issued_lock_id: lockContext.lock_id,
    pr_number: prNumber, pr_head_sha: currentHead, done_criteria_sha256: currentDoneCriteriaSha256,
    operator: operatorAction.actor, github_login: githubLogin, method: operatorAction.method,
    override_reason: external ? operatorAction.overrideReason.trim() : null };
  immutableJson(path.join(canonical, `merge-authorization-${operationId}.json`), { ...durable,
    hmac_sha256: crypto.createHmac("sha256", authKey(canonical, lockContext)).update(JSON.stringify(durable)).digest("hex") });
  return issueAuthorization(canonical, lockContext, freshObservation, durable);
}
function resumeOperatorMerge({ runDir, lockContext, operationId, freshObservation }) {
  const canonical = requireObservation(runDir, lockContext, freshObservation), durable = readAuthorization(canonical, operationId, lockContext);
  const record = readRunRecord({ runDir: canonical });
  if (durable.run_id !== record.run_id || durable.done_criteria_sha256 !== record.contract.done_criteria_sha256
    || durable.pr_number !== freshObservation.facts.pr_number || durable.pr_head_sha !== freshObservation.facts.pr_head_sha) throw new Error("durable merge authorization does not match fresh locked observations");
  return issueAuthorization(canonical, lockContext, freshObservation, durable);
}
async function recordMerge({ eventsPath, at = new Date().toISOString(), provenance, authorization, lockContext, observer, fault = null }) {
  if (!issuedAuthorizations.has(authorization) || authorization.lockContext !== lockContext) throw new Error("an issued explicit merge authorization capability is required");
  if (authorization.actor !== provenance.operator || authorization.method !== provenance.method || authorization.overrideReason !== provenance.override_reason
    || authorization.prNumber !== provenance.pr_number || authorization.headSha !== provenance.reviewed_source_sha || authorization.headSha !== provenance.pr_head_sha) throw new Error("merge provenance does not match its explicit authorization");
  const record = readRunRecord({ runDir: path.dirname(path.resolve(eventsPath)) });
  const durable = readAuthorization(authorization.runDir, authorization.operationId, lockContext);
  if (durable.authorization_id !== authorization.authorizationId || durable.github_login !== authorization.githubLogin
    || durable.run_id !== record.run_id || authorization.doneCriteriaSha256 !== record.contract.done_criteria_sha256) throw new Error("issued merge capability does not match its durable authorization");
  const fresh = await revalidateExternalFacts({ runDir: authorization.runDir, lockContext, observer,
    request: { operation_id: authorization.operationId, pr_number: authorization.prNumber, expected_pr_head_sha: authorization.headSha,
      expected_result_target_sha: provenance.result_target_sha, required_state: "MERGED" }, authorize: (seen) => {
      if (seen.pr_number !== authorization.prNumber || seen.pr_head_sha !== authorization.headSha || seen.pr_state !== "MERGED" || seen.merge_sha !== provenance.result_target_sha) throw new Error("record-time observer did not prove the exact merged PR and target SHA");
      return { authorized: true };
    } });
  const payload = { ...provenance, operation_id: authorization.operationId, authorization_id: authorization.authorizationId,
    observation_nonce: fresh.observationCapability.nonce, done_criteria_sha256: authorization.doneCriteriaSha256 };
  const existing = readFacts({ eventsPath }).facts.filter((fact) => fact.type === "merge_recorded");
  const converged = existing.find((fact) => fact.payload.operation_id === authorization.operationId);
  if (converged) {
    if (!isDeepStrictEqual({ ...converged.payload, observation_nonce: null }, { ...payload, observation_nonce: null })) throw new Error("merge operation already exists with conflicting provenance");
    immutableJson(path.join(authorization.runDir, `merge-receipt-${authorization.operationId}.json`), { schema_version: 1,
      operation_id: authorization.operationId, authorization_id: authorization.authorizationId, event_id: converged.event_id, payload: converged.payload }); return converged;
  }
  if (existing.length) throw new Error("a different merge operation is already recorded");
  const fact = { event_id: crypto.randomUUID(), run_id: record.run_id, type: "merge_recorded", at, actor: provenance.operator, payload };
  appendFact({ eventsPath, fact, lockContext }); fault?.("after_fact_append");
  immutableJson(path.join(authorization.runDir, `merge-receipt-${authorization.operationId}.json`), { schema_version: 1,
    operation_id: authorization.operationId, authorization_id: authorization.authorizationId, event_id: fact.event_id, payload }); return fact;
}

module.exports = {
  ATTEMPT_TYPES,
  MAX_FACT_BYTES,
  PAYLOAD_SCHEMAS,
  appendFact,
  canonicalFactLine,
  factFromHostAudit,
  planOperatorMerge,
  readFacts,
  recordMerge,
  repairTornTail,
  resumeOperatorMerge,
  revalidateExternalFacts,
  validateReviewBinding,
  validateFact,
};
