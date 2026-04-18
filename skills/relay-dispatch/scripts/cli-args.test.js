const test = require("node:test");
const assert = require("node:assert/strict");

const { getArg, hasFlag } = require("./cli-args");

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

test("getArg returns the fallback when the next token looks like a long flag", () => {
  // Anti-theater: rejects the naive `args[args.indexOf(flag) + 1]` helper because `--json` is a
  // sibling flag, not the value for `--repo`.
  assert.equal(
    getArg(["--repo", "--json"], "--repo", "."),
    "."
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

test("getArg can treat reserved short aliases as missing values", () => {
  // Anti-theater: shared dedupe must not widen caller behavior. `create-worktree` and `dispatch`
  // previously rejected sibling short aliases from their local KNOWN_FLAGS lists, so the shared
  // helper needs an opt-in guard to preserve that fail-closed contract.
  assert.equal(
    getArg(
      ["--title", "-b", "--branch", "feature"],
      "--title",
      "fallback",
      { reservedFlags: ["-b", "-t"] }
    ),
    "fallback"
  );
});

test("getArg rejects -h as a value for close-run and recover-state style reason flags", () => {
  // Anti-theater: pre-r3 helper call sites widened behavior by accepting `-h` as the value for
  // `--reason`; these CLIs historically rejected the token because their KNOWN_FLAGS included `-h`.
  assert.equal(
    getArg(["--reason", "-h"], "--reason", undefined, { reservedFlags: ["-h"] }),
    undefined
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
      ["--prompt", "--executor", "codex"],
      "--prompt",
      "fallback",
      { reservedFlags: ["--executor", "-e"] }
    ),
    "fallback"
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
