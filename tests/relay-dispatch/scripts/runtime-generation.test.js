"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const test = require("node:test");

const generation = require("../../../skills/relay-dispatch/scripts/runtime-generation");

const worker = path.resolve(__dirname, "../fixtures/runtime-generation-worker.js");
const ZERO = Object.freeze({
  observed_at: "2026-08-01T06:11:54.365Z",
  active_legacy_run_count: 0,
  oldest_active_legacy_age_hours: null,
});
const ONE = Object.freeze({
  observed_at: "2026-08-01T06:11:54.302Z",
  active_legacy_run_count: 1,
  oldest_active_legacy_age_hours: 35,
});

function fixture(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-generation-${label}-`)));
  execFileSync("git", ["init", "-q", root]);
  const repository = { checkoutRoot: root, remote: "sungjunlee/dev-relay" };
  const store = generation.initializeStore(repository);
  return { root, stateDir: store.stateDir, repository, store };
}

test("read-only generation peek preserves absence and rejects partial stores", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-generation-peek-")));
  execFileSync("git", ["init", "-q", root]);
  const repository = { checkoutRoot: root, remote: "sungjunlee/dev-relay" };
  const stateDir = path.join(root, ".git", "relay-runtime-vnext");
  assert.equal(generation.peekStore(repository), null);
  assert.equal(fs.existsSync(stateDir), false);

  fs.mkdirSync(stateDir);
  assert.throws(
    () => generation.peekStore(repository),
    (error) => error.code === "INVALID_GENERATION_STORE",
  );
  assert.deepEqual(fs.readdirSync(stateDir), [], "peek must not repair a partial store");
});

test("read-only generation peek rejects symlinked store components without mutation", () => {
  const value = fixture("peek-symlink");
  const realEvents = `${value.store.paths.events}-real`;
  fs.renameSync(value.store.paths.events, realEvents);
  fs.symlinkSync(realEvents, value.store.paths.events);
  const beforeTarget = fs.readlinkSync(value.store.paths.events);
  assert.throws(
    () => generation.peekStore(value.repository),
    (error) => error.code === "UNTRUSTED_GENERATION_PATH",
  );
  assert.equal(fs.readlinkSync(value.store.paths.events), beforeTarget);
  assert.deepEqual(fs.readdirSync(realEvents), []);
});

function child(value, command, payload) {
  const processHandle = spawn(process.execPath, [worker, command, value.root, value.repository.remote, JSON.stringify(payload)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  processHandle.stdout.on("data", (chunk) => { stdout += chunk; });
  processHandle.stderr.on("data", (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve) => {
    processHandle.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { processHandle, completion };
}

function facts({ terminal = true } = {}) {
  const values = [
    {
      event_id: "1".repeat(64),
      type: "pull_request_recorded",
      payload: { pr_number: 42, repo: "sungjunlee/dev-relay", head_ref: "issue-1136", base_ref: "main", head_sha: "a".repeat(40), created_by_relay: true },
    },
    {
      event_id: "2".repeat(64),
      type: "attempt_started",
      attempt_id: "attempt-1",
      payload: { start_sha: "a".repeat(40) },
    },
  ];
  if (terminal) {
    values.push({
      event_id: "3".repeat(64),
      type: "attempt_finished",
      attempt_id: "attempt-1",
      payload: { status: "completed", start_sha: "a".repeat(40), final_sha: "b".repeat(40) },
    });
    values.push({
      event_id: "4".repeat(64),
      type: "merge_recorded",
      payload: {
        pr_number: 42,
        reviewed_source_sha: "b".repeat(40),
        pr_head_sha: "b".repeat(40),
        result_target_sha: "c".repeat(40),
        method: "squash",
        operation_id: "merge-42",
      },
    });
  }
  return values;
}

function drain(value, { observedAt = "2026-08-01T06:12:00.000Z", actor = "operator", operationId = "drain-1" } = {}) {
  return generation.recordDrainCompleted({
    store: value.store,
    inventory: { observed_at: observedAt, active_legacy_run_count: 0, oldest_active_legacy_age_hours: null },
    actor,
    operationId,
  });
}

function switchVnext(value, { actor = "operator", operationId = "switch-vnext-1", switchedAt = "2026-08-01T06:13:00.000Z", drainInventoryDigest = undefined, fault = null } = {}) {
  const decision = generation.readDecision(value.store);
  const completed = decision.strategy === "drain_and_cutover" ? drain(value) : null;
  return generation.switchGeneration({
    store: value.store,
    generation: "vnext",
    actor,
    operationId,
    switchedAt,
    drainInventoryDigest: drainInventoryDigest === undefined ? completed?.inventory.inventory_digest ?? null : drainInventoryDigest,
    fault,
  });
}

function loadedRuns({ terminal = true, closed = true } = {}) {
  return [{ run_id: "run-1", closed, facts: facts({ terminal }) }];
}

function rollback(value, { actor = "operator", operationId = "rollback-1", switchedAt = "2026-08-01T06:14:00.000Z", loaded = loadedRuns(), fault = null } = {}) {
  return generation.rollbackToLegacy({
    store: value.store,
    runIds: ["run-1"],
    loadRunFacts: () => loaded,
    switchedAt,
    actor,
    operationId,
    fault,
  });
}

test("repository identity and observed migration decision are exact, immutable, and idempotent", () => {
  const value = fixture("decision");
  const first = generation.decideMigration({ store: value.store, observation: ZERO });
  const second = generation.decideMigration({ store: value.store, observation: ZERO });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.decision.strategy, "drain_and_cutover");
  assert.equal(first.decision.decision_digest.length, 64);
  assert.equal(generation.readEvents(value.store).filter((event) => event.type === "migration_decided").length, 1);
  assert.throws(
    () => generation.decideMigration({ store: value.store, observation: { ...ZERO, observed_at: "2026-08-01T06:12:00.000Z" } }),
    (error) => error.code === "MIGRATION_DECISION_CONFLICT",
  );
  assert.throws(
    () => generation.initializeStore({ checkoutRoot: value.root, remote: "other/repo" }),
    (error) => error.code === "REPOSITORY_IDENTITY_CONFLICT",
  );
});

test("linked worktrees resolve one Git-common-dir marker and serialize admission across processes without dirtying checkouts", async () => {
  const value = fixture("linked-worktree");
  execFileSync("git", ["config", "user.email", "relay@example.test"], { cwd: value.root });
  execFileSync("git", ["config", "user.name", "Relay Test"], { cwd: value.root });
  fs.writeFileSync(path.join(value.root, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "seed.txt"], { cwd: value.root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: value.root });
  const linkedRoot = path.join(path.dirname(value.root), `${path.basename(value.root)}-linked`);
  execFileSync("git", ["worktree", "add", "-q", "--detach", linkedRoot], { cwd: value.root });
  const linked = generation.initializeStore({ checkoutRoot: fs.realpathSync(linkedRoot), remote: value.repository.remote });
  assert.equal(linked.stateDir, value.store.stateDir);
  assert.equal(linked.repositoryDigest, value.store.repositoryDigest);

  generation.decideMigration({ store: value.store, observation: ZERO });
  const completed = drain(value, { observedAt: "2026-08-01T06:12:00.500Z", operationId: "linked-drain" });
  let admit;
  let release;
  const admitted = new Promise((resolve) => { admit = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  const legacy = generation.withGenerationAdmission({ store: value.store, generation: "legacy", mode: "write" }, async () => {
    admit();
    await released;
  });
  await admitted;
  const linkedValue = { ...value, root: fs.realpathSync(linkedRoot) };
  const switching = child(linkedValue, "switch", {
    generation: "vnext",
    actor: "operator",
    operationId: "linked-switch",
    switchedAt: "2026-08-01T06:12:01.000Z",
    drainInventoryDigest: completed.inventory.inventory_digest,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(switching.processHandle.exitCode, null, "linked-worktree switch must wait for the shared admission lock");
  release();
  await legacy;
  const switched = await switching.completion;
  assert.equal(switched.code, 0, switched.stderr);
  assert.equal(generation.readGeneration(value.store).writer_generation, "vnext");
  assert.equal(generation.readGeneration(linked).writer_generation, "vnext");
  assert.equal(execFileSync("git", ["status", "--short"], { cwd: value.root, encoding: "utf8" }), "");
  assert.equal(execFileSync("git", ["status", "--short"], { cwd: linkedRoot, encoding: "utf8" }), "");
});

test("timestamps require exact canonical UTC form and future schemas fail closed", () => {
  for (const observedAt of ["2026-08-01T06:11:54Z", "2026-08-01T15:11:54.365+09:00", "2026-08-01 06:11:54.365Z"] ) {
    assert.throws(
      () => generation.decideMigration({ store: fixture(`timestamp-${observedAt.length}-${observedAt.charCodeAt(0)}`).store, observation: { ...ZERO, observed_at: observedAt } }),
      /canonical UTC ISO-8601/,
    );
  }
  const value = fixture("future-schema");
  fs.writeFileSync(value.store.paths.decision, `${JSON.stringify({ schema_version: 2 })}\n`);
  assert.throws(() => generation.readDecision(value.store), (error) => error.code === "UNSUPPORTED_GENERATION_SCHEMA");
});

test("strategy is derived from count and age, and an undrained drain decision cannot cut over", () => {
  const drain = fixture("drain-active");
  const dual = fixture("dual-decision");
  assert.equal(generation.decideMigration({ store: drain.store, observation: { ...ZERO, active_legacy_run_count: 1, oldest_active_legacy_age_hours: 71 } }).decision.strategy, "drain_and_cutover");
  assert.equal(generation.decideMigration({ store: dual.store, observation: { ...ZERO, active_legacy_run_count: 6, oldest_active_legacy_age_hours: 1 } }).decision.strategy, "dual_read_vnext_write");
  assert.throws(
    () => generation.switchGeneration({ store: drain.store, generation: "vnext", actor: "operator", operationId: "switch-1", switchedAt: "2026-08-01T06:12:00.000Z", drainInventoryDigest: "0".repeat(64) }),
    (error) => error.code === "LEGACY_DRAIN_INCOMPLETE",
  );
});

test("a drain decision is immutable but cutover requires a later immutable zero inventory and its exact digest", () => {
  const value = fixture("fresh-drain-inventory");
  const initial = generation.decideMigration({ store: value.store, observation: ONE });
  assert.equal(initial.decision.strategy, "drain_and_cutover");
  assert.equal(initial.decision.active_legacy_run_count, 1);
  assert.equal(generation.readDrainCompleted(value.store), null);
  assert.throws(
    () => generation.recordDrainCompleted({ store: value.store, inventory: { observed_at: ONE.observed_at, active_legacy_run_count: 0, oldest_active_legacy_age_hours: null }, actor: "operator", operationId: "stale-drain" }),
    (error) => error.code === "LEGACY_DRAIN_STALE",
  );
  const completed = drain(value, { observedAt: "2026-08-01T06:12:00.000Z", operationId: "drain-proof-1" });
  assert.equal(completed.created, true);
  assert.equal(generation.readDrainCompleted(value.store).inventory_digest, completed.inventory.inventory_digest);
  assert.throws(
    () => generation.switchGeneration({ store: value.store, generation: "vnext", actor: "operator", operationId: "switch-proof-1", switchedAt: "2026-08-01T06:13:00.000Z", drainInventoryDigest: "f".repeat(64) }),
    (error) => error.code === "LEGACY_DRAIN_INCOMPLETE",
  );
  const switched = generation.switchGeneration({ store: value.store, generation: "vnext", actor: "operator", operationId: "switch-proof-1", switchedAt: "2026-08-01T06:13:00.000Z", drainInventoryDigest: completed.inventory.inventory_digest });
  assert.equal(switched.marker.writer_generation, "vnext");
  assert.throws(
    () => generation.recordDrainCompleted({ store: value.store, inventory: { observed_at: "2026-08-01T06:14:00.000Z", active_legacy_run_count: 0, oldest_active_legacy_age_hours: null }, actor: "other", operationId: "drain-proof-2" }),
    (error) => error.code === "LEGACY_DRAIN_COMPLETION_CONFLICT",
  );
});

test("dual-read/vNext-write separates writer generation from legacy read admission", async () => {
  const value = fixture("dual-admission");
  generation.decideMigration({ store: value.store, observation: { ...ZERO, active_legacy_run_count: 6, oldest_active_legacy_age_hours: 1 } });
  const switched = switchVnext(value);
  assert.equal(switched.marker.writer_generation, "vnext");
  assert.equal(switched.marker.legacy_read_allowed, true);
  assert.equal(await generation.withGenerationAdmission({ store: value.store, generation: "vnext", mode: "write" }, (capability) => capability.epoch), 2);
  assert.equal(await generation.withGenerationAdmission({ store: value.store, generation: "legacy", mode: "legacy_read" }, (capability) => capability.epoch), 2);
  await assert.rejects(
    generation.withGenerationAdmission({ store: value.store, generation: "legacy", mode: "write" }, () => null),
    (error) => error.code === "GENERATION_NOT_ACTIVE",
  );
});

test("generation transaction capabilities are unforgeable, expire after callbacks, and release on errors", async () => {
  const value = fixture("capability-lifetime");
  generation.decideMigration({ store: value.store, observation: ZERO });
  let expired;
  await generation.withGenerationAdmission({ store: value.store, generation: "legacy", mode: "write" }, (capability) => {
    expired = capability;
  });
  const input = {
    store: value.store,
    observationId: "capability-check",
    readerVersion: "legacy-1",
    surface: "dispatch",
    observedAt: "2026-08-01T06:12:00.000Z",
  };
  assert.throws(() => generation.recordLegacyRead({ ...input, admission: expired }), (error) => error.code === "GENERATION_ADMISSION_EXPIRED");
  assert.throws(() => generation.recordLegacyRead({ ...input, admission: { epoch: 1, generation: "legacy", mode: "write" } }), (error) => error.code === "INVALID_GENERATION_ADMISSION");
  await assert.rejects(
    generation.withGenerationAdmission({ store: value.store, generation: "legacy", mode: "write" }, () => { throw new Error("callback failed"); }),
    /callback failed/,
  );
  assert.equal(await generation.withGenerationAdmission({ store: value.store, generation: "legacy", mode: "write" }, () => "released"), "released");
  let writerCapability;
  await generation.withGenerationAdmission({ store: value.store, generation: "legacy", mode: "write" }, (capability) => {
    writerCapability = capability;
    assert.deepEqual(generation.assertGenerationWrite({ store: value.store, admission: capability, generation: "legacy" }), { epoch: 1, generation: "legacy" });
  });
  assert.throws(() => generation.assertGenerationWrite({ store: value.store, admission: writerCapability, generation: "legacy" }), (error) => error.code === "GENERATION_ADMISSION_EXPIRED");
  assert.throws(() => generation.assertGenerationWrite({ store: value.store, admission: { epoch: 1 }, generation: "legacy" }), (error) => error.code === "INVALID_GENERATION_ADMISSION");
});

test("drain cutover waits for an exclusive legacy transaction and rejects every later legacy event", async () => {
  const value = fixture("exclusive-cutover");
  generation.decideMigration({ store: value.store, observation: ZERO });
  const completed = drain(value, { observedAt: "2026-08-01T06:12:00.500Z" });
  let admit;
  let release;
  const admitted = new Promise((resolve) => { admit = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  const legacy = generation.withGenerationAdmission({ store: value.store, generation: "legacy", mode: "write" }, async (capability) => {
    admit();
    await released;
    generation.recordLegacyRead({
      store: value.store,
      admission: capability,
      observationId: "last-legacy-read",
      readerVersion: generation.LEGACY_OVERLAY_READER_VERSION,
      surface: "dispatch",
      observedAt: "2026-08-01T06:12:00.000Z",
    });
  });
  await admitted;
  const switchChild = child(value, "switch", { generation: "vnext", actor: "operator", operationId: "switch-exclusive", switchedAt: "2026-08-01T06:12:01.000Z", drainInventoryDigest: completed.inventory.inventory_digest });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(switchChild.processHandle.exitCode, null, "cross-process cutover must wait for the admitted legacy callback");
  release();
  await legacy;
  const switched = await switchChild.completion;
  assert.equal(switched.code, 0, switched.stderr);
  const before = generation.readEvents(value.store).filter((event) => event.type === "legacy_read_observed");
  assert.equal(before.length, 1);
  assert.throws(
    () => generation.observeLegacyRead({ store: value.store, observationId: "forbidden", readerVersion: "legacy-1", surface: "dispatch", observedAt: "2026-08-01T06:12:02.000Z" }),
    (error) => error.code === "GENERATION_NOT_ACTIVE",
  );
  assert.equal(generation.readEvents(value.store).filter((event) => event.type === "legacy_read_observed").length, 1);
});

test("immutable event files coalesce a 12-way same-ID race and reject conflicting timestamps", async () => {
  const value = fixture("event-race");
  generation.decideMigration({ store: value.store, observation: ZERO });
  const payload = {
    observationId: "shared-observation",
    readerVersion: "legacy-1",
    surface: "review",
    observedAt: "2026-08-01T06:12:00.000Z",
  };
  const workers = Array.from({ length: 12 }, () => child(value, "observe", payload));
  const results = await Promise.all(workers.map((entry) => entry.completion));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const observations = generation.readEvents(value.store).filter((event) => event.type === "legacy_read_observed");
  assert.equal(observations.length, 1);
  assert.equal(fs.readdirSync(value.store.paths.events).filter((name) => name.endsWith(".json")).length, 2, "decision plus one observation");
  assert.throws(
    () => generation.observeLegacyRead({ ...payload, store: value.store, observedAt: "2026-08-01T06:12:01.000Z" }),
    (error) => error.code === "GENERATION_EVENT_CONFLICT",
  );
  assert.equal(generation.readEvents(value.store).filter((event) => event.type === "legacy_read_observed").length, 1);
});

test("rollback overlay projects PR, merge, and terminal attempt for the built-in legacy reader", () => {
  const value = fixture("overlay-terminal");
  generation.decideMigration({ store: value.store, observation: ZERO });
  switchVnext(value);
  const result = rollback(value);
  const projection = generation.readLegacyRecoveryOverlay({ store: value.store });
  assert.equal(result.marker.writer_generation, "legacy");
  assert.equal(projection.runs[0].action.pull_request.pr_number, 42);
  assert.equal(projection.runs[0].action.merge.operation_id, "merge-42");
  assert.equal(projection.runs[0].closed, true);
  assert.deepEqual(projection.runs[0].terminal, { attempt_id: "attempt-1", state: "terminal", status: "completed", start_sha: "a".repeat(40), final_sha: "b".repeat(40) });
  const retry = rollback(value);
  assert.equal(retry.changed, false);
});

test("rollback overlay projects active attempts and rejects caller-asserted reader compatibility", () => {
  const value = fixture("overlay-active");
  generation.decideMigration({ store: value.store, observation: ZERO });
  switchVnext(value);
  assert.throws(
    () => generation.rollbackToLegacy({ store: value.store, legacyReaderVersion: "caller-claims-compatible", runIds: ["run-1"], loadRunFacts: () => loadedRuns({ terminal: false }), switchedAt: "2026-08-01T06:14:00.000Z", actor: "operator", operationId: "rollback-1" }),
    (error) => error.code === "LEGACY_OVERLAY_UNSUPPORTED",
  );
  rollback(value, { loaded: loadedRuns({ terminal: false, closed: false }) });
  assert.deepEqual(generation.readLegacyRecoveryOverlay({ store: value.store }).runs[0].terminal, {
    attempt_id: "attempt-1", state: "active", status: "running", start_sha: "a".repeat(40), final_sha: null,
  });
  assert.throws(
    () => generation.readLegacyRecoveryOverlay({ store: value.store, readerVersion: "legacy-unknown" }),
    (error) => error.code === "LEGACY_OVERLAY_UNSUPPORTED",
  );
});

test("rollback invokes a canonical multi-run loader under the generation lock and retains closed terminal/action projections", async () => {
  const value = fixture("canonical-loader");
  generation.decideMigration({ store: value.store, observation: ZERO });
  switchVnext(value);
  let request;
  let childResult;
  const result = generation.rollbackToLegacy({
    store: value.store,
    runIds: ["run-1", "run-2"],
    actor: "operator",
    operationId: "rollback-multi-1",
    switchedAt: "2026-08-01T06:14:00.000Z",
    loadRunFacts(loaderRequest) {
      request = loaderRequest;
      const blocked = child(value, "observe", { observationId: "loader-lock", readerVersion: "legacy-1", surface: "recover", observedAt: "2026-08-01T06:14:00.000Z" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      assert.equal(blocked.processHandle.exitCode, null, "canonical fact loading must run while the repository generation lock is held");
      childResult = blocked.completion;
      return [
        { run_id: "run-2", closed: false, facts: facts({ terminal: false }) },
        { run_id: "run-1", closed: true, facts: facts() },
      ];
    },
  });
  assert.deepEqual(request.run_ids, ["run-1", "run-2"]);
  assert.equal(result.overlay.runs.length, 2);
  assert.equal(result.overlay.runs[0].closed, true);
  assert.equal(result.overlay.runs[0].terminal.state, "terminal");
  assert.equal(result.overlay.runs[1].closed, false);
  assert.equal(result.overlay.runs[1].action.pull_request.pr_number, 42);
  const blocked = await childResult;
  assert.equal(blocked.code, 0, "the delayed legacy read starts only after the rollback releases its transaction");
});

test("child-process crashes preserve the transition receipt, bind retry identity, and emit exactly one switch event", async () => {
  for (const command of ["crash-switch-before-marker", "crash-switch"]) {
    const value = fixture(`transition-crash-${command}`);
    generation.decideMigration({ store: value.store, observation: ZERO });
    const completed = drain(value, { operationId: `drain-${command}` });
    const payload = { generation: "vnext", actor: "operator-a", operationId: `switch-${command}`, switchedAt: "2026-08-01T06:13:00.000Z", drainInventoryDigest: completed.inventory.inventory_digest };
    const crashed = await child(value, command, payload).completion;
    assert.equal(crashed.code, command === "crash-switch" ? 73 : 74, crashed.stderr);
    assert.throws(
      () => generation.switchGeneration({ store: value.store, ...payload, actor: "operator-b" }),
      (error) => ["GENERATION_TRANSITION_PENDING", "GENERATION_TRANSITION_CONFLICT"].includes(error.code),
    );
    const resumed = generation.switchGeneration({ store: value.store, ...payload });
    assert.equal(resumed.marker.transition_actor, "operator-a");
    assert.equal(resumed.marker.transition_operation_id, payload.operationId);
    assert.equal(resumed.marker.transition_event_digest, resumed.event.event_id);
    assert.equal(generation.readEvents(value.store).filter((event) => event.type === "generation_switched").length, 1);
  }
});

test("child-process rollback crashes bind the pending overlay transition to one actor and one event digest", async () => {
  for (const command of ["crash-rollback-before-marker", "crash-rollback"]) {
    const value = fixture(`rollback-crash-${command}`);
    generation.decideMigration({ store: value.store, observation: ZERO });
    switchVnext(value);
    const payload = { actor: "operator-a", operationId: `rollback-${command}`, switchedAt: "2026-08-01T06:14:00.000Z" };
    const crashed = await child(value, command, payload).completion;
    assert.equal(crashed.code, command === "crash-rollback" ? 76 : 75, crashed.stderr);
    assert.throws(
      () => generation.rollbackToLegacy({ store: value.store, runIds: ["run-1"], loadRunFacts: () => loadedRuns(), ...payload, actor: "operator-b" }),
      (error) => ["GENERATION_TRANSITION_PENDING", "GENERATION_TRANSITION_CONFLICT"].includes(error.code),
    );
    const resumed = rollback(value, payload);
    assert.equal(resumed.marker.writer_generation, "legacy");
    assert.equal(resumed.marker.transition_actor, "operator-a");
    assert.equal(resumed.marker.transition_event_digest, resumed.switchEvent.event_id);
    assert.equal(generation.readEvents(value.store).filter((event) => event.type === "rollback_overlay_written").length, 1);
    assert.equal(generation.readEvents(value.store).filter((event) => event.type === "generation_switched" && event.payload.to_generation === "legacy").length, 1);
  }
});

test("symlink event and marker artifacts fail closed without following them", () => {
  const marker = fixture("marker-symlink");
  generation.decideMigration({ store: marker.store, observation: ZERO });
  fs.unlinkSync(marker.store.paths.generation);
  const outside = path.join(marker.root, "outside.json");
  fs.writeFileSync(outside, "{}\n");
  fs.symlinkSync(outside, marker.store.paths.generation);
  assert.throws(() => generation.readGeneration(marker.store), (error) => error.code === "UNTRUSTED_GENERATION_ARTIFACT");

  const events = fixture("event-symlink");
  generation.decideMigration({ store: events.store, observation: ZERO });
  fs.symlinkSync(outside, path.join(events.store.paths.events, `${"f".repeat(64)}.json`));
  assert.throws(() => generation.readEvents(events.store), (error) => error.code === "UNTRUSTED_GENERATION_ARTIFACT");
});

test("decision, marker, and immutable event publication crash boundaries converge on retry", () => {
  const boundaries = [
    ["decision", ["open", "write", "fsync", "dir_fsync"]],
    ["runtime-generation", ["open", "write", "fsync", "rename", "dir_fsync"]],
    ["generation-events", ["open", "write", "fsync", "dir_fsync"]],
  ];
  for (const [artifact, stages] of boundaries) {
    for (const stage of stages) {
      const value = fixture(`crash-decision-${artifact}-${stage}`);
      let fired = false;
      const fault = (current, target) => {
        if (!fired && current === stage && target.includes(artifact)) {
          fired = true;
          throw new Error(`injected ${artifact}-${stage}`);
        }
      };
      assert.throws(() => generation.decideMigration({ store: value.store, observation: ZERO, fault }), new RegExp(`injected ${artifact}-${stage}`));
      generation.decideMigration({ store: value.store, observation: ZERO });
      assert.equal(generation.readGeneration(value.store).writer_generation, "legacy");
      assert.equal(generation.readEvents(value.store).filter((event) => event.type === "migration_decided").length, 1);
    }
  }
});

test("rollback resumes after overlay, marker, and immutable event durable boundaries", () => {
  const points = ["overlay", "overlay-event", "marker", "switch-event"];
  for (const point of points) {
    const value = fixture(`rollback-${point}`);
    generation.decideMigration({ store: value.store, observation: ZERO });
    switchVnext(value);
    let eventWrites = 0;
    let fired = false;
    const fault = (stage, target) => {
      if (stage === "fsync" && target.includes("generation-events")) eventWrites += 1;
      const matches = (point === "overlay" && stage === "fsync" && target.includes("legacy-recovery-overlays"))
        || (point === "overlay-event" && stage === "fsync" && target.includes("generation-events") && eventWrites === 1)
        || (point === "marker" && stage === "rename" && target.endsWith("runtime-generation.json"))
        || (point === "switch-event" && stage === "fsync" && target.includes("generation-events") && eventWrites === 2);
      if (!fired && matches) {
        fired = true;
        throw new Error(`injected ${point}`);
      }
    };
    const request = { store: value.store, runIds: ["run-1"], loadRunFacts: () => loadedRuns(), switchedAt: "2026-08-01T06:14:00.000Z", actor: "operator", operationId: "rollback-1" };
    assert.throws(() => generation.rollbackToLegacy({ ...request, fault }), new RegExp(`injected ${point}`), point);
    const resumed = generation.rollbackToLegacy(request);
    assert.equal(resumed.marker.writer_generation, "legacy", point);
    assert.equal(generation.readLegacyRecoveryOverlay({ store: value.store }).runs[0].action.merge.operation_id, "merge-42", point);
    const events = generation.readEvents(value.store);
    assert.equal(events.filter((event) => event.type === "rollback_overlay_written").length, 1, point);
    assert.equal(events.filter((event) => event.type === "generation_switched" && event.payload.to_generation === "legacy").length, 1, point);
  }
});

test("checked-in cutover report separates reproducible preimage from historical operator evidence", () => {
  const reportPath = path.resolve(__dirname, "../../../docs/plans/relay-runtime-core-reset-vnext/cutover-decision-2026-08-01.json");
  const preimagePath = path.resolve(__dirname, "../../../docs/plans/relay-runtime-core-reset-vnext/cutover-decision-preimage-2026-08-01.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const preimageBytes = fs.readFileSync(preimagePath);
  const preimage = JSON.parse(preimageBytes);
  assert.deepEqual(report.decision_observation, {
    observed_at: "2026-08-01T06:11:54.302Z",
    active_legacy_run_count: 1,
    oldest_active_legacy_age_hours: 35,
  });
  assert.deepEqual(report.drain_completion, {
    observed_at: "2026-08-01T06:11:54.365Z",
    active_legacy_run_count: 0,
    oldest_active_legacy_age_hours: null,
  });
  assert.ok(report.drain_completion.observed_at > report.decision_observation.observed_at);
  const expectedStrategy = report.decision_observation.active_legacy_run_count <= 5
    && report.decision_observation.oldest_active_legacy_age_hours < 72
    ? "drain_and_cutover" : "dual_read_vnext_write";
  assert.equal(report.selected_strategy, expectedStrategy);
  assert.equal(report.archived_source_run_evidence.run_id, "issue-1118-20260730181218333-33897c8c");
  assert.equal(report.archived_source_run_evidence.head_sha, "7c83ed0620ec25b4e182c10813724dde02fbf9d7");
  assert.equal(report.archived_source_run_evidence.archive_tag, "archive/relay-issue-1118-vnext-drain");
  assert.equal(report.archived_source_run_evidence.close_event.state_to, "closed");
  assert.equal(report.archived_source_run_evidence.close_event.jsonl_record_sha256, "499eddf1fbc5b8a1bcb8c463b84b7a80072f7c155ff9600bf63f6f403a2c43e6");
  assert.match(report.archived_source_run_evidence.manifest_sha256, /^[0-9a-f]{64}$/);
  assert.match(report.archived_source_run_evidence.events_sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.evidence_scope.checked_in_preimage, "cutover-decision-preimage-2026-08-01.json");
  assert.equal(report.evidence_scope.checked_in_preimage_sha256, crypto.createHash("sha256").update(preimageBytes).digest("hex"));
  assert.match(report.evidence_scope.historical_operator_evidence, /not.*test-verified/i);
  assert.equal(preimage.decision_observation.active_legacy_run_count, 1);
  assert.equal(preimage.drain_completion.active_legacy_run_count, 0);
  assert.equal(preimage.decision_observation.legacy_run_id, report.archived_source_run_evidence.run_id);
  assert.equal(preimage.decision_observation.legacy_run_created_at, report.archived_source_run_evidence.created_at);
  assert.equal(Math.floor((Date.parse(preimage.decision_observation.observed_at) - Date.parse(preimage.decision_observation.legacy_run_created_at)) / 3_600_000), preimage.decision_observation.oldest_active_legacy_age_hours);
  assert.equal(preimage.archive.commit, report.archived_source_run_evidence.head_sha);
  assert.match(preimage.decision_observation.provenance, /historical_operator_evidence/);
  assert.match(preimage.verification.not_checked_in.join(" "), /not.*independently.*test-verified/i);
  assert.equal(execFileSync("git", ["rev-parse", preimage.archive.tag], { cwd: path.resolve(__dirname, "../../.."), encoding: "utf8" }).trim(), preimage.archive.commit);
  assert.equal(execFileSync("git", ["cat-file", "-t", preimage.archive.tag], { cwd: path.resolve(__dirname, "../../.."), encoding: "utf8" }).trim(), "commit");
});
