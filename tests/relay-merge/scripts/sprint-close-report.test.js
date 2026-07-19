"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  writeManifest,
} = require(
  "../../../skills/relay-dispatch/scripts/relay-manifest"
);

const SCRIPT = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "skills",
  "relay-merge",
  "scripts",
  "sprint-close-report.js"
);
const {
  aggregateCandidatePatterns,
  renderReport,
} = require(SCRIPT);

function initRepo(repoRoot) {
  execFileSync("git", ["init", "-b", "main"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Legacy Report Test"], {
    cwd: repoRoot,
  });
  execFileSync("git", ["config", "user.email", "relay@example.com"], {
    cwd: repoRoot,
  });
}

function scoreLog(factor, score) {
  return [
    "## Score Log",
    "",
    "| Factor | Target | Final | Status |",
    "| --- | --- | --- | --- |",
    `| ${factor} | >= 8/10 | ${score}/10 | locked |`,
  ].join("\n");
}

test("legacy sprint-close report still consumes completed historical Score Logs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-legacy-report-"));
  const repoRoot = path.join(root, "repo");
  const relayHome = path.join(root, "relay-home");
  fs.mkdirSync(repoRoot);
  initRepo(repoRoot);

  const sprintPath = path.join(root, "sprint.md");
  fs.writeFileSync(sprintPath, [
    "## Plan",
    "- [x] #101 first historical run",
    "- [x] #102 second historical run",
  ].join("\n"));

  const previousRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = relayHome;
  try {
    for (const [index, issueNumber] of [101, 102].entries()) {
      const runId = createRunId({
        issueNumber,
        timestamp: new Date(`2026-04-20T00:00:0${index}.000Z`),
      });
      const { runDir, manifestPath } = ensureRunLayout(repoRoot, runId);
      fs.writeFileSync(path.join(runDir, "rubric.yaml"), [
        "rubric:",
        "  factors:",
        "    - name: Historical signal",
        "      tier: quality",
        "      type: evaluated",
      ].join("\n"));

      const manifest = createManifestSkeleton({
        repoRoot,
        runId,
        branch: `issue-${issueNumber}-legacy`,
        baseBranch: "main",
        issueNumber,
        worktreePath: path.join(root, "worktrees", runId),
      });
      manifest.state = STATES.MERGED;
      manifest.git.pr_number = issueNumber + 100;
      manifest.anchor.rubric_path = "rubric.yaml";
      writeManifest(manifestPath, manifest);
    }
  } finally {
    if (previousRelayHome === undefined) {
      delete process.env.RELAY_HOME;
    } else {
      process.env.RELAY_HOME = previousRelayHome;
    }
  }

  const bodies = {
    201: scoreLog("Historical signal", 9),
    202: scoreLog("Historical signal", 10),
  };
  process.env.RELAY_HOME = relayHome;
  let stdout;
  try {
    const report = aggregateCandidatePatterns({
      repoRoot,
      sprintPath,
      threshold: 9,
      minRuns: 2,
      loadBody: (_repoRoot, prNumber) => bodies[prNumber] || "",
    });
    stdout = renderReport(report);
  } finally {
    if (previousRelayHome === undefined) {
      delete process.env.RELAY_HOME;
    } else {
      process.env.RELAY_HOME = previousRelayHome;
    }
  }

  assert.match(stdout, /Legacy Score Log candidate patterns/);
  assert.match(stdout, /Historical signal \(2 runs; scores: 10\/10, 9\/10\)/);
  assert.match(stdout, /Promote manually only after current evidence confirms it/);
});
