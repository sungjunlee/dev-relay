const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const {
  COMMAND_FLAGS,
  FLAGS,
  BOOLEAN,
  MODE_PARSED,
  MODE_VERBATIM,
  VALUE,
  formatFlagAuditMarkdown,
  getFlagMode,
  hasFlag,
  readArg,
} = require("../../../skills/relay-dispatch/scripts/cli-schema");

const valueFlags = FLAGS.filter((flag) => flag.kind === VALUE);
const verbatimFlags = valueFlags.filter((flag) => flag.mode === MODE_VERBATIM);
const parsedValueFlags = valueFlags.filter((flag) => flag.mode === MODE_PARSED);
const CLI_SCHEMA_FIXTURE = path.join(__dirname, "..", "fixtures", "cli-schema-reader.js");

function runCliSchemaFixture(argv, { flag, fallback = "fallback", commandName } = {}) {
  const env = {
    ...process.env,
    CLI_SCHEMA_TEST_FLAG: flag,
    CLI_SCHEMA_TEST_FALLBACK: fallback,
  };

  if (commandName) {
    env.CLI_SCHEMA_TEST_COMMAND = commandName;
  } else {
    delete env.CLI_SCHEMA_TEST_COMMAND;
  }

  return JSON.parse(
    execFileSync(process.execPath, [CLI_SCHEMA_FIXTURE, ...argv], {
      encoding: "utf-8",
      env,
    })
  );
}

test("every registered command flag has an explicit parsed/verbatim mode", () => {
  for (const [commandName, flags] of Object.entries(COMMAND_FLAGS)) {
    for (const flag of flags) {
      assert.match(getFlagMode(flag), /^(parsed|verbatim)$/, `${commandName} ${flag}`);
    }
  }
});

test("unregistered flag reads fail closed", () => {
  assert.throws(
    () => readArg(["--unknown", "value"], "--unknown"),
    /Unregistered CLI flag: --unknown/
  );
});

for (const definition of verbatimFlags) {
  const flag = definition.flag;

  test(`${flag} verbatim mode preserves adversarial values through argv`, () => {
    const acceptedCases = [
      { label: "--prefix value", argv: [flag, "--watch"], expected: "--watch" },
      { label: "reserved token", argv: [flag, "--skip-review"], expected: "--skip-review" },
      { label: "unicode", argv: [flag, "📦 bootstrap"], expected: "📦 bootstrap" },
      { label: "shell-special chars", argv: [flag, "npm test && echo done"], expected: "npm test && echo done" },
      { label: "quotes", argv: [flag, "a\"b'c"], expected: "a\"b'c" },
      { label: "final token fallback", argv: [flag], expected: "fallback" },
      { label: "--flag=value", argv: [`${flag}=--inline`], expected: "--inline" },
    ];

    for (const testCase of acceptedCases) {
      assert.deepEqual(
        runCliSchemaFixture(testCase.argv, { flag }),
        { ok: true, value: testCase.expected },
        `${flag} ${testCase.label}`
      );
    }

    for (const testCase of [
      { label: "empty string", argv: [flag, ""] },
      { label: "whitespace-only", argv: [flag, "   "] },
      { label: "--flag= empty string", argv: [`${flag}=`] },
      { label: "--flag= whitespace-only", argv: [`${flag}=   `] },
    ]) {
      const result = runCliSchemaFixture(testCase.argv, { flag });
      assert.equal(result.ok, false, `${flag} ${testCase.label}`);
      assert.match(result.message, /requires a non-empty value/, `${flag} ${testCase.label}`);
    }
  });
}

test("verbatim values that look like flags do not activate sibling flags", () => {
  const args = ["--test-command", "--json"];
  assert.equal(readArg(args, "--test-command", undefined, { commandName: "dispatch" }), "--json");
  assert.equal(hasFlag(args, "--json", { commandName: "dispatch" }), false);
});

for (const definition of parsedValueFlags) {
  const flag = definition.flag;

  test(`${flag} parsed mode treats --prefix input as missing through argv`, () => {
    assert.deepEqual(runCliSchemaFixture([flag, "--watch"], { flag }), { ok: true, value: "fallback" });
    assert.deepEqual(runCliSchemaFixture([`${flag}=--watch`], { flag }), { ok: true, value: "fallback" });
  });
}

test("--flag value and --flag=value forms both work", () => {
  assert.equal(readArg(["--prompt", "do work"], "--prompt"), "do work");
  assert.equal(readArg(["--prompt=do work"], "--prompt"), "do work");
  assert.equal(readArg(["--timeout", "60"], "--timeout"), "60");
  assert.equal(readArg(["--timeout=60"], "--timeout"), "60");
});

test("flag audit markdown enumerates every migrated flag", () => {
  const table = formatFlagAuditMarkdown();
  for (const definition of FLAGS) {
    assert.match(table, new RegExp(`\\| \`${definition.flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(table, new RegExp(`\\| \`${definition.mode}\` \\|`));
  }
});

test("recover-commit flags are registered with explicit required modes", () => {
  const definitions = new Map(FLAGS.map((definition) => [definition.flag, definition]));
  const expected = [
    ["--reason", VALUE, MODE_VERBATIM],
    ["--pr-title", VALUE, MODE_VERBATIM],
    ["--pr-body-file", VALUE, MODE_VERBATIM],
    ["--manifest", VALUE, MODE_VERBATIM],
    ["--test-command", VALUE, MODE_VERBATIM],
    ["--test-result-file", VALUE, MODE_VERBATIM],
    ["--test-exit-code", VALUE, MODE_PARSED],
    ["--replace-placeholder-evidence", BOOLEAN, MODE_PARSED],
    ["--run-id", VALUE, MODE_PARSED],
    ["--dry-run", BOOLEAN, MODE_PARSED],
    ["--json", BOOLEAN, MODE_PARSED],
    ["--help", BOOLEAN, MODE_PARSED],
  ];

  for (const [flag, kind, mode] of expected) {
    assert.ok(COMMAND_FLAGS["recover-commit"].includes(flag), `recover-commit should allow ${flag}`);
    assert.equal(definitions.get(flag)?.kind, kind, `${flag} kind`);
    assert.equal(definitions.get(flag)?.mode, mode, `${flag} mode`);
  }
});

test("reconcile-run flags are registered with explicit required modes", () => {
  const definitions = new Map(FLAGS.map((definition) => [definition.flag, definition]));
  const expected = [
    ["--repo", VALUE, MODE_VERBATIM],
    ["--run-id", VALUE, MODE_PARSED],
    ["--dry-run", BOOLEAN, MODE_PARSED],
    ["--json", BOOLEAN, MODE_PARSED],
    ["--help", BOOLEAN, MODE_PARSED],
  ];

  for (const [flag, kind, mode] of expected) {
    assert.ok(COMMAND_FLAGS["reconcile-run"].includes(flag), `reconcile-run should allow ${flag}`);
    assert.equal(definitions.get(flag)?.kind, kind, `${flag} kind`);
    assert.equal(definitions.get(flag)?.mode, mode, `${flag} mode`);
  }
});

test("dispatch registers --route-preset as a parsed value flag", () => {
  const definition = FLAGS.find((entry) => entry.flag === "--route-preset");
  assert.ok(definition, "--route-preset should be registered");
  assert.equal(definition.kind, VALUE);
  assert.equal(definition.mode, MODE_PARSED);
  assert.ok(COMMAND_FLAGS.dispatch.includes("--route-preset"));
});

const HELP_COMMANDS = [
  ["cleanup-worktrees", path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "cleanup-worktrees.js")],
  ["close-run", path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "close-run.js")],
  ["create-worktree", path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "create-worktree.js")],
  ["dispatch", path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "dispatch.js")],
  ["extend-review-policy", path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "extend-review-policy.js")],
  ["finalize-run", path.join(__dirname, "..", "..", "..", "skills", "relay-merge", "scripts", "finalize-run.js")],
  ["gate-check", path.join(__dirname, "..", "..", "..", "skills", "relay-merge", "scripts", "gate-check.js")],
  ["invoke-reviewer-antigravity", path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "invoke-reviewer-antigravity.js")],
  ["invoke-reviewer-cursor", path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "invoke-reviewer-cursor.js")],
  ["invoke-reviewer-claude", path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "invoke-reviewer-claude.js")],
  ["invoke-reviewer-codex", path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "invoke-reviewer-codex.js")],
  ["invoke-reviewer-pi", path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "invoke-reviewer-pi.js")],
  ["persist-request", path.join(__dirname, "..", "..", "..", "skills", "relay-ready", "scripts", "persist-request.js")],
  ["probe-executor-env", path.join(__dirname, "..", "..", "..", "skills", "relay-plan", "scripts", "probe-executor-env.js")],
  ["recover-commit", path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "recover-commit.js")],
  ["reconcile-run", path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "reconcile-run.js")],
  ["relay-config", path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "relay-config.js")],
  ["rebrand-evidence", path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "rebrand-evidence.js")],
  ["recover-state", path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "recover-state.js")],
  ["reliability-report", path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "reliability-report.js")],
  ["review-runner", path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "review-runner.js")],
  ["run-full-gate", path.join(__dirname, "..", "..", "..", "skills", "relay-merge", "scripts", "run-full-gate.js")],
];

for (const [commandName, scriptPath] of HELP_COMMANDS) {
  test(`${commandName} help cites parsed/verbatim mode for listed flags`, () => {
    const output = execFileSync(process.execPath, [scriptPath, "--help"], { encoding: "utf-8" });
    for (const flag of COMMAND_FLAGS[commandName].filter((item) => item !== "--help")) {
      assert.match(output, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${commandName} ${flag}`);
      assert.match(output, new RegExp(`\\[${getFlagMode(flag)}\\]`), `${commandName} ${flag}`);
    }
  });
}
