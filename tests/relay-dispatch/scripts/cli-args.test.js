const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bindCliArgs,
  findUnknownFlags,
  getPositionals,
  modeLabel,
  readArg,
  schemaHasFlag,
} = require("../../../skills/relay-dispatch/scripts/cli-args");
const { parseReviewRunnerCliArgs } = require("../../../skills/relay-review/scripts/review-runner/cli");

const DISPATCH_FLAGS = ["--repo", "--prompt", "-p", "--timeout", "--json", "--help", "-h"];
const DISPATCH_OPTIONS = {
  reservedFlags: DISPATCH_FLAGS,
  booleanFlags: ["--json", "--help", "-h"],
  verbatimValueFlags: ["--repo", "--prompt", "-p"],
};

test("CLI parser requires a local closed flag contract", () => {
  assert.throws(() => readArg(["--repo", "."], "--repo"), /entrypoint-local reservedFlags/);
  assert.throws(
    () => bindCliArgs(["--repo", "."], { reservedFlags: ["--repo"], verbatimValueFlags: [] }),
    /entrypoint-local booleanFlags/
  );
  assert.throws(
    () => bindCliArgs(["--repo", "."], { reservedFlags: ["--repo"], booleanFlags: [] }),
    /entrypoint-local verbatimValueFlags/
  );
  assert.throws(
    () => readArg(["--unknown", "value"], "--unknown", undefined, DISPATCH_OPTIONS),
    /not registered/
  );
});

test("CLI parser rejects incomplete or contradictory local taxonomies", () => {
  assert.throws(
    () => bindCliArgs([], {
      reservedFlags: ["--json"],
      booleanFlags: ["--bogus"],
      verbatimValueFlags: [],
    }),
    /taxonomy references unknown flag: --bogus/
  );
  assert.throws(
    () => bindCliArgs([], {
      reservedFlags: ["--json"],
      booleanFlags: ["--json"],
      verbatimValueFlags: ["--json"],
    }),
    /both boolean and verbatim value/
  );
  assert.throws(() => modeLabel("--json"), /entrypoint-local reservedFlags/);
});

test("local parser supports aliases and rejects values that are other known flags", () => {
  assert.equal(readArg(["-p", "do work"], ["--prompt", "-p"], undefined, DISPATCH_OPTIONS), "do work");
  assert.equal(readArg(["--timeout", "--json"], "--timeout", "30", DISPATCH_OPTIONS), "30");
  assert.equal(schemaHasFlag(["--json"], "--json", DISPATCH_OPTIONS), true);
  assert.deepEqual(getPositionals([".", "--json"], DISPATCH_OPTIONS), ["."]);
  assert.deepEqual(getPositionals(["--json", "repo-after-boolean"], DISPATCH_OPTIONS), ["repo-after-boolean"]);
  assert.equal(readArg(["--repo=/tmp/example"], "--repo", undefined, DISPATCH_OPTIONS), "/tmp/example");
  assert.equal(schemaHasFlag(["--json=true"], "--json", DISPATCH_OPTIONS), true);
});

test("verbatim values do not activate a sibling flag", () => {
  const args = ["--prompt", "--json"];
  assert.equal(readArg(args, "--prompt", undefined, DISPATCH_OPTIONS), "--json");
  assert.equal(schemaHasFlag(args, "--json", DISPATCH_OPTIONS), false);
});

test("unknown flag detection uses only the entrypoint list", () => {
  assert.deepEqual(findUnknownFlags(["--repo", ".", "--model-hints"], DISPATCH_OPTIONS), ["--model-hints"]);
  assert.deepEqual(findUnknownFlags(["--prompt", "--json"], DISPATCH_OPTIONS), []);
});

test("bound readers retain their caller-owned contract", () => {
  const cli = bindCliArgs(["--repo", "/tmp/repo", "--json"], DISPATCH_OPTIONS);
  assert.equal(cli.getArg("--repo"), "/tmp/repo");
  assert.equal(cli.hasFlag("--json"), true);
  assert.equal(cli.options.reservedFlags, DISPATCH_FLAGS);
});

test("review-runner preserves a flag-like review-file value", () => {
  const parsed = parseReviewRunnerCliArgs(["--review-file", "--json"]);
  assert.equal(parsed.options.reviewFile, "--json");
  assert.equal(parsed.options.jsonOut, false);
});
