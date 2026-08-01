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
const PRIMARY_MODELS = Object.freeze({ opencode: "opencode-go/glm-5.2" });
const SHA256_RE = /^[a-f0-9]{64}$/;

function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
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

function initializeFixture(root, outsideBase, adapterName) {
  let fixtureRoot = path.join(root, adapterName); fs.mkdirSync(fixtureRoot); fixtureRoot = fs.realpathSync(fixtureRoot);
  const repo = path.join(fixtureRoot, "repository"), worktree = path.join(fixtureRoot, "worktree");
  fs.mkdirSync(repo); runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["config", "user.email", "adapter-canary@example.test"]); runGit(repo, ["config", "user.name", "adapter canary"]);
  fs.writeFileSync(path.join(repo, "README.md"), "adapter live canary\n");
  runGit(repo, ["add", "README.md"]); runGit(repo, ["commit", "-q", "-m", "canary fixture"]);
  runGit(repo, ["worktree", "add", "-q", "-b", `canary-${adapterName}`, worktree]);
  const runId = `canary-${adapterName}`, runDir = path.join(fixtureRoot, runId); fs.mkdirSync(runDir);
  const criteriaSource = path.join(runDir, "criteria.source"); fs.writeFileSync(criteriaSource, "Satisfy the exact nonce canary contract.\n");
  const frozen = runStore.freezeDoneCriteria({ sourcePath: criteriaSource, runDir }); fs.unlinkSync(criteriaSource);
  const startSha = runGit(worktree, ["rev-parse", "HEAD"]);
  const record = { version: runStore.RUN_VERSION, run_id: runId, repo: { root: runStore.canonicalRepository(repo), remote: "canary://local" },
    git: { branch: `canary-${adapterName}`, base_branch: "main", worktree, start_sha: startSha },
    contract: { done_criteria_path: frozen.path, done_criteria_sha256: frozen.sha256 },
    roles: { orchestrator: "canary", executor: adapterName, reviewer: adapterName }, parent: null, ownership_digest: null, created_at: new Date().toISOString() };
  runStore.createRunRecord({ runDir, record });
  let outside = path.join(outsideBase, adapterName); fs.mkdirSync(outside); outside = fs.realpathSync(outside); fs.writeFileSync(path.join(outside, "sentinel"), "outside sentinel\n");
  return { root: fixtureRoot, repo, worktree, runDir, record, outside };
}

function validateCanaryVerdict(value, nonce) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("canary verdict must be an object");
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "nonce")) throw new Error("canary verdict must contain exactly the nonce key");
  if (value.nonce !== nonce) throw new Error("canary verdict nonce mismatch");
  return value;
}
function classifyFailure(error, provisioned = false) {
  const detail = String(error?.message || error || "");
  if (error?.failure_reason === "credentials_unavailable") return { status: provisioned ? "failed" : "not_run", reason: provisioned ? "credential_auth_failed" : "not_run_credentials_unavailable" };
  if (error?.failure_reason === "execution_environment_unavailable") return { status: "failed", reason: "sandbox_environment_failed" };
  if (/timed.?out|ETIMEDOUT/i.test(detail)) return { status: "failed", reason: "invocation_timeout" };
  if (/process (?:group|scope) survived|escaped process audit failed/i.test(detail)) return { status: "failed", reason: "process_scope_survived" };
  if (AUTH_FAILURE.test(detail)) return { status: provisioned ? "failed" : "not_run", reason: provisioned ? "credential_auth_failed" : "not_run_credentials_unavailable" };
  if (ENVIRONMENT_FAILURE.test(detail)) return { status: "failed", reason: "sandbox_environment_failed" };
  return { status: "failed", reason: "invocation_failed" };
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
function invocationDigest(invocation) { return sha(Buffer.from(JSON.stringify({ command: path.basename(invocation.command), args: invocation.args, stdin_sha256: invocation.stdinSha256 || null }))); }
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
function runReviewAttempt(fixture, adapter, model, timeoutMs, credentials, prompt, nonce) {
  let invocation;
  const outcome = runStore.invokeIndependentReviewer({ runDir: fixture.runDir, request: reviewRequest(fixture, prompt, nonce), timeoutMs,
    credentialRequest: credentials,
    buildInvocation: ({ cwd, promptPath, promptBytes, resultPath, schemaPath }) => {
      invocation = adapter.buildInvocation({ phase: ADAPTER_PHASES.PRIMARY_REVIEW, cwd, promptPath, promptBytes,
        resultPath, schemaPath, model, timeoutMs, sandbox: "read-only", networkAccess: "disabled" }); return invocation;
    }, parseOutcome: (input) => adapter.parseOutcome(input) });
  return { outcome, invocation };
}
async function runDispatchAttempt(fixture, adapter, model, timeoutMs, credentials, prompt) {
  const attemptId = `canary-${crypto.randomBytes(6).toString("hex")}`, executorResultPath = path.join(fixture.runDir, `${attemptId}.executor-output`);
  const invocation = adapter.buildInvocation({ phase: ADAPTER_PHASES.DISPATCH, cwd: fixture.worktree,
    promptPath: prompt.path, promptBytes: prompt.bytes, resultPath: executorResultPath, model, timeoutMs,
    sandbox: "workspace-write", networkAccess: "disabled" });
  const capability = host.acquireRunLock({ runDir: fixture.runDir, attemptId, operation: "canary", hostHandle: `canary:${attemptId}`, worktreeDir: fixture.worktree });
  let receipt, terminal;
  try {
    receipt = host.launchLocalSupervisor({ runDir: fixture.runDir, attemptId, command: invocation.command, args: invocation.args,
      trustedWorktreeRoot: fixture.worktree, cwd: invocation.cwd, inputFiles: [prompt.path], stdinPath: invocation.stdinPath,
      stdinSha256: invocation.stdinSha256, executorResultPath, executorSandbox: "workspace-write", executorNetworkAccess: "disabled",
      timeoutMs, credentialRequest: credentials, processContainment: adapter.metadata.processContainment, lockContext: capability });
    terminal = await host.waitForTerminalResult(receipt, { timeoutMs: timeoutMs + 10_000 });
    const outcome = adapter.parseOutcome({ phase: ADAPTER_PHASES.DISPATCH, exitCode: terminal.exit_code, signal: terminal.signal,
      timedOut: terminal.status === "timed_out", cancelled: terminal.status === "cancelled", stdoutPath: receipt.stdout_path,
      stderrPath: receipt.stderr_path, resultPath: executorResultPath });
    if (terminal.status !== "completed" || terminal.exit_code !== 0 || outcome.status !== "succeeded") {
      const stderr = fs.existsSync(receipt.stderr_path) ? fs.readFileSync(receipt.stderr_path, "utf8") : outcome.summary;
      const error = new Error(stderr || terminal.error || "dispatch failed"); error.runtime_audit = terminal; throw error;
    }
    return { outcome, invocation, terminal, stdoutPath: receipt.stdout_path };
  } finally { if (receipt && terminal) host.releaseRunLock(capability, { outcome: terminal.status }); }
}
function expectedDispatchMutation(before, after, fixture, prompt, nonce) {
  const target = path.join(fixture.worktree, prompt.artifactName), expected = Buffer.from(`${nonce}\n`);
  if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isFile() || !fs.readFileSync(target).equals(expected)) return false;
  const filtered = after.worktree_entries.filter((entry) => entry[0] !== prompt.artifactName);
  const stable = { ...after, worktree_entries: filtered };
  return sameSnapshot(before, stable) && runGit(fixture.worktree, ["status", "--porcelain=v1", "-z"]) === `?? ${prompt.artifactName}\0`;
}

async function runCell(adapter, phase, fixture, { timeoutMs, credentialSelections, onFixture, onError }) {
  const model = PRIMARY_MODELS[adapter.name] || null, nonce = crypto.randomBytes(16).toString("hex"), prompt = phasePrompt(fixture, phase, nonce);
  const base = { adapter: adapter.name, phase, model: model || "default", provider: resolveAdapterProvider(adapter, model), nonce_sha256: sha(Buffer.from(nonce)), prompt_sha256: prompt.digest };
  const probe = adapter.probe({ timeoutMs: Math.min(timeoutMs, 10_000) }), probeRecord = probeEvidence(adapter, probe);
  if (probe.status !== "available") return { ...base, status: "not_run", reason: probe.status === "skipped" ? "not_run_cli_unavailable" : "not_run_probe_failed", probe: probeRecord, checks: {} };
  const credentials = credentialsFor(adapter, phase, credentialSelections);
  if (!credentials) return { ...base, status: "not_run", reason: "not_run_credentials_unavailable", probe: probeRecord,
    credential_request: { env_names: [], file_ids: [] }, checks: {} };
  const before = snapshotFixture(fixture), started = Date.now(); if (onFixture) onFixture(fixture, adapter, phase);
  try {
    const execution = phase === ADAPTER_PHASES.DISPATCH
      ? await runDispatchAttempt(fixture, adapter, model, timeoutMs, credentials, prompt)
      : runReviewAttempt(fixture, adapter, model, timeoutMs, credentials, prompt, nonce);
    if (phase === ADAPTER_PHASES.PRIMARY_REVIEW) validateCanaryVerdict(execution.outcome.output, nonce);
    quietWindow(); const after = snapshotFixture(fixture);
    const boundary = phase === ADAPTER_PHASES.DISPATCH ? expectedDispatchMutation(before, after, fixture, prompt, nonce) : sameSnapshot(before, after);
    if (!boundary) throw new Error("canary repository, Git metadata, or outside boundary mutated");
    const processAbsent = execution.outcome.runtime_audit?.process_group_absent
      ?? (execution.terminal?.status === "completed" && !execution.terminal?.error ? true : execution.terminal?.process_group_absent);
    if (processAbsent !== true) throw new Error("canary has no production process-group absence proof");
    const outputBytes = phase === ADAPTER_PHASES.DISPATCH
      ? fs.readFileSync(path.join(fixture.worktree, prompt.artifactName))
      : Buffer.from(JSON.stringify(execution.outcome.output));
    return { ...base, status: "passed", reason: "production_path_passed", probe: probeRecord, credential_request: credentials.public,
      invocation_sha256: invocationDigest(execution.invocation), output_sha256: sha(outputBytes), checks: { boundary: "passed", nonce: "passed",
        cleanup: "passed", process_scope_absent: "passed", elapsed_ms: Date.now() - started } };
  } catch (error) {
    if (onError) onError(error, adapter, phase); quietWindow(); const after = snapshotFixture(fixture), classified = classifyFailure(error, true);
    const boundary = phase === ADAPTER_PHASES.DISPATCH ? expectedDispatchMutation(before, after, fixture, prompt, nonce) : sameSnapshot(before, after);
    if (!boundary && classified.reason === "invocation_failed") classified.reason = "boundary_mutated";
    return { ...base, ...classified, probe: probeRecord, credential_request: credentials.public,
      checks: { boundary: boundary ? "passed" : "failed", nonce: "failed", cleanup: "unknown", process_scope_absent: "unknown", elapsed_ms: Date.now() - started } };
  }
}

function requiredMatrix(adapters) {
  return adapters.flatMap((adapter) => PHASES.filter((phase) => phase === ADAPTER_PHASES.DISPATCH || adapter.capabilities({ phase }).supported)
    .map((phase) => `${adapter.name}:${phase}`));
}
function sourceProvenance() {
  const runnerPath = __filename, runtimePaths = [host.__filename || require.resolve("../../../skills/relay-dispatch/scripts/host"),
    require.resolve("../../../skills/relay-dispatch/scripts/run-store"), require.resolve("../../../skills/relay-dispatch/scripts/adapter-contract")];
  return { git_head: runGit(PROJECT_ROOT, ["rev-parse", "HEAD"]), git_tree: runGit(PROJECT_ROOT, ["rev-parse", "HEAD^{tree}"]),
    dirty_digest: sha(Buffer.from(runGit(PROJECT_ROOT, ["status", "--porcelain=v1", "-z"]))), runner_sha256: sha(fs.readFileSync(runnerPath)),
    runtime_sha256: Object.fromEntries(runtimePaths.map((file) => [path.basename(file), sha(fs.readFileSync(file))])), platform: process.platform, arch: process.arch, node: process.version };
}
async function runCanaries({ timeoutMs = 120_000, adapters = listAdapters().map(getAdapter), credentialSelections = {}, onFixture = null, onError = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-adapter-live-canary-")), outsideBase = fs.mkdtempSync(path.join(os.tmpdir(), "relay-adapter-live-canary-outside-"));
  try {
    const results = [];
    for (const adapter of adapters) {
      const fixture = initializeFixture(root, outsideBase, adapter.name);
      for (const phase of PHASES) if (phase === ADAPTER_PHASES.DISPATCH || adapter.capabilities({ phase }).supported) {
        results.push(await runCell(adapter, phase, fixture, { timeoutMs, credentialSelections, onFixture, onError }));
      }
    }
    const required = requiredMatrix(adapters), completed = results.filter((entry) => entry.status === "passed").map((entry) => `${entry.adapter}:${entry.phase}`);
    const summary = { required: required.length, passed: completed.length, not_run: results.filter((entry) => entry.status === "not_run").length,
      failed: results.filter((entry) => entry.status === "failed").length, missing: required.filter((cell) => !completed.includes(cell)) };
    return { schema_version: 2, evidence_status: summary.passed === summary.required && summary.not_run === 0 && summary.failed === 0 ? "release_complete" : "incomplete_non_release",
      generated_at: new Date().toISOString(), timeout_ms: timeoutMs, provenance: sourceProvenance(),
      policy: { required_cells: required, acceptance: "every required cell must pass its production phase; not_run, skip, failure, and fallback are non-release" },
      results, summary };
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outsideBase, { recursive: true, force: true }); }
}
function validateReport(report) {
  if (report?.schema_version !== 2 || !Array.isArray(report?.policy?.required_cells) || !Array.isArray(report?.results)) throw new Error("canary report schema invalid");
  const provenance = report.provenance;
  if (!provenance || !/^[a-f0-9]{40}$/.test(provenance.git_head || "") || !/^[a-f0-9]{40}$/.test(provenance.git_tree || "")
    || !SHA256_RE.test(provenance.dirty_digest || "") || !SHA256_RE.test(provenance.runner_sha256 || "")
    || !provenance.runtime_sha256 || !Object.values(provenance.runtime_sha256).every((value) => SHA256_RE.test(value))
    || !provenance.platform || !provenance.arch || !provenance.node) throw new Error("canary report provenance invalid");
  const keys = report.results.map((entry) => `${entry.adapter}:${entry.phase}`);
  if (new Set(keys).size !== keys.length || keys.length !== report.policy.required_cells.length || report.policy.required_cells.some((cell) => !keys.includes(cell))) throw new Error("canary report phase coverage invalid");
  if (report.results.some((entry) => !["passed", "failed", "not_run"].includes(entry.status))) throw new Error("canary report status invalid");
  for (const entry of report.results) {
    if (!SHA256_RE.test(entry.nonce_sha256 || "") || !SHA256_RE.test(entry.prompt_sha256 || "") || !entry.probe
      || Object.hasOwn(entry, "fallback") || Object.hasOwn(entry, "credential_source") || Object.hasOwn(entry, "credential_values")) throw new Error("canary report cell evidence invalid");
    if (entry.status === "passed" && (!SHA256_RE.test(entry.invocation_sha256 || "") || !SHA256_RE.test(entry.output_sha256 || "")
      || !["boundary", "nonce", "cleanup", "process_scope_absent"].every((key) => entry.checks?.[key] === "passed"))) throw new Error("canary report passed-cell evidence invalid");
    if (entry.credential_request && (!Array.isArray(entry.credential_request.env_names) || !Array.isArray(entry.credential_request.file_ids))) throw new Error("canary report credential evidence invalid");
  }
  const passed = report.results.filter((entry) => entry.status === "passed").length, failed = report.results.filter((entry) => entry.status === "failed").length,
    notRun = report.results.filter((entry) => entry.status === "not_run").length, missing = report.policy.required_cells.filter((cell) => {
      const entry = report.results.find((item) => `${item.adapter}:${item.phase}` === cell); return entry?.status !== "passed";
    });
  if (report.summary?.required !== keys.length || report.summary.passed !== passed || report.summary.failed !== failed
    || report.summary.not_run !== notRun || JSON.stringify(report.summary.missing) !== JSON.stringify(missing)) throw new Error("canary report summary integrity invalid");
  const expectedStatus = passed === keys.length && failed === 0 && notRun === 0 ? "release_complete" : "incomplete_non_release";
  if (report.evidence_status !== expectedStatus) throw new Error("canary report evidence status invalid");
  return report;
}
function canaryExitCode(report) {
  try { validateReport(report); } catch { return 1; }
  return report.summary.required === report.policy.required_cells.length && report.summary.passed === report.summary.required
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
  const report = validateReport({ ...await runCanaries({ timeoutMs, credentialSelections: parsed.selections }), generated_by: "tests/relay-dispatch/scripts/adapter-live-canary-runner.js" });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (outputIndex >= 0) { const outputPath = parsed.argv[outputIndex + 1]; if (!outputPath || outputPath.startsWith("--")) throw new Error("--output requires a file path"); fs.writeFileSync(path.resolve(outputPath), output); }
  process.stdout.write(output); process.exitCode = canaryExitCode(report);
}

if (require.main === module) main().catch((error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
module.exports = { canaryExitCode, classifyFailure, parseCredentialArgs, requiredMatrix, runCanaries, validateCanaryVerdict, validateReport };
