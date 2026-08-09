#!/usr/bin/env node
"use strict";

/** Read-only Relay merge gate. It never records an override or mutates a run. */

const { parseArgs } = require("util");

const { inspectProductionRun } = require("../../relay-dispatch/scripts/recover");
const { requireMergeAction, resolveRun } = require("./review-gate");

const OPTIONS = Object.freeze({
  repo: { type: "string" },
  "run-dir": { type: "string" },
  "run-id": { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
});

function usage() {
  return [
    "Usage: gate-check.js --repo <path> (--run-id <id> | --run-dir <path>) [--json]",
    "",
    "Read the canonical Relay inspection and require an exact-SHA passing review.",
    "This command is read-only. Review bypasses are not part of the Relay merge contract.",
  ].join("\n");
}

function parseCli(argv) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); }
  catch (error) {
    const unknown = /^Unknown option ['\"]?([^'\"]+)['\"]?/.exec(error.message);
    if (unknown) error.message = `unknown flag: ${unknown[1]}`;
    error.code = "MERGE_USAGE";
    throw error;
  }
  if (parsed.values.help) return { help: true, values: parsed.values, repo: "." };
  if (parsed.positionals.length > 1) throw Object.assign(new Error("at most one positional repo is allowed"), { code: "MERGE_USAGE" });
  if (parsed.values.repo && parsed.positionals.length) throw Object.assign(new Error("use positional repo or --repo, not both"), { code: "MERGE_USAGE" });
  return { help: false, values: parsed.values, repo: parsed.values.repo || parsed.positionals[0] || "." };
}

async function checkGate(cli, overrides = {}) {
  const inspectRun = overrides.inspectRun || inspectProductionRun;
  const resolved = resolveRun({
    repo: cli.repo,
    runDir: cli.values["run-dir"] || null,
    runId: cli.values["run-id"] || null,
  });
  const inspection = await inspectRun({ runDir: resolved.runDir });
  const binding = requireMergeAction(inspection, resolved.record);
  return {
    ready_to_merge: true,
    run_id: resolved.record.run_id,
    pr_number: binding.prNumber,
    reviewed_sha: binding.head,
    done_criteria_sha256: resolved.record.contract.done_criteria_sha256,
    reviewer: binding.review.payload.reviewer,
    action_key: inspection.recommended_action.key,
  };
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv);
  if (cli.help) {
    console.log(usage());
    return 0;
  }
  const result = await checkGate(cli);
  console.log(cli.values.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  return 0;
}

if (require.main === module) {
  main().catch((error) => {
    const payload = { ok: false, code: error.code || "MERGE_GATE_FAILED", error: error.message };
    console.error(process.argv.includes("--json") ? JSON.stringify(payload) : `Error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { checkGate, main, parseCli, usage };
