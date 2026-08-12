#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const reviewRunner = require("../../../skills/relay-review/scripts/review-runner");

function reviewerSuccess(input) {
  const stat = fs.statSync(process.execPath);
  return {
    status: "succeeded",
    output: {
      verdict: "pass",
      summary: "independent local crash-matrix review passed",
      issues: [],
    },
    review_binding: {
      diff_sha256: input.request.diff_sha256,
      prompt_sha256: input.request.prompt_sha256,
      staged_diff_sha256: input.request.diff_sha256,
      staged_prompt_sha256: input.request.prompt_sha256,
      staged_done_criteria_sha256: crypto.createHash("sha256")
        .update(fs.readFileSync(input.request.done_criteria_path)).digest("hex"),
      request_sha256: crypto.createHash("sha256").update("local-crash-matrix-review").digest("hex"),
    },
    executed_runtime: [{
      path: process.execPath,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex"),
    }],
  };
}

async function main() {
  const cli = reviewRunner.parseCli([
    "--repo", process.env.RELAY_TEST_REPO,
    "--run-dir", process.env.RELAY_TEST_RUN_DIR,
    "--json",
  ]);
  const result = await reviewRunner.runReview(cli, {
    invokeReviewer: async (input) => reviewerSuccess(input),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.code || "REVIEW_FAILED"}: ${error.message}\n`);
  process.exitCode = 1;
});
