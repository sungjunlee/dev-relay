const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createRunRecord,
  freezeDoneCriteria,
  hashDoneCriteria,
  readRunRecord,
  validateRunRecord,
} = require("../../../skills/relay-dispatch/scripts/run-store");
const runtime = require("../../../skills/relay-dispatch/scripts/runtime-vnext");

function tempDir(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-${label}-`)));
  const runDir = path.join(root, "run-1");
  fs.mkdirSync(runDir);
  return runDir;
}

function record(runDir, overrides = {}) {
  const criteriaPath = path.join(runDir, "done-criteria.md");
  return {
    version: 3,
    run_id: "run-1",
    repo: { root: "/repo", remote: "owner/repo" },
    git: {
      branch: "work",
      base_branch: "main",
      worktree: "/relay/worktree",
      start_sha: "a".repeat(40),
    },
    contract: {
      done_criteria_path: criteriaPath,
      done_criteria_sha256: "b".repeat(64),
    },
    roles: { orchestrator: "codex", executor: "cursor", reviewer: "claude" },
    parent: null,
    ownership_digest: null,
    created_at: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

test("run.json is immutable, exact-schema, and same-byte creation is idempotent", () => {
  const runDir = tempDir("run-record");
  fs.writeFileSync(path.join(runDir, "done-criteria.md"), "criterion\n");
  const value = record(runDir, {
    contract: {
      done_criteria_path: path.join(runDir, "done-criteria.md"),
      done_criteria_sha256: crypto.createHash("sha256").update("criterion\n").digest("hex"),
    },
  });
  assert.deepEqual(createRunRecord({ runDir, record: value }), value);
  assert.deepEqual(createRunRecord({ runDir, record: value }), value);
  assert.deepEqual(readRunRecord({ runDir }), value);
  assert.throws(
    () => createRunRecord({ runDir, record: { ...value, run_id: "run-2" } }),
    (error) => error.code === "RUN_ID_PATH_MISMATCH",
  );
  assert.throws(
    () => validateRunRecord({ ...value, state: "draft" }),
    /run\.state is not allowed/,
  );
});

test("future run versions and incomplete immutable identities fail closed", () => {
  const runDir = tempDir("run-version");
  assert.throws(
    () => validateRunRecord(record(runDir, { version: 4 })),
    (error) => error.code === "UNSUPPORTED_RUN_VERSION",
  );
  const incomplete = record(runDir);
  delete incomplete.contract.done_criteria_sha256;
  assert.throws(() => validateRunRecord(incomplete), /done_criteria_sha256 is required/);
});

test("Done Criteria are frozen by bytes and later source mutation has no effect", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-criteria-")));
  const runDir = path.join(root, "run-1");
  const sourcePath = path.join(root, "source.md");
  fs.writeFileSync(sourcePath, "criterion A\n", "utf8");
  const frozen = freezeDoneCriteria({ sourcePath, runDir });
  const expected = crypto.createHash("sha256").update("criterion A\n").digest("hex");
  assert.equal(frozen.sha256, expected);
  assert.equal(hashDoneCriteria(frozen.path), expected);
  fs.writeFileSync(sourcePath, "criterion B\n", "utf8");
  assert.equal(fs.readFileSync(frozen.path, "utf8"), "criterion A\n");
  assert.throws(
    () => freezeDoneCriteria({ sourcePath, runDir }),
    (error) => error.code === "DONE_CRITERIA_CONFLICT",
  );
});

test("run and Done Criteria readers refuse symlinks", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-run-symlink-")));
  const target = path.join(root, "target");
  const runDir = path.join(root, "run-1");
  fs.mkdirSync(target);
  fs.mkdirSync(runDir);
  fs.writeFileSync(path.join(target, "run.json"), "{}\n");
  fs.symlinkSync(path.join(target, "run.json"), path.join(runDir, "run.json"));
  assert.throws(
    () => readRunRecord({ runDir }),
    (error) => error.code === "UNTRUSTED_RUN_ARTIFACT",
  );
});

test("run directory basename is the immutable run identity", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-run-id-path-")));
  const runDir = path.join(root, "wrong-name");
  fs.mkdirSync(runDir);
  const criteriaPath = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteriaPath, "criterion\n");
  const value = record(runDir, {
    contract: {
      done_criteria_path: criteriaPath,
      done_criteria_sha256: crypto.createHash("sha256").update("criterion\n").digest("hex"),
    },
  });
  assert.throws(
    () => createRunRecord({ runDir, record: value }),
    (error) => error.code === "RUN_ID_PATH_MISMATCH",
  );
});

test("stored Done Criteria path must itself be canonical, not merely resolve canonically", () => {
  const runDir = tempDir("criteria-canonical-path");
  const criteriaPath = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteriaPath, "criterion\n");
  const alias = path.join(path.dirname(runDir), "run-alias");
  fs.symlinkSync(runDir, alias);
  const value = record(runDir, {
    contract: {
      done_criteria_path: path.join(alias, "done-criteria.md"),
      done_criteria_sha256: crypto.createHash("sha256").update("criterion\n").digest("hex"),
    },
  });
  assert.throws(
    () => createRunRecord({ runDir, record: value }),
    /frozen run-local done-criteria/,
  );
});

test("run record creation and reads bind the exact frozen Done Criteria bytes", () => {
  const runDir = tempDir("run-criteria-binding");
  const criteriaPath = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteriaPath, "criterion\n");
  const value = record(runDir, {
    contract: {
      done_criteria_path: criteriaPath,
      done_criteria_sha256: crypto.createHash("sha256").update("criterion\n").digest("hex"),
    },
  });
  createRunRecord({ runDir, record: value });
  fs.writeFileSync(criteriaPath, "mutated\n");
  assert.throws(
    () => readRunRecord({ runDir }),
    (error) => error.code === "DONE_CRITERIA_HASH_MISMATCH",
  );
});

test("run record reader stays on the opened inode during a path swap", () => {
  const runDir = tempDir("run-read-inode-swap");
  const criteriaPath = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteriaPath, "done\n");
  const value = record(runDir, {
    contract: {
      done_criteria_path: criteriaPath,
      done_criteria_sha256: crypto.createHash("sha256").update("done\n").digest("hex"),
    },
  });
  createRunRecord({ runDir, record: value });
  const runPath = path.join(runDir, "run.json");
  const originalInode = fs.statSync(runPath).ino;
  const originalRead = fs.readFileSync;
  const retained = `${runPath}.retained`;
  const attacker = `${runPath}.attacker`;
  fs.writeFileSync(attacker, "{}\n");
  let swapped = false;
  fs.readFileSync = function swappedRead(target, ...args) {
    if (!swapped && typeof target === "number" && fs.fstatSync(target).ino === originalInode) {
      swapped = true;
      fs.renameSync(runPath, retained);
      fs.symlinkSync(attacker, runPath);
    }
    return originalRead.call(fs, target, ...args);
  };
  try {
    assert.deepEqual(readRunRecord({ runDir }), value);
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(swapped, true);
});

test("recovery converges without duplicate apply after an effect-before-receipt crash", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recover-crash-"));
  let published = false;
  let applies = 0;
  const operation = {
    runDir,
    recoveryKey: "publish-crash",
    observe: async () => ({ converged: published, pr: published ? 42 : null }),
    apply: async () => {
      applies += 1;
      published = true;
      throw new Error("simulated process crash after external effect");
    },
  };
  await assert.rejects(runtime.recoverRun(operation), /simulated process crash/);
  const receipt = await runtime.recoverRun(operation);
  assert.equal(applies, 1);
  assert.equal(receipt.applied, false);
  assert.equal(receipt.final_observation.converged, true);
});

test("recovery receipt open/write/fsync/rename faults converge on retry", async () => {
  for (const stage of ["open", "write", "fsync", "rename", "dir_fsync"]) {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `relay-recover-${stage}-`));
    let applied = 0;
    let converged = false;
    let injected = false;
    const operation = {
      runDir,
      recoveryKey: `fault-${stage}`,
      observe: async () => ({ converged }),
      apply: async () => {
        applied += 1;
        converged = true;
        return { applied };
      },
      fault(current, pathname) {
        if (!injected && current === stage && !pathname.endsWith(".intent.json")) {
          injected = true;
          throw new Error(`injected ${stage}`);
        }
      },
    };
    await assert.rejects(runtime.recoverRun(operation), new RegExp(`injected ${stage}`));
    delete operation.fault;
    const receipt = await runtime.recoverRun(operation);
    assert.equal(receipt.final_observation.converged, true, stage);
    assert.equal(applied, 1, stage);
  }
});

test("merge recording converges after fact append but before receipt", async () => {
  const runDir = tempDir("merge-crash");
  const criteriaPath = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteriaPath, "done\n");
  const value = record(runDir, {
    contract: {
      done_criteria_path: criteriaPath,
      done_criteria_sha256: crypto.createHash("sha256").update("done\n").digest("hex"),
    },
  });
  createRunRecord({ runDir, record: value });
  const eventsPath = path.join(runDir, "events.jsonl");
  const observer = {
    command: process.execPath,
    args: [
      {
        kind: "staged_file",
        value: path.resolve(__dirname, "../fixtures/vnext-json-observer.js"),
      },
      { kind: "literal", value: "--observe" },
    ],
  };
  const provenance = {
    pr_number: 42,
    reviewed_source_sha: "a".repeat(40),
    pr_head_sha: "a".repeat(40),
    result_target_sha: "b".repeat(40),
    method: "squash",
    operator: "owner",
    override_reason: null,
  };
  let operationId;
  await runtime.withRunLock({
    runDir,
    attemptId: "merge-crash",
    operation: "merge-crash",
    hostKind: "local_supervisor",
    hostHandle: `merge-crash:${process.pid}`,
    worktreeDir: runDir,
  }, async (lockContext) => {
    const fresh = await runtime.revalidateExternalFacts({
      runDir,
      lockContext,
      observer,
      request: { pr_number: 42, expected_pr_head_sha: "a".repeat(40) },
      authorize: () => ({ authorized: true }),
    });
    const authorization = runtime.planOperatorMerge({
      runDir,
      lockContext,
      freshObservation: fresh.observationCapability,
      operatorAction: { actor: "owner", method: "squash" },
      currentHead: "a".repeat(40),
      currentDoneCriteriaSha256: value.contract.done_criteria_sha256,
      prNumber: 42,
      verdict: {
        verdict: "lgtm",
        reviewed_sha: "a".repeat(40),
        done_criteria_sha256: value.contract.done_criteria_sha256,
      },
    });
    operationId = authorization.operationId;
    await assert.rejects(runtime.recordMerge({
      eventsPath,
      provenance,
      authorization,
      lockContext,
      observer,
      fault(stage) {
        if (stage === "after_fact_append") throw new Error("crash after merge fact");
      },
    }), /crash after merge fact/);
  });
  await runtime.withRunLock({
    runDir,
    attemptId: "merge-resume",
    operation: "merge-resume",
    hostKind: "local_supervisor",
    hostHandle: `merge-resume:${process.pid}`,
    worktreeDir: runDir,
  }, async (lockContext) => {
    const fresh = await runtime.revalidateExternalFacts({
      runDir,
      lockContext,
      observer,
      request: { pr_number: 42, expected_pr_head_sha: "a".repeat(40) },
      authorize: () => ({ authorized: true }),
    });
    const authorizationPath = path.join(runDir, `merge-authorization-${operationId}.json`);
    const originalAuthorization = fs.readFileSync(authorizationPath);
    const forged = JSON.parse(originalAuthorization);
    forged.operator = "attacker";
    fs.writeFileSync(authorizationPath, `${JSON.stringify(forged)}\n`);
    assert.throws(() => runtime.resumeOperatorMerge({
      runDir,
      lockContext,
      operationId,
      freshObservation: fresh.observationCapability,
    }), /HMAC is invalid/);
    fs.writeFileSync(authorizationPath, originalAuthorization);
    const keyPath = path.join(runDir, ".merge-authorization.key");
    fs.chmodSync(keyPath, 0o644);
    assert.throws(() => runtime.resumeOperatorMerge({
      runDir,
      lockContext,
      operationId,
      freshObservation: fresh.observationCapability,
    }), /permissions are unsafe/);
    fs.chmodSync(keyPath, 0o600);
    const authorization = runtime.resumeOperatorMerge({
      runDir,
      lockContext,
      operationId,
      freshObservation: fresh.observationCapability,
    });
    const converged = await runtime.recordMerge({
      eventsPath,
      provenance,
      authorization,
      lockContext,
      observer,
    });
    assert.equal(converged.payload.operation_id, operationId);
    assert.equal(
      fs.readFileSync(eventsPath, "utf8").trim().split("\n").length,
      1,
    );
    assert.equal(
      fs.existsSync(path.join(runDir, `merge-receipt-${operationId}.json`)),
      true,
    );
  });
});
