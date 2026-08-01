const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runCanaries } = require("../../../skills/relay-dispatch/scripts/adapter-live-canary");
const {
  assertInvocationShape,
  makeParseOutcome,
} = require("../../../skills/relay-dispatch/scripts/adapter-contract");

const CANARY_SCRIPT = path.join(
  __dirname,
  "../../../skills/relay-dispatch/scripts/adapter-live-canary.js"
);
const CHECKED_REPORT = path.join(
  __dirname,
  "../../../docs/plans/relay-runtime-core-reset-vnext/adapter-live-canary-2026-07-31.json"
);

function fakeAdapter(name, mode) {
  return {
    name,
    probe() {
      if (mode === "unavailable") return { status: "skipped", error: `${name} CLI not found`, raw: null };
      if (mode === "probe-timeout") return { status: "failed", error: `${name} --version failed: spawnSync ${name} ETIMEDOUT`, raw: null };
      return { status: "available", error: null, raw: `${name} 1.0.0` };
    },
    capabilities({ phase }) {
      return {
        supported: phase === "primary_review",
        write: false,
        readOnly: true,
        networkControl: "informational",
        cancellation: "process",
        structuredOutput: "json",
      };
    },
    buildInvocation({ cwd }) {
      const source = mode === "credentials"
        ? "process.stderr.write('authentication credentials required'); process.exit(1)"
        : mode === "environment"
          ? "process.stderr.write('SQLITE_READONLY: attempt to write a readonly database'); process.exit(1)"
          : mode === "timeout"
            ? "setTimeout(() => process.stdout.write('{}'), 1000)"
        : "process.stdout.write('{\"verdict\":\"pass\"}')"
      return assertInvocationShape({
        command: process.execPath,
        args: ["-e", source],
        cwd,
      });
    },
    parseOutcome: makeParseOutcome("json_result"),
  };
}

test("live adapter canary distinguishes unavailable CLI, credentials skip, and parsed invocation", () => {
  const report = runCanaries({
    timeoutMs: 3000,
    adapters: [
      fakeAdapter("available", "pass"),
      fakeAdapter("missing", "unavailable"),
      fakeAdapter("no-auth", "credentials"),
      fakeAdapter("sandboxed", "environment"),
    ],
  });
  assert.deepEqual(report.results.map(({ adapter, status, reason }) => ({ adapter, status, reason })), [
    { adapter: "available", status: "passed", reason: "minimal_invocation_parsed" },
    { adapter: "missing", status: "skipped", reason: "cli_unavailable" },
    { adapter: "no-auth", status: "skipped", reason: "credentials_unavailable" },
    { adapter: "sandboxed", status: "skipped", reason: "execution_environment_unavailable" },
  ]);
  assert.deepEqual(report.summary, { passed: 1, skipped: 3, failed: 0 });
});

test("live adapter canary never treats an unavailable read-only phase as a healthy pass", () => {
  const adapter = fakeAdapter("no-review", "pass");
  adapter.capabilities = () => ({
    supported: false,
    reason: "read-only review unsupported",
  });
  const report = runCanaries({ timeoutMs: 3000, adapters: [adapter] });
  assert.equal(report.results[0].status, "skipped");
  assert.equal(report.results[0].reason, "read_only_phase_unavailable");
});

test("live adapter canary classifies probe and invocation timeouts as failures", () => {
  const report = runCanaries({
    timeoutMs: 100,
    adapters: [
      fakeAdapter("slow-probe", "probe-timeout"),
      fakeAdapter("slow-invocation", "timeout"),
    ],
  });
  assert.deepEqual(report.results.map(({ adapter, status, reason }) => ({ adapter, status, reason })), [
    { adapter: "slow-probe", status: "failed", reason: "probe_timeout" },
    { adapter: "slow-invocation", status: "failed", reason: "invocation_timeout" },
  ]);
  assert.deepEqual(report.summary, { passed: 0, skipped: 0, failed: 2 });
});

test("live adapter canary CLI emits JSON and exits non-zero when a probe fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-canary-output-"));
  const outputPath = path.join(root, "report.json");
  const result = spawnSync(process.execPath, [
    CANARY_SCRIPT,
    "--timeout-ms", "1000",
    "--output", outputPath,
  ], {
    cwd: path.join(__dirname, "../../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      RELAY_CLINE_BIN: "/usr/bin/false",
    },
    timeout: 15000,
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(fs.readFileSync(outputPath, "utf8"), result.stdout);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(report.summary.failed, 1);
  assert.equal(report.generated_by, "skills/relay-dispatch/scripts/adapter-live-canary.js");
  assert.match(report.command, /--output/);
  const cline = report.results.find((entry) => entry.adapter === "cline");
  assert.equal(cline.status, "failed");
  assert.equal(cline.reason, "probe_failed");
});

test("checked live report preserves the CLI report schema and summary", () => {
  const report = JSON.parse(fs.readFileSync(CHECKED_REPORT, "utf8"));
  assert.equal(report.generated_by, "skills/relay-dispatch/scripts/adapter-live-canary.js");
  assert.match(report.command, /^node skills\/relay-dispatch\/scripts\/adapter-live-canary\.js /);
  assert.equal(report.results.length, 7);
  assert.deepEqual(
    report.summary,
    {
      passed: report.results.filter((entry) => entry.status === "passed").length,
      skipped: report.results.filter((entry) => entry.status === "skipped").length,
      failed: report.results.filter((entry) => entry.status === "failed").length,
    }
  );
  for (const entry of report.results) {
    assert.equal(typeof entry.adapter, "string");
    assert.ok(["passed", "skipped", "failed"].includes(entry.status));
    assert.equal(typeof entry.reason, "string");
    assert.equal(typeof entry.probe?.status, "string");
  }
});

test("live adapter canary CLI fails closed on a forced probe timeout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-canary-timeout-"));
  const slowCline = path.join(root, "slow-cline");
  fs.writeFileSync(slowCline, `#!${process.execPath}\nsetTimeout(() => {}, 5000);\n`, "utf8");
  fs.chmodSync(slowCline, 0o755);
  const result = spawnSync(process.execPath, [CANARY_SCRIPT, "--timeout-ms", "100"], {
    cwd: path.join(__dirname, "../../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      RELAY_CLINE_BIN: slowCline,
    },
    timeout: 15000,
  });
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.failed, 1);
  const cline = report.results.find((entry) => entry.adapter === "cline");
  assert.equal(cline.status, "failed");
  assert.equal(cline.reason, "probe_timeout");
});
