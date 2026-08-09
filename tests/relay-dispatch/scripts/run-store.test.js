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
  const credentialSource = path.join(path.dirname(runDir), "review-audit-secret"); fs.writeFileSync(credentialSource, "audit-secret", { mode: 0o600 });
  const credentialRequest = { metadata: { files: [{ id: "auth", targetRoot: "home", targetRel: ".tool/auth.json", access: "read", recommendedSource: "test" }], envHints: [] },
    envNames: ["TOOL_TOKEN"], fileSpecs: [`auth=${credentialSource}`], env: { TOOL_TOKEN: "audit-env-secret" } };
  const originalMkdtemp = fs.mkdtempSync; let stage;
  fs.mkdtempSync = function captureStage(prefix, ...args) { const value = originalMkdtemp.call(this, prefix, ...args); if (String(prefix).includes("relay-review-")) stage = value; return value; };
  const realAudit = host.sandboxInvocation.auditProcessScope, realReap = host.sandboxInvocation.reapProcessGroup;
  const reaped = []; let escapedPid;
  host.sandboxInvocation.auditProcessScope = () => { const error = new Error("scope audit timed out"); error.code = "HOST_IDENTITY_UNAVAILABLE"; throw error; };
  host.sandboxInvocation.reapProcessGroup = (pgid, seal) => {
    reaped.push({ pgid, seal });
    const resultPath = path.join(stage, "inputs", "output", "reviewer-result.json");
    if (fs.existsSync(resultPath)) escapedPid = JSON.parse(fs.readFileSync(resultPath, "utf8")).pid;
    realReap(pgid, seal);
    const error = new Error("process-group audit timed out"); error.code = "HOST_GROUP_AUDIT_FAILED"; throw error;
  };
  try {
    assert.throws(() => store.invokeIndependentReviewer({ runDir, request, timeoutMs: 10_000, env: {}, credentialRequest,
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
    assert.equal(live, false, "a credential-inheriting reviewer descendant must not outlive an audit failure");
  } finally {
    host.sandboxInvocation.auditProcessScope = realAudit; host.sandboxInvocation.reapProcessGroup = realReap; fs.mkdtempSync = originalMkdtemp;
  }
  assert.ok(stage);
  assert.equal(fs.readFileSync(path.join(stage, "reviewer-credentials", "home", ".tool", "auth.json"), "utf8"), "audit-secret");
  assert.equal(host.inspectOwnership({ runDir }).reason, "cleanup_incomplete");
  return host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir }), reason: "settle preserved reviewer test evidence" }).then(() => {
  assert.equal(fs.existsSync(stage), false);
  assert.equal(host.inspectOwnership({ runDir }).status, "absent");
  });
});

test("signed pending reviewer cleanup recovers every crash cut before secret stage deletion", async () => {
  const worker = path.join(__dirname, "../fixtures/reviewer-crash-worker.js");
  for (const cut of ["pending", "credential", "pre_spawn", "spawned", "before_cleanup"]) {
    const runDir = tempDir(`review-crash-${cut}`), criteriaPath = path.join(runDir, "done-criteria.md"), diffPath = path.join(runDir, "diff.patch"), promptPath = path.join(runDir, "prompt.md");
    fs.writeFileSync(criteriaPath, "criterion\n", { mode: 0o600 }); fs.writeFileSync(diffPath, "diff\n", { mode: 0o600 }); fs.writeFileSync(promptPath, "prompt\n", { mode: 0o600 });
    createRunRecord({ runDir, record: record(runDir, { contract: { done_criteria_path: criteriaPath, done_criteria_sha256: crypto.createHash("sha256").update("criterion\n").digest("hex") } }) });
    const source = path.join(path.dirname(runDir), `auth-${cut}.json`); fs.writeFileSync(source, "secret", { mode: 0o600 });
    const request = { diff_path: diffPath, prompt_path: promptPath, done_criteria_path: criteriaPath, reviewed_sha: "a".repeat(40), current_sha: "a".repeat(40),
      diff_sha256: crypto.createHash("sha256").update("diff\n").digest("hex"), prompt_sha256: crypto.createHash("sha256").update("prompt\n").digest("hex") };
    const credentials = { metadata: { files: [{ id: "auth", targetRoot: "home", targetRel: ".tool/auth.json", access: "read", recommendedSource: "test" }], envHints: [] }, envNames: [], fileSpecs: [`auth=${source}`], env: {} };
    const configPath = path.join(path.dirname(runDir), `worker-${cut}.json`); fs.writeFileSync(configPath, JSON.stringify({ cut, runDir, request, credentials }), { mode: 0o600 });
    const result = spawnSync(process.execPath, [worker, configPath], { timeout: 10_000 }); assert.equal(result.signal, "SIGKILL", cut);
    const cleanupName = fs.readdirSync(runDir).find((name) => name.endsWith(".cleanup-incomplete.json")); assert.ok(cleanupName, cut);
    const cleanup = JSON.parse(fs.readFileSync(path.join(runDir, cleanupName), "utf8")), stage = cleanup.obligation.credential_root.path;
    assert.equal(fs.existsSync(stage), true, cut); await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir }), reason: `recover reviewer crash ${cut}` });
    assert.equal(fs.existsSync(stage), false, cut); assert.equal(host.inspectOwnership({ runDir }).status, "absent", cut);
    assert.ok(fs.readdirSync(runDir).some((name) => name.endsWith(".cleanup-settled.json")), cut);
  }
});

test("independent review stages explicit owner-only credentials into private HOME/XDG and removes them after execution", async () => {
  const runDir = tempDir("review-credentials"), criteriaPath = path.join(runDir, "done-criteria.md"), source = path.join(path.dirname(runDir), "auth.json");
  const criteria = "criterion\n", secret = "review-credential-secret", envSecret = "review-environment-secret";
  fs.writeFileSync(criteriaPath, criteria, { mode: 0o600 }); fs.writeFileSync(source, secret, { mode: 0o600 }); fs.chmodSync(source, 0o600);
  createRunRecord({ runDir, record: record(runDir, { contract: { done_criteria_path: criteriaPath, done_criteria_sha256: crypto.createHash("sha256").update(criteria).digest("hex") } }) });
  const diffPath = path.join(runDir, "diff.patch"), promptPath = path.join(runDir, "prompt.md");
  fs.writeFileSync(diffPath, "diff\n", { mode: 0o600 }); fs.writeFileSync(promptPath, "prompt\n", { mode: 0o600 });
  const request = { diff_path: diffPath, prompt_path: promptPath, done_criteria_path: criteriaPath, reviewed_sha: "a".repeat(40), current_sha: "a".repeat(40),
    diff_sha256: crypto.createHash("sha256").update("diff\n").digest("hex"), prompt_sha256: crypto.createHash("sha256").update("prompt\n").digest("hex") };
  const originalMkdtemp = fs.mkdtempSync; let stage;
  fs.mkdtempSync = function captureStage(prefix, ...args) { const value = originalMkdtemp.call(this, prefix, ...args); if (String(prefix).includes("relay-review-")) stage = value; return value; };
  const script = "const fs=require('fs'),path=require('path');const cache=path.join(process.env.HOME,'.tool/cache/state.json');fs.mkdirSync(path.dirname(cache),{recursive:true});fs.writeFileSync(cache,'state');let authWrite='written',etcSibling='readable';try{fs.writeFileSync(path.join(process.env.HOME,'.tool/auth.json'),'changed')}catch(e){authWrite='denied:'+e.code}try{fs.readFileSync('/private/etc/hosts')}catch(e){etcSibling='denied:'+e.code}const value={home:process.env.HOME,config:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME,privateConfig:process.env.TOOL_CONFIG_DIR,privateData:process.env.TOOL_DATA_DIR,auth:fs.readFileSync(path.join(process.env.HOME,'.tool/auth.json'),'utf8'),cache:fs.readFileSync(cache,'utf8'),authWrite,env:process.env.TOOL_TOKEN,ca:process.env.SSL_CERT_FILE,certificate:fs.readFileSync(process.env.SSL_CERT_FILE,'utf8').includes('BEGIN CERTIFICATE'),etcSibling,modes:[fs.statSync(process.env.HOME).mode&511,fs.statSync(path.join(process.env.HOME,'.tool/auth.json')).mode&511]};fs.writeFileSync(process.argv[1],JSON.stringify(value));";
  const invoke = (credentialRequest) => store.invokeIndependentReviewer({ runDir, request, timeoutMs: 10_000, env: {}, credentialRequest,
    buildInvocation: ({ cwd, promptPath, promptBytes, resultPath }) => ({ command: process.execPath, args: ["-e", script, resultPath], cwd, stdinPath: promptPath, stdinSha256: crypto.createHash("sha256").update(promptBytes).digest("hex"), networkAccess: "enabled",
      privateEnvPaths: [{ key: "TOOL_CONFIG_DIR", root: "home", relative: ".tool" }, { key: "TOOL_DATA_DIR", root: "scratch", relative: "tool-data" }] }),
    parseOutcome: ({ exitCode, resultPath }) => ({ status: exitCode === 0 ? "succeeded" : "failed", output: JSON.parse(fs.readFileSync(resultPath, "utf8")) }),
  });
  const explicit = { metadata: { files: [{ id: "auth", targetRoot: "home", targetRel: ".tool/auth.json", access: "read", recommendedSource: "~/.tool/auth.json" }], envHints: [] }, envNames: ["TOOL_TOKEN"], fileSpecs: [`auth=${source}`], env: { TOOL_TOKEN: envSecret } };
  try {
    const outcome = invoke(explicit);
    assert.equal(outcome.output.auth, secret); assert.equal(outcome.output.cache, "state"); assert.match(outcome.output.authWrite, /^denied:/); assert.equal(outcome.output.env, envSecret); assert.deepEqual(outcome.output.modes, [0o700, 0o600]);
    assert.equal(outcome.output.ca, fs.realpathSync("/etc/ssl/cert.pem")); assert.equal(outcome.output.certificate, true); assert.match(outcome.output.etcSibling, /^denied:/);
    assert.match(outcome.output.home, /reviewer-credentials\/home$/); assert.match(outcome.output.config, /reviewer-credentials\/xdg-config$/); assert.match(outcome.output.data, /reviewer-credentials\/xdg-data$/);
    assert.equal(outcome.output.privateConfig, path.join(outcome.output.home, ".tool")); assert.match(outcome.output.privateData, /reviewer-credentials\/scratch\/tool-data$/); assert.ok(Buffer.byteLength(outcome.output.privateData) <= 83);
    assert.doesNotMatch(JSON.stringify(outcome.review_binding), new RegExp(`${secret}|${envSecret}|${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const realRetain = host.retainReviewerCleanup; let retainedStage;
    try {
      host.retainReviewerCleanup = (...args) => { const value = realRetain(...args); return { ...value, complete() { const error = new Error("injected reviewer cleanup failure"); error.code = "HOST_CLEANUP_INCOMPLETE"; throw error; } }; };
      assert.throws(() => invoke(explicit), (error) => { retainedStage = error.review_evidence_path; return error.code === "HOST_CLEANUP_INCOMPLETE"; });
      assert.equal(fs.existsSync(retainedStage), true, "review stage must be restored to its signed pathname");
    } finally {
      host.retainReviewerCleanup = realRetain;
      if (retainedStage && fs.existsSync(retainedStage)) await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir }), reason: "review quarantine test recovery" });
    }
    assert.throws(() => invoke({ ...explicit, envNames: ["SSL_CERT_FILE"], env: { SSL_CERT_FILE: source } }), /host-reserved/);
    fs.chmodSync(source, 0o644);
    assert.throws(() => invoke(explicit), /owner-only regular file/);
    fs.chmodSync(source, 0o600);
    const link = path.join(path.dirname(source), "auth-link.json"); fs.symlinkSync(source, link);
    assert.throws(() => invoke({ ...explicit, fileSpecs: [`auth=${link}`] }), (error) => {
      assert.match(error.message, /owner-only regular file|source is unavailable/); assert.doesNotMatch(error.message, new RegExp(link)); return true;
    });
    const missing = path.join(path.dirname(source), "missing-private-source.json");
    assert.throws(() => invoke({ ...explicit, fileSpecs: [`auth=${missing}`] }), (error) => {
      assert.match(error.message, /source is unavailable/); assert.doesNotMatch(error.message, new RegExp(missing)); return true;
    });
    assert.throws(() => invoke({ ...explicit, env: {} }), /environment value is missing/);
  } finally { fs.mkdtempSync = originalMkdtemp; assert.ok(stage); assert.equal(fs.existsSync(stage), false); }
});

test("external observer rejects an executable replaced after sandbox profile construction", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-observer-runtime-swap-"))), observer = path.join(root, "observer.sh"), replacement = path.join(root, "replacement.sh");
  fs.writeFileSync(observer, "#!/bin/sh\necho '{\"which\":\"original\"}'\n", { mode: 0o700 });
  fs.writeFileSync(replacement, "#!/bin/sh\necho '{\"which\":\"replacement\"}'\n", { mode: 0o700 });
  const originalSandbox = host.sandboxInvocation; let swapped = false;
  function swapAfterProfile(...args) {
    const isolated = originalSandbox(...args);
    if (!swapped) { swapped = true; fs.renameSync(replacement, observer); }
    return isolated;
  }
  Object.assign(swapAfterProfile, originalSandbox); host.sandboxInvocation = swapAfterProfile;
  try {
    assert.throws(() => store.invokeExternalObserver({ observer: { command: observer, args: [], networkAccess: "disabled",
      runtimeDependencies: { executableParent: null, interpreterParent: null } }, request: {} }),
    (error) => error.code === "HOST_RUNTIME_CHANGED" && /runtime executable closure changed/.test(error.message));
  } finally { host.sandboxInvocation = originalSandbox; fs.rmSync(root, { recursive: true, force: true }); }
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
