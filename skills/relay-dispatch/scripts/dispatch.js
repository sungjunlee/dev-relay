#!/usr/bin/env node
"use strict";

/** Relay dispatch: immutable run -> durable host attempt -> derived action. */

const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseArgs: parseNodeArgs } = require("util");

const { getAdapter, listAdapters } = require("./adapters");
const { assertInvocationShape, filesystemIsolationDiagnostic, validateCapabilities } = require("./adapter-contract");
const facts = require("./facts");
const host = require("./host");
const recover = require("./recover");
const runStore = require("./run-store");

const OPTIONS = Object.freeze({
  repo: { type: "string" },
  branch: { type: "string", short: "b" },
  "run-id": { type: "string" },
  prompt: { type: "string", short: "p" },
  "prompt-file": { type: "string" },
  "rubric-file": { type: "string" },
  "done-criteria-file": { type: "string" },
  executor: { type: "string", short: "e", default: "codex" },
  model: { type: "string", short: "m" },
  "network-access": { type: "string", default: "enabled" },
  timeout: { type: "string" },
  reasoning: { type: "string" },
  copy: { type: "string" },
  "issue-number": { type: "string" },
  "fleet-id": { type: "string" },
  "ownership-json": { type: "string" },
  detach: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
});

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out", "spawn_error"]);
const CLEANUP_REFUSALS = new Set(["HOST_CLEANUP_INCOMPLETE", "HOST_CLEANUP_EXTERNAL_ACTION_REQUIRED"]);
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{0,126}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function usage() {
  return [
    "Usage:",
    "  dispatch.js [<repo>] --branch <name> (--prompt <text> | --prompt-file <path>) --rubric-file <path> [options]",
    "  dispatch.js [<repo>] --run-id <id> (--prompt <text> | --prompt-file <path>) [options]",
    "",
    `Executors: ${listAdapters().join(", ")}`,
    "Dispatch never commits, pushes, opens a PR, or runs recovery. Use relay-recover for those actions.",
  ].join("\n");
}

function fail(message, code = "DISPATCH_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function git(repo, args, options = {}) {
  return execFileSync(process.env.RELAY_GIT_BIN || "git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function branchExists(checkout, branch) {
  try {
    git(checkout, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function branchExistsMessage(branch) {
  return [
    `branch already exists: ${branch}`,
    "Relay cannot prove ownership of pre-run Git state, so it preserves the existing branch and any registered worktree",
    "inspect it with `git worktree list --porcelain`, or dispatch with a new branch and run",
  ].join(". ");
}

function isExclusiveBranchCollision(error) {
  const output = String(error?.stderr || error?.message || "");
  return /(?:a branch named .* already exists|cannot lock ref .*reference already exists)/.test(output);
}

function observeAttemptWorktree(worktree) {
  return {
    head_sha: git(worktree, ["rev-parse", "HEAD"]),
    reviewable_work: git(worktree, ["status", "--porcelain"]).length > 0,
  };
}

function canonicalCheckout(input) {
  const resolved = path.resolve(input);
  const canonical = fs.realpathSync(resolved);
  const root = fs.realpathSync(git(canonical, ["rev-parse", "--show-toplevel"]));
  if (root !== canonical) fail(`repo must be the canonical checkout root: ${root}`);
  return root;
}

function repositoryIdentity(checkout) {
  const rawCommon = git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDir = fs.realpathSync(path.resolve(checkout, rawCommon));
  const repoRoot = fs.realpathSync(path.dirname(commonDir));
  let remote;
  try { remote = git(checkout, ["remote", "get-url", "origin"]); }
  catch { remote = `local/${path.basename(repoRoot)}`; }
  const github = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  return { checkout, commonDir, repoRoot, remote: github ? `${github[1]}/${github[2]}` : remote };
}

function repoSlug(repoRoot) {
  const base = path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  return `${base}-${crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 8)}`;
}

function worktreeBase() {
  return runStore.relayWorktreeBase();
}

function validateToken(value, label, pattern = TOKEN_RE) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function generatedRunId(branch, issueNumber) {
  const prefix = issueNumber ? `issue-${issueNumber}` : String(branch).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "run";
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  return `${prefix}-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function secureBytes(filePath, label) {
  const artifact = runStore.readArtifact(path.resolve(filePath), label);
  return { path: artifact.path, bytes: artifact.bytes };
}

function immutableBytes(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const fd = fs.openSync(filePath, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    runStore.fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!secureBytes(filePath, path.basename(filePath)).bytes.equals(bytes)) fail(`immutable artifact conflict: ${filePath}`);
  }
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  const fd = fs.openSync(temporary, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filePath);
  runStore.fsyncDirectory(path.dirname(filePath));
}

function parseOwnership(raw, fleetId) {
  if (!fleetId && raw === undefined) return { owner: null, digest: null };
  if (!fleetId || raw === undefined) fail("--fleet-id and --ownership-json must be supplied together");
  let owner;
  try { owner = JSON.parse(raw); } catch (error) { fail(`--ownership-json is invalid JSON: ${error.message}`); }
  const keys = Object.keys(owner || {}).sort();
  if (keys.join(",") !== "component,sprint,track") fail("--ownership-json must contain exactly sprint, track, and component");
  for (const key of keys) validateToken(owner[key], `ownership.${key}`, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/);
  const normalized = { sprint: owner.sprint, track: owner.track, component: owner.component };
  return { owner: normalized, digest: crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex") };
}

function parseCli(argv) {
  let parsed;
  try { parsed = parseNodeArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true, tokens: true }); }
  catch (error) {
    if (error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") fail(`unknown flag: ${error.message}`);
    throw error;
  }
  const values = parsed.values;
  if (values.help) return { help: true, values };
  if (parsed.positionals.length > 1) fail("at most one positional repo path is allowed");
  if (values.repo && parsed.positionals.length) fail("use either positional repo or --repo, not both");
  const repo = values.repo || parsed.positionals[0] || ".";
  const internalRunId = process.env.RELAY_DISPATCH_INTERNAL_RUN_ID || null;
  if (values.branch && values["run-id"] && !internalRunId) fail("--branch and --run-id are mutually exclusive");
  if (!values.branch && !values["run-id"] && !internalRunId) fail("--branch or --run-id is required");
  if (values.prompt === undefined && values["prompt-file"] === undefined) fail("--prompt or --prompt-file is required");
  if (values.prompt !== undefined && values["prompt-file"] !== undefined) fail("--prompt and --prompt-file are mutually exclusive");
  if (!new Set(["disabled", "enabled"]).has(values["network-access"])) fail("--network-access must be disabled or enabled");
  const issueNumber = values["issue-number"] === undefined ? null : Number(values["issue-number"]);
  if (issueNumber !== null && (!Number.isInteger(issueNumber) || issueNumber <= 0)) fail("--issue-number must be a positive integer");
  const timeoutSeconds = values.timeout === undefined ? null : Number(values.timeout);
  if (timeoutSeconds !== null && (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0)) fail("--timeout must be a positive integer in seconds");
  const runId = validateToken(internalRunId || values["run-id"] || generatedRunId(values.branch, issueNumber), "run id", RUN_ID_RE);
  const creating = Boolean(values.branch);
  if (creating && !values["rubric-file"]) fail("new dispatch requires --rubric-file");
  const ownership = parseOwnership(values["ownership-json"], values["fleet-id"]);
  return { values, repo, runId, creating, issueNumber, timeoutSeconds, ownership,
    executorExplicit: parsed.tokens.some((token) => token.kind === "option" && token.name === "executor") };
}

function resolveResumeExecutor(cli) {
  if (cli.creating) return cli;
  const identity = repositoryIdentity(canonicalCheckout(cli.repo));
  const record = runStore.readRunRecord({ runDir: runStore.resolveRunDirectory(identity.checkout, cli.runId) });
  const bound = record.roles.executor;
  if (cli.executorExplicit && cli.values.executor !== bound) {
    fail(`run executor is immutably bound to ${bound}`, "RUN_EXECUTOR_MISMATCH");
  }
  if (!cli.executorExplicit) cli.values.executor = bound;
  return cli;
}

// Read once per process, in main(), and thread the same buffer to loadInputs. A second read would
// let a swap stamp bytes that the immutable run contract never validated.
function readPrompt(cli) {
  return cli.values["prompt-file"] === undefined
    ? { path: null, bytes: Buffer.from(cli.values.prompt, "utf8") }
    : secureBytes(cli.values["prompt-file"], "prompt");
}

function validateCopyInputs(repoRoot, copyValue) {
  if (!copyValue) return [];
  const inputs = [];
  for (const input of copyValue.split(",").map((item) => item.trim()).filter(Boolean)) {
    const source = path.resolve(repoRoot, input);
    const relative = path.relative(repoRoot, source);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail(`--copy escapes repo: ${input}`);
    const opened = secureBytes(source, `copy input ${input}`);
    inputs.push({ relative, bytes: opened.bytes });
  }
  return inputs;
}

function copyInputs(repoRoot, worktree, copyValue) {
  const copied = [];
  for (const opened of validateCopyInputs(repoRoot, copyValue)) {
    const { relative } = opened;
    const destination = path.join(worktree, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, opened.bytes, { flag: "wx" });
    copied.push(relative);
  }
  return copied;
}

function createWorktreeBase(directory, ownedRoot) {
  const resolved = path.resolve(directory);
  let stablePrefix = path.dirname(path.resolve(ownedRoot));
  while (!fs.existsSync(stablePrefix)) {
    const parent = path.dirname(stablePrefix);
    if (parent === stablePrefix) fail(`relay worktree base has no existing parent: ${resolved}`);
    stablePrefix = parent;
  }
  const canonicalPrefix = fs.realpathSync(stablePrefix);
  if (!fs.statSync(canonicalPrefix).isDirectory()) {
    fail(`relay worktree base parent is not a directory: ${stablePrefix}`);
  }
  const suffix = path.relative(stablePrefix, resolved);
  if (!suffix || suffix.startsWith("..") || path.isAbsolute(suffix)) {
    fail(`relay worktree base escapes its owned root: ${resolved}`);
  }
  let cursor = canonicalPrefix;
  for (const part of suffix.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { fs.mkdirSync(cursor, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink()) fail(`relay worktree base contains a symlink: ${cursor}`);
    if (!stat.isDirectory()) fail(`relay worktree base component is not a directory: ${cursor}`);
  }
  return fs.realpathSync(resolved);
}

function createRetainedWorktree(identity, runId, branch) {
  git(identity.checkout, ["check-ref-format", "--branch", branch]);
  const baseBranch = git(identity.checkout, ["symbolic-ref", "--short", "HEAD"]);
  const startSha = git(identity.checkout, ["rev-parse", "HEAD"]);
  const base = worktreeBase();
  // Canonicalize the stable prefix so platform aliases such as macOS /tmp remain valid, then
  // no-follow only the path Relay owns: RELAY_HOME through its default worktrees child, or an
  // explicitly configured RELAY_WORKTREE_BASE itself. Node has no mkdirat/openat path walk that
  // can bind this chain against a concurrent rename, but a pre-existing symlink in the owned
  // suffix is rejected before Relay writes through it (#1191).
  const ownedRoot = process.env.RELAY_WORKTREE_BASE ? base : path.dirname(base);
  const canonicalBase = createWorktreeBase(base, ownedRoot);
  const worktree = path.join(canonicalBase, repoSlug(identity.repoRoot), runId, path.basename(identity.repoRoot));
  if (fs.existsSync(worktree)) fail(`retained worktree already exists: ${worktree}`);
  // Reject a pre-existing symlink in any destination component BEFORE mkdirSync or git can write
  // through it. recursive mkdirSync follows an existing symlink at an intermediate component and
  // would create the run-id directory at the untrusted target; git worktree add would do the same.
  // assertTrustedWorktree still runs after `worktree add` and unwinds, but by then a write has
  // already escaped the trusted relay base (#1154).
  let cursor = canonicalBase;
  for (const part of path.relative(canonicalBase, path.dirname(worktree)).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { if (error.code === "ENOENT") break; throw error; }
    if (stat.isSymbolicLink()) fail(`retained worktree destination contains a symlink: ${cursor}`);
    if (!stat.isDirectory()) fail(`retained worktree destination component is not a directory: ${cursor}`);
  }
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  // Create the branch as its own step. `git branch` is an atomic exclusive ref creation: it fails
  // closed if the name is taken, so a successful create is an ownership token for this dispatch.
  // `worktree add -b` cannot serve that role — it creates the branch before it validates the
  // destination, so a rejected destination leaves the branch behind and nothing afterwards
  // distinguishes ours from one a concurrent dispatch created a moment earlier. Probing with
  // `rev-parse` first would only move that race, not close it.
  try {
    git(identity.checkout, ["branch", branch, startSha], {
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
    });
  } catch (error) {
    // The exclusive ref create is the branch-ownership boundary. Its failure means this dispatch
    // did not acquire the requested branch, even if another actor removes that ref before this
    // process can observe it. Do not re-probe or clean up mutable branch state here.
    if (isExclusiveBranchCollision(error)) {
      fail(branchExistsMessage(branch), "BRANCH_EXISTS");
    }
    throw error;
  }
  let registered = false;
  try {
    git(identity.checkout, ["worktree", "add", worktree, branch]);
    registered = true;
    // Containment is validated inside this try so a rejected worktree unwinds like any other
    // failure. Validating it afterwards left an untrusted-path rejection holding both a registered
    // worktree and the branch.
    const canonicalWorktree = fs.realpathSync(worktree);
    runStore.assertTrustedWorktree({ repoRoot: identity.repoRoot, activeCheckout: identity.checkout, relayWorktreeBase: canonicalBase, worktree: canonicalWorktree });
    return { worktree: canonicalWorktree, baseBranch, startSha, canonicalBase };
  } catch (error) {
    // Remove the destination only when this invocation registered it. A failed `worktree add` may
    // have failed precisely because a competing dispatch owns that path, and `--force` deletes a
    // dirty worktree without asking — it would destroy that run's uncommitted executor work.
    // `branch -D` needs no such test: the atomic create above proves the branch is ours.
    if (registered) { try { git(identity.checkout, ["worktree", "remove", "--force", worktree]); } catch {} }
    try { git(identity.checkout, ["branch", "-D", branch]); } catch {}
    throw error;
  }
}

function removeUnpublishedWorktree(identity, created, branch) {
  try { git(identity.checkout, ["worktree", "remove", "--force", created.worktree]); } catch {}
  try { git(identity.checkout, ["branch", "-D", branch]); } catch {}
  const runParent = path.dirname(created.worktree);
  try { fs.rmdirSync(runParent); } catch {}
  try { fs.rmdirSync(path.dirname(runParent)); } catch {}
}

// `runDir` is null when this dispatch never claimed the directory, which is the
// case when another dispatch won the mkdir race: the loser must remove only the
// worktree and branch it created, never the winner's run directory. The shared
// per-repository parent is deliberately left behind — rmdir'ing it raced other
// dispatches into a bare ENOENT on their own leaf mkdir.
function removeUnpublishedRun(identity, created, branch, runDir) {
  if (runDir) {
    // Re-derive the canonical location from immutable inputs; anything that does
    // not match it is not this run's directory to delete.
    let canonical = null;
    try { canonical = runStore.resolveRunDirectory(identity.checkout, path.basename(runDir)); } catch {}
    if (canonical === runDir) { try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {} }
  }
  removeUnpublishedWorktree(identity, created, branch);
}

function assertResumeInspection(inspection, expectedActionKey = null) {
  const derived = inspection?.derived;
  const recommended = inspection?.recommended_action;
  if (derived?.terminal === true || derived?.phase === "terminal") {
    fail("terminal runs cannot be redispatched", "RUN_TERMINAL");
  }
  if (derived?.action !== "redispatch" || recommended?.kind !== "redispatch") {
    fail(
      `run is not redispatchable: derived=${derived?.action || "unknown"}/${derived?.reason || "unknown"} recommended=${recommended?.kind || "unknown"}`,
      "RUN_NOT_REDISPATCHABLE",
    );
  }
  if (typeof recommended.key !== "string" || !/^[0-9a-f]{64}$/.test(recommended.key)) {
    fail("redispatch inspection has no canonical action key", "RUN_NOT_REDISPATCHABLE");
  }
  if (expectedActionKey !== null && recommended.key !== expectedActionKey) {
    fail("redispatch action changed before the attempt lock was acquired", "RUN_ACTION_CHANGED");
  }
  return inspection;
}

function dryRunInvocation({ cli, identity, adapter, inputs }) {
  if (cli.creating) {
    git(identity.checkout, ["check-ref-format", "--branch", cli.values.branch]);
    const existing = git(identity.checkout, ["branch", "--list", cli.values.branch]);
    if (existing) fail(branchExistsMessage(cli.values.branch), "BRANCH_EXISTS");
  }
  validateCopyInputs(identity.repoRoot, cli.values.copy);
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-dry-run-")));
  if (cli.values.model?.startsWith("-") || cli.values.reasoning?.startsWith("-")) {
    fail("model and reasoning must be non-flag values", "INVALID_INVOCATION");
  }
  try {
    const promptPath = path.join(temporary, "prompt.md");
    fs.writeFileSync(promptPath, inputs.prompt.bytes, { flag: "wx", mode: 0o600 });
    const resultPath = path.join(temporary, "executor-output");
    const invocation = adapter.buildInvocation({
      phase: "dispatch",
      cwd: identity.checkout,
      promptPath,
      promptBytes: inputs.prompt.bytes,
      resultPath,
      model: cli.values.model || null,
      timeoutMs: (cli.timeoutSeconds || adapter.defaults.timeoutMs / 1000) * 1000,
      networkAccess: cli.values["network-access"],
      reasoning: cli.values.reasoning || null,
    });
    return { command: invocation.command, args: [...invocation.args], cwd: invocation.cwd, validation: "adapter_build_invocation",
      launch_boundary: "host_supervisor_required_do_not_execute_raw",
      prompt_transport: adapter.metadata.promptTransport, network_access: invocation.networkAccess, tool_network_access: invocation.toolNetworkAccess };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function hostAuditAppender(runDir, runId, actor) {
  return (audit, lockContext) => {
    const eventsPath = path.join(runDir, "events.jsonl");
    const eventId = crypto.createHash("sha256").update(`host:${runId}:${audit.audit_key}`).digest("hex");
    const existing = facts.readFacts({ eventsPath }).facts.find((fact) => fact.event_id === eventId);
    const fact = facts.factFromHostAudit({ runId, eventId, at: existing?.at || new Date().toISOString(), actor, audit });
    facts.appendFact({ eventsPath, fact, lockContext });
    return { durable: true, idempotent: true, audit_key: audit.audit_key };
  };
}

function attemptFact({ runId, attemptId, type, actor, payload }) {
  return { event_id: crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex"), run_id: runId, attempt_id: attemptId, type, at: new Date().toISOString(), actor, payload };
}

async function startAttempt({ cli, identity, adapter, prompt, rubric, criteria, resumeInspection = null, inspectRun = recover.inspectProductionRun }) {
  const actor = process.env.RELAY_ORCHESTRATOR || "codex";
  let record;
  let runDir = runStore.resolveRunDirectory(identity.checkout, cli.runId);
  if (cli.creating) {
    // Reject a duplicate run id before any Git work. This is an optimization, not the
    // guard: the authoritative claim is the non-recursive mkdir below.
    if (fs.existsSync(runDir)) fail(`run already exists: ${cli.runId}`, "RUN_RECORD_CONFLICT");
    const worktree = createRetainedWorktree(identity, cli.runId, cli.values.branch);
    let claimed = false;
    try {
      // Claim the run directory atomically. A repository-wide lock used to serialize the
      // check and the create; a non-recursive mkdir on the leaf is a stronger guard with no
      // lock timeout and no serialization between unrelated runs in the same repository.
      // It is claimed after the worktree so that a crash during `git worktree add` cannot
      // strand an empty run directory that permanently rejects both create and resume.
      fs.mkdirSync(path.dirname(runDir), { recursive: true });
      try {
        fs.mkdirSync(runDir);
      } catch (error) {
        if (error.code === "EEXIST") fail(`run already exists: ${cli.runId}`, "RUN_RECORD_CONFLICT");
        throw error;
      }
      claimed = true;
      const criteriaSource = criteria || rubric;
      const stagedCriteria = path.join(runDir, ".done-criteria.source");
      immutableBytes(stagedCriteria, criteriaSource.bytes);
      const frozen = runStore.freezeDoneCriteria({ sourcePath: stagedCriteria, runDir });
      fs.unlinkSync(stagedCriteria);
      immutableBytes(path.join(runDir, "rubric.yaml"), rubric.bytes);
      record = {
        version: runStore.RUN_VERSION, run_id: cli.runId,
        repo: { root: identity.repoRoot, remote: identity.remote },
        git: { branch: cli.values.branch, base_branch: worktree.baseBranch, worktree: worktree.worktree, start_sha: worktree.startSha },
        contract: { done_criteria_path: frozen.path, done_criteria_sha256: frozen.sha256 },
        roles: { orchestrator: actor, executor: adapter.name, reviewer: process.env.RELAY_REVIEWER || "codex" },
        parent: cli.values["fleet-id"] ? { kind: "fleet", id: cli.values["fleet-id"] } : null,
        ownership_digest: cli.ownership.digest,
        created_at: new Date().toISOString(),
      };
      runStore.createRunRecord({ runDir, record });
      copyInputs(identity.repoRoot, record.git.worktree, cli.values.copy);
    } catch (error) {
      removeUnpublishedRun(identity, worktree, cli.values.branch, claimed ? runDir : null);
      throw error;
    }
  } else {
    record = runStore.readRunRecord({ runDir });
    if (record.repo.root !== identity.repoRoot || record.repo.remote !== identity.remote) fail("run repository identity does not match checkout");
    if (record.roles.executor !== adapter.name) fail(`run executor is immutably bound to ${record.roles.executor}`);
    if (cli.values["fleet-id"] && record.parent?.id !== cli.values["fleet-id"]) fail("fleet parent cannot change on redispatch");
    if (cli.ownership.digest && record.ownership_digest !== cli.ownership.digest) fail("fleet ownership cannot change on redispatch");
    runStore.assertTrustedWorktree({ repoRoot: record.repo.root, activeCheckout: identity.checkout, relayWorktreeBase: fs.realpathSync(worktreeBase()), worktree: record.git.worktree });
  }
  const attemptId = `dispatch-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const promptPath = path.join(runDir, `prompt-${attemptId}.md`);
  const outputPath = path.join(runDir, `attempt-${attemptId}.executor-output`);
  const resultPath = path.join(runDir, `attempt-${attemptId}.result.json`);
  const stdoutPath = path.join(runDir, `attempt-${attemptId}.stdout.log`);
  const stderrPath = path.join(runDir, `attempt-${attemptId}.stderr.log`);
  const audit = hostAuditAppender(runDir, cli.runId, actor);
  const lockContext = host.acquireRunLock({
    runDir, attemptId, operation: "dispatch", hostKind: "local_supervisor",
    hostHandle: `dispatch:${process.pid}:${crypto.randomBytes(8).toString("hex")}`,
    worktreeDir: record.git.worktree, audit,
  });
  let attemptStarted = false;
  let invocation;
  let startSha;
  let timeoutMs;
  let receipt;
  try {
    if (!cli.creating) {
      const fresh = assertResumeInspection(await inspectRun({
        runDir,
        activeRunLock: lockContext,
      }), resumeInspection?.recommended_action?.key || null);
      if (fresh.recommended_action.key !== resumeInspection?.recommended_action?.key) {
        fail("redispatch action key was not preserved under the run lock", "RUN_ACTION_CHANGED");
      }
    }
    immutableBytes(promptPath, prompt.bytes);
    validateCapabilities(adapter, "dispatch", { networkAccess: cli.values["network-access"], model: cli.values.model || null });
    invocation = adapter.buildInvocation({
      phase: "dispatch", cwd: record.git.worktree, promptPath, resultPath: outputPath,
      promptBytes: prompt.bytes,
      model: cli.values.model || null, timeoutMs: (cli.timeoutSeconds || adapter.defaults.timeoutMs / 1000) * 1000,
      networkAccess: cli.values["network-access"], reasoning: cli.values.reasoning || null,
    });
    startSha = git(record.git.worktree, ["rev-parse", "HEAD"]);
    timeoutMs = (cli.timeoutSeconds || adapter.defaults.timeoutMs / 1000) * 1000;
    facts.appendFact({ eventsPath: path.join(runDir, "events.jsonl"), lockContext, fact: attemptFact({
      runId: cli.runId, attemptId, type: "attempt_started", actor,
      payload: { executor: adapter.name, model: cli.values.model || null, start_sha: startSha, host_kind: "local_supervisor", host_handle: lockContext.host_handle, stdout_path: stdoutPath, stderr_path: stderrPath, result_path: resultPath, timeout_ms: timeoutMs },
    }) });
    attemptStarted = true;
    receipt = host.launchLocalSupervisor({
      runDir, attemptId, command: invocation.command, args: invocation.args,
      trustedWorktreeRoot: record.git.worktree, cwd: invocation.cwd,
      stdoutPath, stderrPath, resultPath,
      inputFiles: [promptPath],
      stdinPath: invocation.stdinPath || null,
      stdinSha256: invocation.stdinSha256 || null,
      executorResultPath: outputPath,
      executorNetworkAccess: cli.values["network-access"],
      runtimeDependencies: invocation.runtimeDependencies,
      timeoutMs,
      processContainment: adapter.metadata.processContainment,
      providerUnavailableSignals: adapter.providerUnavailableSignals,
      lockContext,
    });
  } catch (error) {
    try {
      if (attemptStarted) {
        const observed = observeAttemptWorktree(record.git.worktree);
        facts.appendFact({ eventsPath: path.join(runDir, "events.jsonl"), lockContext, fact: attemptFact({
          runId: cli.runId, attemptId, type: "attempt_interrupted", actor,
          payload: { last_known_sha: observed.head_sha, reason: `host launch failed: ${error.message}`, host_liveness: "dead", reviewable_work: observed.reviewable_work },
        }) });
      }
      host.releaseRunLock(lockContext, { outcome: "failed", audit });
    } catch {}
    throw error;
  }
  return { record, runDir, attemptId, receipt, lockContext, audit, invocation, outputPath, actor, startSha };
}

async function recoverIncompleteHostCleanup(started, hostError) {
  // A signed cleanup obligation is the only authority to reap a scoped
  // executor and remove its staged input. Never release this owner by
  // hand: breakStaleRunLock verifies and settles that exact obligation first.
  const inspection = host.inspectOwnership({ runDir: started.runDir });
  try {
    await host.breakStaleRunLock({ inspection, reason: "dispatch observed an incomplete host cleanup", audit: started.audit });
  } catch (recoveryError) {
    recoveryError.cleanup_sha256 ||= hostError.cleanup_sha256;
    recoveryError.cleanup_recovery = "incomplete";
    throw recoveryError;
  }
  const terminal = await host.waitForTerminalResult(started.receipt);
  const lockContext = host.acquireRunLock({ runDir: started.runDir, attemptId: started.attemptId,
    operation: "dispatch-cleanup-finalize", worktreeDir: started.record.git.worktree });
  return { terminal, lockContext };
}

async function finishAttempt({ cli, adapter, started }) {
  let terminal, finalizerLock = started.lockContext;
  try { terminal = await host.waitForTerminalResult(started.receipt); }
  catch (error) {
    if (error.code === "HOST_CLEANUP_INCOMPLETE") {
      const settled = await recoverIncompleteHostCleanup(started, error);
      terminal = settled.terminal; finalizerLock = settled.lockContext;
    } else if (new Set(["HOST_RESULT_TIMEOUT", "HOST_RESULT_MISMATCH"]).has(error.code)) {
      // These have no signed cleanup obligation. Retain the owner and evidence
      // for canonical recovery rather than guessing that the host is gone.
      throw error;
    } else {
      const observed = observeAttemptWorktree(started.record.git.worktree);
      facts.appendFact({ eventsPath: path.join(started.runDir, "events.jsonl"), lockContext: started.lockContext, fact: attemptFact({
        runId: cli.runId, attemptId: started.attemptId, type: "attempt_interrupted", actor: started.actor,
        payload: { last_known_sha: observed.head_sha, reason: error.message, host_liveness: "unknown", reviewable_work: observed.reviewable_work },
      }) });
      host.releaseRunLock(started.lockContext, { outcome: "failed", audit: started.audit });
      throw error;
    }
  }
  if (!TERMINAL_STATUSES.has(terminal.status)) fail(`unknown terminal host status: ${terminal.status}`);
  const observed = observeAttemptWorktree(started.record.git.worktree);
  const committedTreeSha = git(started.record.git.worktree, ["rev-parse", "HEAD^{tree}"]);
  const parsed = adapter.parseOutcome({
    phase: "dispatch", exitCode: terminal.exit_code, signal: terminal.signal,
    timedOut: terminal.status === "timed_out", cancelled: terminal.status === "cancelled",
    stdoutPath: started.receipt.stdout_path, stderrPath: started.receipt.stderr_path, resultPath: started.outputPath,
  });
  const status = terminal.status === "completed" && terminal.exit_code === 0 && parsed.status === "succeeded" ? "completed"
    : new Set(["cancelled", "timed_out"]).has(terminal.status) ? "cancelled" : "failed";
  facts.appendFact({ eventsPath: path.join(started.runDir, "events.jsonl"), lockContext: finalizerLock, fact: attemptFact({
    runId: cli.runId, attemptId: started.attemptId, type: "attempt_finished", actor: started.actor,
    payload: { status, start_sha: started.startSha, final_sha: observed.head_sha, tree_sha: committedTreeSha, result_path: started.receipt.result_path, exit_code: terminal.exit_code ?? 1, verification_status: "not_declared" },
  }) });
  host.releaseRunLock(finalizerLock, { outcome: status, audit: started.audit });
  return { terminal, parsed, status };
}

// `prompt` is the buffer main() already loaded, threaded rather than re-read.
function loadInputs(cli, prompt) {
  const rubric = cli.values["rubric-file"] ? secureBytes(cli.values["rubric-file"], "rubric") : null;
  if (cli.creating && !rubric) fail("new dispatch requires a readable --rubric-file");
  const criteria = cli.values["done-criteria-file"] ? secureBytes(cli.values["done-criteria-file"], "Done Criteria") : null;
  return { prompt, rubric, criteria };
}

// `adapter` and `prompt` are resolved once in main() and threaded here; re-deriving either would split
// the trusted inputs from the dispatch.
async function executeForeground(cli, overrides = {}) {
  const { adapter, prompt } = overrides;
  // Both are the trusted values main() resolved once. Defaulting or re-deriving either here
  // reintroduces the split between validated bytes and executed bytes; a caller that omits them gets
  // a typed failure before any filesystem read instead of an undefined forwarded downstream.
  if (adapter === undefined || prompt === undefined) {
    fail("executeForeground requires the resolved adapter and prompt; re-deriving either would split validation from use", "INVALID_INVOCATION");
  }
  const inspectRun = overrides.inspectRun || recover.inspectProductionRun;
  const identity = repositoryIdentity(canonicalCheckout(cli.repo));
  const capabilityRequest = { networkAccess: cli.values["network-access"], model: cli.values.model || null };
  validateCapabilities(adapter, "dispatch", capabilityRequest);
  const filesystemIsolation = filesystemIsolationDiagnostic(adapter, "dispatch", capabilityRequest);
  let resumeInspection = null;
  if (!cli.creating) {
    const runDir = runStore.resolveRunDirectory(identity.checkout, cli.runId);
    resumeInspection = assertResumeInspection(await inspectRun({ runDir }));
  }
  const inputs = loadInputs(cli, prompt);
  if (cli.values["dry-run"]) {
    const invocation = dryRunInvocation({ cli, identity, adapter, inputs });
    return { status: "dry-run", run_id: cli.runId, repo: identity.repoRoot, executor: adapter.name, model: cli.values.model || null, filesystem_isolation: filesystemIsolation, durable_bytes_written: 0, invocation, ...(resumeInspection ? { inspection: resumeInspection } : {}), recovery: "canonical relay-recover only" };
  }
  const started = await startAttempt({ cli, identity, adapter, prompt: inputs.prompt, rubric: inputs.rubric, criteria: inputs.criteria, resumeInspection, inspectRun });
  const launch = { status: "dispatched", run_id: cli.runId, run_dir: started.runDir, worktree: started.record.git.worktree, attempt_id: started.attemptId, host_handle: started.receipt.host_handle, filesystem_isolation: filesystemIsolation };
  if (process.env.RELAY_DISPATCH_NOTIFY_PATH) {
    const inspection = await recover.inspectProductionRun({ runDir: started.runDir });
    atomicJson(process.env.RELAY_DISPATCH_NOTIFY_PATH, { ...launch, dispatcher_pid: process.pid, inspection });
  }
  const finished = await finishAttempt({ cli, adapter, started });
  const inspection = await recover.inspectProductionRun({ runDir: started.runDir });
  return { ...launch, status: finished.status, host_status: finished.terminal.status,
    ...(finished.terminal.termination ? { termination: finished.terminal.termination } : {}), outcome: finished.parsed, inspection };
}

function processLive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function executeDetached(cli, argv) {
  const notifyPath = path.join(os.tmpdir(), `relay-dispatch-${crypto.randomUUID()}.json`);
  const env = { ...process.env, RELAY_DISPATCH_INTERNAL_RUN_ID: cli.runId, RELAY_DISPATCH_NOTIFY_PATH: notifyPath };
  const childArgs = argv.filter((arg) => arg !== "--detach");
  const child = spawn(process.execPath, [__filename, ...childArgs], { detached: true, env, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(notifyPath)) {
      const result = JSON.parse(secureBytes(notifyPath, "detached launch receipt").bytes.toString("utf8"));
      fs.unlinkSync(notifyPath);
      if (result.ok === false) fail(result.error, result.code);
      return result;
    }
    if (!processLive(child.pid)) fail("detached dispatcher exited before publishing a launch receipt", "DISPATCH_START_FAILED");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fail("detached dispatcher did not publish a launch receipt", "DISPATCH_START_FAILED");
}

// When a foreground dispatch throws after the attempt already settled (the gate
// exiting mid-flight during Relay cancellation, e.g. a post-settle inspection
// fault), the terminal state is still durable: an attempt_finished fact and its
// host result file. Salvage the typed shape for stdout instead of losing it to a
// stderr-only error. Exit-code semantics are unchanged: the caller still returns 1.
async function salvageTerminalResult(cli) {
  if (!cli || !cli.runId || !cli.repo || cli.values["dry-run"]) return null;
  const runDir = runStore.resolveRunDirectory(canonicalCheckout(cli.repo), cli.runId);
  const inspection = await recover.inspectProductionRun({ runDir });
  const finished = inspection.facts.filter((fact) => fact.type === "attempt_finished"
    && new Set(["cancelled", "failed", "timed_out"]).has(fact.payload?.status)).at(-1);
  if (!finished) return null;
  const hostResult = JSON.parse(fs.readFileSync(finished.payload.result_path, "utf8"));
  if (!TERMINAL_STATUSES.has(hostResult.status)) return null;
  const adapter = getAdapter(cli.values.executor);
  const capabilityRequest = { networkAccess: cli.values["network-access"], model: cli.values.model || null };
  return { status: finished.payload.status, host_status: hostResult.status,
    ...(hostResult.termination ? { termination: hostResult.termination } : {}),
    run_id: cli.runId, run_dir: runDir, attempt_id: finished.attempt_id,
    filesystem_isolation: filesystemIsolationDiagnostic(adapter, "dispatch", capabilityRequest),
    recovery: "canonical relay-recover only", inspection };
}

async function main(argv = process.argv.slice(2)) {
  let cli;
  try {
    cli = parseCli(argv);
    if (cli.help) { console.log(usage()); return 0; }
    resolveResumeExecutor(cli);
    // Resolve the executor once, before any filesystem read: an unknown one stays the argv error it
    // is rather than a missing prompt file, and every later stage uses this exact descriptor.
    const adapter = getAdapter(cli.values.executor);
    const prompt = readPrompt(cli);
    // The detached child is a separate process and resolves its own copy of both; there is nothing to
    // hand across the boundary.
    const result = cli.values.detach && !process.env.RELAY_DISPATCH_INTERNAL_RUN_ID
      ? await executeDetached(cli, argv)
      : await executeForeground(cli, { prompt, adapter });
    console.log(cli.values.json ? JSON.stringify(result, null, 2) : `${result.status}: ${result.run_id}`);
    return new Set(["failed", "cancelled", "timed_out", "spawn_error"]).has(result.status) ? 1 : 0;
  } catch (error) {
    const code = error.code || "DISPATCH_FAILED";
    const payload = { ok: false, code, error: error.message };
    if (CLEANUP_REFUSALS.has(code) && error.terminal) {
      payload.terminal = error.terminal;
    }
    if (code === "HOST_CLEANUP_EXTERNAL_ACTION_REQUIRED") {
      payload.recommended_action = error.recommended_action;
      payload.process_identity = error.process_identity;
      payload.relay_signalled = false;
    }
    if (process.env.RELAY_DISPATCH_NOTIFY_PATH) {
      try { atomicJson(process.env.RELAY_DISPATCH_NOTIFY_PATH, payload); } catch {}
    }
    let salvaged = null;
    try { salvaged = await salvageTerminalResult(cli); } catch {}
    if (salvaged) {
      console.log(cli?.values?.json ? JSON.stringify(salvaged, null, 2) : `${salvaged.status}: ${salvaged.run_id}`);
    }
    console.error(cli?.values?.json ? JSON.stringify(payload) : `relay-dispatch: ${error.message}`);
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { assertResumeInspection, dryRunInvocation, executeForeground, finishAttempt, main, parseCli, repositoryIdentity, startAttempt, validateCopyInputs };
