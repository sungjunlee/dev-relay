#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const runStore = require("../../relay-dispatch/scripts/run-store");
const { inspectProductionRun } = require("../../relay-dispatch/scripts/recover");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--run-id", "--issue", "--json", "--help", "-h"];
const CLI_OPTIONS = {
  reservedFlags: KNOWN_FLAGS,
  booleanFlags: ["--json", "--help", "-h"],
  verbatimValueFlags: ["--repo"],
};
function parseCli(argv) {
  const known = new Set(KNOWN_FLAGS), bool = new Set(CLI_OPTIONS.booleanFlags), verbatim = new Set(CLI_OPTIONS.verbatimValueFlags), consumed = new Set(); const name = (token) => String(token).split("=", 1)[0]; const accepts = (flag, value) => value !== undefined && (verbatim.has(flag) || (!String(value).startsWith("--") && !known.has(String(value))));
  argv.forEach((token, index) => { const flag = name(token); if (known.has(flag) && !bool.has(flag) && !String(token).includes("=") && accepts(flag, argv[index + 1])) consumed.add(index + 1); });
  const unknown = argv.filter((token, index) => !consumed.has(index) && String(token).startsWith("-") && !known.has(name(token))); if (unknown.length) throw new Error(`unknown flags: ${unknown.join(", ")}`);
  const variants = (flag) => Array.isArray(flag) ? flag : [flag]; return { hasFlag: (flags) => variants(flags).some((flag) => argv.some((token, index) => !consumed.has(index) && (token === flag || String(token).startsWith(`${flag}=`)))), getArg: (flags, fallback) => { for (const flag of variants(flags)) for (let index = 0; index < argv.length; index += 1) { if (consumed.has(index)) continue; const token = String(argv[index]); if (token === flag || token.startsWith(`${flag}=`)) { const value = token === flag ? argv[index + 1] : token.slice(flag.length + 1); if (!accepts(flag, value)) return fallback; if (verbatim.has(flag) && !String(value).trim()) throw new Error(`${flag} requires a non-empty value`); return value; } } return fallback; } };
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

async function main(argv = args) {
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
  canonicalRepoRoot,
  main,
  readRunCandidates,
  resolveRunById,
  runsDirectory,
  selectIssueRuns,
  statusRow,
};
