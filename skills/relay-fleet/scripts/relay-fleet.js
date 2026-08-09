#!/usr/bin/env node
"use strict";

/** Relay fleet: one immutable cohort plus a read-only view of child runs. */

const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs: parseNodeArgs } = require("node:util");

const { inspectProductionRun } = require("../../relay-dispatch/scripts/recover");
const runStore = require("../../relay-dispatch/scripts/run-store");
const { normalizeOwnership, validateOwnershipAgainstSprintState } = require("./ownership");

const DEFAULT_PARALLEL = 4;
const DEFAULT_DISPATCH_SCRIPT = path.join(__dirname, "..", "..", "relay-dispatch", "scripts", "dispatch.js");
const DEFAULT_REVIEW_SCRIPT = path.join(__dirname, "..", "..", "relay-review", "scripts", "review-runner.js");
const DEFAULT_FINALIZE_SCRIPT = path.join(__dirname, "..", "..", "relay-merge", "scripts", "finalize-run.js");
const ID_RE = /^[a-z0-9][a-z0-9-]{0,126}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const LEAF_FIELDS = new Set([
  "leaf_ref", "issue_number", "branch", "prompt_file", "prompt_sha256", "rubric_file", "rubric_sha256",
  "done_criteria_file", "done_criteria_sha256", "ownership", "executor", "model", "sandbox",
  "network_access", "timeout", "reasoning", "copy", "allow_toolset_mismatch",
]);
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
  executor: { type: "string" }, model: { type: "string" }, sandbox: { type: "string" },
  "network-access": { type: "string" }, timeout: { type: "string" }, reasoning: { type: "string" },
  copy: { type: "string" },
  reviewer: { type: "string" }, "reviewer-model": { type: "string" },
  "merge-method": { type: "string", default: "squash" },
  "dry-run": { type: "boolean", default: false }, json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
});

class FleetInputError extends Error {
  constructor(message) { super(message); this.name = "FleetInputError"; }
}

function fail(message) { throw new FleetInputError(message); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value) { return `${JSON.stringify(value, null, 2)}\n`; }
// Must stay byte-identical to dispatch.js parseOwnership(): this digest is the
// immutable fleet/run binding, not a display serialization.
function ownershipDigest(value) { return sha256(JSON.stringify(value)); }
function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value)) fail(`${label} must be a non-empty single-line string`);
  return value.trim();
}
function validId(value, label) {
  const id = requiredString(value, label);
  if (!ID_RE.test(id)) fail(`${label} must match ${ID_RE}`);
  return id;
}
function issueNumber(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) fail(`${label} must be a positive integer`);
  return result;
}
function hashValue(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}
function readRegular(file, label = file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail(`${label} must be a regular file`);
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}
function sourceFile(value, base, label) {
  const candidate = path.resolve(base, requiredString(value, label));
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { fail(`${label} must be an existing regular file: ${candidate}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file: ${candidate}`);
  return fs.realpathSync(candidate);
}
function storedFile(value, base, label) { return path.resolve(base, requiredString(value, label)); }

function git(repo, args) {
  return execFileSync(process.env.RELAY_GIT_BIN || "git", ["-C", repo, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function repositoryIdentity(input) {
  const checkout = fs.realpathSync(path.resolve(input));
  if (fs.realpathSync(git(checkout, ["rev-parse", "--show-toplevel"])) !== checkout) fail("--repo must be a canonical Git checkout root");
  let remote;
  try { remote = git(checkout, ["remote", "get-url", "origin"]); }
  catch { remote = `local/${path.basename(checkout)}`; }
  const github = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  const normalizedRemote = github ? `${github[1]}/${github[2]}` : remote;
  // A linked worktree shares its main checkout's Git common dir, so fleet state keys off that root.
  // The common dir is resolved before taking its parent, exactly as dispatch.repositoryIdentity and
  // run-store do: with a symlinked `.git`, dirname(realpath(x)) and realpath(dirname(x)) disagree, and
  // fleet would then scan a different run-directory slug than dispatch writes to.
  const commonDir = fs.realpathSync(path.resolve(checkout, git(checkout, ["rev-parse", "--git-common-dir"])));
  return { checkout, repoRoot: fs.realpathSync(path.dirname(commonDir)), remote: normalizedRemote };
}
function repoSlug(repoRoot) {
  const base = path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  return `${base}-${sha256(repoRoot).slice(0, 8)}`;
}
function relayHome() { return path.resolve(process.env.RELAY_HOME || path.join(os.homedir(), ".relay")); }
function runsDirectory(repoRoot) { return path.join(process.env.RELAY_RUNS_BASE || path.join(relayHome(), "runs"), repoSlug(repoRoot)); }
function getFleetLeavesStorePath(repoRoot, fleetId) {
  return path.join(relayHome(), "fleets", repoSlug(fs.realpathSync(repoRoot)), `${validId(fleetId, "fleet id")}.leaves.json`);
}

function normalizeLeaf(raw, index, base, freeze) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`leaves[${index}] must be an object`);
  const unexpected = Object.keys(raw).filter((key) => !LEAF_FIELDS.has(key));
  if (unexpected.length) fail(`leaves[${index}] has unsupported fields: ${unexpected.join(", ")}`);
  const leafRef = validId(raw.leaf_ref, `leaves[${index}].leaf_ref`);
  let ownership;
  try { ownership = normalizeOwnership(raw.ownership, { label: `leaves[${index}].ownership (${leafRef})` }); }
  catch (error) { fail(error.message); }
  const resolve = freeze ? sourceFile : storedFile;
  const artifact = (name) => {
    const file = resolve(raw[name], base, `leaves[${index}].${name}`);
    const digest = freeze ? sha256(readRegular(file, name)) : hashValue(raw[`${name.replace(/_file$/, "")}_sha256`], `leaves[${index}].${name.replace(/_file$/, "")}_sha256`);
    return { file, digest };
  };
  const prompt = artifact("prompt_file");
  const rubric = artifact("rubric_file");
  const done = artifact("done_criteria_file");
  const optional = (name, alias = null) => {
    const value = raw[name] ?? (alias ? raw[alias] : undefined);
    return value == null ? null : requiredString(String(value), `leaves[${index}].${name}`);
  };
  const allowMismatch = raw.allow_toolset_mismatch;
  if (allowMismatch != null && typeof allowMismatch !== "boolean") fail(`leaves[${index}].allow_toolset_mismatch must be a boolean`);
  return Object.freeze({
    leaf_ref: leafRef,
    issue_number: issueNumber(raw.issue_number, `leaves[${index}].issue_number`),
    branch: requiredString(raw.branch, `leaves[${index}].branch`),
    prompt_file: prompt.file, prompt_sha256: prompt.digest,
    rubric_file: rubric.file, rubric_sha256: rubric.digest,
    done_criteria_file: done.file, done_criteria_sha256: done.digest,
    ownership,
    executor: optional("executor"), model: optional("model"), sandbox: optional("sandbox"),
    network_access: optional("network_access"),
    timeout: raw.timeout == null ? null : String(issueNumber(raw.timeout, `leaves[${index}].timeout`)),
    reasoning: optional("reasoning"), copy: Array.isArray(raw.copy) ? raw.copy.join(",") : optional("copy"),
    allow_toolset_mismatch: allowMismatch,
  });
}
function validateLeaves(repoRoot, leaves) {
  if (!Array.isArray(leaves) || !leaves.length) fail("a fleet requires at least one leaf");
  const seen = new Set();
  const expectedOwner = canonical(leaves[0].ownership);
  for (const leaf of leaves) {
    for (const [field, value] of [["leaf_ref", leaf.leaf_ref], ["issue_number", leaf.issue_number], ["branch", leaf.branch]]) {
      const key = `${field}:${value}`;
      if (seen.has(key)) fail(`duplicate ${field} '${value}' in immutable cohort`);
      seen.add(key);
    }
    if (canonical(leaf.ownership) !== expectedOwner) fail("one fleet must carry a single ownership binding");
  }
  try { validateOwnershipAgainstSprintState(repoRoot, leaves[0].ownership, { label: "fleet ownership" }); }
  catch (error) { fail(error.message); }
  return leaves;
}
function loadLeavesFile(repoRoot, leavesFile) {
  const source = sourceFile(leavesFile, process.cwd(), "--leaves-file");
  let value;
  try { value = JSON.parse(readRegular(source).toString("utf8")); }
  catch (error) { fail(`cannot parse --leaves-file: ${error.message}`); }
  const raw = Array.isArray(value) ? value : value?.leaves;
  if (!Array.isArray(raw) || !raw.length) fail("--leaves-file must contain a non-empty leaves array");
  return validateLeaves(repoRoot, raw.map((leaf, index) => normalizeLeaf(leaf, index, path.dirname(source), true)));
}

function trustedDirectory(logical, create = false) {
  const directory = path.resolve(logical);
  let cursor = path.parse(directory).root;
  for (const part of path.relative(cursor, directory).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (error.code !== "ENOENT" || !create) throw error;
      try { fs.mkdirSync(cursor); } catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink()) fail(`fleet cohort directory contains a symlink component: ${cursor}`);
    if (!stat.isDirectory()) fail(`fleet cohort directory component is not a directory: ${cursor}`);
  }
  if (fs.realpathSync(directory) !== directory) fail(`fleet cohort directory must be canonical: ${directory}`);
  return directory;
}
function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function writeCohortExclusive(repoRoot, fleetId, inputLeaves) {
  const canonicalRoot = fs.realpathSync(repoRoot);
  const leaves = validateLeaves(canonicalRoot, inputLeaves.map((leaf, index) => normalizeLeaf(
    leaf, index, canonicalRoot, !leaf.prompt_sha256 || !leaf.rubric_sha256 || !leaf.done_criteria_sha256,
  )));
  const store = getFleetLeavesStorePath(canonicalRoot, fleetId);
  const bytes = Buffer.from(canonical({ fleet_id: fleetId, leaves }));
  const directory = trustedDirectory(path.dirname(store), true);
  const temporary = path.join(directory, `.${path.basename(store)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    try { fs.linkSync(temporary, store); fsyncDirectory(directory); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!readRegular(store).equals(bytes)) fail(`immutable cohort '${fleetId}' already exists with different bytes`);
    }
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return store;
}
function readCohort(repoRoot, fleetId) {
  const store = getFleetLeavesStorePath(repoRoot, fleetId);
  try { trustedDirectory(path.dirname(store), false); }
  catch (error) { if (error.code === "ENOENT") fail(`immutable cohort does not exist: ${store}`); throw error; }
  let value;
  try { value = JSON.parse(readRegular(store, "immutable cohort").toString("utf8")); }
  catch (error) { fail(`invalid immutable cohort: ${error.message}`); }
  if (!value || value.fleet_id !== fleetId || !Array.isArray(value.leaves)) fail("invalid immutable cohort shape");
  const leaves = validateLeaves(repoRoot, value.leaves.map((leaf, index) => normalizeLeaf(leaf, index, path.dirname(store), false)));
  return { store, leaves };
}

function issueFromRunId(runId) { return Number(/^issue-(\d+)-/.exec(runId)?.[1]) || null; }
function expectedIdentity(leaf) {
  return { issue_number: leaf.issue_number, branch: leaf.branch, done_criteria_sha256: leaf.done_criteria_sha256, ownership_digest: ownershipDigest(leaf.ownership) };
}
function sameIdentity(actual, expected) {
  return actual.issue_number === expected.issue_number && actual.branch === expected.branch
    && actual.done_criteria_sha256 === expected.done_criteria_sha256 && actual.ownership_digest === expected.ownership_digest;
}
function verifyLeafArtifacts(leaf) {
  for (const [file, digest] of [[leaf.prompt_file, leaf.prompt_sha256], [leaf.rubric_file, leaf.rubric_sha256], [leaf.done_criteria_file, leaf.done_criteria_sha256]]) {
    if (sha256(readRegular(sourceFile(file, path.dirname(file), file))) !== digest) fail(`${path.basename(file)} changed after immutable cohort creation for ${leaf.leaf_ref}`);
  }
}
function actionView(inspection) {
  if (!inspection || typeof inspection !== "object") fail("inspectRun returned no structured result");
  const derived = inspection.derived?.action;
  const recommended = inspection.recommended_action?.kind;
  if (inspection.blockers?.length) return { action: recommended || "operator_attention", state: "attention", error: inspection.blockers[0].code || "inspection_blocked" };
  if (derived !== recommended) return { action: recommended || "operator_attention", state: "attention", error: `inspection recommends '${recommended || "missing"}' for derived '${derived || "missing"}'` };
  if (inspection.derived?.terminal_kind === "merged") return { action: "none", state: "merged" };
  if (inspection.derived?.terminal_kind === "closed") return { action: "none", state: "closed" };
  if (derived === "review") return { action: "review", state: "review_pending" };
  if (derived === "merge") return { action: "merge", state: "ready_to_merge" };
  if (derived === "redispatch") return { action: "redispatch", state: inspection.derived?.reason === "changes_requested" ? "changes_requested" : "redispatch" };
  if (derived === "wait") return { action: "wait", state: "dispatched" };
  return { action: recommended || "operator_attention", state: "attention", error: `unsupported derived action '${derived || "missing"}'` };
}
async function scanChildren(repoRoot, fleetId, services = {}) {
  const inspectRun = services.inspectRun || inspectProductionRun;
  const directory = runsDirectory(repoRoot);
  if (!fs.existsSync(directory)) return [];
  const runsStat = fs.lstatSync(directory);
  if (!runsStat.isDirectory() || runsStat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) fail("fleet run store must be a canonical real directory");
  const children = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !ID_RE.test(entry.name)) continue;
    const runDir = path.join(directory, entry.name);
    if (fs.realpathSync(runDir) !== runDir || !fs.existsSync(path.join(runDir, "run.json"))) continue;
    let record;
    try { record = runStore.readRunRecord({ runDir }); }
    catch (error) {
      children.push({ run_id: entry.name, invalid: true, issue_number: issueFromRunId(entry.name), action: "none", state: "attention", error: error.message });
      continue;
    }
    if (record.parent?.kind !== "fleet" || record.parent.id !== fleetId) continue;
    let view;
    try {
      if (record.repo.root !== repoRoot) fail("child run repository does not match the fleet repository");
      view = actionView(await inspectRun({ runDir }));
    }
    catch (error) { view = { action: "none", state: "attention", error: error.message }; }
    children.push({
      run_id: record.run_id, run_dir: runDir, record, ...view,
      identity: { issue_number: issueFromRunId(record.run_id), branch: record.git.branch, done_criteria_sha256: record.contract.done_criteria_sha256, ownership_digest: record.ownership_digest },
    });
  }
  return children;
}
async function deriveFleet(repoRoot, fleetId, cohortOverride = null, services = {}) {
  const cohort = cohortOverride || readCohort(repoRoot, fleetId);
  const children = await scanChildren(repoRoot, fleetId, services);
  const claimed = new Set();
  const derived = cohort.leaves.map((leaf) => {
    const matches = children.filter((child) => child.identity && sameIdentity(child.identity, expectedIdentity(leaf)));
    matches.forEach((child) => claimed.add(child.run_id));
    if (matches.length > 1) return { leaf_ref: leaf.leaf_ref, issue_number: leaf.issue_number, branch: leaf.branch, run_id: null, run_state: "conflict", action: "none", disposition: "attention", error: "multiple child runs match immutable cohort identity" };
    if (!matches.length) {
      const invalid = children.filter((child) => child.invalid && child.issue_number === leaf.issue_number);
      invalid.forEach((child) => claimed.add(child.run_id));
      if (invalid.length) return { leaf_ref: leaf.leaf_ref, issue_number: leaf.issue_number, branch: leaf.branch, run_id: invalid.length === 1 ? invalid[0].run_id : null, run_state: "attention", action: "none", disposition: "attention", error: invalid.length === 1 ? invalid[0].error : "multiple corrupt child records claim this issue" };
      try { verifyLeafArtifacts(leaf); }
      catch (error) { return { leaf_ref: leaf.leaf_ref, issue_number: leaf.issue_number, branch: leaf.branch, run_id: null, run_state: "artifact_drift", action: "none", disposition: "attention", error: error.message }; }
      return { leaf_ref: leaf.leaf_ref, issue_number: leaf.issue_number, branch: leaf.branch, run_id: null, run_state: "no_run", action: "dispatch", disposition: "retry_pending" };
    }
    const child = matches[0];
    return { leaf_ref: leaf.leaf_ref, issue_number: leaf.issue_number, branch: leaf.branch, run_id: child.run_id, run_state: child.state, action: child.action, disposition: child.state === "merged" ? "terminal" : child.state === "attention" || child.state === "closed" ? "attention" : "active", ...(child.error ? { error: child.error } : {}) };
  });
  const orphans = children.filter((child) => !child.invalid && !claimed.has(child.run_id)).map((child) => ({ run_id: child.run_id, run_state: child.state, reason: "fleet parent child does not exactly match cohort branch, Done Criteria, issue, and ownership" }));
  const operatorAttention = [...derived.filter((child) => child.disposition === "attention"), ...orphans];
  const closed = derived.length > 0 && derived.every((child) => child.run_state === "merged");
  return { fleet_id: fleetId, cohort_path: cohort.store || null, total_children: derived.length, fleet_state: closed ? "closed" : operatorAttention.length ? "attention" : derived.some((child) => child.run_id) ? "active" : "pending", children: derived, operator_attention: operatorAttention };
}

function parseArgs(argv) {
  let parsed;
  try { parsed = parseNodeArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true }); }
  catch (error) { fail(error.message); }
  const parallel = Number(parsed.values.parallel);
  if (!Number.isInteger(parallel) || parallel < 1) fail("--parallel must be a positive integer");
  return {
    repo: parsed.values.repo, fleetId: parsed.values["fleet-id"], leavesFile: parsed.values["leaves-file"], status: parsed.values.status,
    review: parsed.values.review, parallel, dispatchScript: path.resolve(parsed.values["dispatch-script"]), reviewScript: path.resolve(parsed.values["review-script"]),
    finalizeScript: path.resolve(parsed.values["finalize-script"]), executor: parsed.values.executor, model: parsed.values.model, sandbox: parsed.values.sandbox,
    networkAccess: parsed.values["network-access"], timeout: parsed.values.timeout, reasoning: parsed.values.reasoning, copy: parsed.values.copy,
    reviewer: parsed.values.reviewer, reviewerModel: parsed.values["reviewer-model"], mergeMethod: parsed.values["merge-method"],
    dryRun: parsed.values["dry-run"], json: parsed.values.json, help: parsed.values.help,
  };
}
function push(args, flag, value) { if (value != null && value !== "") args.push(flag, String(value)); }
function buildDispatchArgs({ repoRoot, fleetId, leaf, options, runId = null }) {
  const args = [options.dispatchScript, repoRoot, ...(runId ? ["--run-id", runId] : ["--branch", leaf.branch]), "--issue-number", String(leaf.issue_number), "--prompt-file", leaf.prompt_file, "--rubric-file", leaf.rubric_file, "--done-criteria-file", leaf.done_criteria_file, "--fleet-id", fleetId, "--ownership-json", JSON.stringify(leaf.ownership), "--json"];
  push(args, "--executor", leaf.executor || options.executor); push(args, "--model", leaf.model || options.model);
  push(args, "--sandbox", leaf.sandbox || options.sandbox); push(args, "--network-access", leaf.network_access || options.networkAccess);
  push(args, "--timeout", leaf.timeout || options.timeout); push(args, "--reasoning", leaf.reasoning || options.reasoning); push(args, "--copy", leaf.copy || options.copy);
  if (leaf.allow_toolset_mismatch) args.push("--allow-toolset-mismatch");
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
