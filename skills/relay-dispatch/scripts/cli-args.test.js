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
