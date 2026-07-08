const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DISPATCH_SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-dispatch", "scripts", "dispatch.js");
const ADVISORY_SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-review", "scripts", "review-runner", "advisory.js");

test("dispatch timeout diagnostics distinguish total_timeout and no_result", () => {
  const source = fs.readFileSync(DISPATCH_SCRIPT, "utf-8");
  assert.match(source, /executor total_timeout after/);
  assert.match(source, /executor no_result: produced no structured result file or summary/);
  assert.match(source, /dispatchFailureClass/);
  assert.match(source, /dispatch_failure_class/);
  assert.ok(source.includes("stdout=${stdoutLog}"));
  assert.ok(source.includes("stderr=${stderrLog}"));
  assert.ok(source.includes("result=${resultFile}"));
});

test("advisory timeout wording includes reviewer model and raw response", () => {
  const source = fs.readFileSync(ADVISORY_SCRIPT, "utf-8");
  assert.match(source, /reviewer advisory_review exceeded/);
  assert.match(source, /timeout/);
  assert.ok(source.includes("model=${request.reviewerModel || \"default\"}"));
  assert.ok(source.includes("raw_response=${rawResponsePath}"));
});
