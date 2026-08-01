const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../../..");
const contractTest = path.join(__dirname, "runtime-contract-vnext.test.js");
const noopRuntime = path.join(
  repoRoot,
  "tests/relay-dispatch/fixtures/runtime-contract-vnext-noop.js",
);

test("vNext contract suite rejects a runtime missing retained createRunRecord behavior", () => {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--test", contractTest],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...childEnv,
        RELAY_VNEXT_CONTRACTS: "1",
        RELAY_VNEXT_RUNTIME_PATH: noopRuntime,
      },
      timeout: 30_000,
    },
  );

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, output);
  assert.match(output, /createRunRecord is not a function/);
});
