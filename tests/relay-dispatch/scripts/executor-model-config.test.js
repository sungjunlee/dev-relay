const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  loadExecutorModelConfig,
  resolveExecutorDefaultModel,
  validateExecutorModelConfig,
} = require("../../../skills/relay-dispatch/scripts/executor-model-config");

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
  return filePath;
}

function withCapturedStderr(fn) {
  const original = console.error;
  const messages = [];
  console.error = (message) => messages.push(String(message));
  try {
    return { result: fn(), messages };
  } finally {
    console.error = original;
  }
}

test("validateExecutorModelConfig rejects invalid schema shapes", () => {
  assert.throws(
    () => validateExecutorModelConfig([], "bad.json"),
    /expected object/
  );
  assert.throws(
    () => validateExecutorModelConfig({ executors: [] }, "bad.json"),
    /executors must be an object/
  );
  assert.throws(
    () => validateExecutorModelConfig({ executors: { opencode: [] } }, "bad.json"),
    /executors\.opencode must be an object/
  );
  assert.throws(
    () => validateExecutorModelConfig({ executors: { opencode: { default_model: " " } } }, "bad.json"),
    /default_model must be a non-empty string/
  );
  assert.throws(
    () => validateExecutorModelConfig({ executors: { opencode: { candidate_models: "model" } } }, "bad.json"),
    /candidate_models must be an array/
  );
  assert.throws(
    () => validateExecutorModelConfig({ executors: { opencode: { candidate_models: ["ok", ""] } } }, "bad.json"),
    /candidate_models\[1\] must be a non-empty string/
  );
});

test("optional local schema errors are ignored with bundled fallback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-executor-model-config-"));
  const localPath = writeJson(path.join(dir, "executors.json"), {
    executors: {
      opencode: {
        default_model: 123,
      },
    },
  });

  const { result, messages } = withCapturedStderr(() => resolveExecutorDefaultModel("opencode", { localPath }));

  assert.equal(result, "opencode-go/deepseek-v4-pro");
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Warning: ignoring optional executor model config/);
  assert.match(messages[0], /default_model must be a non-empty string/);
});

test("local config can introduce defaults for executors absent from the bundled config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-executor-model-config-"));
  const localPath = writeJson(path.join(dir, "executors.json"), {
    executors: {
      codex: {
        default_model: "gpt-5.5",
      },
    },
  });

  assert.equal(resolveExecutorDefaultModel("codex", { localPath }), "gpt-5.5");
});

test("loadExecutorModelConfig merges bundled and local executor entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-executor-model-config-"));
  const localPath = writeJson(path.join(dir, "executors.json"), {
    executors: {
      opencode: {
        default_model: "opencode-go/qwen3.6-plus",
      },
      codex: {
        default_model: "gpt-5.5",
      },
    },
  });

  const config = loadExecutorModelConfig({ localPath });

  assert.equal(config.executors.opencode.default_model, "opencode-go/qwen3.6-plus");
  assert.deepEqual(config.executors.opencode.candidate_models, [
    "opencode-go/deepseek-v4-pro",
    "opencode-go/deepseek-v4-flash",
    "opencode-go/qwen3.6-plus",
    "opencode-go/qwen3.5-plus",
    "opencode-go/kimi-k2.6",
    "opencode-go/glm-5.1",
  ]);
  assert.equal(config.executors.codex.default_model, "gpt-5.5");
});
