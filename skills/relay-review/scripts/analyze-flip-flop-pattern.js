#!/usr/bin/env node
/**
 * Phase A measurement for issue #270:
 * scan recent relay runs, detect rubric-factor flip-flops, and measure how
 * often they look progressive-shaped versus thrash-shaped.
 *
 * Buckets:
 * - progressive-shaped: at least one flip-flop factor trace and
 *   review.repeated_issue_count === 0
 * - thrash-shaped: at least one flip-flop factor trace and
 *   review.repeated_issue_count >= 1
 * - no_flip_flop: no factor shows >=2 pass/fail transitions inside any
 *   3-round sliding window
 * - data_gap: the run cannot be classified confidently because required input
 *   is missing or invalid (for example missing manifest, missing verdict round,
 *   invalid verdict JSON, or missing review.repeated_issue_count)
 *
 * Decision gate: if progressive / (progressive + thrash) >= 20%, Phase B is
 * worth building. Otherwise deprioritize. Context: issue #270.
 *
 * Re-run before any Phase B go/no-go decision, after new multi-round relay
 * review data enters the last-30-days window, or whenever reusing an older
 * issue #270 report would make the decision gate stale.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const {
  getRunsBase,
  validateRunId,
} = require("../../relay-dispatch/scripts/manifest/paths");
const { readManifest } = require("../../relay-dispatch/scripts/manifest/store");
const {
  findUnknownFlags,
  getArg,
  getPositionals,
  hasFlag,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");

const DEFAULT_WINDOW_DAYS = 30;
const PASS_FAIL_STATUSES = new Set(["pass", "fail"]);
const DATA_GAP = "data_gap";
const KNOWN_FLAGS = new Set([
  "--print",
  "--post-comment",
  "--issue",
  "--window-days",
  "--runs-dir",
  "--help",
  "-h",
]);
const CLI_ARG_OPTIONS = {
  commandName: "analyze-flip-flop-pattern",
  reservedFlags: [...KNOWN_FLAGS],
};

function parsePositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = [...argv];
  const unknownFlags = findUnknownFlags(args, "analyze-flip-flop-pattern");
  if (unknownFlags.length > 0) {
    throw new Error(`Unknown flag: ${unknownFlags[0]}`);
  }
  const positionals = getPositionals(args, "analyze-flip-flop-pattern");
  if (positionals.length > 0) {
    throw new Error(`Unexpected positional argument: ${positionals[0]}`);
  }

  const issueRaw = getArg(args, "--issue", undefined, CLI_ARG_OPTIONS);
  const windowDaysRaw = getArg(args, "--window-days", undefined, CLI_ARG_OPTIONS);
  const runsDirRaw = getArg(args, "--runs-dir", undefined, CLI_ARG_OPTIONS);
  const options = {
    help: hasFlag(args, ["--help", "-h"], CLI_ARG_OPTIONS),
    issueNumber: issueRaw === undefined ? null : parsePositiveInt(issueRaw, "--issue"),
    postComment: hasFlag(args, "--post-comment", CLI_ARG_OPTIONS),
    print: true,
    runsDir: path.resolve(runsDirRaw || getRunsBase()),
    windowDays: windowDaysRaw === undefined ? DEFAULT_WINDOW_DAYS : parsePositiveInt(windowDaysRaw, "--window-days"),
  };

  if (hasFlag(args, "--issue", CLI_ARG_OPTIONS) && issueRaw === undefined) {
    throw new Error("--issue requires a value");
  }
  if (hasFlag(args, "--window-days", CLI_ARG_OPTIONS) && windowDaysRaw === undefined) {
    throw new Error("--window-days requires a value");
  }
  if (hasFlag(args, "--runs-dir", CLI_ARG_OPTIONS) && runsDirRaw === undefined) {
    throw new Error("--runs-dir requires a value");
  }

  if (options.postComment && !options.issueNumber) {
    throw new Error("--post-comment requires --issue <N>");
  }

  return options;
}

function printHelp() {
  console.log("Usage: analyze-flip-flop-pattern.js [options]");
  console.log("");
  console.log("Scan recent relay review runs and measure whether flip-flops look progressive or thrashy.");
  console.log("");
  console.log("Options:");
  console.log(`  --print               ${modeLabel("--print")} Emit the markdown report to stdout (default)`);
  console.log(`  --post-comment        ${modeLabel("--post-comment")} Post the same markdown report to a GitHub issue comment`);
  console.log(`  --issue <N>           ${modeLabel("--issue")} GitHub issue number to use with --post-comment`);
  console.log(`  --window-days <N>     ${modeLabel("--window-days")} Scan runs whose latest artifact mtime is within the last N days (default: ${DEFAULT_WINDOW_DAYS})`);
  console.log(`  --runs-dir <path>     ${modeLabel("--runs-dir")} Override the relay runs base directory (default: ~/.relay/runs)`);
  console.log(`  --help, -h            ${modeLabel("--help")} Show this help text`);
}

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function normalizeFactor(factor) {
  return String(factor || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function summarizeExecError(error) {
  const stderr = String(error.stderr || "").trim();
  const stdout = String(error.stdout || "").trim();
  return stderr || stdout || error.message;
}

function getRepoRoot() {
  return path.resolve(__dirname, "../../..");
}

function getScriptRelativePath() {
  return path.relative(getRepoRoot(), __filename).replace(/\\/g, "/");
}

function getCommitShort(repoRoot) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return "unknown";
  }
}

function listImmediateDirectories(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name));
}

function listFilesRecursive(rootPath) {
  const stat = fs.statSync(rootPath);
  if (!stat.isDirectory()) return [rootPath];

  const files = [];
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(entryPath));
      continue;
    }
    files.push(entryPath);
  }
  return files;
}

function getLatestArtifactMtimeMs(runDir) {
  const artifactPaths = listFilesRecursive(runDir);
  if (artifactPaths.length === 0) {
    return fs.statSync(runDir).mtimeMs;
  }
  return artifactPaths.reduce((latest, artifactPath) => {
    return Math.max(latest, fs.statSync(artifactPath).mtimeMs);
  }, 0);
}

function extractRoundNumber(fileName) {
  const match = fileName.match(/^review-round-(\d+)-verdict\.json$/);
  return match ? Number(match[1]) : null;
}

function listVerdictFiles(runDir) {
  if (!fs.existsSync(runDir)) return [];
  return fs.readdirSync(runDir)
    .map((fileName) => ({ fileName, round: extractRoundNumber(fileName) }))
    .filter((entry) => Number.isInteger(entry.round))
    .sort((left, right) => left.round - right.round)
    .map((entry) => path.join(runDir, entry.fileName));
}

function loadManifestIndex(slugDir) {
  const manifestIndex = new Map();
  for (const entry of fs.readdirSync(slugDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const runId = path.basename(entry.name, ".md");
    if (!validateRunId(runId).valid) continue;
    const manifestPath = path.join(slugDir, entry.name);
    try {
      const parsed = readManifest(manifestPath);
      manifestIndex.set(runId, {
        body: parsed.body,
        data: parsed.data,
        error: null,
        manifestPath,
        runId,
      });
    } catch (error) {
      manifestIndex.set(runId, {
        body: null,
        data: null,
        error,
        manifestPath,
        runId,
      });
    }
  }
  return manifestIndex;
}

function loadVerdictRounds(verdictPaths) {
  const rounds = [];
  const errors = [];

  for (const verdictPath of verdictPaths) {
    const round = extractRoundNumber(path.basename(verdictPath));
    try {
      rounds.push({
        round,
        verdict: JSON.parse(fs.readFileSync(verdictPath, "utf-8")),
        verdictPath,
      });
    } catch (error) {
      errors.push({
        error,
        reason: "invalid_verdict_json",
        round,
        verdictPath,
      });
    }
  }

  rounds.sort((left, right) => left.round - right.round);
  return { errors, rounds };
}

function getRecordedReviewRoundCount(manifestRecord, expectedRunId) {
  if (!manifestRecord || manifestRecord.error) return null;
  if (manifestRecord.data?.run_id && manifestRecord.data.run_id !== expectedRunId) return null;

  const rounds = manifestRecord.data?.review?.rounds;
  if (rounds === undefined || rounds === null) return null;
  if (!Number.isInteger(Number(rounds)) || Number(rounds) < 0) return null;
  return Number(rounds);
}

function findVerdictRoundGap(verdictPaths, expectedRoundCount = null) {
  const rounds = verdictPaths
    .map((verdictPath) => extractRoundNumber(path.basename(verdictPath)))
    .filter((round) => Number.isInteger(round))
    .sort((left, right) => left - right);

  if (expectedRoundCount !== null && expectedRoundCount !== undefined) {
    const roundSet = new Set(rounds);
    for (let round = 1; round <= expectedRoundCount; round += 1) {
      if (!roundSet.has(round)) return round;
    }
    return null;
  }

  if (rounds.length < 2) return null;
  if (rounds[0] !== 1) return 1;

  for (let index = 1; index < rounds.length; index += 1) {
    const expectedRound = rounds[index - 1] + 1;
    if (rounds[index] !== expectedRound) return expectedRound;
  }

  return null;
}

function buildFactorTraceMap(rounds) {
  const traceMap = new Map();

  for (const roundRecord of rounds) {
    const roundFactorMap = new Map();
    const rubricScores = Array.isArray(roundRecord.verdict?.rubric_scores)
      ? roundRecord.verdict.rubric_scores
      : [];

    for (const score of rubricScores) {
      const factorKey = normalizeFactor(score?.factor);
      if (!factorKey) continue;
      roundFactorMap.set(factorKey, {
        factor: String(score.factor || "").trim() || factorKey,
        status: normalizeStatus(score.status),
      });
    }

    for (const [factorKey, score] of roundFactorMap.entries()) {
      if (!traceMap.has(factorKey)) {
        traceMap.set(factorKey, { factor: score.factor, entries: [] });
      }
      const trace = traceMap.get(factorKey);
      trace.factor = score.factor || trace.factor;
      trace.entries.push({
        round: roundRecord.round,
        status: score.status,
      });
    }
  }

  return [...traceMap.values()].sort((left, right) => left.factor.localeCompare(right.factor));
}

function countPassFailTransitions(entries) {
  const passFailEntries = entries.filter((entry) => PASS_FAIL_STATUSES.has(entry.status));
  let transitions = 0;
  for (let index = 1; index < passFailEntries.length; index += 1) {
    if (passFailEntries[index - 1].status !== passFailEntries[index].status) {
      transitions += 1;
    }
  }
  return {
    transitions,
    traceEntries: passFailEntries,
  };
}

function formatTrace(entries) {
  return entries.map((entry) => `r${entry.round}:${entry.status}`).join(" -> ");
}

function findFlipFactors(rounds) {
  if (rounds.length === 0) return [];
  const maxRound = rounds.reduce((memo, round) => Math.max(memo, round.round), 0);
  return buildFactorTraceMap(rounds).flatMap((trace) => {
    for (let startRound = 1; startRound <= maxRound - 2; startRound += 1) {
      const windowEntries = trace.entries.filter((entry) => (
        entry.round >= startRound && entry.round <= startRound + 2
      ));
      const flip = countPassFailTransitions(windowEntries);
      if (flip.transitions >= 2) {
        return [{
          factor: trace.factor,
          traceEntries: flip.traceEntries,
          traceLabel: formatTrace(flip.traceEntries),
        }];
      }
    }
    return [];
  });
}

function resolveManifestData(manifestRecord, expectedRunId) {
  if (!manifestRecord) {
    return {
      dataGapReason: "missing_manifest",
      manifestData: null,
      repeatedIssueCount: null,
    };
  }

  if (manifestRecord.error) {
    return {
      dataGapReason: "invalid_manifest",
      manifestData: null,
      repeatedIssueCount: null,
    };
  }

  if (manifestRecord.data?.run_id && manifestRecord.data.run_id !== expectedRunId) {
    return {
      dataGapReason: "manifest_run_id_mismatch",
      manifestData: manifestRecord.data,
      repeatedIssueCount: null,
    };
  }

  const repeatedIssueCount = manifestRecord.data?.review?.repeated_issue_count;
  if (repeatedIssueCount === undefined) {
    return {
      dataGapReason: "missing_repeated_issue_count",
      manifestData: manifestRecord.data,
      repeatedIssueCount: null,
    };
  }

  if (!Number.isInteger(Number(repeatedIssueCount)) || Number(repeatedIssueCount) < 0) {
    return {
      dataGapReason: "invalid_repeated_issue_count",
      manifestData: manifestRecord.data,
      repeatedIssueCount: null,
    };
  }

  return {
    dataGapReason: null,
    manifestData: manifestRecord.data,
    repeatedIssueCount: Number(repeatedIssueCount),
  };
}

function classifyRun(candidate) {
  const recordedRoundCount = candidate.recordedRoundCount ?? getRecordedReviewRoundCount(
    candidate.manifestRecord,
    candidate.runId
  );
  const missingVerdictRound = findVerdictRoundGap(candidate.verdictPaths, recordedRoundCount);
  const verdictLoad = loadVerdictRounds(candidate.verdictPaths);
  const manifest = resolveManifestData(candidate.manifestRecord, candidate.runId);
  const flipFactors = missingVerdictRound || verdictLoad.errors.length > 0
    ? []
    : findFlipFactors(verdictLoad.rounds);

  let dataGapReason = manifest.dataGapReason;
  if (!dataGapReason && missingVerdictRound) {
    dataGapReason = "missing_verdict_round";
  }
  if (!dataGapReason && verdictLoad.errors.length > 0) {
    dataGapReason = verdictLoad.errors[0].reason;
  }

  let bucket = "no_flip_flop";
  if (dataGapReason) {
    bucket = DATA_GAP;
  } else if (flipFactors.length > 0) {
    bucket = manifest.repeatedIssueCount === 0 ? "progressive-shaped" : "thrash-shaped";
  }

  return {
    bucket,
    dataGapReason,
    flipFactors,
    latestMtimeMs: candidate.latestMtimeMs,
    latestMtimeIso: new Date(candidate.latestMtimeMs).toISOString(),
    manifestPath: candidate.manifestRecord?.manifestPath || null,
    prNumber: manifest.manifestData?.git?.pr_number ?? null,
    repeatedIssueCount: manifest.repeatedIssueCount,
    roundCount: recordedRoundCount ?? candidate.verdictPaths.length,
    missingVerdictRound,
    runDir: candidate.runDir,
    runId: candidate.runId,
    slug: candidate.slug,
    verdictPaths: candidate.verdictPaths,
  };
}

function countBySlug(records) {
  const counts = new Map();
  for (const record of records) {
    counts.set(record.slug, (counts.get(record.slug) || 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function formatPercentage(value) {
  if (value === null || value === undefined) return "n/a";
  return `${Math.round(value)}`;
}

function summarizeDecisionMetric(classificationCounts) {
  const progressive = classificationCounts["progressive-shaped"];
  const thrash = classificationCounts["thrash-shaped"];
  const denominator = progressive + thrash;

  if (denominator === 0) {
    return {
      denominator,
      percentage: null,
      recommendationLabel: "`n/a - no flip-flop runs in window` -> deprioritize (insufficient signal)",
    };
  }

  const percentage = (progressive / denominator) * 100;
  return {
    denominator,
    percentage,
    recommendationLabel: percentage >= 20
      ? "`>=20% -> proceed to Phase B`"
      : "`<20% -> deprioritize`",
  };
}

function analyzeRuns({ now = new Date(), runsDir = getRunsBase(), windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const anchorDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(anchorDate.getTime())) {
    throw new Error(`Invalid anchor date: ${JSON.stringify(now)}`);
  }

  const resolvedRunsDir = path.resolve(runsDir);
  const windowStartMs = anchorDate.getTime() - (windowDays * 24 * 60 * 60 * 1000);
  const recentRuns = [];
  const inScopeRuns = [];

  for (const slugDir of listImmediateDirectories(resolvedRunsDir)) {
    const slug = path.basename(slugDir);
    const manifestIndex = loadManifestIndex(slugDir);
    for (const runDir of listImmediateDirectories(slugDir)) {
      const runId = path.basename(runDir);
      if (!validateRunId(runId).valid) continue;

      const latestMtimeMs = getLatestArtifactMtimeMs(runDir);
      if (latestMtimeMs < windowStartMs) continue;

      const verdictPaths = listVerdictFiles(runDir);
      const manifestRecord = manifestIndex.get(runId) || null;
      const recordedRoundCount = getRecordedReviewRoundCount(manifestRecord, runId);
      const candidate = {
        latestMtimeMs,
        manifestRecord,
        recordedRoundCount,
        runDir,
        runId,
        slug,
        verdictPaths,
      };

      recentRuns.push(candidate);
      if ((recordedRoundCount ?? verdictPaths.length) < 2) continue;
      inScopeRuns.push(classifyRun(candidate));
    }
  }

  const classificationCounts = {
    "progressive-shaped": 0,
    "thrash-shaped": 0,
    "no_flip_flop": 0,
    [DATA_GAP]: 0,
  };

  for (const run of inScopeRuns) {
    classificationCounts[run.bucket] += 1;
  }

  const metric = summarizeDecisionMetric(classificationCounts);
  const bucketPriority = {
    "progressive-shaped": 0,
    "thrash-shaped": 1,
    [DATA_GAP]: 2,
    "no_flip_flop": 3,
  };
  inScopeRuns.sort((left, right) => {
    const bucketDelta = bucketPriority[left.bucket] - bucketPriority[right.bucket];
    if (bucketDelta !== 0) return bucketDelta;
    return right.latestMtimeMs - left.latestMtimeMs;
  });

  return {
    anchorIso: anchorDate.toISOString(),
    classificationCounts,
    commitShort: getCommitShort(getRepoRoot()),
    decisionMetric: metric,
    recentRunsBySlug: countBySlug(recentRuns),
    recentRunsCount: recentRuns.length,
    runs: inScopeRuns,
    runsDir: resolvedRunsDir,
    scriptPath: getScriptRelativePath(),
    windowDays,
    windowEndIso: anchorDate.toISOString(),
    windowStartIso: new Date(windowStartMs).toISOString(),
  };
}

function escapeTableCell(value) {
  return String(value)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function formatBySlug(bySlug) {
  if (bySlug.length === 0) return "none";
  return bySlug.map(([slug, count]) => `${slug}: ${count}`).join(", ");
}

function formatBucketLabel(run) {
  if (run.bucket !== DATA_GAP || !run.dataGapReason) return run.bucket;
  return `${run.bucket} (${run.dataGapReason})`;
}

function formatRepeatedIssueCount(run) {
  if (run.repeatedIssueCount !== null && run.repeatedIssueCount !== undefined) {
    return String(run.repeatedIssueCount);
  }
  return "missing";
}

function renderBreakdownRows(runs) {
  if (runs.length === 0) {
    return ["| _none_ | - | - | - | - | - | - |"];
  }

  return runs.map((run) => {
    const flippedFactor = run.flipFactors.length
      ? run.flipFactors.map((flip) => escapeTableCell(flip.factor)).join("<br>")
      : "-";
    const statusTrace = run.flipFactors.length
      ? run.flipFactors.map((flip) => escapeTableCell(flip.traceLabel)).join("<br>")
      : "-";
    const pr = run.prNumber === null || run.prNumber === undefined ? "n/a" : String(run.prNumber);

    return [
      `| ${escapeTableCell(run.runId)}`,
      `${escapeTableCell(run.slug)}`,
      `${escapeTableCell(pr)}`,
      `${flippedFactor}`,
      `${statusTrace}`,
      `${escapeTableCell(formatRepeatedIssueCount(run))}`,
      `${escapeTableCell(formatBucketLabel(run))} |`,
    ].join(" | ");
  });
}

function renderReport(summary) {
  const decisionMetric = summary.decisionMetric.percentage === null
    ? "n/a"
    : `${formatPercentage(summary.decisionMetric.percentage)}%`;

  return [
    "# Flip-flop pattern scan — #270 Phase A",
    "",
    `**Scan window**: ${summary.windowStartIso} → ${summary.windowEndIso} (last ${summary.windowDays}d, anchored at ${summary.anchorIso})`,
    `**Script**: ${summary.scriptPath}@${summary.commitShort}`,
    "",
    "## Totals",
    `- Runs scanned (all slugs): ${summary.recentRunsCount}`,
    `- Runs with ≥2 rounds: ${summary.runs.length}`,
    `- By slug: ${formatBySlug(summary.recentRunsBySlug)}`,
    "",
    "## Flip-flop classification",
    `- progressive-shaped: ${summary.classificationCounts["progressive-shaped"]}`,
    `- thrash-shaped: ${summary.classificationCounts["thrash-shaped"]}`,
    `- no_flip_flop: ${summary.classificationCounts.no_flip_flop}`,
    `- data_gap: ${summary.classificationCounts.data_gap}`,
    "",
    "## Decision metric",
    `progressive / (progressive + thrash) = **${decisionMetric}**`,
    "",
    `**Recommendation**: ${summary.decisionMetric.recommendationLabel}`,
    "",
    "## Per-run breakdown",
    "| run_id | slug | PR | flipped factor | status trace | repeated_issue_count | bucket |",
    "|---|---|---|---|---|---|---|",
    ...renderBreakdownRows(summary.runs),
  ].join("\n");
}

function postIssueComment({ body, issueNumber, repoRoot }) {
  try {
    execFileSync("gh", ["issue", "comment", String(issueNumber), "--body-file", "-"], {
      cwd: repoRoot,
      encoding: "utf-8",
      input: body,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`gh issue comment failed: ${summarizeExecError(error)}`);
  }
}

function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return null;
  }

  const summary = analyzeRuns({
    runsDir: options.runsDir,
    windowDays: options.windowDays,
  });
  const report = renderReport(summary);

  if (options.print) {
    process.stdout.write(`${report}\n`);
  }

  if (options.postComment) {
    postIssueComment({
      body: report,
      issueNumber: options.issueNumber,
      repoRoot: getRepoRoot(),
    });
  }

  return { report, summary };
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_WINDOW_DAYS,
  analyzeRuns,
  countPassFailTransitions,
  findFlipFactors,
  formatTrace,
  loadManifestIndex,
  loadVerdictRounds,
  parseArgs,
  postIssueComment,
  renderReport,
  resolveManifestData,
  runCli,
};
