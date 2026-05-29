const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  copyStdoutToResultFile,
  parseJsonObject,
  recoverExecStdout,
  summarizeSpawnResult,
} = require("../../../skills/relay-dispatch/scripts/agent-adapters/transport");

test("transport/copyStdoutToResultFile copies empty stdout to the result file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-agent-transport-"));
  const stdoutLog = path.join(tmp, "stdout.log");
  const resultFile = path.join(tmp, "result.txt");
  fs.writeFileSync(stdoutLog, "", "utf-8");
  fs.writeFileSync(resultFile, "stale result\n", "utf-8");

  const result = copyStdoutToResultFile({
    adapter: "claude",
    phase: "dispatch",
    stdoutLog,
    resultFile,
  });

  assert.deepEqual(result, { copied: true, status: "empty", bytes: 0 });
  assert.equal(fs.readFileSync(resultFile, "utf-8"), "");
});

test("transport/copyStdoutToResultFile reports a missing stdout log without throwing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-agent-transport-missing-"));
  const resultFile = path.join(tmp, "result.txt");

  const result = copyStdoutToResultFile({
    adapter: "opencode",
    phase: "dispatch",
    stdoutLog: path.join(tmp, "missing.log"),
    resultFile,
  });

  assert.deepEqual(result, { copied: false, status: "missing", bytes: 0 });
  assert.equal(fs.existsSync(resultFile), false);
});

test("transport/recoverExecStdout returns trimmed stdout from a non-zero adapter exit", () => {
  const recovered = recoverExecStdout({
    status: 1,
    stdout: "\n{\"verdict\":\"pass\"}\n",
    stderr: "late failure",
  });

  assert.equal(recovered, "{\"verdict\":\"pass\"}");
});

test("transport/parseJsonObject includes adapter and phase in invalid JSON errors", () => {
  assert.throws(
    () => parseJsonObject("not-json", {
      adapter: "codex",
      phase: "primary_review",
      description: "review verdict",
    }),
    /adapter=codex phase=primary_review review verdict must be valid JSON:/
  );
});

test("transport/parseJsonObject rejects non-object JSON with adapter and phase", () => {
  assert.throws(
    () => parseJsonObject("[]", {
      adapter: "opencode",
      phase: "advisory_review",
      description: "advisory review",
    }),
    /adapter=opencode phase=advisory_review advisory review must be a JSON object/
  );
});

test("transport/summarizeSpawnResult reports probe timeouts with context", () => {
  const timeoutError = new Error("spawn ETIMEDOUT");
  timeoutError.code = "ETIMEDOUT";

  const summary = summarizeSpawnResult({
    error: timeoutError,
    status: null,
  }, {
    adapter: "opencode",
    phase: "dispatch_probe",
    timeoutSeconds: 7,
  });

  assert.equal(summary, "probe timed out after 7s (adapter=opencode phase=dispatch_probe)");
});
