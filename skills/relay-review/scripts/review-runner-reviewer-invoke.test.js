const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  captureGitStatus,
  resolveReviewerName,
  resolveReviewerScript,
} = require("./review-runner/reviewer-invoke");

test("reviewer-invoke/resolveReviewerName preserves arg, manifest, env precedence", () => {
  process.env.RELAY_REVIEWER = "env-reviewer";
  assert.equal(resolveReviewerName({ roles: { reviewer: "manifest-reviewer" } }, "arg-reviewer"), "arg-reviewer");
  assert.equal(resolveReviewerName({ roles: { reviewer: "manifest-reviewer" } }), "manifest-reviewer");
  assert.equal(resolveReviewerName({ roles: { reviewer: "unknown" } }), "env-reviewer");
});

test("reviewer-invoke/resolveReviewerScript resolves built-in adapters and rejects invalid names", () => {
  const script = resolveReviewerScript("codex");
  assert.match(script, /invoke-reviewer-codex\.js$/);
  assert.throws(() => resolveReviewerScript("../bad"), /Invalid reviewer name/);
});

test("reviewer-invoke/captureGitStatus preserves dirty-worktree detection", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-invoke-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "dirty.txt"), "dirty\n", "utf-8");

  assert.match(captureGitStatus(repoRoot), /dirty\.txt/);
});
