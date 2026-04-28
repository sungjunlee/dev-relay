// canary: bare-string `event === "..."` reader assertions in this file are deliberate canaries against EVENTS schema drift; do not port to EVENTS.X (see #313).
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { STATES } = require("../../relay-dispatch/scripts/manifest/lifecycle");
const { ensureRunLayout, getEventsPath } = require("../../relay-dispatch/scripts/manifest/paths");
const { createManifestSkeleton, readManifest, writeManifest } = require("../../relay-dispatch/scripts/manifest/store");
const { maybeSwapReviewer } = require("./review-runner/reviewer-swap");

function setupEscalatedRun({ lastReviewer = "codex", swapCount = 0 } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-swap-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review Swap"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-swap@example.com"], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });

  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  const runId = "issue-249-20260421120000000";
  const { manifestPath } = ensureRunLayout(repoRoot, runId);

  const manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-249",
    baseBranch: "main",
    issueNumber: 249,
    worktreePath: path.join(repoRoot, "wt", "issue-249"),
    orchestrator: "codex",
    executor: "codex",
    reviewer: lastReviewer,
  });
  const escalated = {
    ...manifest,
    state: STATES.ESCALATED,
    next_action: "inspect_review_failure",
    review: {
      ...(manifest.review || {}),
      rounds: 1,
      last_reviewer: lastReviewer,
      reviewer_swap_count: swapCount,
    },
  };
  writeManifest(manifestPath, escalated, "");
  return { data: escalated, manifestPath, repoRoot, runId };
}

test("reviewer-swap/returns data unchanged when state is not escalated", () => {
  const { data, manifestPath, repoRoot } = setupEscalatedRun();
  const pending = { ...data, state: STATES.REVIEW_PENDING };
  const result = maybeSwapReviewer(pending, "claude", "", manifestPath, repoRoot);
  assert.equal(result, pending);
});

test("reviewer-swap/returns data unchanged when no --reviewer is provided", () => {
  const { data, manifestPath, repoRoot } = setupEscalatedRun();
  const result = maybeSwapReviewer(data, null, "", manifestPath, repoRoot);
  assert.equal(result, data);
});

test("reviewer-swap/transitions escalated -> review_pending with different reviewer", () => {
  const { data, manifestPath, repoRoot, runId } = setupEscalatedRun({ lastReviewer: "codex" });
  const swapped = maybeSwapReviewer(data, "claude", "", manifestPath, repoRoot);
  assert.equal(swapped.state, STATES.REVIEW_PENDING);
  assert.equal(swapped.next_action, "run_review");
  assert.equal(swapped.review.reviewer_swap_count, 1);
  assert.equal(swapped.review.last_reviewer, "codex");

  const persisted = readManifest(manifestPath).data;
  assert.equal(persisted.state, STATES.REVIEW_PENDING);
  assert.equal(persisted.review.reviewer_swap_count, 1);

  const events = fs.readFileSync(getEventsPath(repoRoot, runId), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const swapEvent = events.find((event) => event.event === "reviewer_swap");
  assert.ok(swapEvent, "reviewer_swap event should be appended");
  assert.equal(swapEvent.from_reviewer, "codex");
  assert.equal(swapEvent.to_reviewer, "claude");
  assert.equal(swapEvent.state_from, STATES.ESCALATED);
  assert.equal(swapEvent.state_to, STATES.REVIEW_PENDING);
});

test("reviewer-swap/rejects same-reviewer retry", () => {
  const { data, manifestPath, repoRoot } = setupEscalatedRun({ lastReviewer: "codex" });
  assert.throws(
    () => maybeSwapReviewer(data, "codex", "", manifestPath, repoRoot),
    /matches review\.last_reviewer/
  );
});

test("reviewer-swap/rejects a second swap after the quota is used", () => {
  const { data, manifestPath, repoRoot } = setupEscalatedRun({ lastReviewer: "codex", swapCount: 1 });
  assert.throws(
    () => maybeSwapReviewer(data, "claude", "", manifestPath, repoRoot),
    /reviewer_swap_count=1 \(max 1 per run\)/
  );
});
