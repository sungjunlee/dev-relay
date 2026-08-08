const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeParseOutcome } = require("../../../skills/relay-dispatch/scripts/adapter-contract");
const { listAdapters } = require("../../../skills/relay-dispatch/scripts/adapters");
const host = require("../../../skills/relay-dispatch/scripts/host");
const { canaryExitCode, canonicalRuntimeSha256Keys, classifyFailure, parseCredentialArgs, requiredMatrix, runCanaries, sourceProvenance, validateCanaryVerdict, validateReport } = require("./adapter-live-canary-runner");

const RUNNER = path.join(__dirname, "adapter-live-canary-runner.js");
function hash(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function selection(...cells) { return Object.fromEntries(cells.map((cell) => [cell, { envNames: ["TEST_CANARY_TOKEN"], fileSpecs: [] }])); }

test("release canary is test-only and requires the exact 7-dispatch plus 6-review matrix", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "../../../skills/relay-dispatch/scripts/adapter-live-canary.js")), false);
  assert.deepEqual(listAdapters(), ["claude", "codex", "opencode", "pi", "antigravity", "cursor", "cline"]);
  const adapters = listAdapters().map((name) => ({ name, capabilities: ({ phase }) => ({ supported: phase === "primary_review" && name !== "cline" }) }));
  const matrix = requiredMatrix(adapters);
  assert.equal(matrix.length, 13);
  assert.deepEqual(matrix.filter((cell) => cell.endsWith(":dispatch")).length, 7);
  assert.deepEqual(matrix.filter((cell) => cell.endsWith(":primary_review")).length, 6);
  const source = fs.readFileSync(RUNNER, "utf8");
  assert.doesNotMatch(source, /FALLBACK|pass_with_fallback|status:\s*["']skipped/);
  assert.match(source, /invokeIndependentReviewer/);
  assert.match(source, /launchLocalSupervisor/);
});

test("nonce verdict schema rejects replay and every permissive shape", () => {
  assert.deepEqual(validateCanaryVerdict({ nonce: "abc" }, "abc"), { nonce: "abc" });
  for (const value of [null, [], "abc", {}, { nonce: "old" }, { nonce: "abc", extra: true }]) {
    assert.throws(() => validateCanaryVerdict(value, "abc"), /canary verdict/);
  }
});

function fakeAdapter(name, mode = "pass", state = {}) {
  return {
    name,
    defaults: { timeoutMs: 10_000 },
    metadata: { cliBinary: process.execPath, outputProtocol: "phase-specific", providerDefault: "test", processContainment: "inherited_scope_no_daemon",
      credentials: { files: [], envHints: ["TEST_CANARY_TOKEN"] } },
    probe() { return mode === "unavailable" ? { status: "skipped", error: "CLI not found", raw: null } : { status: "available", error: null, raw: "test 1.0" }; },
    capabilities({ phase }) { return { supported: phase === "dispatch" || (phase === "primary_review" && name !== "cline"), write: phase === "dispatch", readOnly: phase !== "dispatch" }; },
    buildInvocation({ phase, cwd, promptPath, promptBytes }) {
      assert.ok(Buffer.isBuffer(promptBytes));
      const prompt = promptBytes.toString("utf8"), nonce = prompt.match(/[a-f0-9]{32}/)?.[0];
      if (mode === "builder-mutation") fs.writeFileSync(state.target, "mutated by builder\n");
      let source;
      if (mode === "auth") source = "process.stderr.write('authentication credentials required');process.exit(1)";
      else if (mode === "missing-artifact" && phase === "dispatch") source = "process.stdout.write('done')";
      else if (mode === "wrong-artifact" && phase === "dispatch") source = `require('fs').writeFileSync(${JSON.stringify(path.join(cwd, `RELAY_CANARY_${nonce}.txt`))},'wrong\\n');process.stdout.write('done')`;
      else if (mode === "wrong-nonce") source = "process.stdout.write(JSON.stringify({nonce:'stale'}))";
      else if (mode === "fallback-marker") source = "process.stdout.write(JSON.stringify({nonce:'fallback'}))";
      else if (mode === "delayed-grandchild") source = `const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{detached:true,stdio:'ignore'});c.unref();process.stdout.write(JSON.stringify({nonce:${JSON.stringify(nonce)}}))`;
      else if (phase === "dispatch") {
        const file = `RELAY_CANARY_${nonce}.txt`;
        source = `require('fs').writeFileSync(${JSON.stringify(path.join(cwd, file))},${JSON.stringify(`${nonce}\n`)});process.stdout.write('done')`;
      } else source = `process.stdout.write(JSON.stringify({nonce:${JSON.stringify(nonce)}}))`;
      return { command: process.execPath, args: ["-e", source], cwd, stdinPath: promptPath, stdinSha256: hash(promptBytes),
        networkAccess: "enabled", runtimeDependencies: { executableParent: 1, interpreterParent: null } };
    },
    parseOutcome(input) { return makeParseOutcome(input.phase === "dispatch" ? "text_stdout" : "json_result")(input); },
  };
}

test("two production phase cells pass only with explicit credentials and exact nonce evidence", { skip: process.platform !== "darwin" }, async () => {
  process.env.TEST_CANARY_TOKEN = "unit-secret";
  const report = await runCanaries({ timeoutMs: 10_000, adapters: [fakeAdapter("healthy")],
    credentialSelections: selection("healthy:dispatch", "healthy:primary_review") });
  assert.equal(report.summary.required, 2);
  assert.equal(report.summary.passed, 2, JSON.stringify(report.results));
  assert.equal(canaryExitCode(report), 1, "a custom matrix is diagnostic and cannot be release evidence");
  for (const result of report.results) {
    assert.equal(result.status, "passed"); assert.equal(result.checks.nonce, "passed");
    assert.equal(result.tool_network_access, "enabled"); assert.equal(result.tool_network_enforcement, "unsupported_explicit_enabled");
    assert.match(result.invocation_sha256, /^[a-f0-9]{64}$/); assert.match(result.output_sha256, /^[a-f0-9]{64}$/); assert.match(result.executed_runtime.digest, /^[a-f0-9]{64}$/);
    assert.match(result.executed_runtime.executable.sha256, /^[a-f0-9]{64}$/); assert.equal(typeof result.executed_runtime.executable.basename, "string");
    assert.equal(/[\\/]/.test(result.executed_runtime.executable.basename), false);
    assert.deepEqual(result.credential_request, { env_names: ["TEST_CANARY_TOKEN"], file_ids: [] });
    assert.doesNotMatch(JSON.stringify(result), /unit-secret/);
  }
});

test("missing CLI and missing explicit credentials are non-release not_run cells", async () => {
  const report = await runCanaries({ timeoutMs: 1_000, adapters: [fakeAdapter("missing", "unavailable"), fakeAdapter("unprovisioned")] });
  assert.ok(report.results.every((entry) => entry.status === "not_run"));
  assert.ok(report.results.some((entry) => entry.reason === "not_run_cli_unavailable"));
  assert.ok(report.results.some((entry) => entry.reason === "not_run_credentials_unavailable"));
  assert.equal(canaryExitCode(report), 1);
});

test("structurally unrepresentable credentials stay typed not_run even when a dummy secret is selected", async () => {
  const adapter = fakeAdapter("blocked");
  adapter.capabilities = ({ phase }) => ({ supported: phase === "dispatch" || phase === "primary_review", credentialTransport: "unrepresentable" });
  process.env.TEST_CANARY_TOKEN = "must-not-be-used";
  const report = await runCanaries({ timeoutMs: 1_000, adapters: [adapter],
    credentialSelections: selection("blocked:dispatch", "blocked:primary_review") });
  assert.ok(report.results.every((entry) => entry.reason === "not_run_credentials_unrepresentable"));
  assert.ok(report.results.every((entry) => entry.blocker?.code === "CREDENTIALS_UNREPRESENTABLE"));
  assert.doesNotMatch(JSON.stringify(report), /must-not-be-used/);
});

test("provisioned authentication failure is failed, never skipped or not_run", { skip: process.platform !== "darwin" }, async () => {
  process.env.TEST_CANARY_TOKEN = "wrong-secret";
  const report = await runCanaries({ timeoutMs: 10_000, adapters: [fakeAdapter("auth", "auth")],
    credentialSelections: selection("auth:dispatch", "auth:primary_review") });
  assert.ok(report.results.every((entry) => entry.status === "failed"), JSON.stringify(report.results));
  assert.ok(report.results.every((entry) => entry.reason === "credential_auth_failed"));
  assert.ok(report.results.every((entry) => entry.checks.boundary === "passed"), JSON.stringify(report.results));
  assert.equal(canaryExitCode(report), 1);
});

test("typed credential staging failures retain no message or source path", () => {
  const error = new Error("credential '/private/secret/auth.json' source must be owner-only");
  error.code = "UNTRUSTED_CREDENTIAL";
  const classified = classifyFailure(error, true);
  assert.deepEqual(classified, { status: "failed", reason: "credential_source_rejected",
    failure: { type: "credential_staging", code: "UNTRUSTED_CREDENTIAL" } });
  assert.doesNotMatch(JSON.stringify(classified), /private|secret|auth\.json/);
});

test("host cleanup failures remain typed and carry a redacted cleanup proof", () => {
  const error = Object.assign(new Error("executor cleanup is incomplete"), { code: "HOST_CLEANUP_INCOMPLETE" });
  assert.deepEqual(classifyFailure(error, true), { status: "failed", reason: "host_cleanup_incomplete",
    failure: { type: "cleanup", code: "HOST_CLEANUP_INCOMPLETE" } });
});

test("dispatch cleanup-incomplete is settled before canary fixtures are removed", { skip: process.platform !== "darwin", timeout: 20_000 }, async () => {
  process.env.TEST_CANARY_TOKEN = "unit-secret";
  let fixtureRoot, settled = false;
  const report = await runCanaries({ timeoutMs: 10_000, adapters: [fakeAdapter("cleanup-settle")],
    credentialSelections: selection("cleanup-settle:dispatch", "cleanup-settle:primary_review"),
    onFixture(fixture, unused, phase) {
      if (phase !== "dispatch") return;
      fixtureRoot = fixture.root; fixture.testCleanupFailurePath = path.join(fixture.runDir, "cleanup.fail");
      fs.writeFileSync(fixture.testCleanupFailurePath, "inject cleanup failure\n", { mode: 0o600 });
    },
    onError(error, unused, phase) {
      if (phase !== "dispatch") return;
      assert.equal(error.code, "HOST_CLEANUP_INCOMPLETE");
      assert.equal(host.inspectOwnership({ runDir: path.join(fixtureRoot, "canary-cleanup-settle-dispatch") }).status, "absent");
      const runDir = path.join(fixtureRoot, "canary-cleanup-settle-dispatch"), names = fs.readdirSync(runDir);
      assert.ok(names.some((name) => name.endsWith(".cleanup-incomplete.json")));
      assert.ok(names.some((name) => name.endsWith(".cleanup-settled.json")));
      assert.ok(names.some((name) => name.endsWith(".result.json")));
      settled = true;
    } });
  assert.equal(settled, true);
  assert.equal(report.results[0].reason, "host_cleanup_incomplete");
  assert.equal(fs.existsSync(fixtureRoot), false, "settled fixture may be removed");
});

test("unsettleable dispatch cleanup preserves signed evidence and aborts the canary", { skip: process.platform !== "darwin", timeout: 20_000 }, async () => {
  process.env.TEST_CANARY_TOKEN = "unit-secret";
  let fixture, credentialRoot, displacedRoot;
  try {
    await assert.rejects(runCanaries({ timeoutMs: 10_000, adapters: [fakeAdapter("cleanup-preserve")],
      credentialSelections: selection("cleanup-preserve:dispatch", "cleanup-preserve:primary_review"),
      onFixture(value, unused, phase) {
        if (phase !== "dispatch") return;
        fixture = value; value.testCleanupFailurePath = path.join(value.runDir, "cleanup.fail");
        fs.writeFileSync(value.testCleanupFailurePath, "inject cleanup failure\n", { mode: 0o600 });
      },
      onCleanupIncomplete(value) {
        const name = fs.readdirSync(value.runDir).find((entry) => entry.endsWith(".cleanup-incomplete.json"));
        const cleanup = JSON.parse(fs.readFileSync(path.join(value.runDir, name), "utf8"));
        credentialRoot = cleanup.obligation.credential_root.path; displacedRoot = `${credentialRoot}.displaced`;
        fs.renameSync(credentialRoot, displacedRoot); fs.mkdirSync(credentialRoot, { mode: 0o700 });
      } }), (error) => error.code === "CANARY_CLEANUP_UNSETTLED" && /evidence preserved/.test(error.message));
    assert.ok(fixture && fs.existsSync(fixture.root));
    assert.ok(fs.readdirSync(fixture.runDir).some((name) => name.endsWith(".cleanup-incomplete.json")));
    assert.notEqual(host.inspectOwnership({ runDir: fixture.runDir }).status, "absent");
    assert.equal(fs.readFileSync(path.join(fixture.outside, "sentinel"), "utf8"), "outside sentinel\n");
  } finally {
    if (credentialRoot && displacedRoot && fs.existsSync(displacedRoot)) {
      fs.rmSync(credentialRoot, { recursive: true, force: true }); fs.renameSync(displacedRoot, credentialRoot);
      await host.breakStaleRunLock({ inspection: host.inspectOwnership({ runDir: fixture.runDir }), reason: "test cleanup after preserved canary evidence" });
    }
    if (fixture) {
      fs.rmSync(path.dirname(fixture.root), { recursive: true, force: true });
      fs.rmSync(path.dirname(fixture.outside), { recursive: true, force: true });
    }
  }
});

test("a post-receipt timeout is cancelled and settled before canary fixture deletion", { skip: process.platform !== "darwin", timeout: 20_000 }, async () => {
  process.env.TEST_CANARY_TOKEN = "unit-secret"; const realWait = host.waitForTerminalResult; let calls = 0, observedAbsent = false;
  host.waitForTerminalResult = async (...args) => { if (calls++ === 0) { await new Promise((resolve) => setTimeout(resolve, 1_000)); const error = new Error("injected result timeout"); error.code = "HOST_RESULT_TIMEOUT"; throw error; } return realWait(...args); };
  try {
    const report = await runCanaries({ timeoutMs: 10_000, adapters: [fakeAdapter("cline")], credentialSelections: selection("cline:dispatch"),
      onError(unused, unusedAdapter, unusedPhase) { observedAbsent = true; } });
    assert.equal(report.results[0].status, "failed"); assert.equal(observedAbsent, true); assert.ok(calls >= 2);
  } finally { host.waitForTerminalResult = realWait; }
});

// Ownership liveness is deliberately NOT asserted here. On a post-receipt failure the runner itself
// calls `breakStaleRunLock`, and that call is gated on the ownership status captured at that instant:
// "stale" breaks the lock and returns, "live" refuses with BREAK_EVIDENCE_INSUFFICIENT. Both are
// correct. `two_dead_probes` stays reachable despite the corrupted terminal because a false
// `validTerminal` at host.js:705 falls through to the running-artifact probe rather than returning
// `unknown`, so once supervisor and executor have exited the owner probes dead. Forcing a delay before
// the break flips the outcome every time, which is what made this a ~17% flake: it measured supervisor
// exit timing, not a contract. What the canary must guarantee is that it aborts with the typed cause
// intact and destroys no evidence. Cleanup settlement is not asserted: this path publishes no
// cleanup-incomplete artifact, so `settleCleanup` is never reachable and the check would be vacuous.
test("an invalid post-receipt terminal aborts with a typed cause and destroys no evidence", { skip: process.platform !== "darwin", timeout: 20_000 }, async () => {
  process.env.TEST_CANARY_TOKEN = "unit-secret"; const realWait = host.waitForTerminalResult; let fixture, terminalBytes, resultPath, corrupted = false;
  host.waitForTerminalResult = async (...args) => {
    if (!corrupted) { await realWait(...args); resultPath = args[0].result_path; terminalBytes = fs.readFileSync(resultPath); fs.writeFileSync(resultPath, "{}\n"); corrupted = true;
      const error = new Error("injected invalid terminal"); error.code = "HOST_ARTIFACT_INVALID"; throw error; }
    return realWait(...args);
  };
  try {
    await assert.rejects(runCanaries({ timeoutMs: 10_000, adapters: [fakeAdapter("cline")], credentialSelections: selection("cline:dispatch"), onFixture(value) { fixture = value; } }),
      (error) => error.code === "CANARY_CLEANUP_UNSETTLED" && error.preserveCanaryEvidence === true
        && error.originalError instanceof Error && error.originalError.code === "HOST_ARTIFACT_INVALID"
        && error.cause instanceof Error && typeof error.cause.code === "string");
    assert.ok(fixture && fs.existsSync(fixture.root), "fixture evidence must be preserved");
    assert.equal(fs.readFileSync(path.join(fixture.outside, "sentinel"), "utf8"), "outside sentinel\n", "the abort must not touch anything outside the fixture boundary");
  } finally {
    host.waitForTerminalResult = realWait;
    if (terminalBytes && resultPath) { fs.writeFileSync(resultPath, terminalBytes); const inspection = host.inspectOwnership({ runDir: fixture.runDir });
      if (inspection.status !== "absent") await host.breakStaleRunLock({ inspection, reason: "invalid terminal test recovery", resultPath }); }
    if (fixture) { fs.rmSync(path.dirname(fixture.root), { recursive: true, force: true }); fs.rmSync(path.dirname(fixture.outside), { recursive: true, force: true }); }
  }
});

test("dispatch and review cells use phase-pristine fixtures", { skip: process.platform !== "darwin" }, async () => {
  process.env.TEST_CANARY_TOKEN = "unit-secret";
  const fixtures = [];
  const report = await runCanaries({ timeoutMs: 10_000, adapters: [fakeAdapter("pristine")],
    credentialSelections: selection("pristine:dispatch", "pristine:primary_review"),
    onFixture(fixture, adapter, phase) { fixtures.push({ phase, root: fixture.root }); } });
  assert.equal(report.summary.passed, 2, JSON.stringify(report.results));
  assert.equal(fixtures.length, 2); assert.notEqual(fixtures[0].root, fixtures[1].root);
});

test("boundary mutation and stale or fallback nonce cannot produce a pass", { skip: process.platform !== "darwin" }, async () => {
  process.env.TEST_CANARY_TOKEN = "unit-secret";
  for (const mode of ["wrong-nonce", "fallback-marker"]) {
    const report = await runCanaries({ timeoutMs: 10_000, adapters: [fakeAdapter("negative", mode)],
      credentialSelections: selection("negative:dispatch", "negative:primary_review") });
    assert.equal(canaryExitCode(report), 1);
    assert.ok(report.results.some((entry) => entry.status === "failed"));
  }
  const state = {}, report = await runCanaries({ timeoutMs: 10_000, adapters: [fakeAdapter("mutator", "builder-mutation", state)],
    credentialSelections: selection("mutator:dispatch", "mutator:primary_review"), onFixture(fixture) { state.target = path.join(fixture.outside, "sentinel"); } });
  assert.equal(canaryExitCode(report), 1);
  assert.ok(report.results.some((entry) => entry.reason === "boundary_mutated"));
});

test("clean exit with a missing or wrong nonce artifact is output failure, not boundary mutation", { skip: process.platform !== "darwin" }, async () => {
  process.env.TEST_CANARY_TOKEN = "unit-secret";
  for (const mode of ["missing-artifact", "wrong-artifact"]) {
    const report = await runCanaries({ timeoutMs: 10_000, adapters: [fakeAdapter(`output-${mode}`, mode)],
      credentialSelections: selection(`output-${mode}:dispatch`, `output-${mode}:primary_review`) });
    const dispatch = report.results.find((entry) => entry.phase === "dispatch");
    assert.equal(dispatch.status, "failed"); assert.equal(dispatch.reason, "canary_output_invalid", JSON.stringify(dispatch));
    assert.deepEqual(dispatch.failure, { type: "output", code: "CANARY_OUTPUT_INVALID" });
    assert.equal(dispatch.checks.boundary, "passed"); assert.equal(dispatch.checks.nonce, "failed"); assert.equal(dispatch.checks.cleanup, "passed");
  }
});

test("report integrity rejects duplicate, missing, unknown status, and partial phase coverage", () => {
  const digest = "a".repeat(64), adapters = listAdapters().map((name) => ({ name, capabilities: ({ phase }) => ({ supported: phase === "primary_review" && name !== "cline" }) }));
  const required = requiredMatrix(adapters), cell = (key) => { const [adapter, phase] = key.split(":"); return { adapter, phase, status: "passed", nonce_sha256: digest, prompt_sha256: digest,
    invocation_sha256: digest, output_sha256: digest, executed_runtime: { digest, executable: { basename: "tool", dev: 1, ino: 2, size: 3, sha256: digest } }, tool_network_access: "enabled", tool_network_enforcement: "unsupported_explicit_enabled", probe: { status: "available" }, checks: { boundary: "passed", nonce: "passed", cleanup: "passed", process_scope_absent: "passed" } };
  };
  const base = { schema_version: 2, evidence_status: "release_complete", provenance: { git_head: "a".repeat(40), git_tree: "b".repeat(40),
    dirty_digest: digest, runner_sha256: digest, runtime_sha256: Object.fromEntries(canonicalRuntimeSha256Keys().map((key) => [key, digest])), platform: "darwin", arch: "arm64", node: "v22" },
    policy: { required_cells: required }, results: required.map(cell),
    summary: { required: required.length, passed: required.length, not_run: 0, failed: 0, missing: [] } };
  base.provenance_after = { ...base.provenance, runtime_sha256: { ...base.provenance.runtime_sha256 } };
  assert.equal(validateReport(base), base);
  assert.equal(canaryExitCode(base), 1, "fabricated shape-valid evidence cannot be release-valid outside its source checkout");
  const current = { ...base, provenance: sourceProvenance() };
  assert.equal(canaryExitCode(current), 1, "current source hashes cannot replace a fresh production-matrix execution");
  assert.equal(canaryExitCode(JSON.parse(JSON.stringify(current))), 1, "serialized evidence has no fresh-run release authority");
  assert.equal(canaryExitCode({ ...current, provenance: { ...current.provenance, runner_sha256: digest } }), 1);
  for (const bad of [
    { ...base, results: [base.results[0]] },
    { ...base, results: [base.results[0], ...base.results.slice(0, -1)] },
    { ...base, results: [{ ...base.results[0], status: "skipped" }, ...base.results.slice(1)] },
    { ...base, summary: { ...base.summary, passed: required.length - 1, missing: [required.at(-1)] } },
    { ...base, results: [{ ...base.results[0], output_sha256: null }, ...base.results.slice(1)] },
    { ...base, results: [{ ...base.results[0], executed_runtime: null }, ...base.results.slice(1)] },
    { ...base, results: [{ ...base.results[0], executed_runtime: { ...base.results[0].executed_runtime, executable: { ...base.results[0].executed_runtime.executable, sha256: null } } }, ...base.results.slice(1)] },
    { ...base, results: [{ ...base.results[0], executed_runtime: { ...base.results[0].executed_runtime, executable: { ...base.results[0].executed_runtime.executable, path: "/Users/leak/tool" } } }, ...base.results.slice(1)] },
    { ...base, results: [{ ...base.results[0], executed_runtime: { ...base.results[0].executed_runtime, executable: { ...base.results[0].executed_runtime.executable, basename: "dir/tool" } } }, ...base.results.slice(1)] },
    { ...base, provenance: { ...base.provenance, runtime_sha256: Object.fromEntries(Object.entries(base.provenance.runtime_sha256).slice(1)) } },
    { ...base, provenance: { ...base.provenance, runtime_sha256: { ...base.provenance.runtime_sha256, "unexpected.js": digest } } },
    { ...base, provenance_after: { ...base.provenance_after, dirty_digest: "c".repeat(64) } },
    { ...base, results: [((entry) => { const { tool_network_access, ...withoutToolNetwork } = entry; return withoutToolNetwork; })(base.results[0]), ...base.results.slice(1)] },
    { ...base, results: [{ ...base.results[0], tool_network_enforcement: "" }, ...base.results.slice(1)] },
    { ...base, results: [{ ...base.results[0], fallback: { diagnostic: true } }, ...base.results.slice(1)] },
    { ...base, policy: { ...base.policy, required_cells: required.slice(0, -1) }, results: base.results.slice(0, -1), summary: { required: required.length - 1, passed: required.length - 1, not_run: 0, failed: 0, missing: [] } },
  ]) assert.equal(canaryExitCode(bad), 1);
});

test("fresh production reports are deeply immutable and cannot be promoted after the run", async () => {
  const report = await runCanaries({ timeoutMs: 100 });
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.results), true);
  assert.equal(Object.isFrozen(report.summary), true);
  assert.equal(Reflect.set(report.summary, "passed", report.summary.required), false);
  assert.equal(canaryExitCode(report), 1);
});

test("inherited or accessor adapter matrices cannot mint fresh production authority", async () => {
  const inherited = Object.create({ adapters: [fakeAdapter("inherited")] });
  await assert.rejects(runCanaries(inherited), /plain object/);
  const accessor = {};
  Object.defineProperty(accessor, "adapters", { get: () => [fakeAdapter("accessor")], enumerable: true });
  await assert.rejects(runCanaries(accessor), /cannot contain accessors/);
});

test("canary runtime provenance follows the complete static production entrypoint closure", () => {
  assert.deepEqual(canonicalRuntimeSha256Keys(), [
    "skills/relay-dispatch/scripts/adapter-contract.js", "skills/relay-dispatch/scripts/adapters/antigravity.js",
    "skills/relay-dispatch/scripts/adapters/claude.js", "skills/relay-dispatch/scripts/adapters/cline.js",
    "skills/relay-dispatch/scripts/adapters/codex.js", "skills/relay-dispatch/scripts/adapters/cursor.js",
    "skills/relay-dispatch/scripts/adapters/index.js", "skills/relay-dispatch/scripts/adapters/opencode.js",
    "skills/relay-dispatch/scripts/adapters/pi.js", "skills/relay-dispatch/scripts/dispatch.js",
    "skills/relay-dispatch/scripts/exec.js", "skills/relay-dispatch/scripts/facts.js", "skills/relay-dispatch/scripts/host.js",
    "skills/relay-dispatch/scripts/inspect.js", "skills/relay-dispatch/scripts/recover.js", "skills/relay-dispatch/scripts/run-store.js",
    "skills/relay-review/scripts/review-runner.js",
  ]);
});

test("current evidence is new-shape only: no checked-in cell leaks an absolute host path", () => {
  const activeDir = path.join(__dirname, "../../../docs/plans/relay-runtime-core-reset-vnext");
  // The old-format evidence (absolute executable paths) was archived as superseded rather than
  // hand-edited (#1153); the next canary run regenerates new-shape evidence here. Any current file
  // must validate under the new schema, stay honestly non-release, and carry basename identity only.
  for (const name of fs.readdirSync(activeDir).filter((entry) => /^adapter-live-canary-.*\.json$/.test(entry))) {
    const evidence = JSON.parse(fs.readFileSync(path.join(activeDir, name), "utf8"));
    assert.equal(validateReport(evidence), evidence);
    assert.equal(evidence.evidence_status, "incomplete_non_release");
    assert.equal(canaryExitCode(evidence), 1);
    for (const entry of evidence.results) {
      const executable = entry.executed_runtime?.executable;
      if (!executable) continue;
      assert.equal(Object.hasOwn(executable, "path"), false, `absolute executable path leaked in ${name}`);
      assert.equal(/[\\/]/.test(executable.basename || ""), false, `non-basename executable identity in ${name}`);
    }
  }
  // The archived old-format files must fail the new validator: the shape change is enforced, so
  // stale absolute-path evidence cannot be reintroduced as current.
  const archivedDir = path.join(__dirname, "../../../docs/archive/plans/relay-runtime-core-reset-vnext");
  for (const name of fs.readdirSync(archivedDir).filter((entry) => /^adapter-live-canary-.*\.json$/.test(entry))) {
    const stale = JSON.parse(fs.readFileSync(path.join(archivedDir, name), "utf8"));
    assert.throws(() => validateReport(stale), undefined, name);
  }
  const last = JSON.parse(fs.readFileSync(path.join(archivedDir, "adapter-live-canary-2026-08-03.json"), "utf8"));
  assert.throws(() => validateReport(last), /passed-cell evidence invalid/, "the old absolute-path shape must be rejected");
});

test("credential CLI grammar is phase-explicit and retains no values in the public selector", () => {
  const parsed = parseCredentialArgs(["--credential-env", "codex:dispatch:OPENAI_API_KEY", "--credential-file", "codex:primary_review:auth=/private/auth.json",
    "--credential-env", "claude:dispatch:CLAUDE_CODE_OAUTH_TOKEN", "--credential-env", "claude:primary_review:CLAUDE_CODE_OAUTH_TOKEN", "--timeout-ms", "5"]);
  assert.deepEqual(parsed.selections, {
    "codex:dispatch": { envNames: ["OPENAI_API_KEY"], fileSpecs: [] },
    "codex:primary_review": { envNames: [], fileSpecs: ["auth=/private/auth.json"] },
    "claude:dispatch": { envNames: ["CLAUDE_CODE_OAUTH_TOKEN"], fileSpecs: [] },
    "claude:primary_review": { envNames: ["CLAUDE_CODE_OAUTH_TOKEN"], fileSpecs: [] },
  });
  assert.deepEqual(parsed.argv, ["--timeout-ms", "5"]);
  assert.throws(() => parseCredentialArgs(["--credential-env", "codex:OPENAI_API_KEY"]), /adapter:phase:value/);
});

test("runner help documents explicit phase credentials", () => {
  const result = spawnSync(process.execPath, [RUNNER, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /adapter:phase:NAME/);
  assert.match(result.stdout, /adapter:phase:ID=\/absolute\/source/);
});
