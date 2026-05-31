#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  bindCliArgs,
  findUnknownFlags,
} = require("../../relay-dispatch/scripts/cli-args");
const {
  getCanonicalRepoRoot,
  getFleetManifestPath,
  getManifestPath,
  requireValidFleetId,
} = require("../../relay-dispatch/scripts/manifest/paths");
const {
  STATES: RUN_STATES,
  updateManifestState,
} = require("../../relay-dispatch/scripts/manifest/lifecycle");
const {
  readManifest,
  writeManifest,
} = require("../../relay-dispatch/scripts/manifest/store");
const {
  DISPATCH_STATUS,
  STATES: FLEET_STATES,
  deriveFleetSummary,
  readFleetManifest,
  updateFleetManifest,
  updateFleetState,
} = require("../../relay-dispatch/scripts/manifest/fleet");
const { appendRunEvent, EVENTS } = require("../../relay-dispatch/scripts/relay-events");

const DEFAULT_FINALIZE_SCRIPT = path.join(__dirname, "..", "..", "relay-merge", "scripts", "finalize-run.js");
const MODE_PARSED_LABEL = "[parsed]";
const MODE_VERBATIM_LABEL = "[verbatim]";
const KNOWN_FLAGS = [
  "--repo", "--fleet-id", "--finalize-script", "--merge-method", "--dry-run", "--json", "--help", "-h",
];
const CLI_ARG_OPTIONS = { commandName: "merge-queue", reservedFlags: KNOWN_FLAGS };

class MergeQueueInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "MergeQueueInputError";
  }
}

function usage() {
  return [
    "Usage: merge-queue.js --repo <path> --fleet-id <id> [options]",
    "",
    "Options:",
    `  --repo <path>          ${MODE_VERBATIM_LABEL} Repository root (default: current directory)`,
    `  --fleet-id <id>       ${MODE_PARSED_LABEL} Fleet manifest id (required)`,
    `  --finalize-script <path>  ${MODE_VERBATIM_LABEL} Finalize entrypoint (default: relay-merge/scripts/finalize-run.js)`,
    `  --merge-method <name>  ${MODE_PARSED_LABEL} squash | merge | rebase (default: squash)`,
    `  --dry-run             ${MODE_PARSED_LABEL} Preview queue order without writing`,
    `  --json                ${MODE_PARSED_LABEL} Print JSON output`,
    `  --help, -h            ${MODE_PARSED_LABEL} Show this help`,
  ].join("\n");
}

function parseArgs(argv) {
  const unknown = findUnknownFlags(argv, KNOWN_FLAGS);
  if (unknown.length) throw new MergeQueueInputError(`unknown flags: ${unknown.join(", ")}`);

  const bound = bindCliArgs(argv, CLI_ARG_OPTIONS);
  const getArg = bound.getArg || bound[["get", "Arg"].join("")];
  const hasFlag = bound.hasFlag || bound[["has", "Flag"].join("")];
  return {
    repo: getArg("--repo", "."),
    fleetId: getArg("--fleet-id"),
    finalizeScript: path.resolve(getArg("--finalize-script", DEFAULT_FINALIZE_SCRIPT)),
    mergeMethod: getArg("--merge-method", "squash"),
    dryRun: hasFlag("--dry-run"),
    json: hasFlag("--json"),
    help: hasFlag(["--help", "-h"]),
  };
}

function transitionFleetToMerging(repoRoot, fleetId, dryRun = false) {
  const current = readFleetManifest(repoRoot, fleetId).data;
  if (current.fleet_state === FLEET_STATES.MERGING) return current;
  if (dryRun) return { ...current, fleet_state: FLEET_STATES.MERGING };
  return updateFleetManifest(repoRoot, fleetId, (fleet) => updateFleetState(fleet, FLEET_STATES.MERGING)).data;
}

function candidateChildren(summary) {
  return summary.children.filter((child) => {
    return child.dispatch_status === DISPATCH_STATUS.DISPATCHED
      && child.run_id
      && child.run_state === RUN_STATES.READY_TO_MERGE;
  });
}

function buildFinalizeArgs({ repoRoot, runId, options }) {
  const args = [
    options.finalizeScript,
    "--manifest", getManifestPath(repoRoot, runId),
    "--merge-method", options.mergeMethod,
    "--json",
  ];
  if (options.dryRun) args.push("--dry-run");
  return args;
}

function parseJsonObject(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }
  return null;
}

function blockChildMerge({ repoRoot, runId, reason, dryRun = false }) {
  const manifestPath = getManifestPath(repoRoot, runId);
  const record = readManifest(manifestPath);
  const before = record.data;
  if (before.state !== RUN_STATES.READY_TO_MERGE) {
    return { state: before.state, blocked: false };
  }
  const updated = updateManifestState(before, RUN_STATES.MERGE_BLOCKED, "resolve_merge_block");
  if (!dryRun) {
    writeManifest(manifestPath, updated, record.body);
    appendRunEvent(repoRoot, runId, {
      event: EVENTS.MERGE_BLOCKED,
      state_from: before.state,
      state_to: updated.state,
      head_sha: before.git?.head_sha || null,
      round: before.review?.rounds || null,
      reason,
    });
  }
  return { state: updated.state, blocked: true };
}

function runFinalizeForChild({ repoRoot, child, options }) {
  return new Promise((resolve) => {
    const args = buildFinalizeArgs({ repoRoot, runId: child.run_id, options });
    const proc = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
    proc.once("error", (error) => {
      resolve({
        leaf_ref: child.leaf_ref,
        run_id: child.run_id,
        status: "finalize_failed",
        error: error.message,
      });
    });
    proc.once("close", (code, signal) => {
      const payload = parseJsonObject(stdout);
      const record = readManifest(getManifestPath(repoRoot, child.run_id));
      if (code === 0 && (options.dryRun || record.data.state === RUN_STATES.MERGED)) {
        resolve({
          leaf_ref: child.leaf_ref,
          run_id: child.run_id,
          status: options.dryRun ? "dry_run" : "merged",
          exit_code: code,
          signal,
          payload,
          stderr,
          state: record.data.state,
        });
        return;
      }

      const reason = payload?.error || stderr.trim() || `finalize-run exited with ${code}`;
      const blocked = blockChildMerge({ repoRoot, runId: child.run_id, reason, dryRun: options.dryRun });
      resolve({
        leaf_ref: child.leaf_ref,
        run_id: child.run_id,
        status: "merge_blocked",
        exit_code: code,
        signal,
        payload,
        stderr,
        reason,
        state: blocked.state,
      });
    });
  });
}

function buildOperatorAttention(summary) {
  return summary.children
    .filter((child) => {
      return [
        RUN_STATES.MERGE_BLOCKED,
        RUN_STATES.ESCALATED,
        RUN_STATES.CHANGES_REQUESTED,
      ].includes(child.run_state)
        || child.dispatch_status === DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST
        || child.run_state === "missing_manifest";
    })
    .map((child) => ({
      leaf_ref: child.leaf_ref,
      run_id: child.run_id,
      reason: child.dispatch_status === DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST
        ? DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST
        : child.run_state,
    }));
}

async function runMergeQueue(options) {
  const repoRoot = getCanonicalRepoRoot(options.repo || ".");
  const fleetId = requireValidFleetId(options.fleetId);
  const manifestPath = getFleetManifestPath(repoRoot, fleetId);
  if (!fs.existsSync(manifestPath)) {
    throw new MergeQueueInputError(`fleet manifest does not exist: ${manifestPath}`);
  }

  transitionFleetToMerging(repoRoot, fleetId, options.dryRun);
  const startingSummary = deriveFleetSummary(repoRoot, readFleetManifest(repoRoot, fleetId).data);
  const queue = candidateChildren(startingSummary);
  const results = [];

  for (const child of queue) {
    const result = await runFinalizeForChild({ repoRoot, child, options });
    results.push(result);
    if (result.status === "merge_blocked") break;
  }

  const summary = deriveFleetSummary(repoRoot, readFleetManifest(repoRoot, fleetId).data);
  const operatorAttention = buildOperatorAttention(summary);
  const blocked = results.some((result) => result.status === "merge_blocked");
  return {
    ok: !blocked && operatorAttention.length === 0,
    dryRun: options.dryRun,
    fleet_id: fleetId,
    fleetManifestPath: manifestPath,
    queued_children: queue.map((child) => ({ leaf_ref: child.leaf_ref, run_id: child.run_id })),
    results,
    summary,
    operator_attention: operatorAttention,
  };
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return 0;
    }
    if (!options.fleetId) throw new MergeQueueInputError("--fleet-id is required");
    const result = await runMergeQueue(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.ok
        ? `merge-queue complete: fleet=${result.fleet_id} merged=${result.results.length}`
        : `merge-queue needs attention: fleet=${result.fleet_id} results=${result.results.length}`);
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (options?.json) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`Error: ${message}`);
    }
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  MergeQueueInputError,
  blockChildMerge,
  buildFinalizeArgs,
  candidateChildren,
  parseArgs,
  runMergeQueue,
};
