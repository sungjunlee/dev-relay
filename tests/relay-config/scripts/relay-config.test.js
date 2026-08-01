const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const SCRIPT = path.join(__dirname, "../../../skills/relay-config/scripts/relay-config.js");

test("relay-config check reports an explicit adapter/model selection", () => {
  const result = spawnSync(process.execPath, [SCRIPT,
    "check", "--phase", "dispatch", "--executor", "codex",
    "--model", "openai/gpt-5", "--json",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.adapter, "codex");
  assert.equal(output.model, "openai/gpt-5");
  assert.equal(output.model_source, "explicit");
  assert.equal(output.capability.supported, true);
});

test("relay-config rejects unsupported primary-review adapters", () => {
  const result = spawnSync(process.execPath, [SCRIPT,
    "check", "--phase", "review", "--reviewer", "cline", "--json",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot run primary_review/);
});

test("relay-config no longer exposes mutation, presets, or catalog commands", () => {
  for (const command of ["init", "preset", "resolve-model", "set-default", "add-route"]) {
    const result = spawnSync(process.execPath, [SCRIPT, command, "--json"], { encoding: "utf8" });
    assert.notEqual(result.status, 0, command);
    assert.match(result.stderr, /unknown command/, command);
  }
});
