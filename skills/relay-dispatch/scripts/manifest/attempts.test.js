const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  captureAttempt,
  formatAttemptsForPrompt,
  readPreviousAttempts,
} = require("./attempts");

function initGitRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Attempts Test"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay@example.com"], { cwd: repoRoot, stdio: "pipe" });
}

test("manifest/attempts formatAttemptsForPrompt handles empty lists", () => {
  assert.equal(formatAttemptsForPrompt([]), "");
});

test("manifest/attempts captureAttempt round-trips through direct imports", () => {
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-attempts-repo-"));
  initGitRepo(repoRoot);
  const runId = "issue-188-20260418091011123-a1b2c3d4";

  captureAttempt(repoRoot, runId, {
    score_log: "| factor | 8 |\n",
    reviewer_feedback: "Fix imports",
  });
  const attempts = readPreviousAttempts(repoRoot, runId);
  assert.equal(attempts.length, 1);
  assert.match(formatAttemptsForPrompt(attempts), /Previous Attempt/);
});
