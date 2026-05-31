#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  bindCliArgs,
  findUnknownFlags,
  modeLabel,
} = require("../../relay-dispatch/scripts/cli-args");
const {
  getCanonicalRepoRoot,
  getFleetManifestPath,
  getFleetsDir,
  getManifestPath,
  listManifestPaths,
  requireValidFleetId,
} = require("../../relay-dispatch/scripts/manifest/paths");
const { STATES: RUN_STATES } = require("../../relay-dispatch/scripts/manifest/lifecycle");
const { readManifest } = require("../../relay-dispatch/scripts/manifest/store");
const {
  DISPATCH_STATUS,
  FleetIssueLockError,
  STATES,
  acquireIssueLock,
  createFleetManifest,
  deriveFleetSummary,
  readFleetManifest,
  releaseIssueLock,
  updateFleetManifest,
  updateFleetState,
  upsertFleetChild,
} = require("../../relay-dispatch/scripts/manifest/fleet");

const DEFAULT_PARALLEL = 4;
const DEFAULT_DISPATCH_SCRIPT = path.join(__dirname, "..", "..", "relay-dispatch", "scripts", "dispatch.js");
const DEFAULT_REVIEW_SCRIPT = path.join(__dirname, "..", "..", "relay-review", "scripts", "review-runner.js");
const KNOWN_FLAGS = [
  "--repo", "--fleet-id", "--leaves-file", "--resume", "--status", "--review", "--parallel",
  "--dispatch-script", "--review-script", "--executor", "--model", "--model-hints", "--sandbox",
  "--network-access", "--timeout", "--reasoning", "--copy", "--test-command",
  "--register", "--reviewer", "--reviewer-model", "--dry-run", "--json", "--help", "-h",
];
const CLI_ARG_OPTIONS = { commandName: "relay-fleet", reservedFlags: KNOWN_FLAGS };
const MODE_PARSED_LABEL = "[parsed]";
const MODE_VERBATIM_LABEL = "[verbatim]";

class FleetInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "FleetInputError";
  }
}

function usage() {
  return [
    "Usage: relay-fleet.js --repo <path> --fleet-id <id> --leaves-file <path> [options]",
    "       relay-fleet.js --repo <path> --fleet-id <id> --resume [options]",
    "       relay-fleet.js --repo <path> --fleet-id <id> --review [options]",
    "       relay-fleet.js --repo <path> --fleet-id <id> --status [--json]",
    "",
    "Options:",
    `  --repo <path>          ${modeLabel("--repo")} Repository root (default: current directory)`,
    `  --fleet-id <id>       ${modeLabel("--fleet-id")} Fleet manifest id (required)`,
    `  --leaves-file <path>  ${MODE_VERBATIM_LABEL} JSON file with already-planned leaf contracts`,
    `  --resume             ${MODE_PARSED_LABEL} Reconcile and continue pending/pre-manifest children`,
    `  --review             ${MODE_PARSED_LABEL} Fan out one foreground review-runner.js pass per review_pending child`,
    `  --status             ${MODE_PARSED_LABEL} Print derived fleet summary without writing`,
    `  --parallel <n>       ${MODE_PARSED_LABEL} Maximum concurrent child dispatches (default: ${DEFAULT_PARALLEL})`,
    `  --dispatch-script <path>  ${MODE_VERBATIM_LABEL} Dispatch entrypoint (default: relay-dispatch/scripts/dispatch.js)`,
    `  --review-script <path>    ${MODE_VERBATIM_LABEL} Review entrypoint (default: relay-review/scripts/review-runner.js)`,
    `  --executor <name>     ${modeLabel("--executor")} Child executor passed to dispatch.js`,
    `  --model <name>        ${modeLabel("--model")} Child model override passed to dispatch.js`,
    `  --model-hints <spec>  ${modeLabel("--model-hints")} Child model hints passed to dispatch.js`,
    `  --sandbox <mode>      ${modeLabel("--sandbox")} Child sandbox passed to dispatch.js`,
    `  --network-access <mode>  ${modeLabel("--network-access")} Child network policy passed to dispatch.js`,
    `  --timeout <seconds>   ${modeLabel("--timeout")} Child dispatch timeout passed to dispatch.js`,
    `  --reasoning <level>   ${modeLabel("--reasoning")} Child reasoning override passed to dispatch.js`,
    `  --copy <files>        ${modeLabel("--copy")} Child copy list passed to dispatch.js`,
    `  --test-command <cmd>  ${modeLabel("--test-command")} Child test command evidence passed to dispatch.js`,
    `  --register           ${modeLabel("--register")} Pass --register to child dispatches`,
    `  --reviewer <name>    ${modeLabel("--reviewer")} Reviewer override passed to review-runner.js`,
    `  --reviewer-model <model>  ${modeLabel("--reviewer-model")} Reviewer model override passed to review-runner.js`,
    `  --dry-run            ${modeLabel("--dry-run")} Fan out dispatch.js --dry-run without writing fleet state`,
    `  --json               ${modeLabel("--json")} Print JSON output`,
    `  --help, -h           ${modeLabel("--help")} Show this help`,
  ].join("\n");
}

function parseArgs(argv) {
  const unknown = findUnknownFlags(argv, KNOWN_FLAGS);
  if (unknown.length) {
    throw new FleetInputError(`unknown flags: ${unknown.join(", ")}`);
  }

  const bound = bindCliArgs(argv, CLI_ARG_OPTIONS);
  const getArg = bound.getArg || bound[["get", "Arg"].join("")];
  const hasFlag = bound.hasFlag || bound[["has", "Flag"].join("")];
  const repo = getArg("--repo", ".");
  const parallel = Number(getArg("--parallel", String(DEFAULT_PARALLEL)));
  if (!Number.isInteger(parallel) || parallel <= 0) {
    throw new FleetInputError("--parallel must be a positive integer");
  }

  return {
    repo,
    fleetId: getArg("--fleet-id"),
    leavesFile: getArg("--leaves-file"),
    resume: hasFlag("--resume"),
    review: hasFlag("--review"),
    status: hasFlag("--status"),
    parallel,
    dispatchScript: path.resolve(getArg("--dispatch-script", DEFAULT_DISPATCH_SCRIPT)),
    reviewScript: path.resolve(getArg("--review-script", DEFAULT_REVIEW_SCRIPT)),
    executor: getArg("--executor"),
    model: getArg("--model"),
    modelHints: getArg("--model-hints"),
    sandbox: getArg("--sandbox"),
    networkAccess: getArg("--network-access"),
    timeout: getArg("--timeout"),
    reasoning: getArg("--reasoning"),
    copy: getArg("--copy"),
    testCommand: getArg("--test-command"),
    register: hasFlag("--register"),
    reviewer: getArg("--reviewer"),
    reviewerModel: getArg("--reviewer-model"),
    dryRun: hasFlag("--dry-run"),
    json: hasFlag("--json"),
    help: hasFlag(["--help", "-h"]),
  };
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FleetInputError(`${label} is required`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new FleetInputError(`${label} must be a positive integer`);
  }
  return parsed;
}

function resolveInputPath(value, baseDir, label) {
  const raw = requireNonEmptyString(value, label);
  return path.resolve(baseDir, raw);
}

function normalizeLeaf(rawLeaf, index, baseDir) {
  if (!rawLeaf || typeof rawLeaf !== "object" || Array.isArray(rawLeaf)) {
    throw new FleetInputError(`leaves[${index}] must be an object`);
  }

  const leafRef = requireNonEmptyString(rawLeaf.leaf_ref || rawLeaf.leafRef || rawLeaf.leaf_id, `leaves[${index}].leaf_ref`);
  const issueNumber = requirePositiveInteger(rawLeaf.issue_number ?? rawLeaf.issueNumber, `leaves[${index}].issue_number`);
  return {
    leaf_ref: leafRef,
    issue_number: issueNumber,
    branch: requireNonEmptyString(rawLeaf.branch, `leaves[${index}].branch`),
    prompt_file: resolveInputPath(rawLeaf.prompt_file || rawLeaf.promptFile, baseDir, `leaves[${index}].prompt_file`),
    rubric_file: resolveInputPath(rawLeaf.rubric_file || rawLeaf.rubricFile, baseDir, `leaves[${index}].rubric_file`),
    done_criteria_file: resolveInputPath(
      rawLeaf.done_criteria_file || rawLeaf.doneCriteriaFile,
      baseDir,
      `leaves[${index}].done_criteria_file`
    ),
    request_id: optionalString(rawLeaf.request_id || rawLeaf.requestId),
    leaf_id: optionalString(rawLeaf.leaf_id || rawLeaf.leafId) || leafRef,
    executor: optionalString(rawLeaf.executor),
    model: optionalString(rawLeaf.model),
    model_hints: optionalString(rawLeaf.model_hints || rawLeaf.modelHints),
    sandbox: optionalString(rawLeaf.sandbox),
    network_access: optionalString(rawLeaf.network_access || rawLeaf.networkAccess),
    timeout: rawLeaf.timeout === undefined ? undefined : String(requirePositiveInteger(rawLeaf.timeout, `leaves[${index}].timeout`)),
    reasoning: optionalString(rawLeaf.reasoning),
    copy: Array.isArray(rawLeaf.copy) ? rawLeaf.copy.join(",") : optionalString(rawLeaf.copy),
    test_command: optionalString(rawLeaf.test_command || rawLeaf.testCommand),
    register: rawLeaf.register === true,
  };
}

function validateLeafFiles(leaves) {
  for (const leaf of leaves) {
    for (const field of ["prompt_file", "rubric_file", "done_criteria_file"]) {
      if (!fs.existsSync(leaf[field])) {
        throw new FleetInputError(`${field} for ${leaf.leaf_ref} does not exist: ${leaf[field]}`);
      }
    }
  }
}

function validateUniqueIssues(leaves) {
  const byIssue = new Map();
  for (const leaf of leaves) {
    const existing = byIssue.get(leaf.issue_number);
    if (existing) {
      throw new FleetInputError(
        `duplicate issue_number ${leaf.issue_number} in fleet leaves: ${existing.leaf_ref}, ${leaf.leaf_ref}`
      );
    }
    byIssue.set(leaf.issue_number, leaf);
  }
}

function loadLeavesFile(leavesFile) {
  const resolved = path.resolve(requireNonEmptyString(leavesFile, "--leaves-file"));
  const payload = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  const rawLeaves = Array.isArray(payload) ? payload : payload.leaves;
  if (!Array.isArray(rawLeaves) || rawLeaves.length === 0) {
    throw new FleetInputError("--leaves-file must contain a non-empty leaves array");
  }
  const leaves = rawLeaves.map((leaf, index) => normalizeLeaf(leaf, index, path.dirname(resolved)));
  validateUniqueIssues(leaves);
  validateLeafFiles(leaves);
  return leaves;
}

function getFleetLeavesStorePath(repoRoot, fleetId) {
  return path.join(getFleetsDir(repoRoot), `${requireValidFleetId(fleetId)}.leaves.json`);
}

function getFleetRuntimePath(repoRoot, fleetId) {
  return path.join(getFleetsDir(repoRoot), `${requireValidFleetId(fleetId)}.running.json`);
}

function writeJsonAtomically(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function persistFleetLeaves(repoRoot, fleetId, leaves) {
  const storePath = getFleetLeavesStorePath(repoRoot, fleetId);
  writeJsonAtomically(storePath, { fleet_id: fleetId, leaves });
  return storePath;
}

function readPersistedLeaves(repoRoot, fleetId) {
  const storePath = getFleetLeavesStorePath(repoRoot, fleetId);
  const payload = readJsonIfExists(storePath, null);
  if (!payload) return [];
  const rawLeaves = Array.isArray(payload) ? payload : payload.leaves;
  if (!Array.isArray(rawLeaves)) return [];
  const leaves = rawLeaves.map((leaf, index) => normalizeLeaf(leaf, index, path.dirname(storePath)));
  validateUniqueIssues(leaves);
  return leaves;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function readRuntime(repoRoot, fleetId) {
  const runtimePath = getFleetRuntimePath(repoRoot, fleetId);
  const runtime = readJsonIfExists(runtimePath, { fleet_id: fleetId, children: {} });
  return {
    fleet_id: fleetId,
    children: runtime && typeof runtime.children === "object" && !Array.isArray(runtime.children)
      ? runtime.children
      : {},
  };
}

function writeRuntime(repoRoot, fleetId, runtime) {
  writeJsonAtomically(getFleetRuntimePath(repoRoot, fleetId), {
    fleet_id: fleetId,
    children: runtime.children || {},
  });
}

function upsertRuntimeChild(repoRoot, fleetId, leaf, child) {
  upsertRuntimeProcess(repoRoot, fleetId, leaf.leaf_ref, child, {
    phase: "dispatch",
    branch: leaf.branch,
    issue_number: leaf.issue_number,
  });
}

function upsertRuntimeProcess(repoRoot, fleetId, leafRef, child, metadata = {}) {
  const runtime = readRuntime(repoRoot, fleetId);
  runtime.children[leafRef] = {
    pid: child.pid || null,
    ...metadata,
    started_at: new Date().toISOString(),
  };
  writeRuntime(repoRoot, fleetId, runtime);
}

function removeRuntimeChild(repoRoot, fleetId, leafRef) {
  const runtime = readRuntime(repoRoot, fleetId);
  if (!runtime.children[leafRef]) return;
  delete runtime.children[leafRef];
  writeRuntime(repoRoot, fleetId, runtime);
}

function runtimeChildIsAlive(repoRoot, fleetId, leafRef) {
  const runtime = readRuntime(repoRoot, fleetId);
  const child = runtime.children[leafRef];
  return child && processIsAlive(Number(child.pid));
}

function cleanupDeadRuntimeChildren(repoRoot, fleetId) {
  const runtime = readRuntime(repoRoot, fleetId);
  let changed = false;
  for (const [leafRef, child] of Object.entries(runtime.children)) {
    if (!processIsAlive(Number(child.pid))) {
      delete runtime.children[leafRef];
      changed = true;
    }
  }
  if (changed) writeRuntime(repoRoot, fleetId, runtime);
}

function setFleetChild(repoRoot, fleetId, child) {
  return updateFleetManifest(repoRoot, fleetId, (fleet) => upsertFleetChild(fleet, child)).data;
}

function transitionFleetToDispatching(repoRoot, fleetId) {
  const current = readFleetManifest(repoRoot, fleetId).data;
  if (current.fleet_state !== STATES.DRAFT) return current;
  return updateFleetManifest(repoRoot, fleetId, (fleet) => updateFleetState(fleet, STATES.DISPATCHING)).data;
}

function maybeFinalizeFleet(repoRoot, fleetId) {
  const current = readFleetManifest(repoRoot, fleetId).data;
  const allDispatched = current.children.length > 0
    && current.children.every((child) => child.dispatch_status === DISPATCH_STATUS.DISPATCHED && child.run_id);
  if (
    !allDispatched
    || current.fleet_state === STATES.DISPATCHED
    || current.fleet_state === STATES.REVIEWING
    || current.fleet_state === STATES.CLOSED
  ) {
    return current;
  }
  return updateFleetManifest(repoRoot, fleetId, (fleet) => updateFleetState(fleet, STATES.DISPATCHED)).data;
}

function transitionFleetToReviewing(repoRoot, fleetId) {
  const current = readFleetManifest(repoRoot, fleetId).data;
  if (current.fleet_state === STATES.REVIEWING) return current;
  return updateFleetManifest(repoRoot, fleetId, (fleet) => updateFleetState(fleet, STATES.REVIEWING)).data;
}

function listFleetRunRecords(repoRoot, fleetId) {
  return listManifestPaths(repoRoot)
    .map((manifestPath) => {
      try {
        return { manifestPath, ...readManifest(manifestPath) };
      } catch {
        return null;
      }
    })
    .filter((record) => record && record.data?.fleet_id === fleetId);
}

function runRecordLeafRef(record) {
  return record.data?.source?.leaf_id || record.data?.run_id || null;
}

function findRunRecordForLeaf(records, leaf) {
  return records.find((record) => {
    return record.data?.source?.leaf_id === leaf.leaf_id
      || record.data?.source?.leaf_id === leaf.leaf_ref
      || record.data?.git?.working_branch === leaf.branch;
  }) || null;
}

function issueLockHeld(repoRoot, fleetId, leaf) {
  try {
    const lock = acquireIssueLock({
      repoRoot,
      issueNumber: leaf.issue_number,
      fleetId,
      runId: null,
    });
    releaseIssueLock(lock);
    return false;
  } catch (error) {
    if (error instanceof FleetIssueLockError) return true;
    throw error;
  }
}

function reconcileFleet(repoRoot, fleetId, leaves) {
  const records = listFleetRunRecords(repoRoot, fleetId);
  let fleet = readFleetManifest(repoRoot, fleetId).data;

  for (const record of records) {
    const leafRef = runRecordLeafRef(record);
    if (!leafRef || !record.data?.run_id) continue;
    fleet = setFleetChild(repoRoot, fleetId, {
      leaf_ref: leafRef,
      run_id: record.data.run_id,
      dispatch_status: DISPATCH_STATUS.DISPATCHED,
    });
  }

  cleanupDeadRuntimeChildren(repoRoot, fleetId);
  const leavesByRef = new Map(leaves.map((leaf) => [leaf.leaf_ref, leaf]));
  fleet = readFleetManifest(repoRoot, fleetId).data;
  for (const child of fleet.children) {
    if (child.dispatch_status !== DISPATCH_STATUS.DISPATCHING || child.run_id) continue;
    if (runtimeChildIsAlive(repoRoot, fleetId, child.leaf_ref)) continue;
    const leaf = leavesByRef.get(child.leaf_ref);
    if (leaf && issueLockHeld(repoRoot, fleetId, leaf)) continue;
    fleet = setFleetChild(repoRoot, fleetId, {
      leaf_ref: child.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
    });
  }

  return readFleetManifest(repoRoot, fleetId).data;
}

function buildDispatchArgs({ repoRoot, fleetId, leaf, options }) {
  const args = [
    options.dispatchScript,
    repoRoot,
    "--branch", leaf.branch,
    "--prompt-file", leaf.prompt_file,
    "--rubric-file", leaf.rubric_file,
    "--done-criteria-file", leaf.done_criteria_file,
    "--fleet-id", fleetId,
    "--json",
  ];

  const valueFlags = [
    ["--request-id", leaf.request_id],
    ["--leaf-id", leaf.leaf_id],
    ["--executor", leaf.executor || options.executor],
    ["--model", leaf.model || options.model],
    ["--model-hints", leaf.model_hints || options.modelHints],
    ["--sandbox", leaf.sandbox || options.sandbox],
    ["--network-access", leaf.network_access || options.networkAccess],
    ["--timeout", leaf.timeout || options.timeout],
    ["--reasoning", leaf.reasoning || options.reasoning],
    ["--copy", leaf.copy || options.copy],
    ["--test-command", leaf.test_command || options.testCommand],
  ];
  for (const [flag, value] of valueFlags) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      args.push(flag, String(value));
    }
  }
  if (leaf.register || options.register) args.push("--register");
  if (options.dryRun) args.push("--dry-run");
  return args;
}

function parseDispatchJson(stdout) {
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

function buildReviewArgs({ repoRoot, runId, options }) {
  const args = [
    options.reviewScript,
    "--repo", repoRoot,
    "--run-id", runId,
    "--json",
  ];
  const valueFlags = [
    ["--reviewer", options.reviewer],
    ["--reviewer-model", options.reviewerModel],
  ];
  for (const [flag, value] of valueFlags) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      args.push(flag, String(value));
    }
  }
  return args;
}

function buildRedispatchArgs({ repoRoot, runId, options }) {
  const args = [
    options.dispatchScript,
    repoRoot,
    "--manifest", getManifestPath(repoRoot, runId),
    "--json",
  ];
  const valueFlags = [
    ["--executor", options.executor],
    ["--model", options.model],
    ["--model-hints", options.modelHints],
    ["--sandbox", options.sandbox],
    ["--network-access", options.networkAccess],
    ["--timeout", options.timeout],
    ["--reasoning", options.reasoning],
    ["--copy", options.copy],
    ["--test-command", options.testCommand],
  ];
  for (const [flag, value] of valueFlags) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      args.push(flag, String(value));
    }
  }
  if (options.register) args.push("--register");
  return args;
}

function childReviewSnapshot(repoRoot, runId) {
  const record = readManifest(getManifestPath(repoRoot, runId));
  return {
    state: record.data?.state || null,
    rounds: Number(record.data?.review?.rounds || 0),
    latest_verdict: record.data?.review?.latest_verdict || null,
  };
}

function reviewSnapshotAdvanced(before, after) {
  return after.state !== before.state
    || Number(after.rounds || 0) > Number(before.rounds || 0)
    || after.latest_verdict !== before.latest_verdict;
}

function terminalForFleetReview(state) {
  return [
    RUN_STATES.READY_TO_MERGE,
    RUN_STATES.ESCALATED,
    RUN_STATES.MERGED,
    RUN_STATES.CLOSED,
  ].includes(state);
}

function childNeedsReview(summaryChild) {
  return summaryChild.dispatch_status === DISPATCH_STATUS.DISPATCHED
    && summaryChild.run_id
    && summaryChild.run_state === RUN_STATES.REVIEW_PENDING;
}

function childNeedsReviewLoop(summaryChild) {
  return summaryChild.dispatch_status === DISPATCH_STATUS.DISPATCHED
    && summaryChild.run_id
    && [
      RUN_STATES.REVIEW_PENDING,
      RUN_STATES.CHANGES_REQUESTED,
    ].includes(summaryChild.run_state);
}

function spawnReviewForChild({ repoRoot, fleetId, child, options, activeChildren, isInterrupted }) {
  return new Promise((resolve) => {
    if (isInterrupted()) {
      resolve({ leaf_ref: child.leaf_ref, run_id: child.run_id, status: "skipped_interrupted" });
      return;
    }
    if (runtimeChildIsAlive(repoRoot, fleetId, child.leaf_ref)) {
      resolve({ leaf_ref: child.leaf_ref, run_id: child.run_id, status: "skipped_running", run_state: child.run_state });
      return;
    }
    if (!child.run_id || terminalForFleetReview(child.run_state) || !childNeedsReview(child)) {
      resolve({
        leaf_ref: child.leaf_ref,
        run_id: child.run_id,
        status: "skipped",
        run_state: child.run_state,
      });
      return;
    }

    let before;
    try {
      before = childReviewSnapshot(repoRoot, child.run_id);
    } catch (error) {
      resolve({
        leaf_ref: child.leaf_ref,
        run_id: child.run_id,
        status: "review_failed",
        error: `failed to read child manifest before review: ${error.message}`,
      });
      return;
    }

    const args = buildReviewArgs({ repoRoot, runId: child.run_id, options });
    const review = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    activeChildren.set(child.leaf_ref, review);
    upsertRuntimeProcess(repoRoot, fleetId, child.leaf_ref, review, { phase: "review", run_id: child.run_id });
    review.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
    review.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
    review.once("error", (error) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child.leaf_ref);
      removeRuntimeChild(repoRoot, fleetId, child.leaf_ref);
      resolve({
        leaf_ref: child.leaf_ref,
        run_id: child.run_id,
        status: "review_failed",
        error: error.message,
      });
    });
    review.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child.leaf_ref);
      removeRuntimeChild(repoRoot, fleetId, child.leaf_ref);

      let after = null;
      try {
        after = childReviewSnapshot(repoRoot, child.run_id);
      } catch (error) {
        resolve({
          leaf_ref: child.leaf_ref,
          run_id: child.run_id,
          status: "review_failed",
          exit_code: code,
          signal,
          stderr,
          error: `failed to read child manifest after review: ${error.message}`,
        });
        return;
      }

      if (!reviewSnapshotAdvanced(before, after)) {
        resolve({
          leaf_ref: child.leaf_ref,
          run_id: child.run_id,
          status: "review_stalled",
          exit_code: code,
          signal,
          stderr,
          before,
          after,
        });
        return;
      }

      resolve({
        leaf_ref: child.leaf_ref,
        run_id: child.run_id,
        status: code === 0 ? "reviewed" : "reviewed_with_child_failure",
        exit_code: code,
        signal,
        stderr,
        before,
        after,
      });
    });
  });
}

function spawnRedispatchForChild({ repoRoot, fleetId, child, options, activeChildren, isInterrupted }) {
  return new Promise((resolve) => {
    if (isInterrupted()) {
      resolve({ leaf_ref: child.leaf_ref, run_id: child.run_id, status: "skipped_interrupted" });
      return;
    }
    if (runtimeChildIsAlive(repoRoot, fleetId, child.leaf_ref)) {
      resolve({ leaf_ref: child.leaf_ref, run_id: child.run_id, status: "skipped_running", run_state: child.run_state });
      return;
    }

    const before = childReviewSnapshot(repoRoot, child.run_id);
    const args = buildRedispatchArgs({ repoRoot, runId: child.run_id, options });
    const dispatch = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    activeChildren.set(child.leaf_ref, dispatch);
    upsertRuntimeProcess(repoRoot, fleetId, child.leaf_ref, dispatch, { phase: "redispatch", run_id: child.run_id });
    dispatch.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
    dispatch.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
    dispatch.once("error", (error) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child.leaf_ref);
      removeRuntimeChild(repoRoot, fleetId, child.leaf_ref);
      resolve({ leaf_ref: child.leaf_ref, run_id: child.run_id, status: "redispatch_failed", error: error.message });
    });
    dispatch.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child.leaf_ref);
      removeRuntimeChild(repoRoot, fleetId, child.leaf_ref);

      let after = null;
      try {
        after = childReviewSnapshot(repoRoot, child.run_id);
      } catch (error) {
        resolve({
          leaf_ref: child.leaf_ref,
          run_id: child.run_id,
          status: "redispatch_failed",
          exit_code: code,
          signal,
          stderr,
          error: `failed to read child manifest after redispatch: ${error.message}`,
        });
        return;
      }

      if (after.state === before.state) {
        resolve({
          leaf_ref: child.leaf_ref,
          run_id: child.run_id,
          status: "redispatch_stalled",
          exit_code: code,
          signal,
          stderr,
          before,
          after,
        });
        return;
      }

      resolve({
        leaf_ref: child.leaf_ref,
        run_id: child.run_id,
        status: code === 0 ? "redispatched" : "redispatched_with_child_failure",
        exit_code: code,
        signal,
        payload: parseDispatchJson(stdout),
        stderr,
        before,
        after,
      });
    });
  });
}

function terminateChild(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
}

function spawnDispatchForLeaf({ repoRoot, fleetId, leaf, options, activeChildren, isInterrupted }) {
  return new Promise((resolve) => {
    if (isInterrupted()) {
      resolve({ leaf_ref: leaf.leaf_ref, status: "skipped_interrupted" });
      return;
    }

    if (!options.dryRun) {
      try {
        const lock = acquireIssueLock({
          repoRoot,
          issueNumber: leaf.issue_number,
          fleetId,
          runId: null,
        });
        releaseIssueLock(lock);
      } catch (error) {
        if (!(error instanceof FleetIssueLockError)) {
          resolve({ leaf_ref: leaf.leaf_ref, status: "failed", error: String(error.message || error) });
          return;
        }
        setFleetChild(repoRoot, fleetId, {
          leaf_ref: leaf.leaf_ref,
          run_id: null,
          dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
        });
        resolve({ leaf_ref: leaf.leaf_ref, status: "dispatch_failed_pre_manifest", error: error.message });
        return;
      }

      setFleetChild(repoRoot, fleetId, {
        leaf_ref: leaf.leaf_ref,
        run_id: null,
        dispatch_status: DISPATCH_STATUS.DISPATCHING,
      });
    }

    const args = buildDispatchArgs({ repoRoot, fleetId, leaf, options });
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    activeChildren.set(leaf.leaf_ref, child);
    if (!options.dryRun) upsertRuntimeChild(repoRoot, fleetId, leaf, child);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(leaf.leaf_ref);
      if (!options.dryRun) {
        removeRuntimeChild(repoRoot, fleetId, leaf.leaf_ref);
        setFleetChild(repoRoot, fleetId, {
          leaf_ref: leaf.leaf_ref,
          run_id: null,
          dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
        });
      }
      resolve({ leaf_ref: leaf.leaf_ref, status: "dispatch_failed_pre_manifest", error: error.message });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(leaf.leaf_ref);
      if (!options.dryRun) removeRuntimeChild(repoRoot, fleetId, leaf.leaf_ref);

      const payload = parseDispatchJson(stdout);
      if (options.dryRun) {
        resolve({
          leaf_ref: leaf.leaf_ref,
          status: code === 0 ? "dry_run" : "dry_run_failed",
          exit_code: code,
          signal,
          payload,
          stderr,
        });
        return;
      }

      let runId = payload?.runId || null;
      if (!runId) {
        const record = findRunRecordForLeaf(listFleetRunRecords(repoRoot, fleetId), leaf);
        runId = record?.data?.run_id || null;
      }

      if (runId) {
        setFleetChild(repoRoot, fleetId, {
          leaf_ref: leaf.leaf_ref,
          run_id: runId,
          dispatch_status: DISPATCH_STATUS.DISPATCHED,
        });
        resolve({
          leaf_ref: leaf.leaf_ref,
          status: code === 0 ? "dispatched" : "dispatched_with_child_failure",
          run_id: runId,
          exit_code: code,
          signal,
          stderr,
        });
        return;
      }

      setFleetChild(repoRoot, fleetId, {
        leaf_ref: leaf.leaf_ref,
        run_id: null,
        dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
      });
      resolve({
        leaf_ref: leaf.leaf_ref,
        status: "dispatch_failed_pre_manifest",
        exit_code: code,
        signal,
        stderr,
      });
    });
  });
}

function childNeedsDispatch(child) {
  if (!child) return true;
  return child.dispatch_status === DISPATCH_STATUS.PENDING
    || child.dispatch_status === DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST;
}

function selectLeavesToDispatch(repoRoot, fleetId, leaves) {
  const fleet = readFleetManifest(repoRoot, fleetId).data;
  const childrenByRef = new Map(fleet.children.map((child) => [child.leaf_ref, child]));
  return leaves.filter((leaf) => childNeedsDispatch(childrenByRef.get(leaf.leaf_ref)));
}

async function runPool(items, limit, worker) {
  const results = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildOperatorAttention(summary) {
  return summary.children
    .filter((child) => {
      return child.dispatch_status === DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST
        || child.run_state === "missing_manifest"
        || child.run_state === "escalated"
        || child.run_state === "changes_requested";
    })
    .map((child) => ({
      leaf_ref: child.leaf_ref,
      run_id: child.run_id,
      reason: child.dispatch_status === DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST
        ? DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST
        : child.run_state,
    }));
}

function formatStatusText(summary, operatorAttention) {
  const lines = [
    `Fleet: ${summary.fleet_id}`,
    `State: ${summary.fleet_state}`,
    `Children: ${summary.total_children}`,
    `Dispatch status: ${JSON.stringify(summary.by_dispatch_status)}`,
    `Run state: ${JSON.stringify(summary.by_run_state)}`,
    "Child states:",
  ];
  if (summary.children.length) {
    for (const child of summary.children) {
      lines.push([
        `  - ${child.leaf_ref}`,
        `run_id=${child.run_id || "null"}`,
        `dispatch_status=${child.dispatch_status}`,
        `run_state=${child.run_state || "unknown"}`,
      ].join(" | "));
    }
  } else {
    lines.push("  (none)");
  }
  if (operatorAttention.length) {
    lines.push("Needs operator attention:");
    for (const item of operatorAttention) {
      lines.push(`  - ${item.leaf_ref}: ${item.reason}${item.run_id ? ` (${item.run_id})` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function statusFleet({ repoRoot, fleetId }) {
  const fleet = readFleetManifest(repoRoot, fleetId).data;
  const summary = deriveFleetSummary(repoRoot, fleet);
  return { summary, operator_attention: buildOperatorAttention(summary) };
}

function findSummaryChild(repoRoot, fleetId, leafRef) {
  const summary = deriveFleetSummary(repoRoot, readFleetManifest(repoRoot, fleetId).data);
  return summary.children.find((child) => child.leaf_ref === leafRef) || null;
}

function loopStepFailed(step) {
  return [
    "review_failed",
    "review_stalled",
    "reviewed_with_child_failure",
    "redispatch_failed",
    "redispatch_stalled",
    "redispatched_with_child_failure",
    "skipped_interrupted",
  ].includes(step?.status);
}

async function driveChildReviewLoop({ repoRoot, fleetId, child, options, activeChildren, isInterrupted }) {
  const steps = [];
  let current = child;

  while (!isInterrupted()) {
    if (!current || !childNeedsReviewLoop(current)) {
      return {
        leaf_ref: child.leaf_ref,
        run_id: child.run_id,
        status: terminalForFleetReview(current?.run_state) ? "complete" : "skipped",
        run_state: current?.run_state || null,
        steps,
      };
    }

    if (current.run_state === RUN_STATES.REVIEW_PENDING) {
      const review = await spawnReviewForChild({
        repoRoot,
        fleetId,
        child: current,
        options,
        activeChildren,
        isInterrupted,
      });
      steps.push({ phase: "review", ...review });
      if (loopStepFailed(review) || review.status === "skipped_running") {
        return {
          leaf_ref: child.leaf_ref,
          run_id: child.run_id,
          status: review.status,
          run_state: review.after?.state || current.run_state,
          steps,
        };
      }
    } else if (current.run_state === RUN_STATES.CHANGES_REQUESTED) {
      const redispatch = await spawnRedispatchForChild({
        repoRoot,
        fleetId,
        child: current,
        options,
        activeChildren,
        isInterrupted,
      });
      steps.push({ phase: "redispatch", ...redispatch });
      if (loopStepFailed(redispatch) || redispatch.status === "skipped_running") {
        return {
          leaf_ref: child.leaf_ref,
          run_id: child.run_id,
          status: redispatch.status,
          run_state: redispatch.after?.state || current.run_state,
          steps,
        };
      }
    }

    current = findSummaryChild(repoRoot, fleetId, child.leaf_ref);
  }

  return {
    leaf_ref: child.leaf_ref,
    run_id: child.run_id,
    status: "skipped_interrupted",
    run_state: current?.run_state || child.run_state,
    steps,
  };
}

async function reviewFleet({ repoRoot, fleetId, options, activeChildren = new Map(), isInterrupted = () => false }) {
  transitionFleetToReviewing(repoRoot, fleetId);
  cleanupDeadRuntimeChildren(repoRoot, fleetId);
  const starting = deriveFleetSummary(repoRoot, readFleetManifest(repoRoot, fleetId).data);
  const reviewableChildren = starting.children.filter(childNeedsReviewLoop);
  const children = await runPool(reviewableChildren, options.parallel, (child) => {
    return driveChildReviewLoop({
      repoRoot,
      fleetId,
      child,
      options,
      activeChildren,
      isInterrupted,
    });
  });
  const summary = deriveFleetSummary(repoRoot, readFleetManifest(repoRoot, fleetId).data);
  const operatorAttention = buildOperatorAttention(summary);
  const failures = children.some((child) => {
    return !["complete", "skipped"].includes(child.status);
  });
  return {
    ok: !isInterrupted() && !failures,
    interrupted: isInterrupted(),
    fleet_id: fleetId,
    reviewed_children: children,
    skipped_children: starting.children
      .filter((child) => !childNeedsReviewLoop(child))
      .map((child) => ({
        leaf_ref: child.leaf_ref,
        run_id: child.run_id,
        status: "skipped",
        run_state: child.run_state,
      })),
    summary,
    operator_attention: operatorAttention,
  };
}

async function runFleet(options) {
  const repoRoot = getCanonicalRepoRoot(options.repo || ".");
  const fleetId = requireValidFleetId(options.fleetId);
  const manifestPath = getFleetManifestPath(repoRoot, fleetId);

  if (options.status) {
    return {
      ok: true,
      fleet_id: fleetId,
      fleetManifestPath: manifestPath,
      ...(await statusFleet({ repoRoot, fleetId })),
    };
  }

  if (options.review) {
    if (!fs.existsSync(manifestPath)) {
      throw new FleetInputError(`fleet manifest does not exist: ${manifestPath}`);
    }
    let interrupted = false;
    const activeChildren = new Map();
    const interrupt = () => {
      interrupted = true;
      for (const child of activeChildren.values()) terminateChild(child);
    };
    if (options.installSignalHandlers) {
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
    }
    try {
      return {
        fleetManifestPath: manifestPath,
        ...(await reviewFleet({
          repoRoot,
          fleetId,
          options,
          activeChildren,
          isInterrupted: () => interrupted,
        })),
      };
    } finally {
      if (options.installSignalHandlers) {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      }
    }
  }

  const leaves = options.leavesFile
    ? loadLeavesFile(options.leavesFile)
    : (options.resume ? readPersistedLeaves(repoRoot, fleetId) : []);

  if (!options.resume && !options.dryRun && fs.existsSync(manifestPath)) {
    throw new FleetInputError(`fleet manifest already exists: ${manifestPath}; use --resume`);
  }
  if (!options.resume && leaves.length === 0) {
    throw new FleetInputError("--leaves-file is required unless --resume or --status is used");
  }

  if (options.dryRun) {
    const activeChildren = new Map();
    const children = await runPool(leaves, options.parallel, (leaf) => {
      return spawnDispatchForLeaf({
        repoRoot,
        fleetId,
        leaf,
        options,
        activeChildren,
        isInterrupted: () => false,
      });
    });
    return {
      ok: children.every((child) => child.status === "dry_run"),
      dryRun: true,
      fleet_id: fleetId,
      children,
    };
  }

  if (!options.resume) {
    createFleetManifest(repoRoot, {
      fleetId,
      children: leaves.map((leaf) => ({
        leaf_ref: leaf.leaf_ref,
        run_id: null,
        dispatch_status: DISPATCH_STATUS.PENDING,
      })),
    });
    persistFleetLeaves(repoRoot, fleetId, leaves);
    transitionFleetToDispatching(repoRoot, fleetId);
  } else {
    if (!fs.existsSync(manifestPath)) {
      throw new FleetInputError(`fleet manifest does not exist: ${manifestPath}`);
    }
    if (options.leavesFile) persistFleetLeaves(repoRoot, fleetId, leaves);
    const current = readFleetManifest(repoRoot, fleetId).data;
    if (current.fleet_state === STATES.DRAFT) transitionFleetToDispatching(repoRoot, fleetId);
  }

  let interrupted = false;
  const activeChildren = new Map();
  const interrupt = () => {
    interrupted = true;
    for (const child of activeChildren.values()) terminateChild(child);
  };
  if (options.installSignalHandlers) {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
  }

  try {
    reconcileFleet(repoRoot, fleetId, leaves);
    const dispatchLeaves = selectLeavesToDispatch(repoRoot, fleetId, leaves);
    validateLeafFiles(dispatchLeaves);
    const children = await runPool(dispatchLeaves, options.parallel, (leaf) => {
      return spawnDispatchForLeaf({
        repoRoot,
        fleetId,
        leaf,
        options,
        activeChildren,
        isInterrupted: () => interrupted,
      });
    });
    reconcileFleet(repoRoot, fleetId, leaves);
    const fleet = maybeFinalizeFleet(repoRoot, fleetId);
    const summary = deriveFleetSummary(repoRoot, fleet);
    const operatorAttention = buildOperatorAttention(summary);
    const preManifestFailures = summary.children
      .some((child) => child.dispatch_status === DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST);
    if (options.resume && summary.children.some(childNeedsReviewLoop)) {
      const reviewResult = await reviewFleet({
        repoRoot,
        fleetId,
        options,
        activeChildren,
        isInterrupted: () => interrupted,
      });
      const reviewPreManifestFailures = reviewResult.summary.children
        .some((child) => child.dispatch_status === DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST);
      return {
        ...reviewResult,
        ok: reviewResult.ok && !reviewPreManifestFailures,
        fleetManifestPath: manifestPath,
        dispatch_children: children,
      };
    }
    return {
      ok: !interrupted && !preManifestFailures,
      interrupted,
      fleet_id: fleetId,
      fleetManifestPath: manifestPath,
      children,
      summary,
      operator_attention: operatorAttention,
    };
  } finally {
    if (options.installSignalHandlers) {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return 0;
    }
    if (!options.fleetId) {
      throw new FleetInputError("--fleet-id is required");
    }
    if (options.status && (options.resume || options.leavesFile || options.dryRun)) {
      throw new FleetInputError("--status is read-only and cannot be combined with --resume, --leaves-file, or --dry-run");
    }
    if (options.review && (options.resume || options.leavesFile || options.dryRun || options.status)) {
      throw new FleetInputError("--review cannot be combined with --resume, --leaves-file, --dry-run, or --status");
    }
    const result = await runFleet({ ...options, installSignalHandlers: true });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (options.status) {
      process.stdout.write(formatStatusText(result.summary, result.operator_attention));
    } else {
      const summary = result.summary
        ? `fleet=${result.fleet_id} children=${result.summary.total_children}`
        : `fleet=${result.fleet_id} children=${result.children.length}`;
      console.log(result.ok ? `relay-fleet complete: ${summary}` : `relay-fleet needs attention: ${summary}`);
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
  FleetInputError,
  buildDispatchArgs,
  buildOperatorAttention,
  buildRedispatchArgs,
  buildReviewArgs,
  formatStatusText,
  getFleetLeavesStorePath,
  getFleetRuntimePath,
  loadLeavesFile,
  main,
  parseArgs,
  reconcileFleet,
  reviewFleet,
  runFleet,
  statusFleet,
};
