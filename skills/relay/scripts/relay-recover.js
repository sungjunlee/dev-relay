#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

const {
  bindCliArgs,
  findUnknownFlags,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const { getCanonicalRepoRoot } = require("../../relay-dispatch/scripts/manifest/paths");
const { observeRun } = require("../../relay-dispatch/scripts/run-observer");
const { selectIssueRuns } = require("./relay-status");

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--repo", "--run-id", "--issue", "--apply", "--dry-run", "--json", "--help", "-h"];
const CLI_ARG_OPTIONS = { commandName: "relay-recover", reservedFlags: KNOWN_FLAGS };
const cliArgs = bindCliArgs(args, CLI_ARG_OPTIONS);

function hasCliFlag(flag) {
  return cliArgs.hasFlag(flag);
}

function usage() {
  return [
    "Usage: relay-recover.js --repo <path> (--run-id <id> | --issue <number>) [--dry-run | --apply] [--json]",
    "",
    "Choose the safe existing recovery command for a relay run. Defaults to dry-run.",
    "",
    "Options:",
    `  --repo <path>  ${modeLabel("--repo")} Repository root (default: .)`,
    `  --run-id <id>  ${modeLabel("--run-id")} Relay run identifier`,
    `  --issue <n>    ${modeLabel("--issue")} GitHub issue number`,
    `  --dry-run      ${modeLabel("--dry-run")} Print planned command without mutating (default)`,
    `  --apply        ${modeLabel("--apply")} Execute safe delegated recovery`,
    `  --json         ${modeLabel("--json")} Output JSON`,
    `  --help, -h     ${modeLabel("--help")} Show help`,
  ].join("\n");
}

function shellCommand(argv) {
  return argv.map((part) => JSON.stringify(String(part))).join(" ");
}

function planFor(row, repoRoot) {
  const reconcile = [
    process.execPath,
    "skills/relay-dispatch/scripts/reconcile-run.js",
    "--repo", repoRoot,
    "--run-id", row.run_id,
    "--json",
  ];
  const reconcileDryRun = [...reconcile, "--dry-run"];
  if ([
    "running_with_output",
    "running_silent",
    "timed_out_live",
    "dead_with_work",
    "dead_no_work",
    "branch_without_pr",
    "pr_without_manifest_stamp",
  ].includes(row.classification)) {
    return {
      action: "delegate_reconcile",
      safe_to_apply: row.classification !== "running_with_output" && row.classification !== "running_silent",
      command: reconcile,
      dry_run_command: reconcileDryRun,
      reason: row.classification,
    };
  }
  return {
    action: "manual_guidance",
    safe_to_apply: false,
    command: null,
    dry_run_command: null,
    reason: row.classification,
    guidance: row.next_action.command,
  };
}

function resolveRun({ repoRoot, runId, issueArg }) {
  if (runId) return runId;
  const issueNumber = Number(issueArg);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error("--issue must be a positive integer");
  const selection = selectIssueRuns(repoRoot, issueNumber);
  if (selection.selection_reason === "multiple_active_runs") {
    const error = new Error(`multiple active relay runs found for issue #${issueNumber}; pass --run-id`);
    error.selection = selection;
    throw error;
  }
  if (!selection.selected_run_id) {
    const error = new Error(`no relay run found for issue #${issueNumber}`);
    error.selection = selection;
    throw error;
  }
  return selection.selected_run_id;
}

function runCommand(argv, repoRoot) {
  const stdout = execFileSync(argv[0], argv.slice(1), {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

function formatText(result) {
  const lines = [
    `Run: ${result.run_id}`,
    `Classification: ${result.classification}`,
    `Action: ${result.plan.action}`,
    `Safe to apply: ${result.plan.safe_to_apply}`,
  ];
  if (result.plan.dry_run_command) {
    lines.push(`Dry-run: ${shellCommand(result.plan.dry_run_command)}`);
  }
  if (result.plan.command) {
    lines.push(`Apply: ${shellCommand(result.plan.command)}`);
  }
  if (result.plan.guidance) {
    lines.push(`Guidance: ${result.plan.guidance}`);
  }
  if (result.applied) {
    lines.push("Applied: yes");
  }
  return lines.join("\n");
}

function main() {
  if (!args.length || hasCliFlag(["--help", "-h"])) {
    console.log(usage());
    process.exit(hasCliFlag(["--help", "-h"]) ? 0 : 1);
  }
  const unknownFlags = findUnknownFlags(args, KNOWN_FLAGS);
  if (unknownFlags.length) throw new Error(`unknown flags: ${unknownFlags.join(", ")}`);
  const repo = cliArgs.getArg("--repo", ".");
  const runIdArg = cliArgs.getArg("--run-id");
  const issueArg = cliArgs.getArg("--issue");
  const apply = hasCliFlag("--apply");
  if ((runIdArg && issueArg) || (!runIdArg && !issueArg)) {
    throw new Error("exactly one of --run-id or --issue is required");
  }
  const repoRoot = getCanonicalRepoRoot(path.resolve(repo));
  const runId = resolveRun({ repoRoot, runId: runIdArg, issueArg });
  const row = observeRun({ repo: repoRoot, runId });
  const plan = planFor(row, repoRoot);
  const result = {
    ok: true,
    dry_run: !apply,
    applied: false,
    run_id: row.run_id,
    classification: row.classification,
    row,
    plan,
    result: null,
  };
  if (apply) {
    if (!plan.safe_to_apply || !plan.command) {
      throw new Error(`refusing to apply unsafe recovery for ${row.classification}; inspect guidance first`);
    }
    result.result = runCommand(plan.command, repoRoot);
    result.applied = true;
  }
  console.log(hasCliFlag("--json") ? JSON.stringify(result, null, 2) : formatText(result));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`relay-recover: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  planFor,
};
