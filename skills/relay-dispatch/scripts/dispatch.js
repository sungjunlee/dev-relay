#!/usr/bin/env node
/**
 * Create a worktree and dispatch a task to an executor.
 *
 * Executor-agnostic orchestrator: worktree -> execute -> collect -> retain.
 * Executors are selected through the universal adapter registry.
 *
 * Usage:
 *   ./dispatch.js <repo-path> --branch <name> --prompt <task>  [options]
 *   ./dispatch.js <repo-path> --branch <name> --prompt-file <path> [options]
 *   ./dispatch.js <repo-path> --run-id <id> --prompt <task> [options]
 *   ./dispatch.js --manifest <path> --prompt-file <path> [options]
 *
 * Options:
 *   --branch, -b <name>    Branch name (required)
 *   --run-id <id>          Resume an existing run, or reserve id for new dispatch with --branch
 *   --manifest <path>      Resume an existing relay run from its manifest
 *   --prompt, -p <text>    Task prompt
 *   --prompt-file <path>   Read prompt from file (for large prompts)
 *   --executor, -e <name>  Executor to use (default: codex)
 *   --model, -m <name>     Explicit model selection (omitted: adapter provider default)
 *   --sandbox <mode>       workspace-write | read-only (default: workspace-write)
 *   --network-access <mode> disabled | enabled (default: disabled; codex workspace-write only)
 *   --copy <file,...>      Additional files to copy
 *   --timeout <seconds>    Exec timeout (default: 2400 for codex, 1800 for others)
 *   --reasoning <level>    Explicit Codex reasoning effort override (omitted: provider default)
 *   --rubric-file <path>   REQUIRED: copy rubric YAML to run dir (persists for review)
 *   --test-command <cmd>   Record the executor-side test command in execution evidence
 *   --publish-policy <mode> immediate | after-internal-review (default: immediate)
 *   --rubric-grandfathered Retired alias; dispatch rejects it
 *   --request-id <id>      Link the run back to a relay-ready request
 *   --leaf-id <id>         Link the run back to a relay-ready leaf handoff
 *   --ownership-json <json>  Validated fleet owner: sprint, track, component
 *   --done-criteria-file   Persist a frozen Done Criteria anchor path
 *   --register             Register session in executor's app (keeps worktree)
 *   --auto-recover-commit  Orchestrator-commit completed-uncommitted work (default: on)
 *   --no-auto-recover-commit  Opt out of the default orchestrator commit
 *   --detach               Launch detached supervisor and print a receipt
 *   --dry-run              Show plan without executing
 *   --json                 Output as JSON
 *
 * Examples:
 *   # Basic dispatch (default executor: codex)
 *   ./dispatch.js . -b feature-auth -p "Implement OAuth2 flow"
 *
 *   # With prompt file
 *   ./dispatch.js . -b fix-login --prompt-file TASK.md
 *
 *   # Explicit executor
 *   ./dispatch.js . -b feature-auth -e codex -p "Implement OAuth2 flow"
 *
 *   # Register session in executor app (keeps worktree for resumption)
 *   ./dispatch.js . -b feature-auth -p "..." --register
 *
 *   # Dry run
 *   ./dispatch.js . -b test --prompt "test" --dry-run --json
 */

const { execFileSync, spawn: nodeSpawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { pushAndOpenPR } = require("./dispatch-publish");
const {
  buildExecutionEvidence,
  buildExecutorVerificationInstructions,
  collectExecutorVerificationEvidence,
  extractVerificationGates,
  hashFileSha256,
  resolveExecutionEvidenceTestCommand,
  writeExecutionEvidence,
} = require("./execution-evidence");
const {
  createWorktree,
  formatDispatchDryRun,
  removeWorktree,
} = require("./worktree-runtime");
const { getExecutor: getLegacyExecutor } = require("./executors");
const { ADAPTER_PHASES, getAdapter, listAdapters } = require("./adapters");
const { assertInvocationIdentity, resolveAdapterProvider, validateCapabilities } = require("./adapter-contract");
const {
  collectEnvironmentSnapshot,
  compareEnvironmentSnapshot,
} = require("./manifest/environment");
const {
  createManifestSkeleton,
  readManifest,
  writeManifest,
} = require("./manifest/store");
const {
  createRunId,
  ensureRunLayout,
  getCanonicalRepoRoot,
  getRelayHome,
  getFleetIssueLockPath,
  getManifestPath,
  getRunDir,
  inferIssueNumber,
  looksLikeGitRepo,
  requireValidFleetId,
  sameFilesystemLocation,
  validateManifestPaths,
} = require("./manifest/paths");
const {
  findInflightRunsForIssue,
  formatInflightCollisionError,
  inferIssueFromPromptOrBranch,
} = require("./manifest/inflight-runs");
const {
  getRubricAnchorStatus,
  hasRubricPath,
  rejectLegacyGrandfatherField,
  validateRubricPathContainment,
} = require("./manifest/rubric");
const { findUnknownFlags, getPositionals, modeLabel, readArg, schemaHasFlag } = require("./cli-args");
const { captureLocalProcessIdentity, probeLocalProcess } = require("./host");
const {
  formatOwnership,
  normalizeOwnership,
  ownershipsEqual,
  parseOwnershipJson,
  validateOwnershipAgainstSprintState,
} = require("./ownership");
const { formatAttemptsForPrompt, readPreviousAttempts } = require("./manifest/attempts");
const { STATES, updateManifestState } = require("./manifest/lifecycle");
const { resolveManifestRecord } = require("./relay-resolver");
const { appendRunEvent, EVENTS } = require("./relay-events");
const { execGit } = require("./exec");
const {
  classifyRepositoryDirt,
  formatEmptyReviewableIndexError,
  formatRuntimeMetadataDirt,
  gitAddReviewableArgs,
} = require("./runtime-dirt");
const {
  dispatchManifestPathFields,
  getRunArtifactPaths,
  isProcessGroupAlive,
  latestRunEvent,
  removeRunLease,
  terminateProcessGroup,
  waitForProcessGroupExit,
  writeRunLease,
} = require("./run-runtime-state");

// Fleet admission is deliberately private to dispatch.  A fleet is now only an
// immutable cohort plus child-run lineage. This append-only admission ledger
// serializes mutation of the transient per-issue lock without recreating a
// fleet lifecycle/state subsystem. Only an unambiguously dead local generation
// may be closed; remote, malformed, or unreadable owners fail closed.
function fleetIssueLockPath(repoRoot, issueNumber) {
  return getFleetIssueLockPath(repoRoot, issueNumber);
}

// O_NOFOLLOW protects the final lock file, not a symlinked `fleets/` or
// `locks/` parent. Keep the configured relay home as the trust anchor (it may
// itself be an OS-level alias such as /var on macOS), then make the logical
// descendant and its canonical path agree component by component.
function trustedAdmissionLockPath(lockPath, { create = false } = {}) {
  const logicalHome = path.resolve(getRelayHome());
  const logicalDirectory = path.resolve(path.dirname(lockPath));
  if (create) fs.mkdirSync(logicalHome, { recursive: true });
  let canonicalHome;
  try {
    canonicalHome = fs.realpathSync(logicalHome);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`fleet admission relay home does not exist: ${logicalHome}`);
    throw error;
  }
  const relativeTo = (root) => path.relative(root, logicalDirectory);
  const isContainedRelative = (relative) => relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  // Internal callers retain canonical paths in their lock capability. Accept
  // either that canonical spelling or the configured logical spelling, but
  // never a sibling outside the configured relay home.
  const relative = isContainedRelative(relativeTo(logicalHome))
    ? relativeTo(logicalHome)
    : relativeTo(canonicalHome);
  if (!isContainedRelative(relative)) throw new Error(`fleet admission lock escapes relay home: ${lockPath}`);
  const expectedDirectory = path.join(canonicalHome, relative);
  let cursor = canonicalHome;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return path.join(expectedDirectory, path.basename(lockPath));
      fs.mkdirSync(cursor);
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink()) throw new Error(`fleet admission lock contains a symlink component: ${cursor}`);
    if (!stat.isDirectory()) throw new Error(`fleet admission lock parent is not a directory: ${cursor}`);
  }
  const canonicalDirectory = fs.realpathSync(logicalDirectory);
  if (canonicalDirectory !== expectedDirectory) {
    throw new Error(`fleet admission lock parent is not its canonical logical path: ${logicalDirectory}`);
  }
  return path.join(expectedDirectory, path.basename(lockPath));
}

function readAdmissionLockSnapshot(lockPath) {
  lockPath = trustedAdmissionLockPath(lockPath);
  let fd;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error("admission lock is not a regular file");
    const record = JSON.parse(fs.readFileSync(fd, "utf8"));
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("admission lock changed while being read");
    return { record, dev: before.dev, ino: before.ino };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function admissionMutationPath(lockPath) { return `${lockPath}.mutation`; }

function admissionGenerationBase(generation) {
  return String(generation).padStart(12, "0");
}

function fsyncAdmissionDirectory(directory, fsModule = fs) {
  let fd;
  try {
    fd = fsModule.openSync(directory, fsModule.constants.O_RDONLY);
    fsModule.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fsModule.closeSync(fd);
  }
}

function readImmutableAdmissionArtifact(artifactPath, label) {
  let fd;
  try {
    fd = fs.openSync(artifactPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    const pathname = fs.lstatSync(artifactPath);
    if (
      !opened.isFile()
      || pathname.isSymbolicLink()
      || opened.dev !== pathname.dev
      || opened.ino !== pathname.ino
    ) throw new Error(`${label} is not an immutable regular file`);
    const record = JSON.parse(fs.readFileSync(fd, "utf8"));
    const after = fs.fstatSync(fd);
    if (opened.dev !== after.dev || opened.ino !== after.ino) throw new Error(`${label} changed while being read`);
    return { record, dev: opened.dev, ino: opened.ino };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function publishImmutableAdmissionArtifact(target, record) {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`,
  );
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.linkSync(temporary, target);
    fsyncAdmissionDirectory(directory);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

// The issue lock is transient, but publishing it still has to be crash-safe:
// an interrupted direct O_EXCL write would leave malformed bytes that block
// every later admission. Publish a durable private inode, then atomically add
// its final name with link(2). A failed publication removes only the inode it
// just linked, so a later normal admission is never poisoned by partial bytes.
function publishIssueLockExclusive(lockPath, record, fsModule = fs) {
  const directory = path.dirname(lockPath);
  const temporary = path.join(
    directory,
    `.${path.basename(lockPath)}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`,
  );
  let fd;
  let linked = false;
  let published = null;
  try {
    fd = fsModule.openSync(temporary, "wx", 0o600);
    fsModule.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fsModule.fsyncSync(fd);
    const stat = fsModule.fstatSync(fd);
    fsModule.closeSync(fd); fd = undefined;

    try {
      fsModule.linkSync(temporary, lockPath);
      linked = true;
    } catch (error) {
      if (error.code === "EEXIST") return null;
      throw error;
    }
    published = { dev: stat.dev, ino: stat.ino };
    fsyncAdmissionDirectory(directory, fsModule);
    return published;
  } catch (error) {
    // If the final name was installed but its durability acknowledgement
    // failed, remove exactly that inode before returning the failure. Never
    // unlink a replacement published by another contender.
    if (linked && published) {
      try {
        const current = fsModule.lstatSync(lockPath);
        if (
          current.isFile()
          && !current.isSymbolicLink()
          && current.dev === published.dev
          && current.ino === published.ino
        ) {
          fsModule.unlinkSync(lockPath);
          fsyncAdmissionDirectory(directory, fsModule);
        }
      } catch {
        // Preserve the original publication failure. A cleanup failure leaves
        // the regular lock record for the existing dead-holder reclaim path.
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) try { fsModule.closeSync(fd); } catch {}
    try { fsModule.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function validateAdmissionOwner(record, { generation, lockPath } = {}) {
  if (
    !record
    || record.generation !== generation
    || record.lock_path !== lockPath
    || typeof record.token !== "string"
    || !/^[0-9a-f]{32}$/.test(record.token)
  ) throw new Error("fleet admission mutation owner is invalid");
  return record;
}

function validateAdmissionTerminal(record, owner) {
  if (
    !record
    || record.generation !== owner.generation
    || record.token !== owner.token
    || !["released", "broken"].includes(record.outcome)
  ) throw new Error("fleet admission mutation terminal marker is invalid");
  return record;
}

function admissionMutationSnapshot(lockPath) {
  lockPath = trustedAdmissionLockPath(lockPath);
  const directory = path.dirname(lockPath);
  const prefix = path.basename(admissionMutationPath(lockPath));
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ownerPattern = new RegExp(`^${escaped}\\.(\\d{12})\\.owner\\.json$`);
  const entries = fs.readdirSync(directory)
    .map((name) => ({ name, match: name.match(ownerPattern) }))
    .filter((entry) => entry.match)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, match }) => {
      const generation = Number(match[1]);
      const ownerPath = path.join(directory, name);
      const ownerArtifact = readImmutableAdmissionArtifact(ownerPath, "fleet admission mutation owner");
      const owner = validateAdmissionOwner(ownerArtifact.record, { generation, lockPath });
      const terminalPath = path.join(directory, `${prefix}.${admissionGenerationBase(generation)}.terminal.json`);
      let terminal = null;
      if (fs.existsSync(terminalPath)) {
        terminal = validateAdmissionTerminal(
          readImmutableAdmissionArtifact(terminalPath, "fleet admission mutation terminal").record,
          owner,
        );
      }
      return { generation, ownerPath, terminalPath, owner, ownerArtifact, terminal };
    });
  const active = entries.filter((entry) => !entry.terminal);
  if (active.length > 1) throw new Error("ambiguous fleet admission mutation generations");

  // A pre-generation guard can remain after upgrading from the former mutable
  // protocol. It blocks only while its exact local owner is still live; dead or
  // released legacy bytes are left untouched and the immutable ledger proceeds.
  const legacyPath = admissionMutationPath(lockPath);
  if (fs.existsSync(legacyPath)) {
    const legacy = readImmutableAdmissionArtifact(legacyPath, "legacy fleet admission mutation").record;
    const owner = { ...legacy, host: legacy?.host || legacy?.hostname };
    if (legacy?.state !== "released" && probeLocalProcess(owner).status !== "dead") {
      return { entries, active: null, legacyBlocked: true, nextGeneration: (entries.at(-1)?.generation || 0) + 1 };
    }
  }
  return {
    entries,
    active: active[0] || null,
    legacyBlocked: false,
    nextGeneration: (entries.at(-1)?.generation || 0) + 1,
  };
}

function prepareAdmissionMutationCandidate(lockPath, snapshot = admissionMutationSnapshot(lockPath)) {
  lockPath = trustedAdmissionLockPath(lockPath);
  if (snapshot.legacyBlocked || snapshot.active) return null;
  const generation = snapshot.nextGeneration;
  const token = crypto.randomBytes(16).toString("hex");
  const identity = captureLocalProcessIdentity();
  const owner = {
    generation,
    token,
    lock_path: lockPath,
    acquired_at: new Date().toISOString(),
    ...identity,
    hostname: identity.host,
  };
  const prefix = admissionMutationPath(lockPath);
  return {
    lockPath,
    generation,
    token,
    owner,
    ownerPath: `${prefix}.${admissionGenerationBase(generation)}.owner.json`,
    terminalPath: `${prefix}.${admissionGenerationBase(generation)}.terminal.json`,
  };
}

function commitAdmissionMutationCandidate(candidate) {
  if (!candidate || !publishImmutableAdmissionArtifact(candidate.ownerPath, candidate.owner)) return null;
  const snapshot = admissionMutationSnapshot(candidate.lockPath);
  if (
    !snapshot.active
    || snapshot.active.generation !== candidate.generation
    || snapshot.active.owner.token !== candidate.token
  ) return null;
  return {
    ...candidate,
    dev: snapshot.active.ownerArtifact.dev,
    ino: snapshot.active.ownerArtifact.ino,
  };
}

function publishAdmissionMutationTerminal(entry, outcome) {
  const terminal = {
    generation: entry.owner.generation,
    token: entry.owner.token,
    outcome,
    completed_at: new Date().toISOString(),
  };
  if (publishImmutableAdmissionArtifact(entry.terminalPath, terminal)) return true;
  const existing = validateAdmissionTerminal(
    readImmutableAdmissionArtifact(entry.terminalPath, "fleet admission mutation terminal").record,
    entry.owner,
  );
  return existing.outcome === outcome;
}

function acquireAdmissionMutation(lockPath) {
  lockPath = trustedAdmissionLockPath(lockPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const snapshot = admissionMutationSnapshot(lockPath);
    if (snapshot.legacyBlocked) return null;
    if (snapshot.active) {
      if (probeLocalProcess(snapshot.active.owner).status !== "dead") return null;
      // The true owner may publish `released` between our dead probe and the
      // terminal election. Either terminal closes this generation, so follow
      // the immutable ledger again instead of surfacing a false contention.
      if (!publishAdmissionMutationTerminal(snapshot.active, "broken")) continue;
      continue;
    }
    const acquired = commitAdmissionMutationCandidate(
      prepareAdmissionMutationCandidate(lockPath, snapshot),
    );
    if (acquired) return acquired;
  }
  return null;
}

function releaseAdmissionMutation(mutation) {
  if (!mutation) return false;
  try {
    const snapshot = admissionMutationSnapshot(mutation.lockPath);
    if (
      !snapshot.active
      || snapshot.active.generation !== mutation.generation
      || snapshot.active.owner.token !== mutation.token
      || snapshot.active.ownerArtifact.dev !== mutation.dev
      || snapshot.active.ownerArtifact.ino !== mutation.ino
    ) return false;
    return publishAdmissionMutationTerminal(snapshot.active, "released");
  } catch {
    return false;
  }
}

function localHolderIsDead(record) {
  if (!record) return false;
  return probeLocalProcess({ ...record, host: record.host || record.hostname }).status === "dead";
}

function acquireIssueLock({ repoRoot, issueNumber, fleetId, runId }) {
  const lockPath = trustedAdmissionLockPath(fleetIssueLockPath(repoRoot, issueNumber), { create: true });
  const token = crypto.randomBytes(16).toString("hex");
  const identity = captureLocalProcessIdentity();
  const record = { issue_number: Number(issueNumber), fleet_id: fleetId, run_id: runId,
    token, acquired_at: new Date().toISOString(), ...identity, hostname: identity.host };
  const mutation = acquireAdmissionMutation(lockPath);
  if (!mutation) throw new Error(`Refusing to dispatch: fleet admission mutation is active at ${lockPath}`);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const published = publishIssueLockExclusive(lockPath, record);
        if (published) return { lockPath, token, ...published };
      } catch (error) {
        throw error;
      }
      try {
        let observed;
        try { observed = readAdmissionLockSnapshot(lockPath); } catch {
          throw new Error(`Refusing to dispatch: ambiguous fleet admission lock at ${lockPath}`);
        }
        if (!localHolderIsDead(observed.record)) {
          throw new Error(`Refusing to dispatch: fleet admission lock is held at ${lockPath}`);
        }
        const current = readAdmissionLockSnapshot(lockPath);
        if (
          current.dev !== observed.dev || current.ino !== observed.ino ||
          current.record?.token !== observed.record?.token || !localHolderIsDead(current.record)
        ) {
          throw new Error(`Refusing to dispatch: fleet admission lock changed during dead-holder reclaim at ${lockPath}`);
        }
        fs.unlinkSync(lockPath);
        fsyncAdmissionDirectory(path.dirname(lockPath));
      } catch (error) {
        throw error;
      }
    }
  } finally {
    releaseAdmissionMutation(mutation);
  }
  throw new Error(`Refusing to dispatch: fleet admission lock remains contested at ${lockPath}`);
}

function releaseIssueLock(lock) {
  if (!lock?.lockPath || !lock.token || lock.dev === undefined || lock.ino === undefined) return false;
  let mutation;
  try {
    mutation = acquireAdmissionMutation(lock.lockPath);
    if (!mutation) return false;
    const current = readAdmissionLockSnapshot(lock.lockPath);
    if (current.dev !== lock.dev || current.ino !== lock.ino || current.record?.token !== lock.token) return false;
    fs.unlinkSync(lock.lockPath);
    return true;
  } catch { return false; }
  finally { releaseAdmissionMutation(mutation); }
}

function acquireIssueAdmission({ repoRoot, issueNumber, fleetId, runId, scanInflight }) {
  const lock = acquireIssueLock({ repoRoot, issueNumber, fleetId, runId });
  try {
    return { lock, inflightRuns: scanInflight() };
  } catch (error) {
    releaseIssueLock(lock);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const KNOWN_FLAGS = [
  "--branch", "-b", "--run-id", "--manifest", "--prompt", "-p", "--prompt-file", "--executor", "-e",
  "--model", "-m", "--sandbox", "--network-access", "--copy", "--timeout", "--reasoning", "--rubric-file", "--test-command", "--rubric-grandfathered",
  "--request-id", "--leaf-id", "--fleet-id", "--issue-number", "--ownership-json", "--done-criteria-file", "--publish-policy",
  "--register", "--auto-recover-commit", "--no-auto-recover-commit", "--allow-conflicting-run", "--detach", "--dry-run", "--json", "--help", "-h",
];
const CLI_ARG_OPTIONS = {
  reservedFlags: KNOWN_FLAGS,
  booleanFlags: [
    "--rubric-grandfathered", "--register", "--auto-recover-commit", "--no-auto-recover-commit",
    "--allow-conflicting-run", "--detach", "--dry-run", "--json", "--help", "-h",
  ],
  verbatimValueFlags: [
    "--branch", "-b", "--manifest", "--prompt", "-p", "--prompt-file", "--copy",
    "--rubric-file", "--test-command", "--done-criteria-file", "--ownership-json",
  ],
};
const hasCliFlag = (flag) => schemaHasFlag(args, flag, CLI_ARG_OPTIONS);
const JSON_OUT_REQUESTED = hasCliFlag("--json");

function failEarly(message, extra = {}) {
  if (JSON_OUT_REQUESTED) {
    console.log(JSON.stringify({
      status: "failed",
      error: message,
      ...extra,
    }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(1);
}

if (args.some((arg) => arg === "--coordination-marker" || arg.startsWith("--coordination-marker="))) {
  failEarly(
    "--coordination-marker is no longer supported; the coordination-marker seam was removed and nothing replaces it."
  );
}

if (!args.length || hasCliFlag(["--help", "-h"])) {
  console.log("Usage: dispatch.js <repo-path> --branch <name> --prompt <task> [options]");
  console.log("       dispatch.js <repo-path> --branch <name> --prompt-file <path> [options]");
  console.log("       dispatch.js <repo-path> --run-id <id> --prompt <task> [options]");
  console.log("       dispatch.js --manifest <path> --prompt-file <path> [options]");
  console.log("\nOptions:");
  console.log(`  --branch, -b       ${modeLabel("--branch", CLI_ARG_OPTIONS)} Branch name (required)`);
  console.log(`  --run-id           ${modeLabel("--run-id", CLI_ARG_OPTIONS)} Resume an existing run, or reserve id for new dispatch with --branch`);
  console.log(`  --manifest         ${modeLabel("--manifest", CLI_ARG_OPTIONS)} Resume an existing relay run from its manifest`);
  console.log(`  --prompt, -p       ${modeLabel("--prompt", CLI_ARG_OPTIONS)} Task prompt`);
  console.log(`  --prompt-file      ${modeLabel("--prompt-file", CLI_ARG_OPTIONS)} Read prompt from file`);
  console.log(`  --executor, -e     ${modeLabel("--executor", CLI_ARG_OPTIONS)} Executor: ${listAdapters().join(", ")} (default: codex)`);
  console.log(`  --model, -m        ${modeLabel("--model", CLI_ARG_OPTIONS)} Explicit model selection (omitted: adapter provider default)`);
  console.log(`  --sandbox          ${modeLabel("--sandbox", CLI_ARG_OPTIONS)} workspace-write | read-only (default: workspace-write)`);
  console.log(`  --network-access   ${modeLabel("--network-access", CLI_ARG_OPTIONS)} disabled | enabled (default: disabled; codex workspace-write only)`);
  console.log(`  --copy <files>     ${modeLabel("--copy", CLI_ARG_OPTIONS)} Additional files to copy (comma-separated)`);
  console.log(`  --timeout          ${modeLabel("--timeout", CLI_ARG_OPTIONS)} Exec timeout in seconds (default: 2400 for codex, 1800 for others)`);
  console.log(`  --reasoning        ${modeLabel("--reasoning", CLI_ARG_OPTIONS)} Explicit Codex reasoning effort (omitted: provider default)`);
  console.log(`  --rubric-file      ${modeLabel("--rubric-file", CLI_ARG_OPTIONS)} REQUIRED: copy rubric YAML to run dir (persists for review)`);
  console.log(`  --test-command     ${modeLabel("--test-command", CLI_ARG_OPTIONS)} Record the executor-side test command in execution evidence`);
  console.log(`  --publish-policy   ${modeLabel("--publish-policy", CLI_ARG_OPTIONS)} PR publication policy: immediate | after-internal-review (default: immediate)`);
  console.log(`  --rubric-grandfathered  ${modeLabel("--rubric-grandfathered", CLI_ARG_OPTIONS)} Retired alias; remove anchor.rubric_grandfathered manually`);
  console.log(`  --request-id       ${modeLabel("--request-id", CLI_ARG_OPTIONS)} Link the run back to a relay-ready request`);
  console.log(`  --leaf-id          ${modeLabel("--leaf-id", CLI_ARG_OPTIONS)} Link the run back to a relay-ready leaf handoff`);
  console.log(`  --fleet-id         ${modeLabel("--fleet-id", CLI_ARG_OPTIONS)} Link the run back to a relay fleet`);
  console.log(`  --issue-number     ${modeLabel("--issue-number", CLI_ARG_OPTIONS)} Explicit immutable issue identity for fleet admission`);
  console.log(`  --ownership-json   ${modeLabel("--ownership-json", CLI_ARG_OPTIONS)} Fleet owner JSON with sprint, track, and component`);
  console.log(`  --done-criteria-file  ${modeLabel("--done-criteria-file", CLI_ARG_OPTIONS)} Persist a frozen Done Criteria anchor path`);
  console.log(`  --register         ${modeLabel("--register", CLI_ARG_OPTIONS)} Register session in executor's app (keeps worktree)`);
  console.log(`  --auto-recover-commit  ${modeLabel("--auto-recover-commit", CLI_ARG_OPTIONS)} Orchestrator-commit completed-uncommitted work (default: on)`);
  console.log(`  --no-auto-recover-commit  ${modeLabel("--no-auto-recover-commit", CLI_ARG_OPTIONS)} Opt out of the default orchestrator commit`);
  console.log(`  --allow-conflicting-run  ${modeLabel("--allow-conflicting-run", CLI_ARG_OPTIONS)} Bypass the in-flight run check (logs conflicting_run_override event)`);
  console.log(`  --detach           ${modeLabel("--detach", CLI_ARG_OPTIONS)} Launch detached supervisor and print a receipt`);
  console.log(`  --dry-run          ${modeLabel("--dry-run", CLI_ARG_OPTIONS)} Show plan without executing`);
  console.log(`  --json             ${modeLabel("--json", CLI_ARG_OPTIONS)} Output as JSON`);
  process.exit(hasCliFlag(["--help", "-h"]) ? 0 : 1);
}

const UNKNOWN_FLAGS = findUnknownFlags(args, CLI_ARG_OPTIONS);
if (UNKNOWN_FLAGS.length) {
  console.error(`Error: unknown flags: ${UNKNOWN_FLAGS.join(", ")}`);
  process.exit(1);
}

// Positional arg: first arg that isn't a flag and isn't consumed as a flag's value.
const repoPathRaw = getPositionals(args, CLI_ARG_OPTIONS)[0];
const REPO_PATH = path.resolve(repoPathRaw || ".");
const BRANCH = readArg(args, ["--branch", "-b"], undefined, CLI_ARG_OPTIONS);
const RUN_ID = readArg(args, "--run-id", undefined, CLI_ARG_OPTIONS);
const MANIFEST_INPUT = readArg(args, "--manifest", undefined, CLI_ARG_OPTIONS);
const PROMPT = readArg(args, ["--prompt", "-p"], undefined, CLI_ARG_OPTIONS);
const PROMPT_FILE = readArg(args, "--prompt-file", undefined, CLI_ARG_OPTIONS);
const EXECUTOR_ARG = readArg(args, ["--executor", "-e"], undefined, CLI_ARG_OPTIONS);
const MODEL = readArg(args, ["--model", "-m"], undefined, CLI_ARG_OPTIONS);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const REASONING_OVERRIDE = readArg(args, "--reasoning", undefined, CLI_ARG_OPTIONS);
const SANDBOX = readArg(args, "--sandbox", "workspace-write", CLI_ARG_OPTIONS);
const NETWORK_ACCESS = readArg(args, "--network-access", "disabled", CLI_ARG_OPTIONS);
const COPY_FILES = readArg(args, "--copy", "", CLI_ARG_OPTIONS).split(",").filter(Boolean);
const RUBRIC_FILE = readArg(args, "--rubric-file", undefined, CLI_ARG_OPTIONS);
const TEST_COMMAND = readArg(args, "--test-command", undefined, CLI_ARG_OPTIONS);
const PUBLISH_POLICY_ARG = readArg(args, "--publish-policy", undefined, CLI_ARG_OPTIONS);
let PUBLISH_POLICY = PUBLISH_POLICY_ARG || "immediate";
const RUBRIC_GRANDFATHERED = hasCliFlag("--rubric-grandfathered");
const REQUEST_ID = readArg(args, "--request-id", undefined, CLI_ARG_OPTIONS);
const LEAF_ID = readArg(args, "--leaf-id", undefined, CLI_ARG_OPTIONS);
const FLEET_ID = readArg(args, "--fleet-id", undefined, CLI_ARG_OPTIONS);
const ISSUE_NUMBER_ARG_RAW = readArg(args, "--issue-number", undefined, CLI_ARG_OPTIONS);
const ISSUE_NUMBER_ARG = ISSUE_NUMBER_ARG_RAW === undefined ? null : Number(ISSUE_NUMBER_ARG_RAW);
if (ISSUE_NUMBER_ARG_RAW !== undefined && (!Number.isInteger(ISSUE_NUMBER_ARG) || ISSUE_NUMBER_ARG <= 0)) {
  failEarly("--issue-number must be a positive integer");
}
const OWNERSHIP_JSON_RAW = readArg(args, "--ownership-json", undefined, CLI_ARG_OPTIONS);
const DONE_CRITERIA_FILE = readArg(args, "--done-criteria-file", undefined, CLI_ARG_OPTIONS);
let EXECUTOR = null;
let adapter = null;
let TIMEOUT = null;
let executorPolicy = null;
let executorNetworkPolicy = null;
let AUTO_RECOVER_COMMIT = null;

function resolveDispatchRuntime(manifest) {
  const boundExecutor = nonEmptyString(manifest?.roles?.executor);
  if (boundExecutor && EXECUTOR_ARG && EXECUTOR_ARG !== boundExecutor) {
    failEarly(`--executor cannot replace immutable run binding '${boundExecutor}'`);
  }
  const executor = boundExecutor || EXECUTOR_ARG || "codex";
  let resolvedAdapter;
  try {
    resolvedAdapter = getAdapter(executor);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  const defaultTimeout = String(Math.max(1, Math.floor((resolvedAdapter.defaults?.timeoutMs ?? 1800000) / 1000)));
  const timeout = parseInt(readArg(args, "--timeout", defaultTimeout, CLI_ARG_OPTIONS), 10);
  if (isNaN(timeout) || timeout <= 0) {
    console.error("Error: --timeout must be a positive integer");
    process.exit(1);
  }
  if (!["disabled", "enabled"].includes(NETWORK_ACCESS)) {
    console.error("Error: --network-access must be disabled or enabled");
    process.exit(1);
  }
  let negotiatedCapability;
  try {
    negotiatedCapability = validateCapabilities(resolvedAdapter, ADAPTER_PHASES.DISPATCH, {
      readOnly: SANDBOX === "read-only",
      sandbox: SANDBOX,
      networkAccess: NETWORK_ACCESS,
    });
  } catch (error) {
    if (JSON_OUT_REQUESTED) {
      console.log(JSON.stringify({ status: "failed", executor, phase: "dispatch", error: error.message }, null, 2));
    }
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  for (const warn of (negotiatedCapability.warnings || [])) {
    console.error(`Warning: ${warn}`);
  }

  return {
    adapter: resolvedAdapter,
    autoRecoverCommit: AUTO_RECOVER_COMMIT_REQUESTED
      ? true
      : NO_AUTO_RECOVER_COMMIT
        ? false
        : true,
    executor,
    executorNetworkPolicy: {
      access: NETWORK_ACCESS,
      mechanism: NETWORK_ACCESS === "enabled" ? "sandbox_workspace_write.network_access" : "default",
      domains: null,
    },
    executorPolicy: negotiatedCapability,
    timeout,
  };
}

function resolveRecordedRepoRoot(repoPath) {
  const resolvedRepoPath = path.resolve(repoPath);
  const canonicalRepoRoot = getCanonicalRepoRoot(resolvedRepoPath);
  return path.basename(canonicalRepoRoot) === path.basename(resolvedRepoPath)
    ? resolvedRepoPath
    : canonicalRepoRoot;
}

function classifyNetworkFailure(text) {
  if (!text) return null;
  const patterns = [
    /CODEX_SANDBOX_NETWORK_DISABLED=1/i,
    /Could not resolve host/i,
    /error connecting to api\.github\.com/i,
    /network is unreachable/i,
    /Name or service not known/i,
    /Temporary failure in name resolution/i,
    /nodename nor servname provided/i,
    /failed to resolve .*domain/i,
  ];
  return patterns.some((pattern) => pattern.test(text)) ? "network_blocked_or_unavailable" : null;
}

const REGISTER = hasCliFlag("--register");
const AUTO_RECOVER_COMMIT_REQUESTED = hasCliFlag("--auto-recover-commit");
const NO_AUTO_RECOVER_COMMIT = hasCliFlag("--no-auto-recover-commit");
const ALLOW_CONFLICTING_RUN = hasCliFlag("--allow-conflicting-run");
const DETACH = hasCliFlag("--detach");
const DRY_RUN = hasCliFlag("--dry-run");
const JSON_OUT = JSON_OUT_REQUESTED;
const RESUME_MODE = !!MANIFEST_INPUT || (!!RUN_ID && !BRANCH);

if (AUTO_RECOVER_COMMIT_REQUESTED && NO_AUTO_RECOVER_COMMIT) {
  console.error("Error: use either --auto-recover-commit or --no-auto-recover-commit, not both");
  process.exit(1);
}

if (DETACH && DRY_RUN) {
  console.error("Error: use either --detach or --dry-run, not both");
  process.exit(1);
}

if (FLEET_ID) {
  try {
    requireValidFleetId(FLEET_ID);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (OWNERSHIP_JSON_RAW !== undefined && !FLEET_ID) {
  console.error("Error: --ownership-json requires --fleet-id");
  process.exit(1);
}

let OWNERSHIP = null;
try {
  OWNERSHIP = parseOwnershipJson(OWNERSHIP_JSON_RAW, {
    required: Boolean(FLEET_ID),
  });
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (RUN_ID && MANIFEST_INPUT) {
  console.error("Error: use either --run-id or --manifest, not both");
  process.exit(1);
}

if (!RESUME_MODE && !BRANCH) {
  console.error("Error: --branch is required for new dispatches");
  process.exit(1);
}

if (RUBRIC_FILE) {
  const rubricPath = path.resolve(RUBRIC_FILE);
  if (!fs.existsSync(rubricPath)) {
    console.error(`Error: rubric file not found: ${rubricPath}`);
    process.exit(1);
  }
}

if (RUBRIC_FILE && RUBRIC_GRANDFATHERED) {
  console.error("Error: use either --rubric-file or --rubric-grandfathered, not both");
  process.exit(1);
}

if (RUBRIC_GRANDFATHERED) {
  console.error("Error: --rubric-grandfathered is retired.");
  console.error(
    "Remove anchor.rubric_grandfathered from the manifest and persist anchor.rubric_path with --rubric-file."
  );
  process.exit(1);
}

if (DONE_CRITERIA_FILE) {
  const doneCriteriaPath = path.resolve(DONE_CRITERIA_FILE);
  if (!fs.existsSync(doneCriteriaPath)) {
    console.error(`Error: done criteria file not found: ${doneCriteriaPath}`);
    process.exit(1);
  }
}

if (!["immediate", "after-internal-review"].includes(PUBLISH_POLICY)) {
  console.error("Error: --publish-policy must be immediate or after-internal-review");
  process.exit(1);
}

if (!MANIFEST_INPUT && !fs.existsSync(path.join(REPO_PATH, ".git"))) {
  const msg = !fs.existsSync(REPO_PATH)
    ? `repo path does not exist: ${REPO_PATH}`
    : `not a git repository: ${REPO_PATH}`;
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertWithin(base, resolved, label) {
  const norm = path.resolve(resolved);
  if (!norm.startsWith(base + path.sep) && norm !== base) {
    console.error(`Error: ${label} escapes base directory: ${norm}`);
    process.exit(1);
  }
}

function isValidBaseBranchName(branch) {
  return typeof branch === "string" && branch.trim() !== "" && branch.trim() !== "HEAD";
}

function resolveOriginDefaultBranch(repoDir) {
  const remoteHeadRef = execGit(repoDir, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  const prefix = "refs/remotes/origin/";
  if (!remoteHeadRef.startsWith(prefix)) {
    throw new Error(`origin/HEAD resolved to unexpected ref '${remoteHeadRef}'`);
  }

  const branch = remoteHeadRef.slice(prefix.length).trim();
  if (!isValidBaseBranchName(branch)) {
    throw new Error(`origin/HEAD resolved to invalid branch '${branch || "(empty)"}'`);
  }
  return branch;
}

function fetchErrorMeansMissingRemoteBranch(error) {
  const detail = [
    error?.stderr,
    error?.stdout,
    error?.message,
  ].filter(Boolean).join("\n");
  return /could(n't| not) find remote ref/i.test(detail);
}

function hasOriginTrackingBranch(repoDir, branch) {
  try {
    execGit(repoDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function isRemoteValidBaseBranch(repoDir, branch) {
  try {
    execGit(repoDir, ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    return hasOriginTrackingBranch(repoDir, branch);
  } catch (error) {
    if (fetchErrorMeansMissingRemoteBranch(error)) {
      return false;
    }
    return hasOriginTrackingBranch(repoDir, branch);
  }
}

function hasOriginRemote(repoDir) {
  try {
    execGit(repoDir, ["remote", "get-url", "origin"]);
    return true;
  } catch {
    return false;
  }
}

function fallbackToOriginDefaultBranch(repoDir, detectedBranch) {
  try {
    const fallbackBranch = resolveOriginDefaultBranch(repoDir);
    console.error(
      `[relay-dispatch] base_branch fallback: rev-parse returned '${detectedBranch || "(empty)"}', using origin default '${fallbackBranch}'`
    );
    return fallbackBranch;
  } catch (error) {
    throw new Error(
      "unable to determine base branch for new dispatch when repository HEAD is detached. " +
      `Run 'git remote set-head origin --auto' to repair refs/remotes/origin/HEAD, then retry. (${error.message})`
    );
  }
}

function resolveBaseBranchForNewDispatch(repoDir, { validateRemote = true } = {}) {
  let detectedBranch = "";
  try {
    detectedBranch = execGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {}

  if (isValidBaseBranchName(detectedBranch)) {
    if (!validateRemote || !hasOriginRemote(repoDir) || isRemoteValidBaseBranch(repoDir, detectedBranch)) {
      return detectedBranch;
    }
    return fallbackToOriginDefaultBranch(repoDir, detectedBranch);
  }

  return fallbackToOriginDefaultBranch(repoDir, detectedBranch);
}

function firstErrorLine(error) {
  const detail = [
    error?.stderr,
    error?.stdout,
    error?.message,
    String(error),
  ].filter(Boolean)[0] || "unknown error";
  return String(detail).split("\n")[0];
}

function resolveWorktreeStartPointForNewDispatch(repoDir, baseBranch) {
  const originStartPoint = `refs/remotes/origin/${baseBranch}`;
  try {
    execGit(repoDir, ["fetch", "origin", `+refs/heads/${baseBranch}:${originStartPoint}`]);
    return originStartPoint;
  } catch (error) {
    const localStartPoint = `refs/heads/${baseBranch}`;
    console.error(
      `[relay-dispatch] WARNING: unable to fetch origin/${baseBranch} before worktree creation ` +
      `(${firstErrorLine(error)}); falling back to local ${localStartPoint}; ` +
      "unpushed local commits may contaminate the dispatch PR diff."
    );
    return localStartPoint;
  }
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const DETACH_RECEIPT_ENV = "RELAY_DISPATCH_DETACH_RECEIPT_PATH";
let detachReceiptWritten = false;

function removeDetachFlag(argv) {
  return argv.filter((arg) => arg !== "--detach" && !String(arg).startsWith("--detach="));
}

function appendRunIdArg(argv, runId) {
  return [...argv, "--run-id", runId];
}

function tailFile(filePath, maxBytes = 8192) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf-8").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function reconcileCommandForReceipt(repoRoot, runId) {
  return `node skills/relay-dispatch/scripts/reconcile-run.js --repo ${shellQuote(repoRoot)} --run-id ${runId}`;
}

function writeJsonFileAtomically(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function ensureEmptyFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "a");
  fs.closeSync(fd);
}

function writeDetachReceiptIfRequested({
  repoRoot,
  runId,
  manifestPath,
  runDir,
  stdoutLog,
  stderrLog,
}) {
  if (detachReceiptWritten) return;
  const receiptPath = process.env[DETACH_RECEIPT_ENV];
  if (!receiptPath) return;
  if (!runId || !manifestPath || !stdoutLog || !stderrLog) return;
  ensureEmptyFile(stdoutLog);
  ensureEmptyFile(stderrLog);
  writeJsonFileAtomically(receiptPath, {
    runId,
    runDir,
    manifestPath,
    stdoutLog,
    stderrLog,
    reconcileCommand: reconcileCommandForReceipt(repoRoot, runId),
  });
  detachReceiptWritten = true;
  delete process.env[DETACH_RECEIPT_ENV];
}

function buildDetachReceipt({ repoRoot, runId, manifestPath, runDir, stdoutLog, stderrLog, note = null }) {
  return {
    runId,
    runDir,
    manifestPath,
    stdoutLog,
    stderrLog,
    reconcileCommand: reconcileCommandForReceipt(repoRoot, runId),
    ...(note ? { note } : {}),
  };
}

function buildFallbackReceiptForRun({ repoRoot, runId, manifestPath, note }) {
  const paths = getRunArtifactPaths(repoRoot, runId);
  return buildDetachReceipt({
    repoRoot,
    runId,
    manifestPath,
    runDir: paths.runDir,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
    note,
  });
}

function planDetachedLaunch() {
  const childArgs = removeDetachFlag(args);

  if (!RESUME_MODE) {
    const runId = RUN_ID || createRunId({ issueNumber: ISSUE_NUMBER_ARG || inferIssueNumber(BRANCH), branch: BRANCH });
    const plannedChildArgs = RUN_ID ? childArgs : appendRunIdArg(childArgs, runId);
    return {
      childArgs: plannedChildArgs,
      fallbackReceipt: buildFallbackReceiptForRun({
        repoRoot: REPO_PATH,
        runId,
        manifestPath: getManifestPath(REPO_PATH, runId),
        note: "detached supervisor is still running; the child receipt was not written before the parent wait ceiling. The manifest may appear after setup finishes. Use the logs or reconcile command to follow progress.",
      }),
    };
  }

  try {
    const manifestPath = MANIFEST_INPUT ? path.resolve(MANIFEST_INPUT) : getManifestPath(REPO_PATH, RUN_ID);
    if (!fs.existsSync(manifestPath)) {
      return { childArgs, fallbackReceipt: null };
    }
    const record = readManifest(manifestPath);
    const runId = record.data?.run_id || RUN_ID;
    const repoRoot = record.data?.paths?.repo_root ? path.resolve(record.data.paths.repo_root) : REPO_PATH;
    if (!runId) {
      return { childArgs, fallbackReceipt: null };
    }
    return {
      childArgs,
      fallbackReceipt: buildFallbackReceiptForRun({
        repoRoot,
        runId,
        manifestPath,
        note: "detached supervisor is still running; the child receipt was not written before the parent wait ceiling. Use the logs or reconcile command to follow progress.",
      }),
    };
  } catch {
    return { childArgs, fallbackReceipt: null };
  }
}

async function waitForDetachReceipt({ receiptPath, stderrPath, stdoutPath, child, fallbackReceipt = null, timeoutMs = 30000 }) {
  const deadline = Date.now() + timeoutMs;
  let childExit = null;
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });
  while (true) {
    if (fs.existsSync(receiptPath)) {
      let receipt;
      try {
        receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
      } catch {
        await sleepAsync(25);
        continue;
      }
      if (!receipt.runId) {
        throw new Error(`detached dispatch wrote an invalid receipt without runId: ${receiptPath}`);
      }
      return receipt;
    }
    if (childExit) {
      const stderrTail = tailFile(stderrPath);
      const stdoutTail = tailFile(stdoutPath);
      const detail = stderrTail || stdoutTail || `child exited code=${childExit.code} signal=${childExit.signal || "none"}`;
      throw new Error(`detached dispatch exited before receipt: ${detail}`);
    }
    if (Date.now() >= deadline && fallbackReceipt) {
      return fallbackReceipt;
    }
    await sleepAsync(50);
  }
}

async function launchDetachedAndExit() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dispatch-detach-"));
  const receiptPath = path.join(tmpDir, "receipt.json");
  const stdoutPath = path.join(tmpDir, "supervisor-stdout.log");
  const stderrPath = path.join(tmpDir, "supervisor-stderr.log");
  const detachedLaunch = planDetachedLaunch();
  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");
  let child;
  try {
    child = nodeSpawn(process.execPath, [__filename, ...detachedLaunch.childArgs], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [DETACH_RECEIPT_ENV]: receiptPath,
      },
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    try { fs.closeSync(stdoutFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}
  }
  child.unref();
  const receipt = await waitForDetachReceipt({
    receiptPath,
    stderrPath,
    stdoutPath,
    child,
    fallbackReceipt: detachedLaunch.fallbackReceipt,
  });
  const output = {
    status: "detached",
    ...receipt,
    supervisorPid: child.pid,
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Detached dispatch launched: ${output.runId}`);
    console.log(`  Manifest:  ${output.manifestPath}`);
    console.log(`  Stdout log: ${output.stdoutLog}`);
    console.log(`  Stderr log: ${output.stderrLog}`);
    console.log(`  Reconcile:  ${output.reconcileCommand}`);
    if (output.note) console.log(`  Note:       ${output.note}`);
  }
}

function localBranchExists(repoRoot, branch) {
  if (!repoRoot || !branch) return false;
  try {
    execFileSync("git", ["show-ref", "--verify", `refs/heads/${branch}`], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function formatMissingResumeWorktreeError({ repoRoot, runId, worktreePath, branch, baseBranch }) {
  let reprovisionCommand = null;
  if (branch && localBranchExists(repoRoot, branch)) {
    reprovisionCommand = `git worktree add ${shellQuote(worktreePath)} ${shellQuote(branch)}`;
  } else if (branch && baseBranch) {
    reprovisionCommand = `git worktree add ${shellQuote(worktreePath)} -b ${shellQuote(branch)} ${shellQuote(baseBranch)}`;
  }
  // An externally deleted directory can still be REGISTERED as a worktree (and
  // its branch marked checked out there), which would make a bare `worktree add`
  // fail — clear the stale registration first.
  const unregisterCommand = `git worktree remove --force ${shellQuote(worktreePath)} 2>/dev/null || git worktree prune`;
  return [
    `retained worktree is missing for run '${runId}': ${worktreePath || "(unset)"}`,
    ...(reprovisionCommand
      ? [
          "Re-provision the retained worktree before resuming (clears any stale registration first):",
          `  ${unregisterCommand}`,
          `  ${reprovisionCommand}`,
        ]
      : [
          "Re-provision the retained worktree before resuming with create-worktree.js, then retry.",
        ]),
  ].join("\n");
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse `ps` rows into `{ pid, command }` entries for one process group. */
function parseProcessGroupPsInventory(output, pgid) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      if (Number(match[2]) !== Number(pgid)) return null;
      return { pid: Number(match[1]), command: match[3].trim() };
    })
    .filter(Boolean);
}

/** Best-effort inventory of live process-group members; never throws. */
function captureProcessGroupSurvivorInventory(pgid) {
  if (!pgid || !Number.isFinite(Number(pgid)) || process.platform === "win32") {
    return [];
  }
  try {
    // Prefer pgrep -g: group-scoped, avoids full-process-table scans that time out under load.
    try {
      const pgrepOut = execFileSync("pgrep", ["-g", String(pgid)], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
        maxBuffer: 1024 * 1024,
      });
      const pids = pgrepOut
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((pid) => Number.isFinite(pid) && pid > 0);
      return pids.map((pid) => {
        let command = "";
        try {
          command = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 1000,
          }).trim();
        } catch {
          // Command name is best-effort; keep the pid entry either way.
        }
        return { pid, command };
      });
    } catch (error) {
      // status 1 = no matches. Timeouts / missing binary: degrade to [] rather than
      // falling through to a full-table ps scan that can stall the supervisor under load.
      if (error && (error.status === 1 || error.code === "ETIMEDOUT" || error.killed)) {
        return [];
      }
    }

    // Fallback only when pgrep is unavailable (ENOENT): group-scoped ps, never full-table.
    const scoped = execFileSync("ps", ["-o", "pid=,pgid=,comm=", "-g", String(pgid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    return parseProcessGroupPsInventory(scoped, pgid);
  } catch {
    return [];
  }
}

const POSIX_LEASE_GATE_SCRIPT = [
  "lease_path=$1",
  "expected_pid=$2",
  "expected_pgid=$$",
  "shift 2",
  "attempt=0",
  "lease_matches() {",
  "  [ -f \"$lease_path\" ] || return 1",
  "  awk -v expected_pid=\"$expected_pid\" -v expected_pgid=\"$expected_pgid\" '",
  "    /\"pid\"[[:space:]]*:/ {",
  "      value = $0",
  "      sub(/^.*\"pid\"[[:space:]]*:[[:space:]]*/, \"\", value)",
  "      sub(/[^0-9].*$/, \"\", value)",
  "      if (value == expected_pid) pid_ok = 1",
  "    }",
  "    /\"pgid\"[[:space:]]*:/ {",
  "      value = $0",
  "      sub(/^.*\"pgid\"[[:space:]]*:[[:space:]]*/, \"\", value)",
  "      sub(/[^0-9].*$/, \"\", value)",
  "      if (value == expected_pgid) pgid_ok = 1",
  "    }",
  "    END { exit((pid_ok && pgid_ok) ? 0 : 1) }",
  "  ' \"$lease_path\"",
  "}",
  "while ! lease_matches; do",
  "  attempt=$((attempt + 1))",
  "  if [ \"$attempt\" -ge 600 ]; then",
  "    echo \"relay-dispatch: timed out waiting for fresh run lease: $lease_path pid=$expected_pid pgid=$expected_pgid\" >&2",
  "    exit 125",
  "  fi",
  "  sleep 0.05",
  "done",
  "exec \"$@\"",
].join("\n");

function buildLeaseGatedCommand({ cmd, args, leasePath }) {
  if (process.platform === "win32") {
    return { cmd, args };
  }
  return {
    cmd: "/bin/sh",
    args: ["-c", POSIX_LEASE_GATE_SCRIPT, "relay-dispatch-lease-gate", leasePath, String(process.pid), cmd, ...args],
  };
}

function maybePauseBeforeExecutorSpawnForTest() {
  const pauseMs = Number(process.env.RELAY_TEST_BEFORE_EXECUTOR_SPAWN_PAUSE_MS || 0);
  if (!Number.isFinite(pauseMs) || pauseMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, pauseMs));
}

function maybePauseAfterWorktreeCreateForTest() {
  const pauseMs = Number(process.env.RELAY_TEST_AFTER_WORKTREE_CREATE_PAUSE_MS || 0);
  if (!Number.isFinite(pauseMs) || pauseMs <= 0) return Promise.resolve();
  const markerPath = process.env.RELAY_TEST_AFTER_WORKTREE_CREATE_MARKER;
  if (markerPath) {
    try {
      fs.writeFileSync(markerPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf-8");
    } catch {}
  }
  return new Promise((resolve) => setTimeout(resolve, pauseMs));
}

function validateResumeRequestLinkage(manifest, { requestId, leafId, fleetId, doneCriteriaPath }) {
  const checks = [
    {
      field: "source.request_id",
      existing: manifest?.source?.request_id || null,
      incoming: requestId || null,
    },
    {
      field: "source.leaf_id",
      existing: manifest?.source?.leaf_id || null,
      incoming: leafId || null,
    },
    {
      field: "fleet_id",
      existing: manifest?.fleet_id || null,
      incoming: fleetId || null,
    },
    {
      field: "anchor.done_criteria_path",
      existing: manifest?.anchor?.done_criteria_path || null,
      incoming: doneCriteriaPath || null,
      normalize: (value) => path.resolve(value),
    },
  ];

  for (const check of checks) {
    if (!check.incoming) continue;

    if (!check.existing) {
      throw new Error(
        `same-run resume cannot add immutable ${check.field}; intake linkage must be bound when the run is created`
      );
    }

    const normalize = check.normalize || ((value) => value);
    if (normalize(check.existing) !== normalize(check.incoming)) {
      throw new Error(
        `same-run resume cannot change immutable ${check.field} (existing: ${check.existing}, incoming: ${check.incoming})`
      );
    }
  }
}

function validateResumeOwnership(manifest, incoming) {
  const fleetBound = Boolean(manifest?.fleet_id || FLEET_ID);
  if (fleetBound && !manifest?.ownership) {
    const fleetId = manifest?.fleet_id || FLEET_ID;
    throw new Error(
      "same-run fleet resume cannot add or guess missing immutable manifest.ownership; " +
      `resume the owning fleet '${fleetId}' with a validated single-track --leaves-file ` +
      "to perform the audited ownership backfill"
    );
  }

  const existing = manifest?.ownership
    ? normalizeOwnership(manifest.ownership, { label: "manifest.ownership" })
    : null;
  if (!incoming) return existing;
  if (!existing) {
    throw new Error(
      "same-run resume cannot add immutable manifest.ownership; ownership must be bound when the run is created"
    );
  }
  if (!ownershipsEqual(existing, incoming)) {
    throw new Error(
      `same-run resume cannot change immutable manifest.ownership (existing: ${formatOwnership(existing)}, incoming: ${formatOwnership(incoming)})`
    );
  }
  return existing;
}

function failRubricPersistence(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function formatManifestDisplayPath(manifestPath) {
  const resolvedPath = path.resolve(manifestPath);
  const homeDir = os.homedir();
  return resolvedPath.startsWith(`${homeDir}${path.sep}`)
    ? `~${resolvedPath.slice(homeDir.length)}`
    : resolvedPath;
}

function failRunDirCollision(runId, manifestPath) {
  console.error([
    "Refusing to overwrite existing run dir:",
    `  run_id: ${runId}`,
    `  manifest: ${formatManifestDisplayPath(manifestPath)}`,
    "Pass --run-id <id> to resume, or --manifest <path> to resume from an explicit manifest.",
  ].join("\n"));
  process.exit(1);
}

function readDispatchOwnerFile(ownerPath) {
  let bytes;
  let owner;
  try {
    bytes = fs.readFileSync(ownerPath, "utf-8");
    owner = JSON.parse(bytes);
  } catch {
    return null;
  }
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
  return { bytes, owner };
}

function isDispatchOwnerStale(owner) {
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function isDispatchClaimStale(claimPath) {
  const validated = readDispatchOwnerFile(claimPath);
  return validated !== null && isDispatchOwnerStale(validated.owner);
}

const DISPATCH_RECLAIM_GUARD_NAME = ".dispatch-claim.reclaim-lock";

function acquireDispatchReclaimGuard(runDir) {
  const guardPath = path.join(runDir, DISPATCH_RECLAIM_GUARD_NAME);
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = JSON.stringify({ pid: process.pid, claimed_at: new Date().toISOString(), nonce });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let guardFd;
    try {
      guardFd = fs.openSync(guardPath, "wx");
      try {
        fs.writeFileSync(guardFd, payload);
      } finally {
        fs.closeSync(guardFd);
      }
      const readback = readDispatchOwnerFile(guardPath);
      if (readback?.owner.pid !== process.pid || readback.owner.nonce !== nonce) return null;
      return { guardPath, nonce };
    } catch (error) {
      if (guardFd !== undefined) {
        try { fs.closeSync(guardFd); } catch {}
      }
      if (error.code !== "EEXIST" || attempt > 0) return null;
      const staleGuard = readDispatchOwnerFile(guardPath);
      if (!staleGuard || !isDispatchOwnerStale(staleGuard.owner)) return null;
      let currentBytes;
      try {
        currentBytes = fs.readFileSync(guardPath, "utf-8");
      } catch {
        return null;
      }
      if (currentBytes !== staleGuard.bytes) return null;
      try {
        fs.unlinkSync(guardPath);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") return null;
      }
    }
  }
  return null;
}

function isRetryCompatibleRunDir(runDir) {
  if (!fs.existsSync(runDir)) return false;
  const entries = fs.readdirSync(runDir).filter((entry) => entry !== ".DS_Store");
  const nonClaimEntries = entries.filter((entry) => entry !== ".dispatch-claim"
    && entry !== DISPATCH_RECLAIM_GUARD_NAME);
  if (nonClaimEntries.length > 1
    || (nonClaimEntries.length === 1 && nonClaimEntries[0] !== "done-criteria.md")) {
    return false;
  }
  const guardCompatible = !entries.includes(DISPATCH_RECLAIM_GUARD_NAME)
    || isDispatchClaimStale(path.join(runDir, DISPATCH_RECLAIM_GUARD_NAME));
  return guardCompatible && (!entries.includes(".dispatch-claim")
    || isDispatchClaimStale(path.join(runDir, ".dispatch-claim")));
}

function claimRetryCompatibleRunDir(runDir) {
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  try {
    fs.mkdirSync(runDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!isRetryCompatibleRunDir(runDir)) return null;
  }

  const claimPath = path.join(runDir, ".dispatch-claim");
  const hasReclaimGuard = () => fs.existsSync(path.join(runDir, DISPATCH_RECLAIM_GUARD_NAME));
  if (!fs.existsSync(claimPath) && !hasReclaimGuard()) {
    let claimFd;
    try {
      claimFd = fs.openSync(claimPath, "wx");
      fs.writeFileSync(claimFd, JSON.stringify({ pid: process.pid, claimed_at: new Date().toISOString() }));
      fs.closeSync(claimFd);
      return claimPath;
    } catch (error) {
      if (claimFd !== undefined) {
        fs.closeSync(claimFd);
        try { fs.unlinkSync(claimPath); } catch {}
      }
      if (error.code !== "EEXIST") throw error;
    }
  }

  const guard = acquireDispatchReclaimGuard(runDir);
  if (!guard) return null;
  let claimFd;
  let createdClaim = false;
  try {
    if (fs.existsSync(claimPath)) {
      const staleClaim = readDispatchOwnerFile(claimPath);
      if (!staleClaim || !isDispatchOwnerStale(staleClaim.owner)) return null;
      let currentBytes;
      try {
        currentBytes = fs.readFileSync(claimPath, "utf-8");
      } catch (error) {
        if (error.code !== "ENOENT") return null;
      }
      if (currentBytes !== undefined) {
        if (currentBytes !== staleClaim.bytes) return null;
        try {
          fs.unlinkSync(claimPath);
        } catch (error) {
          if (error.code !== "ENOENT") return null;
        }
      }
    }
    claimFd = fs.openSync(claimPath, "wx");
    createdClaim = true;
    try {
      fs.writeFileSync(claimFd, JSON.stringify({ pid: process.pid, claimed_at: new Date().toISOString() }));
    } finally {
      fs.closeSync(claimFd);
      claimFd = undefined;
    }
    return claimPath;
  } catch {
    if (claimFd !== undefined) {
      try { fs.closeSync(claimFd); } catch {}
    }
    if (createdClaim) {
      try { fs.unlinkSync(claimPath); } catch {}
    }
    return null;
  } finally {
    // If a guard owner dies in this few-syscall critical section, reclaiming it retains a
    // theoretical concurrent-unlink window. That requires the crash plus two contenders;
    // final ownership remains atomically arbitrated by the claim file's wx creation.
    const currentGuard = readDispatchOwnerFile(guard.guardPath);
    if (currentGuard?.owner.pid === process.pid && currentGuard.owner.nonce === guard.nonce) {
      try { fs.unlinkSync(guard.guardPath); } catch {}
    }
  }
}

function isCanonicalPlannerDoneCriteriaPath(repoRoot, runId, doneCriteriaPath) {
  if (!doneCriteriaPath) return false;
  const canonicalPath = path.join(getRunDir(repoRoot, runId), "done-criteria.md");
  return path.resolve(doneCriteriaPath) === canonicalPath
    || sameFilesystemLocation(doneCriteriaPath, canonicalPath);
}

function inferDoneCriteriaSource({ repoRoot, runId, doneCriteriaPath, requestId, leafId }) {
  if (!doneCriteriaPath) return null;
  if (requestId || leafId) return "request_snapshot";
  if (isCanonicalPlannerDoneCriteriaPath(repoRoot, runId, doneCriteriaPath)) {
    return "planner_decision";
  }
  return "file";
}

function copyFileAtomically(sourcePath, finalPath) {
  const tmpPath = `${finalPath}.tmp`;
  try {
    fs.copyFileSync(sourcePath, tmpPath);
    fs.renameSync(tmpPath, finalPath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

function persistDoneCriteria(manifest, runDir, originalPath, doneCriteriaSource) {
  if (!originalPath) return manifest;
  // Request/leaf-bound anchors already live durably under ~/.relay/requests/
  // and the request->run->review linkage depends on that exact path identity.
  if (doneCriteriaSource === "request_snapshot") return manifest;

  const persistedPath = path.join(runDir, "done-criteria.md");
  const isSelfCopy = sameFilesystemLocation(originalPath, persistedPath);
  if (!isSelfCopy) {
    try {
      copyFileAtomically(originalPath, persistedPath);
    } catch (error) {
      throw new Error(`Failed to persist Done Criteria from ${originalPath}: ${error.message}`);
    }
  }

  return {
    ...manifest,
    anchor: {
      ...(manifest.anchor || {}),
      done_criteria_path: persistedPath,
      ...(path.resolve(originalPath) === path.resolve(persistedPath)
        ? {}
        : { done_criteria_original_path: originalPath }),
    },
  };
}

function getPersistedRubricPath(runDir, rubricPath = "rubric.yaml") {
  const containment = validateRubricPathContainment(rubricPath, runDir);
  if (!containment.valid) {
    failRubricPersistence(containment.reason);
  }
  return containment;
}

function enforceRubricPersistence(manifest, runDir) {
  const legacyGrandfatherField = rejectLegacyGrandfatherField(manifest);
  if (!legacyGrandfatherField.ok) {
    failRubricPersistence(legacyGrandfatherField.error);
  }

  if (RUBRIC_FILE) {
    getPersistedRubricPath(runDir);
    return;
  }

  if (!hasRubricPath(manifest)) {
    failRubricPersistence(
      "--rubric-file is required. Generate the rubric with relay-plan and pass --rubric-file <path> to dispatch.js. " +
      "Retained manifests must carry anchor.rubric_path before dispatch resume."
    );
  }

  if (hasRubricPath(manifest)) {
    const rubricAnchor = getRubricAnchorStatus(manifest, { runDir });
    if (!rubricAnchor.satisfied) {
      failRubricPersistence(
        `${rubricAnchor.error} Re-dispatch with --rubric-file to repair the run's rubric anchor, ` +
        "or remove anchor.rubric_grandfathered if the retained manifest still carries it."
      );
    }
  }
}

function validateExecutorCli() {
  let adapter;
  try {
    adapter = getAdapter(EXECUTOR);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  const cli = adapter.metadata.cliBinary || EXECUTOR;
  let version;
  try {
    version = execFileSync(cli, ["--version"], { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    const message = `${cli} CLI not found.`;
    const hint = `Install '${cli}' and ensure it is available on PATH.`;
    if (JSON_OUT_REQUESTED) {
      console.log(JSON.stringify({
        status: "failed",
        error: message,
        hint,
      }, null, 2));
    }
    console.error(`Error: ${message}`);
    console.error(`hint: ${hint}`);
    process.exit(1);
  }
  return { binary: cli, version };
}

function findLatestRedispatchPrompt(runDir) {
  if (!runDir || !fs.existsSync(runDir)) return null;
  let latest = null;
  for (const entry of fs.readdirSync(runDir)) {
    const match = /^review-round-(\d+)-redispatch\.md$/.exec(entry);
    if (!match) continue;
    const round = parseInt(match[1], 10);
    if (!Number.isFinite(round)) continue;
    if (!latest || round > latest.round) {
      latest = { round, path: path.join(runDir, entry) };
    }
  }
  return latest;
}

const REDISPATCH_CRITERIA_PREFIXES = [
  /(?:^|\n)Original Done Criteria \(scope anchor\):\r?\n<task-content source="[^"]+">\r?\n$/,
  /(?:^|\n)Done Criteria:\r?\n$/,
];

function isGeneratorAnchoredOccurrence(prompt, start) {
  const before = prompt.slice(Math.max(0, start - 400), start);
  return REDISPATCH_CRITERIA_PREFIXES.some((pattern) => pattern.test(before));
}

function refreshRedispatchDoneCriteria(prompt, doneCriteria, previousDoneCriteria) {
  // The embedded criteria are author-controlled Markdown: marker-looking
  // lines (</task-content>, "Done Criteria:", convergence headings) can
  // legitimately appear INSIDE them, so the stale block is located by the
  // exact bytes the generating round recorded, never by structural markers.
  if (previousDoneCriteria === doneCriteria) return { status: "ok", prompt };
  if (!previousDoneCriteria) return { status: "not_found" };
  const anchoredOccurrences = [];
  let searchFrom = 0;
  while (searchFrom <= prompt.length - previousDoneCriteria.length) {
    const start = prompt.indexOf(previousDoneCriteria, searchFrom);
    if (start === -1) break;
    if (isGeneratorAnchoredOccurrence(prompt, start)) anchoredOccurrences.push(start);
    searchFrom = start + 1;
  }
  if (anchoredOccurrences.length === 0) return { status: "not_found" };
  if (anchoredOccurrences.length > 1) return { status: "ambiguous" };
  const [start] = anchoredOccurrences;
  return {
    status: "ok",
    prompt: prompt.slice(0, start) + doneCriteria + prompt.slice(start + previousDoneCriteria.length),
  };
}

function readTaskPrompt({ runDir, resumeMode, effectiveDoneCriteriaPath } = {}) {
  if (PROMPT_FILE) {
    const promptPath = path.resolve(PROMPT_FILE);
    if (!fs.existsSync(promptPath)) {
      console.error(`Error: prompt file not found: ${promptPath}`);
      process.exit(1);
    }
    const prompt = fs.readFileSync(promptPath, "utf-8");
    return { prompt: resumeMode ? prompt : prompt.trim(), source: "explicit-file", path: promptPath };
  }

  if (PROMPT) {
    return { prompt: PROMPT, source: "explicit-arg", path: null };
  }

  if (resumeMode) {
    const auto = findLatestRedispatchPrompt(runDir);
    if (auto) {
      let prompt = fs.readFileSync(auto.path, "utf-8");
      if (effectiveDoneCriteriaPath) {
        if (!fs.existsSync(effectiveDoneCriteriaPath)) {
          console.error(`Error: effective Done Criteria file not found: ${effectiveDoneCriteriaPath}`);
          process.exit(1);
        }
        const doneCriteria = fs.readFileSync(effectiveDoneCriteriaPath, "utf-8").trim();
        const roundDoneCriteriaPath = path.join(runDir, `review-round-${auto.round}-done-criteria.md`);
        if (!fs.existsSync(roundDoneCriteriaPath)) {
          console.error(`Error: cannot refresh Done Criteria in auto-discovered redispatch prompt: ${auto.path}`);
          console.error(`  Missing the round's recorded Done Criteria artifact: ${roundDoneCriteriaPath}`);
          console.error("  Pass --prompt-file to supply the redispatch prompt explicitly.");
          process.exit(1);
        }
        const previousDoneCriteria = fs.readFileSync(roundDoneCriteriaPath, "utf-8").trim();
        const refreshed = refreshRedispatchDoneCriteria(prompt, doneCriteria, previousDoneCriteria);
        if (refreshed.status !== "ok") {
          console.error(`Error: cannot refresh Done Criteria in auto-discovered redispatch prompt: ${auto.path}`);
          console.error(refreshed.status === "ambiguous"
            ? `  The round's recorded Done Criteria (${roundDoneCriteriaPath}) appear at more than one generated Done Criteria position.`
            : `  The round's recorded Done Criteria (${roundDoneCriteriaPath}) do not appear in the artifact.`);
          console.error("  Pass --prompt-file to supply the redispatch prompt explicitly.");
          process.exit(1);
        }
        prompt = refreshed.prompt;
      }
      return {
        prompt,
        source: "auto-discovered-redispatch",
        path: auto.path,
        round: auto.round,
      };
    }
    console.error("Error: --prompt or --prompt-file is required");
    console.error(
      `  Auto-discovery looked for review-round-<N>-redispatch.md in ${runDir} but found none.`
    );
    process.exit(1);
  }

  console.error("Error: --prompt or --prompt-file is required");
  process.exit(1);
}

function resolveRoleBinding(envName, fallback) {
  const explicit = process.env[envName];
  return typeof explicit === "string" && explicit.trim() ? explicit.trim() : fallback;
}

function resolveEffectiveDispatchModel({ cliModel, manifest, resumeMode = false }) {
  const dispatch = manifest?.dispatch;
  const hasModelBinding = !!dispatch && (
    Object.prototype.hasOwnProperty.call(dispatch, "model")
    || Object.prototype.hasOwnProperty.call(dispatch, "last_model")
  );
  const boundModel = nonEmptyString(
    Object.prototype.hasOwnProperty.call(dispatch || {}, "model")
      ? dispatch.model
      : dispatch?.last_model
  );
  if (hasModelBinding && cliModel && cliModel !== boundModel) {
    failEarly(`--model cannot replace immutable run binding '${boundModel || "adapter default"}'`);
  }
  if (resumeMode && !hasModelBinding && cliModel) {
    failEarly(
      "--model cannot be added to a legacy run without an immutable dispatch model binding; " +
      "resume with the recorded adapter default or migrate the run through an explicit audited migration"
    );
  }
  return hasModelBinding ? boundModel : nonEmptyString(cliModel);
}

function summarizeCommitMode({ status, gitLog, uncommitted }) {
  if (status === "completed-uncommitted") {
    return "completed-uncommitted, recover-commit required";
  }
  if (status === "completed" || status === "completed-with-warning") {
    return gitLog ? "committed in-sandbox" : status;
  }
  return status;
}

function readFileIfExists(filePath) {
  if (!filePath) return null;
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

function resolveRubricText({ rubricFile, manifest, runDir }) {
  if (rubricFile) return readFileIfExists(path.resolve(rubricFile));
  const rubricPath = manifest?.anchor?.rubric_path;
  if (!rubricPath || !runDir) return null;
  return readFileIfExists(path.join(runDir, rubricPath));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Worktree location: relay-owned, executor-agnostic.
  // All executors share the same base — manifest tracks the exact path.
  const RELAY_HOME = process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  const wtBase = process.env.RELAY_WORKTREE_BASE || path.join(RELAY_HOME, "worktrees");
  const wtId = crypto.randomBytes(4).toString("hex");
  let repoRoot = RESUME_MODE ? REPO_PATH : resolveRecordedRepoRoot(REPO_PATH);
  let wtPath = null;
  let resultFile = null;
  let stdoutLog = null;
  let stderrLog = null;
  const resolvedDoneCriteriaPath = DONE_CRITERIA_FILE ? path.resolve(DONE_CRITERIA_FILE) : null;
  let branch = BRANCH;
  let runId = RUN_ID;
  let manifestPath = MANIFEST_INPUT ? path.resolve(MANIFEST_INPUT) : null;
  let cleanupPolicy = "on_close";
  let baseBranch = "main";
  let worktreeStartPoint = null;
  let issueNumber = ISSUE_NUMBER_ARG || inferIssueNumber(branch);
  let manifest;
  let copiedFiles = [];
  let executorPid = null;
  let executorPgid = null;
  let executorClosePromise = null;
  let dispatchStartTime = null;
  let fleetIssueLock = null;
  let handlingSignal = false;
  let runtime = null;
  let runDirClaimPath = null;

  function releaseRunDirClaim() {
    if (!runDirClaimPath) return;
    try {
      fs.unlinkSync(runDirClaimPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    runDirClaimPath = null;
  }

  function releaseFleetIssueLock() {
    if (!fleetIssueLock) return;
    releaseIssueLock(fleetIssueLock);
    fleetIssueLock = null;
  }

  function failBeforeAdmission(message, extra = {}) {
    failEarly(message, {
      ...extra,
      recoverable: true,
    });
  }

  function persistInterruptedManifestForSignal() {
    if (!manifest || !manifestPath || !runId) return false;
    try {
      const runDir = getRunDir(repoRoot, runId);
      ensureRunLayout(repoRoot, runId);
      if (RUBRIC_FILE && !hasRubricPath(manifest)) {
        const rubricSrc = path.resolve(RUBRIC_FILE);
        const persistedRubric = getPersistedRubricPath(runDir, "rubric.yaml");
        copyFileAtomically(rubricSrc, persistedRubric.resolvedPath);
        manifest = {
          ...manifest,
          anchor: {
            ...(manifest.anchor || {}),
            rubric_path: persistedRubric.rubricPath,
          },
        };
      }
      if (!fs.existsSync(manifestPath)) {
        writeManifest(manifestPath, manifest);
      }
      return true;
    } catch {
      return false;
    }
  }

  function journalDispatchInterrupted(signal, executorTerminated, { reason = "signal" } = {}) {
    if (!manifest || !runId) return false;
    let runDir;
    try {
      if (!persistInterruptedManifestForSignal()) return false;
      runDir = getRunDir(repoRoot, runId);
      if (!fs.existsSync(runDir)) return false;
      appendRunEvent(repoRoot, runId, {
        event: EVENTS.DISPATCH_INTERRUPTED,
        state_from: manifest.state || null,
        state_to: manifest.state || null,
        reason,
        signal,
        executor_pid: executorPid,
        executor_pgid: executorPgid,
        elapsed_s: dispatchStartTime ? Math.max(0, Math.round((Date.now() - dispatchStartTime) / 1000)) : null,
        timeout_s: TIMEOUT,
        executor_terminated: executorTerminated,
        worktree: wtPath || null,
      });
      return true;
    } catch { return false; }
  }

  function printSignalRecoveryHint(signal, executorTerminated) {
    try {
      const command = manifestPath
        ? `node skills/relay-dispatch/scripts/dispatch.js --manifest ${manifestPath}`
        : "node skills/relay-dispatch/scripts/dispatch.js --manifest <manifest-path>";
      const suffix = signal === "SIGTERM" && !executorTerminated
        ? " The executor may still be running and may complete on its own."
        : signal === "SIGINT" && executorPid && !executorTerminated
          ? " Executor termination was requested, but the process group may still be running."
        : "";
      console.error(`Dispatch interrupted by ${signal}; retained worktree at ${wtPath || "(unknown)"}. Resume with: ${command}.${suffix}`);
    } catch {}
  }

  async function handleSignal(signal) {
    if (handlingSignal) return;
    handlingSignal = true;
    let executorTerminated = false;
    if (signal === "SIGINT") {
      const pgid = executorPgid || executorPid;
      terminateProcessGroup(pgid);
      executorTerminated = await waitForProcessGroupExit(pgid);
      if (executorClosePromise) {
        await Promise.race([
          executorClosePromise.catch(() => null),
          sleepAsync(100),
        ]);
      }
    }
    journalDispatchInterrupted(signal, executorTerminated);
    releaseFleetIssueLock();
    printSignalRecoveryHint(signal, executorTerminated);
    process.exit(1);
  }

  process.once("exit", () => {
    try { releaseRunDirClaim(); } catch {}
    try { releaseFleetIssueLock(); } catch {}
  });
  process.on("SIGINT", () => { void handleSignal("SIGINT"); });
  process.on("SIGTERM", () => { void handleSignal("SIGTERM"); });

  if (RESUME_MODE) {
    const manifestRecord = resolveManifestRecord({
      repoRoot,
      manifestPath: MANIFEST_INPUT,
      runId: RUN_ID,
    });
    manifestPath = manifestRecord.manifestPath;
    manifest = manifestRecord.data;
    try {
      validateResumeOwnership(manifest, OWNERSHIP);
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    const validatedPaths = validateManifestPaths(manifest.paths, {
      expectedRepoRoot: MANIFEST_INPUT ? undefined : ((repoPathRaw || looksLikeGitRepo(repoRoot)) ? repoRoot : undefined),
      manifestPath,
      runId: manifest.run_id || runId,
      allowMissingWorktree: true,
      caller: "dispatch resume",
    });
    repoRoot = validatedPaths.repoRoot;
    branch = manifest.git?.working_branch || branch;
    runId = manifest.run_id || runId;
    wtPath = validatedPaths.worktree;
    runtime = resolveDispatchRuntime(manifest);
    if (manifest.ownership || OWNERSHIP) {
      try {
        validateOwnershipAgainstSprintState(repoRoot, manifest.ownership || OWNERSHIP, {
          label: `leaf '${manifest.source?.leaf_id || LEAF_ID || branch}' ownership`,
        });
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    }
    manifest = {
      ...manifest,
      paths: {
        ...(manifest.paths || {}),
        repo_root: validatedPaths.repoRoot,
        worktree: validatedPaths.worktree,
      },
    };
    const manifestPublishPolicy = manifest.dispatch?.publish_policy || "immediate";
    if (PUBLISH_POLICY_ARG && PUBLISH_POLICY_ARG !== manifestPublishPolicy) {
      console.error(
        `Error: same-run resume cannot change dispatch.publish_policy from ${manifestPublishPolicy} to ${PUBLISH_POLICY_ARG}`
      );
      process.exit(1);
    }
    PUBLISH_POLICY = manifestPublishPolicy;
    if (!["immediate", "after-internal-review"].includes(PUBLISH_POLICY)) {
      console.error(`Error: manifest dispatch.publish_policy must be immediate or after-internal-review, got ${JSON.stringify(PUBLISH_POLICY)}`);
      process.exit(1);
    }
    cleanupPolicy = manifest.policy?.cleanup || cleanupPolicy;
    baseBranch = manifest.git?.base_branch || baseBranch;
    const manifestIssueNumber = manifest.issue?.number || inferIssueNumber(branch);
    if (ISSUE_NUMBER_ARG !== null && ISSUE_NUMBER_ARG !== manifestIssueNumber) {
      console.error(`Error: --issue-number cannot replace immutable run issue binding '${manifestIssueNumber || "none"}'`);
      process.exit(1);
    }
    issueNumber = manifestIssueNumber;

    if (!fs.existsSync(path.join(repoRoot, ".git"))) {
      console.error(`Error: manifest repo root is not a git repository: ${repoRoot}`);
      process.exit(1);
    }
    const interruptibleResumeState = manifest.state === STATES.DISPATCHED || manifest.state === STATES.DRAFT;
    const latestEvent = interruptibleResumeState ? latestRunEvent(repoRoot, runId) : null;
    const resumesInterruptedDispatch = interruptibleResumeState && latestEvent?.event === EVENTS.DISPATCH_INTERRUPTED;
    if (resumesInterruptedDispatch && isProcessGroupAlive(latestEvent.executor_pgid)) {
      console.error(
        `Error: interrupted executor process group is still alive for run '${runId}' ` +
        `(pid=${latestEvent.executor_pid ?? "unknown"}, pgid=${latestEvent.executor_pgid}). ` +
        "Wait for it to finish, or kill that process group before resuming."
      );
      process.exit(1);
    }
    if (manifest.state !== STATES.CHANGES_REQUESTED && !resumesInterruptedDispatch) {
      console.error(`Error: same-run resume requires state='${STATES.CHANGES_REQUESTED}', got '${manifest.state}'`);
      process.exit(1);
    }
    if (!branch) {
      console.error(`Error: manifest ${manifestPath} is missing git.working_branch`);
      process.exit(1);
    }
    if (validatedPaths.worktreeMissing) {
      console.error(`Error: ${formatMissingResumeWorktreeError({
        repoRoot,
        runId,
        worktreePath: manifest.paths?.worktree || wtPath,
        branch,
        baseBranch,
      })}`);
      process.exit(1);
    }
    if (!wtPath || !fs.existsSync(wtPath)) {
      console.error(`Error: retained worktree is missing for run '${runId}': ${wtPath || "(unset)"}`);
      process.exit(1);
    }
    try {
      const currentBranch = execGit(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (currentBranch !== branch) {
        console.error(`Error: retained worktree HEAD is '${currentBranch}', expected '${branch}'`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`Error: retained worktree is unusable: ${error.message}`);
      process.exit(1);
    }

    // --- Environment drift check ---
    const currentEnv = collectEnvironmentSnapshot(repoRoot, baseBranch);
    const needsDraftEnvironmentBackfill = manifest.state === STATES.DRAFT
      && resumesInterruptedDispatch
      && (
        !manifest.environment
        || ["node_version", "main_sha", "lockfile_hash", "dispatch_ts"].every((field) => manifest.environment[field] == null)
      );
    if (needsDraftEnvironmentBackfill) {
      manifest = {
        ...manifest,
        environment: currentEnv,
      };
      writeManifest(manifestPath, manifest);
    }
    const drift = compareEnvironmentSnapshot(manifest.environment, currentEnv);
    if (drift.length) {
      const driftMsg = drift.map(d => `${d.field}: ${d.from} → ${d.to}`).join(", ");
      if (!JSON_OUT) {
        console.error(`[WARN] Environment drift detected since initial dispatch: ${driftMsg}`);
      }
      appendRunEvent(repoRoot, runId, {
        event: EVENTS.ENVIRONMENT_DRIFT,
        state_from: manifest.state,
        state_to: manifest.state,
        reason: driftMsg,
      });
    }
  } else {
    runtime = resolveDispatchRuntime(null);
    if (OWNERSHIP) {
      try {
        validateOwnershipAgainstSprintState(repoRoot, OWNERSHIP, {
          label: `leaf '${LEAF_ID || branch}' ownership`,
        });
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    }
    const issueForCollisionCheck = issueNumber
      || inferIssueFromPromptOrBranch(branch, PROMPT);
    runId = runId || createRunId({ issueNumber, branch });
    let inflightRuns = null;
    if (FLEET_ID && issueForCollisionCheck && !DRY_RUN) {
      try {
        const admission = acquireIssueAdmission({
          repoRoot,
          issueNumber: issueForCollisionCheck,
          fleetId: FLEET_ID,
          runId,
          scanInflight: () => findInflightRunsForIssue(repoRoot, issueForCollisionCheck),
        });
        fleetIssueLock = admission.lock;
        inflightRuns = admission.inflightRuns;
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    }
    // Fleet admission is authoritative only after the per-issue exclusion is
    // held. This closes the stale-scan ABA window between discovery and lock.
    inflightRuns = inflightRuns || (issueForCollisionCheck
      ? findInflightRunsForIssue(repoRoot, issueForCollisionCheck)
      : []);
    if (inflightRuns.length > 0 && !ALLOW_CONFLICTING_RUN) {
      releaseFleetIssueLock();
      console.error("Error: " + formatInflightCollisionError(inflightRuns, { issueNumber: issueForCollisionCheck }));
      process.exit(1);
    }
    manifestPath = getManifestPath(repoRoot, runId);
    const runDir = getRunDir(repoRoot, runId);
    wtPath = path.join(wtBase, wtId, path.basename(repoRoot));
    if (fs.existsSync(manifestPath)) {
      failRunDirCollision(runId, manifestPath);
    }
    if (DRY_RUN) {
      if (fs.existsSync(runDir) && !isRetryCompatibleRunDir(runDir)) {
        failRunDirCollision(runId, manifestPath);
      }
    }
    baseBranch = resolveBaseBranchForNewDispatch(REPO_PATH, { validateRemote: !DRY_RUN });
    if (fs.existsSync(wtPath)) {
      console.error(`Error: worktree path already exists: ${wtPath}`);
      process.exit(1);
    }
    if (!DRY_RUN) {
      worktreeStartPoint = resolveWorktreeStartPointForNewDispatch(repoRoot, baseBranch);
      runDirClaimPath = claimRetryCompatibleRunDir(runDir);
      if (!runDirClaimPath) failRunDirCollision(runId, manifestPath);
    }
    if (inflightRuns.length > 0 && ALLOW_CONFLICTING_RUN) {
      appendRunEvent(repoRoot, runId, {
        event: EVENTS.CONFLICTING_RUN_OVERRIDE,
        state_from: STATES.DRAFT,
        state_to: STATES.DRAFT,
        reason: `bypassed ${inflightRuns.length} non-terminal run(s) for issue-${issueForCollisionCheck}: ${inflightRuns.map((run) => run.runId).join(", ")}`,
      });
    }
  }

  EXECUTOR = runtime.executor;
  adapter = runtime.adapter;
  TIMEOUT = runtime.timeout;
  executorPolicy = runtime.executorPolicy;
  executorNetworkPolicy = runtime.executorNetworkPolicy;
  AUTO_RECOVER_COMMIT = runtime.autoRecoverCommit;
  const runArtifactPaths = getRunArtifactPaths(repoRoot, runId);
  resultFile = runArtifactPaths.resultFile;
  stdoutLog = runArtifactPaths.stdoutLog;
  stderrLog = runArtifactPaths.stderrLog;
  const manifestPathFields = dispatchManifestPathFields(runArtifactPaths);

  if (RESUME_MODE) {
    try {
      const resumeDoneCriteriaPath = resolvedDoneCriteriaPath
        && manifest?.anchor?.done_criteria_original_path
        && sameFilesystemLocation(resolvedDoneCriteriaPath, manifest.anchor.done_criteria_original_path)
          ? manifest.anchor.done_criteria_path
          : resolvedDoneCriteriaPath;
      validateResumeRequestLinkage(manifest, {
        requestId: REQUEST_ID,
        leafId: LEAF_ID,
        fleetId: FLEET_ID,
        doneCriteriaPath: resumeDoneCriteriaPath,
      });
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  }

  const manifestRunDir = getRunDir(repoRoot, runId);
  enforceRubricPersistence(manifest, manifestRunDir);

  // A resumed run may carry a Done Criteria amendment: the operator edits the
  // original anchor file (or passes --done-criteria-file). The durable run-dir
  // copy must be refreshed BEFORE prompt delivery so the redispatch prompt and
  // every later review read the same amended criteria; when the original file
  // is gone (e.g. /tmp wiped), the persisted copy remains authoritative (#914).
  if (RESUME_MODE && manifest?.anchor?.done_criteria_original_path && manifest?.anchor?.done_criteria_path) {
    const livePath = resolvedDoneCriteriaPath || manifest.anchor.done_criteria_original_path;
    const persistedPath = manifest.anchor.done_criteria_path;
    if (fs.existsSync(livePath) && !sameFilesystemLocation(livePath, persistedPath)) {
      const liveBytes = fs.readFileSync(livePath, "utf-8");
      const persistedBytes = fs.existsSync(persistedPath) ? fs.readFileSync(persistedPath, "utf-8") : null;
      if (liveBytes !== persistedBytes) {
        copyFileAtomically(livePath, persistedPath);
      }
    }
  }

  const effectiveDoneCriteriaPath = resolvedDoneCriteriaPath || manifest?.anchor?.done_criteria_path || null;
  const taskPromptResult = readTaskPrompt({
    runDir: manifestRunDir,
    resumeMode: RESUME_MODE,
    effectiveDoneCriteriaPath,
  });
  let taskPrompt = taskPromptResult.prompt;
  if (taskPromptResult.source === "auto-discovered-redispatch" && !JSON_OUT) {
    console.log(`Auto-discovered redispatch prompt (round ${taskPromptResult.round}): ${taskPromptResult.path}`);
  }

  // --- Prepend iteration history on re-dispatch ---
  if (RESUME_MODE) {
    const previousAttempts = readPreviousAttempts(repoRoot, runId);
    const historySection = formatAttemptsForPrompt(previousAttempts);
    if (historySection) {
      taskPrompt = historySection + taskPrompt;
    }
  }

  const effectiveDispatchModel = resolveEffectiveDispatchModel({
    cliModel: MODEL,
    manifest,
    resumeMode: RESUME_MODE,
  });
  const provider = resolveAdapterProvider(adapter, effectiveDispatchModel);
  const rubricText = resolveRubricText({
    rubricFile: RUBRIC_FILE,
    manifest,
    runDir: manifestRunDir,
  });
  let evidenceTestCommand;
  let verificationGates;
  try {
    verificationGates = extractVerificationGates(rubricText);
    evidenceTestCommand = resolveExecutionEvidenceTestCommand({
      explicitTestCommand: TEST_COMMAND,
      rubricYaml: rubricText,
    });
  } catch (error) {
    failEarly(`Failed to seed execution evidence from verification gates: ${error.message}`, {
      error_code: "verification_gate_evidence_seed_failed",
      rubric_file: RUBRIC_FILE || manifest?.anchor?.rubric_path || null,
    });
  }
  // --- Dry run ---
  if (DRY_RUN) {
    const planFleetId = FLEET_ID || manifest?.fleet_id || null;
    const worktreePlan = createWorktree({
      repoRoot,
      worktreePath: wtPath,
      branch,
      title: `Dispatch: ${branch}`,
      register: REGISTER,
      dryRun: true,
    });
    const plan = {
      mode: RESUME_MODE ? "resume" : "new",
      runId,
      manifestPath,
      executor: EXECUTOR, worktree: wtPath, branch,
      prompt: taskPrompt.slice(0, 200),
      model: MODEL, sandbox: SANDBOX, networkAccess: NETWORK_ACCESS, register: REGISTER,
      resultFile, stdoutLog, stderrLog, timeout: TIMEOUT,
      cleanupPolicy,
      worktreeinclude: worktreePlan.worktreeinclude,
      rubricFile: RUBRIC_FILE || null,
      requestId: REQUEST_ID || manifest?.source?.request_id || null,
      leafId: LEAF_ID || manifest?.source?.leaf_id || null,
      doneCriteriaFile: resolvedDoneCriteriaPath || manifest?.anchor?.done_criteria_path || null,
      publishPolicy: PUBLISH_POLICY,
      environment: RESUME_MODE ? (manifest?.environment || null) : "collected-at-dispatch",
      runState: manifest?.state || null,
      dispatchSkipped: false,
      provider,
    };
    if (planFleetId) {
      plan.fleetId = planFleetId;
    }
    if (OWNERSHIP || manifest?.ownership) {
      plan.ownership = OWNERSHIP || manifest.ownership;
    }
    if (effectiveDispatchModel !== null) {
      plan.effective_dispatch_model = effectiveDispatchModel;
    }
    if (JSON_OUT) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(formatDispatchDryRun({
        runId,
        mode: RESUME_MODE ? "resume" : "new",
        executor: EXECUTOR,
        repoRoot,
        manifestPath,
        prompt: taskPrompt,
        model: effectiveDispatchModel,
        sandbox: SANDBOX,
        networkAccess: NETWORK_ACCESS,
        register: REGISTER,
        resultFile,
        cleanupPolicy,
        timeout: TIMEOUT,
        rubricFile: RUBRIC_FILE || null,
        requestId: REQUEST_ID || manifest?.source?.request_id || null,
        leafId: LEAF_ID || manifest?.source?.leaf_id || null,
        fleetId: planFleetId,
        doneCriteriaFile: resolvedDoneCriteriaPath || manifest?.anchor?.done_criteria_path || null,
        worktreePlan,
      }));
    }
    return;
  }

  const executorCli = validateExecutorCli();
  executorPolicy = {
    ...executorPolicy,
    cli: executorCli,
  };

  if (!RESUME_MODE) {
    const doneCriteriaSource = inferDoneCriteriaSource({
      repoRoot,
      runId,
      doneCriteriaPath: resolvedDoneCriteriaPath,
      requestId: REQUEST_ID,
      leafId: LEAF_ID,
    });
    manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch,
      baseBranch,
      issueNumber,
      worktreePath: wtPath,
      orchestrator: resolveRoleBinding("RELAY_ORCHESTRATOR", "unknown"),
      executor: EXECUTOR,
      reviewer: resolveRoleBinding("RELAY_REVIEWER", "unknown"),
      cleanupPolicy,
      requestId: REQUEST_ID || null,
      leafId: LEAF_ID || null,
      doneCriteriaPath: resolvedDoneCriteriaPath,
      doneCriteriaSource,
      fleetId: FLEET_ID,
      ownership: OWNERSHIP || undefined,
    });
    ensureRunLayout(repoRoot, runId);
    manifest = persistDoneCriteria(manifest, manifestRunDir, resolvedDoneCriteriaPath, doneCriteriaSource);
    manifest = {
      ...manifest,
      paths: {
        ...(manifest.paths || {}),
        ...manifestPathFields,
      },
      policy: {
        ...(manifest.policy || {}),
        executor_network: executorNetworkPolicy,
        executor_policy: executorPolicy,
      },
      dispatch: {
        ...(manifest.dispatch || {}),
        model: effectiveDispatchModel,
        provider,
        publish_policy: PUBLISH_POLICY,
      },
    };
    try {
      const created = createWorktree({
        repoRoot,
        worktreePath: wtPath,
        branch,
        title: `Dispatch: ${branch}`,
        startPoint: worktreeStartPoint,
        copyFiles: COPY_FILES,
        register: false,
        assertWithin,
        ...(process.env.RELAY_TEST_FAIL_CREATE_WORKTREE === "1"
          ? {
              dependencies: {
                gitRunner: () => {
                  throw new Error("injected create-worktree failure");
                },
              },
            }
          : {}),
      });
      copiedFiles = created.copiedFiles;
    } catch (error) {
      failBeforeAdmission(`worktree creation failed: ${error.message}`, {
        error_code: "worktree_creation_failed",
      });
    }
    await maybePauseAfterWorktreeCreateForTest();

    // Merge base branch into worktree so the executor works on merged state.
    // Prevents wasted rounds from stale-base conflicts or CI failures.
    // On merge conflict, the worktree is cleaned up and dispatch aborts.
    let fetchSucceeded = false;
    try {
      execGit(wtPath, ["fetch", "origin", baseBranch]);
      fetchSucceeded = true;
    } catch (fetchErr) {
      const msg = (fetchErr.stderr || fetchErr.message || String(fetchErr)).split("\n")[0];
      if (!msg.includes("does not appear to be a git repository")) {
        if (!JSON_OUT) console.log(`  Note: skipping base-branch merge (${msg})`);
      }
    }
    if (fetchSucceeded) {
      try {
        if (process.env.RELAY_TEST_FAIL_BASE_MERGE === "1") {
          const injected = new Error("injected base-branch merge failure");
          injected.stderr = "injected base-branch merge failure\n";
          throw injected;
        }
        execGit(wtPath, ["merge", `origin/${baseBranch}`, "--no-edit"]);
      } catch (mergeErr) {
        try { execGit(wtPath, ["merge", "--abort"]); } catch {}
        removeWorktree({ repoRoot, worktreePath: wtPath });
        const reason = (mergeErr.stderr || mergeErr.message || String(mergeErr)).split("\n")[0];
        failBeforeAdmission(`failed to merge origin/${baseBranch} into worktree: ${reason}`, {
          error_code: "base_branch_merge_failed",
        });
      }
    }

    const environment = collectEnvironmentSnapshot(repoRoot, baseBranch);
    manifest = {
      ...manifest,
      environment,
      policy: {
        ...(manifest.policy || {}),
        executor_network: executorNetworkPolicy,
        executor_policy: executorPolicy,
      },
    };
    ensureRunLayout(repoRoot, runId);
    writeManifest(manifestPath, manifest);
    releaseRunDirClaim();
  } else if (manifest) {
    manifest = {
      ...manifest,
      paths: {
        ...(manifest.paths || {}),
        ...manifestPathFields,
      },
      policy: {
        ...(manifest.policy || {}),
        executor_network: executorNetworkPolicy,
        executor_policy: executorPolicy,
      },
    };
    writeManifest(manifestPath, manifest);
  }

  // --- Copy rubric file to run dir ---
  if (RUBRIC_FILE) {
    const rubricSrc = path.resolve(RUBRIC_FILE);
    const runDir = getRunDir(repoRoot, runId);
    const persistedRubric = getPersistedRubricPath(runDir, "rubric.yaml");
    const rubricDest = persistedRubric.resolvedPath;
    copyFileAtomically(rubricSrc, rubricDest);
    manifest = {
      ...manifest,
      anchor: {
        ...(manifest.anchor || {}),
        rubric_path: persistedRubric.rubricPath,
      },
    };
    const rubricAnchor = getRubricAnchorStatus(manifest, { runDir });
    if (!rubricAnchor.satisfied) {
      failRubricPersistence(rubricAnchor.error);
    }
    writeManifest(manifestPath, manifest);
  }

  // --- Step 3: Execute task ---
  // Executor adapter builds command + args + spawn cwd.

  let cmd, execArgs;
  let execCwd;
  let codexGitCommonDir = null;
  const reasoningRunDir = getRunDir(repoRoot, runId);

  // Prepend non-interactive directive so the model doesn't wait for approval
  // (e.g. brainstorming HARD-GATE or design-confirmation patterns).
  const executorVerificationInstructions = buildExecutorVerificationInstructions(verificationGates);
  const execPrompt =
    "[NON-INTERACTIVE DISPATCH] This is an automated, non-interactive execution. " +
    "Do not present plans for approval or wait for user confirmation. " +
    "Execute the task fully and autonomously.\n\n" +
    taskPrompt +
    (executorVerificationInstructions ? `\n\n${executorVerificationInstructions}` : "");

  const invocationPromptPath = path.join(reasoningRunDir, "dispatch-invocation-prompt.md");
  fs.writeFileSync(invocationPromptPath, execPrompt, "utf8");
  const buildResult = adapter.buildInvocation({
    phase: ADAPTER_PHASES.DISPATCH,
    cwd: wtPath,
    promptPath: invocationPromptPath,
    resultPath: resultFile,
    model: effectiveDispatchModel,
    sandbox: SANDBOX,
    networkAccess: NETWORK_ACCESS,
    reasoning: REASONING_OVERRIDE,
    timeoutMs: TIMEOUT * 1000,
  });
  executorPolicy = { ...executorPolicy, cli: executorPolicy?.cli || null };
  manifest = {
    ...manifest,
    policy: {
      ...(manifest.policy || {}),
      executor_network: executorNetworkPolicy,
      executor_policy: executorPolicy,
    },
  };
  cmd = buildResult.command;
  execArgs = buildResult.args;
  execCwd = buildResult.cwd;
  const addDirIndex = execArgs.indexOf("--add-dir");
  codexGitCommonDir = addDirIndex >= 0 ? execArgs[addDirIndex + 1] || null : null;
  if (!JSON_OUT) {
    console.log(`Dispatching to ${EXECUTOR}...`);
    console.log(`  Run:      ${runId}`);
    console.log(`  Worktree: ${wtPath}`);
    console.log(`  Branch:   ${branch}`);
    console.log(`  Manifest: ${manifestPath}`);
    if (copiedFiles.length) console.log(`  Copied:   ${copiedFiles.join(", ")}`);
    console.log(`  Network:  ${NETWORK_ACCESS}`);
    console.log(`  Result:   ${resultFile}`);
  }

  let exitCode = 0;
  let error = null;
  const startTime = Date.now();
  dispatchStartTime = startTime;
  let stderrText = "";

  // Record HEAD before execution so we can measure only new work.
  let startHead = "";
  try {
    startHead = execGit(wtPath, ["rev-parse", "HEAD"]);
  } catch {}

  fs.rmSync(resultFile, { force: true });
  const dispatchFromState = manifest.state;
  manifest = manifest.state === STATES.DISPATCHED
    ? {
        ...manifest,
        next_action: "await_dispatch_result",
      }
    : updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest = {
    ...manifest,
    git: {
      ...(manifest.git || {}),
      head_sha: startHead || null,
    },
    dispatch: {
      ...(manifest.dispatch || {}),
      last_executor: EXECUTOR,
      last_model: effectiveDispatchModel,
      last_provider: provider,
      publish_policy: PUBLISH_POLICY,
    },
  };
  writeManifest(manifestPath, manifest);
  appendRunEvent(repoRoot, runId, {
    event: EVENTS.DISPATCH_START,
    state_from: dispatchFromState,
    state_to: STATES.DISPATCHED,
    head_sha: startHead || null,
    reason: RESUME_MODE ? "same_run_resume" : "new_dispatch",
    executor: EXECUTOR,
    model: effectiveDispatchModel,
    provider,
    executor_network: executorNetworkPolicy,
    executor_policy: executorPolicy,
  });
  writeDetachReceiptIfRequested({
    repoRoot,
    runId,
    manifestPath,
    runDir: runArtifactPaths.runDir,
    stdoutLog,
    stderrLog,
  });
  await maybePauseBeforeExecutorSpawnForTest();
  assertInvocationIdentity(buildResult);

  // Redirect stdout/stderr to files. Using spawn with detached: true gives us
  // a killable process group (terminateProcessGroup sends SIGTERM to -pid).
  const stdoutFd = fs.openSync(stdoutLog, "w");
  const stderrFd = fs.openSync(stderrLog, "w");

  const spawnOpts = { stdio: ["ignore", stdoutFd, stderrFd], detached: true };
  if (execCwd) spawnOpts.cwd = execCwd;
  const gatedCommand = buildLeaseGatedCommand({
    cmd,
    args: execArgs,
    leasePath: runArtifactPaths.leasePath,
  });
  const child = nodeSpawn(gatedCommand.cmd, gatedCommand.args, spawnOpts);
  executorPid = child.pid;
  executorPgid = child.pid;
  if (executorPgid) {
    try {
      writeRunLease(repoRoot, runId, {
        pid: process.pid,
        pgid: executorPgid,
        timeoutS: TIMEOUT,
      });
    } catch (leaseError) {
      terminateProcessGroup(executorPgid);
      try { fs.closeSync(stdoutFd); } catch {}
      try { fs.closeSync(stderrFd); } catch {}
      throw new Error(`lease_write_failed: ${leaseError.message}`);
    }
    writeDetachReceiptIfRequested({
      repoRoot,
      runId,
      manifestPath,
      runDir: runArtifactPaths.runDir,
      stdoutLog,
      stderrLog,
    });
  }

  executorClosePromise = new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child.pid);
    }, TIMEOUT * 1000);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, timedOut });
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, signal: null, timedOut, spawnError: e });
    });
  });
  const execResult = await executorClosePromise;
  if (handlingSignal) return;
  if (executorPgid) {
    const processGroupGone = await waitForProcessGroupExit(executorPgid);
    if (!processGroupGone) {
      const cleanLeaderExit = !execResult.timedOut && !execResult.spawnError;
      if (cleanLeaderExit) {
        // Leader finished on its own; survivors are notifiers/helpers (e.g. SkyComputerUseClient).
        // Terminate the group, re-wait once, audit, then continue the normal completion path.
        const survivorInventory = captureProcessGroupSurvivorInventory(executorPgid);
        terminateProcessGroup(executorPgid);
        const survivorsTerminated = await waitForProcessGroupExit(executorPgid);
        appendRunEvent(repoRoot, runId, {
          event: EVENTS.EXECUTOR_GROUP_LINGERING,
          state_from: STATES.DISPATCHED,
          state_to: STATES.DISPATCHED,
          reason: "executor_group_survivors_after_clean_leader_exit",
          executor_pid: executorPid,
          executor_pgid: executorPgid,
          survivors_terminated: survivorsTerminated,
          survivor_inventory: survivorInventory,
        });
      } else {
        try { fs.closeSync(stdoutFd); } catch {}
        try { fs.closeSync(stderrFd); } catch {}
        appendRunEvent(repoRoot, runId, {
          event: EVENTS.DISPATCH_INTERRUPTED,
          state_from: STATES.DISPATCHED,
          state_to: STATES.DISPATCHED,
          reason: "executor_group_unsettled_after_leader_close",
          signal: null,
          executor_pid: executorPid,
          executor_pgid: executorPgid,
          elapsed_s: dispatchStartTime ? Math.max(0, Math.round((Date.now() - dispatchStartTime) / 1000)) : null,
          timeout_s: TIMEOUT,
          executor_terminated: false,
          worktree: wtPath || null,
        });
        throw new Error(
          `executor process group ${executorPgid} is still alive after executor leader exited; ` +
          `kept run lease at ${runArtifactPaths.leasePath}. Run reconcile-run.js for run ${runId}.`
        );
      }
    }
  }
  removeRunLease(repoRoot, runId);
  executorClosePromise = null;
  executorPid = null;
  executorPgid = null;

  if (execResult.timedOut) {
    exitCode = 1;
    error = (
      `executor total_timeout after ${TIMEOUT}s; ` +
      `stdout=${stdoutLog}; stderr=${stderrLog}; result=${resultFile}`
    );
  } else if (execResult.spawnError) {
    exitCode = 1;
    error = execResult.spawnError.message.split("\n")[0];
  } else if (execResult.code !== 0) {
    exitCode = execResult.code;
  }

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  if (fs.existsSync(stderrLog)) {
    stderrText = fs.readFileSync(stderrLog, "utf-8").trim();
    if (!error && stderrText) {
      error = stderrText.split("\n").slice(0, 10).join("\n");
    }
  }
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  try {
    const adapterOutcome = adapter.parseOutcome({
      phase: ADAPTER_PHASES.DISPATCH,
      exitCode,
      signal: execResult.signal,
      timedOut: execResult.timedOut,
      stdoutPath: stdoutLog,
      stderrPath: stderrLog,
      resultPath: resultFile,
    });
    if (exitCode === 0 && adapterOutcome.status === "failed") {
      exitCode = 1;
      error = `executor_result_finalize_failed: ${adapterOutcome.summary || "executor_result_parse_failed"}`;
    } else if (adapterOutcome.status === "succeeded" && adapterOutcome.output !== null) {
      const normalizedOutput = typeof adapterOutcome.output === "string"
        ? adapterOutcome.output
        : JSON.stringify(adapterOutcome.output);
      fs.writeFileSync(resultFile, normalizedOutput.endsWith("\n") ? normalizedOutput : `${normalizedOutput}\n`, "utf8");
    }
  } catch (finalizeError) {
    exitCode = exitCode || 1;
    error = error || `executor_result_finalize_failed: ${String(finalizeError.message || finalizeError).split("\n")[0]}`;
  }

  // --- Step 4: Collect results ---
  let resultText = "";
  if (fs.existsSync(resultFile)) {
    resultText = fs.readFileSync(resultFile, "utf-8").trim();
  }
  const networkFailure = classifyNetworkFailure([stderrText, resultText].filter(Boolean).join("\n"));
  if (networkFailure && !error) {
    error = networkFailure;
  }

  // Only show commits created by this run (startHead..HEAD).
  let gitLog = "";
  let currentHead = startHead;
  try {
    currentHead = execGit(wtPath, ["rev-parse", "HEAD"]);
    if (startHead && currentHead !== startHead) {
      gitLog = execGit(wtPath, ["log", "--oneline", `${startHead}..HEAD`]);
    }
  } catch {}

  let diffStat = "";
  try {
    if (startHead && gitLog) {
      diffStat = execGit(wtPath, ["diff", "--stat", `${startHead}..HEAD`]);
    }
  } catch {}

  // Also capture uncommitted diff for partial runs (timeout, interrupted).
  let uncommittedDiff = "";
  try {
    const wd = execGit(wtPath, ["diff", "--stat"]);
    const staged = execGit(wtPath, ["diff", "--stat", "--cached"]);
    uncommittedDiff = [wd, staged].filter(Boolean).join("\n");
  } catch {}

  // Check for uncommitted work (executor may have worked but not committed).
  // Executor runtime metadata is not reviewable repository work.
  let rawUncommitted = "";
  try {
    rawUncommitted = execGit(wtPath, ["status", "--porcelain"]);
  } catch {}
  const dirt = classifyRepositoryDirt(rawUncommitted);
  let uncommitted = dirt.reviewableStatus;

  const hasResult = resultText !== "";
  const dispatchFailureClass = execResult.timedOut
    ? "total_timeout"
    : !hasResult
    ? "no_result"
    : networkFailure || null;

  // Detect approval-wait: executor stopped to ask for confirmation instead of working.
  const BLOCKED_PATTERNS = [
    /waiting (?:on|for) (?:your )?approval/i,
    /before (?:proceeding|editing|making changes)/i,
    /please confirm/i,
  ];
  const looksBlocked = resultText && BLOCKED_PATTERNS.some((p) => p.test(resultText));

  // Determine actual status — hasWork must be based on NEW commits/changes only.
  const hasWork = gitLog || uncommitted;
  let status;
  if (looksBlocked) {
    status = "failed";
    error = error || `executor blocked on approval: ${resultText.split("\n")[0].slice(0, 120)}`;
  } else if (!hasResult) {
    status = "failed";
    error = error || (
      `executor no_result: produced no structured result file or summary (silent failure); ` +
      `stdout=${stdoutLog}; stderr=${stderrLog}; result=${resultFile}`
    );
  } else if (execResult.timedOut && hasWork) {
    status = "completed-with-warning";
  } else if (exitCode === 0 && !gitLog && dirt.hasOnlyRuntimeMetadataDirt) {
    status = "failed";
    error = error || (
      "executor produced no reviewable repository changes; only runtime metadata dirt was detected: " +
      `${formatRuntimeMetadataDirt(rawUncommitted)}. ` +
      "Rerun dispatch after producing source changes, or close the run as a no-op."
    );
  } else if (exitCode === 0 && !gitLog && !uncommitted) {
    status = "completed-no-op";
  } else if (exitCode === 0 && !gitLog && uncommitted) {
    status = "completed-uncommitted";
  } else if (exitCode === 0 && gitLog) {
    status = "completed";
  } else {
    status = exitCode === 0 ? "completed" : "failed";
  }

  // Issue B (orchestrator-owned commit): when the executor exits cleanly but left
  // reviewable work uncommitted, commit it now — before execution evidence is
  // written — so evidence binds once to the committed SHA and no post-hoc
  // recover-commit or evidence rebrand is needed. Gated identically to
  // the executor-independent auto-recover-commit decision. On failure, fall through with the original
  // completed-uncommitted status so the downstream recover-commit path still runs.
  //
  // Skip when another orchestrator has already superseded this run (manifest
  // advanced off DISPATCHED). Committing here would promote the run to `completed`
  // and trip the immediate-publish push below, which runs BEFORE the supervisor
  // supersede check (~line 3400) and would open a duplicate/conflicting PR for a
  // run this orchestrator no longer owns. Leaving it completed-uncommitted keeps
  // the prior behavior: the downstream recover-commit path is itself
  // supersede-guarded and correctly no-ops.
  let orchestratorCommitted = false;
  const supersededBeforeCommit = readManifest(manifestPath).data.state !== STATES.DISPATCHED;
  if (!DRY_RUN && AUTO_RECOVER_COMMIT && status === "completed-uncommitted" && !supersededBeforeCommit) {
    try {
      execGit(wtPath, gitAddReviewableArgs(rawUncommitted, wtPath));
      if (dirt.hasReviewableDirt && !execGit(wtPath, ["diff", "--cached", "--name-only"])) {
        throw new Error(formatEmptyReviewableIndexError(rawUncommitted));
      }
      execGit(wtPath, [
        "commit",
        "-m", `Relay run ${runId}`,
        "-m", `Executor reviewable changes committed by the relay orchestrator (run ${runId}).`,
      ]);
      currentHead = execGit(wtPath, ["rev-parse", "HEAD"]);
      if (startHead && currentHead !== startHead) {
        gitLog = execGit(wtPath, ["log", "--oneline", `${startHead}..HEAD`]);
      }
      uncommitted = classifyRepositoryDirt(execGit(wtPath, ["status", "--porcelain"])).reviewableStatus;
      if (!uncommitted) uncommittedDiff = "";
      orchestratorCommitted = true;
      status = "completed";
    } catch (orchestratorCommitError) {
      // Leave status as completed-uncommitted; the auto-recover-commit fallback runs
      // below. Surface the git failure reason — this is now the primary commit path,
      // so a silent no-op would hide why the unreliability tax persists (a
      // gitAddReviewableArgs bug, a pre-commit hook, or a missing git identity).
      orchestratorCommitted = false;
      console.error(
        `orchestrator_commit_failed (run ${runId}), falling back to recover-commit: ` +
        `${String(orchestratorCommitError.message || orchestratorCommitError).split("\n")[0]}`
      );
    }
  }

  let commitMode = summarizeCommitMode({ status, gitLog, uncommitted });
  if (orchestratorCommitted) commitMode = "orchestrator-committed";
  const delayedReviewHasUncommittedWork = PUBLISH_POLICY === "after-internal-review" && (
    status === "completed-uncommitted" || (status === "completed-with-warning" && uncommitted)
  );
  let delayedReviewRequiresRecover = false;
  if (delayedReviewHasUncommittedWork && !AUTO_RECOVER_COMMIT) {
    status = "failed";
    exitCode = exitCode || 1;
    error = "recover-commit required before internal review: executor left reviewable uncommitted changes";
    delayedReviewRequiresRecover = true;
  }

  let verificationEvidence = { runs: [], outputPath: null, exitCode: undefined };
  const canCollectVerificationGates = (
    !DRY_RUN
    && verificationGates.length > 0
    && exitCode === 0
    && (status === "completed" || status === "completed-no-op")
  );
  if (canCollectVerificationGates) {
    try {
      verificationEvidence = collectExecutorVerificationEvidence({
        gates: verificationGates,
        cwd: wtPath,
        headSha: currentHead || startHead,
        finalTreeSha: execGit(wtPath, ["rev-parse", "HEAD^{tree}"]),
        runDir: getRunDir(repoRoot, runId),
        resultText,
        executor: EXECUTOR,
      });
      const failedVerification = verificationEvidence.runs.find((run) => run.exit_code !== 0);
      if (failedVerification) {
        status = "failed";
        exitCode = failedVerification.exit_code || 1;
        error = (
          `verification_gate_failed: '${failedVerification.name}' exited ` +
          `${failedVerification.exit_code}; output=${failedVerification.output_path}`
        );
      }
    } catch (verificationError) {
      status = "failed";
      exitCode = exitCode || 1;
      error = `verification_gate_evidence_invalid: ${String(
        verificationError.message || verificationError
      ).split("\n")[0]}`;
      verificationEvidence = { runs: [], outputPath: null, exitCode: undefined };
    }
  }

  let prNumber = manifest.git?.pr_number ?? null;
  let prCreatedByUs = null;
  const shouldPublishImmediately = PUBLISH_POLICY === "immediate";
  if (
    shouldPublishImmediately
    && (status === "completed" || status === "completed-with-warning")
    && !DRY_RUN
    && gitLog
  ) {
    try {
      const prResult = await pushAndOpenPR({
        repoRoot,
        wtPath,
        branch,
        baseBranch,
        resultPreview: resultText,
        runId,
        executor: EXECUTOR,
      });
      prNumber = prResult.prNumber;
      prCreatedByUs = prResult.createdByUs;
    } catch (e) {
      status = "failed";
      exitCode = exitCode || 1;
      error = `push_or_pr_failed: ${String(e.message || e).split("\n")[0]}`;
    }
  }

  // Persist dispatch artifacts in the run directory for post-mortem analysis.
  const runDir = getRunDir(repoRoot, runId);
  try {
    fs.writeFileSync(path.join(runDir, "dispatch-prompt.md"), taskPrompt, "utf-8");
  } catch {}
  try {
    const persistedResultPath = path.join(runDir, "dispatch-result.txt");
    if (resultText && path.resolve(resultFile) !== path.resolve(persistedResultPath)) {
      fs.writeFileSync(persistedResultPath, resultText, "utf-8");
    }
  } catch {}
  let executionEvidencePath = null;
  try {
    executionEvidencePath = writeExecutionEvidence(runDir, buildExecutionEvidence({
      headSha: currentHead || startHead || null,
      testCommand: evidenceTestCommand,
      resultFilePath: verificationEvidence.outputPath
        || (fs.existsSync(resultFile) ? resultFile : null),
      executor: verificationEvidence.outputPath ? `${EXECUTOR} confirmed verification` : EXECUTOR,
      testExitCode: verificationEvidence.exitCode ?? exitCode,
      ...(verificationEvidence.runs.length
        ? { verificationRuns: verificationEvidence.runs }
        : {}),
    }));
  } catch (executionEvidenceError) {
    status = "failed";
    exitCode = exitCode || 1;
    error = `execution_evidence_write_failed: ${String(executionEvidenceError.message || executionEvidenceError)}`;
  }

  const dispatchSuccessState = PUBLISH_POLICY === "after-internal-review"
    ? STATES.INTERNAL_REVIEW_PENDING
    : STATES.REVIEW_PENDING;
  const dispatchSuccessNextAction = PUBLISH_POLICY === "after-internal-review"
    ? "run_internal_review"
    : "run_review";
  const dispatchTargetState = delayedReviewRequiresRecover
    ? STATES.INTERNAL_REVIEW_PENDING
    : status === "failed"
      ? STATES.ESCALATED
      : dispatchSuccessState;
  const dispatchNextAction = delayedReviewRequiresRecover
    ? "recover_commit_before_internal_review"
    : status === "failed"
      ? "inspect_dispatch_failure"
      : dispatchSuccessNextAction;
  const freshManifest = readManifest(manifestPath).data;
  const supervisorResultSuperseded = freshManifest.state !== STATES.DISPATCHED;
  const intendedOutcome = `${dispatchTargetState}_${dispatchFailureClass || status}`;
  if (supervisorResultSuperseded) {
    manifest = freshManifest;
  } else {
    manifest = updateManifestState(
      freshManifest,
      dispatchTargetState,
      dispatchNextAction
    );
    const { github: _legacyGithub, ...manifestSansGithub } = manifest;
    const { pr_number: _legacyGithubPrNumber, ...githubFields } = _legacyGithub || {};
    const github = {
      ...githubFields,
      ...(prCreatedByUs !== null ? { pr_created_by_orchestrator: prCreatedByUs } : {}),
    };
    manifest = {
      ...manifestSansGithub,
      git: {
        ...(manifestSansGithub.git || {}),
        ...(prNumber !== null ? { pr_number: prNumber } : {}),
        head_sha: currentHead || startHead || null,
      },
      ...(Object.keys(github).length ? { github } : {}),
    };
    writeManifest(manifestPath, manifest);
  }

  const shouldAutoRecoverCommit = !supervisorResultSuperseded && AUTO_RECOVER_COMMIT && !DRY_RUN && (
    status === "completed-uncommitted" ||
    (PUBLISH_POLICY === "after-internal-review" && status === "completed-with-warning" && uncommitted)
  );
  if (shouldAutoRecoverCommit) {
    const recoverCommitPath = path.join(__dirname, "recover-commit.js");
    const reason = `auto-recovered after dispatch returned ${status} with auto-recover-commit enabled (run ${runId})`;
    try {
      const recoveryOutput = execFileSync(process.execPath, [
        recoverCommitPath,
        "--repo", repoRoot,
        "--run-id", runId,
        "--reason", reason,
        "--json",
      ], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const recovery = JSON.parse(recoveryOutput);
      commitMode = "auto-recovered";
      prNumber = recovery.prNumber ?? prNumber;
      currentHead = recovery.commitSha || currentHead;
      try {
        gitLog = execGit(wtPath, ["log", "--oneline", `${startHead}..HEAD`]);
        uncommitted = classifyRepositoryDirt(execGit(wtPath, ["status", "--porcelain"])).reviewableStatus;
        if (!uncommitted) uncommittedDiff = "";
      } catch {}
      try {
        manifest = readManifest(manifestPath).data;
        manifest = {
          ...manifest,
          git: {
            ...(manifest.git || {}),
            ...(prNumber !== null ? { pr_number: prNumber } : {}),
            head_sha: currentHead || startHead || null,
          },
        };
        writeManifest(manifestPath, manifest);
      } catch {}
    } catch (recoverError) {
      const stderr = recoverError.stderr ? String(recoverError.stderr).trim() : "";
      const message = stderr || String(recoverError.message || recoverError).split("\n")[0];
      status = "failed";
      exitCode = exitCode || 1;
      error = `auto_recover_commit_failed: ${message}`;
      commitMode = "auto-recover failed";
      try {
        manifest = readManifest(manifestPath).data;
        if (manifest.state !== STATES.ESCALATED) {
          manifest = updateManifestState(manifest, STATES.ESCALATED, "inspect_dispatch_failure");
          manifest = {
            ...manifest,
            git: {
              ...(manifest.git || {}),
              head_sha: currentHead || startHead || null,
            },
          };
          writeManifest(manifestPath, manifest);
        }
      } catch {}
    }
  }
  appendRunEvent(repoRoot, runId, {
    event: EVENTS.DISPATCH_RESULT,
    state_from: supervisorResultSuperseded ? manifest.state : STATES.DISPATCHED,
    state_to: manifest.state,
    head_sha: currentHead || startHead || null,
    reason: supervisorResultSuperseded
      ? `supervisor_result_superseded_by_external_progress:${intendedOutcome}`
      : status === "failed"
        ? `${RESUME_MODE ? "same_run_resume" : "new_dispatch"}:${error || "dispatch_failed"}`
        : `${RESUME_MODE ? "same_run_resume" : "new_dispatch"}:${status}`,
    ...(supervisorResultSuperseded
      ? {
          observed_state: manifest.state,
          intended_outcome: intendedOutcome,
        }
      : {}),
    publish_policy: PUBLISH_POLICY,
    executor_network: executorNetworkPolicy,
    executor_policy: executorPolicy,
    failure_class: networkFailure,
    dispatch_failure_class: dispatchFailureClass,
    execution_evidence_path: executionEvidencePath,
    execution_evidence_hash: executionEvidencePath ? hashFileSha256(executionEvidencePath) : null,
  });

  // --- Step 4.5: Optional app registration ---
  let threadId = null;
  if (REGISTER && status !== "failed") {
    try {
      const reg = getLegacyExecutor(EXECUTOR).register({
        wtPath,
        repoPath: repoRoot,
        branch,
        title: `Dispatch: ${branch}`,
      });
      threadId = reg.threadId;
      if (!JSON_OUT) console.log(`\n  Registered in ${EXECUTOR} app.`);
    } catch (e) {
      if (!JSON_OUT) console.log(`\n  Warning: app registration failed: ${e.message.split("\n")[0]}`);
    }
  }

  const rubricAnchor = getRubricAnchorStatus(manifest, { runDir });
  const result = {
    runId,
    runDir,
    manifestPath,
    rubricPath: rubricAnchor.resolvedPath || null,
    requestId: manifest.source?.request_id || null,
    leafId: manifest.source?.leaf_id || null,
    doneCriteriaPath: manifest.anchor?.done_criteria_path || null,
    runState: manifest.state,
    cleanupPolicy,
    status,
    commitMode,
    executor: EXECUTOR,
    executorNetwork: executorNetworkPolicy,
    executorPolicy,
    publishPolicy: PUBLISH_POLICY,
    codexGitCommonDir,
    worktree: wtPath,
    branch,
    mode: RESUME_MODE ? "resume" : "new",
    headSha: currentHead || startHead || null,
    prNumber,
    prCreatedByUs,
    executionEvidencePath,
    resultFile,
    stdoutLog,
    stderrLog,
    elapsed: `${elapsed}s`,
    exitCode,
    error,
    dispatchFailureClass,
    registered: !!threadId,
    threadId,
    commits: gitLog,
    uncommitted: uncommitted || null,
    uncommittedDiff: uncommittedDiff || null,
    diffStat,
    resultPreview: resultText.slice(0, 500),
  };
  if (manifest.fleet_id) {
    result.fleetId = manifest.fleet_id;
  }
  if (manifest.ownership) {
    result.ownership = manifest.ownership;
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n--- Dispatch ${result.status} (${elapsed}s) ---`);
    if (error) console.log(`  Error: ${error}`);
    console.log(`  Run state: ${result.runState}`);
    console.log(`  Commit mode: ${result.commitMode}`);
    if (prNumber !== null) {
      console.log(`  PR:        #${prNumber}${prCreatedByUs === true ? " (created by orchestrator)" : prCreatedByUs === false ? " (existing)" : ""}`);
    }
    if (gitLog) {
      console.log(`  Commits:`);
      gitLog.split("\n").forEach((l) => console.log(`    ${l}`));
    }
    if (diffStat) {
      console.log(`  Changes:`);
      diffStat.split("\n").forEach((l) => console.log(`    ${l}`));
    }
    if (resultText) {
      console.log(`  Result preview:`);
      console.log(`    ${resultText.slice(0, 300).replace(/\n/g, "\n    ")}`);
    }
    console.log(`  Manifest: ${manifestPath}`);
    console.log(`\n  Full result: cat ${resultFile}`);
    console.log(`  Stdout log:  cat ${stdoutLog}`);
    console.log(`  Stderr log:  cat ${stderrLog}`);
    if (uncommittedDiff) {
      console.log(`  Uncommitted changes:`);
      uncommittedDiff.split("\n").forEach((l) => console.log(`    ${l}`));
    }
    console.log(`\n  Review:      git -C ${shellQuote(wtPath)} log --oneline ${startHead ? startHead + "..HEAD" : ""}`);
    console.log(`  Diff:        git -C ${shellQuote(wtPath)} diff ${startHead ? startHead + "..HEAD" : "HEAD~1"}`);
    console.log(`  Merge:       git merge ${branch}`);
    console.log(`  Cleanup:     deferred (${cleanupPolicy})`);
  }

  if (status === "failed") process.exit(exitCode || 1);
}

if (DETACH) {
  launchDetachedAndExit().catch((e) => {
    if (JSON_OUT) {
      console.log(JSON.stringify({
        status: "failed",
        error: e.message,
      }, null, 2));
    }
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}
