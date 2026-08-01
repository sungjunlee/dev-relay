const fs = require("fs");

const requestIndex = process.argv.indexOf("--request-file");
if (requestIndex < 0 || !process.argv[requestIndex + 1]) {
  process.stderr.write("missing --request-file\n");
  process.exit(2);
}

const request = JSON.parse(fs.readFileSync(process.argv[requestIndex + 1], "utf8"));
const mode = process.argv.includes("--observe") ? "observe" : "review";

if (mode === "observe") {
  process.stdout.write(`${JSON.stringify({
    source: "fresh-subprocess",
    nonce: request.nonce,
    pr_number: request.request?.pr_number || request.request?.pr || 42,
    pr_head_sha: request.request?.expected_pr_head_sha || "b".repeat(40),
    pr_state: process.argv.includes("--forge-open") ? "OPEN" : (request.request?.required_state || "OPEN"),
    merge_sha: process.argv.includes("--forge-target")
      ? "f".repeat(40)
      : (request.request?.expected_result_target_sha || null),
  })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({
    verdict: "lgtm",
    run_id: request.run_id,
    reviewed_sha: request.reviewed_sha,
    prompt_sha256: request.prompt_sha256,
    prompt_text: fs.readFileSync(request.prompt_path, "utf8"),
    request_paths: [
      request.diff_path,
      request.prompt_path,
      request.done_criteria_path,
      process.argv[requestIndex + 1],
    ],
    cwd: process.cwd(),
    home: process.env.HOME,
    executor_session_token: process.env.EXECUTOR_SESSION_TOKEN || null,
    executor_worktree: process.env.EXECUTOR_WORKTREE || null,
  })}\n`);
}
