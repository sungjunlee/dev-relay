const path = require("path");
const { bindCliArgs, findUnknownFlags } = require("../../../relay-dispatch/scripts/cli-args");

const KNOWN_FLAGS = ["--repo", "--run-id", "--branch", "--pr", "--manifest", "--done-criteria-file", "--diff-file", "--review-file", "--manual-review-reason", "--reviewer", "--reviewer-script", "--reviewer-model", "--allow-behind-base", "--wait-for-checks", "--detach", "--prepare-only", "--no-comment", "--json", "--help", "-h"];
const CLI_ARG_OPTIONS = {
  reservedFlags: KNOWN_FLAGS,
  booleanFlags: ["--allow-behind-base", "--detach", "--prepare-only", "--no-comment", "--json", "--help", "-h"],
  verbatimValueFlags: ["--repo", "--branch", "--manifest", "--done-criteria-file", "--diff-file", "--review-file", "--manual-review-reason", "--reviewer-script"],
};

function parseReviewRunnerCliArgs(args) {
  const cliArgs = bindCliArgs(args, CLI_ARG_OPTIONS);
  const repoArg = cliArgs.getArg("--repo");
  return {
    args,
    cliArgs,
    options: {
      allowBehindBase: cliArgs.hasFlag("--allow-behind-base"),
      detach: cliArgs.hasFlag("--detach"),
      branchArg: cliArgs.getArg("--branch"),
      diffFile: cliArgs.getArg("--diff-file"),
      doneCriteriaFile: cliArgs.getArg("--done-criteria-file"),
      jsonOut: cliArgs.hasFlag("--json"),
      manifestPathArg: cliArgs.getArg("--manifest"),
      manualReviewReason: cliArgs.getArg("--manual-review-reason"),
      noComment: cliArgs.hasFlag("--no-comment"),
      prArg: cliArgs.getArg("--pr"),
      prepareOnly: cliArgs.hasFlag("--prepare-only"),
      repoArg,
      repoPath: path.resolve(repoArg || "."),
      reviewFile: cliArgs.getArg("--review-file"),
      reviewerArg: cliArgs.getArg("--reviewer"),
      reviewerModel: cliArgs.getArg("--reviewer-model"),
      reviewerScriptArg: cliArgs.getArg("--reviewer-script"),
      runIdArg: cliArgs.getArg("--run-id"),
      waitForChecksArg: cliArgs.getArg("--wait-for-checks"),
    },
  };
}

function assertKnownReviewRunnerFlags(args) {
  const unknownFlags = findUnknownFlags(args, CLI_ARG_OPTIONS);
  if (unknownFlags.length) {
    throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  }
}

module.exports = {
  CLI_ARG_OPTIONS,
  assertKnownReviewRunnerFlags,
  parseReviewRunnerCliArgs,
};
