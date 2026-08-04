const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..", "..");
const LOCAL_CLI_TARGETS = [
  "skills/relay-config/scripts/relay-config.js",
  "skills/relay-merge/scripts/run-full-gate.js", "skills/relay-plan/scripts/persist-done-criteria.js",
  "skills/relay-plan/scripts/probe-executor-env.js", "skills/relay-ready/scripts/persist-request.js",
  "skills/relay-review/scripts/review-runner.js",
  "skills/relay/scripts/relay-recover.js", "skills/relay/scripts/relay-status.js", "skills/relay/scripts/run-preflight.js",
];

test("each local closed CLI parser serves --help", () => {
  const failures = LOCAL_CLI_TARGETS.flatMap((relative) => {
    const absolute = path.join(ROOT, relative);
    const result = spawnSync(process.execPath, [absolute, "--help"], { encoding: "utf8" });
    return result.status === 0 ? [] : [{
      path: path.relative(ROOT, absolute),
      status: result.status,
      stderr: result.stderr,
    }];
  });
  assert.deepEqual(failures, []);
});
