const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeParseOutcome } = require("../../../skills/relay-dispatch/scripts/adapter-contract");
const { listAdapters } = require("../../../skills/relay-dispatch/scripts/adapters");
const { canaryExitCode, parseCredentialArgs, requiredMatrix, runCanaries, validateCanaryVerdict, validateReport } = require("./adapter-live-canary-runner");

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
      else if (mode === "wrong-nonce") source = "process.stdout.write(JSON.stringify({nonce:'stale'}))";
      else if (mode === "fallback-marker") source = "process.stdout.write(JSON.stringify({nonce:'fallback'}))";
      else if (mode === "delayed-grandchild") source = `const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{detached:true,stdio:'ignore'});c.unref();process.stdout.write(JSON.stringify({nonce:${JSON.stringify(nonce)}}))`;
      else if (phase === "dispatch") {
        const file = `RELAY_CANARY_${nonce}.txt`;
        source = `require('fs').writeFileSync(${JSON.stringify(path.join(cwd, file))},${JSON.stringify(`${nonce}\n`)});process.stdout.write('done')`;
      } else source = `process.stdout.write(JSON.stringify({nonce:${JSON.stringify(nonce)}}))`;
      return { command: process.execPath, args: ["-e", source], cwd, stdinPath: promptPath, stdinSha256: hash(promptBytes) };
    },
    parseOutcome(input) { return makeParseOutcome(input.phase === "dispatch" ? "text_stdout" : "json_result")(input); },
  };
}

test("two production phase cells pass only with explicit credentials and exact nonce evidence", { skip: process.platform !== "darwin" }, async () => {
  process.env.TEST_CANARY_TOKEN = "unit-secret";
  const report = await runCanaries({ timeoutMs: 3_000, adapters: [fakeAdapter("healthy")],
    credentialSelections: selection("healthy:dispatch", "healthy:primary_review") });
  assert.equal(report.summary.required, 2);
  assert.equal(report.summary.passed, 2, JSON.stringify(report.results));
  assert.equal(canaryExitCode(report), 0);
  for (const result of report.results) {
    assert.equal(result.status, "passed"); assert.equal(result.checks.nonce, "passed");
    assert.match(result.invocation_sha256, /^[a-f0-9]{64}$/); assert.match(result.output_sha256, /^[a-f0-9]{64}$/);
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

test("provisioned authentication failure is failed, never skipped or not_run", { skip: process.platform !== "darwin" }, async () => {
  process.env.TEST_CANARY_TOKEN = "wrong-secret";
  const report = await runCanaries({ timeoutMs: 3_000, adapters: [fakeAdapter("auth", "auth")],
    credentialSelections: selection("auth:dispatch", "auth:primary_review") });
  assert.ok(report.results.every((entry) => entry.status === "failed"), JSON.stringify(report.results));
  assert.ok(report.results.every((entry) => entry.reason === "credential_auth_failed"));
  assert.equal(canaryExitCode(report), 1);
});

test("boundary mutation and stale or fallback nonce cannot produce a pass", { skip: process.platform !== "darwin" }, async () => {
  process.env.TEST_CANARY_TOKEN = "unit-secret";
  for (const mode of ["wrong-nonce", "fallback-marker"]) {
    const report = await runCanaries({ timeoutMs: 3_000, adapters: [fakeAdapter("negative", mode)],
      credentialSelections: selection("negative:dispatch", "negative:primary_review") });
    assert.equal(canaryExitCode(report), 1);
    assert.ok(report.results.some((entry) => entry.status === "failed"));
  }
  const state = {}, report = await runCanaries({ timeoutMs: 3_000, adapters: [fakeAdapter("mutator", "builder-mutation", state)],
    credentialSelections: selection("mutator:dispatch", "mutator:primary_review"), onFixture(fixture) { state.target = path.join(fixture.outside, "sentinel"); } });
  assert.equal(canaryExitCode(report), 1);
  assert.ok(report.results.some((entry) => entry.reason === "boundary_mutated"));
});

test("report integrity rejects duplicate, missing, unknown status, and partial phase coverage", () => {
  const digest = "a".repeat(64), cell = (phase) => ({ adapter: "a", phase, status: "passed", nonce_sha256: digest, prompt_sha256: digest,
    invocation_sha256: digest, output_sha256: digest, probe: { status: "available" }, checks: { boundary: "passed", nonce: "passed", cleanup: "passed", process_scope_absent: "passed" } });
  const base = { schema_version: 2, evidence_status: "release_complete", provenance: { git_head: "a".repeat(40), git_tree: "b".repeat(40),
    dirty_digest: digest, runner_sha256: digest, runtime_sha256: { "host.js": digest }, platform: "darwin", arch: "arm64", node: "v22" },
    policy: { required_cells: ["a:dispatch", "a:primary_review"] }, results: [cell("dispatch"), cell("primary_review")],
    summary: { required: 2, passed: 2, not_run: 0, failed: 0, missing: [] } };
  assert.equal(canaryExitCode(validateReport(base)), 0);
  for (const bad of [
    { ...base, results: [base.results[0]] },
    { ...base, results: [base.results[0], base.results[0]] },
    { ...base, results: [{ ...base.results[0], status: "skipped" }, base.results[1]] },
    { ...base, summary: { ...base.summary, passed: 1, missing: ["a:primary_review"] } },
    { ...base, results: [{ ...base.results[0], output_sha256: null }, base.results[1]] },
    { ...base, results: [{ ...base.results[0], fallback: { diagnostic: true } }, base.results[1]] },
  ]) assert.equal(canaryExitCode(bad), 1);
});

test("checked-in current evidence is schema-valid and honestly non-release", () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../docs/plans/relay-runtime-core-reset-vnext/adapter-live-canary-2026-08-02.json"), "utf8"));
  assert.equal(validateReport(evidence), evidence);
  assert.equal(evidence.policy.required_cells.length, 13);
  assert.equal(evidence.evidence_status, "incomplete_non_release");
  assert.equal(canaryExitCode(evidence), 1);
  assert.equal(JSON.stringify(evidence).includes("source_path"), false);
});

test("credential CLI grammar is phase-explicit and retains no values in the public selector", () => {
  const parsed = parseCredentialArgs(["--credential-env", "codex:dispatch:OPENAI_API_KEY", "--credential-file", "codex:primary_review:auth=/private/auth.json", "--timeout-ms", "5"]);
  assert.deepEqual(parsed.selections, {
    "codex:dispatch": { envNames: ["OPENAI_API_KEY"], fileSpecs: [] },
    "codex:primary_review": { envNames: [], fileSpecs: ["auth=/private/auth.json"] },
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
