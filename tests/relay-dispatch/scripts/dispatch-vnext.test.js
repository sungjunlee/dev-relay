"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const facts = require("../../../skills/relay-dispatch/scripts/facts");
const generation = require("../../../skills/relay-dispatch/scripts/runtime-generation");
const dispatch = require("../../../skills/relay-dispatch/scripts/dispatch");
const host = require("../../../skills/relay-dispatch/scripts/host");
const recovery = require("../../../skills/relay-dispatch/scripts/recover");
const runtime = { ...recovery, inspectRun: recovery.inspectProductionRun };
const { readRunRecord } = require("../../../skills/relay-dispatch/scripts/run-store");

const ROOT = path.resolve(__dirname, "../../..");
const DISPATCH = path.join(ROOT, "skills/relay-dispatch/scripts/dispatch.js");
const FAKE_CODEX = path.join(ROOT, "tests/relay-dispatch/fixtures/vnext-fake-codex.js");
const FAKE_CURSOR = path.join(ROOT, "tests/relay-dispatch/fixtures/vnext-fake-cursor.js");
const FAKE_CLINE = path.join(ROOT, "tests/relay-dispatch/fixtures/vnext-fake-cline.js");
const CRASH_AFTER_START = path.join(ROOT, "tests/relay-dispatch/fixtures/dispatch-crash-after-start-preload.js");
const WRITE_CONTAINMENT_EXECUTOR = path.join(ROOT, "tests/relay-dispatch/fixtures/vnext-write-containment-executor.js");
const ADAPTER_RUNTIME_PRELOAD = path.join(ROOT, "tests/relay-dispatch/fixtures/vnext-adapter-runtime-preload.js");

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function installNodeFixture(source, target) {
  const bytes = fs.readFileSync(source, "utf8").replace(/^#![^\n]*/, `#!${process.execPath}`);
  fs.writeFileSync(target, bytes, { mode: 0o755 });
}

function fixture(label, { active = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `relay-dispatch-vnext-${label}-`)));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const relayHome = path.join(root, "relay-home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, ["config", "user.email", "relay@example.test"]);
  git(repo, ["config", "user.name", "Relay Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  const prompt = path.join(root, "prompt.md");
  const rubric = path.join(root, "rubric.yaml");
  fs.writeFileSync(prompt, "Implement the requested change.\n");
  fs.writeFileSync(rubric, "done_criteria:\n  - change is reviewable\n");
  installNodeFixture(FAKE_CODEX, path.join(bin, "codex"));
  installNodeFixture(FAKE_CURSOR, path.join(bin, "agent"));
  const fakeCline = path.join(bin, "node_modules", "cline", "bin", "cline"); fs.mkdirSync(path.dirname(fakeCline), { recursive: true }); installNodeFixture(FAKE_CLINE, fakeCline);
  const env = { ...process.env, RELAY_HOME: relayHome, RELAY_CURSOR_AGENT_BIN: path.join(bin, "agent"), RELAY_CLINE_BIN: fakeCline,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${ADAPTER_RUNTIME_PRELOAD}`].filter(Boolean).join(" "),
    PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  if (active) {
    const identity = dispatch.repositoryIdentity(fs.realpathSync(repo));
    const store = generation.initializeStore({ checkoutRoot: identity.checkout, remote: identity.remote });
    generation.decideMigration({ store, observation: { observed_at: "2026-08-01T00:00:00.000Z", active_legacy_run_count: 0, oldest_active_legacy_age_hours: null } });
    const drain = generation.recordDrainCompleted({ store,
      inventory: { observed_at: "2026-08-01T00:00:00.001Z", active_legacy_run_count: 0, oldest_active_legacy_age_hours: null },
      actor: "test-fixture", operationId: `drain-${label}` }).inventory;
    generation.switchGeneration({ store, generation: "vnext", actor: "test-fixture", operationId: `switch-${label}`,
      switchedAt: "2026-08-01T00:00:00.002Z", drainInventoryDigest: drain.inventory_digest });
  }
  return { root, repo, remote, relayHome, prompt, rubric, env };
}

function run(value, args, env = value.env) {
  const network = args.includes("--network-access") ? [] : ["--network-access", "enabled"];
  return spawnSync(process.execPath, [DISPATCH, value.repo, ...args, ...network], { encoding: "utf8", env, timeout: 60_000 });
}

function json(stdout) { return JSON.parse(stdout); }

function processLive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function fixtureRunsDir(value) {
  const canonical = fs.realpathSync(value.repo);
  const base = path.basename(canonical).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const slug = `${base}-${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 8)}`;
  return path.join(value.relayHome, "runs", slug);
}

function byteTree(root) {
  if (!fs.existsSync(root)) return null;
  const visit = (directory, prefix = "") => fs.readdirSync(directory).sort().flatMap((name) => {
    const absolute = path.join(directory, name);
    const relative = path.join(prefix, name);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) return [{ path: relative, kind: "directory", mode: stat.mode & 0o777 }, ...visit(absolute, relative)];
    if (stat.isSymbolicLink()) return [{ path: relative, kind: "symlink", target: fs.readlinkSync(absolute) }];
    return [{ path: relative, kind: "file", mode: stat.mode & 0o777, bytes: fs.readFileSync(absolute).toString("base64") }];
  });
  return visit(root);
}

test("cleanup recovery refuses to release an owner without a signed exact obligation", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-cleanup-pending-")));
  const runDir = path.join(root, "run"), worktree = path.join(root, "worktree"); fs.mkdirSync(runDir); fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(runDir, "events.jsonl"), "");
  const lockContext = host.acquireRunLock({ runDir, attemptId: "cleanup-pending", operation: "dispatch", worktreeDir: worktree });
  const originalWait = host.waitForTerminalResult;
  host.waitForTerminalResult = async () => { throw Object.assign(new Error("cleanup remains"), { code: "HOST_CLEANUP_INCOMPLETE" }); };
  try {
    await assert.rejects(dispatch.finishAttempt({ cli: {}, store: null, adapter: null, started: { receipt: {}, lockContext, runDir } }),
      (error) => error.code === "BREAK_EVIDENCE_INSUFFICIENT" && error.cleanup_recovery === "incomplete");
    assert.equal(fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8"), "");
    assert.equal(host.inspectOwnership({ runDir }).status, "live");
  } finally {
    host.waitForTerminalResult = originalWait; host.releaseRunLock(lockContext); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run validates the closed vNext surface while writing zero durable bytes", () => {
  const value = fixture("dry", { active: false });
  const stateDir = path.join(value.repo, ".git", "relay-runtime-vnext");
  const result = run(value, ["--branch", "dry-run", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--dry-run", "--json"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(json(result.stdout).durable_bytes_written, 0);
  assert.equal(json(result.stdout).invocation.validation, "adapter_build_invocation");
  assert.equal(json(result.stdout).invocation.launch_boundary, "host_sandbox_required_do_not_execute_raw");
  assert.equal(fs.existsSync(stateDir), false);
  assert.equal(fs.existsSync(value.relayHome), false);
  const cursor = run(value, ["--executor", "cursor", "--branch", "cursor-dry", "--prompt", "x", "--rubric-file", value.rubric, "--dry-run", "--json"]);
  assert.equal(cursor.status, 0, cursor.stderr); assert.deepEqual(json(cursor.stdout).invocation.private_env_paths,
    [{ key: "CURSOR_CONFIG_DIR", root: "home", relative: ".cursor" }, { key: "CURSOR_DATA_DIR", root: "scratch", relative: "cursor-data" }]);

  const absentSource = path.join(value.root, "never-read-auth.json");
  const credentialDryRun = run(value, ["--branch", "credential-dry", "--prompt", "x", "--rubric-file", value.rubric, "--credential-env", "OPENAI_API_KEY",
    "--credential-file", `auth=${absentSource}`, "--dry-run", "--json"], { ...value.env, OPENAI_API_KEY: undefined });
  assert.equal(credentialDryRun.status, 0, credentialDryRun.stderr);
  assert.deepEqual(json(credentialDryRun.stdout).credential_request, { env_names: ["OPENAI_API_KEY"], file_ids: ["auth"] });
  assert.doesNotMatch(credentialDryRun.stdout + credentialDryRun.stderr, /never-read-auth/);
  assert.equal(fs.existsSync(absentSource), false);
  const customEnv = run(value, ["--branch", "custom-env-dry", "--prompt", "x", "--rubric-file", value.rubric,
    "--credential-env", "CUSTOM_PROVIDER_TOKEN", "--dry-run", "--json"], { ...value.env, CUSTOM_PROVIDER_TOKEN: undefined });
  assert.equal(customEnv.status, 0, customEnv.stderr);
  assert.deepEqual(json(customEnv.stdout).credential_request.env_names, ["CUSTOM_PROVIDER_TOKEN"]);

  git(value.repo, ["branch", "existing-dry"]);
  const existingBranch = run(value, ["--branch", "existing-dry", "--prompt", "x", "--rubric-file", value.rubric, "--dry-run", "--json"]);
  assert.notEqual(existingBranch.status, 0);
  assert.equal(json(existingBranch.stderr).code, "BRANCH_EXISTS");
  assert.equal(fs.existsSync(value.relayHome), false);

  const invalidBranch = run(value, ["--branch", "bad branch", "--prompt", "x", "--rubric-file", value.rubric, "--dry-run", "--json"]);
  assert.notEqual(invalidBranch.status, 0);
  assert.equal(git(value.repo, ["branch", "--list", "bad branch"]), "");
  assert.equal(fs.existsSync(value.relayHome), false);

  const missingCopy = run(value, ["--branch", "missing-copy", "--prompt", "x", "--rubric-file", value.rubric, "--copy", "missing.txt", "--dry-run", "--json"]);
  assert.notEqual(missingCopy.status, 0);
  assert.equal(fs.existsSync(value.relayHome), false);

  const escapedCopy = run(value, ["--branch", "escaped-copy", "--prompt", "x", "--rubric-file", value.rubric, "--copy", "../prompt.md", "--dry-run", "--json"]);
  assert.notEqual(escapedCopy.status, 0);
  assert.match(json(escapedCopy.stderr).error, /--copy escapes repo/);
  assert.equal(fs.existsSync(value.relayHome), false);

  const obsolete = run(value, ["--branch", "old", "--prompt", "x", "--rubric-file", value.rubric, "--auto-recover-commit"]);
  assert.notEqual(obsolete.status, 0);
  assert.match(obsolete.stderr, /Unknown option '--auto-recover-commit'/);
});

test("tool-network disable fails closed for informational executors and preserves provider transport for native ones", () => {
  const value = fixture("network-disabled-preflight");
  const unsupported = run(value, ["--branch", "network-disabled-codex", "--prompt-file", value.prompt, "--rubric-file", value.rubric,
    "--network-access", "disabled", "--dry-run", "--json"]);
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /tool network disable/i);
  // pi is the only adapter declaring networkControl "native"; claude is deliberately informational,
  // because safe mode preserves admin-managed hooks and so cannot prove complete tool egress denial.
  const result = run(value, ["--executor", "pi", "--branch", "network-disabled-native", "--prompt-file", value.prompt, "--rubric-file", value.rubric,
    "--network-access", "disabled", "--dry-run", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = json(result.stdout); assert.equal(output.invocation.network_access, "enabled"); assert.equal(output.invocation.tool_network_access, "disabled");
  assert.equal(fs.existsSync(fixtureRunsDir(value)), false);
});

test("removed readiness identity flags fail closed instead of being silently ignored", () => {
  const value = fixture("removed-readiness-flags");
  for (const flag of ["--request-id", "--leaf-id"]) {
    const result = run(value, ["--branch", "closed-surface", "--prompt", "x", "--rubric-file", value.rubric, flag, "legacy", "--dry-run", "--json"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown flag/i);
  }
  assert.equal(fs.existsSync(value.relayHome), false);
});

test("missing generation marker and caller bootstrap both fail closed", () => {
  const value = fixture("generation", { active: false });
  const stateDir = path.join(value.repo, ".git", "relay-runtime-vnext");
  assert.equal(fs.existsSync(stateDir), false);
  const denied = run(value, ["--branch", "denied", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"]);
  assert.notEqual(denied.status, 0);
  assert.equal(json(denied.stderr).code, "GENERATION_NOT_ACTIVE");
  assert.equal(git(value.repo, ["branch", "--list", "denied"]), "");
  assert.equal(fs.existsSync(stateDir), false, "ordinary admission must not initialize an absent store");

  const allowed = run(value, ["--branch", "issue-42", "--issue-number", "42", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--bootstrap-vnext", "--json"]);
  assert.notEqual(allowed.status, 0);
  assert.equal(json(allowed.stderr).code, "CUTOVER_GATE_UNSATISFIED");
  assert.equal(fs.existsSync(stateDir), false, "sealed bootstrap must not initialize an absent store");
  const store = generation.initializeStore({ checkoutRoot: value.repo, remote: value.remote });
  assert.equal(generation.readGeneration(store), null);
});

test("an initialized store without an active marker is byte-for-byte read-only on dispatch admission", () => {
  const value = fixture("generation-inactive-store", { active: false });
  const store = generation.initializeStore({ checkoutRoot: value.repo, remote: value.remote });
  const before = byteTree(store.stateDir);
  const denied = run(value, ["--branch", "inactive-store", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"]);
  assert.notEqual(denied.status, 0);
  assert.equal(json(denied.stderr).code, "GENERATION_NOT_ACTIVE");
  assert.deepEqual(byteTree(store.stateDir), before);
  assert.equal(git(value.repo, ["branch", "--list", "inactive-store"]), "");
});

test("a malformed generation marker fails closed without repairing or rewriting the store", () => {
  const value = fixture("generation-malformed-store", { active: false });
  const store = generation.initializeStore({ checkoutRoot: value.repo, remote: value.remote });
  fs.writeFileSync(store.paths.generation, "{malformed\n");
  const before = byteTree(store.stateDir);
  const denied = run(value, ["--branch", "malformed-store", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--json"]);
  assert.notEqual(denied.status, 0);
  assert.equal(json(denied.stderr).code, "INVALID_GENERATION_ARTIFACT");
  assert.deepEqual(byteTree(store.stateDir), before);
  assert.equal(git(value.repo, ["branch", "--list", "malformed-store"]), "");
});

test("self-attested 30-run JSON and caller digest cannot authorize bootstrap", () => {
  const value = fixture("bootstrap-gate", { active: false });
  const gate = path.join(value.root, "self-attested.json");
  fs.writeFileSync(gate, JSON.stringify({ successful_vnext_runs: 30, days: 14, violations: 0 }));
  const result = run(value, ["--branch", "gate-self-attested", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--bootstrap-vnext", "--json"], {
    ...value.env, RELAY_VNEXT_CUTOVER_GATE: gate,
    RELAY_VNEXT_CUTOVER_GATE_SHA256: crypto.createHash("sha256").update(fs.readFileSync(gate)).digest("hex"),
  });
  assert.notEqual(result.status, 0);
  assert.equal(json(result.stderr).code, "CUTOVER_GATE_UNSATISFIED");
});

test("bootstrap resumes the same durable transition identity after a receipt-before-marker crash", () => {
  const value = fixture("bootstrap-resume", { active: false });
  const identity = dispatch.repositoryIdentity(fs.realpathSync(value.repo));
  const store = generation.initializeStore({ checkoutRoot: identity.checkout, remote: identity.remote });
  const observed = new Date().toISOString();
  generation.decideMigration({ store, observation: { observed_at: observed, active_legacy_run_count: 0, oldest_active_legacy_age_hours: null } });
  const drainedAt = new Date(Date.parse(observed) + 1).toISOString();
  const drained = generation.recordDrainCompleted({
    store,
    inventory: { observed_at: drainedAt, active_legacy_run_count: 0, oldest_active_legacy_age_hours: null },
    actor: "relay-dispatch",
    operationId: `bootstrap-drain-${store.repositoryDigest.slice(0, 24)}`,
  }).inventory;
  const operationId = `bootstrap-vnext-${store.repositoryDigest.slice(0, 24)}`;
  assert.throws(() => generation.switchGeneration({
    store,
    generation: "vnext",
    actor: "relay-dispatch",
    operationId,
    switchedAt: new Date(Date.parse(drainedAt) + 1).toISOString(),
    drainInventoryDigest: drained.inventory_digest,
    fault(stage, filePath) {
      if (stage === "dir_fsync" && filePath.includes("generation-transitions")) throw new Error("crash after receipt");
    },
  }), /crash after receipt/);
  const selected = generation.switchGeneration({ store, generation: "vnext", actor: "relay-dispatch", operationId,
    switchedAt: new Date(Date.parse(drainedAt) + 1).toISOString(), drainInventoryDigest: drained.inventory_digest });
  assert.equal(selected.marker.writer_generation, "vnext");
  assert.equal(selected.marker.transition_operation_id, operationId);
  assert.equal(generation.readEvents(store).filter((event) => event.type === "generation_switched").length, 1);
});

test("attempt_started is durable before executor gate launch, so a launch-window crash cannot orphan work", () => {
  const value = fixture("launch-window");
  const runId = "crash-start-run";
  const crashed = run(value, ["--branch", "crash-start", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--bootstrap-vnext", "--json"], {
    ...value.env,
    RELAY_DISPATCH_INTERNAL_RUN_ID: runId,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${CRASH_AFTER_START}`.trim(),
  });
  assert.equal(crashed.signal, "SIGKILL");
  const runDir = path.join(fixtureRunsDir(value), runId);
  const record = readRunRecord({ runDir });
  const journal = facts.readFacts({ eventsPath: path.join(runDir, "events.jsonl") });
  assert.deepEqual(journal.facts.filter((fact) => fact.type.startsWith("attempt_")).map((fact) => fact.type), ["attempt_started"]);
  assert.equal(fs.existsSync(path.join(record.git.worktree, "executor-change.txt")), false);
  assert.equal(fs.readdirSync(runDir).some((name) => name.endsWith(".executor.json")), false);
});

test("dispatch persists immutable bindings and exact attempt facts but never auto-recovers dirty work", async () => {
  const value = fixture("facts");
  const before = git(value.repo, ["rev-parse", "HEAD"]);
  const result = run(value, [
    "--branch", "issue-7", "--issue-number", "7", "--prompt-file", value.prompt,
    "--rubric-file", value.rubric, "--done-criteria-file", value.rubric,
    "--executor", "codex", "--model", "test/model", "--bootstrap-vnext", "--json",
  ]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const output = json(result.stdout);
  const record = readRunRecord({ runDir: output.run_dir });
  assert.equal(record.git.start_sha, before);
  assert.equal(record.roles.executor, "codex");
  assert.equal(record.parent, null);
  assert.equal(git(record.git.worktree, ["rev-parse", "HEAD"]), before, "default dispatch must not commit executor dirt");
  assert.equal(fs.readFileSync(path.join(record.git.worktree, "executor-change.txt"), "utf8"), "review me\n");
  const journal = facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") });
  const attempt = journal.facts.filter((fact) => fact.type.startsWith("attempt_"));
  assert.deepEqual(attempt.map((fact) => fact.type), ["attempt_started", "attempt_finished"]);
  assert.equal(attempt[0].payload.executor, "codex");
  assert.equal(attempt[0].payload.model, "test/model");
  assert.equal(attempt[1].payload.final_sha, before);
  assert.equal(attempt[1].payload.status, "completed");
  const hostResult = JSON.parse(fs.readFileSync(attempt[1].payload.result_path, "utf8"));
  assert.equal(hostResult.attempt_id, attempt[0].attempt_id);
  assert.equal(hostResult.host_handle, attempt[0].payload.host_handle);
  assert.equal(hostResult.status, "completed");
  assert.equal(output.outcome.status, "succeeded");
  const independentlyInspected = await runtime.inspectRun({ runDir: output.run_dir });
  assert.deepEqual(output.inspection.recommended_action, independentlyInspected.recommended_action);
});

test("the actual executor process tree enforces filesystem/service boundaries and exposes enabled transport honestly", async () => {
  const value = fixture("write-containment");
  installNodeFixture(WRITE_CONTAINMENT_EXECUTOR, path.join(value.root, "bin", "codex"));
  const activeTarget = path.join(value.repo, "active-checkout-escape.txt");
  const siblingTarget = path.join(value.root, "sibling-escape.txt");
  const outsideTarget = path.join(os.tmpdir(), `relay-outside-escape-${crypto.randomUUID()}.txt`);
  const server = spawn(process.execPath, ["-e", "const net=require('net');const s=net.createServer(x=>x.end());s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    let text = "";
    server.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\n")) resolve(Number(text.trim()));
    });
    server.once("error", reject);
    server.once("exit", (code) => { if (!text.includes("\n")) reject(new Error(`network probe server exited ${code}`)); });
  });
  try {
    fs.writeFileSync(value.prompt, JSON.stringify({ active: activeTarget, sibling: siblingTarget, outside: outsideTarget, port }));
    const result = run(value, ["--branch", "contained", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--bootstrap-vnext", "--json"], {
      ...value.env,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const output = json(result.stdout);
    const proof = JSON.parse(fs.readFileSync(path.join(output.worktree, "containment-proof.json"), "utf8"));
    assert.equal(proof.worktree, "written");
    assert.equal(proof.temp, "written");
    assert.match(proof.active, /^denied:/);
    assert.match(proof.sibling, /^denied:/);
    assert.match(proof.outside, /^denied:/);
    assert.equal(proof.network, "connected");
    assert.match(proof.apple_event, /^denied:/);
    for (const label of ["git_add", "git_commit", "git_ref", "git_config", "git_hook"]) {
      assert.match(proof[label], /^denied:/, `${label} must stay owned by canonical recovery`);
    }
    assert.equal(path.dirname(proof.tempdir), output.run_dir);
    assert.match(path.basename(proof.tempdir), /^executor-tmp-dispatch-/);
    assert.equal(fs.existsSync(activeTarget), false);
    assert.equal(fs.existsSync(siblingTarget), false);
    assert.equal(fs.existsSync(outsideTarget), false);
    assert.equal(output.outcome.status, "succeeded");
  } finally {
    server.kill("SIGTERM");
  }
});

test("read-only dispatch denies worktree writes while retaining only result and private temp writes", () => {
  const value = fixture("read-only-containment");
  installNodeFixture(WRITE_CONTAINMENT_EXECUTOR, path.join(value.root, "bin", "codex"));
  fs.writeFileSync(value.prompt, JSON.stringify({ active: path.join(value.repo, "active.txt"), sibling: path.join(value.root, "sibling.txt"),
    outside: path.join(os.tmpdir(), `relay-readonly-${crypto.randomUUID()}`), proof_in_result: true }));
  const result = run(value, ["--branch", "read-only-contained", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--sandbox", "read-only", "--bootstrap-vnext", "--json"], value.env);
  assert.equal(result.status, 0, result.stderr);
  const output = json(result.stdout);
  const proof = JSON.parse(output.outcome.output);
  assert.match(proof.worktree, /^denied:/);
  assert.equal(proof.temp, "written");
  for (const label of ["git_add", "git_commit", "git_ref", "git_config", "git_hook"]) {
    assert.match(proof[label], /^denied:/, `${label} must stay owned by canonical recovery`);
  }
  assert.equal(fs.existsSync(path.join(output.worktree, "worktree-write.txt")), false);
});

test("executor dispatch fails closed on hosts without an enforceable write boundary", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-no-sandbox-")));
  assert.throws(
    () => host.sandboxInvocation({
      role: "executor",
      command: process.execPath,
      args: ["-e", ""],
      readRoots: [root],
      writeRoots: [root],
      platform: "linux",
    }),
    (error) => error.code === "EXECUTOR_WRITE_ISOLATION_UNAVAILABLE",
  );
});

test("an empty adapter result cannot turn an exit-zero host result into a completed attempt", () => {
  const value = fixture("empty-outcome");
  fs.writeFileSync(value.prompt, JSON.stringify({ empty: true }));
  const result = run(value, ["--branch", "empty-outcome", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--bootstrap-vnext", "--json"], value.env);
  assert.notEqual(result.status, 0);
  const output = json(result.stdout);
  assert.equal(output.host_status, "completed");
  assert.equal(output.status, "failed");
  assert.equal(output.outcome.status, "empty");
  const journal = facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") });
  const finished = journal.facts.find((fact) => fact.type === "attempt_finished");
  assert.equal(finished.payload.status, "failed");
  assert.equal(finished.payload.exit_code, 0);
});

test("a malformed structured adapter result cannot turn an exit-zero host result into a completed attempt", () => {
  const value = fixture("malformed-outcome");
  const result = run(value, ["--branch", "malformed-outcome", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--executor", "cline", "--bootstrap-vnext", "--json"]);
  assert.notEqual(result.status, 0);
  const output = json(result.stdout);
  assert.equal(output.host_status, "completed");
  assert.equal(output.status, "failed");
  assert.equal(output.outcome.status, "failed");
  const journal = facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") });
  const finished = journal.facts.find((fact) => fact.type === "attempt_finished");
  assert.equal(finished.payload.status, "failed");
  assert.equal(finished.payload.exit_code, 0);
});

test("detached mode returns a durable launch receipt while a child dispatcher retains the run lock", async () => {
  const value = fixture("detach");
  fs.writeFileSync(value.prompt, JSON.stringify({ delay_ms: 1000 }));
  const started = Date.now();
  const result = run(value, ["--branch", "detached", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--bootstrap-vnext", "--detach", "--json"], {
    ...value.env,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = json(result.stdout);
  assert.equal(output.status, "dispatched");
  assert.ok(Date.now() - started < 5_000);
  assert.ok(output.dispatcher_pid > 0);
  const eventsPath = path.join(output.run_dir, "events.jsonl");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const types = facts.readFacts({ eventsPath }).facts.map((fact) => fact.type);
    if (types.includes("attempt_finished")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("detached dispatcher did not persist attempt_finished");
});

test("a rollback between launch and settlement leaves an authenticated terminal result for canonical recovery", async () => {
  const value = fixture("rollback-window");
  fs.writeFileSync(value.prompt, JSON.stringify({ delay_ms: 700 }));
  const launched = run(value, ["--branch", "rollback-window", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--bootstrap-vnext", "--detach", "--json"], {
    ...value.env,
  });
  assert.equal(launched.status, 0, launched.stderr);
  const output = json(launched.stdout);
  const record = readRunRecord({ runDir: output.run_dir });
  const identity = dispatch.repositoryIdentity(fs.realpathSync(value.repo));
  const store = generation.initializeStore({ checkoutRoot: identity.checkout, remote: identity.remote });
  const currentFacts = facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") }).facts;
  generation.rollbackToLegacy({
    store,
    runIds: [record.run_id],
    loadRunFacts: () => [{ run_id: record.run_id, closed: false, facts: currentFacts }],
    switchedAt: new Date().toISOString(),
    actor: "rollback-test",
    operationId: "rollback-dispatch-window",
  });
  const resultPath = path.join(output.run_dir, `attempt-${output.attempt_id}.result.json`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (!fs.existsSync(resultPath) || processLive(output.dispatcher_pid))) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(fs.existsSync(resultPath), true, "host result must outlive the rejected vNext terminal write");
  assert.equal(facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") }).facts.some((fact) => fact.type === "attempt_finished"), false);
  const inspection = host.inspectOwnership({ runDir: output.run_dir });
  assert.equal(inspection.status, "stale");
  assert.equal(inspection.reason, "terminal_result");
});

test("fleet parent and ownership digest are immutable across redispatch", () => {
  const value = fixture("fleet");
  const ownership = JSON.stringify({ sprint: "backlog/sprints/runtime.md", track: "runtime", component: "dispatch" });
  const first = run(value, ["--branch", "fleet-child", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--fleet-id", "fleet-1", "--ownership-json", ownership, "--bootstrap-vnext", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const output = json(first.stdout);
  const record = readRunRecord({ runDir: output.run_dir });
  assert.deepEqual(record.parent, { kind: "fleet", id: "fleet-1" });
  assert.match(record.ownership_digest, /^[0-9a-f]{64}$/);
  const changed = run(value, ["--run-id", record.run_id, "--prompt", "again", "--executor", "codex", "--fleet-id", "fleet-2", "--ownership-json", ownership, "--json"]);
  assert.notEqual(changed.status, 0);
  assert.equal(json(changed.stderr).code, "RUN_NOT_REDISPATCHABLE");
  assert.deepEqual(readRunRecord({ runDir: output.run_dir }).parent, { kind: "fleet", id: "fleet-1" });
});

test("resume admission accepts only an exact inspect-derived redispatch action", () => {
  const redispatch = {
    derived: { terminal: false, phase: "active", action: "redispatch", reason: "changes_requested" },
    recommended_action: { kind: "redispatch", key: "a".repeat(64) },
  };
  assert.equal(dispatch.assertResumeInspection(redispatch), redispatch);
  assert.throws(
    () => dispatch.assertResumeInspection({ derived: { terminal: true, phase: "terminal", action: "none" }, recommended_action: { kind: "none" } }),
    (error) => error.code === "RUN_TERMINAL",
  );
  for (const kind of ["review", "merge"]) {
    assert.throws(
      () => dispatch.assertResumeInspection({ derived: { terminal: false, phase: "active", action: kind }, recommended_action: { kind } }),
      (error) => error.code === "RUN_NOT_REDISPATCHABLE",
    );
  }
});

test("resume revalidates the exact action key under the acquired run lock before prompt or attempt facts", async () => {
  const value = fixture("resume-lock-barrier");
  const first = run(value, ["--branch", "resume-lock-barrier", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--bootstrap-vnext", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const output = json(first.stdout);
  const beforePrompts = fs.readdirSync(output.run_dir).filter((name) => name.startsWith("prompt-")).sort();
  const beforeAttempts = facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") }).facts.filter((fact) => fact.type.startsWith("attempt_")).length;
  const previousHome = process.env.RELAY_HOME;
  const previousPath = process.env.PATH;
  process.env.RELAY_HOME = value.relayHome;
  process.env.PATH = value.env.PATH;
  let calls = 0;
  const inspectRun = async () => ({
    derived: { terminal: false, phase: "active", action: "redispatch", reason: "changes_requested" },
    recommended_action: { kind: "redispatch", key: (calls++ === 0 ? "a" : "b").repeat(64) },
  });
  try {
    const cli = dispatch.parseCli([value.repo, "--run-id", output.run_id, "--prompt", "retry", "--network-access", "enabled", "--json"]);
    await assert.rejects(dispatch.executeForeground(cli, { inspectRun }), (error) => error.code === "RUN_ACTION_CHANGED");
  } finally {
    if (previousHome === undefined) delete process.env.RELAY_HOME; else process.env.RELAY_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  }
  assert.deepEqual(fs.readdirSync(output.run_dir).filter((name) => name.startsWith("prompt-")).sort(), beforePrompts);
  assert.equal(facts.readFacts({ eventsPath: path.join(output.run_dir, "events.jsonl") }).facts.filter((fact) => fact.type.startsWith("attempt_")).length, beforeAttempts);
});

test("production inspection excludes only the self-held dispatch lock from exact action identity", async () => {
  const value = fixture("production-self-lock");
  const first = run(value, ["--branch", "production-self-lock", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--bootstrap-vnext", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const output = json(first.stdout);
  const record = readRunRecord({ runDir: output.run_dir });
  const before = await runtime.inspectRun({ runDir: output.run_dir });
  const eventsPath = path.join(output.run_dir, "events.jsonl");
  const audit = (fragment, capability) => {
    const eventId = `host-${fragment.audit_key}`;
    const existing = facts.readFacts({ eventsPath }).facts.find((fact) => fact.event_id === eventId);
    const fact = facts.factFromHostAudit({
      runId: output.run_id,
      eventId,
      at: existing?.at || new Date().toISOString(),
      actor: "relay-host",
      audit: fragment,
    });
    facts.appendFact({ eventsPath, lockContext: capability, fact });
    return { durable: true, idempotent: true, audit_key: fragment.audit_key };
  };
  const lockContext = host.acquireRunLock({
    runDir: output.run_dir,
    attemptId: `dispatch-self-${crypto.randomBytes(4).toString("hex")}`,
    operation: "dispatch",
    hostKind: "local_supervisor",
    hostHandle: `dispatch-self:${process.pid}`,
    worktreeDir: record.git.worktree,
    audit,
  });
  try {
    await assert.rejects(runtime.inspectRun({
      runDir: output.run_dir,
      activeRunLock: Object.freeze({ lock_id: lockContext.lock_id, operation: "dispatch" }),
    }), /issued run lock|lock capability/i);
    const self = await runtime.inspectRun({
      runDir: output.run_dir,
      activeRunLock: lockContext,
    });
    const foreign = await runtime.inspectRun({ runDir: output.run_dir });
    assert.equal(self.observations.host.live, false);
    assert.equal(self.recommended_action.key, before.recommended_action.key);
    assert.equal(foreign.observations.host.live, true);
    assert.notEqual(foreign.recommended_action.key, before.recommended_action.key);
  } finally {
    host.releaseRunLock(lockContext, { outcome: "test_complete", audit });
  }
});

test("a denied resume writes no prompt, attempt, or fact before failing closed", () => {
  const value = fixture("resume-gate");
  const first = run(value, ["--branch", "resume-gate", "--prompt-file", value.prompt, "--rubric-file", value.rubric, "--bootstrap-vnext", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const output = json(first.stdout);
  const beforeFiles = fs.readdirSync(output.run_dir).sort();
  const eventsPath = path.join(output.run_dir, "events.jsonl");
  const beforeFacts = facts.readFacts({ eventsPath }).facts;

  const denied = run(value, ["--run-id", output.run_id, "--prompt-file", path.join(value.root, "missing-retry.md"), "--json"]);
  assert.notEqual(denied.status, 0);
  assert.equal(json(denied.stderr).code, "RUN_NOT_REDISPATCHABLE");
  assert.deepEqual(fs.readdirSync(output.run_dir).sort(), beforeFiles);
  assert.deepEqual(facts.readFacts({ eventsPath }).facts, beforeFacts);
});
