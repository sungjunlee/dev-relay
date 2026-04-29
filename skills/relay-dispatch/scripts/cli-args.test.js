const test = require("node:test");
const assert = require("node:assert/strict");

const { bindCliArgs, readArg, schemaHasFlag } = require("./cli-args");

test("bindCliArgs returns callable bound helpers and options", () => {
  const bound = bindCliArgs(["--repo", "/tmp/repo", "--json"], {
    commandName: "persist-request",
    reservedFlags: ["--repo", "--json"],
  });

  assert.deepEqual(Object.keys(bound).sort(), ["getArg", "hasFlag", "options"]);
  assert.equal(typeof bound.getArg, "function");
  assert.equal(typeof bound.hasFlag, "function");
  assert.deepEqual(bound.options, {
    commandName: "persist-request",
    reservedFlags: ["--repo", "--json"],
  });
  assert.equal(bound.getArg("--repo"), "/tmp/repo");
  assert.equal(bound.hasFlag("--json"), true);
});

test("readArg returns the value for a present single flag", () => {
  // Anti-theater: rejects the naive `args[args.indexOf(flag) + 1]` helper once the value is a
  // string payload contract rather than an unconditional positional read.
  assert.equal(
    readArg(["--repo", "/tmp/repo"], "--repo"),
    "/tmp/repo"
  );
});

test("readArg resolves array-form aliases for both long and short flags", () => {
  // Anti-theater: rejects the naive `args[args.indexOf(flag) + 1]` helper because array-form flags
  // must resolve each alias, not treat the flag parameter as a single token.
  assert.equal(
    readArg(["--branch", "issue-191"], ["--branch", "-b"]),
    "issue-191"
  );
  assert.equal(
    readArg(["-b", "issue-191"], ["--branch", "-b"]),
    "issue-191"
  );
});

test("readArg returns the fallback when the flag is absent", () => {
  // Anti-theater: rejects the naive `args[args.indexOf(flag) + 1]` helper because an absent flag
  // must return the caller fallback, not read `args[0]` through `indexOf(...) === -1`.
  assert.equal(
    readArg(["--json"], "--repo", "."),
    "."
  );
});

test("readArg returns the fallback when the flag is the last token", () => {
  // Anti-theater: rejects the naive `args[args.indexOf(flag) + 1]` helper because a trailing flag
  // must fail closed instead of returning `undefined` as though it were a valid value.
  assert.equal(
    readArg(["--repo"], "--repo", "."),
    "."
  );
});

test("readArg returns the fallback when a parsed-mode value looks like a long flag", () => {
  // Anti-theater: rejects the naive `args[args.indexOf(flag) + 1]` helper because `--json` is a
  // sibling flag, not the value for parsed-mode flags.
  assert.equal(
    readArg(["--timeout", "--json"], "--timeout", "30"),
    "30"
  );
});

test("readArg keeps a single-dash token as data", () => {
  // Anti-theater: rejects the naive `args[args.indexOf(flag) + 1]` helper once the shared helper's
  // look-alike guard is narrowed to `--*` only and single-dash payloads must pass through.
  assert.equal(
    readArg(["--title", "-b"], "--title", "fallback"),
    "-b"
  );
});

test("readArg preserves reserved short aliases for verbatim-mode flags", () => {
  // Anti-theater: branch/title-like operator text is now explicitly verbatim, so a token that
  // matches another flag alias must stay data when the flag declares that contract.
  assert.equal(
    readArg(
      ["--title", "-b", "--branch", "feature"],
      "--title",
      "fallback",
      { reservedFlags: ["-b", "-t"] }
    ),
    "-b"
  );
});

test("readArg preserves -h as a value for verbatim-mode reason flags", () => {
  // Anti-theater: audit reasons are verbatim text, so even reserved-looking tokens remain data.
  assert.equal(
    readArg(["--reason", "-h"], "--reason", undefined, { reservedFlags: ["-h"] }),
    "-h"
  );
});

test("readArg rejects -h as a value for update-manifest-state state flags", () => {
  // Anti-theater: state-transition selectors must not reinterpret the short help alias as the
  // requested manifest state when the caller declares `-h` reserved.
  assert.equal(
    readArg(["--state", "-h"], "--state", undefined, { reservedFlags: ["-h"] }),
    undefined
  );
});

test("readArg rejects -h as a value for reliability-report numeric flags", () => {
  // Anti-theater: reporting CLIs still need the old fail-closed `-h` guard so `--stale-hours -h`
  // falls back instead of parsing the help alias as hours data.
  assert.equal(
    readArg(["--stale-hours", "-h"], "--stale-hours", undefined, { reservedFlags: ["-h"] }),
    undefined
  );
});

test("readArg can treat reserved long flags as missing values", () => {
  // Anti-theater: callers that already maintain a full known-flag list should get the same answer
  // for both long and short aliases through one shared helper path.
  assert.equal(
    readArg(
      ["--timeout", "--json"],
      "--timeout",
      "fallback",
      { reservedFlags: ["--json"] }
    ),
    "fallback"
  );
});

test("readArg preserves a flag-like token verbatim when the schema declares it", () => {
  // Anti-theater: `dispatch --test-command \"--grep smoke\"` must record the quoted payload exactly
  // instead of dropping it just because the token starts with `--`.
  assert.equal(
    readArg(
      ["--test-command", "--grep smoke"],
      "--test-command",
      undefined,
      { reservedFlags: ["--json"] }
    ),
    "--grep smoke"
  );
});

test("readArg preserves exact reserved tokens for verbatim-mode flags", () => {
  // Anti-theater: issue #261 requires `dispatch --test-command '--json'` to record the caller
  // payload verbatim even when it matches a token in the shared reserved flag list.
  assert.equal(
    readArg(
      ["--test-command", "--json"],
      "--test-command",
      "fallback",
      { commandName: "dispatch", reservedFlags: ["--json"] }
    ),
    "--json"
  );
});

test("schemaHasFlag ignores tokens consumed as verbatim values", () => {
  assert.equal(
    schemaHasFlag(["--test-command", "--json"], "--json", { commandName: "dispatch" }),
    false
  );
});

test("schemaHasFlag detects a present string flag", () => {
  // Anti-theater: the shared helper contract includes presence checks alongside value reads so thin
  // CLIs do not duplicate ad-hoc flag scans next to `readArg(...)`.
  assert.equal(
    schemaHasFlag(["--json"], "--json"),
    true
  );
  assert.equal(
    schemaHasFlag(["--repo", "."], "--json"),
    false
  );
});

test("schemaHasFlag detects array-form aliases", () => {
  // Anti-theater: array-form aliases need the same normalization as `readArg(...)`; a one-token-only
  // helper would miss `-h` when callers ask for ['--help', '-h'].
  assert.equal(
    schemaHasFlag(["-h"], ["--help", "-h"]),
    true
  );
  assert.equal(
    schemaHasFlag(["--json"], ["--help", "-h"]),
    false
  );
});
