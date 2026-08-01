const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatAdapterPhase,
  parseJsonObject,
  recoverExecStdout,
} = require("../../../skills/relay-dispatch/scripts/adapter-contract");

test("flat contract formats immutable adapter phase context", () => {
  assert.equal(formatAdapterPhase({ adapter: "claude", phase: "dispatch" }), "adapter=claude phase=dispatch");
});

test("flat contract recovers trimmed stdout from a non-zero adapter exit", () => {
  const recovered = recoverExecStdout({
    status: 1,
    stdout: "\n{\"verdict\":\"pass\"}\n",
    stderr: "late failure",
  });

  assert.equal(recovered, "{\"verdict\":\"pass\"}");
});

test("flat contract JSON parser includes adapter and phase in invalid JSON errors", () => {
  assert.throws(
    () => parseJsonObject("not-json", {
      adapter: "codex",
      phase: "primary_review",
      description: "review verdict",
    }),
    /adapter=codex phase=primary_review review verdict must be valid JSON:/
  );
});
