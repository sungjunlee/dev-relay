const path = require("path");
const { bindCliArgs, findUnknownFlags } = require("../../../relay-dispatch/scripts/cli-args");

const KNOWN_FLAGS = ["--repo", "--run-id", "--branch", "--pr", "--manifest", "--done-criteria-file", "--diff-file", "--review-file", "--manual-review-reason", "--reviewer", "--reviewer-script", "--reviewer-model", "--independent-review-reason", "--advisory-reviewer", "--advisory-profile", "--advisory-reviewer-model", "--advisory-timeout", "--advisory-grace", "--prepare-only", "--no-comment", "--json", "--help", "-h"];

function parseReviewRunnerCliArgs(args) {
  const cliArgs = bindCliArgs(args, {
    commandName: "review-runner",
    reservedFlags: KNOWN_FLAGS,
  });
  const repoArg = cliArgs.getArg("--repo");
  return {
    args,
    cliArgs,
    options: {
      advisoryGraceArg: cliArgs.getArg("--advisory-grace"),
      advisoryProfileArg: cliArgs.getArg("--advisory-profile"),
      advisoryReviewerArg: cliArgs.getArg("--advisory-reviewer"),
      advisoryReviewerModel: cliArgs.getArg("--advisory-reviewer-model"),
      advisoryTimeoutArg: cliArgs.getArg("--advisory-timeout"),
      branchArg: cliArgs.getArg("--branch"),
      diffFile: cliArgs.getArg("--diff-file"),
      doneCriteriaFile: cliArgs.getArg("--done-criteria-file"),
      independentReviewReason: cliArgs.getArg("--independent-review-reason"),
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
    },
  };
}

function assertKnownReviewRunnerFlags(args) {
  const unknownFlags = findUnknownFlags(args, "review-runner");
  if (unknownFlags.length) {
    throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  }
}

module.exports = {
  assertKnownReviewRunnerFlags,
  parseReviewRunnerCliArgs,
};
