#!/usr/bin/env node
"use strict";

const fs = require("fs");

const index = process.argv.indexOf("--request-file");
if (index < 0) throw new Error("missing --request-file");
const input = JSON.parse(fs.readFileSync(process.argv[index + 1], "utf8"));
const request = input.request;
const merged = request.required_state === "MERGED" || request.expected_state === "MERGED";
process.stdout.write(JSON.stringify({
  nonce: input.nonce,
  repo: request.repo,
  head_repo: request.repo,
  pr_number: request.pr_number,
  pr_state: merged ? "MERGED" : "OPEN",
  pr_head_sha: request.expected_pr_head_sha,
  pr_base_sha: request.expected_pr_base_sha || "a".repeat(40),
  head_ref: request.expected_head_ref,
  base_ref: request.expected_base_ref,
  merge_sha: merged ? (request.expected_result_target_sha || "c".repeat(40)) : null,
  auto_merge_request: request.expected_auto_merge_request || null,
  merge_state_status: request.expected_merge_state_status || null,
}));
