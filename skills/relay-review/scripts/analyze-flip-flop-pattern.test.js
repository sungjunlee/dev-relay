const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  analyzeRuns,
  parseArgs,
  renderReport,
} = require("./analyze-flip-flop-pattern");

const SCRIPT_PATH = path.join(__dirname, "analyze-flip-flop-pattern.js");
const FIXTURES_DIR = path.join(__dirname, "fixtures", "analyze-flip-flop-pattern");

function loadFixtureSpec(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf-8"));
}

function writeManifest(manifestPath, { prNumber, repeatedIssueCount, omitRepeatedIssueCount }, runId) {
  const lines = [
    "---",
    "relay_version: 2",
    `run_id: '${runId}'`,
    "git:",
    `  pr_number: ${prNumber === null || prNumber === undefined ? "null" : prNumber}`,
    "review:",
  ];

  if (!omitRepeatedIssueCount) {
    lines.push(`  repeated_issue_count: ${repeatedIssueCount}`);
  }

  lines.push(
    "paths:",
    "  repo_root: '/tmp/fake-repo'",
    "  worktree: '/tmp/fake-worktree'",
    "timestamps:",
    "  created_at: '2026-04-20T00:00:00.000Z'",
    "  updated_at: '2026-04-20T00:00:00.000Z'",
    "---",
    "# Notes",
    ""
  );

  fs.writeFileSync(manifestPath, lines.join("\n"), "utf-8");
}

function writeVerdict(verdictPath, roundSpec) {
  if (roundSpec.raw) {
    fs.writeFileSync(verdictPath, roundSpec.raw, "utf-8");
    return;
  }

  const rubric_scores = (roundSpec.rubricScores || []).map(([factor, status]) => ({
    factor,
    target: ">= 1/1",
    observed: `${factor} ${status}`,
    status,
    tier: "contract",
    notes: `${factor} is ${status}`,
  }));

  fs.writeFileSync(verdictPath, JSON.stringify({
    verdict: roundSpec.verdict || "changes_requested",
    rubric_scores,
  }, null, 2), "utf-8");
}

function setIsoMtime(targetPath, isoText) {
  const date = new Date(isoText);
  fs.utimesSync(targetPath, date, date);
}

function materializeFixture(name) {
  const spec = loadFixtureSpec(name);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-flip-flop-pattern-"));
  const runsDir = path.join(rootDir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });

  for (const run of spec.runs) {
    const slugDir = path.join(runsDir, run.slug);
    const runDir = path.join(slugDir, run.runId);
    fs.mkdirSync(runDir, { recursive: true });

    if (run.manifest !== false) {
      const manifestPath = path.join(slugDir, `${run.runId}.md`);
      writeManifest(manifestPath, run.manifest, run.runId);
      setIsoMtime(manifestPath, run.latestMtime);
    }

    for (const round of run.rounds) {
      const verdictPath = path.join(runDir, `review-round-${round.round}-verdict.json`);
      writeVerdict(verdictPath, round);
      setIsoMtime(verdictPath, run.latestMtime);
    }
  }

  return {
    now: spec.now,
    rootDir,
    runsDir,
  };
}

function findRun(summary, runId) {
  return summary.runs.find((run) => run.runId === runId);
}

function createFakeGhCapture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fake-gh-"));
  const binDir = path.join(rootDir, "bin");
  const capturePath = path.join(rootDir, "capture.json");
  const ghPath = path.join(binDir, "gh");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(ghPath, [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const input = fs.readFileSync(0, 'utf8');",
    `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input }, null, 2));`,
  ].join("\n"), { mode: 0o755 });
  return { binDir, capturePath };
}

test("analyze-flip-flop-pattern/parseArgs keeps the default print mode and validates post-comment requirements", () => {
  const parsed = parseArgs(["--window-days", "14"]);
  assert.equal(parsed.print, true);
  assert.equal(parsed.windowDays, 14);

  assert.throws(
    () => parseArgs(["--post-comment"]),
    /requires --issue <N>/
  );
});

test("analyze-flip-flop-pattern classifies progressive, thrash, no-flip, and data-gap runs from the baseline fixture", () => {
  const fixture = materializeFixture("baseline");
  const summary = analyzeRuns({
    now: fixture.now,
    runsDir: fixture.runsDir,
    windowDays: 30,
  });

  assert.equal(summary.recentRunsCount, 10);
  assert.equal(summary.runs.length, 9);
  assert.deepEqual(summary.classificationCounts, {
    "progressive-shaped": 2,
    "thrash-shaped": 1,
    "no_flip_flop": 3,
    data_gap: 3,
  });
  assert.equal(summary.decisionMetric.denominator, 3);
  assert.equal(summary.decisionMetric.percentage, (2 / 3) * 100);
});

test("analyze-flip-flop-pattern ignores not_run and missing-factor gaps when looking for flip-flops", () => {
  const fixture = materializeFixture("baseline");
  const summary = analyzeRuns({
    now: fixture.now,
    runsDir: fixture.runsDir,
    windowDays: 30,
  });

  assert.equal(findRun(summary, "issue-205-20260420010505050-ee55ff66").bucket, "no_flip_flop");
  assert.equal(findRun(summary, "issue-206-20260420010606060-ff66aa77").bucket, "no_flip_flop");
});

test("analyze-flip-flop-pattern detects a sliding-window flip that only appears in rounds 2-4", () => {
  const fixture = materializeFixture("baseline");
  const summary = analyzeRuns({
    now: fixture.now,
    runsDir: fixture.runsDir,
    windowDays: 30,
  });

  const run = findRun(summary, "issue-207-20260420010707070-aa77bb88");
  assert.equal(run.bucket, "progressive-shaped");
  assert.deepEqual(run.flipFactors.map((flip) => flip.traceLabel), ["r2:pass -> r3:fail -> r4:pass"]);
});

test("analyze-flip-flop-pattern excludes old runs and one-round runs from the in-scope denominator", () => {
  const fixture = materializeFixture("baseline");
  const summary = analyzeRuns({
    now: fixture.now,
    runsDir: fixture.runsDir,
    windowDays: 30,
  });

  assert.equal(findRun(summary, "issue-208-20260301010808080-bb88cc99"), undefined);
  assert.equal(findRun(summary, "issue-209-20260420010909090-cc99ddaa"), undefined);
});

test("analyze-flip-flop-pattern records explicit data-gap reasons for missing repeated_issue_count, missing manifest, and invalid verdict JSON", () => {
  const fixture = materializeFixture("baseline");
  const summary = analyzeRuns({
    now: fixture.now,
    runsDir: fixture.runsDir,
    windowDays: 30,
  });

  assert.equal(findRun(summary, "issue-204-20260420010404040-dd44ee55").dataGapReason, "missing_repeated_issue_count");
  assert.equal(findRun(summary, "issue-210-20260420011010100-ddaaeebb").dataGapReason, "missing_manifest");
  assert.equal(findRun(summary, "issue-211-20260420011111110-eebbffcc").dataGapReason, "invalid_verdict_json");
});

test("analyze-flip-flop-pattern classifies missing verdict-file round gaps as data_gap", () => {
  const fixture = materializeFixture("corner-cases");
  const summary = analyzeRuns({
    now: fixture.now,
    runsDir: fixture.runsDir,
    windowDays: 30,
  });

  const run = findRun(summary, "issue-401-20260422040101010-aabbccdd");
  assert.equal(run.bucket, "data_gap");
  assert.equal(run.dataGapReason, "missing_verdict_round");
  assert.equal(run.missingVerdictRound, 2);
  assert.deepEqual(run.flipFactors, []);
});

test("analyze-flip-flop-pattern reports mixed flip and stable factors without inventing stable-factor flips", () => {
  const fixture = materializeFixture("corner-cases");
  const summary = analyzeRuns({
    now: fixture.now,
    runsDir: fixture.runsDir,
    windowDays: 30,
  });

  const run = findRun(summary, "issue-402-20260422040202020-bbccddee");
  assert.equal(run.bucket, "progressive-shaped");
  assert.deepEqual(run.flipFactors.map((flip) => flip.factor), ["Behavior"]);
  assert.deepEqual(run.flipFactors.map((flip) => flip.traceLabel), ["r1:pass -> r2:fail -> r3:pass"]);
});

test("analyze-flip-flop-pattern ignores skipped statuses when counting pass/fail transitions", () => {
  const fixture = materializeFixture("corner-cases");
  const summary = analyzeRuns({
    now: fixture.now,
    runsDir: fixture.runsDir,
    windowDays: 30,
  });

  const run = findRun(summary, "issue-403-20260422040303030-ccddeeff");
  assert.equal(run.bucket, "no_flip_flop");
  assert.deepEqual(run.flipFactors, []);
});

test("analyze-flip-flop-pattern renderReport emits the required headings and percentage output", () => {
  const fixture = materializeFixture("baseline");
  const summary = analyzeRuns({
    now: fixture.now,
    runsDir: fixture.runsDir,
    windowDays: 30,
  });
  const report = renderReport(summary);

  assert.match(report, /^# Flip-flop pattern scan — #270 Phase A/m);
  assert.match(report, /## Totals/);
  assert.match(report, /## Flip-flop classification/);
  assert.match(report, /## Decision metric/);
  assert.match(report, /## Per-run breakdown/);
  assert.match(report, /progressive \/ \(progressive \+ thrash\) = \*\*66\.7%\*\*/);
  assert.match(report, /\*\*Recommendation\*\*: `>=20% -> proceed to Phase B`/);
});

test("analyze-flip-flop-pattern renderReport uses n/a when there are no flip-flop runs in the window", () => {
  const fixture = materializeFixture("no-flips");
  const summary = analyzeRuns({
    now: fixture.now,
    runsDir: fixture.runsDir,
    windowDays: 30,
  });
  const report = renderReport(summary);

  assert.equal(summary.decisionMetric.denominator, 0);
  assert.equal(summary.decisionMetric.percentage, null);
  assert.match(report, /progressive \/ \(progressive \+ thrash\) = \*\*n\/a\*\*/);
  assert.match(report, /\*\*Recommendation\*\*: `n\/a - no flip-flop runs in window` -> deprioritize \(insufficient signal\)/);
});

test("analyze-flip-flop-pattern CLI --help lists every supported flag", () => {
  const output = execFileSync("node", [SCRIPT_PATH, "--help"], {
    cwd: __dirname,
    encoding: "utf-8",
    stdio: "pipe",
  });

  for (const flag of ["--print", "--post-comment", "--issue", "--window-days", "--runs-dir", "--help"]) {
    assert.match(output, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("analyze-flip-flop-pattern CLI --post-comment sends the rendered report to gh issue comment", () => {
  const fixture = materializeFixture("baseline");
  const fakeGh = createFakeGhCapture();
  const output = execFileSync("node", [
    SCRIPT_PATH,
    "--runs-dir", fixture.runsDir,
    "--window-days", "30",
    "--post-comment",
    "--issue", "270",
  ], {
    cwd: __dirname,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${fakeGh.binDir}:${process.env.PATH}`,
    },
    stdio: "pipe",
  });

  const capture = JSON.parse(fs.readFileSync(fakeGh.capturePath, "utf-8"));
  assert.match(output, /^# Flip-flop pattern scan — #270 Phase A/m);
  assert.deepEqual(capture.argv, ["issue", "comment", "270", "--body-file", "-"]);
  assert.match(capture.input, /^# Flip-flop pattern scan — #270 Phase A/m);
});
