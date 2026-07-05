const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  loadExecutorModelConfig,
  resolveExecutorDefaultModel,
  validateExecutorModelConfig,
} = require("../../../skills/relay-dispatch/scripts/executor-model-config");
const { getProjectRoutesPath } = require("../../../skills/relay-dispatch/scripts/manifest/paths");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
  return filePath;
}

function initGitRepo(repoRoot) {
  fs.mkdirSync(repoRoot, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
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

test("optional local schema errors are ignored without inventing a fallback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-executor-model-config-"));
  const localPath = writeJson(path.join(dir, "executors.json"), {
    executors: {
      opencode: {
        default_model: 123,
      },
    },
  });

  const { result, messages } = withCapturedStderr(() => resolveExecutorDefaultModel("opencode", { localPath }));

  assert.equal(result, null);
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

test("loadExecutorModelConfig preserves local executor entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-executor-model-config-"));
  const localPath = writeJson(path.join(dir, "executors.json"), {
    executors: {
      opencode: {
        default_model: "example/opencode-model-local",
        candidate_models: ["example/opencode-model-local"],
      },
      codex: {
        default_model: "gpt-5.5",
      },
    },
  });

  const config = loadExecutorModelConfig({ localPath });

  assert.equal(config.executors.opencode.default_model, "example/opencode-model-local");
  assert.deepEqual(config.executors.opencode.candidate_models, ["example/opencode-model-local"]);
  assert.equal(config.executors.codex.default_model, "gpt-5.5");
});

test("routes config executor_defaults override legacy executors config when routes is source of truth", () => {
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-executor-model-config-"));
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: false,
    defaults: {
      dispatch: { executor: "opencode" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    executor_defaults: {
      opencode: { model: "openai/routes-default" },
    },
    routes: [],
    denied_routes: [],
    presets: {},
  });
  writeJson(path.join(relayHome, "executors.json"), {
    executors: {
      opencode: {
        default_model: "openai/legacy-default",
      },
    },
  });

  assert.equal(resolveExecutorDefaultModel("opencode", { relayHome }), "openai/routes-default");
});

test("project routes executor_defaults override global routes defaults in shared resolver", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-executor-model-config-"));
  const relayHome = path.join(root, "relay-home");
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    strict: false,
    defaults: {
      dispatch: { executor: "opencode" },
      review: { reviewer: "codex" },
      advisory_review: null,
    },
    executor_defaults: {
      opencode: { model: "openai/global-default" },
    },
    routes: [],
    denied_routes: [],
    presets: {},
  });
  writeJson(getProjectRoutesPath(repoRoot, { relayHome }), {
    version: 2,
    executor_defaults: {
      opencode: { model: "openai/project-default" },
    },
  });

  assert.equal(resolveExecutorDefaultModel("opencode", { relayHome, repoRoot }), "openai/project-default");
  assert.equal(loadExecutorModelConfig({ relayHome, repoRoot }).executors.opencode.default_model, "openai/project-default");
});

test("default-model resolution without repoRoot uses only the global scope (no cwd fallback)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-executor-model-config-"));
  const relayHome = path.join(root, "relay-home");
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  writeJson(path.join(relayHome, "routes.json"), {
    version: 2,
    executor_defaults: {
      opencode: { model: "openai/global-default" },
    },
  });
  writeJson(getProjectRoutesPath(repoRoot, { relayHome }), {
    version: 2,
    executor_defaults: {
      opencode: { model: "openai/project-default" },
    },
  });

  const previousCwd = process.cwd();
  process.chdir(repoRoot);
  try {
    // Without an explicit repoRoot the resolver must not pick up the
    // project routes of whatever directory it happens to run in.
    assert.equal(resolveExecutorDefaultModel("opencode", { relayHome }), "openai/global-default");
  } finally {
    process.chdir(previousCwd);
  }
});
