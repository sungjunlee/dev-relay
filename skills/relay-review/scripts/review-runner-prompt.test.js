const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildPrompt } = require("./review-runner/prompt");

test("prompt/buildPrompt preserves rubric warnings in the rendered prompt", () => {
  const prompt = buildPrompt({
    round: 1,
    prNumber: 189,
    branch: "issue-189",
    issueNumber: 189,
    doneCriteria: "# Done Criteria\n\n- Keep behavior identical\n",
    doneCriteriaSource: "github-issue",
    diffText: "diff --git a/a.js b/a.js\n",
    runDir: null,
    rubricLoad: {
      warning: "WARNING: [rubric missing] rubric file is missing",
      content: null,
    },
  });

  assert.match(prompt, /## Scoring Rubric/);
  assert.match(prompt, /\[rubric missing\]/i);
});

test("prompt/buildPrompt includes the reviewer versus runner trust-boundary rationale", () => {
  const prompt = buildPrompt({
    round: 1,
    prNumber: 261,
    branch: "issue-261",
    issueNumber: 261,
    doneCriteria: "# Done Criteria\n\n- Verify SHA-bound execution evidence\n",
    doneCriteriaSource: "github-issue",
    diffText: "diff --git a/a.js b/a.js\n",
    runDir: null,
    rubricLoad: {
      warning: null,
      content: null,
    },
  });

  assert.match(prompt, /reviewer cannot execute code/i);
  assert.match(prompt, /runner independently verifies SHA-bound execution evidence/i);
});

test("prompt/buildPrompt preserves prior-round context rendering", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-prompt-"));
  fs.writeFileSync(path.join(runDir, "review-round-1-verdict.json"), JSON.stringify({
    verdict: "changes_requested",
    summary: "Fix auth boundary",
    issues: [{ file: "auth.js", line: 19, title: "Auth", body: "Do not widen scope" }],
  }), "utf-8");

  const prompt = buildPrompt({
    round: 2,
    prNumber: 189,
    branch: "issue-189",
    issueNumber: 189,
    doneCriteria: "# Done Criteria\n",
    doneCriteriaSource: "github-issue",
    diffText: "diff --git a/a.js b/a.js\n",
    runDir,
    rubricLoad: {
      warning: null,
      content: "rubric:\n  factors:\n    - name: behavior\n",
    },
  });

  assert.match(prompt, /## Prior Round Context/);
  assert.match(prompt, /Fix auth boundary/);
  assert.match(prompt, /auth\.js:19 — Auth/);
});
