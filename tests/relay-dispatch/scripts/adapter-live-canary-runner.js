"use strict";

// Test-only release evidence. Live invocations cross the production reviewer or
// executor-host boundary; this file owns fixtures, the acceptance matrix, and
// redacted evidence only.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const host = require("../../../skills/relay-dispatch/scripts/host");
const runStore = require("../../../skills/relay-dispatch/scripts/run-store");
const { ADAPTER_PHASES, getAdapter, listAdapters } = require("../../../skills/relay-dispatch/scripts/adapters");
const { credentialRequest, resolveAdapterProvider } = require("../../../skills/relay-dispatch/scripts/adapter-contract");

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const PHASES = Object.freeze([ADAPTER_PHASES.DISPATCH, ADAPTER_PHASES.PRIMARY_REVIEW]);
const AUTH_FAILURE = /\b(auth(?:entication|orization)?|credential|login|log in|api[_ -]?key|token)\b.{0,100}\b(missing|required|invalid|failed|unavailable|not found|not set|expired|denied)\b|\b(not authenticated|not logged in|unauthorized|forbidden|no api key found)\b/i;
const ENVIRONMENT_FAILURE = /\b(operation not permitted|readonly database|sqlite_readonly|filesystem\.open|bind: operation not permitted|filesystem isolation unavailable)\b/i;
const PRIMARY_MODELS = Object.freeze({ opencode: "opencode-go/glm-5.2", pi: "qwen-token-plan/qwen3.8-max-preview" });
const SHA256_RE = /^[a-f0-9]{64}$/;
// Structural reports remain useful after JSON serialization, but release
// authority belongs only to the production matrix executed by this process.
// A caller-supplied adapter matrix must never mint release evidence.
const FRESH_PRODUCTION_RUNS = new WeakSet();

function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function runGit(repo, args, encoding = "utf8") {
  return execFileSync("git", ["-C", repo, ...args], { encoding, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function treeEntries(root) {
  const entries = [];
  function visit(directory, prefix = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name), relative = path.join(prefix, name), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) entries.push([relative, "link", fs.readlinkSync(absolute)]);
      else if (stat.isDirectory()) { entries.push([relative, "dir", stat.mode & 0o777]); visit(absolute, relative); }
      else if (stat.isFile()) entries.push([relative, "file", stat.mode & 0o777, sha(fs.readFileSync(absolute))]);
      else entries.push([relative, "other", stat.mode]);
    }
  }
  visit(root);
  return entries;
}
function snapshotFixture(fixture) {
  return Object.freeze({
    worktree_entries: treeEntries(fixture.worktree), repository_digest: sha(Buffer.from(JSON.stringify(treeEntries(fixture.repo)))),
    head: runGit(fixture.worktree, ["rev-parse", "HEAD"]), index: runGit(fixture.worktree, ["write-tree"]),
    refs: runGit(fixture.worktree, ["for-each-ref", "--format=%(refname)%00%(objectname)"]),
    config: runGit(fixture.worktree, ["config", "--local", "--null", "--list"]),
    outside_digest: sha(Buffer.from(JSON.stringify(treeEntries(fixture.outside)))),
  });
}
function sameSnapshot(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function quietWindow(milliseconds = 250) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }

function initializeFixture(root, outsideBase, adapterName, phase = null) {
  const fixtureId = phase ? `${adapterName}-${phase}` : adapterName;
  let fixtureRoot = path.join(root, fixtureId); fs.mkdirSync(fixtureRoot); fixtureRoot = fs.realpathSync(fixtureRoot);
  const repo = path.join(fixtureRoot, "repository"), worktree = path.join(fixtureRoot, "worktree");
  fs.mkdirSync(repo); runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["config", "user.email", "adapter-canary@example.test"]); runGit(repo, ["config", "user.name", "adapter canary"]);
  fs.writeFileSync(path.join(repo, "README.md"), "adapter live canary\n");
  runGit(repo, ["add", "README.md"]); runGit(repo, ["commit", "-q", "-m", "canary fixture"]);
  runGit(repo, ["worktree", "add", "-q", "-b", `canary-${fixtureId}`, worktree]);
  const runId = `canary-${fixtureId}`, runDir = path.join(fixtureRoot, runId); fs.mkdirSync(runDir);
  const criteriaSource = path.join(runDir, "criteria.source"); fs.writeFileSync(criteriaSource, "Satisfy the exact nonce canary contract.\n");
  const frozen = runStore.freezeDoneCriteria({ sourcePath: criteriaSource, runDir }); fs.unlinkSync(criteriaSource);
  const startSha = runGit(worktree, ["rev-parse", "HEAD"]);
  const record = { version: runStore.RUN_VERSION, run_id: runId, repo: { root: runStore.canonicalRepository(repo), remote: "canary://local" },
    git: { branch: `canary-${fixtureId}`, base_branch: "main", worktree, start_sha: startSha },
    contract: { done_criteria_path: frozen.path, done_criteria_sha256: frozen.sha256 },
    roles: { orchestrator: "canary", executor: adapterName, reviewer: adapterName }, parent: null, ownership_digest: null, created_at: new Date().toISOString() };
  runStore.createRunRecord({ runDir, record });
  let outside = path.join(outsideBase, fixtureId); fs.mkdirSync(outside); outside = fs.realpathSync(outside); fs.writeFileSync(path.join(outside, "sentinel"), "outside sentinel\n");
  return { root: fixtureRoot, repo, worktree, runDir, record, outside };
}

function validateCanaryVerdict(value, nonce) {
  const invalid = (message) => { const error = new Error(message); error.code = "CANARY_NONCE_INVALID"; throw error; };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("canary verdict must be an object");
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "nonce")) invalid("canary verdict must contain exactly the nonce key");
  if (value.nonce !== nonce) invalid("canary verdict nonce mismatch");
  return value;
}
function classifyFailure(error, provisioned = false) {
  const detail = String(error?.message || error || "");
  const failure = (status, reason, type, code) => ({ status, reason, failure: { type, code } });
  if (error?.code === "HOST_CLEANUP_INCOMPLETE" || error?.runtime_audit?.status === "cleanup_incomplete") {
    return failure("failed", "host_cleanup_incomplete", "cleanup", "HOST_CLEANUP_INCOMPLETE");
  }
  if (new Set(["UNTRUSTED_CREDENTIAL", "INVALID_CREDENTIAL", "CREDENTIAL_CHANGED", "CREDENTIAL_MISSING"]).has(error?.code)) {
    return failure("failed", "credential_source_rejected", "credential_staging", error.code);
  }
  if (error?.code === "CREDENTIAL_NETWORK_ISOLATION_UNAVAILABLE") return failure("failed", "credential_network_isolation_unavailable", "sandbox", error.code);
  if (error?.failure_reason === "credentials_unavailable") return provisioned ? failure("failed", "credential_auth_failed", "authentication", "AUTHENTICATION_FAILED") : { status: "not_run", reason: "not_run_credentials_unavailable" };
  if (error?.failure_reason === "execution_environment_unavailable") return failure("failed", "sandbox_environment_failed", "sandbox", "EXECUTION_ENVIRONMENT_UNAVAILABLE");
  if (new Set(["CANARY_OUTPUT_INVALID", "CANARY_NONCE_INVALID"]).has(error?.code)) return failure("failed", "canary_output_invalid", "output", error.code);
  if (/timed.?out|ETIMEDOUT/i.test(detail)) return failure("failed", "invocation_timeout", "timeout", "INVOCATION_TIMEOUT");
  if (/process (?:group|scope) survived|escaped process audit failed/i.test(detail)) return failure("failed", "process_scope_survived", "cleanup", "PROCESS_SCOPE_SURVIVED");
  if (AUTH_FAILURE.test(detail)) return provisioned ? failure("failed", "credential_auth_failed", "authentication", "AUTHENTICATION_FAILED") : { status: "not_run", reason: "not_run_credentials_unavailable" };
  if (ENVIRONMENT_FAILURE.test(detail)) return failure("failed", "sandbox_environment_failed", "sandbox", "SANDBOX_DENIED");
  return failure("failed", "invocation_failed", "invocation", error?.code && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : "INVOCATION_FAILED");
}
function cleanupProof(error) {
  return { reported: true, terminal_status: error?.runtime_audit?.status || null,
    ...(SHA256_RE.test(error?.cleanup_sha256 || "") ? { artifact_sha256: error.cleanup_sha256 } : {}) };
}
function resolveExecutable(command) {
  const candidates = path.isAbsolute(command) ? [command] : String(process.env.PATH || "").split(path.delimiter).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); const real = fs.realpathSync(candidate), stat = fs.statSync(real); return { name: path.basename(real), dev: stat.dev, ino: stat.ino, mode: stat.mode, sha256: sha(fs.readFileSync(real)) }; } catch {}
  }
  return null;
}
function probeEvidence(adapter, probe) {
  return { status: probe.status, version: probe.raw ? String(probe.raw).split(/\r?\n/, 1)[0].slice(0, 160) : null,
    executable: probe.status === "available" ? resolveExecutable(
      (adapter.metadata?.cliBinaryEnv && process.env[adapter.metadata.cliBinaryEnv]) || adapter.metadata?.cliBinary || adapter.name,
    ) : null };
}
function invocationDigest(invocation) { return sha(Buffer.from(JSON.stringify({ command: path.basename(invocation.command), args: invocation.args, stdin_sha256: invocation.stdinSha256 || null, private_env_paths: invocation.privateEnvPaths }))); }
function executedRuntimeEvidence(files) {
  if (!Array.isArray(files) || !files.length) throw new Error("canary execution has no authoritative runtime binding");
  const executable = files[0], fields = ["path", "dev", "ino", "size", "sha256"];
  if (fields.some((key) => executable[key] === undefined) || !SHA256_RE.test(executable.sha256 || "")) throw new Error("canary executable runtime binding is invalid");
  return { digest: sha(Buffer.from(JSON.stringify(files))), executable: Object.fromEntries(fields.map((key) => [key, executable[key]])) };
}
function credentialsFor(adapter, phase, selections) {
  const key = `${adapter.name}:${phase}`, selected = selections?.[key];
  if (!selected || (!selected.envNames?.length && !selected.fileSpecs?.length)) return null;
  const request = credentialRequest(adapter.metadata?.credentials, { envNames: selected.envNames || [], fileSpecs: selected.fileSpecs || [] });
  const env = Object.fromEntries(request.envNames.map((name) => [name, process.env[name]]));
  if (Object.values(env).some((value) => typeof value !== "string" || value.length === 0)) return null;
  return { ...request, env, public: request.summary };
}
function phasePrompt(fixture, phase, nonce) {
  const promptPath = path.join(fixture.runDir, `${phase}-${nonce}.prompt.md`);
  const artifactName = `RELAY_CANARY_${nonce}.txt`;
  const text = phase === ADAPTER_PHASES.DISPATCH
    ? `Create exactly one file named ${artifactName} in the repository root with exact UTF-8 bytes ${nonce} followed by one newline. Do not modify any other path.\n`
    : `Do not modify any file. Return exactly {"nonce":"${nonce}"} with no other key or text.\n`;
  fs.writeFileSync(promptPath, text, { mode: 0o600 });
  return { path: promptPath, bytes: Buffer.from(text), digest: sha(Buffer.from(text)), artifactName };
}
function reviewRequest(fixture, prompt, nonce) {
  const diffPath = path.join(fixture.runDir, `${nonce}.review.diff`); fs.writeFileSync(diffPath, "diff --git a/README.md b/README.md\n", { mode: 0o600 });
  const schema = { type: "object", properties: { nonce: { type: "string", const: nonce } }, required: ["nonce"], additionalProperties: false };
  return { diff_path: diffPath, prompt_path: prompt.path, done_criteria_path: fixture.record.contract.done_criteria_path,
    reviewed_sha: fixture.record.git.start_sha, current_sha: fixture.record.git.start_sha,
    diff_sha256: sha(fs.readFileSync(diffPath)), prompt_sha256: prompt.digest, schema };
}
function runReviewAttempt(fixture, adapter, model, timeoutMs, credentials, prompt, nonce, toolNetwork) {
  let invocation;
  const outcome = runStore.invokeIndependentReviewer({ runDir: fixture.runDir, request: reviewRequest(fixture, prompt, nonce), timeoutMs,
    credentialRequest: credentials,
    buildInvocation: ({ cwd, promptPath, promptBytes, resultPath, schemaPath }) => {
      invocation = adapter.buildInvocation({ phase: ADAPTER_PHASES.PRIMARY_REVIEW, cwd, promptPath, promptBytes,
        resultPath, schemaPath, model, timeoutMs, sandbox: "read-only", networkAccess: toolNetwork.access }); return invocation;
    }, parseOutcome: (input) => adapter.parseOutcome(input) });
  return { outcome, invocation };
}
async function runDispatchAttempt(fixture, adapter, model, timeoutMs, credentials, prompt, toolNetwork, onCleanupIncomplete) {
  const attemptId = `canary-${crypto.randomBytes(6).toString("hex")}`, executorResultPath = path.join(fixture.runDir, `${attemptId}.executor-output`);
  const invocation = adapter.buildInvocation({ phase: ADAPTER_PHASES.DISPATCH, cwd: fixture.worktree,
    promptPath: prompt.path, promptBytes: prompt.bytes, resultPath: executorResultPath, model, timeoutMs,
    sandbox: "workspace-write", networkAccess: toolNetwork.access });
  const capability = host.acquireRunLock({ runDir: fixture.runDir, attemptId, operation: "canary", hostHandle: `canary:${attemptId}`, worktreeDir: fixture.worktree });
  let receipt, terminal, ownershipSettled = false;
  try {
    receipt = host.launchLocalSupervisor({ runDir: fixture.runDir, attemptId, command: invocation.command, args: invocation.args,
      trustedWorktreeRoot: fixture.worktree, cwd: invocation.cwd, inputFiles: [prompt.path], stdinPath: invocation.stdinPath,
      stdinSha256: invocation.stdinSha256, executorResultPath, executorSandbox: "workspace-write", executorNetworkAccess: toolNetwork.access,
      timeoutMs, credentialRequest: credentials, processContainment: adapter.metadata.processContainment, runtimeDependencies: invocation.runtimeDependencies,
      privateEnvPaths: invocation.privateEnvPaths, testCleanupFailurePath: fixture.testCleanupFailurePath || null, lockContext: capability });
    terminal = await host.waitForTerminalResult(receipt, { timeoutMs: timeoutMs + 10_000 });
    const outcome = adapter.parseOutcome({ phase: ADAPTER_PHASES.DISPATCH, exitCode: terminal.exit_code, signal: terminal.signal,
      timedOut: terminal.status === "timed_out", cancelled: terminal.status === "cancelled", stdoutPath: receipt.stdout_path,
      stderrPath: receipt.stderr_path, resultPath: executorResultPath });
    if (terminal.status !== "completed" || terminal.exit_code !== 0 || outcome.status !== "succeeded") {
      const stderr = fs.existsSync(receipt.stderr_path) ? fs.readFileSync(receipt.stderr_path, "utf8") : outcome.summary;
      const error = new Error(stderr || terminal.error || "dispatch failed"); error.runtime_audit = terminal; throw error;
    }
    return { outcome, invocation, terminal, stdoutPath: receipt.stdout_path, executedRuntime: receipt.runtime_files };
  } catch (error) {
    if (receipt && !terminal) {
      try {
        if (error?.code === "HOST_CLEANUP_INCOMPLETE" && onCleanupIncomplete) onCleanupIncomplete(fixture, error);
        host.cancelHost(receipt, { reason: "live_canary_post_receipt_failure" });
        try { terminal = await host.waitForTerminalResult(receipt, { timeoutMs: 10_000 }); }
        catch {
          await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: fixture.runDir }), reason: "settle live canary post-receipt failure" });
          ownershipSettled = true; terminal = await host.waitForTerminalResult(receipt);
        }
        error.runtime_audit = terminal;
      } catch (settlementError) {
        const unsettled = new Error("live canary cleanup could not be settled; fixture evidence must be preserved");
        unsettled.code = "CANARY_CLEANUP_UNSETTLED"; unsettled.cause = settlementError;
        unsettled.originalError = error; unsettled.preserveCanaryEvidence = true; throw unsettled;
      }
    }
    throw error;
  } finally { if (receipt && terminal && !ownershipSettled) host.releaseRunLock(capability, { outcome: terminal.status }); }
}
function dispatchMutationAssessment(before, after, fixture, prompt, nonce) {
  const target = path.join(fixture.worktree, prompt.artifactName), expected = Buffer.from(`${nonce}\n`);
  const filtered = after.worktree_entries.filter((entry) => entry[0] !== prompt.artifactName);
  const stable = { ...after, worktree_entries: filtered };
  if (!fs.existsSync(target)) return { boundary: sameSnapshot(before, after), expected: false };
  const boundary = sameSnapshot(before, stable) && runGit(fixture.worktree, ["status", "--porcelain=v1", "-z"]) === `?? ${prompt.artifactName}\0`;
  const stat = fs.lstatSync(target), exact = !stat.isSymbolicLink() && stat.isFile() && fs.readFileSync(target).equals(expected);
  return { boundary, expected: boundary && exact };
}

async function runCell(adapter, phase, fixture, { timeoutMs, credentialSelections, onFixture, onError, onCleanupIncomplete }) {
  const model = PRIMARY_MODELS[adapter.name] || null, nonce = crypto.randomBytes(16).toString("hex"), prompt = phasePrompt(fixture, phase, nonce);
  const capability = adapter.capabilities({ phase }), nativeToolNetwork = capability.networkControl === "native";
  const toolNetwork = { access: nativeToolNetwork ? "disabled" : "enabled", enforcement: nativeToolNetwork ? "native" : "unsupported_explicit_enabled" };
  const base = { adapter: adapter.name, phase, model: model || "default", provider: resolveAdapterProvider(adapter, model),
    tool_network_access: toolNetwork.access, tool_network_enforcement: toolNetwork.enforcement,
    nonce_sha256: sha(Buffer.from(nonce)), prompt_sha256: prompt.digest };
  const probe = adapter.probe({ timeoutMs: Math.min(timeoutMs, 10_000) }), probeRecord = probeEvidence(adapter, probe);
  if (probe.status !== "available") return { ...base, status: "not_run", reason: probe.status === "skipped" ? "not_run_cli_unavailable" : "not_run_probe_failed", probe: probeRecord, checks: {} };
  if (capability.credentialTransport === "unrepresentable") return { ...base, status: "not_run", reason: "not_run_credentials_unrepresentable",
    blocker: { type: "credentials_unrepresentable", code: "CREDENTIALS_UNREPRESENTABLE" }, probe: probeRecord, credential_request: { env_names: [], file_ids: [] }, checks: {} };
  const credentials = credentialsFor(adapter, phase, credentialSelections);
  if (!credentials) return { ...base, status: "not_run", reason: "not_run_credentials_unavailable", probe: probeRecord,
    credential_request: { env_names: [], file_ids: [] }, checks: {} };
  const before = snapshotFixture(fixture), started = Date.now(); if (onFixture) onFixture(fixture, adapter, phase);
  const executionCredentials = adapter.metadata?.providerDefault === "test" ? null : credentials;
  try {
    const execution = phase === ADAPTER_PHASES.DISPATCH
      ? await runDispatchAttempt(fixture, adapter, model, timeoutMs, executionCredentials, prompt, toolNetwork, onCleanupIncomplete)
      : runReviewAttempt(fixture, adapter, model, timeoutMs, executionCredentials, prompt, nonce, toolNetwork);
    if (phase === ADAPTER_PHASES.PRIMARY_REVIEW) validateCanaryVerdict(execution.outcome.output, nonce);
    quietWindow(); const after = snapshotFixture(fixture), dispatchAssessment = phase === ADAPTER_PHASES.DISPATCH
      ? dispatchMutationAssessment(before, after, fixture, prompt, nonce) : null;
    const boundary = dispatchAssessment ? dispatchAssessment.boundary : sameSnapshot(before, after);
    if (!boundary) throw new Error("canary repository, Git metadata, or outside boundary mutated");
    const processAbsent = execution.outcome.runtime_audit?.process_group_absent
      ?? (execution.terminal?.status === "completed" && !execution.terminal?.error ? true : execution.terminal?.process_group_absent);
    if (processAbsent !== true) throw new Error("canary has no production process-group absence proof");
    if (dispatchAssessment && !dispatchAssessment.expected) {
      const error = new Error("canary dispatch did not produce the exact nonce artifact"); error.code = "CANARY_OUTPUT_INVALID";
      error.runtime_audit = { process_group_absent: true }; throw error;
    }
    const outputBytes = phase === ADAPTER_PHASES.DISPATCH
      ? fs.readFileSync(path.join(fixture.worktree, prompt.artifactName))
      : Buffer.from(JSON.stringify(execution.outcome.output));
    const executedRuntime = executedRuntimeEvidence(execution.executedRuntime || execution.outcome.executed_runtime);
    return { ...base, status: "passed", reason: "production_path_passed", probe: probeRecord, credential_request: credentials.public, executed_runtime: executedRuntime,
      invocation_sha256: invocationDigest(execution.invocation), output_sha256: sha(outputBytes), checks: { boundary: "passed", nonce: "passed",
        cleanup: "passed", process_scope_absent: "passed", elapsed_ms: Date.now() - started } };
  } catch (error) {
    if (error?.preserveCanaryEvidence === true) throw error;
    if (onError) onError(error, adapter, phase); quietWindow(); const after = snapshotFixture(fixture), classified = classifyFailure(error, true);
    const boundary = phase === ADAPTER_PHASES.DISPATCH ? dispatchMutationAssessment(before, after, fixture, prompt, nonce).boundary : sameSnapshot(before, after);
    if (!boundary && classified.failure?.type !== "cleanup") Object.assign(classified, { reason: "boundary_mutated", failure: { type: "boundary", code: "BOUNDARY_MUTATED" } });
    const notStarted = classified.failure?.type === "credential_staging", cleanupFailed = classified.failure?.type === "cleanup", runtimeAudit = error.runtime_audit;
    const cleanup = notStarted ? "not_started" : cleanupFailed ? "failed" : runtimeAudit?.process_group_absent === true ? "passed" : "unknown";
    return { ...base, ...classified, probe: probeRecord, credential_request: credentials.public,
      checks: { boundary: boundary ? "passed" : "failed", nonce: "failed", cleanup,
        process_scope_absent: notStarted ? "not_started" : runtimeAudit?.process_group_absent === true ? "passed" : "unknown", elapsed_ms: Date.now() - started },
      ...(cleanupFailed ? { cleanup_proof: cleanupProof(error) } : {}) };
  }
}

function requiredMatrix(adapters) {
  return adapters.flatMap((adapter) => PHASES.filter((phase) => phase === ADAPTER_PHASES.DISPATCH || adapter.capabilities({ phase }).supported)
    .map((phase) => `${adapter.name}:${phase}`));
}
function resolveLocalModule(parent, specifier) {
  const root = path.resolve(path.dirname(parent), specifier), candidates = [root, `${root}.js`, path.join(root, "index.js")];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!resolved) throw new Error(`canary runtime dependency cannot be resolved: ${specifier} from ${parent}`);
  return fs.realpathSync(resolved);
}
function canonicalRuntimePaths() {
  const pending = [path.join(PROJECT_ROOT, "skills/relay-dispatch/scripts/dispatch.js"), path.join(PROJECT_ROOT, "skills/relay-review/scripts/review-runner.js")], seen = new Set();
  while (pending.length) {
    const file = fs.realpathSync(pending.pop()); if (seen.has(file)) continue; seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\brequire\s*\(\s*([^)]*?)\s*\)/g)) {
      const literal = match[1].match(/^["']([^"']+)["']$/);
      if (!literal) throw new Error(`canary runtime dependency must use a literal require: ${file}`);
      if (literal[1].startsWith(".")) pending.push(resolveLocalModule(file, literal[1]));
    }
  }
  return [...seen].sort((left, right) => path.relative(PROJECT_ROOT, left).localeCompare(path.relative(PROJECT_ROOT, right)));
}
function canonicalRuntimeSha256Keys() { return canonicalRuntimePaths().map((file) => path.relative(PROJECT_ROOT, file)); }
function sourceProvenance() {
  const runnerPath = __filename, runtimePaths = canonicalRuntimePaths();
  const hash = crypto.createHash("sha256"), gitBytes = (args) => execFileSync("git", ["-C", PROJECT_ROOT, ...args], { encoding: null, stdio: ["ignore", "pipe", "pipe"] });
  hash.update(gitBytes(["status", "--porcelain=v1", "-z", "--untracked-files=all"])); hash.update(gitBytes(["diff", "--binary", "HEAD", "--"]));
  const untracked = gitBytes(["ls-files", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean).sort();
  for (const relative of untracked) {
    const absolute = path.join(PROJECT_ROOT, relative), stat = fs.lstatSync(absolute); hash.update(Buffer.from(`\0${relative}\0${stat.mode}\0`));
    if (stat.isSymbolicLink()) hash.update(Buffer.from(fs.readlinkSync(absolute))); else if (stat.isFile()) hash.update(fs.readFileSync(absolute));
  }
  return { git_head: runGit(PROJECT_ROOT, ["rev-parse", "HEAD"]), git_tree: runGit(PROJECT_ROOT, ["rev-parse", "HEAD^{tree}"]),
    dirty_digest: hash.digest("hex"), runner_sha256: sha(fs.readFileSync(runnerPath)),
    runtime_sha256: Object.fromEntries(runtimePaths.map((file) => [path.relative(PROJECT_ROOT, file), sha(fs.readFileSync(file))])), platform: process.platform, arch: process.arch, node: process.version };
}
async function runCanaries(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new Error("canary options must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) throw new Error("canary options cannot contain accessors");
  const own = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  const { timeoutMs = 120_000, credentialSelections = {}, onFixture = null, onError = null, onCleanupIncomplete = null } = own;
  if (onCleanupIncomplete !== null && typeof onCleanupIncomplete !== "function") throw new Error("onCleanupIncomplete must be a function");
  const customMatrix = Object.hasOwn(own, "adapters");
  const productionMatrix = !customMatrix && onFixture === null && onError === null && onCleanupIncomplete === null;
  const adapters = customMatrix ? own.adapters : listAdapters().map(getAdapter);
  if (!Array.isArray(adapters)) throw new Error("canary adapters must be an array");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-adapter-live-canary-")), outsideBase = fs.mkdtempSync(path.join(os.tmpdir(), "relay-adapter-live-canary-outside-"));
  let preserveEvidence = false;
  try {
    // This is a release authority boundary, not a best-effort diagnostic: the
    // complete production source must stay byte-identical throughout all cells.
    const provenanceBefore = sourceProvenance();
    const results = [];
    for (const adapter of adapters) {
      for (const phase of PHASES) if (phase === ADAPTER_PHASES.DISPATCH || adapter.capabilities({ phase }).supported) {
        const fixture = initializeFixture(root, outsideBase, adapter.name, phase);
        results.push(await runCell(adapter, phase, fixture, { timeoutMs, credentialSelections, onFixture, onError, onCleanupIncomplete }));
      }
    }
    const required = requiredMatrix(adapters), completed = results.filter((entry) => entry.status === "passed").map((entry) => `${entry.adapter}:${entry.phase}`);
    const summary = { required: required.length, passed: completed.length, not_run: results.filter((entry) => entry.status === "not_run").length,
      failed: results.filter((entry) => entry.status === "failed").length, missing: required.filter((cell) => !completed.includes(cell)) };
    const provenanceAfter = sourceProvenance(), sourceUnchanged = JSON.stringify(provenanceBefore) === JSON.stringify(provenanceAfter);
    const report = deepFreeze({ schema_version: 2, evidence_status: sourceUnchanged && summary.passed === summary.required && summary.not_run === 0 && summary.failed === 0 ? "release_complete" : "incomplete_non_release",
      generated_at: new Date().toISOString(), timeout_ms: timeoutMs, provenance: provenanceBefore, provenance_after: provenanceAfter,
      policy: { required_cells: required, acceptance: "every required cell must pass its production phase; not_run, skip, failure, and fallback are non-release" },
      results, summary });
    if (productionMatrix && sourceUnchanged) FRESH_PRODUCTION_RUNS.add(report);
    return report;
  } catch (error) {
    if (error?.preserveCanaryEvidence === true) {
      preserveEvidence = true;
      error.message = `live canary aborted with cleanup evidence preserved at ${root} and ${outsideBase}`;
    }
    throw error;
  } finally {
    if (!preserveEvidence) { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outsideBase, { recursive: true, force: true }); }
  }
}
function currentSourceMatches(provenance) {
  const current = sourceProvenance();
  return JSON.stringify(provenance) === JSON.stringify(current);
}
function validateReport(report, { requireCurrentSource = false } = {}) {
  if (report?.schema_version !== 2 || !Array.isArray(report?.policy?.required_cells) || !Array.isArray(report?.results)) throw new Error("canary report schema invalid");
  const provenance = report.provenance;
  const validProvenance = (value) => value && /^[a-f0-9]{40}$/.test(value.git_head || "") && /^[a-f0-9]{40}$/.test(value.git_tree || "")
    && SHA256_RE.test(value.dirty_digest || "") && SHA256_RE.test(value.runner_sha256 || "")
    && value.runtime_sha256 && JSON.stringify(Object.keys(value.runtime_sha256).sort()) === JSON.stringify(canonicalRuntimeSha256Keys().sort())
    && Object.values(value.runtime_sha256).every((value) => SHA256_RE.test(value)) && value.platform && value.arch && value.node;
  if (!validProvenance(provenance)
    || (report.provenance_after !== undefined && (!validProvenance(report.provenance_after)
      || JSON.stringify(provenance) !== JSON.stringify(report.provenance_after)))) throw new Error("canary report provenance invalid");
  const canonical = requiredMatrix(listAdapters().map(getAdapter)), keys = report.results.map((entry) => `${entry.adapter}:${entry.phase}`);
  if (JSON.stringify(report.policy.required_cells) !== JSON.stringify(canonical) || JSON.stringify(keys) !== JSON.stringify(canonical)) throw new Error("canary report phase coverage invalid");
  if (report.results.some((entry) => !["passed", "failed", "not_run"].includes(entry.status))) throw new Error("canary report status invalid");
  for (const entry of report.results) {
    if (!SHA256_RE.test(entry.nonce_sha256 || "") || !SHA256_RE.test(entry.prompt_sha256 || "") || !entry.probe
      || Object.hasOwn(entry, "fallback") || Object.hasOwn(entry, "credential_source") || Object.hasOwn(entry, "credential_values")) throw new Error("canary report cell evidence invalid");
    if (!((entry.tool_network_access === "disabled" && entry.tool_network_enforcement === "native")
        || (entry.tool_network_access === "enabled" && entry.tool_network_enforcement === "unsupported_explicit_enabled"))) {
      throw new Error("canary report tool-network evidence invalid");
    }
    if (entry.status === "passed" && (!SHA256_RE.test(entry.invocation_sha256 || "") || !SHA256_RE.test(entry.output_sha256 || "")
      || !SHA256_RE.test(entry.executed_runtime?.digest || "") || !SHA256_RE.test(entry.executed_runtime?.executable?.sha256 || "")
      || typeof entry.executed_runtime?.executable?.path !== "string" || !["dev", "ino", "size"].every((key) => Number.isInteger(entry.executed_runtime.executable[key]))
      || !["boundary", "nonce", "cleanup", "process_scope_absent"].every((key) => entry.checks?.[key] === "passed"))) throw new Error("canary report passed-cell evidence invalid");
    if (entry.failure?.type === "cleanup" && !(entry.failure.code === "HOST_CLEANUP_INCOMPLETE" && entry.checks?.cleanup === "failed"
      && entry.cleanup_proof?.reported === true && Object.hasOwn(entry.cleanup_proof, "terminal_status")
      && (!Object.hasOwn(entry.cleanup_proof, "artifact_sha256") || SHA256_RE.test(entry.cleanup_proof.artifact_sha256)))) throw new Error("canary report cleanup proof invalid");
    if (entry.credential_request && (!Array.isArray(entry.credential_request.env_names) || !Array.isArray(entry.credential_request.file_ids))) throw new Error("canary report credential evidence invalid");
  }
  const passed = report.results.filter((entry) => entry.status === "passed").length, failed = report.results.filter((entry) => entry.status === "failed").length,
    notRun = report.results.filter((entry) => entry.status === "not_run").length, missing = report.policy.required_cells.filter((cell) => {
      const entry = report.results.find((item) => `${item.adapter}:${item.phase}` === cell); return entry?.status !== "passed";
    });
  if (report.summary?.required !== keys.length || report.summary.passed !== passed || report.summary.failed !== failed
    || report.summary.not_run !== notRun || JSON.stringify(report.summary.missing) !== JSON.stringify(missing)) throw new Error("canary report summary integrity invalid");
  const sourceUnchanged = report.provenance_after !== undefined && JSON.stringify(provenance) === JSON.stringify(report.provenance_after);
  const expectedStatus = sourceUnchanged && passed === keys.length && failed === 0 && notRun === 0 ? "release_complete" : "incomplete_non_release";
  if (report.evidence_status !== expectedStatus) throw new Error("canary report evidence status invalid");
  if (report.evidence_status === "release_complete" && report.provenance_after === undefined) throw new Error("release canary report lacks before-and-after provenance");
  if (requireCurrentSource && !currentSourceMatches(provenance)) throw new Error("canary report does not bind the current runtime source");
  return report;
}
function canaryExitCode(report) {
  try { validateReport(report, { requireCurrentSource: true }); } catch { return 1; }
  return FRESH_PRODUCTION_RUNS.has(report) && report.summary.required === report.policy.required_cells.length && report.summary.passed === report.summary.required
    && report.summary.failed === 0 && report.summary.not_run === 0 && report.summary.missing.length === 0 ? 0 : 1;
}
function parseCredentialArgs(argv) {
  const selections = {}, consumed = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]; if (!["--credential-env", "--credential-file"].includes(flag)) continue;
    const value = argv[index + 1]; if (!value || value.startsWith("--")) throw new Error(`${flag} requires adapter:phase:value`);
    const match = value.match(/^([a-z0-9-]+):(dispatch|primary_review):(.+)$/); if (!match) throw new Error(`${flag} requires adapter:phase:value`);
    const key = `${match[1]}:${match[2]}`, selection = selections[key] ||= { envNames: [], fileSpecs: [] };
    (flag === "--credential-env" ? selection.envNames : selection.fileSpecs).push(match[3]); consumed.add(index); consumed.add(index + 1); index += 1;
  }
  return { selections, argv: argv.filter((unused, index) => !consumed.has(index)) };
}
async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: node tests/relay-dispatch/scripts/adapter-live-canary-runner.js [--timeout-ms <1..120000>] [--credential-env <adapter:phase:NAME>] [--credential-file <adapter:phase:ID=/absolute/source>] [--output <path>]\n"); return;
  }
  const parsed = parseCredentialArgs(argv), timeoutIndex = parsed.argv.indexOf("--timeout-ms"), outputIndex = parsed.argv.indexOf("--output");
  const timeoutMs = timeoutIndex >= 0 ? Number(parsed.argv[timeoutIndex + 1]) : 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new Error("--timeout-ms must be an integer between 1 and 120000");
  const report = validateReport(await runCanaries({ timeoutMs, credentialSelections: parsed.selections }));
  const exitCode = canaryExitCode(report);
  const outputReport = { ...report, generated_by: "tests/relay-dispatch/scripts/adapter-live-canary-runner.js" };
  const output = `${JSON.stringify(outputReport, null, 2)}\n`;
  if (outputIndex >= 0) { const outputPath = parsed.argv[outputIndex + 1]; if (!outputPath || outputPath.startsWith("--")) throw new Error("--output requires a file path"); fs.writeFileSync(path.resolve(outputPath), output); }
  process.stdout.write(output); process.exitCode = exitCode;
}

if (require.main === module) main().catch((error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
module.exports = { canaryExitCode, canonicalRuntimeSha256Keys, classifyFailure, parseCredentialArgs, requiredMatrix, runCanaries, sourceProvenance, validateCanaryVerdict, validateReport };
