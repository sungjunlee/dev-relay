"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const generation = require("../../../skills/relay-dispatch/scripts/runtime-generation");
const runStore = require("../../../skills/relay-dispatch/scripts/run-store");
const testAuthorities = new Map();
const authorityPreload = path.resolve(__dirname, "../fixtures/external-authority-preload.js");

function authorityFor(options, reason = options.quiescenceReason || "test operator confirms historical writers are quiesced") {
  const marker = generation.peekGeneration(options.store);
  const preview = generation.previewMigrationFromCanonicalInventory({
    checkoutRoot: fs.realpathSync(path.dirname(options.store.repository.git_common_dir)),
    remote: options.store.repository.remote,
    runsRoot: options.runsRoot,
  });
  const needsAuthority = preview.inventory.active_legacy_run_count === 0 && marker?.writer_generation !== "vnext"
    || preview.inventory.active_legacy_run_count === 0 && marker?.legacy_read_allowed === true;
  if (!needsAuthority) return null;
  const transitionOperationId = `${options.operationId}-${marker?.writer_generation === "vnext" ? "vnext-only" : "switch"}`;
  const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const authorityId = `${options.store.stateDir}:${transitionOperationId}`;
  let authority = testAuthorities.get(authorityId);
  if (!authority) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyBytes = publicKey.export({ type: "spki", format: "pem" });
    const keyId = crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const unsigned = {
      schema_version: 1,
      repository_digest: options.store.repositoryDigest,
      operation_id: transitionOperationId,
      actor: options.actor,
      reason,
      target_generation: "vnext",
      legacy_read_allowed: false,
      inventory_digest: preview.inventory.inventory_digest,
      identity_digest: preview.inventory.identity_digest,
      active_legacy_run_count: 0,
      oldest_active_legacy_age_hours: null,
      issued_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2030-01-01T00:00:00.000Z",
      previous_anchor_digest: null,
      key_id: keyId,
    };
    const signature = crypto.sign(null, Buffer.from(canonical(unsigned)), privateKey).toString("base64");
    const signed = { ...unsigned, signature };
    const attestation = { ...signed, attestation_digest: crypto.createHash("sha256").update(canonical(signed)).digest("hex") };
    const authorityDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-authority-")));
    const attestationPath = path.join(authorityDir, "quiescence.json"), keyPath = path.join(authorityDir, "public.pem");
    fs.writeFileSync(attestationPath, canonical(attestation), { mode: 0o400 });
    fs.writeFileSync(keyPath, publicKeyBytes, { mode: 0o400 });
    authority = { attestationPath, keyPath, publicKey, privateKey };
    testAuthorities.set(authorityId, authority);
  }
  return authority;
}

function startCanonical(options) {
  const reason = options.quiescenceReason || "test operator confirms historical writers are quiesced";
  const authority = authorityFor(options, reason);
  if (!authority) return generation.startMigrationFromCanonicalInventory({ quiescenceReason: reason, ...options });
  const { attestationPath, keyPath } = authority;
  const priorAttestation = process.env.RELAY_QUIESCENCE_ATTESTATION_FILE, priorKey = process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE;
  const originalGeteuid = process.geteuid, originalAccess = fs.accessSync;
  process.env.RELAY_QUIESCENCE_ATTESTATION_FILE = attestationPath;
  process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE = keyPath;
  process.geteuid = () => 99999;
  fs.accessSync = (target, mode) => {
    if (mode === fs.constants.W_OK) { const error = new Error("test authority is non-writable"); error.code = "EACCES"; throw error; }
    return originalAccess(target, mode);
  };
  try {
    return generation.startMigrationFromCanonicalInventory({ quiescenceReason: reason, ...options });
  } finally {
    process.geteuid = originalGeteuid;
    fs.accessSync = originalAccess;
    if (priorAttestation === undefined) delete process.env.RELAY_QUIESCENCE_ATTESTATION_FILE; else process.env.RELAY_QUIESCENCE_ATTESTATION_FILE = priorAttestation;
    if (priorKey === undefined) delete process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE; else process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE = priorKey;
  }
}

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

test("read-only generation peek rejects symlink parents for every status support directory", () => {
  for (const key of ["events", "overlays", "transitions", "transitionAborts", "quiescence", "rollout", "rolloutSeals", "terminalReceipts"]) {
    const value = fixture(`peek-support-${key}`), target = value.store.paths[key], real = `${target}-real`;
    fs.renameSync(target, real); fs.symlinkSync(real, target);
    assert.throws(() => generation.peekStore(value.repository), (error) => error.code === "UNTRUSTED_GENERATION_PATH", key);
    assert.equal(fs.readlinkSync(target), real, `${key} must not be repaired or followed`);
  }
});

function child(value, command, payload) {
  let env = process.env;
  if (command === "start") {
    const reason = payload.quiescenceReason || "worker test confirms historical writers are quiesced";
    const authority = authorityFor({ store: value.store, runsRoot: payload.runsRoot, actor: payload.actor, operationId: payload.operationId, quiescenceReason: reason }, reason);
    if (authority) env = {
      ...process.env,
      RELAY_QUIESCENCE_ATTESTATION_FILE: authority.attestationPath,
      RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE: authority.keyPath,
      RELAY_TEST_EXTERNAL_AUTHORITY: "1",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${authorityPreload}`.trim(),
    };
  }
  const processHandle = spawn(process.execPath, [worker, command, value.root, value.repository.remote, JSON.stringify(payload)], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
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

test("stale-lock quarantine restores a replacement live owner instead of removing it", () => {
  const value = fixture("stale-lock-replacement");
  fs.mkdirSync(value.store.paths.lock);
  fs.writeFileSync(path.join(value.store.paths.lock, "owner.json"), `${JSON.stringify({ schema_version: 1, pid: 999999, token: "a".repeat(48) })}\n`);
  const originalRename = fs.renameSync;
  let replaced = false;
  fs.renameSync = function guardedRename(source, destination, ...rest) {
    if (source === value.store.paths.lock && String(destination).startsWith(`${value.store.paths.lock}.stale.`)) {
      fs.rmSync(value.store.paths.lock, { recursive: true, force: true });
      fs.mkdirSync(value.store.paths.lock);
      fs.writeFileSync(path.join(value.store.paths.lock, "owner.json"), `${JSON.stringify({ schema_version: 1, pid: process.pid, token: "b".repeat(48) })}\n`);
      replaced = true;
    }
    return originalRename.call(this, source, destination, ...rest);
  };
  try {
    assert.throws(
      () => generation.decideMigration({ store: value.store, observation: ZERO }),
      (error) => error.code === "GENERATION_LOCK_REPLACED",
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(replaced, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(value.store.paths.lock, "owner.json"), "utf8")).token, "b".repeat(48));
  const malformed = fixture("malformed-lock-owner");
  fs.mkdirSync(malformed.store.paths.lock);
  fs.writeFileSync(path.join(malformed.store.paths.lock, "owner.json"), `${JSON.stringify({ schema_version: 1, pid: "not-a-pid", token: "c".repeat(48) })}\n`);
  assert.throws(
    () => generation.decideMigration({ store: malformed.store, observation: ZERO }),
    (error) => error.code === "UNTRUSTED_GENERATION_LOCK",
  );
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

test("all current runtime writer admissions linearize against a vNext-only cutover", async () => {
  const value = rolloutFixture("writer-admissions"), runId = "issue-1142-20260701000000000-56565656";
  legacyManifest(value, runId, "closed");
  generation.decideMigration({ store: value.store, observation: ZERO });
  let admit;
  let release;
  const admitted = new Promise((resolve) => { admit = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  const legacyWriter = generation.withGenerationAdmission({ store: value.store, generation: "legacy", mode: "write" }, async (capability) => {
    assert.deepEqual(generation.assertGenerationWrite({ store: value.store, admission: capability, generation: "legacy" }), { epoch: 1, generation: "legacy" });
    admit();
    await released;
  });
  await admitted;
  const cutover = child(value, "start", { runsRoot: value.runsRoot, actor: "operator", operationId: "writer-admissions" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(cutover.processHandle.exitCode, null, "an admitted legacy writer must complete before cutover can publish");
  release();
  await legacyWriter;
  const result = await cutover.completion;
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(
    generation.withGenerationAdmission({ store: value.store, generation: "legacy", mode: "write" }, () => null),
    (error) => error.code === "GENERATION_NOT_ACTIVE",
  );
  assert.equal(await generation.withGenerationAdmission({ store: value.store, generation: "vnext", mode: "write" }, (capability) => generation.assertGenerationWrite({ store: value.store, admission: capability, generation: "vnext" }).generation), "vnext");
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
  assert.equal(preimage.verification.requires_archive_ref_fetch, true);
  assert.deepEqual(preimage.verification.operator_verification_commands, [
    `git rev-parse ${preimage.archive.tag}`,
    `git cat-file -t ${preimage.archive.tag}`,
  ]);
  assert.match(preimage.verification.not_checked_in.join(" "), /archive ref.*shallow CI clones.*historical operator evidence/i);
  assert.match(preimage.archive.tag, /^archive\/[a-z0-9][a-z0-9._/-]+$/);
  assert.match(preimage.archive.commit, /^[0-9a-f]{40}$/);
});

function rolloutFixture(label) {
  const value = fixture(`rollout-${label}`);
  const runsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-rollout-runs-${label}-`)));
  const repoRoot = fs.realpathSync(path.dirname(value.store.repository.git_common_dir));
  const base = path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const slug = `${base}-${crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 8)}`;
  const repoRuns = path.join(runsRoot, slug);
  fs.mkdirSync(repoRuns);
  return { ...value, runsRoot, repoRuns, repoRoot };
}

function legacyManifest(value, runId, state = "closed") {
  const created = "2026-07-01T00:00:00.000Z";
  fs.writeFileSync(path.join(value.repoRuns, `${runId}.md`), [
    "---", `run_id: '${runId}'`, `state: '${state}'`, "metadata:", `  created_at: '${created}'`, "---", "",
  ].join("\n"));
  fs.mkdirSync(path.join(value.repoRuns, runId));
}

function setLegacyState(value, runId, state) {
  const target = path.join(value.repoRuns, `${runId}.md`);
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(/^state:.*$/m, `state: '${state}'`));
}

function byteTree(root) {
  const output = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name), stat = fs.lstatSync(target), relative = path.relative(root, target);
      if (stat.isDirectory()) { output.push([relative, "dir"]); walk(target); }
      else if (stat.isFile()) output.push([relative, "file", crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex")]);
      else output.push([relative, "other"]);
    }
  }
  walk(root);
  return output;
}

function vnextTerminalRun(value, index, at) {
  const runId = `issue-1142-${String(index).padStart(17, "0")}-aaaaaaaa`;
  const runDir = path.join(value.repoRuns, runId);
  fs.mkdirSync(runDir);
  const criteria = path.join(runDir, "done-criteria.md");
  fs.writeFileSync(criteria, "done\n");
  const criteriaDigest = runStore.hashDoneCriteria(criteria);
  const record = {
    version: runStore.RUN_VERSION,
    run_id: runId,
    repo: { root: value.repoRoot, remote: value.repository.remote },
    git: { branch: `issue-${index}`, base_branch: "main", worktree: value.repoRoot, start_sha: "a".repeat(40) },
    contract: { done_criteria_path: criteria, done_criteria_sha256: criteriaDigest },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "codex" },
    parent: null,
    ownership_digest: null,
    created_at: at,
  };
  runStore.createRunRecord({ runDir, record });
  const terminal = {
    event_id: `terminal-${index}`,
    run_id: runId,
    type: "run_closed",
    at,
    actor: "operator",
    payload: { reason: "complete", operator: "operator", last_sha: "b".repeat(40), pr_number: null },
  };
  fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify(terminal)}\n`);
}

function signedRolloutLineage(value, issuedAtFor = (observation) => observation.occurred_at, authority = null) {
  const marker = generation.peekGeneration(value.store);
  const observations = generation.readRolloutObservations(value.store).observations;
  const checkpoints = observations.filter((item) => item.type === "daily_checkpoint");
  const cutoverAuthority = testAuthorities.get(`${value.store.stateDir}:${marker.transition_operation_id}`);
  const { publicKey, privateKey } = authority || cutoverAuthority || crypto.generateKeyPairSync("ed25519");
  const publicKeyBytes = publicKey.export({ type: "spki", format: "pem" });
  const keyId = crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  let previousAnchorDigest = marker.quiescence_attestation_digest;
  const anchors = checkpoints.map((observation, index) => {
    const name = `${String(observation.sequence).padStart(12, "0")}.json`;
    const seal = JSON.parse(fs.readFileSync(path.join(value.store.paths.rolloutSeals, name), "utf8"));
    const unsigned = {
      schema_version: 1,
      repository_digest: value.store.repositoryDigest,
      marker_digest: marker.marker_digest,
      sequence: observation.sequence,
      observation_digest: observation.observation_digest,
      seal_digest: seal.seal_digest,
      checkpoint_date: observation.payload.date,
      issued_at: issuedAtFor(observation, index, checkpoints),
      previous_anchor_digest: previousAnchorDigest,
      key_id: keyId,
    };
    const signature = crypto.sign(null, Buffer.from(`${JSON.stringify(unsigned, null, 2)}\n`), privateKey).toString("base64");
    const signed = { ...unsigned, signature };
    const anchor = { ...signed, anchor_digest: crypto.createHash("sha256").update(`${JSON.stringify(signed, null, 2)}\n`).digest("hex") };
    previousAnchorDigest = anchor.anchor_digest;
    return anchor;
  });
  const base = { schema_version: 1, repository_digest: value.store.repositoryDigest, marker_digest: marker.marker_digest, anchors };
  return { lineage: { ...base, lineage_digest: crypto.createHash("sha256").update(`${JSON.stringify(base, null, 2)}\n`).digest("hex") }, publicKeyBytes, authority: { publicKey, privateKey } };
}

function rolloutContext(value, now) {
  const observations = generation.readRolloutObservations(value.store, { now }).observations;
  const seals = observations.map((observation) => {
    const name = `${String(observation.sequence).padStart(12, "0")}.json`;
    return JSON.parse(fs.readFileSync(path.join(value.store.paths.rolloutSeals, name), "utf8"));
  });
  const marker = generation.peekGeneration(value.store);
  return {
    observations,
    seals,
    checkpoints: observations.filter((item) => item.type === "daily_checkpoint"),
    marker,
    zeroLegacySince: marker.switched_at,
  };
}

test("canonical inventory starts drain or dual-read from real counts and tightens only after a fresh zero scan", () => {
  const value = rolloutFixture("start");
  legacyManifest(value, "issue-1142-20260701000000000-aaaaaaaa");
  const times = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z", "2026-07-02T00:00:00.002Z"];
  const started = startCanonical({
    store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "start-rollout", now: () => times.shift(),
  });
  assert.equal(started.inventory.active_legacy_run_count, 0);
  assert.equal(started.marker.writer_generation, "vnext");
  assert.equal(started.marker.legacy_read_allowed, false);
  assert.ok(generation.readRolloutObservations(value.store).observations.some((item) => item.type === "legacy_artifact_read"));

  const active = rolloutFixture("active");
  const activeRun = "issue-1142-20260701000000000-bbbbbbbb";
  legacyManifest(active, activeRun, "dispatched");
  const draining = startCanonical({ store: active.store, runsRoot: active.runsRoot, actor: "operator", operationId: "active", now: () => "2026-07-02T00:00:00.000Z" });
  assert.equal(draining.phase, "draining");
  assert.equal(draining.decision.active_legacy_run_count, 1);
  assert.equal(draining.marker.writer_generation, "legacy");
  setLegacyState(active, activeRun, "closed");
  const drainTimes = ["2026-07-02T00:00:00.001Z", "2026-07-02T00:00:00.002Z"];
  const drained = startCanonical({ store: active.store, runsRoot: active.runsRoot, actor: "operator", operationId: "active-finished", now: () => drainTimes.shift() });
  assert.equal(drained.phase, "vnext_only");
  assert.equal(drained.marker.legacy_read_allowed, false);

  const dual = rolloutFixture("dual");
  const dualRuns = [];
  for (let index = 0; index < 6; index += 1) {
    const runId = `issue-1142-2026070100000000${index}-d${String(index).repeat(7)}`;
    dualRuns.push(runId); legacyManifest(dual, runId, "dispatched");
  }
  const dualTimes = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z"];
  const dualStarted = startCanonical({ store: dual.store, runsRoot: dual.runsRoot, actor: "operator", operationId: "dual", now: () => dualTimes.shift() });
  assert.equal(dualStarted.phase, "dual_read_vnext_write");
  assert.equal(dualStarted.decision.active_legacy_run_count, 6);
  assert.equal(dualStarted.marker.writer_generation, "vnext");
  assert.equal(dualStarted.marker.legacy_read_allowed, true);
  for (const runId of dualRuns) setLegacyState(dual, runId, "closed");
  const preserved = byteTree(dual.repoRuns);
  const tightenTimes = ["2026-07-02T00:00:00.002Z", "2026-07-02T00:00:00.003Z"];
  const tightened = startCanonical({ store: dual.store, runsRoot: dual.runsRoot, actor: "operator", operationId: "dual-finished", now: () => tightenTimes.shift() });
  assert.equal(tightened.phase, "vnext_only");
  assert.equal(tightened.marker.legacy_read_allowed, false);
  assert.deepEqual(byteTree(dual.repoRuns), preserved, "cutover must preserve canonical historical run bytes");
  const orphan = rolloutFixture("orphan");
  fs.mkdirSync(path.join(orphan.repoRuns, "issue-1142-orphan"));
  assert.throws(
    () => startCanonical({ store: orphan.store, runsRoot: orphan.runsRoot, actor: "operator", operationId: "orphan" }),
    (error) => error.code === "ACTIVE_LEGACY_AMBIGUITY",
  );
  const empty = rolloutFixture("empty");
  assert.throws(
    () => generation.previewMigrationFromCanonicalInventory({ checkoutRoot: empty.root, remote: empty.repository.remote, runsRoot: empty.runsRoot }),
    (error) => error.code === "ACTIVE_LEGACY_AMBIGUITY" && /empty/.test(error.message),
  );
});

test("start revalidates canonical inventory under the generation lock immediately before cutover", () => {
  const value = rolloutFixture("cutover-race"), runId = "issue-1142-20260701000000000-34343434";
  legacyManifest(value, runId, "closed");
  const times = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z"];
  assert.throws(
    () => startCanonical({
      store: value.store,
      runsRoot: value.runsRoot,
      actor: "operator",
      operationId: "cutover-race",
      now: () => times.shift(),
      fault(stage) { if (stage === "after_final_inventory") setLegacyState(value, runId, "dispatched"); },
    }),
    (error) => error.code === "ACTIVE_LEGACY_AMBIGUITY" && /changed during/.test(error.message),
  );
  assert.equal(generation.peekGeneration(value.store).writer_generation, "legacy");
});

test("dual-read start retry repairs a marker published before its switch event", () => {
  const value = rolloutFixture("dual-read-event-crash");
  for (let index = 0; index < 6; index += 1) legacyManifest(value, `issue-1142-2026070100000000${index}-4${index}4${index}4${index}4${index}`, "dispatched");
  let crashed = false;
  assert.throws(
    () => startCanonical({
      store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "dual-read-event-crash",
      now: (() => { const values = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z"]; return () => values.shift(); })(),
      fault(stage, target) {
        if (!crashed && stage === "fsync" && target.includes("generation-events") && generation.peekGeneration(value.store)?.writer_generation === "vnext") {
          crashed = true; const error = new Error("switch event crash"); error.code = "EIO"; throw error;
        }
      },
    }),
    (error) => error.code === "EIO",
  );
  assert.equal(crashed, true);
  assert.equal(generation.peekGeneration(value.store).legacy_read_allowed, true);
  assert.equal(generation.readEvents(value.store).filter((event) => event.type === "generation_switched").length, 0);
  const resumed = startCanonical({ store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "dual-read-event-crash", now: () => "2026-07-02T00:00:00.002Z" });
  assert.equal(resumed.phase, "dual_read_vnext_write");
  assert.equal(generation.readEvents(value.store).filter((event) => event.type === "generation_switched").length, 1);
});

test("cutover revalidates the exact zero-active snapshot immediately before marker publication", () => {
  const value = rolloutFixture("cutover-marker-race"), runId = "issue-1142-20260701000000000-45454545";
  legacyManifest(value, runId, "closed");
  const times = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z"];
  assert.throws(
    () => startCanonical({
      store: value.store,
      runsRoot: value.runsRoot,
      actor: "operator",
      operationId: "cutover-marker-race",
      now: () => times.shift(),
      fault(stage) { if (stage === "before_cutover_marker") setLegacyState(value, runId, "dispatched"); },
    }),
    (error) => error.code === "ACTIVE_LEGACY_AMBIGUITY" && /cutover marker publication/.test(error.message),
  );
  assert.equal(generation.peekGeneration(value.store).writer_generation, "legacy");
  assert.equal(fs.existsSync(path.join(value.store.paths.transitions, "cutover-marker-race-switch.json")), false, "a failed volatile snapshot must not strand a durable transition intent");
  setLegacyState(value, runId, "closed");
  const retryTimes = ["2026-07-02T00:00:00.002Z", "2026-07-02T00:00:00.003Z", "2026-07-02T00:00:00.004Z"];
  const resumed = startCanonical({
    store: value.store,
    runsRoot: value.runsRoot,
    actor: "operator",
    operationId: "cutover-marker-race-retry",
    now: () => retryTimes.shift(),
  });
  assert.equal(resumed.phase, "vnext_only");
  assert.equal(generation.readEvents(value.store).filter((event) => event.type === "generation_switched").length, 1);
});

test("post-marker inventory drift restores legacy and append-only abort permits a freshly signed cutover", () => {
  const value = rolloutFixture("post-marker-race"), runId = "issue-1142-20260701000000000-34343434";
  legacyManifest(value, runId, "closed");
  const times = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z"];
  assert.throws(
    () => startCanonical({
      store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "post-marker-race", now: () => times.shift(),
      fault(stage) { if (stage === "after_cutover_marker") setLegacyState(value, runId, "dispatched"); },
    }),
    (error) => error.code === "ACTIVE_LEGACY_AMBIGUITY",
  );
  assert.equal(generation.peekGeneration(value.store).writer_generation, "legacy");
  assert.ok(fs.existsSync(path.join(value.store.paths.transitions, "post-marker-race-switch.json")));
  assert.ok(fs.existsSync(path.join(value.store.paths.transitionAborts, "post-marker-race-switch.json")));
  setLegacyState(value, runId, "closed");
  const retryTimes = ["2026-07-02T00:00:00.002Z", "2026-07-02T00:00:00.003Z"];
  const resumed = startCanonical({ store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "post-marker-race-retry", now: () => retryTimes.shift() });
  assert.equal(resumed.phase, "vnext_only");
  assert.equal(generation.readEvents(value.store).filter((event) => event.type === "generation_switched").length, 1);
});

test("a fresh signed operation supersedes an uncommitted receipt and resumes after the new receipt crash", () => {
  const value = rolloutFixture("pending-supersede"), runId = "issue-1142-20260701000000000-35353535";
  legacyManifest(value, runId, "closed");
  let firstCrash = false;
  assert.throws(
    () => startCanonical({
      store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "pending-old", now: (() => { const values = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z"]; return () => values.shift(); })(),
      fault(stage, target) { if (!firstCrash && stage === "dir_fsync" && target.includes("generation-transitions")) { firstCrash = true; const error = new Error("old receipt crash"); error.code = "EIO"; throw error; } },
    }),
    (error) => error.code === "EIO",
  );
  assert.equal(firstCrash, true);
  assert.equal(generation.peekGeneration(value.store).writer_generation, "legacy");
  setLegacyState(value, runId, "dispatched");
  setLegacyState(value, runId, "closed");

  let secondCrash = false;
  assert.throws(
    () => startCanonical({
      store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "pending-new", now: (() => { const values = ["2026-07-02T00:00:00.002Z", "2026-07-02T00:00:00.003Z"]; return () => values.shift(); })(),
      fault(stage, target) { if (!secondCrash && stage === "dir_fsync" && target.includes("generation-transitions")) { secondCrash = true; const error = new Error("new receipt crash"); error.code = "EIO"; throw error; } },
    }),
    (error) => error.code === "EIO",
  );
  assert.equal(secondCrash, true);
  const oldAbort = JSON.parse(fs.readFileSync(path.join(value.store.paths.transitionAborts, "pending-old-switch.json"), "utf8"));
  assert.equal(oldAbort.reason, "superseded_by_fresh_attestation");
  assert.equal(oldAbort.superseded_by_operation_id, "pending-new-switch");

  const resumed = startCanonical({
    store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "pending-new", now: (() => { const values = ["2026-07-02T00:00:00.004Z", "2026-07-02T00:00:00.005Z"]; return () => values.shift(); })(),
  });
  assert.equal(resumed.phase, "vnext_only");
  assert.equal(generation.readEvents(value.store).filter((event) => event.type === "generation_switched").length, 1);
});

test("rollback and fresh cutover scope checkpoints and terminal receipts to the active marker", () => {
  const value = rolloutFixture("epoch-scope");
  legacyManifest(value, "issue-1142-20260701000000000-37373737", "closed");
  startCanonical({ store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "epoch-one", now: (() => { const values = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z"]; return () => values.shift(); })() });
  vnextTerminalRun(value, 1, "2026-07-02T00:00:00.002Z");
  generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: "2026-07-03T00:00:00.000Z" });
  const firstMarker = generation.peekGeneration(value.store);
  generation.rollbackToLegacy({ store: value.store, runIds: ["run-1"], loadRunFacts: () => loadedRuns(), switchedAt: "2026-07-03T00:00:00.001Z", actor: "operator", operationId: "epoch-rollback" });
  startCanonical({ store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "epoch-two", now: (() => { const values = ["2026-07-03T00:00:00.002Z", "2026-07-03T00:00:00.003Z"]; return () => values.shift(); })() });
  const secondMarker = generation.peekGeneration(value.store);
  assert.notEqual(secondMarker.marker_digest, firstMarker.marker_digest);
  vnextTerminalRun(value, 2, "2026-07-03T00:00:00.004Z");
  generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: "2026-07-04T00:00:00.000Z" });
  const status = generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now: "2026-07-04T00:00:00.000Z" });
  assert.equal(status.vnext_terminal_run_count, 1);
  assert.equal(status.consecutive_zero_legacy_days, 1);
  assert.equal(status.checkpoint_current, true);
  const checkpoints = generation.readRolloutObservations(value.store, { now: "2026-07-04T00:00:00.000Z" }).observations.filter((item) => item.type === "daily_checkpoint");
  assert.deepEqual(checkpoints.map((item) => item.payload.marker_digest), [firstMarker.marker_digest, secondMarker.marker_digest]);
  assert.equal(fs.readdirSync(value.store.paths.terminalReceipts).length, 2, "historical epoch receipts remain immutable and independently validated");
  const historicalEventsPath = path.join(value.repoRuns, "issue-1142-00000000000000001-aaaaaaaa", "events.jsonl"), historicalBytes = fs.readFileSync(historicalEventsPath);
  const historicalFact = JSON.parse(historicalBytes.toString("utf8"));
  fs.writeFileSync(historicalEventsPath, `${JSON.stringify({ ...historicalFact, payload: { ...historicalFact.payload, reason: "tampered" } })}\n`);
  assert.throws(() => generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now: "2026-07-04T00:00:00.000Z" }), (error) => error.code === "INVALID_TERMINAL_RECEIPT");
  fs.writeFileSync(historicalEventsPath, historicalBytes);
  fs.unlinkSync(historicalEventsPath);
  assert.throws(() => generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now: "2026-07-04T00:00:00.000Z" }), (error) => new Set(["INVALID_TERMINAL_RECEIPT", "VNEXT_TERMINAL_AMBIGUITY"]).has(error.code));
});

test("operator start dry-run derives canonical inventory with zero durable writes and mutation requires explicit audit identity", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-rollout-dry-run-")));
  execFileSync("git", ["init", "-q", root]);
  const runsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-rollout-dry-runs-")));
  const base = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const repoRuns = path.join(runsRoot, `${base}-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 8)}`);
  fs.mkdirSync(repoRuns);
  legacyManifest({ repoRuns }, "issue-1142-20260701000000000-12121212");
  const before = byteTree(root), beforeRuns = byteTree(runsRoot), cli = path.resolve(__dirname, "../../../skills/relay-dispatch/scripts/runtime-generation.js");
  const dry = spawnSync(process.execPath, [cli, "start", "--repo", root, "--dry-run", "--actor", "test-operator", "--operation-id", "dry-run-followup", "--quiescence-reason", "operator confirms historical writers stopped", "--json"], {
    encoding: "utf8", env: { ...process.env, RELAY_RUNS_BASE: runsRoot },
  });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).can_start, true);
  assert.equal(JSON.parse(dry.stdout).quiescence_request.operation_id, "dry-run-followup-switch");
  assert.deepEqual(byteTree(root), before);
  assert.deepEqual(byteTree(runsRoot), beforeRuns);
  assert.equal(fs.existsSync(path.join(root, ".git", "relay-runtime-vnext")), false);

  const unsafe = spawnSync(process.execPath, [cli, "start", "--repo", root, "--json"], {
    encoding: "utf8", env: { ...process.env, RELAY_RUNS_BASE: runsRoot },
  });
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /explicit --actor, --operation-id, and --quiescence-reason/);
  assert.equal(fs.existsSync(path.join(root, ".git", "relay-runtime-vnext")), false);

  const cliStore = generation.initializeStore({ checkoutRoot: root, remote: `local/${path.basename(root)}` });
  const cliAuthority = authorityFor({ store: cliStore, runsRoot, actor: "test-operator", operationId: "dry-run-followup", quiescenceReason: "operator confirms historical writers stopped" });
  const start = spawnSync(process.execPath, [cli, "start", "--repo", root, "--actor", "test-operator", "--operation-id", "dry-run-followup", "--quiescence-reason", "operator confirms historical writers stopped", "--json"], {
    encoding: "utf8", env: { ...process.env, RELAY_RUNS_BASE: runsRoot, RELAY_QUIESCENCE_ATTESTATION_FILE: cliAuthority.attestationPath, RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE: cliAuthority.keyPath, RELAY_TEST_EXTERNAL_AUTHORITY: "1", NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${authorityPreload}`.trim() },
  });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(JSON.parse(start.stdout).marker.writer_generation, "vnext");
  const beforeStatus = byteTree(root), beforeStatusRuns = byteTree(runsRoot);
  const status = spawnSync(process.execPath, [cli, "status", "--repo", root, "--json"], {
    encoding: "utf8", env: { ...process.env, RELAY_RUNS_BASE: runsRoot },
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).retire_ready, false);
  assert.deepEqual(byteTree(root), beforeStatus, "status must not mutate the generation store");
  assert.deepEqual(byteTree(runsRoot), beforeStatusRuns, "status must not mutate canonical run bytes");
});

test("external authority rejects same-UID ownership and descriptor identity replacement", () => {
  const value = rolloutFixture("authority-path");
  legacyManifest(value, "issue-1142-20260701000000000-36363636", "closed");
  const options = { store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "authority-path", quiescenceReason: "authority path is externally controlled" };
  const authority = authorityFor(options);
  const priorAttestation = process.env.RELAY_QUIESCENCE_ATTESTATION_FILE, priorKey = process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE;
  const originalAccess = fs.accessSync, originalGeteuid = process.geteuid, originalOpen = fs.openSync, originalFstat = fs.fstatSync;
  process.env.RELAY_QUIESCENCE_ATTESTATION_FILE = authority.attestationPath;
  process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE = authority.keyPath;
  fs.accessSync = (target, mode) => {
    if (mode === fs.constants.W_OK) { const error = new Error("test authority is non-writable"); error.code = "EACCES"; throw error; }
    return originalAccess(target, mode);
  };
  try {
    assert.throws(
      () => generation.startMigrationFromCanonicalInventory({ ...options, now: (() => { const values = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z"]; return () => values.shift(); })() }),
      (error) => error.code === "ROLLOUT_ANCHOR_UNAVAILABLE" && /different OS identity/.test(error.message),
    );

    const tracked = new Set();
    process.geteuid = () => 99999;
    fs.openSync = (target, ...args) => {
      const fd = originalOpen(target, ...args);
      if (target === authority.attestationPath) tracked.add(fd);
      return fd;
    };
    const counts = new Map();
    fs.fstatSync = (fd, ...args) => {
      const stat = originalFstat(fd, ...args);
      if (!tracked.has(fd)) return stat;
      const count = (counts.get(fd) || 0) + 1;
      counts.set(fd, count);
      return count < 2 ? stat : { dev: stat.dev, ino: stat.ino + 1, size: stat.size, isFile: () => true };
    };
    assert.throws(
      () => generation.startMigrationFromCanonicalInventory({ ...options, now: (() => { const values = ["2026-07-02T00:00:00.002Z", "2026-07-02T00:00:00.003Z"]; return () => values.shift(); })() }),
      (error) => error.code === "UNTRUSTED_GENERATION_ARTIFACT" && /changed while being read/.test(error.message),
    );
  } finally {
    fs.accessSync = originalAccess; fs.openSync = originalOpen; fs.fstatSync = originalFstat; process.geteuid = originalGeteuid;
    if (priorAttestation === undefined) delete process.env.RELAY_QUIESCENCE_ATTESTATION_FILE; else process.env.RELAY_QUIESCENCE_ATTESTATION_FILE = priorAttestation;
    if (priorKey === undefined) delete process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE; else process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE = priorKey;
  }
});

test("daily authority lineage advances as a verified prefix and emits the next exact request", () => {
  const value = rolloutFixture("incremental-lineage");
  legacyManifest(value, "issue-1142-20260701000000000-38383838", "closed");
  startCanonical({ store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "incremental-lineage", now: (() => { const values = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z"]; return () => values.shift(); })() });
  generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: "2026-07-03T00:00:00.000Z" });
  const dayOne = signedRolloutLineage(value), authorityDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-daily-authority-")));
  const lineagePath = path.join(authorityDir, "lineage.json"), keyPath = path.join(authorityDir, "public.pem");
  fs.writeFileSync(lineagePath, `${JSON.stringify(dayOne.lineage, null, 2)}\n`, { mode: 0o400 }); fs.writeFileSync(keyPath, dayOne.publicKeyBytes, { mode: 0o400 });
  generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: "2026-07-04T00:00:00.000Z" });
  const priorAnchor = dayOne.lineage.anchors[0], priorAnchorFile = process.env.RELAY_ROLLOUT_ANCHOR_FILE, priorKeyFile = process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE;
  const originalGeteuid = process.geteuid, originalAccess = fs.accessSync;
  delete process.env.RELAY_ROLLOUT_ANCHOR_FILE; delete process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE;
  const missingPrefix = generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now: "2026-07-04T00:00:00.001Z" });
  assert.equal(missingPrefix.external_attestation.anchor_request, null);
  assert.equal(missingPrefix.external_attestation.pending_reason, "daily_signature_prefix_missing");
  process.env.RELAY_ROLLOUT_ANCHOR_FILE = lineagePath; process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE = keyPath;
  process.geteuid = () => 99999;
  fs.accessSync = (target, mode) => { if (mode === fs.constants.W_OK) { const error = new Error("external authority is non-writable"); error.code = "EACCES"; throw error; } return originalAccess(target, mode); };
  try {
    const dayTwoPending = generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now: "2026-07-04T00:00:00.001Z" });
    assert.equal(dayTwoPending.external_attestation.status, "pending");
    assert.equal(dayTwoPending.external_attestation.anchor_request.previous_anchor_digest, priorAnchor.anchor_digest);
    assert.equal(dayTwoPending.external_attestation.anchor_request.checkpoint_date, "2026-07-04");
    const dayTwo = signedRolloutLineage(value, (observation) => observation.occurred_at, dayOne.authority);
    fs.chmodSync(lineagePath, 0o600); fs.writeFileSync(lineagePath, `${JSON.stringify(dayTwo.lineage, null, 2)}\n`); fs.chmodSync(lineagePath, 0o400);
    const caughtUp = generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now: "2026-07-04T00:00:00.001Z" });
    assert.equal(caughtUp.external_attestation.status, "pending");
    assert.equal(caughtUp.external_attestation.pending_reason, "signed_lineage_below_30_days");
    assert.equal(caughtUp.external_attestation.anchor_request, null);
  } finally {
    process.geteuid = originalGeteuid; fs.accessSync = originalAccess;
    if (priorAnchorFile === undefined) delete process.env.RELAY_ROLLOUT_ANCHOR_FILE; else process.env.RELAY_ROLLOUT_ANCHOR_FILE = priorAnchorFile;
    if (priorKeyFile === undefined) delete process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE; else process.env.RELAY_ROLLOUT_ANCHOR_PUBLIC_KEY_FILE = priorKeyFile;
  }
  generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: "2026-07-05T00:00:00.000Z" });
  const dayThree = signedRolloutLineage(value, (observation) => observation.occurred_at, dayOne.authority), missingMiddleBase = { ...dayThree.lineage, anchors: [dayThree.lineage.anchors[0], dayThree.lineage.anchors[2]] };
  const missingMiddle = { ...missingMiddleBase, lineage_digest: crypto.createHash("sha256").update(`${JSON.stringify({ schema_version: missingMiddleBase.schema_version, repository_digest: missingMiddleBase.repository_digest, marker_digest: missingMiddleBase.marker_digest, anchors: missingMiddleBase.anchors }, null, 2)}\n`).digest("hex") };
  assert.throws(() => generation.verifyRolloutAnchor(missingMiddle, dayThree.publicKeyBytes, value.store, rolloutContext(value, "2026-07-05T00:00:00.001Z"), "2026-07-05T00:00:00.001Z"), (error) => error.code === "ROLLOUT_ANCHOR_GAP");
});

test("rollout status independently verifies the 30-day and 30-terminal retirement gate", () => {
  const value = rolloutFixture("gate");
  legacyManifest(value, "issue-1142-20260701000000000-cccccccc");
  const startTimes = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z", "2026-07-02T00:00:00.002Z"];
  startCanonical({ store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "start-gate", now: () => startTimes.shift() });
  for (let index = 1; index <= 30; index += 1) vnextTerminalRun(value, index, "2026-07-02T00:00:00.003Z");
  for (let day = 0; day < 30; day += 1) {
    const at = new Date(Date.UTC(2026, 6, 2 + day, 0, 0, 0, day === 0 ? 4 : 0)).toISOString();
    generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: at });
  }
  const prematureNow = new Date(Date.UTC(2026, 6, 31, 0, 0, 0, 0)).toISOString();
  const premature = generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now: prematureNow });
  assert.equal(premature.consecutive_zero_legacy_days, 30);
  assert.equal(premature.local_gate_satisfied, false, "D0 through D29 is less than 30 elapsed days");
  assert.ok(premature.blockers.includes("zero_legacy_elapsed_below_30_days"));
  const now = new Date(Date.UTC(2026, 7, 1, 0, 0, 0, 5)).toISOString();
  generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: now });
  const observations = generation.readRolloutObservations(value.store, { now }).observations;
  const missingAnchor = generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now });
  assert.equal(missingAnchor.local_gate_satisfied, true);
  assert.ok(missingAnchor.zero_legacy_elapsed_hours >= 30 * 24);
  assert.equal(missingAnchor.retire_ready, false);
  assert.ok(missingAnchor.blockers.includes("external_anchor_missing"));
  assert.equal(missingAnchor.external_attestation.anchor_request, null);
  assert.equal(missingAnchor.external_attestation.pending_reason, "daily_signature_prefix_missing");
  const signed = signedRolloutLineage(value);
  const attestation = generation.verifyRolloutAnchor(signed.lineage, signed.publicKeyBytes, value.store, rolloutContext(value, now), now);
  const firstCheckpoint = observations.find((item) => item.type === "daily_checkpoint");
  assert.equal(firstCheckpoint.payload.legacy_activity_count, 0, "baseline audit reads before cutover do not poison day one");
  assert.equal(attestation.required, true);
  assert.equal(attestation.status, "verified");
  const tampered = structuredClone(signed.lineage);
  tampered.anchors[0].observation_digest = "f".repeat(64);
  assert.throws(
    () => generation.verifyRolloutAnchor(tampered, signed.publicKeyBytes, value.store, rolloutContext(value, now), now),
    (error) => error.code === "INVALID_ROLLOUT_ANCHOR",
  );
  const latestOnlyBase = { ...signed.lineage, anchors: [signed.lineage.anchors.at(-1)] };
  const latestOnly = { ...latestOnlyBase, lineage_digest: crypto.createHash("sha256").update(`${JSON.stringify({ schema_version: latestOnlyBase.schema_version, repository_digest: latestOnlyBase.repository_digest, marker_digest: latestOnlyBase.marker_digest, anchors: latestOnlyBase.anchors }, null, 2)}\n`).digest("hex") };
  assert.throws(
    () => generation.verifyRolloutAnchor(latestOnly, signed.publicKeyBytes, value.store, rolloutContext(value, now), now),
    (error) => error.code === "ROLLOUT_ANCHOR_GAP",
  );
  const authorityNow = Date.parse(now), checkpointCount = observations.filter((item) => item.type === "daily_checkpoint").length;
  const backdated = signedRolloutLineage(value, (_observation, index) => new Date(authorityNow - (checkpointCount - index) * 1_000).toISOString());
  assert.throws(
    () => generation.verifyRolloutAnchor(backdated.lineage, backdated.publicKeyBytes, value.store, rolloutContext(value, now), now),
    (error) => error.code === "ROLLOUT_ANCHOR_TIME_INVALID",
  );
  assert.throws(
    () => generation.verifyRolloutAnchor({ ...signed.lineage, repository_digest: "e".repeat(64) }, signed.publicKeyBytes, value.store, rolloutContext(value, now), now),
    (error) => error.code === "REPOSITORY_IDENTITY_MISMATCH",
  );
  fs.unlinkSync(path.join(value.store.paths.terminalReceipts, "issue-1142-00000000000000001-aaaaaaaa.json"));
  assert.throws(
    () => generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now }),
    (error) => error.code === "TERMINAL_RECEIPT_MISSING",
  );
});

test("a newly terminal run is a checkpoint-pending blocker, not ledger corruption", () => {
  const value = rolloutFixture("pending-terminal");
  legacyManifest(value, "issue-1142-20260701000000000-abababab");
  const times = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z", "2026-07-02T00:00:00.002Z"];
  startCanonical({ store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "pending-start", now: () => times.shift() });
  vnextTerminalRun(value, 99, "2026-07-02T00:00:00.003Z");
  const status = generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now: "2026-07-03T00:00:00.000Z" });
  assert.deepEqual(status.pending_terminal_runs, ["issue-1142-00000000000000099-aaaaaaaa"]);
  assert.ok(status.blockers.includes("terminal_receipt_pending"));
  assert.equal(status.retire_ready, false);
});

test("checkpoint retry repairs receipt/observation publication crashes without duplicate terminal evidence", () => {
  for (const crashAt of ["observation", "seal"]) {
    const value = rolloutFixture(`terminal-crash-${crashAt}`);
    legacyManifest(value, `issue-1142-20260701000000000-${crashAt === "seal" ? "51515151" : "41414141"}`);
    const times = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z", "2026-07-02T00:00:00.002Z"];
    startCanonical({ store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: `terminal-crash-${crashAt}`, now: () => times.shift() });
    vnextTerminalRun(value, crashAt === "seal" ? 52 : 42, "2026-07-02T00:00:00.003Z");
    const originalLink = fs.linkSync;
    let injected = false;
    fs.linkSync = (source, target) => {
      const selectedDirectory = crashAt === "seal" ? value.store.paths.rolloutSeals : value.store.paths.rollout;
      if (!injected && target.startsWith(`${selectedDirectory}${path.sep}`) && fs.readdirSync(value.store.paths.terminalReceipts).length === 1) {
        injected = true;
        const error = new Error(`injected ${crashAt} publication crash`); error.code = "EIO"; throw error;
      }
      return originalLink(source, target);
    };
    try {
      assert.throws(
        () => generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: "2026-07-03T00:00:00.000Z" }),
        (error) => error.code === "EIO",
      );
    } finally { fs.linkSync = originalLink; }
    assert.equal(injected, true);
    generation.recordLegacySurfaceInvocation({ store: value.store, command: "recover-state", mode: "recover", invocationId: `after-${crashAt}-crash`, observedAt: "2026-07-03T00:00:00.001Z" });
    generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: "2026-07-03T00:00:00.002Z" });
    const observations = generation.readRolloutObservations(value.store, { now: "2026-07-03T00:00:00.002Z" }).observations;
    assert.equal(observations.filter((item) => item.type === "vnext_terminal_observed").length, 1);
    assert.equal(observations.filter((item) => item.type === "daily_checkpoint").length, 1);
    assert.equal(observations.filter((item) => item.type === "legacy_surface_invoked").length, 1);
    assert.equal(fs.readdirSync(value.store.paths.terminalReceipts).length, 1);
  }
});

test("terminal receipt digest is canonical across runs observed in non-lexicographic order", () => {
  const value = rolloutFixture("terminal-order");
  legacyManifest(value, "issue-1142-20260701000000000-61616161");
  const times = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z", "2026-07-02T00:00:00.002Z"];
  startCanonical({ store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "terminal-order", now: () => times.shift() });
  vnextTerminalRun(value, 99, "2026-07-02T00:00:00.003Z");
  generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: "2026-07-03T00:00:00.000Z" });
  vnextTerminalRun(value, 1, "2026-07-03T00:00:00.001Z");
  generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: "2026-07-04T00:00:00.000Z" });
  const observations = generation.readRolloutObservations(value.store, { now: "2026-07-04T00:00:00.000Z" }).observations;
  assert.deepEqual(observations.filter((item) => item.type === "vnext_terminal_observed").map((item) => item.payload.run_id), [
    "issue-1142-00000000000000099-aaaaaaaa",
    "issue-1142-00000000000000001-aaaaaaaa",
  ]);
  const status = generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now: "2026-07-04T00:00:00.000Z" });
  assert.equal(status.vnext_terminal_run_count, 2);
  assert.equal(status.checkpoint_current, true);
});

test("persisted terminal receipts reject every field tamper, extra keys, and non-canonical bytes", () => {
  const value = rolloutFixture("terminal-tamper");
  legacyManifest(value, "issue-1142-20260701000000000-62626262");
  const times = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z", "2026-07-02T00:00:00.002Z"];
  startCanonical({ store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "terminal-tamper", now: () => times.shift() });
  vnextTerminalRun(value, 77, "2026-07-02T00:00:00.003Z");
  const now = "2026-07-03T00:00:00.000Z";
  generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: now });
  const target = path.join(value.store.paths.terminalReceipts, "issue-1142-00000000000000077-aaaaaaaa.json");
  const originalBytes = fs.readFileSync(target), original = JSON.parse(originalBytes);
  const mutations = {
    schema_version: 2,
    repository_digest: "f".repeat(64),
    marker_digest: "e".repeat(64),
    epoch: original.epoch + 1,
    run_id: `${original.run_id}-tampered`,
    run_digest: "d".repeat(64),
    terminal_event_id: "tampered-terminal-event",
    terminal_type: original.terminal_type === "run_closed" ? "merge_recorded" : "run_closed",
    terminal_at: "2026-07-02T00:00:00.004Z",
    terminal_fact_digest: "c".repeat(64),
    observed_at: "2026-07-02T23:59:59.999Z",
    receipt_digest: "b".repeat(64),
  };
  for (const [field, changed] of Object.entries(mutations)) {
    fs.writeFileSync(target, `${JSON.stringify({ ...original, [field]: changed }, null, 2)}\n`);
    assert.throws(
      () => generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now }),
      (error) => new Set(["INVALID_TERMINAL_RECEIPT", "INVALID_GENERATION_ARTIFACT"]).has(error.code),
      field,
    );
    fs.writeFileSync(target, originalBytes);
  }
  fs.writeFileSync(target, `${JSON.stringify({ ...original, unexpected: true }, null, 2)}\n`);
  assert.throws(() => generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now }), (error) => error.code === "INVALID_TERMINAL_RECEIPT");
  fs.writeFileSync(target, JSON.stringify(original));
  assert.throws(() => generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now }), (error) => error.code === "INVALID_TERMINAL_RECEIPT" && /canonical JSON/.test(error.message));
  fs.writeFileSync(target, originalBytes);
  assert.equal(generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now }).vnext_terminal_run_count, 1);
});

test("external signed root rejects observation, seal, and mutable-head triple rewind", () => {
  const value = rolloutFixture("triple-rewind");
  legacyManifest(value, "issue-1142-20260701000000000-71717171");
  const times = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z", "2026-07-02T00:00:00.002Z"];
  startCanonical({ store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "triple-rewind", now: () => times.shift() });
  generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: "2026-07-03T00:00:00.000Z" });
  generation.recordLegacySurfaceInvocation({ store: value.store, command: "recover-state", mode: "recover", invocationId: "triple-rewind-tail", observedAt: "2026-07-03T00:00:00.001Z" });
  generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: "2026-07-04T00:00:00.000Z" });
  const observations = generation.readRolloutObservations(value.store, { now: "2026-07-04T00:00:00.001Z" }).observations;
  const tail = observations.at(-1), prior = observations.at(-2);
  const signed = signedRolloutLineage(value);
  const priorName = `${String(prior.sequence).padStart(12, "0")}.json`;
  const priorSeal = JSON.parse(fs.readFileSync(path.join(value.store.paths.rolloutSeals, priorName), "utf8"));
  fs.unlinkSync(path.join(value.store.paths.rollout, `${String(tail.sequence).padStart(12, "0")}.json`));
  fs.unlinkSync(path.join(value.store.paths.rolloutSeals, `${String(tail.sequence).padStart(12, "0")}.json`));
  fs.writeFileSync(value.store.paths.rolloutHead, `${JSON.stringify({ schema_version: 1, repository_digest: value.store.repositoryDigest, sequence: prior.sequence, observation_digest: prior.observation_digest, seal_digest: priorSeal.seal_digest }, null, 2)}\n`);
  assert.equal(generation.readRolloutObservations(value.store, { now: "2026-07-04T00:00:00.002Z" }).observations.at(-1).type, "legacy_surface_invoked", "local files alone cannot distinguish a coordinated rewind");
  assert.throws(
    () => generation.verifyRolloutAnchor(signed.lineage, signed.publicKeyBytes, value.store, rolloutContext(value, "2026-07-04T00:00:00.002Z"), "2026-07-04T00:00:00.002Z"),
    (error) => new Set(["ROLLOUT_ANCHOR_STALE", "ROLLOUT_ANCHOR_GAP"]).has(error.code),
  );
});

test("production status rejects direct anchor injection even when NODE_TEST_CONTEXT is spoofed", () => {
  const value = rolloutFixture("anchor-api");
  legacyManifest(value, "issue-1142-20260701000000000-81818181");
  const times = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z", "2026-07-02T00:00:00.002Z"];
  startCanonical({ store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "anchor-api", now: () => times.shift() });
  generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: "2026-07-03T00:00:00.000Z" });
  const latest = generation.readRolloutObservations(value.store, { now: "2026-07-03T00:00:00.001Z" }).observations.at(-1);
  const signed = signedRolloutLineage(value);
  const testContext = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = "spoofed-by-caller";
  try {
    assert.throws(
      () => generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now: "2026-07-03T00:00:00.002Z", externalAnchor: signed.lineage, anchorPublicKey: signed.publicKeyBytes }),
      (error) => error.code === "ROLLOUT_ANCHOR_UNAVAILABLE" && /not a production API/.test(error.message),
    );
  } finally {
    if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = testContext;
  }
  const childSpoof = spawnSync(process.execPath, [worker, "status-direct-anchor", value.root, value.repository.remote, JSON.stringify({ runsRoot: value.runsRoot })], {
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: "spoofed-by-fresh-child" },
  });
  assert.equal(childSpoof.status, 1);
  assert.match(childSpoof.stderr, /ROLLOUT_ANCHOR_UNAVAILABLE/);

  for (const { type, options } of [
    { type: "rsa", options: { modulusLength: 2048 } },
    { type: "ec", options: { namedCurve: "prime256v1" } },
  ]) {
    const foreign = crypto.generateKeyPairSync(type, options).publicKey.export({ type: "spki", format: "pem" });
    assert.throws(
      () => generation.verifyRolloutAnchor(signed.lineage, foreign, value.store, rolloutContext(value, "2026-07-03T00:00:00.002Z"), "2026-07-03T00:00:00.002Z"),
      (error) => error.code === "INVALID_ROLLOUT_ANCHOR" && /Ed25519/.test(error.message),
    );
  }
});

test("status rejects observation deletion, sequence reordering, future timestamps, checkpoint gaps, and marker drift", () => {
  const deleted = rolloutFixture("deleted");
  legacyManifest(deleted, "issue-1142-20260701000000000-dddddddd");
  const times = ["2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.001Z", "2026-08-01T00:00:00.002Z"];
  startCanonical({ store: deleted.store, runsRoot: deleted.runsRoot, actor: "operator", operationId: "start-deleted", now: () => times.shift() });
  fs.unlinkSync(path.join(deleted.store.paths.rollout, "000000000001.json"));
  assert.throws(() => generation.readRolloutObservations(deleted.store), (error) => error.code === "ROLLOUT_SEQUENCE_GAP");

  const reordered = rolloutFixture("reordered");
  generation.recordLegacySurfaceInvocation({ store: reordered.store, command: "recover-state", mode: "recover", observedAt: "2026-08-01T00:00:00.000Z" });
  generation.recordLegacySurfaceInvocation({ store: reordered.store, command: "publish-run", mode: "recover", observedAt: "2026-08-01T00:00:00.001Z" });
  const onePath = path.join(reordered.store.paths.rollout, "000000000001.json"), twoPath = path.join(reordered.store.paths.rollout, "000000000002.json");
  const one = fs.readFileSync(onePath), two = fs.readFileSync(twoPath);
  fs.writeFileSync(onePath, two); fs.writeFileSync(twoPath, one);
  assert.throws(() => generation.readRolloutObservations(reordered.store), (error) => error.code === "ROLLOUT_SEQUENCE_BROKEN");

  const source = rolloutFixture("cross-source"), target = rolloutFixture("cross-target");
  generation.recordLegacySurfaceInvocation({ store: source.store, command: "reconcile-run", mode: "inspect", observedAt: "2026-08-01T00:00:00.000Z" });
  fs.copyFileSync(path.join(source.store.paths.rollout, "000000000001.json"), path.join(target.store.paths.rollout, "000000000001.json"));
  fs.copyFileSync(source.store.paths.rolloutHead, target.store.paths.rolloutHead);
  assert.throws(() => generation.readRolloutObservations(target.store), (error) => error.code === "REPOSITORY_IDENTITY_MISMATCH");

  const future = rolloutFixture("future");
  generation.recordLegacySurfaceInvocation({ store: future.store, command: "recover-state", mode: "recover", observedAt: "2099-01-01T00:00:00.000Z" });
  assert.throws(
    () => generation.readRolloutObservations(future.store, { now: "2026-08-02T00:00:00.000Z" }),
    (error) => error.code === "ROLLOUT_FUTURE_TIMESTAMP",
  );

  const gap = rolloutFixture("gap");
  legacyManifest(gap, "issue-1142-20260701000000000-eeeeeeee");
  const gapTimes = ["2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.001Z", "2026-07-01T00:00:00.002Z"];
  startCanonical({ store: gap.store, runsRoot: gap.runsRoot, actor: "operator", operationId: "start-gap", now: () => gapTimes.shift() });
  generation.recordRolloutCheckpoint({ store: gap.store, runsRoot: gap.runsRoot, observedAt: "2026-07-02T00:00:00.000Z" });
  assert.throws(
    () => generation.recordRolloutCheckpoint({ store: gap.store, runsRoot: gap.runsRoot, observedAt: "2026-07-04T00:00:00.000Z" }),
    (error) => error.code === "ROLLOUT_CHECKPOINT_GAP",
  );
  generation.rollbackToLegacy({ store: gap.store, runIds: ["run-1"], loadRunFacts: () => loadedRuns(), switchedAt: "2026-07-02T00:00:00.001Z", actor: "operator", operationId: "marker-rollback" });
  const drain = generation.readDrainCompleted(gap.store);
  generation.switchGeneration({ store: gap.store, generation: "vnext", actor: "operator", operationId: "marker-reswitch", switchedAt: "2026-07-02T00:00:00.002Z", drainInventoryDigest: drain.inventory_digest });
  const rescoped = generation.retirementStatus({ store: gap.store, runsRoot: gap.runsRoot, now: "2026-07-02T00:00:00.003Z" });
  assert.equal(rescoped.consecutive_zero_legacy_days, 0);
  assert.equal(rescoped.checkpoint_current, false);
});

test("checkpoint and status audit sealed legacy bytes even when size and mtime are preserved", () => {
  const value = rolloutFixture("content-drift"), runId = "issue-1142-20260701000000000-ffffffff";
  legacyManifest(value, runId, "closed");
  const manifest = path.join(value.repoRuns, `${runId}.md`), fixed = new Date("2026-07-01T12:00:00.000Z");
  fs.utimesSync(manifest, fixed, fixed);
  const times = ["2026-07-02T00:00:00.000Z", "2026-07-02T00:00:00.001Z", "2026-07-02T00:00:00.002Z"];
  startCanonical({ store: value.store, runsRoot: value.runsRoot, actor: "operator", operationId: "content-start", now: () => times.shift() });
  generation.recordRolloutCheckpoint({ store: value.store, runsRoot: value.runsRoot, observedAt: "2026-07-03T00:00:00.000Z" });
  const before = fs.readFileSync(manifest, "utf8"), changed = before.replace("state: 'closed'", "state: 'merged'");
  assert.equal(Buffer.byteLength(before), Buffer.byteLength(changed));
  fs.writeFileSync(manifest, changed); fs.utimesSync(manifest, fixed, fixed);
  assert.throws(
    () => generation.retirementStatus({ store: value.store, runsRoot: value.runsRoot, now: "2026-07-03T00:00:00.000Z" }),
    (error) => error.code === "ACTIVE_LEGACY_AMBIGUITY" && /content drifted/.test(error.message),
  );
});
