const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Scope boundary: these tests cover the deterministic probe CLI and event line
// recording only. TTY detection, AskUserQuestion, and y/n/abort routing live in
// the /relay orchestrator instructions and are tested at that layer.

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "skills", "relay-ready", "scripts", "probe-readiness.js");

function runProbe(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf-8",
    input: options.input,
  });
}

function parseJson(stdout) {
  assert.doesNotThrow(() => JSON.parse(stdout), `stdout was not JSON: ${stdout}`);
  return JSON.parse(stdout);
}

function assertEnvelopeShape(envelope) {
  assert.equal(typeof envelope, "object");
  assert.equal(typeof envelope.readiness_score, "object");
  assert.equal(typeof envelope.readiness_score.clarity, "string");
  assert.equal(typeof envelope.readiness_score.granularity, "string");
  assert.equal(typeof envelope.readiness_score.verifiability, "string");
  assert.equal(typeof envelope.bypass, "boolean");
  assert.ok(["proceed", "qa_needed", "escalate"].includes(envelope.next_action));
  assert.equal(typeof envelope.signals_summary, "string");
  assert.ok(envelope.signals_summary.length <= 140, envelope.signals_summary);
  assert.equal(typeof envelope.elapsed_ms, "number");
}

function deterministic5KbBypassBody() {
  const base = `Fix \`skills/relay-ready/scripts/probe-readiness.js\` JSON envelope emission.

## Done Criteria

- \`skills/relay-ready/scripts/probe-readiness.js\` prints deterministic JSON.
- \`tests/relay-ready/scripts/probe-readiness.test.js\` passes.
- p95 < 200ms over 50 runs.

`;
  const filler = "The probe uses deterministic regex scoring with bounded output for audit. ";
  const body = (base + filler.repeat(100)).slice(0, 5 * 1024);
  assert.equal(Buffer.byteLength(body, "utf-8"), 5 * 1024);
  return body;
}

test("happy_path_bypass emits proceed envelope under 200ms for a 5KB issue body", (t) => {
  const bodyPath = path.join(os.tmpdir(), `relay-437-happy-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(bodyPath, deterministic5KbBypassBody(), "utf-8");
  t.after(() => fs.rmSync(bodyPath, { force: true }));

  const start = process.hrtime.bigint();
  const result = runProbe(["--json", "--body-file", bodyPath]);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsedMs < 200, `elapsed=${elapsedMs}ms`);
  const envelope = parseJson(result.stdout);
  assertEnvelopeShape(envelope);
  assert.equal(envelope.bypass, true);
  assert.equal(envelope.next_action, "proceed");
});

test("non_bypass_emits_summary returns a bounded human summary for low scores", () => {
  const result = runProbe(["--json", "--body", "Polish the thing."]);

  assert.equal(result.status, 0, result.stderr);
  const envelope = parseJson(result.stdout);
  assertEnvelopeShape(envelope);
  assert.equal(envelope.bypass, false);
  assert.ok(envelope.signals_summary.length > 0);
  assert.ok(envelope.signals_summary.length <= 140);
});

test("manifest_event_appended writes one readiness_probe line with probe payload", (t) => {
  const eventsPath = path.join(os.tmpdir(), `relay-437-test-events-${process.pid}-${Date.now()}.jsonl`);
  t.after(() => fs.rmSync(eventsPath, { force: true }));

  const result = runProbe([
    "--json",
    "--body",
    deterministic5KbBypassBody(),
    "--manifest",
    eventsPath,
    "--issue-number",
    "437",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const envelope = parseJson(result.stdout);
  const lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, "readiness_probe");
  assert.equal(event.issue_number, 437);
  assert.deepEqual(event.readiness_score, envelope.readiness_score);
  assert.equal(event.bypass, envelope.bypass);
  assert.equal(event.next_action, envelope.next_action);
  assert.equal(event.elapsed_ms, envelope.elapsed_ms);
});

test("non_interactive_abort_signal exposes bypass and escalate action for orchestrator routing", () => {
  const body = "Delete the production auth schema and clean up related secrets.";
  const result = runProbe(["--json", "--body", body]);

  assert.equal(result.status, 0, result.stderr);
  const envelope = parseJson(result.stdout);
  assertEnvelopeShape(envelope);
  assert.equal(envelope.bypass, false);
  assert.equal(envelope.next_action, "escalate");
});

test("performance_microbenchmark keeps p95 elapsed_ms below 200ms over 50 CLI invocations", (t) => {
  const bodyPath = path.join(os.tmpdir(), `relay-437-bench-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(bodyPath, deterministic5KbBypassBody(), "utf-8");
  t.after(() => fs.rmSync(bodyPath, { force: true }));

  const durations = [];
  for (let index = 0; index < 50; index += 1) {
    const result = runProbe(["--json", "--body-file", bodyPath]);
    assert.equal(result.status, 0, result.stderr);
    const envelope = parseJson(result.stdout);
    assertEnvelopeShape(envelope);
    durations.push(envelope.elapsed_ms);
  }

  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.ok(p95 < 200, `p95=${p95}ms`);
});

test("static audit confirms probe CLI has no subprocess prompting imports", () => {
  const source = fs.readFileSync(SCRIPT, "utf-8");
  const forbiddenImports = [
    /require\(["'](?:node:)?readline["']\)/,
    /require\(["']inquirer["']\)/,
    /require\(["']prompt["']\)/,
    /require\(["']enquirer["']\)/,
    /from\s+["'](?:node:)?readline["']/,
    /from\s+["']inquirer["']/,
    /from\s+["']prompt["']/,
    /from\s+["']enquirer["']/,
  ];

  for (const token of forbiddenImports) {
    assert.doesNotMatch(source, token);
  }
});

test("static audit confirms probe CLI uses relay-events helper for event writes", () => {
  const source = fs.readFileSync(SCRIPT, "utf-8");

  assert.match(source, /appendEventLineToPath/);
  assert.doesNotMatch(source, /appendTextFileWithoutFollowingSymlinks/);
});

test("malformed input fails open with exit 0 and a degraded proceed envelope", () => {
  const missingPath = path.join(os.tmpdir(), `relay-437-missing-${process.pid}-${Date.now()}.md`);
  const result = runProbe(["--json", "--body-file", missingPath]);

  assert.equal(result.status, 0, result.stderr);
  const envelope = parseJson(result.stdout);
  assertEnvelopeShape(envelope);
  assert.equal(envelope.bypass, true);
  assert.equal(envelope.next_action, "proceed");
  assert.ok(envelope.signals_summary.length > 0);
});
