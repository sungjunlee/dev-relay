"use strict";

const { resolveContext } = require("./context");
const {
  loadRunRoutePlan, preflightPrimaryReviewerCapability, resolveReviewerName,
} = require("./reviewer-invoke");

function preflightResolvedPrimaryReviewer(options) {
  if (options.reviewFile || options.reviewerScriptArg) return;
  const {
    branchArg, doneCriteriaFile, manifestPathArg, prArg, repoArg, repoPath, reviewerArg, runIdArg,
  } = options;
  const context = resolveContext(repoPath, repoArg, manifestPathArg, runIdArg, branchArg, prArg, doneCriteriaFile);
  const { data } = context.manifest;
  const routePlan = loadRunRoutePlan(context.runRepoPath, data.run_id).plan;
  preflightPrimaryReviewerCapability(resolveReviewerName(data, reviewerArg, { routePlan }));
}

module.exports = { preflightResolvedPrimaryReviewer };
