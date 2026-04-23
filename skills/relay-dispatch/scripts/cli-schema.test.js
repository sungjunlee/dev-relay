const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const {
  COMMAND_FLAGS,
  FLAGS,
  MODE_PARSED,
  MODE_VERBATIM,
  VALUE,
  formatFlagAuditMarkdown,
  getFlagMode,
  hasFlag,
  readArg,
} = require("./cli-schema");

const valueFlags = FLAGS.filter((flag) => flag.kind === VALUE);
const verbatimFlags = valueFlags.filter((flag) => flag.mode === MODE_VERBATIM);
const parsedValueFlags = valueFlags.filter((flag) => flag.mode === MODE_PARSED);

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

  test(`${flag} verbatim mode preserves adversarial values`, () => {
    assert.equal(readArg([flag, "--watch"], flag, "fallback"), "--watch");
    assert.equal(readArg([flag, "--skip-review"], flag, "fallback"), "--skip-review");
    assert.equal(readArg([flag, "📦 bootstrap"], flag, "fallback"), "📦 bootstrap");
    assert.equal(readArg([flag, "npm test && echo done"], flag, "fallback"), "npm test && echo done");
    assert.equal(readArg([flag, "a\"b'c"], flag, "fallback"), "a\"b'c");
    assert.equal(readArg([flag], flag, "fallback"), "fallback");
    assert.equal(readArg([`${flag}=--inline`], flag, "fallback"), "--inline");

    if (definition.rejectWhitespaceOnly) {
      assert.throws(() => readArg([flag, ""], flag, "fallback"), /requires a non-empty value/);
      assert.throws(() => readArg([flag, "   "], flag, "fallback"), /requires a non-empty value/);
    } else {
      assert.equal(readArg([flag, ""], flag, "fallback"), "");
      assert.equal(readArg([flag, "   "], flag, "fallback"), "   ");
    }
  });
}

test("reason rejects empty and whitespace-only audit text", () => {
  assert.throws(() => readArg(["--reason", ""], "--reason"), /requires a non-empty value/);
  assert.throws(() => readArg(["--reason", "   "], "--reason"), /requires a non-empty value/);
});

test("verbatim values that look like flags do not activate sibling flags", () => {
  const args = ["--test-command", "--json"];
  assert.equal(readArg(args, "--test-command", undefined, { commandName: "dispatch" }), "--json");
  assert.equal(hasFlag(args, "--json", { commandName: "dispatch" }), false);
});

for (const definition of parsedValueFlags) {
  const flag = definition.flag;

  test(`${flag} parsed mode treats --prefix input as missing`, () => {
    assert.equal(readArg([flag, "--watch"], flag, "fallback"), "fallback");
    assert.equal(readArg([`${flag}=--watch`], flag, "fallback"), "fallback");
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

const HELP_COMMANDS = [
  ["analyze-flip-flop-pattern", path.join(__dirname, "../../relay-review/scripts/analyze-flip-flop-pattern.js")],
  ["cleanup-worktrees", path.join(__dirname, "cleanup-worktrees.js")],
  ["close-run", path.join(__dirname, "close-run.js")],
  ["create-worktree", path.join(__dirname, "create-worktree.js")],
  ["dispatch", path.join(__dirname, "dispatch.js")],
  ["finalize-run", path.join(__dirname, "../../relay-merge/scripts/finalize-run.js")],
  ["gate-check", path.join(__dirname, "../../relay-merge/scripts/gate-check.js")],
  ["invoke-reviewer-claude", path.join(__dirname, "../../relay-review/scripts/invoke-reviewer-claude.js")],
  ["invoke-reviewer-codex", path.join(__dirname, "../../relay-review/scripts/invoke-reviewer-codex.js")],
  ["persist-request", path.join(__dirname, "../../relay-intake/scripts/persist-request.js")],
  ["probe-executor-env", path.join(__dirname, "../../relay-plan/scripts/probe-executor-env.js")],
  ["recover-state", path.join(__dirname, "recover-state.js")],
  ["reliability-report", path.join(__dirname, "reliability-report.js")],
  ["review-runner", path.join(__dirname, "../../relay-review/scripts/review-runner.js")],
  ["update-manifest-state", path.join(__dirname, "update-manifest-state.js")],
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
