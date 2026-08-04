// Regression: every destructive relay CLI must reject unknown flags via
// findUnknownFlags. Without this, silently-accepted typos like
// `finalize-run.js --no-merge` (real flag: --skip-merge) can drive
// unauthorized side effects — see #407 and the 2026-05-02 PR #392 incident.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");

const CLI_TARGETS = [
  // [skill, script-relative-path, args-that-include-an-unknown-flag, unknown-flag-token]
  ["relay-merge", "skills/relay-merge/scripts/finalize-run.js",
    ["--run-id", "fake", "--no-merge"], "--no-merge"],
  ["relay-merge", "skills/relay-merge/scripts/gate-check.js",
    ["123", "--no-merge"], "--no-merge"],
  ["relay-dispatch", "skills/relay-dispatch/scripts/dispatch.js",
    [".", "--branch", "fake", "--prompt", "x", "--no-merge"], "--no-merge"],
  ["relay", "skills/relay/scripts/relay-recover.js",
    ["inspect", "--repo", ".", "--run-id", "fake", "--no-merge"], "--no-merge"],
  ["relay-review", "skills/relay-review/scripts/review-runner.js",
    ["--repo", ".", "--run-id", "fake", "--no-merge"], "--no-merge"],
  ["relay-plan", "skills/relay-plan/scripts/probe-executor-env.js",
    ["--project-only", "--no-merge"], "--no-merge"],
  ["relay-ready", "skills/relay-ready/scripts/persist-request.js",
    ["--json", "--no-merge"], "--no-merge"],
];

for (const [skill, scriptRel, args, unknownFlag] of CLI_TARGETS) {
  test(`${skill}: ${path.basename(scriptRel)} rejects unknown flag ${unknownFlag}`, () => {
    const scriptPath = path.join(REPO_ROOT, scriptRel);
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      encoding: "utf-8",
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.notStrictEqual(result.status, 0,
      `expected non-zero exit; got ${result.status}\n${combined}`);
    assert.ok(/unknown (?:flag|option)/i.test(combined),
      `expected stderr to mention an unknown option; got:\n${combined}`);
    assert.ok(combined.includes(unknownFlag),
      `expected stderr to name the flag ${unknownFlag}; got:\n${combined}`);
  });
}
