#!/usr/bin/env node
"use strict";

/** Relay fleet: one immutable cohort plus a read-only view of child runs. */

const { spawn } = require("node:child_process");
const path = require("node:path");
const { parseArgs: parseNodeArgs } = require("node:util");

const {
  FleetInputError,
  deriveFleet,
  fail,
  getFleetLeavesStorePath,
  loadLeavesFile,
  readCohort,
  repositoryIdentity,
  scanChildren,
  validId,
  verifyLeafArtifacts,
  writeCohortExclusive,
} = require("./relay-fleet-helpers");

const DEFAULT_PARALLEL = 4;
const DEFAULT_DISPATCH_SCRIPT = path.join(__dirname, "..", "..", "relay-dispatch", "scripts", "dispatch.js");
const DEFAULT_REVIEW_SCRIPT = path.join(__dirname, "..", "..", "relay-review", "scripts", "review-runner.js");
const DEFAULT_FINALIZE_SCRIPT = path.join(__dirname, "..", "..", "relay-merge", "scripts", "finalize-run.js");
const OPTIONS = Object.freeze({
  repo: { type: "string", default: "." },
  "fleet-id": { type: "string" },
  "leaves-file": { type: "string" },
  status: { type: "boolean", default: false },
  review: { type: "boolean", default: false },
  parallel: { type: "string", default: String(DEFAULT_PARALLEL) },
  "dispatch-script": { type: "string", default: DEFAULT_DISPATCH_SCRIPT },
  "review-script": { type: "string", default: DEFAULT_REVIEW_SCRIPT },
  "finalize-script": { type: "string", default: DEFAULT_FINALIZE_SCRIPT },
  executor: { type: "string" }, model: { type: "string" },
  "network-access": { type: "string" }, timeout: { type: "string" }, reasoning: { type: "string" },
  copy: { type: "string" },
  reviewer: { type: "string" }, "reviewer-model": { type: "string" },
  "merge-method": { type: "string", default: "squash" },
  "dry-run": { type: "boolean", default: false }, json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
});

function parseArgs(argv) {
  let parsed;
  try { parsed = parseNodeArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true }); }
  catch (error) { fail(error.message); }
  const parallel = Number(parsed.values.parallel);
  if (!Number.isInteger(parallel) || parallel < 1) fail("--parallel must be a positive integer");
  return {
    repo: parsed.values.repo, fleetId: parsed.values["fleet-id"], leavesFile: parsed.values["leaves-file"], status: parsed.values.status,
    review: parsed.values.review, parallel, dispatchScript: path.resolve(parsed.values["dispatch-script"]), reviewScript: path.resolve(parsed.values["review-script"]),
    finalizeScript: path.resolve(parsed.values["finalize-script"]), executor: parsed.values.executor, model: parsed.values.model,
    networkAccess: parsed.values["network-access"], timeout: parsed.values.timeout, reasoning: parsed.values.reasoning, copy: parsed.values.copy,
    reviewer: parsed.values.reviewer, reviewerModel: parsed.values["reviewer-model"], mergeMethod: parsed.values["merge-method"],
    dryRun: parsed.values["dry-run"], json: parsed.values.json, help: parsed.values.help,
  };
}
function push(args, flag, value) { if (value != null && value !== "") args.push(flag, String(value)); }
function buildDispatchArgs({ repoRoot, fleetId, leaf, options, runId = null }) {
  const args = [options.dispatchScript, repoRoot, ...(runId ? ["--run-id", runId] : ["--branch", leaf.branch]), "--issue-number", String(leaf.issue_number), "--prompt-file", leaf.prompt_file, "--rubric-file", leaf.rubric_file, "--done-criteria-file", leaf.done_criteria_file, "--fleet-id", fleetId, "--ownership-json", JSON.stringify(leaf.ownership), "--json"];
  push(args, "--executor", leaf.executor || options.executor); push(args, "--model", leaf.model || options.model);
  push(args, "--network-access", leaf.network_access || options.networkAccess);
  push(args, "--timeout", leaf.timeout || options.timeout); push(args, "--reasoning", leaf.reasoning || options.reasoning); push(args, "--copy", leaf.copy || options.copy);
  if (options.dryRun) args.push("--dry-run");
  return args;
}
function buildReviewArgs(repoRoot, runId, options) {
  const args = [options.reviewScript, "--repo", repoRoot, "--run-id", runId, "--json"];
  push(args, "--reviewer", options.reviewer); push(args, "--model", options.reviewerModel); return args;
}
function buildFinalizeArgs(repoRoot, runId, options) {
  const args = [options.finalizeScript, "--repo", repoRoot, "--run-id", runId, "--merge-method", options.mergeMethod, "--json"];
  if (options.dryRun) args.push("--dry-run"); return args;
}
function runChild(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => done({ ok: false, error: error.message, stdout, stderr }));
    child.once("close", (code, signal) => done({ ok: code === 0, exit_code: code, signal, stdout, stderr }));
  });
}
async function pool(values, limit, work) {
  const results = []; let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) { const index = cursor++; results[index] = await work(values[index]); }
  }));
  return results;
}
async function dispatchDerived(repoRoot, fleetId, summary, cohort, options) {
  const leaves = new Map(cohort.leaves.map((leaf) => [leaf.leaf_ref, leaf]));
  const targets = summary.children.filter((child) => child.action === "dispatch" || child.action === "redispatch");
  return pool(targets, options.parallel, async (child) => {
    const leaf = leaves.get(child.leaf_ref); verifyLeafArtifacts(leaf);
    const runId = child.action === "redispatch" ? child.run_id : null;
    return { leaf_ref: leaf.leaf_ref, mode: runId ? "resume" : "new", ...(runId ? { run_id: runId } : {}), ...(await runChild(buildDispatchArgs({ repoRoot, fleetId, leaf, options, runId }), repoRoot)) };
  });
}
async function reviewDerived(repoRoot, summary, options) {
  return pool(summary.children.filter((child) => child.action === "review"), options.parallel, async (child) => ({ leaf_ref: child.leaf_ref, run_id: child.run_id, ...(await runChild(buildReviewArgs(repoRoot, child.run_id, options), repoRoot)) }));
}
async function mergeDerived(repoRoot, summary, options) {
  const results = [];
  for (const child of summary.children.filter((candidate) => candidate.action === "merge")) {
    const result = { leaf_ref: child.leaf_ref, run_id: child.run_id, ...(await runChild(buildFinalizeArgs(repoRoot, child.run_id, options), repoRoot)) };
    results.push(result); if (!result.ok) break;
  }
  return results;
}
async function runFleet(options) {
  const identity = repositoryIdentity(options.repo || ".");
  const fleetId = validId(options.fleetId, "--fleet-id");
  const services = options.services || {};
  if (options.status) return { ok: true, ...(await deriveFleet(identity.repoRoot, fleetId, null, services)) };
  const proposed = options.leavesFile ? loadLeavesFile(identity.repoRoot, options.leavesFile) : null;
  const ephemeral = options.dryRun && proposed ? { store: null, leaves: proposed } : null;
  if (proposed && !options.dryRun) writeCohortExclusive(identity.repoRoot, fleetId, proposed);
  const cohort = ephemeral || readCohort(identity.repoRoot, fleetId);
  let summary = await deriveFleet(identity.repoRoot, fleetId, cohort, services);
  if (summary.operator_attention.length) return { ok: false, ...summary, dispatch: [], review: [], merge: [] };
  const dispatch = await dispatchDerived(identity.repoRoot, fleetId, summary, cohort, options);
  if (options.dryRun) return { ok: dispatch.every((item) => item.ok), dry_run: true, ...summary, dispatch, review: [], merge: [] };
  summary = await deriveFleet(identity.repoRoot, fleetId, cohort, services);
  const review = options.review ? await reviewDerived(identity.repoRoot, summary, options) : [];
  if (options.review) summary = await deriveFleet(identity.repoRoot, fleetId, cohort, services);
  const merge = options.review ? await mergeDerived(identity.repoRoot, summary, options) : [];
  summary = await deriveFleet(identity.repoRoot, fleetId, cohort, services);
  return { ok: summary.operator_attention.length === 0 && dispatch.every((item) => item.ok) && review.every((item) => item.ok) && merge.every((item) => item.ok), ...summary, dispatch, review, merge };
}
function usage() { return "Usage: relay-fleet.js --repo <path> --fleet-id <id> [--leaves-file <path>] [--status | --review]"; }
async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv); if (options.help) { console.log(usage()); return 0; }
    if (!options.fleetId) fail("--fleet-id is required");
    if (options.status && (options.leavesFile || options.review || options.dryRun)) fail("--status is read-only and cannot be combined with write/drive flags");
    const result = await runFleet(options);
    if (options.json) console.log(JSON.stringify(result, null, 2)); else console.log(result.ok ? `relay-fleet complete: fleet=${result.fleet_id} children=${result.total_children}` : `relay-fleet needs attention: fleet=${result.fleet_id}`);
    return result.ok ? 0 : 1;
  } catch (error) {
    if (options?.json) console.error(JSON.stringify({ ok: false, error: error.message }, null, 2)); else console.error(`Error: ${error.message}`);
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });
module.exports = { FleetInputError, buildDispatchArgs, buildFinalizeArgs, buildReviewArgs, deriveFleet, getFleetLeavesStorePath, loadLeavesFile, main, parseArgs, readCohort, runFleet, scanChildren, writeCohortExclusive };
