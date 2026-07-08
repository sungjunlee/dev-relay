#!/usr/bin/env node
"use strict";

const path = require("path");

const {
  bindCliArgs,
  findUnknownFlags,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const { getCanonicalRepoRoot } = require("../../relay-dispatch/scripts/manifest/paths");
const { listManifestRecords } = require("../../relay-dispatch/scripts/manifest/store");
const { isTerminalState } = require("../../relay-dispatch/scripts/manifest/lifecycle");
const { observeRun } = require("../../relay-dispatch/scripts/run-observer");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--run-id", "--issue", "--json", "--help", "-h"];
const CLI_ARG_OPTIONS = { commandName: "relay-status", reservedFlags: KNOWN_FLAGS };
const cliArgs = bindCliArgs(args, CLI_ARG_OPTIONS);

function hasCliFlag(flag) {
  return cliArgs.hasFlag(flag);
}

function usage() {
  return [
    "Usage: relay-status.js --repo <path> (--run-id <id> | --issue <number>) [--json]",
    "",
    "Print read-only operational status for a relay run or issue.",
    "",
    "Options:",
    `  --repo <path>  ${modeLabel("--repo")} Repository root (default: .)`,
    `  --run-id <id>  ${modeLabel("--run-id")} Relay run identifier`,
    `  --issue <n>    ${modeLabel("--issue")} GitHub issue number`,
    `  --json         ${modeLabel("--json")} Output JSON`,
    `  --help, -h     ${modeLabel("--help")} Show help`,
  ].join("\n");
}

function manifestIssueNumber(record) {
  const value = Number(record?.data?.issue?.number);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function selectIssueRuns(repoRoot, issueNumber) {
  const candidates = listManifestRecords(repoRoot)
    .filter((record) => manifestIssueNumber(record) === issueNumber);
  const active = candidates.filter((record) => !isTerminalState(record.data?.state));
  const ambiguousActive = active.length > 1;
  const selected = ambiguousActive ? null : active[0] || candidates[0] || null;
  return {
    issue: issueNumber,
    selected_run_id: selected?.data?.run_id || null,
    selection_reason: active.length === 1
      ? "single_active_run"
      : active.length > 1
      ? "multiple_active_runs"
      : candidates.length === 1
      ? "single_terminal_or_closed_run"
      : candidates.length > 1
      ? "multiple_terminal_or_closed_runs"
      : "no_run",
    candidates: candidates.map((record) => ({
      run_id: record.data?.run_id || path.basename(record.manifestPath, ".md"),
      state: record.data?.state || "unknown",
      manifest_path: record.manifestPath,
      updated_at: record.data?.timestamps?.updated_at || null,
    })),
  };
}

function formatRow(row) {
  return [
    `Run: ${row.run_id}`,
    `State: ${row.state}`,
    `Lease: ${row.lease.status || "unknown"}, elapsed ${row.lease.elapsed_s ?? "?"}s, remaining ${row.lease.remaining_s ?? "?"}s`,
    `Output: ${row.logs.last_output_at ? `silent for ${row.logs.silent_for_s}s` : "no output observed"}`,
    `Worktree: ${row.worktree.exists ? "exists" : "missing"}, reviewable=${row.worktree.reviewable_dirt}, commits=${row.worktree.new_commits}`,
    `PR: ${row.pr.number ? `#${row.pr.number} ${row.pr.state}` : row.pr.lookup_status}`,
    `Classification: ${row.classification}`,
    `Next: ${row.next_action.kind}`,
    `Command: ${row.next_action.command}`,
  ].join("\n");
}

function formatIssueNoRun(selection) {
  if (selection.selection_reason === "multiple_active_runs") {
    return [
      `Issue: #${selection.issue}`,
      "Run: ambiguous",
      "Selection: multiple_active_runs",
      `Candidates: ${selection.candidates.map((candidate) => candidate.run_id).join(", ")}`,
      "Next: pass --run-id for the intended run",
    ].join("\n");
  }
  return [
    `Issue: #${selection.issue}`,
    "Run: none",
    `Selection: ${selection.selection_reason}`,
    "Next: dispatch or inspect issue manually",
  ].join("\n");
}

function main() {
  if (!args.length || hasCliFlag(["--help", "-h"])) {
    console.log(usage());
    process.exit(hasCliFlag(["--help", "-h"]) ? 0 : 1);
  }
  const unknownFlags = findUnknownFlags(args, KNOWN_FLAGS);
  if (unknownFlags.length) throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  const repo = cliArgs.getArg("--repo", ".");
  const runId = cliArgs.getArg("--run-id");
  const issueArg = cliArgs.getArg("--issue");
  if ((runId && issueArg) || (!runId && !issueArg)) {
    throw new Error("exactly one of --run-id or --issue is required");
  }
  const repoRoot = getCanonicalRepoRoot(path.resolve(repo));
  if (runId) {
    const row = observeRun({ repo: repoRoot, runId });
    console.log(hasCliFlag("--json") ? JSON.stringify({ ok: true, row }, null, 2) : formatRow(row));
    return;
  }
  const issueNumber = Number(issueArg);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error("--issue must be a positive integer");
  const selection = selectIssueRuns(repoRoot, issueNumber);
  if (!selection.selected_run_id) {
    console.log(hasCliFlag("--json") ? JSON.stringify({ ok: true, selection, row: null }, null, 2) : formatIssueNoRun(selection));
    return;
  }
  const row = observeRun({ repo: repoRoot, runId: selection.selected_run_id });
  const payload = { ok: true, selection, row };
  console.log(hasCliFlag("--json") ? JSON.stringify(payload, null, 2) : `${formatRow(row)}\nSelection: ${selection.selection_reason}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`relay-status: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  selectIssueRuns,
};
