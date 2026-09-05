#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const runStore = require("../../relay-dispatch/scripts/run-store");
const { inspectProductionRun } = require("../../relay-dispatch/scripts/recover");
const {
  applyGcCandidate,
  durableClassification,
  formatAllText,
  legacySummaries,
  publicRunRow,
  scanAllRuns,
  worktreeCandidates,
} = require("./relay-status-helpers");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--run-id", "--issue", "--json", "--help", "-h"];
const CLI_OPTIONS = {
  reservedFlags: KNOWN_FLAGS,
  booleanFlags: ["--json", "--help", "-h"],
  verbatimValueFlags: ["--repo"],
};
const ALL_FLAGS = ["--all", "--gc", "--apply", "--min-age-days", "--json", "--help", "-h"];
const ALL_VALUE_FLAGS = new Set(["--min-age-days"]);
const DEFAULT_MIN_AGE_DAYS = 14;
function parseCli(argv) {
  const known = new Set(KNOWN_FLAGS);
  const boolean = new Set(CLI_OPTIONS.booleanFlags);
  const nonEmpty = new Set(CLI_OPTIONS.verbatimValueFlags);
  const consumed = new Set();
  const name = (token) => String(token).split("=", 1)[0];
  const acceptsAdjacent = (value) => value !== undefined && !String(value).startsWith("-");
  const variants = (flag) => Array.isArray(flag) ? flag : [flag];

  argv.forEach((token, index) => {
    const flag = name(token);
    if (known.has(flag) && !boolean.has(flag) && !String(token).includes("=") && acceptsAdjacent(argv[index + 1])) {
      consumed.add(index + 1);
    }
  });
  const unknown = argv.filter((token, index) => !consumed.has(index)
    && String(token).startsWith("-") && !known.has(name(token)));
  if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);

  return {
    hasFlag(flags) {
      return variants(flags).some((flag) => argv.some((token, index) => !consumed.has(index)
        && (token === flag || String(token).startsWith(`${flag}=`))));
    },
    getArg(flags, fallback) {
      for (const flag of variants(flags)) {
        for (let index = 0; index < argv.length; index += 1) {
          if (consumed.has(index)) continue;
          const token = String(argv[index]);
          if (token !== flag && !token.startsWith(`${flag}=`)) continue;
          const inline = token !== flag;
          const value = inline ? token.slice(flag.length + 1) : argv[index + 1];
          if (!inline && !acceptsAdjacent(value)) return fallback;
          if (nonEmpty.has(flag) && !String(value).trim()) throw new Error(`${flag} requires a non-empty value`);
          return value;
        }
      }
      return fallback;
    },
  };
}

function parseAllCli(argv) {
  const known = new Set(ALL_FLAGS), consumed = new Set();
  const name = (token) => String(token).split("=", 1)[0];
  const accepts = (value) => value !== undefined && !String(value).startsWith("-");
  argv.forEach((token, index) => {
    const flag = name(token);
    if (known.has(flag) && ALL_VALUE_FLAGS.has(flag) && !String(token).includes("=") && accepts(argv[index + 1])) {
      consumed.add(index + 1);
    }
  });
  const unknown = argv.filter((token, index) => !consumed.has(index)
    && String(token).startsWith("-") && !known.has(name(token)));
  if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  if (argv.some((token, index) => !consumed.has(index) && !String(token).startsWith("-"))) {
    throw new Error("unexpected positional arguments");
  }
  return {
    hasFlag(flag) {
      return argv.some((token, index) => !consumed.has(index)
        && (token === flag || String(token).startsWith(`${flag}=`)));
    },
    getArg(flag, fallback) {
      for (let index = 0; index < argv.length; index += 1) {
        if (consumed.has(index)) continue;
        const token = String(argv[index]);
        if (token !== flag && !token.startsWith(`${flag}=`)) continue;
        const value = token === flag ? argv[index + 1] : token.slice(flag.length + 1);
        if (token === flag && !accepts(value)) throw new Error(`${flag} requires a non-empty value`);
        if (!String(value).trim()) throw new Error(`${flag} requires a non-empty value`);
        return value;
      }
      return fallback;
    },
  };
}
const modeLabel = (flag) => CLI_OPTIONS.booleanFlags.includes(flag) ? "[boolean]" : "[value]";

function usage() {
  return [
    "Usage: relay-status.js --repo <path> (--run-id <id> | --issue <number>) [--json]",
    "",
    "Inspect the canonical Relay run ledger without mutating it.",
    "",
    `  --repo <path>  ${modeLabel("--repo", CLI_OPTIONS)} Repository checkout (default: .)`,
    `  --run-id <id>  ${modeLabel("--run-id", CLI_OPTIONS)} Relay run identifier`,
    `  --issue <n>    ${modeLabel("--issue", CLI_OPTIONS)} Select an unambiguous issue run`,
    `  --json         ${modeLabel("--json", CLI_OPTIONS)} Output JSON`,
  ].join("\n");
}

function allUsage() {
  return [
    "Usage: relay-status.js --all [--gc] [--apply] [--min-age-days <n>] [--json]",
    "",
    "List all non-terminal v3 runs from durable local state.",
    "",
    "  --gc                List retained-worktree GC candidates (dry-run by default)",
    "  --apply             Apply eligible GC removals; requires --gc",
    `  --min-age-days <n>  Terminal worktree age threshold (default: ${DEFAULT_MIN_AGE_DAYS})`,
    "  --json              Output JSON",
  ].join("\n");
}

function git(repo, argv) {
  return execFileSync(process.env.RELAY_GIT_BIN || "git", ["-C", repo, ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function canonicalRepoRoot(repo) {
  const checkout = fs.realpathSync(path.resolve(repo));
  const common = git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return fs.realpathSync(path.dirname(fs.realpathSync(path.resolve(checkout, common))));
}

function repoSlug(repoRoot) {
  const base = path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  return `${base}-${crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 8)}`;
}

function runsDirectory(repoRoot) {
  const relayHome = path.resolve(process.env.RELAY_HOME || path.join(os.homedir(), ".relay"));
  return path.join(process.env.RELAY_RUNS_BASE || path.join(relayHome, "runs"), repoSlug(repoRoot));
}

function readRunCandidates(repoRoot) {
  const directory = runsDirectory(repoRoot);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))
    .filter((runDir) => fs.existsSync(path.join(runDir, "run.json")))
    .map((runDir) => ({ runDir, record: runStore.readRunRecord({ runDir }) }))
    .filter(({ record }) => record.repo.root === repoRoot)
    .sort((left, right) => left.record.created_at.localeCompare(right.record.created_at));
}

function issueMatches(record, issueNumber) {
  const prefix = `issue-${issueNumber}`;
  return record.run_id === prefix
    || record.run_id.startsWith(`${prefix}-`)
    || record.git.branch === prefix
    || record.git.branch.startsWith(`${prefix}-`);
}

async function selectIssueRuns(repoRoot, issueNumber, inspect = inspectProductionRun) {
  const candidates = readRunCandidates(repoRoot).filter(({ record }) => issueMatches(record, issueNumber));
  const inspected = await Promise.all(candidates.map(async ({ runDir, record }) => ({
    runDir,
    record,
    inspection: await inspect({ runDir }),
  })));
  const active = inspected.filter(({ inspection }) => inspection.derived?.terminal !== true);
  const selected = active.length > 1 ? null : active[0] || inspected.at(-1) || null;
  return {
    issue: issueNumber,
    selected_run_id: selected?.record.run_id || null,
    selection_reason: active.length === 1
      ? "single_active_run"
      : active.length > 1
        ? "multiple_active_runs"
        : inspected.length === 1
          ? "single_terminal_or_closed_run"
          : inspected.length > 1
            ? "multiple_terminal_or_closed_runs"
            : "no_run",
    candidates: inspected.map(({ runDir, record, inspection }) => ({
      run_id: record.run_id,
      phase: inspection.derived?.phase || "unknown",
      action: inspection.recommended_action?.kind || inspection.derived?.action || "unknown",
      terminal: inspection.derived?.terminal === true,
      run_path: path.join(runDir, "run.json"),
      created_at: record.created_at,
    })),
  };
}

function resolveRunById(repoRoot, runId) {
  const matches = readRunCandidates(repoRoot).filter(({ record }) => record.run_id === runId);
  if (matches.length !== 1) throw new Error(matches.length ? `run id is ambiguous: ${runId}` : `Relay run not found: ${runId}`);
  return matches[0];
}

function statusRow(record, runDir, inspection) {
  const derived = inspection.derived || {};
  const action = inspection.recommended_action || {};
  const reviews = (inspection.facts || []).filter((fact) => fact.type === "review_recorded");
  const matchingReview = derived.review_event_id
    ? reviews.find((fact) => fact.event_id === derived.review_event_id) || null
    : reviews.at(-1)?.payload?.reviewed_sha === derived.reviewed_sha ? reviews.at(-1) : null;
  return {
    run_id: record.run_id,
    run_path: path.join(runDir, "run.json"),
    branch: record.git.branch,
    phase: derived.phase || "unknown",
    action: action.kind || derived.action || "unknown",
    reason: action.reason || derived.reason || null,
    blockers: inspection.blockers || [],
    pr_number: derived.pr_number || inspection.observations?.github?.pr_number || null,
    head_sha: derived.head_sha || null,
    reviewed_sha: derived.reviewed_sha || null,
    local_delivery: (derived.terminal === true && derived.reason === "reviewed_result_ready")
      || inspection.observations?.git?.local_delivery === true,
    review_verdict: matchingReview?.payload?.verdict || null,
    review_artifact: matchingReview?.payload?.review_artifact || null,
    terminal: derived.terminal === true,
    action_key: action.key || null,
  };
}

function formatText(row) {
  const lines = [
    `Run: ${row.run_id}`,
    `Phase: ${row.phase}`,
    `Action: ${row.action}${row.reason ? ` (${row.reason})` : ""}`,
    `PR: ${row.pr_number ? `#${row.pr_number}` : "none"}`,
    `Local delivery: ${row.local_delivery ? "yes" : "no"}`,
    `Reviewed SHA: ${row.reviewed_sha || "none"}`,
    `Review verdict: ${row.review_verdict || "none"}`,
    `Review artifact: ${row.review_artifact || "none"}`,
  ];
  for (const blocker of row.blockers) lines.push(`Blocker: ${blocker.code}: ${blocker.message}`);
  return lines.join("\n");
}

function mainAll(argv) {
  const cli = parseAllCli(argv);
  if (!cli.hasFlag("--all")) throw new Error("--all is required for cockpit mode");
  if (cli.hasFlag("--help") || cli.hasFlag("-h")) {
    console.log(allUsage());
    return 0;
  }
  if (cli.hasFlag("--apply") && !cli.hasFlag("--gc")) throw new Error("--apply requires --gc");
  const suppliedAge = cli.getArg("--min-age-days");
  const minAgeDays = Number(suppliedAge ?? DEFAULT_MIN_AGE_DAYS);
  if (!Number.isFinite(minAgeDays) || minAgeDays < 0) throw new Error("--min-age-days must be a non-negative number");
  const nowMs = Date.now();
  const scan = scanAllRuns({ nowMs });
  const legacy = legacySummaries(scan.legacyBySlug);
  const payload = {
    schema_version: 1,
    mode: "all",
    relay_home: scan.relayHome,
    generated_at: new Date(nowMs).toISOString(),
    summary: { non_terminal: scan.rows.length, terminal: scan.terminalRows.length, legacy: legacy.reduce((sum, row) => sum + row.count, 0), legacy_slugs: legacy.length },
    runs: scan.rows.map(publicRunRow),
    terminal_runs: scan.terminalRows.map(publicRunRow),
    legacy,
    diagnostics: scan.diagnostics,
  };
  if (cli.hasFlag("--gc")) {
    const candidates = worktreeCandidates(scan, { minAgeDays, nowMs });
    if (cli.hasFlag("--apply")) {
      for (const candidate of candidates) applyGcCandidate(candidate, scan, { minAgeDays, nowMs });
    }
    payload.gc = {
      apply: cli.hasFlag("--apply"),
      min_age_days: minAgeDays,
      candidates,
      summary: {
        total: candidates.length,
        eligible: candidates.filter((row) => row.eligible).length,
        removed: candidates.filter((row) => row.applied).length,
        manual: candidates.filter((row) => !row.eligible).length,
      },
    };
  }
  console.log(cli.hasFlag("--json") ? JSON.stringify(payload, null, 2) : formatAllText(payload));
  return 0;
}

async function main(argv = args) {
  if (argv.some((token) => String(token).split("=", 1)[0] === "--all")) return mainAll(argv);
  const cli = parseCli(argv);
  if (!argv.length || cli.hasFlag(["--help", "-h"])) {
    console.log(usage());
    return cli.hasFlag(["--help", "-h"]) ? 0 : 1;
  }
  const runId = cli.getArg("--run-id");
  const issueArg = cli.getArg("--issue");
  if (Boolean(runId) === Boolean(issueArg)) throw new Error("exactly one of --run-id or --issue is required");
  const repoRoot = canonicalRepoRoot(cli.getArg("--repo", "."));
  let selection = null;
  let selectedRunId = runId;
  if (issueArg) {
    const issue = Number(issueArg);
    if (!Number.isInteger(issue) || issue < 1) throw new Error("--issue must be a positive integer");
    selection = await selectIssueRuns(repoRoot, issue);
    selectedRunId = selection.selected_run_id;
    if (!selectedRunId) {
      const payload = { ok: selection.selection_reason === "no_run", selection, row: null };
      console.log(cli.hasFlag("--json") ? JSON.stringify(payload, null, 2) : `Issue: #${issue}\nSelection: ${selection.selection_reason}`);
      return selection.selection_reason === "multiple_active_runs" ? 1 : 0;
    }
  }
  const { runDir, record } = resolveRunById(repoRoot, selectedRunId);
  const row = statusRow(record, runDir, await inspectProductionRun({ runDir }));
  const payload = { ok: true, ...(selection ? { selection } : {}), row };
  console.log(cli.hasFlag("--json") ? JSON.stringify(payload, null, 2) : `${formatText(row)}${selection ? `\nSelection: ${selection.selection_reason}` : ""}`);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`relay-status: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  applyGcCandidate,
  canonicalRepoRoot,
  durableClassification,
  main,
  mainAll,
  parseAllCli,
  readRunCandidates,
  resolveRunById,
  runsDirectory,
  scanAllRuns,
  selectIssueRuns,
  statusRow,
  worktreeCandidates,
};
