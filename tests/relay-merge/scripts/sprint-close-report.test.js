"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");

const SCRIPT = path.join(__dirname, "..", "..", "..", "skills", "relay-merge", "scripts", "sprint-close-report.js");

function initRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sprint-close-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Sprint Close Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "sprint-close@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "fixture\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  return repoRoot;
}

function scoreLog(rows) {
  return [
    "## Score Log",
    "",
    "| Factor | Target | Baseline | Iter 1 | Final | Status |",
    "|--------|--------|----------|--------|-------|--------|",
    ...rows.map(({ factor, score }) => `| ${factor} | >= 8/10 | — | ${score}/10 | ${score}/10 | locked |`),
  ].join("\n");
}

function rubricFor(factors) {
  return [
    "rubric:",
    "  factors:",
    ...factors.flatMap((factor) => [
      `    - name: ${factor}`,
      "      tier: contract",
      "      type: automated",
    ]),
  ].join("\n");
}

function createFakeGh(root) {
  const ghPath = path.join(root, "fake-gh.js");
  fs.writeFileSync(ghPath, [
    "#!/usr/bin/env node",
    "const bodies = JSON.parse(process.env.RELAY_TEST_PR_BODIES || '{}');",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'pr' && args[1] === 'view' && args[3] === '--json' && args[4] === 'body') {",
    "  process.stdout.write(JSON.stringify({ body: bodies[args[2]] || '' }));",
    "  process.exit(0);",
    "}",
    "process.stderr.write(`Unsupported gh invocation: ${args.join(' ')}\\n`);",
    "process.exit(1);",
  ].join("\n"), "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return ghPath;
}

function createFixture({ runs, configText = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sprint-close-"));
  const repoRoot = initRepo();
  const relayHome = path.join(root, "relay-home");
  const previousRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = relayHome;

  try {
    const sprintDir = path.join(repoRoot, "backlog", "sprints");
    fs.mkdirSync(sprintDir, { recursive: true });
    const issueNumbers = [...new Set(runs.map((run) => run.issue))].sort((left, right) => left - right);
    const sprintPath = path.join(sprintDir, "fixture-sprint.md");
    fs.writeFileSync(sprintPath, [
      "---",
      "milestone: fixture",
      "status: completed",
      "---",
      "",
      "## Plan",
      ...issueNumbers.map((issue) => `- [x] #${issue} Fixture task -> PR #${issue + 100}`),
      "",
      "## Notes",
    ].join("\n"), "utf-8");

    if (configText !== null) {
      fs.mkdirSync(path.join(repoRoot, "backlog"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "backlog", "config.yml"), configText, "utf-8");
    }

    for (const [index, run] of runs.entries()) {
      const runId = createRunId({
        issueNumber: run.issue,
        timestamp: new Date(`2026-04-20T00:00:${String(index).padStart(2, "0")}.000Z`),
      });
      const { runDir, manifestPath } = ensureRunLayout(repoRoot, runId);
      const rubricPath = "rubric.yaml";
      fs.writeFileSync(path.join(runDir, rubricPath), rubricFor(run.rubricFactors || [run.factor]), "utf-8");
      const prNumber = run.pr ?? run.issue + 100;

      const manifest = createManifestSkeleton({
        repoRoot,
        runId,
        branch: `issue-${run.issue}-fixture`,
        baseBranch: "main",
        issueNumber: run.issue,
        worktreePath: path.join(root, "worktrees", runId),
      });
      manifest.state = run.state || STATES.MERGED;
      manifest.git.pr_number = prNumber;
      manifest.anchor.rubric_path = rubricPath;
      writeManifest(manifestPath, manifest);
    }

    return {
      root,
      repoRoot,
      sprintPath,
      relayHome,
      ghPath: createFakeGh(root),
    };
  } finally {
    if (previousRelayHome === undefined) {
      delete process.env.RELAY_HOME;
    } else {
      process.env.RELAY_HOME = previousRelayHome;
    }
  }
}

function createFixtureAndRun({ runs, configText = null, args = [] }) {
  const fixture = createFixture({ runs, configText });
  const bodiesByPr = {};
  for (const run of runs) {
    const prNumber = run.pr ?? run.issue + 100;
    bodiesByPr[String(prNumber)] = run.body ?? scoreLog([{ factor: run.factor, score: run.score }]);
  }
  const result = spawnSync("node", [
    SCRIPT,
    "--repo", fixture.repoRoot,
    "--sprint", fixture.sprintPath,
    ...args,
  ], {
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      RELAY_HOME: fixture.relayHome,
      RELAY_GH_BIN: fixture.ghPath,
      RELAY_TEST_PR_BODIES: JSON.stringify(bodiesByPr),
    },
  });
  return { fixture, result };
}

test("(a) factor at score >= 9/10 in >= 2 runs in same sprint -> reported as candidate", () => {
  const { result } = createFixtureAndRun({
    runs: [
      { issue: 101, factor: "Reusable CLI pattern", score: 9 },
      { issue: 102, factor: "Reusable CLI pattern", score: 10 },
    ],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Candidate patterns this sprint:/);
  assert.match(result.stdout, /Reusable CLI pattern/);
  assert.match(result.stdout, /2 runs/);
});

test("(b) factor at score >= 9/10 in only 1 run -> NOT reported (min-runs gate holds)", () => {
  const { result } = createFixtureAndRun({
    runs: [
      { issue: 111, factor: "Single-run insight", score: 10 },
      { issue: 112, factor: "Other factor", score: 10 },
    ],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^- Single-run insight/m);
  assert.match(result.stdout, /\(none — no factors met threshold and min-runs gates\)/);
});

test("(c) factor at score < 9/10 across many runs -> NOT reported (threshold gate holds)", () => {
  const { result } = createFixtureAndRun({
    runs: [
      { issue: 121, factor: "Almost pattern", score: 8 },
      { issue: 122, factor: "Almost pattern", score: 8 },
      { issue: 123, factor: "Almost pattern", score: 8 },
    ],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^- Almost pattern/m);
  assert.match(result.stdout, /\(none — no factors met threshold and min-runs gates\)/);
});

test("(d) --threshold N CLI flag overrides default 9", () => {
  const { result } = createFixtureAndRun({
    runs: [
      { issue: 131, factor: "Eight-point convention", score: 8 },
      { issue: 132, factor: "Eight-point convention", score: 8 },
    ],
    args: ["--threshold", "8"],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^- Eight-point convention/m);
});

test("(e) --min-runs N CLI flag overrides default 2", () => {
  const { result } = createFixtureAndRun({
    runs: [
      { issue: 141, factor: "Solo strong signal", score: 9 },
    ],
    args: ["--min-runs", "1"],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^- Solo strong signal/m);
});

test("(f) backlog/config.yml sprint_close.* honored when CLI silent; CLI takes precedence when both are set", () => {
  const configText = [
    "project_name: fixture",
    "sprint_close:",
    "  threshold_score: 8",
    "  min_runs: 1",
  ].join("\n");
  const runs = [{ issue: 151, factor: "Configured candidate", score: 8 }];

  const configOnly = createFixtureAndRun({ runs, configText });
  assert.equal(configOnly.result.status, 0, configOnly.result.stderr);
  assert.match(configOnly.result.stdout, /^- Configured candidate/m);

  const cliOverride = createFixtureAndRun({ runs, configText, args: ["--threshold", "9"] });
  assert.equal(cliOverride.result.status, 0, cliOverride.result.stderr);
  assert.doesNotMatch(cliOverride.result.stdout, /^- Configured candidate/m);
});

test("empty scorable sprint still emits prescribed header, annotation, and manual-promotion instruction", () => {
  const { result } = createFixtureAndRun({
    runs: [
      { issue: 161, factor: "Unscored factor", score: 10, body: "## Score Log\n\nNo table here." },
    ],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Candidate patterns this sprint:/);
  assert.match(result.stdout, /\(none — no scorable Score Log tables in sprint runs\)/);
  assert.match(result.stdout, /Promote manually to _context\.md if applicable/);
});
