const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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

test("relay-config requires the exact actor flag for each phase", () => {
  const invalid = [
    ["dispatch", "--reviewer", "codex"],
    ["dispatch", "--executor", "codex", "--reviewer", "claude"],
    ["review", "--executor", "codex"],
    ["review", "--reviewer", "codex", "--executor", "claude"],
  ];
  for (const args of invalid) {
    const result = spawnSync(process.execPath, [SCRIPT, "check", "--phase", ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /requires --(?:executor|reviewer) only/, args.join(" "));
  }
});

test("relay-config no longer exposes mutation, presets, or catalog commands", () => {
  for (const command of ["init", "preset", "resolve-model", "set-default", "add-route"]) {
    const result = spawnSync(process.execPath, [SCRIPT, command, "--json"], { encoding: "utf8" });
    assert.notEqual(result.status, 0, command);
    assert.match(result.stderr, /unknown command/, command);
  }
});

test("relay-config doctor reports all seven built-in adapters without policy writes", () => {
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "relay-config-path-"));
  const result = spawnSync(process.execPath, [SCRIPT, "doctor", "--json"], {
    encoding: "utf8",
    env: { ...process.env, PATH: emptyPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout).adapters.map((entry) => entry.adapter),
    ["claude", "codex", "opencode", "pi", "antigravity", "cursor", "cline"],
  );
});

test("operator docs use the executable explicit check syntax and no route setup surface", () => {
  const root = path.resolve(__dirname, "../../..");
  const documents = [
    "README.md",
    "docs/model-route-policy.md",
    "docs/relay-operator-guide.md",
    "skills/relay-config/SKILL.md",
    "references/install-graph.md",
  ].map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  assert.match(documents, /check --phase dispatch --executor/);
  assert.match(documents, /check --phase review --reviewer/);
  assert.doesNotMatch(documents, /relay-config Set up|check dispatch opencode|check review pi|delegates all policy mutations/);
});
