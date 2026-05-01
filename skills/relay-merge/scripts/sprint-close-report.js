#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const {
  loadPrBody,
  normalizeFactorKey,
  parseNumericScore,
  parseScoreLog,
} = require("../../relay-review/scripts/review-runner/divergence");
const { extractAllFactors } = require("../../relay-plan/scripts/tdd-flavor");
const { bindCliArgs } = require("../../relay-dispatch/scripts/cli-args");
const { listManifestRecords } = require("../../relay-dispatch/scripts/manifest/store");

const DEFAULT_THRESHOLD = 9;
const DEFAULT_MIN_RUNS = 2;
const TERMINAL_STATES = new Set(["merged", "closed"]);
const RESERVED_FLAGS = ["--repo", "--sprint", "--threshold", "--min-runs", "--help", "-h"];

function usage() {
  return [
    "Usage: node skills/relay-merge/scripts/sprint-close-report.js --repo <path> --sprint <path-to-sprint-md> [--threshold N] [--min-runs N]",
    "",
    "Reports rubric factors that scored consistently high across completed sprint runs.",
    "",
    "Options:",
    "  --repo <path>       Repository root used to resolve relay manifests.",
    "  --sprint <path>     Sprint markdown file containing a Plan checklist.",
    "  --threshold N       Minimum numeric Score Log value; overrides backlog/config.yml.",
    "  --min-runs N        Minimum distinct runs for a factor; overrides backlog/config.yml.",
    "  --help, -h          Show this help.",
    "",
    "Config fallback: backlog/config.yml may define sprint_close.threshold_score and sprint_close.min_runs.",
  ].join("\n");
}

function parsePositiveNumber(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function parseSprintCloseConfig(configText) {
  const result = {};
  let inSprintClose = false;
  let sprintCloseIndent = null;

  for (const rawLine of String(configText || "").split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(rawLine)) continue;
    const line = rawLine.replace(/\s+#.*$/, "");
    const section = line.match(/^(\s*)sprint_close:\s*$/);
    if (section) {
      inSprintClose = true;
      sprintCloseIndent = section[1].length;
      continue;
    }

    if (!inSprintClose) continue;

    const indent = line.match(/^\s*/)[0].length;
    if (indent <= sprintCloseIndent) {
      inSprintClose = false;
      continue;
    }

    const field = line.match(/^\s*(threshold_score|min_runs):\s*([^\s#]+)\s*$/);
    if (field) {
      result[field[1]] = field[2].replace(/^['"]|['"]$/g, "");
    }
  }

  return result;
}

function loadSprintCloseConfig(repoRoot) {
  const configPath = path.join(repoRoot, "backlog", "config.yml");
  if (!fs.existsSync(configPath)) return {};
  return parseSprintCloseConfig(fs.readFileSync(configPath, "utf-8"));
}

function resolveOptions(args) {
  const cli = bindCliArgs(args, { reservedFlags: RESERVED_FLAGS });
  if (cli.hasFlag("--help") || cli.hasFlag("-h")) {
    return { help: true };
  }

  const repoRoot = path.resolve(cli.getArg("--repo", "."));
  const sprintArg = cli.getArg("--sprint", undefined);
  if (!sprintArg) {
    throw new Error("--sprint <path-to-sprint-md> is required");
  }

  const sprintPath = path.resolve(repoRoot, sprintArg);
  const config = loadSprintCloseConfig(repoRoot);
  const configThreshold = parsePositiveNumber(config.threshold_score, "sprint_close.threshold_score");
  const configMinRuns = parsePositiveNumber(config.min_runs, "sprint_close.min_runs");
  const cliThreshold = parsePositiveNumber(cli.getArg("--threshold", undefined), "--threshold");
  const cliMinRuns = parsePositiveNumber(cli.getArg("--min-runs", undefined), "--min-runs");

  return {
    help: false,
    repoRoot,
    sprintPath,
    threshold: cliThreshold ?? configThreshold ?? DEFAULT_THRESHOLD,
    minRuns: cliMinRuns ?? configMinRuns ?? DEFAULT_MIN_RUNS,
  };
}

function parseSprintIssueNumbers(sprintText) {
  const issues = [];
  const seen = new Set();
  let inPlan = false;

  for (const line of String(sprintText || "").split(/\r?\n/)) {
    if (/^##+\s+Plan\b/i.test(line)) {
      inPlan = true;
      continue;
    }
    if (inPlan && /^##\s+\S/.test(line)) break;
    if (!inPlan) continue;

    const match = line.match(/^\s*-\s*\[[xX]\]\s*#(\d+)\b/);
    if (!match) continue;
    const issueNumber = Number(match[1]);
    if (!seen.has(issueNumber)) {
      seen.add(issueNumber);
      issues.push(issueNumber);
    }
  }

  return issues;
}

function issueNumberForManifest(record) {
  const issueNumber = record?.data?.issue?.number ?? record?.data?.git?.issue_number;
  if (Number.isInteger(issueNumber)) return issueNumber;
  const runId = record?.data?.run_id || path.basename(record?.manifestPath || "", ".md");
  const match = String(runId).match(/^issue-(\d+)-/);
  return match ? Number(match[1]) : null;
}

function resolveRubricPath(record) {
  const runId = record?.data?.run_id;
  const rubricPath = record?.data?.anchor?.rubric_path;
  if (!record?.manifestPath || typeof runId !== "string" || typeof rubricPath !== "string" || !rubricPath.trim()) {
    return null;
  }

  const runDir = path.join(path.dirname(record.manifestPath), runId);
  const resolved = path.resolve(runDir, rubricPath);
  const relative = path.relative(runDir, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function readRubricFactorIndex(record) {
  const rubricPath = resolveRubricPath(record);
  if (!rubricPath) return new Map();

  try {
    const factors = extractAllFactors(fs.readFileSync(rubricPath, "utf-8"));
    return new Map(
      factors
        .map((factor) => String(factor?.name || "").trim())
        .filter(Boolean)
        .map((name) => [normalizeFactorKey(name), name])
    );
  } catch {
    return new Map();
  }
}

function matchingSprintRecords(repoRoot, issueNumbers) {
  const issueSet = new Set(issueNumbers);
  return listManifestRecords(repoRoot).filter((record) => {
    const issueNumber = issueNumberForManifest(record);
    return issueSet.has(issueNumber) && TERMINAL_STATES.has(String(record?.data?.state || "").toLowerCase());
  });
}

function aggregateCandidatePatterns({ repoRoot, sprintPath, threshold, minRuns }) {
  const issueNumbers = parseSprintIssueNumbers(fs.readFileSync(sprintPath, "utf-8"));
  const records = matchingSprintRecords(repoRoot, issueNumbers);
  const byFactor = new Map();
  let scorableRuns = 0;

  for (const record of records) {
    const rubricFactors = readRubricFactorIndex(record);
    if (rubricFactors.size === 0) continue;

    const prNumber = record?.data?.git?.pr_number;
    const scoreLog = parseScoreLog(loadPrBody(repoRoot, prNumber));
    if (scoreLog.length === 0) continue;

    let runHasNumericRubricScore = false;
    const countedInRun = new Set();
    for (const row of scoreLog) {
      const factorKey = normalizeFactorKey(row.factor);
      const rubricName = rubricFactors.get(factorKey);
      if (!rubricName || countedInRun.has(factorKey)) continue;

      const score = parseNumericScore(row.score);
      if (score === null) continue;
      runHasNumericRubricScore = true;
      if (score < threshold) continue;

      if (!byFactor.has(factorKey)) {
        byFactor.set(factorKey, { factor: rubricName, runs: new Set(), scores: [] });
      }
      byFactor.get(factorKey).runs.add(record.data.run_id);
      byFactor.get(factorKey).scores.push(score);
      countedInRun.add(factorKey);
    }

    if (runHasNumericRubricScore) scorableRuns += 1;
  }

  const candidates = [...byFactor.values()]
    .filter((entry) => entry.runs.size >= minRuns)
    .sort((left, right) => right.runs.size - left.runs.size || left.factor.localeCompare(right.factor))
    .map((entry) => ({
      factor: entry.factor,
      runCount: entry.runs.size,
      runs: [...entry.runs].sort(),
      scores: entry.scores.slice().sort((left, right) => right - left),
    }));

  return {
    issueNumbers,
    recordsScanned: records.length,
    scorableRuns,
    threshold,
    minRuns,
    candidates,
  };
}

function renderReport(report) {
  const lines = [
    "Candidate patterns this sprint:",
    `Threshold: >= ${report.threshold}/10 across >= ${report.minRuns} runs`,
    `Sprint issues: ${report.issueNumbers.length ? report.issueNumbers.map((issue) => `#${issue}`).join(", ") : "(none found in Plan)"}`,
    `Completed runs scanned: ${report.recordsScanned}`,
    "",
  ];

  if (report.candidates.length > 0) {
    for (const candidate of report.candidates) {
      const scores = candidate.scores.map((score) => `${score}/10`).join(", ");
      lines.push(`- ${candidate.factor} (${candidate.runCount} runs; scores: ${scores})`);
    }
  } else if (report.scorableRuns === 0) {
    lines.push("(none — no scorable Score Log tables in sprint runs)");
  } else {
    lines.push("(none — no factors met threshold and min-runs gates)");
  }

  lines.push("", "Promote manually to _context.md if applicable");
  return lines.join("\n");
}

function main(args = process.argv.slice(2)) {
  const options = resolveOptions(args);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const report = aggregateCandidatePatterns(options);
  console.log(renderReport(report));
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  aggregateCandidatePatterns,
  main,
  parseSprintCloseConfig,
  parseSprintIssueNumbers,
  renderReport,
  resolveOptions,
};
