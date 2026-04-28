const test = require("node:test");
const assert = require("node:assert/strict");

const { bindCliArgs, getArg, hasFlag } = require("./cli-args");

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

test("getArg returns the value for a present single flag", () => {
  // Anti-theater: rejects the naive `args[args.indexOf(flag) + 1]` helper once the value is a
  // string payload contract rather than an unconditional positional read.
  assert.equal(
    getArg(["--repo", "/tmp/repo"], "--repo"),
    "/tmp/repo"
  );
});

test("getArg resolves array-form aliases for both long and short flags", () => {
  // Anti-theater: rejects the naive `args[args.indexOf(flag) + 1]` helper because array-form flags
  // must resolve each alias, not treat the flag parameter as a single token.
  assert.equal(
    getArg(["--branch", "issue-191"], ["--branch", "-b"]),
    "issue-191"
  );
  assert.equal(
    getArg(["-b", "issue-191"], ["--branch", "-b"]),
    "issue-191"
  );
});

test("getArg returns the fallback when the flag is absent", () => {
  // Anti-theater: rejects the naive `args[args.indexOf(flag) + 1]` helper because an absent flag
  // must return the caller fallback, not read `args[0]` through `indexOf(...) === -1`.
  assert.equal(
    getArg(["--json"], "--repo", "."),
    "."
  );
});

test("getArg returns the fallback when the flag is the last token", () => {
  // Anti-theater: rejects the naive `args[args.indexOf(flag) + 1]` helper because a trailing flag
  // must fail closed instead of returning `undefined` as though it were a valid value.
  assert.equal(
    getArg(["--repo"], "--repo", "."),
    "."
  );
});

test("getArg returns the fallback when a parsed-mode value looks like a long flag", () => {
  // Anti-theater: rejects the naive `args[args.indexOf(flag) + 1]` helper because `--json` is a
  // sibling flag, not the value for parsed-mode flags.
  assert.equal(
    getArg(["--timeout", "--json"], "--timeout", "30"),
    "30"
  );
});

test("getArg keeps a single-dash token as data", () => {
  // Anti-theater: rejects the naive `args[args.indexOf(flag) + 1]` helper once the shared helper's
  // look-alike guard is narrowed to `--*` only and single-dash payloads must pass through.
  assert.equal(
    getArg(["--title", "-b"], "--title", "fallback"),
    "-b"
  );
});

test("getArg preserves reserved short aliases for verbatim-mode flags", () => {
  // Anti-theater: branch/title-like operator text is now explicitly verbatim, so a token that
  // matches another flag alias must stay data when the flag declares that contract.
  assert.equal(
    getArg(
      ["--title", "-b", "--branch", "feature"],
      "--title",
      "fallback",
      { reservedFlags: ["-b", "-t"] }
    ),
    "-b"
  );
});

test("getArg preserves -h as a value for verbatim-mode reason flags", () => {
  // Anti-theater: audit reasons are verbatim text, so even reserved-looking tokens remain data.
  assert.equal(
    getArg(["--reason", "-h"], "--reason", undefined, { reservedFlags: ["-h"] }),
    "-h"
  );
});

test("getArg rejects -h as a value for update-manifest-state state flags", () => {
  // Anti-theater: state-transition selectors must not reinterpret the short help alias as the
  // requested manifest state when the caller declares `-h` reserved.
  assert.equal(
    getArg(["--state", "-h"], "--state", undefined, { reservedFlags: ["-h"] }),
    undefined
  );
});

test("getArg rejects -h as a value for reliability-report numeric flags", () => {
  // Anti-theater: reporting CLIs still need the old fail-closed `-h` guard so `--stale-hours -h`
  // falls back instead of parsing the help alias as hours data.
  assert.equal(
    getArg(["--stale-hours", "-h"], "--stale-hours", undefined, { reservedFlags: ["-h"] }),
    undefined
  );
});

test("getArg can treat reserved long flags as missing values", () => {
  // Anti-theater: callers that already maintain a full known-flag list should get the same answer
  // for both long and short aliases through one shared helper path.
  assert.equal(
    getArg(
      ["--timeout", "--json"],
      "--timeout",
      "fallback",
      { reservedFlags: ["--json"] }
    ),
    "fallback"
  );
});

test("getArg preserves a flag-like token verbatim when the schema declares it", () => {
  // Anti-theater: `dispatch --test-command \"--grep smoke\"` must record the quoted payload exactly
  // instead of dropping it just because the token starts with `--`.
  assert.equal(
    getArg(
      ["--test-command", "--grep smoke"],
      "--test-command",
      undefined,
      { reservedFlags: ["--json"] }
    ),
    "--grep smoke"
  );
});

test("getArg preserves exact reserved tokens for verbatim-mode flags", () => {
  // Anti-theater: issue #261 requires `dispatch --test-command '--json'` to record the caller
  // payload verbatim even when it matches a token in the shared reserved flag list.
  assert.equal(
    getArg(
      ["--test-command", "--json"],
      "--test-command",
      "fallback",
      { commandName: "dispatch", reservedFlags: ["--json"] }
    ),
    "--json"
  );
});

test("hasFlag ignores tokens consumed as verbatim values", () => {
  assert.equal(
    hasFlag(["--test-command", "--json"], "--json", { commandName: "dispatch" }),
    false
  );
});

test("hasFlag detects a present string flag", () => {
  // Anti-theater: the shared helper contract includes presence checks alongside value reads so thin
  // CLIs do not duplicate ad-hoc flag scans next to `getArg(...)`.
  assert.equal(
    hasFlag(["--json"], "--json"),
    true
  );
  assert.equal(
    hasFlag(["--repo", "."], "--json"),
    false
  );
});

test("hasFlag detects array-form aliases", () => {
  // Anti-theater: array-form aliases need the same normalization as `getArg(...)`; a one-token-only
  // helper would miss `-h` when callers ask for ['--help', '-h'].
  assert.equal(
    hasFlag(["-h"], ["--help", "-h"]),
    true
  );
  assert.equal(
    hasFlag(["--json"], ["--help", "-h"]),
    false
  );
});
