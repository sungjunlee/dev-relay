#!/usr/bin/env node
"use strict";

// Fleet vNext is intentionally a view, not a second runtime.  The only fleet
// artifact is an immutable cohort; every status is derived from child runs.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { bindCliArgs, findUnknownFlags, modeLabel } = require("../../relay-dispatch/scripts/cli-args");
const {
  getCanonicalRepoRoot, getFleetsDir, getFleetManifestPath, getManifestPath, getRunDir, getRunsDir,
  listManifestPaths, requireValidFleetId, requireValidRunId,
} = require("../../relay-dispatch/scripts/manifest/paths");
const { readManifest } = require("../../relay-dispatch/scripts/manifest/store");
const { fsyncDirectory, readRunRecord } = require("../../relay-dispatch/scripts/run-store");
const { readFacts } = require("../../relay-dispatch/scripts/facts");
const { foldRunFacts } = require("../../relay-dispatch/scripts/run-fold");
const { STATES: RUN_STATES } = require("../../relay-dispatch/scripts/manifest/lifecycle");
const { normalizeOwnership, validateOwnershipAgainstSprintState } = require("../../relay-dispatch/scripts/ownership");

const DEFAULT_PARALLEL = 4;
const DEFAULT_DISPATCH_SCRIPT = path.join(__dirname, "..", "..", "relay-dispatch", "scripts", "dispatch.js");
const DEFAULT_REVIEW_SCRIPT = path.join(__dirname, "..", "..", "relay-review", "scripts", "review-runner.js");
const DEFAULT_FINALIZE_SCRIPT = path.join(__dirname, "..", "..", "relay-merge", "scripts", "finalize-run.js");
const KNOWN_FLAGS = [
  "--repo", "--fleet-id", "--leaves-file", "--status", "--review", "--parallel",
  "--dispatch-script", "--review-script", "--executor", "--model", "--sandbox", "--network-access",
  "--timeout", "--reasoning", "--copy", "--test-command", "--publish-policy", "--register",
  "--reviewer", "--reviewer-model", "--finalize-script", "--merge-method", "--dry-run", "--json", "--help", "-h",
];
const BOOLEAN_FLAGS = ["--status", "--review", "--register", "--dry-run", "--json", "--help", "-h"];
// Only opaque text/path transport may consume a next token that resembles a
// flag. Selector and numeric values deliberately remain parsed, so a missing
// `--parallel` value cannot swallow a following `--json` boolean.
const VERBATIM_VALUE_FLAGS = [
  "--repo", "--leaves-file", "--dispatch-script", "--review-script", "--finalize-script",
  "--copy", "--test-command",
];
const CLI_ARG_OPTIONS = {
  commandName: "relay-fleet",
  reservedFlags: KNOWN_FLAGS,
  booleanFlags: BOOLEAN_FLAGS,
  verbatimValueFlags: VERBATIM_VALUE_FLAGS,
};

class FleetInputError extends Error { constructor(message) { super(message); this.name = "FleetInputError"; } }

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function digestOwnership(ownership) { return sha256(canonical(ownership)); }
function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new FleetInputError(`${label} must be a non-empty string`);
  return value.trim();
}
function requireIssue(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new FleetInputError(`${label} must be a positive integer`);
  return number;
}
function filePath(value, base, label) {
  const resolved = path.resolve(base, requireString(value, label));
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new FleetInputError(`${label} must be an existing regular file: ${resolved}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new FleetInputError(`${label} must be a regular non-symlink file: ${resolved}`);
  return fs.realpathSync(resolved);
}
function storedPath(value, base, label) {
  const resolved = path.resolve(base, requireString(value, label));
  if (!path.isAbsolute(resolved)) throw new FleetInputError(`${label} must be absolute`);
  return resolved;
}
function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) throw new FleetInputError(`${label} must be a SHA-256 digest`);
  return value.toLowerCase();
}
function normalizeLeaf(raw, index, base, { freeze = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FleetInputError(`leaves[${index}] must be an object`);
  const leafRef = requireString(raw.leaf_ref || raw.leafRef || raw.leaf_id, `leaves[${index}].leaf_ref`);
  let ownership;
  try { ownership = normalizeOwnership(raw.ownership, { label: `leaves[${index}].ownership (${leafRef})` }); }
  catch (error) { throw new FleetInputError(error.message); }
  const optional = (key, aliases = []) => {
    const value = [key, ...aliases].map((name) => raw[name]).find((item) => typeof item === "string" && item.trim());
    return value ? String(value).trim() : null;
  };
  const resolveArtifact = freeze ? filePath : storedPath;
  const promptFile = resolveArtifact(raw.prompt_file || raw.promptFile, base, `leaves[${index}].prompt_file`);
  const rubricFile = resolveArtifact(raw.rubric_file || raw.rubricFile, base, `leaves[${index}].rubric_file`);
  const doneCriteriaFile = resolveArtifact(raw.done_criteria_file || raw.doneCriteriaFile, base, `leaves[${index}].done_criteria_file`);
  const artifactHash = (field, file, label) => freeze
    ? sha256(readRegular(file))
    : requireSha256(raw[field], `leaves[${index}].${label}`);
  return {
    leaf_ref: leafRef,
    issue_number: requireIssue(raw.issue_number ?? raw.issueNumber, `leaves[${index}].issue_number`),
    branch: requireString(raw.branch, `leaves[${index}].branch`),
    prompt_file: promptFile,
    prompt_sha256: artifactHash("prompt_sha256", promptFile, "prompt_sha256"),
    rubric_file: rubricFile,
    rubric_sha256: artifactHash("rubric_sha256", rubricFile, "rubric_sha256"),
    done_criteria_file: doneCriteriaFile,
    done_criteria_sha256: artifactHash("done_criteria_sha256", doneCriteriaFile, "done_criteria_sha256"),
    ownership,
    request_id: optional("request_id", ["requestId"]),
    leaf_id: optional("leaf_id", ["leafId"]) || leafRef,
    executor: optional("executor"), model: optional("model"), sandbox: optional("sandbox"),
    network_access: optional("network_access", ["networkAccess"]), timeout: raw.timeout == null ? null : String(requireIssue(raw.timeout, `leaves[${index}].timeout`)),
    reasoning: optional("reasoning"), copy: Array.isArray(raw.copy) ? raw.copy.join(",") : optional("copy"),
    test_command: optional("test_command", ["testCommand"]), publish_policy: optional("publish_policy", ["publishPolicy"]), register: raw.register === true,
  };
}
function validateLeaves(repoRoot, leaves) {
  const values = new Map();
  const owner = leaves[0]?.ownership;
  for (const leaf of leaves) {
    for (const [kind, value] of [["issue_number", leaf.issue_number], ["leaf_ref", leaf.leaf_ref], ["branch", leaf.branch]]) {
      if (values.has(`${kind}:${value}`)) throw new FleetInputError(`duplicate ${kind} '${value}' in immutable cohort`);
      values.set(`${kind}:${value}`, leaf.leaf_ref);
    }
    if (JSON.stringify(leaf.ownership) !== JSON.stringify(owner)) throw new FleetInputError("one fleet must carry a single ownership binding");
  }
  try { validateOwnershipAgainstSprintState(repoRoot, owner, { label: "fleet ownership" }); }
  catch (error) { throw new FleetInputError(error.message); }
  return leaves;
}
function loadLeavesFile(repoRoot, leavesFile) {
  const source = path.resolve(requireString(leavesFile, "--leaves-file"));
  let payload;
  try { payload = JSON.parse(fs.readFileSync(source, "utf8")); }
  catch (error) { throw new FleetInputError(`cannot parse --leaves-file: ${error.message}`); }
  const raw = Array.isArray(payload) ? payload : payload?.leaves;
  if (!Array.isArray(raw) || !raw.length) throw new FleetInputError("--leaves-file must contain a non-empty leaves array");
  return validateLeaves(repoRoot, raw.map((leaf, index) => normalizeLeaf(leaf, index, path.dirname(source), { freeze: true })));
}
function getFleetLeavesStorePath(repoRoot, fleetId) {
  return path.join(getFleetsDir(repoRoot), `${requireValidFleetId(fleetId)}.leaves.json`);
}
function readRegular(pathname) {
  const fd = fs.openSync(pathname, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { const stat = fs.fstatSync(fd); if (!stat.isFile()) throw new FleetInputError(`${pathname} must be a regular file`); return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
}

// `realpath()` alone is not a trust check: it normalizes away the very
// symlink component that redirected a fleet artifact outside RELAY_HOME. Walk
// the logical parent before creating or reading it, then require the resulting
// canonical directory to be byte-for-byte the same path.
function trustedCohortDirectory(logicalDirectory, { create = false } = {}) {
  const directory = path.resolve(logicalDirectory);
  const root = path.parse(directory).root;
  let cursor = root;
  for (const component of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return { directory, exists: false };
      fs.mkdirSync(cursor);
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink()) {
      throw new FleetInputError(`fleet cohort directory contains a symlink component: ${cursor}`);
    }
    if (!stat.isDirectory()) {
      throw new FleetInputError(`fleet cohort directory component is not a directory: ${cursor}`);
    }
  }
  const canonicalDirectory = fs.realpathSync(directory);
  if (canonicalDirectory !== directory) {
    throw new FleetInputError(`fleet cohort directory must use its canonical path: ${directory}`);
  }
  return { directory, exists: true };
}

function writeCohortExclusive(repoRoot, fleetId, leaves) {
  const logicalStore = getFleetLeavesStorePath(repoRoot, fleetId);
  const frozenLeaves = validateLeaves(repoRoot, leaves.map((leaf, index) => normalizeLeaf(
    leaf,
    index,
    repoRoot,
    { freeze: !leaf?.done_criteria_sha256 || !leaf?.prompt_sha256 || !leaf?.rubric_sha256 },
  )));
  const bytes = Buffer.from(canonical({ fleet_id: fleetId, leaves: frozenLeaves }), "utf8");
  const logicalDirectory = path.dirname(logicalStore);
  const { directory } = trustedCohortDirectory(logicalDirectory, { create: true });
  const store = path.join(directory, path.basename(logicalStore));
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new FleetInputError(`fleet store directory must be canonical and non-symlink: ${directory}`);
  }
  const temporary = path.join(directory, `.${path.basename(store)}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    try {
      fs.linkSync(temporary, store);
      fsyncDirectory(directory);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!readRegular(store).equals(bytes)) throw new FleetInputError(`immutable cohort '${fleetId}' already exists with different bytes`);
    }
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return store;
}
function readCohort(repoRoot, fleetId) {
  const logicalStore = getFleetLeavesStorePath(repoRoot, fleetId);
  const cohortDirectory = trustedCohortDirectory(path.dirname(logicalStore));
  const store = path.join(cohortDirectory.directory, path.basename(logicalStore));
  if (!fs.existsSync(store)) {
    const legacy = getFleetManifestPath(repoRoot, fleetId);
    if (fs.existsSync(legacy)) {
      throw new FleetInputError(`legacy active fleet '${fleetId}' has no immutable cohort; drain it with the legacy runtime or recreate it under a new fleet id`);
    }
    throw new FleetInputError(`immutable cohort does not exist: ${store}`);
  }
  let payload;
  try { payload = JSON.parse(readRegular(store).toString("utf8")); }
  catch (error) { throw new FleetInputError(`invalid immutable cohort: ${error.message}`); }
  if (!payload || payload.fleet_id !== fleetId || !Array.isArray(payload.leaves)) throw new FleetInputError("invalid immutable cohort shape");
  const leaves = payload.leaves.map((leaf, index) => normalizeLeaf(leaf, index, path.dirname(store)));
  validateLeaves(repoRoot, leaves);
  return { store, leaves, bytes: canonical(payload) };
}
function leafIdentity(leaf) {
  return { branch: leaf.branch, done_criteria_sha256: leaf.done_criteria_sha256, ownership_digest: digestOwnership(leaf.ownership) };
}
function legacyIdentity(manifest) {
  const criteria = manifest.anchor?.done_criteria_path;
  let hash = null;
  try { if (criteria && fs.existsSync(criteria)) hash = sha256(readRegular(criteria)); } catch {}
  return { issue_number: manifest.issue?.number || issueFromRunId(manifest.run_id), branch: manifest.git?.working_branch || null, done_criteria_sha256: hash, ownership_digest: manifest.ownership ? digestOwnership(manifest.ownership) : null };
}
function sameIdentity(identity, expected) {
  return identity.issue_number === expected.issue_number && identity.branch === expected.branch && identity.done_criteria_sha256 === expected.done_criteria_sha256 && identity.ownership_digest === expected.ownership_digest;
}
function issueFromRunId(runId) {
  const match = /^issue-(\d+)-/.exec(runId);
  return match ? Number(match[1]) : null;
}
function recordedGithubFacts(facts) {
  const pr = facts.filter((fact) => fact.type === "pull_request_recorded").at(-1);
  if (!pr) return { available: true, pr_lookup_complete: true };
  const merged = facts.filter((fact) => fact.type === "merge_recorded").at(-1);
  return {
    available: true,
    pr_lookup_complete: true,
    pr_number: pr.payload.pr_number,
    repo: pr.payload.repo,
    pr_head_sha: pr.payload.head_sha,
    head_ref: pr.payload.head_ref,
    base_ref: pr.payload.base_ref,
    pr_state: merged ? "MERGED" : "OPEN",
    ...(merged ? { merge_sha: merged.payload.result_target_sha } : {}),
  };
}
function foldedRunState(runDir, record) {
  const journal = readFacts({ eventsPath: path.join(runDir, "events.jsonl") });
  if (journal.tailIncomplete) return { state: "fact_conflict", fold: { action: "none", reason: "incomplete_fact_tail" } };
  const folded = foldRunFacts({
    runRecord: record,
    facts: journal.facts,
    githubFacts: recordedGithubFacts(journal.facts),
  });
  if (folded.terminal_kind === "merged") return { state: RUN_STATES.MERGED, fold: folded };
  if (folded.terminal_kind === "closed") return { state: RUN_STATES.CLOSED, fold: folded };
  if (folded.action === "merge") return { state: RUN_STATES.READY_TO_MERGE, fold: folded };
  if (folded.action === "review") return { state: RUN_STATES.REVIEW_PENDING, fold: folded };
  if (folded.action === "redispatch" && folded.reason === "changes_requested") return { state: RUN_STATES.CHANGES_REQUESTED, fold: folded };
  if (folded.action === "wait") return { state: RUN_STATES.DISPATCHED, fold: folded };
  if (folded.action === "redispatch") return { state: RUN_STATES.DISPATCHED, fold: folded };
  return { state: "attention", fold: folded };
}
function attentionFold(error, reason = "invalid_vnext_artifact") {
  return {
    action: "none",
    reason,
    diagnostics: [{ code: error?.code || "INVALID_VNEXT_ARTIFACT", message: error?.message || String(error) }],
  };
}
function scanChildren(repoRoot, fleetId) {
  const out = [];
  // Artifact presence, rather than successful parsing, owns the run id.  Once
  // run.json exists, a legacy manifest with the same id must never become an
  // authority fallback merely because the immutable record or journal is
  // corrupt.  The corrupt vNext artifact is surfaced as operator attention.
  const vnextRunIds = new Set();
  const logicalRunsDir = getRunsDir(repoRoot);
  const runsDir = fs.existsSync(logicalRunsDir) ? fs.realpathSync(logicalRunsDir) : logicalRunsDir;
  if (fs.existsSync(runsDir)) {
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      let runId;
      try { runId = requireValidRunId(entry.name); } catch { continue; }
      const runDir = path.join(runsDir, entry.name);
      const runRecordPath = path.join(runDir, "run.json");
      let artifactExists = false;
      try {
        if (fs.realpathSync(runDir) !== runDir) continue;
        fs.lstatSync(runRecordPath);
        artifactExists = true;
        vnextRunIds.add(runId);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        // An unreadable/symlink artifact still blocks legacy fallback.
        artifactExists = true;
        vnextRunIds.add(runId);
      }
      if (!artifactExists) continue;
      let record;
      try {
        record = readRunRecord({ runDir });
      } catch (error) {
        out.push({
          run_id: runId,
          state: "attention",
          fold: attentionFold(error, "invalid_run_record"),
          identity: { issue_number: issueFromRunId(runId), branch: null, done_criteria_sha256: null, ownership_digest: null },
          source: "vnext_invalid",
          manifest_path: fs.existsSync(getManifestPath(repoRoot, runId)) ? getManifestPath(repoRoot, runId) : null,
        });
        continue;
      }
      if (record.parent?.kind !== "fleet" || record.parent.id !== fleetId) continue;
      let derived;
      try {
        derived = foldedRunState(runDir, record);
      } catch (error) {
        derived = { state: "attention", fold: attentionFold(error, "invalid_fact_journal") };
      }
      out.push({
        run_id: runId,
        state: derived.state,
        fold: derived.fold,
        identity: {
          issue_number: issueFromRunId(runId),
          branch: record.git.branch,
          done_criteria_sha256: record.contract.done_criteria_sha256,
          ownership_digest: record.ownership_digest,
        },
        source: "vnext",
        manifest_path: fs.existsSync(getManifestPath(repoRoot, runId)) ? getManifestPath(repoRoot, runId) : null,
      });
    }
  }
  for (const manifestPath of listManifestPaths(repoRoot)) {
    try {
      const legacy = readManifest(manifestPath).data;
      const runId = legacy.run_id;
      if (!vnextRunIds.has(runId) && legacy.fleet_id === fleetId) {
        out.push({ run_id: runId, state: legacy.state || "unknown", identity: legacyIdentity(legacy), source: "legacy", manifest_path: manifestPath });
      }
    } catch { /* unreadable child cannot establish lineage */ }
  }
  return out;
}
function deriveFleet(repoRoot, fleetId, cohortOverride = null) {
  const { leaves, store } = cohortOverride || readCohort(repoRoot, fleetId);
  const children = scanChildren(repoRoot, fleetId);
  const candidateRunIds = new Set();
  const derived = leaves.map((leaf) => {
    const expected = { issue_number: leaf.issue_number, ...leafIdentity(leaf) };
    const matches = children.filter((child) => sameIdentity(child.identity, expected));
    for (const match of matches) candidateRunIds.add(match.run_id);
    if (matches.length > 1) return { leaf_ref: leaf.leaf_ref, issue_number: leaf.issue_number, branch: leaf.branch, run_id: null, run_state: "conflict", disposition: "attention", error: "multiple child runs match immutable cohort identity" };
    if (!matches.length) {
      const invalid = children.filter((child) => child.source === "vnext_invalid" && child.identity.issue_number === leaf.issue_number);
      if (invalid.length) {
        invalid.forEach((child) => candidateRunIds.add(child.run_id));
        return {
          leaf_ref: leaf.leaf_ref,
          issue_number: leaf.issue_number,
          branch: leaf.branch,
          run_id: invalid.length === 1 ? invalid[0].run_id : null,
          run_state: "attention",
          source: "vnext_invalid",
          disposition: "attention",
          error: invalid.length === 1
            ? invalid[0].fold?.diagnostics?.[0]?.message || "invalid vNext run artifact"
            : "multiple invalid vNext run artifacts claim this issue",
        };
      }
      try { verifyLeafArtifacts(leaf); }
      catch (error) { return { leaf_ref: leaf.leaf_ref, issue_number: leaf.issue_number, branch: leaf.branch, run_id: null, run_state: "artifact_drift", disposition: "attention", error: error.message }; }
      return { leaf_ref: leaf.leaf_ref, issue_number: leaf.issue_number, branch: leaf.branch, run_id: null, run_state: "no_run_manifest", disposition: "retry_pending" };
    }
    const unsafe = ["attention", "fact_conflict"].includes(matches[0].state);
    return {
      leaf_ref: leaf.leaf_ref,
      issue_number: leaf.issue_number,
      branch: leaf.branch,
      run_id: matches[0].run_id,
      run_state: matches[0].state,
      source: matches[0].source,
      fold_action: matches[0].fold?.action || null,
      fold_reason: matches[0].fold?.reason || null,
      disposition: unsafe ? "attention" : matches[0].state === RUN_STATES.MERGED ? "terminal" : "active",
      ...(unsafe ? { error: matches[0].fold?.diagnostics?.[0]?.message || matches[0].fold?.reason || "vNext facts cannot derive a safe action" } : {}),
    };
  });
  const orphans = children.filter((child) => !candidateRunIds.has(child.run_id)).map((child) => ({ run_id: child.run_id, run_state: child.state, reason: "parent fleet child does not match cohort branch/Done-Criteria/ownership identity" }));
  const attention = [...derived.filter((child) => child.disposition === "attention"), ...orphans];
  const allMerged = derived.length > 0 && derived.every((child) => child.run_state === RUN_STATES.MERGED);
  return { fleet_id: fleetId, cohort_path: store || null, total_children: derived.length, fleet_state: allMerged ? "closed" : attention.length ? "attention" : derived.some((child) => child.run_id) ? "active" : "pending", children: derived, operator_attention: attention };
}
function parseArgs(argv) {
  const unknown = findUnknownFlags(argv, CLI_ARG_OPTIONS);
  if (unknown.length) throw new FleetInputError(`unknown flags: ${unknown.join(", ")}`);
  const bound = bindCliArgs(argv, CLI_ARG_OPTIONS);
  const get = bound.getArg || bound[["get", "Arg"].join("")]; const has = bound.hasFlag || bound[["has", "Flag"].join("")];
  const parallel = Number(get("--parallel", String(DEFAULT_PARALLEL)));
  if (!Number.isInteger(parallel) || parallel <= 0) throw new FleetInputError("--parallel must be a positive integer");
  return { repo: get("--repo", "."), fleetId: get("--fleet-id"), leavesFile: get("--leaves-file"), status: has("--status"), review: has("--review"), parallel,
    dispatchScript: path.resolve(get("--dispatch-script", DEFAULT_DISPATCH_SCRIPT)), reviewScript: path.resolve(get("--review-script", DEFAULT_REVIEW_SCRIPT)), finalizeScript: path.resolve(get("--finalize-script", DEFAULT_FINALIZE_SCRIPT)), mergeMethod: get("--merge-method", "squash"), executor: get("--executor"), model: get("--model"), sandbox: get("--sandbox"), networkAccess: get("--network-access"), timeout: get("--timeout"), reasoning: get("--reasoning"), copy: get("--copy"), testCommand: get("--test-command"), publishPolicy: get("--publish-policy"), register: has("--register"), reviewer: get("--reviewer"), reviewerModel: get("--reviewer-model"), dryRun: has("--dry-run"), json: has("--json"), help: has(["--help", "-h"]) };
}
function push(args, flag, value) { if (value != null && value !== "") args.push(flag, String(value)); }
function buildDispatchArgs({ repoRoot, fleetId, leaf, options, runId = null }) {
  const selector = runId ? ["--run-id", runId] : ["--branch", leaf.branch];
  const args = [options.dispatchScript, repoRoot, ...selector, "--issue-number", String(leaf.issue_number), "--prompt-file", leaf.prompt_file, "--rubric-file", leaf.rubric_file, "--done-criteria-file", leaf.done_criteria_file, "--fleet-id", fleetId, "--ownership-json", JSON.stringify(leaf.ownership), "--leaf-id", leaf.leaf_id, "--json"];
  push(args, "--request-id", leaf.request_id); push(args, "--executor", leaf.executor || options.executor); push(args, "--model", leaf.model || options.model); push(args, "--sandbox", leaf.sandbox || options.sandbox); push(args, "--network-access", leaf.network_access || options.networkAccess); push(args, "--timeout", leaf.timeout || options.timeout); push(args, "--reasoning", leaf.reasoning || options.reasoning); push(args, "--copy", leaf.copy || options.copy); push(args, "--test-command", leaf.test_command || options.testCommand); push(args, "--publish-policy", leaf.publish_policy || options.publishPolicy); if (leaf.register || options.register) args.push("--register"); if (options.dryRun) args.push("--dry-run"); return args;
}
function runChild(scriptArgs, cwd) { return new Promise((resolve) => { const child = spawn(process.execPath, scriptArgs, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.once("error", (error) => resolve({ ok: false, error: error.message })); child.once("close", (code, signal) => resolve({ ok: code === 0, exit_code: code, signal, stdout, stderr })); }); }
async function pool(values, limit, work) { const results = []; let cursor = 0; await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => { while (cursor < values.length) { const index = cursor++; results[index] = await work(values[index]); } })); return results; }
function verifyLeafArtifacts(leaf) {
  for (const [fileField, hashField] of [["prompt_file", "prompt_sha256"], ["rubric_file", "rubric_sha256"], ["done_criteria_file", "done_criteria_sha256"]]) {
    const trusted = filePath(leaf[fileField], path.dirname(leaf[fileField]), fileField);
    if (sha256(readRegular(trusted)) !== leaf[hashField]) {
      throw new FleetInputError(`${fileField} changed after immutable cohort creation for ${leaf.leaf_ref}`);
    }
  }
}
async function dispatchPending(repoRoot, fleetId, summary, options, cohortOverride = null) {
  const cohort = cohortOverride || readCohort(repoRoot, fleetId);
  const byRef = new Map(cohort.leaves.map((leaf) => [leaf.leaf_ref, leaf]));
  const pending = summary.children.filter((child) => (
    child.run_state === "no_run_manifest" || child.fold_action === "redispatch"
  ));
  return pool(pending, options.parallel, async (child) => {
    const leaf = byRef.get(child.leaf_ref);
    try { verifyLeafArtifacts(leaf); }
    catch (error) { return { leaf_ref: leaf.leaf_ref, ok: false, error: error.message }; }
    return {
      leaf_ref: leaf.leaf_ref,
      ...(child.run_id ? { run_id: child.run_id, mode: "resume" } : { mode: "new" }),
      ...(await runChild(buildDispatchArgs({ repoRoot, fleetId, leaf, options, runId: child.run_id }), repoRoot)),
    };
  });
}
function buildReviewArgs(repoRoot, runId, options) { const args = [options.reviewScript, "--repo", repoRoot, "--run-id", runId, "--json"]; push(args, "--reviewer", options.reviewer); push(args, "--reviewer-model", options.reviewerModel); return args; }
async function reviewDerived(repoRoot, summary, options) { const targets = summary.children.filter((child) => [RUN_STATES.REVIEW_PENDING, RUN_STATES.INTERNAL_REVIEW_PENDING].includes(child.run_state) && child.fold_action !== "redispatch"); return pool(targets, options.parallel, async (child) => ({ leaf_ref: child.leaf_ref, run_id: child.run_id, ...(await runChild(buildReviewArgs(repoRoot, child.run_id, options), repoRoot)) })); }
function buildFinalizeArgs(repoRoot, runId, options) { const args = [options.finalizeScript, "--repo", repoRoot, "--run-id", runId, "--merge-method", options.mergeMethod, "--json"]; if (options.dryRun) args.push("--dry-run"); return args; }
async function mergeDerived(repoRoot, summary, options) { const targets = summary.children.filter((child) => child.run_state === RUN_STATES.READY_TO_MERGE); const results = []; for (const child of targets) { const result = { leaf_ref: child.leaf_ref, run_id: child.run_id, ...(await runChild(buildFinalizeArgs(repoRoot, child.run_id, options), repoRoot)) }; results.push(result); if (!result.ok) break; } return results; }
async function runFleet(options) {
  const repoRoot = getCanonicalRepoRoot(options.repo || ".");
  const fleetId = requireValidFleetId(options.fleetId);
  if (options.status) return { ok: true, ...(deriveFleet(repoRoot, fleetId)) };
  const proposedLeaves = options.leavesFile ? loadLeavesFile(repoRoot, options.leavesFile) : null;
  const ephemeral = options.dryRun && proposedLeaves
    ? { store: null, leaves: proposedLeaves, bytes: canonical({ fleet_id: fleetId, leaves: proposedLeaves }) }
    : null;
  if (proposedLeaves && !options.dryRun) writeCohortExclusive(repoRoot, fleetId, proposedLeaves);
  const before = deriveFleet(repoRoot, fleetId, ephemeral);
  if (options.dryRun) return { ok: before.operator_attention.length === 0, dry_run: true, ...before, dispatch: await dispatchPending(repoRoot, fleetId, before, options, ephemeral) };
  if (before.operator_attention.length) return { ok: false, ...before };
  const dispatch = await dispatchPending(repoRoot, fleetId, before, options);
  let summary = deriveFleet(repoRoot, fleetId);
  const review = options.review ? await reviewDerived(repoRoot, summary, options) : [];
  if (options.review) summary = deriveFleet(repoRoot, fleetId);
  const merge = options.review ? await mergeDerived(repoRoot, summary, options) : [];
  summary = deriveFleet(repoRoot, fleetId);
  return { ok: summary.operator_attention.length === 0 && dispatch.every((result) => result.ok) && review.every((result) => result.ok) && merge.every((result) => result.ok), ...summary, dispatch, review, merge };
}
function usage() { return `Usage: relay-fleet.js --repo <path> --fleet-id <id> [--leaves-file <path>] [--status] [--review]\n\n${modeLabel("--status", CLI_ARG_OPTIONS)} is read-only; a fleet persists only immutable cohort bytes.`; }
async function main(argv = process.argv.slice(2)) { let options; try { options = parseArgs(argv); if (options.help) { console.log(usage()); return 0; } if (!options.fleetId) throw new FleetInputError("--fleet-id is required"); if (options.status && (options.leavesFile || options.review || options.dryRun)) throw new FleetInputError("--status is read-only"); const result = await runFleet(options); if (options.json) console.log(JSON.stringify(result, null, 2)); else console.log(result.ok ? `relay-fleet complete: fleet=${result.fleet_id} children=${result.total_children}` : `relay-fleet needs attention: fleet=${result.fleet_id}`); return result.ok ? 0 : 1; } catch (error) { if (options?.json) console.error(JSON.stringify({ ok: false, error: error.message }, null, 2)); else console.error(`Error: ${error.message}`); return 1; } }
if (require.main === module) main().then((code) => { process.exitCode = code; });
module.exports = { FleetInputError, buildDispatchArgs, buildFinalizeArgs, deriveFleet, getFleetLeavesStorePath, loadLeavesFile, main, parseArgs, readCohort, runFleet, writeCohortExclusive };
