const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("node:child_process");

const {
  createRunRecord,
  freezeDoneCriteria,
  hashDoneCriteria,
  readRunRecord,
  validateRunRecord,
} = require("../../../skills/relay-dispatch/scripts/run-store");
const store = require("../../../skills/relay-dispatch/scripts/run-store");
const facts = require("../../../skills/relay-dispatch/scripts/facts");
const host = require("../../../skills/relay-dispatch/scripts/host");
const runtime = { ...facts, withRunLock: host.withRunLock };

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

test("artifact reader binds the no-follow open to the caller's expected inode", () => {
  const runDir = tempDir("artifact-identity");
  const artifact = path.join(runDir, "artifact.json");
  const replacement = path.join(runDir, "replacement.json");
  fs.writeFileSync(artifact, "same bytes\n");
  const identity = fs.lstatSync(artifact, { bigint: true });
  assert.equal(store.readArtifact(artifact, "artifact", {
    expectedIdentity: { dev: identity.dev, ino: identity.ino },
  }).bytes.toString("utf8"), "same bytes\n");
  fs.writeFileSync(replacement, "same bytes\n");
  fs.renameSync(replacement, artifact);
  assert.throws(
    () => store.readArtifact(artifact, "artifact", {
      expectedIdentity: { dev: identity.dev, ino: identity.ino },
    }),
    (error) => error.code === "UNTRUSTED_RUN_ARTIFACT" && /changed identity before/.test(error.message),
  );
  const actualDev = (2n ** 53n) + 4n;
  const expectedDev = actualDev + 1n;
  assert.equal(Number(actualDev), Number(expectedDev));
  const currentIdentity = fs.lstatSync(artifact, { bigint: true });
  const originalFstatSync = fs.fstatSync;
  fs.fstatSync = (fd, options) => {
    const stat = originalFstatSync(fd, options);
    return { ...stat, dev: actualDev, isFile: () => true };
  };
  try {
    assert.throws(
      () => store.readArtifact(artifact, "artifact", {
        expectedIdentity: { dev: expectedDev, ino: currentIdentity.ino },
      }),
      (error) => error.code === "UNTRUSTED_RUN_ARTIFACT" && /changed identity before/.test(error.message),
    );
  } finally {
    fs.fstatSync = originalFstatSync;
  }
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

test("run reader rejects a FIFO without blocking", () => {
  const runDir = tempDir("run-fifo");
  fs.writeFileSync(path.join(runDir, "done-criteria.md"), "criterion\n");
  const value = record(runDir, {
    contract: {
      done_criteria_path: path.join(runDir, "done-criteria.md"),
      done_criteria_sha256: crypto.createHash("sha256").update("criterion\n").digest("hex"),
    },
  });
  createRunRecord({ runDir, record: value });
  const runPath = path.join(runDir, "run.json");
  fs.unlinkSync(runPath);
  execFileSync("mkfifo", [runPath]);
  const started = Date.now();
  assert.throws(() => readRunRecord({ runDir }), /regular non-symlink/);
  assert.ok(Date.now() - started < 1000, "FIFO rejection must not wait for a writer");
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

test("reviewer process-group reap still runs when the scope audit throws and both audit errors aggregate", () => {
  const runDir = tempDir("review-audit-failure"), criteriaPath = path.join(runDir, "done-criteria.md"), criteria = "criterion\n";
  fs.writeFileSync(criteriaPath, criteria, { mode: 0o600 });
  createRunRecord({ runDir, record: record(runDir, { contract: { done_criteria_path: criteriaPath, done_criteria_sha256: crypto.createHash("sha256").update(criteria).digest("hex") } }) });
  const diffPath = path.join(runDir, "diff.patch"), promptPath = path.join(runDir, "prompt.md");
  fs.writeFileSync(diffPath, "diff\n", { mode: 0o600 }); fs.writeFileSync(promptPath, "prompt\n", { mode: 0o600 });
  const request = { diff_path: diffPath, prompt_path: promptPath, done_criteria_path: criteriaPath, reviewed_sha: "a".repeat(40), current_sha: "a".repeat(40),
    diff_sha256: crypto.createHash("sha256").update("diff\n").digest("hex"), prompt_sha256: crypto.createHash("sha256").update("prompt\n").digest("hex") };
  const originalMkdtemp = fs.mkdtempSync; let stage;
  fs.mkdtempSync = function captureStage(prefix, ...args) { const value = originalMkdtemp.call(this, prefix, ...args); if (String(prefix).includes("relay-review-")) stage = value; return value; };
  const realAudit = host.hostInvocation.auditProcessScope, realReap = host.hostInvocation.reapProcessGroup;
  const reaped = []; let escapedPid;
  host.hostInvocation.auditProcessScope = () => { const error = new Error("scope audit timed out"); error.code = "HOST_IDENTITY_UNAVAILABLE"; throw error; };
  host.hostInvocation.reapProcessGroup = (pgid, seal) => {
    reaped.push({ pgid, seal });
    const resultPath = path.join(stage, "inputs", "output", "reviewer-result.json");
    if (fs.existsSync(resultPath)) escapedPid = JSON.parse(fs.readFileSync(resultPath, "utf8")).pid;
    realReap(pgid, seal);
    const error = new Error("process-group audit timed out"); error.code = "HOST_GROUP_AUDIT_FAILED"; throw error;
  };
  try {
    assert.throws(() => store.invokeIndependentReviewer({ runDir, request, timeoutMs: 10_000, env: {},
      buildInvocation: ({ cwd, resultPath }) => ({ command: process.execPath, args: ["-e", [
        "const {spawn}=require('child_process'),fs=require('fs');",
        "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
        "child.unref();fs.writeFileSync(process.argv[1],JSON.stringify({pid:child.pid}));",
      ].join(""), resultPath], cwd }),
      parseOutcome: () => ({ status: "succeeded", output: {} }),
    }), (error) => {
      assert.match(error.message, /runtime audit failed: scope audit timed out; process-group audit timed out/);
      assert.deepEqual(error.runtime_audit.audit_errors, ["HOST_IDENTITY_UNAVAILABLE", "HOST_GROUP_AUDIT_FAILED"]);
      assert.equal(error.runtime_audit.process_scope_matched, null);
      assert.equal(error.review_evidence_preserved, true); assert.equal(error.review_evidence_path, stage);
      return true;
    });
    assert.equal(reaped.length, 1, "the process-group reap must be attempted in finally even when the scope audit throws");
    assert.match(reaped[0].seal, /^[0-9a-f]{64}$/, "the reap must be bound to the issued inherited scope seal");
    assert.ok(Number.isInteger(escapedPid));
    const end = Date.now() + 2_000, waiter = new Int32Array(new SharedArrayBuffer(4)); let live = true;
    while (live && Date.now() < end) { try { process.kill(escapedPid, 0); Atomics.wait(waiter, 0, 0, 20); } catch (error) { live = error.code !== "ESRCH"; } }
    assert.equal(live, false, "a reviewer descendant must not outlive an audit failure");
  } finally {
    host.hostInvocation.auditProcessScope = realAudit; host.hostInvocation.reapProcessGroup = realReap; fs.mkdtempSync = originalMkdtemp;
  }
  assert.ok(stage);
  assert.equal(host.inspectOwnership({ runDir }).reason, "cleanup_incomplete");
  return host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir }), reason: "settle preserved reviewer test evidence" }).then(() => {
  assert.equal(fs.existsSync(stage), false);
  assert.equal(host.inspectOwnership({ runDir }).status, "absent");
  });
});

test("signed pending reviewer cleanup recovers every crash cut before staged-input deletion", async () => {
  const worker = path.join(__dirname, "../fixtures/reviewer-crash-worker.js");
  for (const cut of ["pending", "staged", "pre_spawn", "spawned", "before_cleanup"]) {
    const runDir = tempDir(`review-crash-${cut}`), criteriaPath = path.join(runDir, "done-criteria.md"), diffPath = path.join(runDir, "diff.patch"), promptPath = path.join(runDir, "prompt.md");
    fs.writeFileSync(criteriaPath, "criterion\n", { mode: 0o600 }); fs.writeFileSync(diffPath, "diff\n", { mode: 0o600 }); fs.writeFileSync(promptPath, "prompt\n", { mode: 0o600 });
    createRunRecord({ runDir, record: record(runDir, { contract: { done_criteria_path: criteriaPath, done_criteria_sha256: crypto.createHash("sha256").update("criterion\n").digest("hex") } }) });
    const request = { diff_path: diffPath, prompt_path: promptPath, done_criteria_path: criteriaPath, reviewed_sha: "a".repeat(40), current_sha: "a".repeat(40),
      diff_sha256: crypto.createHash("sha256").update("diff\n").digest("hex"), prompt_sha256: crypto.createHash("sha256").update("prompt\n").digest("hex") };
    const configPath = path.join(path.dirname(runDir), `worker-${cut}.json`); fs.writeFileSync(configPath, JSON.stringify({ cut, runDir, request }), { mode: 0o600 });
    const result = spawnSync(process.execPath, [worker, configPath], { timeout: 10_000 }); assert.equal(result.signal, "SIGKILL", cut);
    const cleanupName = fs.readdirSync(runDir).find((name) => name.endsWith(".cleanup-incomplete.json")); assert.ok(cleanupName, cut);
    const cleanup = JSON.parse(fs.readFileSync(path.join(runDir, cleanupName), "utf8")), stage = cleanup.obligation.staged_input_root.path;
    assert.equal(fs.existsSync(stage), true, cut); await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir }), reason: `recover reviewer crash ${cut}` });
    assert.equal(fs.existsSync(stage), false, cut); assert.equal(host.inspectOwnership({ runDir }).status, "absent", cut);
    assert.ok(fs.readdirSync(runDir).some((name) => name.endsWith(".cleanup-settled.json")), cut);
  }
});

test("independent review preserves ambient HOME/XDG and auth while removing staged input", () => {
  const runDir = tempDir("review-ambient"), criteriaPath = path.join(runDir, "done-criteria.md"), criteria = "criterion\n";
  fs.writeFileSync(criteriaPath, criteria, { mode: 0o600 });
  createRunRecord({ runDir, record: record(runDir, { contract: { done_criteria_path: criteriaPath, done_criteria_sha256: crypto.createHash("sha256").update(criteria).digest("hex") } }) });
  const diffPath = path.join(runDir, "diff.patch"), promptPath = path.join(runDir, "prompt.md");
  fs.writeFileSync(diffPath, "diff\n", { mode: 0o600 }); fs.writeFileSync(promptPath, "prompt\n", { mode: 0o600 });
  const request = { diff_path: diffPath, prompt_path: promptPath, done_criteria_path: criteriaPath, reviewed_sha: "a".repeat(40), current_sha: "a".repeat(40),
    diff_sha256: crypto.createHash("sha256").update("diff\n").digest("hex"), prompt_sha256: crypto.createHash("sha256").update("prompt\n").digest("hex") };
  const originalMkdtemp = fs.mkdtempSync; let stage;
  fs.mkdtempSync = function captureStage(prefix, ...args) { const value = originalMkdtemp.call(this, prefix, ...args); if (String(prefix).includes("relay-review-")) stage = value; return value; };
  const previous = { auth: process.env.REVIEW_AMBIENT_AUTH, relay: process.env.RELAY_REVIEW_LEAK };
  process.env.REVIEW_AMBIENT_AUTH = "ambient-review-auth"; process.env.RELAY_REVIEW_LEAK = "blocked";
  try {
    const outcome = store.invokeIndependentReviewer({ runDir, request, timeoutMs: 10_000,
      buildInvocation: ({ cwd, promptPath, promptBytes, resultPath }) => ({ command: process.execPath,
        args: ["-e", "require('fs').writeFileSync(process.argv[1],JSON.stringify({home:process.env.HOME,config:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME,auth:process.env.REVIEW_AMBIENT_AUTH,relay:process.env.RELAY_REVIEW_LEAK||null,tmp:process.env.TMPDIR}))", resultPath], cwd, stdinPath: promptPath, stdinSha256: crypto.createHash("sha256").update(promptBytes).digest("hex"), networkAccess: "enabled" }),
      parseOutcome: ({ exitCode, resultPath }) => ({ status: exitCode === 0 ? "succeeded" : "failed", output: JSON.parse(fs.readFileSync(resultPath, "utf8")) }),
    });
    assert.equal(outcome.output.home, process.env.HOME); assert.equal(outcome.output.config, process.env.XDG_CONFIG_HOME);
    assert.equal(outcome.output.data, process.env.XDG_DATA_HOME); assert.equal(outcome.output.auth, "ambient-review-auth");
    assert.equal(outcome.output.relay, null); assert.equal(outcome.output.tmp, path.join(stage, "inputs", "output"));
    assert.equal(fs.existsSync(stage), false, "the exact signed staged-input root is removed after review");
  } finally {
    fs.mkdtempSync = originalMkdtemp;
    if (previous.auth === undefined) delete process.env.REVIEW_AMBIENT_AUTH; else process.env.REVIEW_AMBIENT_AUTH = previous.auth;
    if (previous.relay === undefined) delete process.env.RELAY_REVIEW_LEAK; else process.env.RELAY_REVIEW_LEAK = previous.relay;
  }
});

test("observable primary review classifies only a recognized live provider failure", { timeout: 30_000 }, async () => {
  const runDir = tempDir("review-provider-unavailable"), criteriaPath = path.join(runDir, "done-criteria.md"), criteria = "criterion\n";
  fs.writeFileSync(criteriaPath, criteria, { mode: 0o600 });
  createRunRecord({ runDir, record: record(runDir, { contract: { done_criteria_path: criteriaPath, done_criteria_sha256: crypto.createHash("sha256").update(criteria).digest("hex") } }) });
  const diffPath = path.join(runDir, "diff.patch"), promptPath = path.join(runDir, "prompt.md");
  fs.writeFileSync(diffPath, "diff\n", { mode: 0o600 }); fs.writeFileSync(promptPath, "prompt\n", { mode: 0o600 });
  const request = { diff_path: diffPath, prompt_path: promptPath, done_criteria_path: criteriaPath, reviewed_sha: "a".repeat(40), current_sha: "a".repeat(40),
    diff_sha256: crypto.createHash("sha256").update("diff\n").digest("hex"), prompt_sha256: crypto.createHash("sha256").update("prompt\n").digest("hex") };
  const originalMkdtemp = fs.mkdtempSync, stages = [];
  fs.mkdtempSync = function captureStage(prefix, ...args) { const value = originalMkdtemp.call(this, prefix, ...args); if (String(prefix).includes("relay-review-")) stages.push(value); return value; };
  const invoke = (script, timeoutMs, forcedStatus = null) => store.invokeIndependentReviewer({ runDir, request, timeoutMs, providerUnavailableSignals: ["insufficient_quota"],
    buildInvocation: ({ cwd }) => ({ command: process.execPath, args: ["-e", script], cwd, networkAccess: "enabled", runtimeDependencies: { executableParent: null, interpreterParent: null } }),
    parseOutcome: ({ exitCode, signal, timedOut }) => ({ status: forcedStatus || (exitCode === 0 && !signal && !timedOut ? "succeeded" : "failed"), output: {} }) });
  try {
    const started = Date.now();
    await assert.rejects(invoke("process.on('SIGTERM',()=>{});process.stderr.write('credential=hidden insufficient_quota trailing\\n');setInterval(()=>{},1000)", 10_000, "succeeded"), (error) => {
      assert.equal(error.termination, "provider_unavailable"); assert.equal(error.classification, "provider_unavailable"); assert.equal(error.failure_reason, "provider_unavailable");
      assert.doesNotMatch(error.message, /credential=hidden|insufficient_quota/); return true;
    });
    assert.ok(Date.now() - started < 5_000); assert.equal(fs.existsSync(stages.at(-1)), false); assert.equal(host.inspectOwnership({ runDir }).status, "absent");

    const timeoutStarted = Date.now();
    await assert.rejects(invoke("process.on('SIGTERM',()=>{});process.stderr.write('ordinary provider error\\n');setInterval(()=>{},1000)", 300), (error) => {
      assert.equal(error.classification, null); assert.equal(error.failure_reason, "invocation_timeout"); return true;
    });
    assert.ok(Date.now() - timeoutStarted >= 250); assert.equal(fs.existsSync(stages.at(-1)), false);

    await assert.rejects(invoke("process.stderr.write('insufficient_quota\\n');setTimeout(()=>process.exit(2),100)", 10_000), (error) => {
      assert.equal(error.classification, null); assert.equal(error.failure_reason, "cli_nonzero_exit"); return true;
    });
    assert.equal(fs.existsSync(stages.at(-1)), false); assert.equal(host.inspectOwnership({ runDir }).status, "absent");

    const realReap = host.hostInvocation.reapProcessGroup; let reapCalls = 0;
    host.hostInvocation.reapProcessGroup = () => {
      reapCalls += 1;
      return { absent: false, survived_terminal: false, unverified: true };
    };
    const cleanupStarted = Date.now(); let cleanupStage;
    try {
      await assert.rejects(invoke("process.on('SIGTERM',()=>{});process.stderr.write('insufficient_quota\\n');setInterval(()=>{},1000)", 10_000), (error) => {
        cleanupStage = error.review_evidence_path;
        assert.equal(error.code, "HOST_CLEANUP_INCOMPLETE"); assert.equal(error.review_evidence_preserved, true);
        assert.equal(error.runtime_audit.process_group_unverified, true); assert.equal(error.runtime_audit.process_group_absent, false);
        return true;
      });
    } finally { host.hostInvocation.reapProcessGroup = realReap; }
    assert.ok(reapCalls >= 2); assert.ok(Date.now() - cleanupStarted < 5_000, "an unverified group must settle after the bounded close window");
    assert.ok(cleanupStage && fs.existsSync(cleanupStage)); assert.equal(host.inspectOwnership({ runDir }).reason, "cleanup_incomplete");
    await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir }), reason: "settle bounded unverified reviewer cleanup" });
    assert.equal(fs.existsSync(cleanupStage), false); assert.equal(host.inspectOwnership({ runDir }).status, "absent");
  } finally { fs.mkdtempSync = originalMkdtemp; }
});

test("external observer rejects an executable replaced after runtime binding", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-observer-runtime-swap-"))), observer = path.join(root, "observer.sh"), replacement = path.join(root, "replacement.sh");
  fs.writeFileSync(observer, "#!/bin/sh\necho '{\"which\":\"original\"}'\n", { mode: 0o700 });
  fs.writeFileSync(replacement, "#!/bin/sh\necho '{\"which\":\"replacement\"}'\n", { mode: 0o700 });
  const originalHostInvocation = host.hostInvocation; let swapped = false;
  function swapAfterProfile(...args) {
    const isolated = originalHostInvocation(...args);
    if (!swapped) { swapped = true; fs.renameSync(replacement, observer); }
    return isolated;
  }
  Object.assign(swapAfterProfile, originalHostInvocation); host.hostInvocation = swapAfterProfile;
  try {
    assert.throws(() => store.invokeExternalObserver({ observer: { command: observer, args: [], networkAccess: "disabled",
      runtimeDependencies: { executableParent: null, interpreterParent: null } }, request: {} }),
    (error) => error.code === "HOST_RUNTIME_CHANGED" && /runtime executable closure changed/.test(error.message));
  } finally { host.hostInvocation = originalHostInvocation; fs.rmSync(root, { recursive: true, force: true }); }
});

test("staged-input mutation preserves cleanup evidence when the reviewer audit is unsafe", async () => {
  const runDir = tempDir("review-mutation-audit"), criteriaPath = path.join(runDir, "done-criteria.md"), criteria = "criterion\n";
  fs.writeFileSync(criteriaPath, criteria, { mode: 0o600 });
  createRunRecord({ runDir, record: record(runDir, { contract: { done_criteria_path: criteriaPath, done_criteria_sha256: crypto.createHash("sha256").update(criteria).digest("hex") } }) });
  const diffPath = path.join(runDir, "diff.patch"), promptPath = path.join(runDir, "prompt.md");
  fs.writeFileSync(diffPath, "diff\n", { mode: 0o600 }); fs.writeFileSync(promptPath, "prompt\n", { mode: 0o600 });
  const request = { diff_path: diffPath, prompt_path: promptPath, done_criteria_path: criteriaPath, reviewed_sha: "a".repeat(40), current_sha: "a".repeat(40),
    diff_sha256: crypto.createHash("sha256").update("diff\n").digest("hex"), prompt_sha256: crypto.createHash("sha256").update("prompt\n").digest("hex") };
  const originalMkdtemp = fs.mkdtempSync, realReap = host.hostInvocation.reapProcessGroup; let stage;
  fs.mkdtempSync = function captureStage(prefix, ...args) { const value = originalMkdtemp.call(this, prefix, ...args); if (String(prefix).includes("relay-review-")) stage = value; return value; };
  host.hostInvocation.reapProcessGroup = (...args) => ({ ...realReap(...args), absent: false, survived_terminal: true, unverified: true });
  try {
    assert.throws(() => store.invokeIndependentReviewer({ runDir, request, timeoutMs: 10_000, env: {},
      buildInvocation: ({ cwd, promptPath: stagedPrompt, promptBytes, resultPath }) => ({ command: process.execPath,
        args: ["-e", "const fs=require('fs');fs.appendFileSync(process.argv[1],'mutated\\n');fs.writeFileSync(process.argv[2],JSON.stringify({ok:true}));", stagedPrompt, resultPath], cwd,
        stdinPath: stagedPrompt, stdinSha256: crypto.createHash("sha256").update(promptBytes).digest("hex"), networkAccess: "enabled", runtimeDependencies: { executableParent: null, interpreterParent: null } }),
      parseOutcome: ({ exitCode, resultPath }) => ({ status: exitCode === 0 ? "succeeded" : "failed", output: JSON.parse(fs.readFileSync(resultPath, "utf8")) }),
    }), (error) => {
      assert.equal(error.review_evidence_preserved, true);
      assert.equal(error.review_input_error?.code, "REVIEW_INPUT_BINDING_CHANGED");
      assert.match(error.review_input_error?.message || "", /staged review prompt changed/);
      assert.equal(error.runtime_audit.process_group_absent, false);
      return true;
    });
  } finally {
    host.hostInvocation.reapProcessGroup = realReap; fs.mkdtempSync = originalMkdtemp;
  }
  assert.ok(stage);
  await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir }), reason: "settle combined review mutation and audit evidence" });
  assert.equal(fs.existsSync(stage), false);
});

test("native-first host runs observer and reviewer through the direct non-darwin seam", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-linux-host-seam-")));
  const runDir = path.join(root, "run-1");
  fs.mkdirSync(runDir);
  const criteriaPath = path.join(runDir, "done-criteria.md"), criteria = "criterion\n";
  fs.writeFileSync(criteriaPath, criteria, { mode: 0o600 });
  createRunRecord({ runDir, record: record(runDir, { contract: { done_criteria_path: criteriaPath, done_criteria_sha256: crypto.createHash("sha256").update(criteria).digest("hex") } }) });
  const observer = path.join(root, "observer.js"), reviewer = path.join(root, "reviewer.js");
  fs.writeFileSync(observer, "const fs=require('fs');const i=process.argv.indexOf('--request-file');process.stdout.write(JSON.stringify({request:JSON.parse(fs.readFileSync(process.argv[i+1],'utf8'))}));");
  fs.writeFileSync(reviewer, "const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({verdict:'pass'}));");
  const diffPath = path.join(runDir, "diff.patch"), promptPath = path.join(runDir, "prompt.md");
  fs.writeFileSync(diffPath, "diff\n", { mode: 0o600 }); fs.writeFileSync(promptPath, "prompt\n", { mode: 0o600 });
  const request = { diff_path: diffPath, prompt_path: promptPath, done_criteria_path: criteriaPath, reviewed_sha: "a".repeat(40), current_sha: "a".repeat(40),
    diff_sha256: crypto.createHash("sha256").update("diff\n").digest("hex"), prompt_sha256: crypto.createHash("sha256").update("prompt\n").digest("hex") };
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    const observed = store.invokeExternalObserver({ observer: { command: process.execPath, args: [{ kind: "staged_file", value: observer }], networkAccess: "enabled",
      runtimeDependencies: { executableParent: null, interpreterParent: null } }, request: { seam: "linux" } });
    assert.deepEqual(observed, { request: { seam: "linux" } });
    const outcome = store.invokeIndependentReviewer({ runDir, request, timeoutMs: 10_000, env: {},
      buildInvocation: ({ cwd, promptPath: stagedPrompt, promptBytes, resultPath }) => ({ command: process.execPath, args: [reviewer, resultPath], cwd, stdinPath: stagedPrompt,
        stdinSha256: crypto.createHash("sha256").update(promptBytes).digest("hex"), networkAccess: "enabled", runtimeDependencies: { executableParent: null, interpreterParent: null } }),
      parseOutcome: ({ exitCode, resultPath }) => ({ status: exitCode === 0 ? "succeeded" : "failed", output: JSON.parse(fs.readFileSync(resultPath, "utf8")) }),
    });
    assert.equal(outcome.output.verdict, "pass");
    assert.ok(outcome.executed_runtime.length > 0);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("runtime path seams canonicalize repository identity and reject path injection", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-path-seams-")));
  execFileSync("git", ["init", "-b", "main", root], { stdio: "pipe" });
  const priorHome = process.env.RELAY_HOME;
  const priorBase = process.env.RELAY_WORKTREE_BASE;
  process.env.RELAY_HOME = path.join(root, "relay-home");
  process.env.RELAY_WORKTREE_BASE = path.join(root, "worktrees");
  try {
    assert.equal(store.canonicalRepository(root), fs.realpathSync(root));
    assert.equal(store.relayWorktreeBase(), path.join(root, "worktrees"));
    assert.match(store.resolveRunDirectory(root, "issue-1"), /\/runs\/[^/]+\/issue-1$/);
    assert.throws(() => store.resolveRunDirectory(root, "../escape"), /safe path segment/);
  } finally {
    if (priorHome === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = priorHome;
    if (priorBase === undefined) delete process.env.RELAY_WORKTREE_BASE; else process.env.RELAY_WORKTREE_BASE = priorBase;
    fs.rmSync(root, { recursive: true, force: true });
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
        value: path.resolve(__dirname, "../fixtures/json-observer.js"),
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
      operatorAction: { actor: "owner", method: "squash", githubLogin: "relay-bot" },
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
