const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("node:child_process");

const {
  PAYLOAD_SCHEMAS,
  appendFact,
  factFromHostAudit,
  readFacts,
  repairTornTail,
  validateFact,
} = require("../../../skills/relay-dispatch/scripts/facts");
const {
  createRunRecord,
} = require("../../../skills/relay-dispatch/scripts/run-store");
const {
  acquireRunLock,
  releaseRunLock,
} = require("../../../skills/relay-dispatch/scripts/host");

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const HASH = "c".repeat(64);

function tempEvents(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `relay-facts-${label}-`));
  const runDir = path.join(fs.realpathSync(root), "r1");
  fs.mkdirSync(runDir);
  const criteriaPath = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteriaPath, "done\n");
  createRunRecord({
    runDir,
    record: {
      version: 3,
      run_id: "r1",
      repo: { root: "/repo", remote: "owner/repo" },
      git: {
        branch: "work",
        base_branch: "main",
        worktree: "/relay/worktree",
        start_sha: SHA,
      },
      contract: {
        done_criteria_path: criteriaPath,
        done_criteria_sha256: crypto.createHash("sha256").update("done\n").digest("hex"),
      },
      roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
      parent: null,
      ownership_digest: null,
      created_at: "2026-07-31T00:00:00Z",
    },
  });
  return path.join(runDir, "events.jsonl");
}

function payload(type) {
  const values = {
    attempt_started: {
      executor: "codex", model: null, start_sha: SHA, host_kind: "local",
      host_handle: "h1", stdout_path: "/r/out", stderr_path: "/r/err",
      result_path: "/r/result", timeout_ms: 1000,
    },
    attempt_finished: {
      status: "completed", start_sha: SHA, final_sha: SHA2, tree_sha: SHA2,
      result_path: "/r/result", exit_code: 0, verification_status: "passed",
    },
    attempt_interrupted: {
      last_known_sha: SHA, reason: "signal", host_liveness: "unknown",
      reviewable_work: false,
    },
    verification_recorded: {
      head_sha: SHA2,
      tree_sha: SHA,
      done_criteria_sha256: HASH,
      command: "node --test",
      verification_request_sha256: HASH,
      declared_command_count: 1,
      completed_command_count: 1,
      result_path: "/r/verification.log",
      result_sha256: HASH,
      exit_code: 0,
      status: "passed",
      operator: "owner",
    },
    lock_acquired: {
      lock_id: "l1", operation: "dispatch", host: "host", pid: 42,
      process_started_at: "2026-07-31T00:00:00Z",
    },
    lock_released: { lock_id: "l1", operation: "dispatch", outcome: "completed" },
    pull_request_recorded: {
      pr_number: 42, repo: "owner/repo", head_ref: "work", base_ref: "main",
      head_sha: SHA2, created_by_relay: true,
    },
    review_recorded: {
      round: 1, verdict: "pass", reviewed_sha: SHA2,
      base_sha: SHA,
      done_criteria_sha256: HASH, reviewer: "claude",
      review_artifact: "/r/review.json", override: null,
    },
    recovery_applied: {
      rule: "publication", observed_event_id: "e1", before_sha: SHA,
      after_sha: SHA2, side_effects: ["push", "pr"], reason: "recover",
      operator: "owner",
    },
    merge_recorded: {
      pr_number: 42, reviewed_source_sha: SHA2, pr_head_sha: SHA2,
      result_target_sha: SHA, method: "squash", operator: "owner",
      override_reason: null, operation_id: "merge-op-1",
      authorization_id: "merge-auth-1", observation_nonce: "merge-observation-1",
      done_criteria_sha256: HASH,
    },
    run_closed: { reason: "operator", operator: "owner", last_sha: SHA2, pr_number: 42 },
  };
  return values[type];
}

test("fact reader rejects a FIFO without blocking", () => {
  const eventsPath = tempEvents("fifo");
  execFileSync("mkfifo", [eventsPath]);
  const started = Date.now();
  assert.throws(() => readFacts({ eventsPath }), /regular non-symlink/);
  assert.ok(Date.now() - started < 1000, "FIFO rejection must not wait for a writer");
});

test("fact reader honors the injected filesystem implementation", () => {
  const eventsPath = tempEvents("injected-read-fs");
  let openCalls = 0;
  const fsSpy = Object.create(fs);
  fsSpy.openSync = (...args) => {
    openCalls += 1;
    return fs.openSync(...args);
  };
  assert.deepEqual(readFacts({ eventsPath, fsModule: fsSpy }).facts, []);
  assert.equal(openCalls, 1);
});

function fact(type, index = 1) {
  return {
    event_id: `e${index}`,
    run_id: "r1",
    ...(
      type.startsWith("attempt_") || type.startsWith("lock_")
        ? { attempt_id: "a1" }
        : {}
    ),
    type,
    at: `2026-07-31T00:00:${String(index).padStart(2, "0")}Z`,
    actor: "owner",
    payload: payload(type),
  };
}

function acquireFactLock(eventsPath) {
  const runDir = fs.realpathSync(path.dirname(eventsPath));
  return acquireRunLock({
    runDir,
    attemptId: "a1",
    operation: "test-fact-write",
    processStartedAt: "2026-07-31T00:00:00.000Z",
  });
}

test("all eleven fact payloads have closed, executable schemas", () => {
  const types = Object.keys(PAYLOAD_SCHEMAS);
  assert.equal(types.length, 11);
  types.forEach((type, index) => {
    assert.equal(validateFact(fact(type, index + 1)).known, true);
    assert.throws(
      () => validateFact({
        ...fact(type, index + 1),
        payload: { ...payload(type), unexpected: true },
      }),
      /unexpected is not allowed/,
    );
    const missing = { ...payload(type) };
    delete missing[PAYLOAD_SCHEMAS[type].required[0]];
    assert.throws(
      () => validateFact({ ...fact(type, index + 1), payload: missing }),
      /is required/,
    );
  });
  assert.throws(
    () => validateFact({
      ...fact("verification_recorded"),
      payload: { ...payload("verification_recorded"), status: "passed", exit_code: null },
    }),
    /passed verification requires exit_code=0 and all declared commands completed/,
  );
  assert.throws(
    () => validateFact({
      ...fact("verification_recorded"),
      payload: { ...payload("verification_recorded"), status: "incomplete", exit_code: 0 },
    }),
    /incomplete verification requires exit_code=null/,
  );
  assert.throws(
    () => validateFact({
      ...fact("verification_recorded"),
      actor: "different-operator",
    }),
    /actor must equal payload.operator/,
  );
  assert.equal(validateFact({
    ...fact("verification_recorded"),
    payload: {
      ...payload("verification_recorded"),
      declared_command_count: 2,
      completed_command_count: 1,
      status: "failed",
      exit_code: 1,
    },
  }).known, true);
  assert.throws(
    () => validateFact({
      ...fact("verification_recorded"),
      payload: {
        ...payload("verification_recorded"),
        declared_command_count: 2,
        completed_command_count: 1,
      },
    }),
    /all declared commands completed/,
  );
  assert.throws(() => validateFact({ ...fact("run_closed"), type: "future_fact" }), /unknown fact type/);
});

test("append requires exclusion, uses one write and fsync, and preserves order", () => {
  const eventsPath = tempEvents("append");
  assert.throws(
    () => appendFact({ eventsPath, fact: fact("attempt_started") }),
    (error) => error.code === "RUN_LOCK_REQUIRED",
  );
  const lock = acquireFactLock(eventsPath);
  let writes = 0;
  let syncs = 0;
  const fsSpy = {
    ...fs,
    writeSync(...args) {
      writes += 1;
      return fs.writeSync(...args);
    },
    fsyncSync(...args) {
      syncs += 1;
      return fs.fsyncSync(...args);
    },
  };
  try {
    appendFact({ eventsPath, fact: fact("attempt_started"), lockContext: lock, fsModule: fsSpy });
    appendFact({ eventsPath, fact: fact("attempt_finished", 2), lockContext: lock, fsModule: fsSpy });
    assert.equal(writes, 2);
    assert.equal(syncs, 3);
    assert.deepEqual(readFacts({ eventsPath }).facts, [
      fact("attempt_started"),
      fact("attempt_finished", 2),
    ]);
    assert.deepEqual(
      appendFact({ eventsPath, fact: fact("attempt_started"), lockContext: lock }),
      fact("attempt_started"),
    );
    assert.equal(readFacts({ eventsPath }).facts.length, 2);
  } finally {
    releaseRunLock(lock);
  }
});

test("reader ignores only a torn final record and repair quarantines exact bytes", () => {
  const eventsPath = tempEvents("tail");
  const lock = acquireFactLock(eventsPath);
  try {
    appendFact({ eventsPath, fact: fact("attempt_started"), lockContext: lock });
    const prefix = fs.readFileSync(eventsPath);
    const tail = Buffer.from('{"event_id":"torn"');
    fs.appendFileSync(eventsPath, tail);
    const read = readFacts({ eventsPath });
    assert.equal(read.tailIncomplete, true);
    assert.deepEqual(read.tailBytes, tail);
    assert.deepEqual(read.facts, [fact("attempt_started")]);
    const repaired = repairTornTail({
      eventsPath,
      lockContext: lock,
      at: "2026-07-31T00:00:00Z",
    });
    assert.equal(repaired.repaired, true);
    assert.deepEqual(fs.readFileSync(repaired.quarantinePath), tail);
    assert.deepEqual(fs.readFileSync(eventsPath), prefix);
  } finally {
    releaseRunLock(lock);
  }
});

test("interior corruption and conflicting duplicate event ids fail closed while exact retries coalesce", () => {
  const corrupt = tempEvents("interior");
  fs.writeFileSync(corrupt, `${JSON.stringify(fact("attempt_started"))}\nnot-json\n`);
  assert.throws(
    () => readFacts({ eventsPath: corrupt }),
    (error) => error.code === "MALFORMED_FACT_JOURNAL",
  );

  const duplicate = tempEvents("duplicate");
  fs.writeFileSync(
    duplicate,
    `${JSON.stringify(fact("attempt_started"))}\n${JSON.stringify(fact("attempt_started"))}\n`,
  );
  assert.deepEqual(readFacts({ eventsPath: duplicate }).facts, [fact("attempt_started")]);
  fs.appendFileSync(
    duplicate,
    `${JSON.stringify({ ...fact("attempt_started"), at: "2025-01-02T00:00:00.000Z" })}\n`,
  );
  assert.throws(
    () => readFacts({ eventsPath: duplicate }),
    (error) => error.code === "DUPLICATE_EVENT_ID",
  );

  const historical = tempEvents("historical");
  const unknown = { event_id: "old-1", run_id: "r1", type: "retired_fact", payload: { any: true } };
  fs.writeFileSync(historical, `${JSON.stringify(unknown)}\n`);
  assert.deepEqual(readFacts({ eventsPath: historical }).facts, [unknown]);
  fs.appendFileSync(historical, `${JSON.stringify(unknown)}\n`);
  assert.deepEqual(readFacts({ eventsPath: historical }).facts, [unknown]);
});

test("merge provenance persists exact reviewed, PR-head, and target SHAs", () => {
  const eventsPath = tempEvents("merge");
  const merge = fact("merge_recorded");
  const lock = acquireFactLock(eventsPath);
  try {
    appendFact({ eventsPath, fact: merge, lockContext: lock });
    assert.deepEqual(readFacts({ eventsPath }).facts[0].payload, merge.payload);
  } finally {
    releaseRunLock(lock);
  }
});

test("lock facts carry the host audit attempt_id and forged or cross-run capabilities fail", () => {
  const eventsPath = tempEvents("lock-capability");
  const otherEventsPath = tempEvents("other-run");
  const lock = acquireFactLock(eventsPath);
  try {
    const acquired = fact("lock_acquired");
    assert.equal(acquired.attempt_id, "a1");
    appendFact({ eventsPath, fact: acquired, lockContext: lock });
    assert.throws(
      () => appendFact({ eventsPath: otherEventsPath, fact: fact("lock_released", 2), lockContext: lock }),
      (error) => error.code === "RUN_LOCK_REQUIRED",
    );
    assert.throws(
      () => appendFact({ eventsPath, fact: fact("lock_released", 2), lockContext: { ...lock, owner: { ...lock.owner, token: "forged" } } }),
      (error) => error.code === "RUN_LOCK_REQUIRED",
    );
  } finally {
    releaseRunLock(lock);
  }
});

test("host lock audit records conform to the attempt-scoped lock fact envelopes", () => {
  const eventsPath = tempEvents("host-audit");
  const runDir = fs.realpathSync(path.dirname(eventsPath));
  const audit = [];
  const lock = acquireRunLock({
    runDir,
    attemptId: "audit-attempt",
    operation: "dispatch",
    processStartedAt: "2026-07-31T00:00:00.000Z",
    audit: (entry) => audit.push(entry),
  });
  releaseRunLock(lock, {
    outcome: "completed",
    audit: (entry) => audit.push(entry),
  });
  assert.deepEqual(audit.map((entry) => entry.type), ["lock_acquired", "lock_released"]);
  audit.forEach((entry, index) => {
    assert.equal(entry.attempt_id, "audit-attempt");
    const normalized = factFromHostAudit({
      eventId: `audit-${index + 1}`,
      runId: "r1",
      at: `2026-07-31T00:00:0${index}Z`,
      actor: "owner",
      audit: entry,
    });
    assert.equal(normalized.attempt_id, "audit-attempt");
    assert.equal(validateFact(normalized).known, true);
  });
});

test("historical reads preserve additive fields on known facts but writes remain closed", () => {
  const eventsPath = tempEvents("future-fields");
  const future = {
    ...fact("review_recorded"),
    future_envelope: "preserve",
    payload: {
      ...payload("review_recorded"),
      future_payload: { opaque: true },
    },
  };
  fs.writeFileSync(eventsPath, `${JSON.stringify(future)}\n`);
  assert.deepEqual(readFacts({ eventsPath }).facts, [future]);
  assert.throws(() => validateFact(future), /future_envelope is not allowed/);
});

test("review executed runtime evidence is optional for history but closed when present", () => {
  const base = fact("review_recorded"), executed_runtime = { digest: HASH, executable: { path: "/bin/reviewer", dev: 1, ino: 2, size: 3, sha256: HASH } };
  assert.equal(validateFact({ ...base, payload: { ...base.payload, executed_runtime } }).known, true);
  assert.throws(() => validateFact({ ...base, payload: { ...base.payload, executed_runtime: { ...executed_runtime, extra: true } } }), /extra is not allowed/);
  assert.throws(() => validateFact({ ...base, payload: { ...base.payload, executed_runtime: { ...executed_runtime, executable: { ...executed_runtime.executable, sha256: "bad" } } } }), /sha256/);
});

// The schema keeps executed_runtime optional so journals written before it existed still parse. The
// append path must not inherit that tolerance: a verdict this runtime records without its runtime
// binding would be a review fact that no longer says which executable produced it.
test("appending a review verdict without executed runtime evidence fails closed", () => {
  const eventsPath = tempEvents("review-runtime-required");
  const lock = acquireFactLock(eventsPath);
  const executed_runtime = { digest: HASH, executable: { path: "/bin/reviewer", dev: 1, ino: 2, size: 3, sha256: HASH } };
  try {
    assert.throws(
      () => appendFact({ eventsPath, fact: fact("review_recorded"), lockContext: lock }),
      (error) => error.code === "INVALID_FACT" && /executed_runtime is required when appending review_recorded/.test(error.message),
    );
    assert.equal(readFacts({ eventsPath }).facts.length, 0, "the rejected verdict must not reach the journal");
    const missingBase = fact("review_recorded");
    delete missingBase.payload.base_sha;
    assert.throws(
      () => appendFact({ eventsPath, fact: { ...missingBase, payload: { ...missingBase.payload, executed_runtime } }, lockContext: lock }),
      (error) => error.code === "INVALID_FACT" && /base_sha is required when appending review_recorded/.test(error.message),
    );
    const bound = fact("review_recorded");
    appendFact({ eventsPath, fact: { ...bound, payload: { ...bound.payload, executed_runtime } }, lockContext: lock });
    assert.equal(readFacts({ eventsPath }).facts.at(-1).payload.executed_runtime.executable.ino, 2);
  } finally {
    releaseRunLock(lock);
  }
});

test("review escalation classification is required only for current escalated appends", () => {
  const eventsPath = tempEvents("review-escalation-kind");
  const lock = acquireFactLock(eventsPath);
  const executed_runtime = { digest: HASH, executable: { path: "/bin/reviewer", dev: 1, ino: 2, size: 3, sha256: HASH } };
  try {
    const escalated = fact("review_recorded");
    escalated.payload = { ...escalated.payload, verdict: "escalated", executed_runtime };
    assert.throws(() => appendFact({ eventsPath, fact: escalated, lockContext: lock }), /escalation_kind is required/);

    const pass = fact("review_recorded");
    pass.payload = { ...pass.payload, executed_runtime, escalation_kind: "reviewer" };
    assert.throws(() => appendFact({ eventsPath, fact: pass, lockContext: lock }), /only allowed for escalated/);

    const historical = fact("review_recorded");
    historical.payload = { ...historical.payload, verdict: "escalated" };
    assert.equal(validateFact(historical).known, true, "old escalations remain readable but fail closed in inspect");
  } finally {
    releaseRunLock(lock);
  }
});

test("journal path and fact run identity are bound to immutable run.json", () => {
  const eventsPath = tempEvents("identity");
  const lock = acquireFactLock(eventsPath);
  try {
    assert.throws(
      () => appendFact({
        eventsPath,
        fact: { ...fact("attempt_started"), run_id: "other" },
        lockContext: lock,
      }),
      (error) => error.code === "RUN_ID_MISMATCH",
    );
    assert.throws(
      () => appendFact({
        eventsPath: path.join(path.dirname(eventsPath), "alternate.jsonl"),
        fact: fact("attempt_started"),
        lockContext: lock,
      }),
      (error) => error.code === "UNTRUSTED_FACT_JOURNAL",
    );
  } finally {
    releaseRunLock(lock);
  }
});

test("torn-tail quarantine retries collisions and syncs directory durability", () => {
  const eventsPath = tempEvents("quarantine-collision");
  const lock = acquireFactLock(eventsPath);
  try {
    appendFact({ eventsPath, fact: fact("attempt_started"), lockContext: lock });
    fs.appendFileSync(eventsPath, "torn");
    const at = "2026-07-31T00:00:00Z";
    const firstCandidate = `${eventsPath}.corrupt-tail.2026-07-31T00-00-00Z`;
    fs.writeFileSync(firstCandidate, "existing");
    let directorySyncs = 0;
    const fsSpy = {
      ...fs,
      fsyncSync(fd) {
        if (fs.fstatSync(fd).isDirectory()) directorySyncs += 1;
        return fs.fsyncSync(fd);
      },
    };
    const repaired = repairTornTail({ eventsPath, lockContext: lock, at, fsModule: fsSpy });
    assert.equal(repaired.quarantinePath, `${firstCandidate}.1`);
    assert.equal(directorySyncs >= 2, true);
  } finally {
    releaseRunLock(lock);
  }
});

test("append faults at open, write, and fsync boundaries fail loudly", () => {
  for (const stage of ["openSync", "writeSync", "fsyncSync"]) {
    const eventsPath = tempEvents(`append-fault-${stage}`);
    const lock = acquireFactLock(eventsPath);
    const fsFault = {
      ...fs,
      [stage](...args) {
        if (
          stage === "openSync"
          || stage === "writeSync"
          || (stage === "fsyncSync" && !fs.fstatSync(args[0]).isDirectory())
        ) {
          const error = new Error(`injected ${stage}`);
          error.code = "EIO";
          throw error;
        }
        return fs[stage](...args);
      },
    };
    try {
      assert.throws(
        () => appendFact({
          eventsPath,
          fact: fact("attempt_started"),
          lockContext: lock,
          fsModule: fsFault,
        }),
        new RegExp(`injected ${stage}`),
      );
    } finally {
      releaseRunLock(lock);
    }
  }
});

test("first journal creation surfaces directory fsync failure after durable record write", () => {
  const eventsPath = tempEvents("append-dir-fsync");
  const lock = acquireFactLock(eventsPath);
  const fsFault = {
    ...fs,
    fsyncSync(fd) {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("injected directory fsync");
      return fs.fsyncSync(fd);
    },
  };
  try {
    assert.throws(
      () => appendFact({
        eventsPath,
        fact: fact("attempt_started"),
        lockContext: lock,
        fsModule: fsFault,
      }),
      /injected directory fsync/,
    );
    assert.deepEqual(readFacts({ eventsPath }).facts, [fact("attempt_started")]);
  } finally {
    releaseRunLock(lock);
  }
});

test("repair read fault never truncates the journal", () => {
  const eventsPath = tempEvents("repair-read-fault");
  const lock = acquireFactLock(eventsPath);
  try {
    appendFact({ eventsPath, fact: fact("attempt_started"), lockContext: lock });
    fs.appendFileSync(eventsPath, "torn");
    const before = fs.readFileSync(eventsPath);
    const fsFault = {
      ...fs,
      readFileSync() {
        const error = new Error("injected read");
        error.code = "EIO";
        throw error;
      },
    };
    assert.throws(
      () => repairTornTail({ eventsPath, lockContext: lock, fsModule: fsFault }),
      /injected read/,
    );
    assert.deepEqual(fs.readFileSync(eventsPath), before);
  } finally {
    releaseRunLock(lock);
  }
});

test("fact reader stays on the opened inode during a path swap", () => {
  const eventsPath = tempEvents("read-inode-swap");
  const lock = acquireFactLock(eventsPath);
  try {
    appendFact({ eventsPath, fact: fact("attempt_started"), lockContext: lock });
  } finally {
    releaseRunLock(lock);
  }
  const originalInode = fs.statSync(eventsPath).ino;
  const originalRead = fs.readFileSync;
  const retained = `${eventsPath}.retained`;
  const attacker = `${eventsPath}.attacker`;
  fs.writeFileSync(attacker, `${JSON.stringify({ event_id: "attacker", run_id: "r1", type: "retired_fact" })}\n`);
  let swapped = false;
  fs.readFileSync = function swappedRead(target, ...args) {
    if (!swapped && typeof target === "number" && fs.fstatSync(target).ino === originalInode) {
      swapped = true;
      fs.renameSync(eventsPath, retained);
      fs.symlinkSync(attacker, eventsPath);
    }
    return originalRead.call(fs, target, ...args);
  };
  try {
    assert.deepEqual(readFacts({ eventsPath }).facts, [fact("attempt_started")]);
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(swapped, true);
});
