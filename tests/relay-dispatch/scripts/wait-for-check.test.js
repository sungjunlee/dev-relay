"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "skills", "relay-dispatch", "scripts", "wait-for-check.js");
const {
  DEFAULT_INTERVAL_S,
  DEFAULT_TIMEOUT_S,
  EXIT,
  MAX_GH_RETRIES,
} = require("../../../skills/relay-dispatch/scripts/wait-for-check");

function installFakeGh() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wait-check-gh-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const responses = JSON.parse(process.env.FAKE_GH_RESPONSES);
const statePath = process.env.FAKE_GH_STATE;
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf-8"))
  : { calls: [] };
const index = state.calls.length;
state.calls.push(process.argv.slice(2));
fs.writeFileSync(statePath, JSON.stringify(state));
const response = responses[Math.min(index, responses.length - 1)];
if (response.type === "error") {
  process.stderr.write(response.message || "transient gh error");
  process.exit(response.status || 1);
}
process.stdout.write(JSON.stringify(response.checks));
if (response.status) process.exit(response.status);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return binDir;
}

function runWait(responses, extraArgs = []) {
  const binDir = installFakeGh();
  const statePath = path.join(binDir, "state.json");
  const result = spawnSync(process.execPath, [
    SCRIPT,
    ...extraArgs,
    "--repo", REPO_ROOT,
    "--pr", "840",
    "--timeout-s", "10",
    "--interval-s", "0",
    "--json",
  ], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      FAKE_GH_RESPONSES: JSON.stringify(responses),
      FAKE_GH_STATE: statePath,
    },
    timeout: 3000,
  });
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf-8"))
    : { calls: [] };
  return { result, state };
}

function parseJsonOutput(result) {
  const output = result.stdout.trim() || result.stderr.trim();
  assert.notEqual(output, "", `expected JSON output; stderr=${result.stderr}`);
  return JSON.parse(output);
}

test("all-terminal checks exit 0 with a deterministic per-check summary", () => {
  const { result, state } = runWait([
    { checks: [{ name: "unit", bucket: "pending" }], status: 8 },
    { checks: [
      { name: "unit", bucket: "pass" },
      { name: "lint", bucket: "skipping" },
    ] },
  ]);

  assert.equal(result.status, EXIT.SUCCESS, result.stderr);
  assert.deepEqual(parseJsonOutput(result), {
    repo: REPO_ROOT,
    pr: 840,
    checks: [
      { name: "lint", bucket: "skipping" },
      { name: "unit", bucket: "pass" },
    ],
    no_checks: false,
    timed_out: false,
    failed_checks: [],
    pending_checks: [],
    ok: true,
    outcome: "success",
  });
  assert.deepEqual(state.calls, [
    ["pr", "checks", "840", "--json", "name,bucket"],
    ["pr", "checks", "840", "--json", "name,bucket"],
  ]);
});

test("failed and cancelled checks use the check-failure exit and name each check", () => {
  const { result } = runWait([{ checks: [
    { name: "build", bucket: "fail" },
    { name: "deploy", bucket: "cancel" },
    { name: "lint", bucket: "pass" },
  ], status: 1 }]);
  const summary = parseJsonOutput(result);

  assert.equal(result.status, EXIT.CHECK_FAILED);
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.timed_out, false);
  assert.deepEqual(summary.failed_checks, ["build", "deploy"]);
  assert.equal(result.stderr, "");
});

test("a PR with no configured checks succeeds explicitly", () => {
  const { result } = runWait([{ checks: [] }]);
  const summary = parseJsonOutput(result);

  assert.equal(result.status, EXIT.SUCCESS, result.stderr);
  assert.equal(summary.outcome, "no_checks");
  assert.equal(summary.no_checks, true);
  assert.deepEqual(summary.checks, []);
});

test("timeout has a distinct exit, timed_out flag, and pending check names", () => {
  const { result } = runWait(
    [{ checks: [
      { name: "unit", bucket: "pending" },
      { name: "integration", bucket: "queued" },
    ], status: 8 }],
    ["--timeout-s", "0"]
  );
  const summary = parseJsonOutput(result);

  assert.equal(result.status, EXIT.TIMEOUT);
  assert.notEqual(result.status, EXIT.CHECK_FAILED);
  assert.equal(summary.outcome, "timeout");
  assert.equal(summary.timed_out, true);
  assert.deepEqual(summary.pending_checks, ["integration", "unit"]);
  assert.deepEqual(summary.failed_checks, []);
  assert.equal(result.stderr, "");
});

test("transient gh errors are retried and persistent errors exhaust a named budget", () => {
  const transient = runWait([
    { checks: [{ name: "unit", bucket: "pending" }], status: 8 },
    { type: "error", message: "temporary API failure" },
    { checks: [{ name: "unit", bucket: "pass" }] },
  ]);
  assert.equal(transient.result.status, EXIT.SUCCESS, transient.result.stderr);
  assert.equal(transient.state.calls.length, 3);

  const persistent = runWait(
    [{ type: "error", message: "API unavailable" }],
    ["--timeout-s", "10"]
  );
  const summary = parseJsonOutput(persistent.result);
  assert.equal(persistent.result.status, EXIT.GH_ERROR);
  assert.equal(summary.outcome, "gh_error");
  assert.equal(summary.error_class, "gh_error");
  assert.equal(summary.retry_budget, MAX_GH_RETRIES);
  assert.equal(summary.attempts, MAX_GH_RETRIES + 1);
  assert.match(summary.error, /API unavailable/);
});

test("unknown flags are rejected before gh is invoked", () => {
  const { result, state } = runWait(
    [{ checks: [] }],
    ["--definitely-unknown"]
  );
  const summary = parseJsonOutput(result);

  assert.equal(result.status, EXIT.USAGE);
  assert.equal(summary.outcome, "usage_error");
  assert.match(summary.error, /unknown flag/i);
  assert.match(summary.error, /--definitely-unknown/);
  assert.deepEqual(state.calls, []);
});

test("help documents rate-limit-polite interval and timeout defaults", () => {
  assert.ok(DEFAULT_INTERVAL_S >= 15);
  assert.ok(DEFAULT_TIMEOUT_S > 0);

  const result = spawnSync(process.execPath, [SCRIPT, "--help"], {
    encoding: "utf-8",
  });
  assert.equal(result.status, EXIT.SUCCESS, result.stderr);
  assert.match(result.stdout, new RegExp(`--interval-s <s>.*default: ${DEFAULT_INTERVAL_S}s`));
  assert.match(result.stdout, new RegExp(`--timeout-s <s>.*default: ${DEFAULT_TIMEOUT_S}s`));
});
