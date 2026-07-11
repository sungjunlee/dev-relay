#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
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
  listFleetManifestPaths,
  listManifestPaths,
  requireValidFleetId,
} = require("../../relay-dispatch/scripts/manifest/paths");
const { STATES: RUN_STATES } = require("../../relay-dispatch/scripts/manifest/lifecycle");
const { readManifest } = require("../../relay-dispatch/scripts/manifest/store");
const { execGh } = require("../../relay-dispatch/scripts/exec");
const {
  DISPATCH_STATUS,
  FleetIssueLockError,
  STATES,
  acquireIssueLock,
  createFleetManifest,
  deriveFleetSummary,
  normalizeFleetChildLastError,
  readFleetManifest,
  releaseIssueLock,
  updateFleetManifest,
  updateFleetState,
  upsertFleetChild,
} = require("../../relay-dispatch/scripts/manifest/fleet");
const { getRequestPath, readRequestArtifact } = require("../../relay-ready/scripts/relay-request");
const { runReconcile } = require("../../relay-dispatch/scripts/reconcile-advisory");
const {
  getRunArtifactPaths,
  getRunLeaseStatus,
} = require("../../relay-dispatch/scripts/run-runtime-state");
const { EVENTS, readRunEvents } = require("../../relay-dispatch/scripts/relay-events");
const { runMergeQueue } = require("./merge-queue");

const DEFAULT_PARALLEL = 4;
// #931: live lease + still-empty stdout past this age → stalled_executor attention.
// Mid-run stalls AFTER the first stdout byte are NOT detected (accepted limitation).
const DEFAULT_STALL_THRESHOLD_MS = 15 * 60 * 1000;
const STALL_STDERR_TAIL_MAX_CHARS = 120;
const FLEET_CHILD_LOCK_TIMEOUT_MS = 5000;
const FLEET_CHILD_LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const FLEET_CHILD_TICKET_PATTERN = /^ticket-(\d+)\.(waiting|done)$/;
const DEFAULT_DISPATCH_SCRIPT = path.join(__dirname, "..", "..", "relay-dispatch", "scripts", "dispatch.js");
const DEFAULT_PUBLISH_SCRIPT = path.join(__dirname, "..", "..", "relay-dispatch", "scripts", "publish-run.js");
const DEFAULT_REVIEW_SCRIPT = path.join(__dirname, "..", "..", "relay-review", "scripts", "review-runner.js");
const DEFAULT_FINALIZE_SCRIPT = path.join(__dirname, "..", "..", "relay-merge", "scripts", "finalize-run.js");
const KNOWN_FLAGS = [
  "--repo", "--fleet-id", "--leaves-file", "--resume", "--status", "--review", "--parallel",
  "--dispatch-script", "--publish-script", "--review-script", "--executor", "--model", "--model-hints", "--sandbox",
  "--network-access", "--timeout", "--reasoning", "--copy", "--test-command", "--publish-policy",
  "--register", "--reviewer", "--reviewer-model", "--finalize-script", "--merge-method",
  "--dry-run", "--json", "--help", "-h",
];
const CLI_ARG_OPTIONS = { commandName: "relay-fleet", reservedFlags: KNOWN_FLAGS };
const MODE_PARSED_LABEL = "[parsed]";
const MODE_VERBATIM_LABEL = "[verbatim]";
const DETACHED_DISPATCH_SUCCESS_STATES = new Set([
  RUN_STATES.INTERNAL_REVIEW_PENDING,
  RUN_STATES.REVIEW_PENDING,
  RUN_STATES.PUBLISH_PENDING,
  RUN_STATES.CHANGES_REQUESTED,
  RUN_STATES.READY_TO_MERGE,
  RUN_STATES.MERGE_BLOCKED,
  RUN_STATES.MERGED,
]);
const DETACHED_DISPATCH_FAILURE_STATES = new Set([
  RUN_STATES.ESCALATED,
  RUN_STATES.CLOSED,
]);

class FleetInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "FleetInputError";
  }
}

function dispatchFailureLastError({ error = null, stderr = null, fallback = null } = {}) {
  const directError = normalizeFleetChildLastError(error);
  if (directError) return directError;
  // Child-process stderr can be verbose; keep the tail where the concrete
  // failure usually appears while still enforcing the fleet child field bound.
  const stderrTail = normalizeFleetChildLastError(stderr, { fromTail: true });
  if (stderrTail) return stderrTail;
  return normalizeFleetChildLastError(fallback);
}

function usage() {
  return [
    "Usage: relay-fleet.js --repo <path> --fleet-id <id> [--leaves-file <path>] [options]",
    "       relay-fleet.js --repo <path> --fleet-id <id> --review [options]",
    "       relay-fleet.js --repo <path> --fleet-id <id> --status [--json]",
    "       relay-fleet.js --repo <path> --status [--json]",
    "",
    "Options:",
    `  --repo <path>          ${modeLabel("--repo")} Repository root (default: current directory)`,
    `  --fleet-id <id>       ${modeLabel("--fleet-id")} Fleet manifest id (required except repo-wide --status)`,
    `  --leaves-file <path>  ${MODE_VERBATIM_LABEL} JSON file with already-planned leaf contracts`,
    `  --resume             ${MODE_PARSED_LABEL} Deprecated alias for the default drive command`,
    `  --review             ${MODE_PARSED_LABEL} Deprecated review-only re-entry point`,
    `  --status             ${MODE_PARSED_LABEL} Print derived fleet summary without writing`,
    `  --parallel <n>       ${MODE_PARSED_LABEL} Maximum concurrent child dispatches (default: ${DEFAULT_PARALLEL})`,
    `  --dispatch-script <path>  ${MODE_VERBATIM_LABEL} Dispatch entrypoint (default: relay-dispatch/scripts/dispatch.js)`,
    `  --publish-script <path>   ${MODE_VERBATIM_LABEL} Publish entrypoint (default: relay-dispatch/scripts/publish-run.js)`,
    `  --review-script <path>    ${MODE_VERBATIM_LABEL} Review entrypoint (default: relay-review/scripts/review-runner.js)`,
    `  --finalize-script <path>  ${MODE_VERBATIM_LABEL} Finalize entrypoint (default: relay-merge/scripts/finalize-run.js)`,
    `  --merge-method <name>  ${MODE_PARSED_LABEL} squash | merge | rebase (default: squash)`,
    `  --executor <name>     ${modeLabel("--executor")} Child executor passed to dispatch.js`,
    `  --model <name>        ${modeLabel("--model")} Child model override passed to dispatch.js`,
    `  --model-hints <spec>  ${modeLabel("--model-hints")} Child model hints passed to dispatch.js`,
    `  --sandbox <mode>      ${modeLabel("--sandbox")} Child sandbox passed to dispatch.js`,
    `  --network-access <mode>  ${modeLabel("--network-access")} Child network policy passed to dispatch.js`,
    `  --timeout <seconds>   ${modeLabel("--timeout")} Child dispatch timeout passed to dispatch.js`,
    `  --reasoning <level>   ${modeLabel("--reasoning")} Child reasoning override passed to dispatch.js`,
    `  --copy <files>        ${modeLabel("--copy")} Child copy list passed to dispatch.js`,
    `  --test-command <cmd>  ${modeLabel("--test-command")} Child test command evidence passed to dispatch.js`,
    `  --publish-policy <mode>  ${modeLabel("--publish-policy")} Child publish policy passed to dispatch.js`,
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
    publishScript: path.resolve(getArg("--publish-script", DEFAULT_PUBLISH_SCRIPT)),
    reviewScript: path.resolve(getArg("--review-script", DEFAULT_REVIEW_SCRIPT)),
    finalizeScript: path.resolve(getArg("--finalize-script", DEFAULT_FINALIZE_SCRIPT)),
    mergeMethod: getArg("--merge-method", "squash"),
    executor: getArg("--executor"),
    model: getArg("--model"),
    modelHints: getArg("--model-hints"),
    sandbox: getArg("--sandbox"),
    networkAccess: getArg("--network-access"),
    timeout: getArg("--timeout"),
    reasoning: getArg("--reasoning"),
    copy: getArg("--copy"),
    testCommand: getArg("--test-command"),
    publishPolicy: getArg("--publish-policy"),
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

function normalizeDependsOn(rawValue, index) {
  if (rawValue === undefined || rawValue === null) return undefined;
  if (!Array.isArray(rawValue)) {
    throw new FleetInputError(`leaves[${index}].depends_on must be an array of leaf_ref strings`);
  }
  return rawValue.map((entry, entryIndex) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new FleetInputError(`leaves[${index}].depends_on[${entryIndex}] must be a non-empty string`);
    }
    return entry.trim();
  });
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
    depends_on: normalizeDependsOn(rawLeaf.depends_on ?? rawLeaf.dependsOn, index),
    executor: optionalString(rawLeaf.executor),
    model: optionalString(rawLeaf.model),
    model_hints: optionalString(rawLeaf.model_hints || rawLeaf.modelHints),
    sandbox: optionalString(rawLeaf.sandbox),
    network_access: optionalString(rawLeaf.network_access || rawLeaf.networkAccess),
    timeout: rawLeaf.timeout === undefined ? undefined : String(requirePositiveInteger(rawLeaf.timeout, `leaves[${index}].timeout`)),
    reasoning: optionalString(rawLeaf.reasoning),
    copy: Array.isArray(rawLeaf.copy) ? rawLeaf.copy.join(",") : optionalString(rawLeaf.copy),
    test_command: optionalString(rawLeaf.test_command || rawLeaf.testCommand),
    publish_policy: optionalString(rawLeaf.publish_policy || rawLeaf.publishPolicy),
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

// Fail-closed same-wave dependency guard. A leaf's depends_on entry that names
// another leaf in THIS SAME leaves file cannot be satisfied by fan-out, since
// fan-out dispatches every leaf in the file concurrently — that dependency must
// be dispatched in an earlier wave (a separate --leaves-file/--fleet-id run)
// first, then dropped from this file. A depends_on entry naming a leaf_ref that
// is not present in this file is accepted silently: it is assumed to already be
// satisfied by an earlier wave or external dispatch (see SKILL.md).
function validateLeafDependencies(leaves) {
  const refsInFile = new Set(leaves.map((leaf) => leaf.leaf_ref));
  for (const leaf of leaves) {
    if (!Array.isArray(leaf.depends_on)) continue;
    for (const dependency of leaf.depends_on) {
      if (dependency === leaf.leaf_ref) {
        throw new FleetInputError(
          `leaf '${leaf.leaf_ref}' has a depends_on entry that references itself`
        );
      }
      if (refsInFile.has(dependency)) {
        throw new FleetInputError(
          `leaf '${leaf.leaf_ref}' depends_on '${dependency}', which is also in this leaves file (same-wave dependency); ` +
          `dispatch '${dependency}' in an earlier wave (a separate fleet run) and remove it from this leaves file before fanning out '${leaf.leaf_ref}'.`
        );
      }
      // Else: dependency is external to this leaves file and assumed already satisfied.
    }
  }
}

// Reads decomposition.leaf_order (multi-leaf requests) or the top-level
// leaf_id (single-leaf requests) from a persisted relay-ready request
// artifact's data, per the shapes written by relay-request.js's
// buildRequestArtifactData. Returns [] when neither is present.
function collectRequestLeafIds(requestData) {
  if (requestData?.decomposition && Array.isArray(requestData.decomposition.leaf_order)) {
    return requestData.decomposition.leaf_order;
  }
  if (typeof requestData?.leaf_id === "string" && requestData.leaf_id.trim() !== "") {
    return [requestData.leaf_id];
  }
  return [];
}

// Fail-closed relay-ready lineage check: a leaf that claims a request_id must
// point at a request artifact that actually exists and parses, and if it also
// names a leaf_id, that leaf_id must be one of the leaf handoffs persisted for
// that request. Leaves without a request_id are exempt (see SKILL.md). This is
// separate from loadLeavesFile because it needs repoRoot, which loadLeavesFile
// does not have in scope.
function validateLeafLineage(repoRoot, leaves) {
  for (const leaf of leaves) {
    if (!leaf.request_id) continue;

    const requestPath = getRequestPath(repoRoot, leaf.request_id);
    if (!fs.existsSync(requestPath)) {
      throw new FleetInputError(
        `leaf '${leaf.leaf_ref}' request_id '${leaf.request_id}' does not resolve to a relay-ready request artifact: ${requestPath}`
      );
    }

    let artifact;
    try {
      artifact = readRequestArtifact(requestPath);
    } catch (error) {
      throw new FleetInputError(
        `leaf '${leaf.leaf_ref}' request_id '${leaf.request_id}' request artifact is unreadable at ${requestPath}: ${error.message}`
      );
    }

    if (leaf.leaf_id) {
      const knownLeafIds = collectRequestLeafIds(artifact.data);
      if (!knownLeafIds.includes(leaf.leaf_id)) {
        throw new FleetInputError(
          `leaf '${leaf.leaf_ref}' leaf_id '${leaf.leaf_id}' is not among the leaf handoffs persisted for request '${leaf.request_id}' ` +
          `(known: ${knownLeafIds.length ? knownLeafIds.join(", ") : "none"})`
        );
      }
    }
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
  validateLeafDependencies(leaves);
  validateLeafFiles(leaves);
  return leaves;
}

function getFleetLeavesStorePath(repoRoot, fleetId) {
  return path.join(getFleetsDir(repoRoot), `${requireValidFleetId(fleetId)}.leaves.json`);
}

function getFleetLeafReplacementPath(repoRoot, fleetId) {
  return path.join(getFleetsDir(repoRoot), `${requireValidFleetId(fleetId)}.leaves-replacement.json`);
}

function getFleetRuntimePath(repoRoot, fleetId) {
  return path.join(getFleetsDir(repoRoot), `${requireValidFleetId(fleetId)}.running.json`);
}

function syncDirectory(directoryPath) {
  let fd = null;
  try {
    fd = fs.openSync(directoryPath, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code)) throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function syncFile(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(path.dirname(filePath));
}

function writeJsonAtomically(filePath, data, { durable = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
    if (durable) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  if (durable) syncDirectory(path.dirname(filePath));
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function persistFleetLeaves(repoRoot, fleetId, leaves, { durable = false } = {}) {
  const storePath = getFleetLeavesStorePath(repoRoot, fleetId);
  writeJsonAtomically(storePath, { fleet_id: fleetId, leaves }, { durable });
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

function comparableLeaf(leaf) {
  return {
    leaf_ref: leaf.leaf_ref,
    issue_number: leaf.issue_number,
    branch: leaf.branch,
    prompt_file: leaf.prompt_file,
    rubric_file: leaf.rubric_file,
    done_criteria_file: leaf.done_criteria_file,
    request_id: leaf.request_id || null,
    leaf_id: leaf.leaf_id || leaf.leaf_ref,
    depends_on: Array.isArray(leaf.depends_on) ? leaf.depends_on.slice().sort() : [],
    executor: leaf.executor || null,
    model: leaf.model || null,
    model_hints: leaf.model_hints || null,
    sandbox: leaf.sandbox || null,
    network_access: leaf.network_access || null,
    timeout: leaf.timeout || null,
    reasoning: leaf.reasoning || null,
    copy: leaf.copy || null,
    test_command: leaf.test_command || null,
    publish_policy: leaf.publish_policy || null,
    register: leaf.register === true,
  };
}

function comparableLeaves(leaves) {
  return leaves
    .map(comparableLeaf)
    .sort((left, right) => left.leaf_ref.localeCompare(right.leaf_ref));
}

function leavesMatch(left, right) {
  return JSON.stringify(comparableLeaves(left)) === JSON.stringify(comparableLeaves(right));
}

function sortedLeafRefs(items) {
  return Array.from(new Set(items.map((item) => item.leaf_ref)))
    .sort((left, right) => left.localeCompare(right));
}

function leafRefSetsMatch(left, right) {
  const leftRefs = sortedLeafRefs(left);
  const rightRefs = sortedLeafRefs(right);
  return leftRefs.length === rightRefs.length
    && leftRefs.every((leafRef, index) => leafRef === rightRefs[index]);
}

function issueSetsMatch(left, right) {
  const leftIssues = left.map((leaf) => leaf.issue_number).sort((a, b) => a - b);
  const rightIssues = right.map((leaf) => leaf.issue_number).sort((a, b) => a - b);
  return leftIssues.length === rightIssues.length
    && leftIssues.every((issueNumber, index) => issueNumber === rightIssues[index]);
}

function isReplaceableFleetChild(child) {
  return child?.run_id === null
    && child?.dispatch_status === DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST;
}

function acceptedLeafReplacements(fleetChildren, persistedLeaves, leaves) {
  if (!Array.isArray(persistedLeaves) || leavesMatch(persistedLeaves, leaves)) return [];
  if (!issueSetsMatch(persistedLeaves, leaves)) return null;
  if (new Set(leaves.map((leaf) => leaf.leaf_ref)).size !== leaves.length) return null;

  const childrenByRef = new Map(fleetChildren.map((child) => [child.leaf_ref, child]));
  const existingChildRefs = new Set(childrenByRef.keys());
  const leavesByIssue = new Map(leaves.map((leaf) => [leaf.issue_number, leaf]));
  const replacements = [];
  for (const persistedLeaf of persistedLeaves) {
    const leaf = leavesByIssue.get(persistedLeaf.issue_number);
    if (JSON.stringify(comparableLeaf(persistedLeaf)) === JSON.stringify(comparableLeaf(leaf))) continue;
    // A changed leaf must carry a NEW leaf_ref: same-ref respecification is
    // rejected so a concurrent invocation holding the old spec can never find
    // a same-keyed child to dispatch (the old ref ceases to exist on accept).
    if (leaf.leaf_ref === persistedLeaf.leaf_ref) return null;
    // Reusing any old child key (including another replaceable child's key)
    // would leave stale selectors able to find that key with a different spec.
    if (existingChildRefs.has(leaf.leaf_ref)) return null;
    const child = childrenByRef.get(persistedLeaf.leaf_ref);
    if (!isReplaceableFleetChild(child)) return null;
    replacements.push({
      old_leaf_ref: persistedLeaf.leaf_ref,
      new_leaf_ref: leaf.leaf_ref,
      issue_number: persistedLeaf.issue_number,
    });
  }
  const replacementsByOldRef = new Map(replacements.map((replacement) => [replacement.old_leaf_ref, replacement]));
  const nextChildren = fleetChildren.map((child) => ({
    leaf_ref: replacementsByOldRef.get(child.leaf_ref)?.new_leaf_ref || child.leaf_ref,
  }));
  const nextChildRefs = nextChildren.map((child) => child.leaf_ref);
  if (new Set(nextChildRefs).size !== nextChildRefs.length) return null;
  if (!leafRefSetsMatch(nextChildren, leaves)) return null;
  return replacements;
}

function getFleetChildLockPath(repoRoot, fleetId) {
  return path.join(getFleetsDir(repoRoot), "locks", `fleet-${requireValidFleetId(fleetId)}-children.lock`);
}

function getFleetChildTicketDirectory(lockPath) {
  return `${lockPath}.queue`;
}

function listFleetChildTickets(ticketDirectory) {
  if (!fs.existsSync(ticketDirectory)) return [];
  return fs.readdirSync(ticketDirectory)
    .map((name) => {
      const match = name.match(FLEET_CHILD_TICKET_PATTERN);
      return match ? {
        number: Number(match[1]),
        state: match[2],
        path: path.join(ticketDirectory, name),
      } : null;
    })
    .filter(Boolean);
}

function createFleetChildTicket(lockPath, fleetId) {
  const ticketDirectory = getFleetChildTicketDirectory(lockPath);
  fs.mkdirSync(ticketDirectory, { recursive: true });

  while (true) {
    const tickets = listFleetChildTickets(ticketDirectory);
    const number = tickets.reduce((highest, ticket) => Math.max(highest, ticket.number), 0) + 1;
    const waitingPath = path.join(ticketDirectory, `ticket-${number}.waiting`);
    const candidatePath = path.join(
      ticketDirectory,
      `.candidate-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    fs.writeFileSync(candidatePath, `${JSON.stringify({
      fleet_id: fleetId,
      pid: process.pid,
      hostname: os.hostname(),
      acquired_at: new Date().toISOString(),
    })}\n`, "utf-8");
    try {
      fs.linkSync(candidatePath, waitingPath);
      return { number, waitingPath, ticketDirectory };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      try {
        fs.unlinkSync(candidatePath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

function retireDeadFleetChildTickets(ticket) {
  for (const predecessor of listFleetChildTickets(ticket.ticketDirectory)) {
    if (predecessor.state !== "waiting" || predecessor.number >= ticket.number) continue;
    try {
      const owner = JSON.parse(fs.readFileSync(predecessor.path, "utf-8"));
      if (owner.hostname !== os.hostname() || processIsAlive(Number(owner.pid))) continue;
      fs.renameSync(predecessor.path, predecessor.path.replace(/\.waiting$/, ".done"));
    } catch (error) {
      if (error.code !== "ENOENT") continue;
    }
  }
}

function fleetChildTicketHasPredecessor(ticket) {
  return listFleetChildTickets(ticket.ticketDirectory)
    .some((entry) => entry.state === "waiting" && entry.number < ticket.number);
}

function releaseFleetChildTicket(ticket) {
  const donePath = ticket.waitingPath.replace(/\.waiting$/, ".done");
  try {
    fs.renameSync(ticket.waitingPath, donePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const tickets = listFleetChildTickets(ticket.ticketDirectory);
  const highest = tickets.reduce((value, entry) => Math.max(value, entry.number), 0);
  for (const entry of tickets) {
    if (entry.state !== "done" || entry.number >= highest) continue;
    try {
      fs.unlinkSync(entry.path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function publishFleetChildLock(lockPath, contents) {
  const candidatePath = `${lockPath}.candidate-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(candidatePath, contents, "utf-8");
  try {
    fs.linkSync(candidatePath, lockPath);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return false;
  } finally {
    try {
      fs.unlinkSync(candidatePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function acquireFleetChildLock(repoRoot, fleetId) {
  const lockPath = getFleetChildLockPath(repoRoot, fleetId);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const ticket = createFleetChildTicket(lockPath, fleetId);
  const contents = `${JSON.stringify({
    fleet_id: fleetId,
    pid: process.pid,
    hostname: os.hostname(),
    acquired_at: new Date().toISOString(),
    ticket: ticket.number,
  })}\n`;
  const startedAt = Date.now();

  try {
    while (Date.now() - startedAt < FLEET_CHILD_LOCK_TIMEOUT_MS) {
      retireDeadFleetChildTickets(ticket);
      if (fleetChildTicketHasPredecessor(ticket)) {
        Atomics.wait(FLEET_CHILD_LOCK_WAIT_ARRAY, 0, 0, 10);
        continue;
      }
      if (publishFleetChildLock(lockPath, contents)) {
        return { lockPath, contents, ticket };
      }
      try {
        const existingContents = fs.readFileSync(lockPath, "utf-8");
        let existing;
        try {
          existing = JSON.parse(existingContents);
        } catch {
          // Older writers created the canonical path before populating it.
          // The lowest live ticket can safely retire a truncated remnant.
          fs.unlinkSync(lockPath);
          continue;
        }
        if (existing.hostname === os.hostname() && !processIsAlive(Number(existing.pid))) {
          // Only the lowest live ticket may reclaim the canonical lock. A
          // contender that observed this stale owner cannot race a successor.
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (readError) {
        if (readError.code === "ENOENT") continue;
      }
      Atomics.wait(FLEET_CHILD_LOCK_WAIT_ARRAY, 0, 0, 10);
    }
  } catch (error) {
    releaseFleetChildTicket(ticket);
    throw error;
  }
  releaseFleetChildTicket(ticket);
  throw new FleetInputError(
    `timed out waiting to update fleet children for '${fleetId}'; another relay-fleet invocation is active`
  );
}

function releaseFleetChildLock(lock) {
  try {
    if (fs.readFileSync(lock.lockPath, "utf-8") === lock.contents) fs.unlinkSync(lock.lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  } finally {
    releaseFleetChildTicket(lock.ticket);
  }
}

function withFleetChildLock(repoRoot, fleetId, callback) {
  const lock = acquireFleetChildLock(repoRoot, fleetId);
  try {
    return callback();
  } finally {
    releaseFleetChildLock(lock);
  }
}

function assertLeavesMatchFleetChildren(repoRoot, fleetId, leaves, { persistedLeaves = null } = {}) {
  const fleet = readFleetManifest(repoRoot, fleetId).data;
  if (persistedLeaves) {
    return {
      fleet,
      replacements: acceptedLeafReplacements(fleet.children, persistedLeaves, leaves),
    };
  }
  if (!leafRefSetsMatch(leaves, fleet.children)) {
    throw new FleetInputError(
      `--leaves-file leaf_ref set differs from fleet manifest children for '${fleetId}'; refusing to overwrite an existing fleet`
    );
  }
  return { fleet, replacements: [] };
}

function replacedFleetChildren(fleetChildren, replacements) {
  const replacementsByOldRef = new Map(replacements.map((replacement) => [replacement.old_leaf_ref, replacement]));
  return fleetChildren.map((child) => {
    const replacement = replacementsByOldRef.get(child.leaf_ref);
    if (!replacement) return child;
    return {
      leaf_ref: replacement.new_leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.PENDING,
    };
  });
}

function fleetChildrenMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function removeFleetLeafReplacementJournal(journalPath) {
  try {
    fs.unlinkSync(journalPath);
    syncDirectory(path.dirname(journalPath));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function recoverAcceptedLeafReplacementUnlocked(repoRoot, fleetId) {
  const journalPath = getFleetLeafReplacementPath(repoRoot, fleetId);
  const journal = readJsonIfExists(journalPath, null);
  if (!journal) return [];
  if (
    journal.fleet_id !== fleetId
    || !Array.isArray(journal.original_children)
    || !Array.isArray(journal.replacement_children)
    || !Array.isArray(journal.original_leaves)
    || !Array.isArray(journal.replacement_leaves)
  ) {
    throw new Error(`invalid fleet leaf-replacement recovery journal: ${journalPath}`);
  }

  const fleet = readFleetManifest(repoRoot, fleetId).data;
  const persistedLeaves = readPersistedLeaves(repoRoot, fleetId);
  const manifestIsOriginal = fleetChildrenMatch(fleet.children, journal.original_children);
  const manifestIsReplacement = fleetChildrenMatch(fleet.children, journal.replacement_children);
  const leavesAreOriginal = leavesMatch(persistedLeaves, journal.original_leaves);
  const leavesAreReplacement = leavesMatch(persistedLeaves, journal.replacement_leaves);

  if (manifestIsOriginal && leavesAreOriginal) {
    removeFleetLeafReplacementJournal(journalPath);
    return [];
  }
  if (manifestIsOriginal && leavesAreReplacement) {
    updateFleetManifest(repoRoot, fleetId, (current) => ({
      ...current,
      children: journal.replacement_children,
    }));
    syncFile(getFleetManifestPath(repoRoot, fleetId));
  } else if (manifestIsReplacement && leavesAreOriginal) {
    persistFleetLeaves(repoRoot, fleetId, journal.replacement_leaves, { durable: true });
  } else if (!manifestIsReplacement || !leavesAreReplacement) {
    throw new Error(
      `fleet leaf-replacement recovery journal does not match the manifest/leaves stores for '${fleetId}'`
    );
  }

  removeFleetLeafReplacementJournal(journalPath);
  return Array.isArray(journal.replacements) ? journal.replacements : [];
}

function recoverAcceptedLeafReplacement(repoRoot, fleetId) {
  if (!fs.existsSync(getFleetLeafReplacementPath(repoRoot, fleetId))) return [];
  return withFleetChildLock(repoRoot, fleetId, () => (
    recoverAcceptedLeafReplacementUnlocked(repoRoot, fleetId)
  ));
}

function applyAcceptedLeafReplacements(repoRoot, fleetId, leaves) {
  return withFleetChildLock(repoRoot, fleetId, () => {
    recoverAcceptedLeafReplacementUnlocked(repoRoot, fleetId);
    const fleet = readFleetManifest(repoRoot, fleetId).data;
    const currentPersistedLeaves = readPersistedLeaves(repoRoot, fleetId);
    const replacements = acceptedLeafReplacements(fleet.children, currentPersistedLeaves, leaves);
    if (!Array.isArray(replacements)) {
      throw new FleetInputError(
        `--leaves-file differs from persisted fleet leaves for '${fleetId}'; refusing to overwrite an existing fleet`
      );
    }
    if (replacements.length === 0) {
      if (leavesMatch(currentPersistedLeaves, leaves) && leafRefSetsMatch(fleet.children, leaves)) return [];
      throw new FleetInputError(
        `--leaves-file differs from persisted fleet leaves for '${fleetId}'; refusing to overwrite an existing fleet`
      );
    }

    const originalChildren = fleet.children;
    const replacementChildren = replacedFleetChildren(fleet.children, replacements);
    const journalPath = getFleetLeafReplacementPath(repoRoot, fleetId);
    writeJsonAtomically(journalPath, {
      fleet_id: fleetId,
      original_children: originalChildren,
      replacement_children: replacementChildren,
      original_leaves: currentPersistedLeaves,
      replacement_leaves: leaves,
      replacements,
    }, { durable: true });
    try {
      updateFleetManifest(repoRoot, fleetId, (current) => ({
        ...current,
        children: replacementChildren,
      }));
      syncFile(getFleetManifestPath(repoRoot, fleetId));
      persistFleetLeaves(repoRoot, fleetId, leaves, { durable: true });
    } catch (error) {
      try {
        const currentFleet = readFleetManifest(repoRoot, fleetId).data;
        if (!fleetChildrenMatch(currentFleet.children, originalChildren)) {
          updateFleetManifest(repoRoot, fleetId, (current) => ({
            ...current,
            children: originalChildren,
          }));
          syncFile(getFleetManifestPath(repoRoot, fleetId));
        }
        const persistedAfterFailure = readPersistedLeaves(repoRoot, fleetId);
        if (!leavesMatch(persistedAfterFailure, currentPersistedLeaves)) {
          persistFleetLeaves(repoRoot, fleetId, currentPersistedLeaves, { durable: true });
        }
        removeFleetLeafReplacementJournal(journalPath);
      } catch (rollbackError) {
        throw new Error(
          `failed to persist accepted leaf replacements and failed to roll back fleet stores: ${error.message}; rollback: ${rollbackError.message}`,
          { cause: error }
        );
      }
      throw error;
    }
    removeFleetLeafReplacementJournal(journalPath);
    return replacements;
  });
}

function assertLeavesMatchPersisted(repoRoot, fleetId, leaves) {
  const storePath = getFleetLeavesStorePath(repoRoot, fleetId);
  const storeExists = fs.existsSync(storePath);
  const persisted = readPersistedLeaves(repoRoot, fleetId);
  if (!storeExists) {
    const { replacements } = assertLeavesMatchFleetChildren(repoRoot, fleetId, leaves);
    return { leaves: null, replacements };
  }
  if (persisted.length === 0) {
    throw new FleetInputError(
      `--leaves-file was provided for existing fleet '${fleetId}', but no persisted fleet leaves exist to verify it; nothing was changed`
    );
  }
  if (!leavesMatch(persisted, leaves)) {
    const { replacements } = assertLeavesMatchFleetChildren(repoRoot, fleetId, leaves, { persistedLeaves: persisted });
    if (Array.isArray(replacements) && replacements.length > 0) {
      return { leaves, replacements };
    }
    throw new FleetInputError(
      `--leaves-file differs from persisted fleet leaves for '${fleetId}'; refusing to overwrite an existing fleet`
    );
  }
  assertLeavesMatchFleetChildren(repoRoot, fleetId, leaves);
  return { leaves: persisted, replacements: [] };
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

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function childIsAlive(repoRoot, fleetId, child) {
  if (!child) return false;
  if (runtimeChildIsAlive(repoRoot, fleetId, child.leaf_ref)) return true;
  return Boolean(child.run_id && getRunLeaseStatus(repoRoot, child.run_id).live);
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
  return withFleetChildLock(repoRoot, fleetId, () => {
    let childExists = true;
    const updated = updateFleetManifest(repoRoot, fleetId, (fleet) => {
      if (!findFleetChild(fleet, child.leaf_ref)) {
        childExists = false;
        return fleet;
      }
      return upsertFleetChild(fleet, child);
    }).data;
    return childExists ? updated : null;
  });
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
    || STATES.DISPATCHED === current.fleet_state
    || STATES.REVIEWING === current.fleet_state
    || STATES.MERGING === current.fleet_state
    || STATES.CLOSED === current.fleet_state
  ) {
    return current;
  }
  return updateFleetManifest(repoRoot, fleetId, (fleet) => updateFleetState(fleet, STATES.DISPATCHED)).data;
}

function transitionFleetToReviewing(repoRoot, fleetId) {
  const current = readFleetManifest(repoRoot, fleetId).data;
  if (STATES.REVIEWING === current.fleet_state) return current;
  if (STATES.DISPATCHED !== current.fleet_state) return current;
  return updateFleetManifest(repoRoot, fleetId, (fleet) => updateFleetState(fleet, STATES.REVIEWING)).data;
}

function transitionFleetToClosed(repoRoot, fleetId) {
  const current = readFleetManifest(repoRoot, fleetId).data;
  if (STATES.CLOSED === current.fleet_state) return current;
  return updateFleetManifest(repoRoot, fleetId, (fleet) => updateFleetState(fleet, STATES.CLOSED)).data;
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
    .filter((record) => record && record.data?.fleet_id === fleetId)
    .sort((left, right) => {
      const leftKey = [
        left.data?.timestamps?.created_at || "",
        left.data?.run_id || path.basename(left.manifestPath),
      ].join(" ");
      const rightKey = [
        right.data?.timestamps?.created_at || "",
        right.data?.run_id || path.basename(right.manifestPath),
      ].join(" ");
      return rightKey.localeCompare(leftKey);
    });
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

function findFleetChild(fleet, leafRef) {
  return fleet.children.find((child) => child.leaf_ref === leafRef) || null;
}

function detachedDispatchRunStateSucceeded(runState) {
  return DETACHED_DISPATCH_SUCCESS_STATES.has(runState);
}

function dispatchStatusForReconciledRunState(runState) {
  if (runState === RUN_STATES.DISPATCHED) return DISPATCH_STATUS.DISPATCHING;
  if (detachedDispatchRunStateSucceeded(runState)) return DISPATCH_STATUS.DISPATCHED;
  return null;
}

function dispatchStatusForRunRecordAdoption(fleet, leafRef, record) {
  const existing = findFleetChild(fleet, leafRef);
  if (existing?.run_id && existing.run_id !== record.data.run_id) return null;
  return dispatchStatusForReconciledRunState(record.data.state);
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
    const dispatchStatus = dispatchStatusForRunRecordAdoption(fleet, leafRef, record);
    if (!dispatchStatus) continue;
    const updated = setFleetChild(repoRoot, fleetId, {
      leaf_ref: leafRef,
      run_id: record.data.run_id,
      dispatch_status: dispatchStatus,
      last_error: null,
    });
    if (updated) fleet = updated;
  }

  cleanupDeadRuntimeChildren(repoRoot, fleetId);
  const leavesByRef = new Map(leaves.map((leaf) => [leaf.leaf_ref, leaf]));
  fleet = readFleetManifest(repoRoot, fleetId).data;
  for (const child of fleet.children) {
    if (child.dispatch_status !== DISPATCH_STATUS.DISPATCHING || child.run_id) continue;
    if (childIsAlive(repoRoot, fleetId, child)) continue;
    const leaf = leavesByRef.get(child.leaf_ref);
    if (leaf && issueLockHeld(repoRoot, fleetId, leaf)) continue;
    const updated = setFleetChild(repoRoot, fleetId, {
      leaf_ref: child.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
      last_error: dispatchFailureLastError({
        fallback: "dispatch interrupted before creating a run manifest",
      }),
    });
    if (updated) fleet = updated;
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
    ["--publish-policy", leaf.publish_policy || options.publishPolicy],
  ];
  for (const [flag, value] of valueFlags) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      args.push(flag, String(value));
    }
  }
  if (leaf.register || options.register) args.push("--register");
  if (options.dryRun) args.push("--dry-run");
  else args.push("--detach");
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

function dispatchPollTimeoutMs(leaf, options) {
  const rawSeconds = Number(leaf.timeout || options.timeout || 2400);
  const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : 2400;
  const envOverride = Number(process.env.RELAY_FLEET_DISPATCH_POLL_TIMEOUT_MS || 0);
  if (Number.isFinite(envOverride) && envOverride > 0) return envOverride;
  return (seconds + 60) * 1000;
}

function readRunState(repoRoot, runId) {
  const manifestPath = getManifestPath(repoRoot, runId);
  if (!fs.existsSync(manifestPath)) return null;
  return readManifest(manifestPath).data?.state || null;
}

function detachedDispatchStatusForRunState(runState) {
  if (detachedDispatchRunStateSucceeded(runState)) return "dispatched";
  if (DETACHED_DISPATCH_FAILURE_STATES.has(runState)) return "dispatch_terminal_failure";
  return "dispatch_unexpected_state";
}

function detachedDispatchProgressForRunState(runId, runState, reconcile) {
  return {
    status: detachedDispatchStatusForRunState(runState),
    run_id: runId,
    run_state: runState,
    reconcile,
  };
}

function reconcileDryRun(repoRoot, runId) {
  try {
    return runReconcile({ repoRoot, runId, mutate: false });
  } catch (error) {
    return {
      status: "error",
      error: error.message,
    };
  }
}

function reconcileMutating(repoRoot, runId) {
  try {
    return runReconcile({ repoRoot, runId, mutate: true });
  } catch (error) {
    return {
      status: "error",
      error: error.message,
    };
  }
}

function detachedSupervisorIsAlive(repoRoot, fleetId, leaf, runId) {
  if (!fleetId || !leaf?.leaf_ref) return false;
  return childIsAlive(repoRoot, fleetId, {
    leaf_ref: leaf.leaf_ref,
    run_id: runId,
  });
}

async function waitForDetachedDispatchProgress({ repoRoot, fleetId, runId, leaf, options, isInterrupted }) {
  const deadline = Date.now() + dispatchPollTimeoutMs(leaf, options);
  let lastReconcile = null;
  while (Date.now() < deadline) {
    if (isInterrupted()) {
      return { status: "skipped_interrupted", run_id: runId, reconcile: lastReconcile, keep_runtime: true };
    }

    const runState = readRunState(repoRoot, runId);
    if (runState && runState !== RUN_STATES.DISPATCHED) {
      return detachedDispatchProgressForRunState(runId, runState, lastReconcile);
    }

    if (runState === RUN_STATES.DISPATCHED) {
      lastReconcile = reconcileDryRun(repoRoot, runId);
      if (lastReconcile.status === "error") {
        return {
          status: "dispatch_reconcile_error",
          run_id: runId,
          run_state: runState,
          reconcile: lastReconcile,
          keep_runtime: detachedSupervisorIsAlive(repoRoot, fleetId, leaf, runId),
        };
      }
      if (lastReconcile.rowName === "lease_live_timed_out") {
        return {
          status: "dispatch_timeout",
          run_id: runId,
          run_state: runState,
          reconcile: lastReconcile,
          keep_runtime: true,
        };
      }
      if (lastReconcile.rowName === "dead_with_result_or_work") {
        // This branch used to mutate immediately on any dry-run row-4 verdict,
        // bypassing the poll deadline. Re-probe the authoritative lease
        // supervisor pid before allowing that destructive transition.
        if (getRunLeaseStatus(repoRoot, runId).live) {
          await sleepAsync(2000);
          continue;
        }
        const healed = reconcileMutating(repoRoot, runId);
        if (healed.status === "error") {
          return {
            status: "dispatch_reconcile_error",
            run_id: runId,
            run_state: runState,
            reconcile: healed,
            keep_runtime: detachedSupervisorIsAlive(repoRoot, fleetId, leaf, runId),
          };
        }
        return {
          status: healed.state === RUN_STATES.DISPATCHED
            ? "dispatch_reconcile_incomplete"
            : detachedDispatchStatusForRunState(healed.state),
          run_id: runId,
          run_state: healed.state,
          reconcile: healed,
          keep_runtime: healed.state === RUN_STATES.DISPATCHED
            && detachedSupervisorIsAlive(repoRoot, fleetId, leaf, runId),
        };
      }
      if (lastReconcile.rowName === "dead_no_result_no_work") {
        if (detachedSupervisorIsAlive(repoRoot, fleetId, leaf, runId)) {
          return {
            status: "dispatch_poll_timeout",
            run_id: runId,
            run_state: runState,
            reconcile: lastReconcile,
            keep_runtime: true,
          };
        }
        const healed = reconcileMutating(repoRoot, runId);
        if (healed.status === "error") {
          return {
            status: "dispatch_reconcile_error",
            run_id: runId,
            run_state: runState,
            reconcile: healed,
            keep_runtime: false,
          };
        }
        return {
          status: "dispatch_interrupted",
          run_id: runId,
          run_state: healed.state,
          reconcile: healed,
        };
      }
      if (lastReconcile.rowName === "not_dispatched") {
        return detachedDispatchProgressForRunState(runId, lastReconcile.state, lastReconcile);
      }
    }

    await sleepAsync(runState === RUN_STATES.DISPATCHED ? 2000 : 250);
  }

  const finalRunState = readRunState(repoRoot, runId);
  const liveLease = finalRunState === RUN_STATES.DISPATCHED
    && getRunLeaseStatus(repoRoot, runId).live;
  return {
    status: liveLease ? "dispatch_still_running" : "dispatch_poll_timeout",
    run_id: runId,
    run_state: finalRunState,
    reconcile: lastReconcile,
    keep_runtime: liveLease || detachedSupervisorIsAlive(repoRoot, fleetId, leaf, runId),
  };
}

function detachedDispatchSucceeded(progress) {
  return progress?.status === "dispatched";
}

function detachedDispatchKeepsRuntime(progress) {
  return progress?.keep_runtime === true || progress?.status === "skipped_interrupted";
}

function dispatchStatusForDetachedProgress(progress) {
  if (detachedDispatchSucceeded(progress)) return DISPATCH_STATUS.DISPATCHED;
  if (detachedDispatchKeepsRuntime(progress)) return DISPATCH_STATUS.DISPATCHING;
  return DISPATCH_STATUS.PENDING;
}

function childNeedsResumeDispatchPoll(child) {
  return child?.dispatch_status === DISPATCH_STATUS.DISPATCHING && Boolean(child.run_id);
}

function selectResumeDispatchPollChildren(repoRoot, fleetId, leaves) {
  const fleet = readFleetManifest(repoRoot, fleetId).data;
  const leavesByRef = new Map(leaves.map((leaf) => [leaf.leaf_ref, leaf]));
  return fleet.children
    .filter(childNeedsResumeDispatchPoll)
    .map((child) => ({
      child,
      leaf: leavesByRef.get(child.leaf_ref) || { leaf_ref: child.leaf_ref },
    }));
}

async function pollResumeDispatchForChild({ repoRoot, fleetId, leaf, child, options, isInterrupted }) {
  const progress = await waitForDetachedDispatchProgress({
    repoRoot,
    fleetId,
    runId: child.run_id,
    leaf,
    options,
    isInterrupted,
  });
  if (!detachedDispatchKeepsRuntime(progress)) {
    removeRuntimeChild(repoRoot, fleetId, child.leaf_ref);
  }
  setFleetChild(repoRoot, fleetId, {
    leaf_ref: child.leaf_ref,
    run_id: child.run_id,
    dispatch_status: dispatchStatusForDetachedProgress(progress),
    last_error: null,
  });
  return {
    leaf_ref: child.leaf_ref,
    status: progress.status,
    run_id: child.run_id,
    reconcile: progress.reconcile,
    run_state: progress.run_state,
  };
}

async function pollResumeDispatchingChildren({ repoRoot, fleetId, leaves, options, isInterrupted }) {
  const children = selectResumeDispatchPollChildren(repoRoot, fleetId, leaves);
  return runPool(children, options.parallel, ({ leaf, child }) => {
    return pollResumeDispatchForChild({
      repoRoot,
      fleetId,
      leaf,
      child,
      options,
      isInterrupted,
    });
  });
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

function buildPublishArgs({ repoRoot, runId, options }) {
  return [
    options.publishScript,
    "--repo", repoRoot,
    "--run-id", runId,
    "--json",
  ];
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
    && [
      RUN_STATES.INTERNAL_REVIEW_PENDING,
      RUN_STATES.REVIEW_PENDING,
    ].includes(summaryChild.run_state);
}

function childNeedsReviewLoop(summaryChild) {
  return summaryChild.dispatch_status === DISPATCH_STATUS.DISPATCHED
    && summaryChild.run_id
    && [
      RUN_STATES.INTERNAL_REVIEW_PENDING,
      RUN_STATES.PUBLISH_PENDING,
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
    if (childIsAlive(repoRoot, fleetId, child)) {
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

function spawnPublishForChild({ repoRoot, fleetId, child, options, activeChildren, isInterrupted }) {
  return new Promise((resolve) => {
    if (isInterrupted()) {
      resolve({ leaf_ref: child.leaf_ref, run_id: child.run_id, status: "skipped_interrupted" });
      return;
    }
    if (childIsAlive(repoRoot, fleetId, child)) {
      resolve({ leaf_ref: child.leaf_ref, run_id: child.run_id, status: "skipped_running", run_state: child.run_state });
      return;
    }

    const before = childReviewSnapshot(repoRoot, child.run_id);
    const args = buildPublishArgs({ repoRoot, runId: child.run_id, options });
    const publish = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    activeChildren.set(child.leaf_ref, publish);
    upsertRuntimeProcess(repoRoot, fleetId, child.leaf_ref, publish, { phase: "publish", run_id: child.run_id });
    publish.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
    publish.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
    publish.once("error", (error) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child.leaf_ref);
      removeRuntimeChild(repoRoot, fleetId, child.leaf_ref);
      resolve({ leaf_ref: child.leaf_ref, run_id: child.run_id, status: "publish_failed", error: error.message });
    });
    publish.once("close", (code, signal) => {
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
          status: "publish_failed",
          exit_code: code,
          signal,
          stderr,
          error: `failed to read child manifest after publish: ${error.message}`,
        });
        return;
      }

      // Publishing counts as progress only when the child manifest state changes; a clean exit with no state movement is stalled.
      if (after.state === before.state) {
        resolve({
          leaf_ref: child.leaf_ref,
          run_id: child.run_id,
          status: "publish_stalled",
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
        status: code === 0 ? "published" : "published_with_child_failure",
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

function spawnRedispatchForChild({ repoRoot, fleetId, child, options, activeChildren, isInterrupted }) {
  return new Promise((resolve) => {
    if (isInterrupted()) {
      resolve({ leaf_ref: child.leaf_ref, run_id: child.run_id, status: "skipped_interrupted" });
      return;
    }
    if (childIsAlive(repoRoot, fleetId, child)) {
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

async function spawnDispatchForLeaf({ repoRoot, fleetId, leaf, options, activeChildren, isInterrupted }) {
  if (isInterrupted()) {
    return { leaf_ref: leaf.leaf_ref, status: "skipped_interrupted" };
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
        return { leaf_ref: leaf.leaf_ref, status: "failed", error: String(error.message || error) };
      }
      const updated = setFleetChild(repoRoot, fleetId, {
        leaf_ref: leaf.leaf_ref,
        run_id: null,
        dispatch_status: DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
        last_error: dispatchFailureLastError({ error: error.message }),
      });
      if (!updated) {
        return { leaf_ref: leaf.leaf_ref, status: "skipped_replaced" };
      }
      return { leaf_ref: leaf.leaf_ref, status: "dispatch_failed_pre_manifest", error: error.message };
    }

    const updated = setFleetChild(repoRoot, fleetId, {
      leaf_ref: leaf.leaf_ref,
      run_id: null,
      dispatch_status: DISPATCH_STATUS.DISPATCHING,
      last_error: null,
    });
    if (!updated) {
      return { leaf_ref: leaf.leaf_ref, status: "skipped_replaced" };
    }
  }

  const args = buildDispatchArgs({ repoRoot, fleetId, leaf, options });
  const launch = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    activeChildren.set(leaf.leaf_ref, child);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(leaf.leaf_ref);
      resolve({ code: 1, signal: null, stdout, stderr, error: error.message });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(leaf.leaf_ref);
      resolve({ code: code ?? 1, signal, stdout, stderr, error: null });
    });
  });

  const payload = parseDispatchJson(launch.stdout);
  if (options.dryRun) {
    return {
      leaf_ref: leaf.leaf_ref,
      status: launch.code === 0 ? "dry_run" : "dry_run_failed",
      exit_code: launch.code,
      signal: launch.signal,
      payload,
      stderr: launch.stderr,
      error: launch.error,
    };
  }

  let runId = payload?.runId || null;
  if (!runId) {
    const record = findRunRecordForLeaf(listFleetRunRecords(repoRoot, fleetId), leaf);
    runId = record?.data?.run_id || null;
  }

  if (!runId || launch.code !== 0) {
    const keepRuntime = Boolean(runId && payload?.supervisorPid);
    const lastError = dispatchFailureLastError({
      error: payload?.error || launch.error,
      stderr: launch.stderr,
      fallback: launch.signal
        ? `dispatch process terminated by ${launch.signal}`
        : `dispatch process exited with code ${launch.code}`,
    });
    setFleetChild(repoRoot, fleetId, {
      leaf_ref: leaf.leaf_ref,
      run_id: runId,
      dispatch_status: runId
        ? (keepRuntime ? DISPATCH_STATUS.DISPATCHING : DISPATCH_STATUS.PENDING)
        : DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST,
      last_error: lastError,
    });
    if (keepRuntime) {
      upsertRuntimeProcess(repoRoot, fleetId, leaf.leaf_ref, { pid: payload.supervisorPid }, {
        phase: "dispatch",
        run_id: runId,
        branch: leaf.branch,
        issue_number: leaf.issue_number,
      });
    }
    return {
      leaf_ref: leaf.leaf_ref,
      status: runId ? "dispatched_with_child_failure" : "dispatch_failed_pre_manifest",
      run_id: runId,
      exit_code: launch.code,
      signal: launch.signal,
      stderr: launch.stderr,
      payload,
      error: launch.error,
    };
  }

  setFleetChild(repoRoot, fleetId, {
    leaf_ref: leaf.leaf_ref,
    run_id: runId,
    dispatch_status: DISPATCH_STATUS.DISPATCHING,
    last_error: null,
  });
  if (payload?.supervisorPid) {
    upsertRuntimeProcess(repoRoot, fleetId, leaf.leaf_ref, { pid: payload.supervisorPid }, {
      phase: "dispatch",
      run_id: runId,
      branch: leaf.branch,
      issue_number: leaf.issue_number,
    });
  }

  const progress = await waitForDetachedDispatchProgress({
    repoRoot,
    fleetId,
    runId,
    leaf,
    options,
    isInterrupted,
  });
  if (!detachedDispatchKeepsRuntime(progress)) {
    removeRuntimeChild(repoRoot, fleetId, leaf.leaf_ref);
  }
  setFleetChild(repoRoot, fleetId, {
    leaf_ref: leaf.leaf_ref,
    run_id: runId,
    dispatch_status: dispatchStatusForDetachedProgress(progress),
    last_error: null,
  });

  return {
    leaf_ref: leaf.leaf_ref,
    status: progress.status,
    run_id: runId,
    exit_code: launch.code,
    signal: launch.signal,
    stderr: launch.stderr,
    payload,
    reconcile: progress.reconcile,
    run_state: progress.run_state,
  };
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

function dispatchFanoutFailed(children) {
  return children.some((child) => child?.status !== "dispatched");
}

function fleetDispatchIncomplete(summary) {
  return summary.children.some((child) => child.dispatch_status !== DISPATCH_STATUS.DISPATCHED);
}

// Mirrors skills/relay-merge/scripts/finalize-run.js's fetchDefaultBranchName
// (gh repo view --json defaultBranchRef) without importing from relay-merge,
// which is frozen for this change. Returns null on any failure (no remote, gh
// unavailable, offline) so callers must treat a null default branch as
// "unknown" rather than a mismatch.
function resolveFleetDefaultBranch(repoRoot) {
  try {
    const raw = execGh(repoRoot, ["repo", "view", "--json", "defaultBranchRef"]);
    const parsed = JSON.parse(raw);
    return parsed?.defaultBranchRef?.name || null;
  } catch {
    return null;
  }
}

const MISSING_PR_RUN_STATES = new Set([
  RUN_STATES.REVIEW_PENDING,
  RUN_STATES.READY_TO_MERGE,
  RUN_STATES.MERGE_BLOCKED,
]);
const KNOWN_RUN_STATES = new Set(Object.values(RUN_STATES));

// The four original reasons, preserved byte-identical: at most one of these
// ever applies to a given child (dispatch_failed_pre_manifest requires
// run_id:null, which forces run_state to "no_run_manifest" and so can never
// co-occur with missing_manifest/escalated/changes_requested).
function legacyAttentionReason(child) {
  if (child.dispatch_status === DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST) {
    return DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST;
  }
  if (child.run_state === "missing_manifest") return "missing_manifest";
  if (child.run_state === "escalated") return "escalated";
  if (child.run_state === "changes_requested") return "changes_requested";
  return null;
}

function resolveStallThresholdMs(env = process.env) {
  const raw = env.RELAY_FLEET_STALL_THRESHOLD_MS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_STALL_THRESHOLD_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STALL_THRESHOLD_MS;
  return parsed;
}

function readLastNonEmptyStderrLine(stderrPath) {
  try {
    const text = fs.readFileSync(stderrPath, "utf-8");
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      return line.length > STALL_STDERR_TAIL_MAX_CHARS
        ? line.slice(0, STALL_STDERR_TAIL_MAX_CHARS)
        : line;
    }
    return null;
  } catch {
    return null;
  }
}

// Visibility only (#931 / #839 boundary): no kill, signal, or state mutation.
// Stateless heuristic — live lease (#927 getRunLeaseStatus) AND 0-byte stdout
// AND lease age over threshold. First-byte limitation: once stdout has any
// bytes, mid-run silence is invisible here.
function detectStalledExecutor(repoRoot, child, { thresholdMs = resolveStallThresholdMs() } = {}) {
  if (!repoRoot || !child?.run_id) return null;
  if (child.dispatch_status !== DISPATCH_STATUS.DISPATCHED) return null;
  if (!KNOWN_RUN_STATES.has(child.run_state)) return null;
  if (terminalForFleetReview(child.run_state)) return null;

  let leaseStatus;
  try {
    leaseStatus = getRunLeaseStatus(repoRoot, child.run_id);
  } catch {
    return null;
  }
  if (!leaseStatus?.live || !leaseStatus.lease) return null;

  const startedAtMs = Date.parse(leaseStatus.lease.started_at);
  if (!Number.isFinite(startedAtMs)) return null;
  const ageMs = Date.now() - startedAtMs;
  if (ageMs <= thresholdMs) return null;

  const { stdoutLog, stderrLog } = getRunArtifactPaths(repoRoot, child.run_id);
  let stdoutStat;
  try {
    stdoutStat = fs.statSync(stdoutLog);
  } catch {
    // Missing or unreadable stdout path → fail open (no item, no crash).
    return null;
  }
  if (!stdoutStat.isFile() || stdoutStat.size !== 0) return null;

  const minutes = Math.floor(ageMs / 60000);
  let detail = `stdout 0 bytes for ${minutes}m`;
  const stderrTail = readLastNonEmptyStderrLine(stderrLog);
  if (stderrTail) detail += `; stderr tail: ${stderrTail}`;
  return { detail };
}

// New reasons are independent of each other and of the legacy reason above, so
// a single child can surface more than one attention item.
function additionalAttentionReasons(child, { repoRoot, fleetId, defaultBranchName }) {
  const reasons = [];

  if (MISSING_PR_RUN_STATES.has(child.run_state) && !child.pr_number) {
    reasons.push("missing_pr");
  }
  if (child.run_state === RUN_STATES.MERGE_BLOCKED) {
    reasons.push("merge_blocked");
  }
  if (Number(child.review_round) >= 3) {
    reasons.push("high_review_rounds");
  }
  if (child.base_branch && defaultBranchName && child.base_branch !== defaultBranchName) {
    reasons.push("stale_base");
  }
  if (
    child.dispatch_status === DISPATCH_STATUS.DISPATCHED
    && KNOWN_RUN_STATES.has(child.run_state)
    && !terminalForFleetReview(child.run_state)
    && repoRoot
    && fleetId
    && !childIsAlive(repoRoot, fleetId, child)
  ) {
    reasons.push("stuck_child");
  }
  if (detectStalledExecutor(repoRoot, child)) {
    reasons.push("stalled_executor");
  }

  return reasons;
}

// Derive-on-read (#901): when a stuck child was blocked by review preflight,
// surface the actionable next_action/reason from the latest review_preflight_failed
// event — but only while that blocked attempt has not been superseded by a
// completed review round (event.round > review.rounds). Fail-open on missing
// or unreadable events so attention stays the bare stuck_child shape.
function stuckChildPreflightEnrichment(repoRoot, child) {
  if (!repoRoot || !child?.run_id) return {};
  let events;
  try {
    events = readRunEvents(repoRoot, child.run_id);
  } catch {
    return {};
  }
  let latest = null;
  for (const event of events) {
    if (event?.event === EVENTS.REVIEW_PREFLIGHT_FAILED) latest = event;
  }
  if (!latest) return {};
  if (!(Number(latest.round) > Number(child.review_round ?? 0))) return {};

  const enrichment = {};
  if (latest.reason != null && latest.reason !== "") {
    enrichment.detail = String(latest.reason);
  }
  // Missing-vs-empty: older events without next_action must omit the key
  // entirely — never empty-string it.
  if (
    Object.prototype.hasOwnProperty.call(latest, "next_action")
    && latest.next_action != null
    && latest.next_action !== ""
  ) {
    enrichment.next_action = String(latest.next_action);
  }
  return enrichment;
}

function buildOperatorAttention(summary, context = {}) {
  const { repoRoot, fleetId } = context;
  const needsDefaultBranch = summary.children.some((child) => child.base_branch);
  const defaultBranchName = needsDefaultBranch && repoRoot ? resolveFleetDefaultBranch(repoRoot) : null;
  const resolvedContext = { repoRoot, fleetId, defaultBranchName };

  const items = [];
  for (const child of summary.children) {
    const legacyReason = legacyAttentionReason(child);
    if (legacyReason) {
      items.push({ leaf_ref: child.leaf_ref, run_id: child.run_id, reason: legacyReason });
    }
    for (const reason of additionalAttentionReasons(child, resolvedContext)) {
      const item = { leaf_ref: child.leaf_ref, run_id: child.run_id, reason };
      if (reason === "stuck_child") {
        Object.assign(item, stuckChildPreflightEnrichment(repoRoot, child));
      }
      if (reason === "stalled_executor") {
        Object.assign(item, detectStalledExecutor(repoRoot, child) || {});
      }
      items.push(item);
    }
  }
  return items;
}

function formatAttentionLine(item) {
  let line = `  - ${item.leaf_ref}: ${item.reason}${item.run_id ? ` (${item.run_id})` : ""}`;
  if (item.next_action && item.detail) {
    line += ` → next: ${item.next_action} — ${item.detail}`;
  } else if (item.next_action) {
    line += ` → next: ${item.next_action}`;
  } else if (item.detail) {
    line += ` — ${item.detail}`;
  }
  return line;
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
      const childLine = [
        `  - ${child.leaf_ref}`,
        `run_id=${child.run_id || "null"}`,
        `dispatch_status=${child.dispatch_status}`,
        `run_state=${child.run_state || "unknown"}`,
      ];
      if (child.last_error) childLine.push(`last_error=${child.last_error}`);
      lines.push(childLine.join(" | "));
    }
  } else {
    lines.push("  (none)");
  }
  if (operatorAttention.length) {
    lines.push("Needs operator attention:");
    for (const item of operatorAttention) {
      lines.push(formatAttentionLine(item));
    }
  }
  return `${lines.join("\n")}\n`;
}

function fleetListingError(manifestPath, error) {
  const message = String(error?.message || error).replace(/\s+/g, " ").trim();
  return `${path.basename(manifestPath)}: ${message}`;
}

function fleetListingRow(repoRoot, manifestPath) {
  const manifestFile = path.basename(manifestPath);
  const fleetId = manifestFile.slice(0, -path.extname(manifestFile).length);
  try {
    const fleet = readFleetManifest(repoRoot, fleetId).data;
    const summary = deriveFleetSummary(repoRoot, fleet);
    return {
      fleet_id: summary.fleet_id,
      fleet_state: summary.fleet_state,
      children_total: summary.total_children,
      children_terminal: summary.children.filter(fleetChildIsTerminal).length,
      updated_at: fleet.timestamps.updated_at || fleet.timestamps.created_at || null,
    };
  } catch (error) {
    return {
      fleet_id: fleetId,
      fleet_state: "error",
      children_total: null,
      children_terminal: null,
      updated_at: null,
      error: fleetListingError(manifestPath, error),
    };
  }
}

function listFleetStatus(repoRoot) {
  return listFleetManifestPaths(repoRoot)
    .map((manifestPath) => fleetListingRow(repoRoot, manifestPath))
    .sort((left, right) => left.fleet_id.localeCompare(right.fleet_id));
}

function formatFleetStatusListingText(rows) {
  if (!rows.length) return "No fleets found for repository.\n";
  const lines = [
    `Fleets: ${rows.length}`,
    "fleet_id | fleet_state | children_terminal/children_total | updated_at",
  ];
  for (const row of rows) {
    const childCounts = row.children_total === null ? "-/-" : `${row.children_terminal}/${row.children_total}`;
    const columns = [row.fleet_id, row.fleet_state, childCounts, row.updated_at || "-"];
    if (row.error) columns.push(`error=${row.error}`);
    lines.push(columns.join(" | "));
  }
  return `${lines.join("\n")}\n`;
}

function formatPreManifestRetryLine(summary, fleetId) {
  const failedLeaves = (summary?.children || [])
    .filter((child) => child.dispatch_status === DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST)
    .map((child) => child.leaf_ref);
  if (!failedLeaves.length) return null;
  return [
    `Pre-manifest dispatch failed for leaf(s): ${failedLeaves.join(", ")}.`,
    `To retry, re-run the same command with --fleet-id ${fleetId}; relay-fleet will re-dispatch those children.`,
  ].join(" ");
}

function writeReplacementNotes(result) {
  for (const replacement of result?.replaced_children || []) {
    console.error(
      `relay-fleet replaced child in fleet '${result.fleet_id}': ${replacement.old_leaf_ref} -> ${replacement.new_leaf_ref}`
    );
  }
}

async function statusFleet({ repoRoot, fleetId }) {
  const fleet = readFleetManifest(repoRoot, fleetId).data;
  const summary = deriveFleetSummary(repoRoot, fleet);
  return { summary, operator_attention: buildOperatorAttention(summary, { repoRoot, fleetId }) };
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
    "publish_failed",
    "publish_stalled",
    "published_with_child_failure",
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

    if ([RUN_STATES.INTERNAL_REVIEW_PENDING, RUN_STATES.REVIEW_PENDING].includes(current.run_state)) {
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
    } else if (current.run_state === RUN_STATES.PUBLISH_PENDING) {
      // Resume already-reviewed children by publishing first, then re-entering the public review loop.
      const publish = await spawnPublishForChild({
        repoRoot,
        fleetId,
        child: current,
        options,
        activeChildren,
        isInterrupted,
      });
      steps.push({ phase: "publish", ...publish });
      if (loopStepFailed(publish) || publish.status === "skipped_running") {
        return {
          leaf_ref: child.leaf_ref,
          run_id: child.run_id,
          status: publish.status,
          run_state: publish.after?.state || current.run_state,
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
  const operatorAttention = buildOperatorAttention(summary, { repoRoot, fleetId });
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

const FLEET_TERMINAL_RUN_STATES = new Set([
  RUN_STATES.MERGED,
  RUN_STATES.CLOSED,
  RUN_STATES.ESCALATED,
]);

function fleetChildIsTerminal(child) {
  return child.dispatch_status === DISPATCH_STATUS.DISPATCHED
    && FLEET_TERMINAL_RUN_STATES.has(child.run_state);
}

function fleetChildrenAreTerminal(summary) {
  return summary.total_children > 0
    && summary.children.every(fleetChildIsTerminal);
}

function closeFleetIfTerminal(repoRoot, fleetId) {
  const summary = deriveFleetSummary(repoRoot, readFleetManifest(repoRoot, fleetId).data);
  if (!fleetChildrenAreTerminal(summary)) return readFleetManifest(repoRoot, fleetId).data;
  return transitionFleetToClosed(repoRoot, fleetId);
}

function fleetHasReadyMergeCandidate(summary) {
  return summary.children.some((child) => {
    return child.dispatch_status === DISPATCH_STATUS.DISPATCHED
      && child.run_id
      && child.run_state === RUN_STATES.READY_TO_MERGE;
  });
}

function fleetHasReviewWork(summary) {
  return summary.children.some(childNeedsReviewLoop);
}

function readDriveLeaves({ repoRoot, fleetId, manifestPath, options }) {
  const manifestExists = fs.existsSync(manifestPath);
  const explicitLeaves = options.leavesFile ? loadLeavesFile(options.leavesFile) : null;

  if (options.dryRun) {
    if (!explicitLeaves) {
      throw new FleetInputError("--leaves-file is required for --dry-run");
    }
    validateLeafLineage(repoRoot, explicitLeaves);
    return { leaves: explicitLeaves, explicitLeaves, manifestExists, replacedChildren: [] };
  }

  if (!manifestExists) {
    if (!explicitLeaves) {
      throw new FleetInputError(`fleet manifest does not exist: ${manifestPath}; nothing to continue`);
    }
    validateLeafLineage(repoRoot, explicitLeaves);
    return { leaves: explicitLeaves, explicitLeaves, manifestExists, replacedChildren: [] };
  }

  const recoveredReplacements = recoverAcceptedLeafReplacement(repoRoot, fleetId);

  if (explicitLeaves) {
    const persisted = assertLeavesMatchPersisted(repoRoot, fleetId, explicitLeaves);
    validateLeafLineage(repoRoot, explicitLeaves);
    if (persisted.replacements.length > 0) {
      const replacements = applyAcceptedLeafReplacements(repoRoot, fleetId, explicitLeaves);
      return {
        leaves: explicitLeaves,
        explicitLeaves,
        manifestExists,
        replacedChildren: replacements,
      };
    }
    if (!persisted.leaves) {
      persistFleetLeaves(repoRoot, fleetId, explicitLeaves);
      return { leaves: explicitLeaves, explicitLeaves, manifestExists, replacedChildren: recoveredReplacements };
    }
    return { leaves: persisted.leaves, explicitLeaves, manifestExists, replacedChildren: recoveredReplacements };
  }

  return {
    leaves: readPersistedLeaves(repoRoot, fleetId),
    explicitLeaves: null,
    manifestExists,
    replacedChildren: recoveredReplacements,
  };
}

function ensureFleetForDrive({ repoRoot, fleetId, manifestExists, leaves }) {
  if (!manifestExists) {
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
    return;
  }

  const current = readFleetManifest(repoRoot, fleetId).data;
  if (STATES.DRAFT === current.fleet_state) transitionFleetToDispatching(repoRoot, fleetId);
}

async function dispatchFleetPhase({ repoRoot, fleetId, leaves, options, activeChildren, isInterrupted }) {
  reconcileFleet(repoRoot, fleetId, leaves);
  const resumePollChildren = await pollResumeDispatchingChildren({
    repoRoot,
    fleetId,
    leaves,
    options,
    isInterrupted,
  });
  reconcileFleet(repoRoot, fleetId, leaves);
  const dispatchLeaves = selectLeavesToDispatch(repoRoot, fleetId, leaves);
  validateLeafFiles(dispatchLeaves);
  const dispatchChildren = await runPool(dispatchLeaves, options.parallel, (leaf) => {
    return spawnDispatchForLeaf({
      repoRoot,
      fleetId,
      leaf,
      options,
      activeChildren,
      isInterrupted,
    });
  });
  const children = [...resumePollChildren, ...dispatchChildren];
  reconcileFleet(repoRoot, fleetId, leaves);
  const fleet = maybeFinalizeFleet(repoRoot, fleetId);
  const summary = deriveFleetSummary(repoRoot, fleet);
  const operatorAttention = buildOperatorAttention(summary, { repoRoot, fleetId });
  const preManifestFailures = summary.children
    .some((child) => child.dispatch_status === DISPATCH_STATUS.DISPATCH_FAILED_PRE_MANIFEST);
  const dispatchFailures = dispatchFanoutFailed(dispatchChildren);
  const incompleteDispatches = fleetDispatchIncomplete(summary);

  return {
    ok: !isInterrupted() && !preManifestFailures && !dispatchFailures && !incompleteDispatches,
    interrupted: isInterrupted(),
    fleet_id: fleetId,
    children,
    preManifestFailures,
    dispatchFailures,
    incompleteDispatches,
    summary,
    operator_attention: operatorAttention,
  };
}

async function mergeFleetPhase({ repoRoot, fleetId, options }) {
  const current = readFleetManifest(repoRoot, fleetId).data;
  if (STATES.CLOSED === current.fleet_state) return null;

  const summary = deriveFleetSummary(repoRoot, current);
  const shouldRunMergeQueue = fleetHasReadyMergeCandidate(summary)
    || STATES.MERGING === current.fleet_state;
  if (!shouldRunMergeQueue) return null;

  if (STATES.DISPATCHING === current.fleet_state) {
    updateFleetManifest(repoRoot, fleetId, (fleet) => updateFleetState(fleet, STATES.DISPATCHED));
    transitionFleetToReviewing(repoRoot, fleetId);
  }

  if (STATES.DISPATCHED === current.fleet_state) {
    transitionFleetToReviewing(repoRoot, fleetId);
  }

  const mergeReadyState = readFleetManifest(repoRoot, fleetId).data.fleet_state;
  if (![STATES.REVIEWING, STATES.MERGING].includes(mergeReadyState)) {
    return null;
  }

  return runMergeQueue({
    repo: repoRoot,
    fleetId,
    finalizeScript: options.finalizeScript,
    mergeMethod: options.mergeMethod,
    dryRun: options.dryRun,
  });
}

function buildDriveResult({
  repoRoot,
  fleetId,
  fleetManifestPath,
  interrupted,
  dispatchResult = null,
  reviewResult = null,
  mergeResult = null,
  deprecatedAliases = [],
  replacedChildren = [],
}) {
  closeFleetIfTerminal(repoRoot, fleetId);
  const summary = deriveFleetSummary(repoRoot, readFleetManifest(repoRoot, fleetId).data);
  const operatorAttention = buildOperatorAttention(summary, { repoRoot, fleetId });
  const ok = !interrupted
    && fleetChildrenAreTerminal(summary)
    && operatorAttention.length === 0;

  return {
    ok,
    interrupted,
    fleet_id: fleetId,
    fleetManifestPath,
    deprecated_aliases: deprecatedAliases,
    replaced_children: replacedChildren,
    children: dispatchResult?.children || [],
    dispatch_children: dispatchResult?.children || [],
    reviewed_children: reviewResult?.reviewed_children || [],
    skipped_children: reviewResult?.skipped_children || [],
    merge_results: mergeResult?.results || [],
    merge_queued_children: mergeResult?.queued_children || [],
    summary,
    operator_attention: operatorAttention,
  };
}

async function runFleet(options) {
  const repoRoot = getCanonicalRepoRoot(options.repo || ".");
  if (options.status && !options.fleetId) {
    return listFleetStatus(repoRoot);
  }
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

  const { leaves, manifestExists, replacedChildren } = readDriveLeaves({ repoRoot, fleetId, manifestPath, options });

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
      replaced_children: replacedChildren,
      children,
    };
  }

  ensureFleetForDrive({ repoRoot, fleetId, manifestExists, leaves });

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
    const deprecatedAliases = options.resume ? ["--resume"] : [];
    const dispatchResult = await dispatchFleetPhase({
      repoRoot,
      fleetId,
      leaves,
      options,
      activeChildren,
      isInterrupted: () => interrupted,
    });

    if (interrupted) {
      return {
        ...dispatchResult,
        ok: false,
        interrupted,
        fleetManifestPath: manifestPath,
        deprecated_aliases: deprecatedAliases,
        replaced_children: replacedChildren,
      };
    }

    let reviewResult = null;
    const afterDispatchSummary = deriveFleetSummary(repoRoot, readFleetManifest(repoRoot, fleetId).data);
    if (fleetHasReviewWork(afterDispatchSummary)) {
      reviewResult = await reviewFleet({
        repoRoot,
        fleetId,
        options,
        activeChildren,
        isInterrupted: () => interrupted,
      });
      if (!reviewResult.ok) {
        return buildDriveResult({
          repoRoot,
          fleetId,
          fleetManifestPath: manifestPath,
          interrupted,
          dispatchResult,
          reviewResult,
          deprecatedAliases,
          replacedChildren,
        });
      }
    }

    const mergeResult = await mergeFleetPhase({ repoRoot, fleetId, options });
    return buildDriveResult({
      repoRoot,
      fleetId,
      fleetManifestPath: manifestPath,
      interrupted,
      dispatchResult,
      reviewResult,
      mergeResult,
      deprecatedAliases,
      replacedChildren,
    });
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
    if (!options.fleetId && !options.status) {
      throw new FleetInputError("--fleet-id is required");
    }
    if (options.status && (options.resume || options.leavesFile || options.dryRun)) {
      throw new FleetInputError("--status is read-only and cannot be combined with --resume, --leaves-file, or --dry-run");
    }
    if (options.review && (options.resume || options.leavesFile || options.dryRun || options.status)) {
      throw new FleetInputError("--review cannot be combined with --resume, --leaves-file, --dry-run, or --status");
    }
    const result = await runFleet({ ...options, installSignalHandlers: true });
    writeReplacementNotes(result);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (options.status) {
      process.stdout.write(Array.isArray(result)
        ? formatFleetStatusListingText(result)
        : formatStatusText(result.summary, result.operator_attention));
    } else {
      const summary = result.summary
        ? `fleet=${result.fleet_id} children=${result.summary.total_children}`
        : `fleet=${result.fleet_id} children=${result.children.length}`;
      console.log(result.ok ? `relay-fleet complete: ${summary}` : `relay-fleet needs attention: ${summary}`);
      const retryLine = result.summary ? formatPreManifestRetryLine(result.summary, result.fleet_id) : null;
      if (!result.ok && retryLine) console.log(retryLine);
    }
    return Array.isArray(result) ? 0 : (result.ok ? 0 : 1);
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
  buildPublishArgs,
  buildRedispatchArgs,
  buildReviewArgs,
  formatFleetStatusListingText,
  formatStatusText,
  getFleetLeafReplacementPath,
  getFleetLeavesStorePath,
  getFleetRuntimePath,
  loadLeavesFile,
  listFleetStatus,
  main,
  parseArgs,
  reconcileFleet,
  reviewFleet,
  runFleet,
  statusFleet,
  withFleetChildLock,
};
