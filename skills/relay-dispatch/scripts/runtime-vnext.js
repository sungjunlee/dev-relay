const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isDeepStrictEqual } = require("util");

const host = require("./host");
const facts = require("./facts");
const runStore = require("./run-store");
const {
  compareShadow,
  foldRunFacts,
  projectLegacyRun,
} = require("./run-fold");

const issuedMergeAuthorizations = new WeakSet();
const issuedFreshObservations = new WeakSet();
const REVIEW_ENV_ALLOWLIST = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
]);

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalDirectory(directory, label) {
  const resolved = fs.realpathSync(directory);
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  return resolved;
}

function assertTrustedWorktree({
  repoRoot,
  activeCheckout,
  relayWorktreeBase,
  worktree,
}) {
  const canonicalRepo = canonicalDirectory(repoRoot, "repoRoot");
  const canonicalActive = canonicalDirectory(activeCheckout, "activeCheckout");
  const canonicalBase = canonicalDirectory(relayWorktreeBase, "relayWorktreeBase");
  const canonicalWorktree = canonicalDirectory(worktree, "worktree");
  if (
    canonicalWorktree === canonicalRepo
    || canonicalWorktree === canonicalActive
    || contained(canonicalActive, canonicalWorktree)
    || contained(canonicalWorktree, canonicalActive)
    || !contained(canonicalBase, canonicalWorktree)
  ) {
    throw new Error("worktree is outside the trusted relay worktree boundary");
  }
  return true;
}

function contractLockOptions(runDir, operation) {
  const canonicalRunDir = fs.realpathSync(runDir);
  return {
    runDir: canonicalRunDir,
    attemptId: `contract-${crypto.randomUUID()}`,
    operation,
    hostKind: "local_supervisor",
    hostHandle: `contract:${process.pid}`,
    worktreeDir: canonicalRunDir,
  };
}

async function withRunLock(runDirOrOptions, callback) {
  const options = typeof runDirOrOptions === "string"
    ? contractLockOptions(runDirOrOptions, "contract")
    : runDirOrOptions;
  return host.withRunLock(options, callback);
}

async function appendFact({ eventsPath, fact }) {
  const runDir = fs.realpathSync(path.dirname(path.resolve(eventsPath)));
  const canonicalEventsPath = path.join(runDir, "events.jsonl");
  if (eventsPath !== canonicalEventsPath) {
    throw new Error("eventsPath must be the canonical run-local events.jsonl");
  }
  return withRunLock(contractLockOptions(runDir, "append_fact"), (lockContext) => (
    facts.appendFact({ eventsPath: canonicalEventsPath, fact, lockContext })
  ));
}

async function repairTornTail({ eventsPath, at }) {
  const runDir = fs.realpathSync(path.dirname(path.resolve(eventsPath)));
  const canonicalEventsPath = path.join(runDir, "events.jsonl");
  if (eventsPath !== canonicalEventsPath) {
    throw new Error("eventsPath must be the canonical run-local events.jsonl");
  }
  return withRunLock(contractLockOptions(runDir, "repair_torn_tail"), (lockContext) => (
    facts.repairTornTail({ eventsPath: canonicalEventsPath, at, lockContext })
  ));
}

function validateReviewBinding({ verdict, currentSha, doneCriteriaSha256 }) {
  const valid = Boolean(
    verdict
    && verdict.reviewed_sha === currentSha
    && verdict.done_criteria_sha256 === doneCriteriaSha256,
  );
  return {
    valid,
    reason: valid ? null : "review_binding_mismatch",
  };
}

function hashRegularFile(filePath, label) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error(`${label} changed identity while being read`);
    }
    return {
      bytes,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function atomicJson(pathname, value, { fault = null } = {}) {
  const directory = path.dirname(pathname);
  const temporary = path.join(
    directory,
    `.${path.basename(pathname)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fault?.("open", pathname);
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    const written = fs.writeSync(fd, bytes, 0, bytes.length);
    if (written !== bytes.length) throw new Error(`short write for ${path.basename(pathname)}`);
    fault?.("write", pathname);
    fs.fsyncSync(fd);
    fault?.("fsync", pathname);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, pathname);
    fault?.("rename", pathname);
    runStore.fsyncDirectory(directory);
    fault?.("dir_fsync", pathname);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function writeImmutableJson(pathname, value) {
  writeImmutableBytes(pathname, Buffer.from(`${JSON.stringify(value)}\n`));
}

function writeImmutableBytes(pathname, bytes) {
  try {
    const fd = fs.openSync(pathname, "wx", 0o600);
    try {
      const written = fs.writeSync(fd, bytes, 0, bytes.length);
      if (written !== bytes.length) throw new Error("short immutable request write");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    runStore.fsyncDirectory(path.dirname(pathname));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = fs.readFileSync(pathname);
    if (!existing.equals(bytes)) throw new Error("immutable request artifact conflict");
    runStore.fsyncDirectory(path.dirname(pathname));
  }
}

function loadOrCreateMergeAuthKey(runDir, lockContext) {
  host.assertRunLockHeld(lockContext, { runDir });
  const keyPath = path.join(runDir, ".merge-authorization.key");
  let fd;
  try {
    fd = fs.openSync(
      keyPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fd = fs.openSync(
      keyPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const generated = crypto.randomBytes(32);
    fs.writeSync(fd, generated, 0, generated.length);
    fs.fsyncSync(fd);
    runStore.fsyncDirectory(runDir);
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || (before.mode & 0o077) !== 0) {
      throw new Error("merge authorization key permissions are unsafe");
    }
    const key = Buffer.alloc(before.size);
    const bytesRead = fs.readSync(fd, key, 0, key.length, 0);
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || bytesRead !== key.length
      || key.length !== 32
    ) {
      throw new Error("merge authorization key identity is invalid");
    }
    return key;
  } finally {
    fs.closeSync(fd);
  }
}

function mergeAuthorizationMac(fields, key) {
  return crypto.createHmac("sha256", key).update(JSON.stringify(fields)).digest("hex");
}

function durableAuthorizationFields(value) {
  return {
    schema_version: value.schema_version,
    run_id: value.run_id,
    operation_id: value.operation_id,
    authorization_id: value.authorization_id,
    observation_nonce: value.observation_nonce,
    issued_lock_id: value.issued_lock_id,
    pr_number: value.pr_number,
    pr_head_sha: value.pr_head_sha,
    done_criteria_sha256: value.done_criteria_sha256,
    operator: value.operator,
    method: value.method,
  };
}

function assertDurableAuthorizationSchema(value) {
  const expectedKeys = [
    "authorization_id",
    "done_criteria_sha256",
    "hmac_sha256",
    "issued_lock_id",
    "method",
    "observation_nonce",
    "operation_id",
    "operator",
    "pr_head_sha",
    "pr_number",
    "run_id",
    "schema_version",
  ];
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
    || value.schema_version !== 1
    || typeof value.run_id !== "string"
    || typeof value.operation_id !== "string"
    || typeof value.authorization_id !== "string"
    || typeof value.observation_nonce !== "string"
    || typeof value.issued_lock_id !== "string"
    || !Number.isInteger(value.pr_number)
    || value.pr_number < 1
    || !/^[0-9a-f]{40}$/.test(value.pr_head_sha)
    || !/^[0-9a-f]{64}$/.test(value.done_criteria_sha256)
    || typeof value.operator !== "string"
    || value.operator.length === 0
    || typeof value.method !== "string"
    || value.method.length === 0
    || !/^[0-9a-f]{64}$/.test(value.hmac_sha256)
  ) {
    throw new Error("durable merge authorization schema is not closed");
  }
}

function readVerifiedDurableAuthorization(runDir, operationId, lockContext) {
  const source = hashRegularFile(
    path.join(runDir, `merge-authorization-${operationId}.json`),
    "durable merge authorization",
  );
  const durable = JSON.parse(source.bytes.toString("utf8"));
  assertDurableAuthorizationSchema(durable);
  const fields = durableAuthorizationFields(durable);
  const key = loadOrCreateMergeAuthKey(runDir, lockContext);
  const expected = mergeAuthorizationMac(fields, key);
  if (
    typeof durable.hmac_sha256 !== "string"
    || durable.hmac_sha256.length !== expected.length
    || !crypto.timingSafeEqual(Buffer.from(durable.hmac_sha256), Buffer.from(expected))
  ) {
    throw new Error("durable merge authorization HMAC is invalid");
  }
  return durable;
}

function sandboxQuote(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

let sandboxExecUsable;

function canApplyDarwinSandbox() {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) return false;
  if (sandboxExecUsable !== undefined) return sandboxExecUsable;
  const probeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-sandbox-probe-")));
  try {
    const profile = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      `(allow file-read* (subpath "${sandboxQuote(probeDir)}") (subpath "/System") (subpath "/usr") (subpath "/Library") (subpath "/Applications") (subpath "/opt") (subpath "/usr/local") (subpath "/dev"))`,
      `(allow file-write* (subpath "${sandboxQuote(probeDir)}") (subpath "/dev"))`,
    ].join("");
    execFileSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, process.execPath, "-e", "process.stdout.write('ok')"],
      { cwd: probeDir, env: { PATH: process.env.PATH || "" }, stdio: "ignore" },
    );
    sandboxExecUsable = true;
  } catch {
    // A permissive /usr/bin/true probe can succeed even when a hosted sandbox
    // aborts the real Node child. Probe the actual executable and profile.
    sandboxExecUsable = false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
  return sandboxExecUsable;
}

function supportsNodePermissionModel() {
  const flags = process.allowedNodeEnvironmentFlags;
  return Boolean(
    flags
    && typeof flags.has === "function"
    && flags.has("--permission")
    && flags.has("--allow-fs-read")
    && flags.has("--allow-fs-write"),
  );
}

function selectFilesystemIsolation({
  darwinSandboxAvailable,
  nodePermissionModelAvailable,
  isNodeCommand,
}) {
  if (darwinSandboxAvailable) return "darwin_sandbox";
  if (isNodeCommand && nodePermissionModelAvailable) return "node_permission";
  throw new Error(
    "filesystem isolation unavailable: neither sandbox-exec nor the Node permission model is supported",
  );
}

function normalizeInvocationArgs(args, stagingDirectory) {
  if (!Array.isArray(args)) throw new Error("independent process args must be an array");
  return args.map((entry, index) => {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || !new Set(["literal", "staged_file"]).has(entry.kind)
      || typeof entry.value !== "string"
    ) {
      throw new Error(`independent process args[${index}] must match {kind:"literal",value:string}`);
    }
    if (entry.value === "--request-file") {
      throw new Error("--request-file is reserved for the immutable request artifact");
    }
    if (entry.kind === "staged_file") {
      const source = hashRegularFile(entry.value, `independent process staged arg ${index}`);
      const extension = path.extname(entry.value).replace(/[^.A-Za-z0-9]/g, "");
      const stagedPath = path.join(
        stagingDirectory,
        `arg-${index}-${source.sha256}${extension}`,
      );
      writeImmutableBytes(stagedPath, source.bytes);
      return stagedPath;
    }
    return entry.value;
  });
}

function isolatedReviewerEnvironment(source = process.env, overrides = {}) {
  const result = {};
  for (const key of REVIEW_ENV_ALLOWLIST) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!REVIEW_ENV_ALLOWLIST.has(key) || typeof value !== "string") {
      throw new Error(`reviewer environment key is not allowed: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

function invokeJsonProcess({
  command,
  args = [],
  requestPath,
  timeoutMs = 120_000,
  env,
  stagingDirectory = null,
}) {
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("an independent reviewer command is required");
  }
  const isolatedCwd = stagingDirectory
    ? fs.realpathSync(stagingDirectory)
    : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-reviewer-")));
  const normalizedArgs = normalizeInvocationArgs(args, isolatedCwd);
  try {
    const request = hashRegularFile(requestPath, "independent process request");
    const stagedRequestPath = path.join(isolatedCwd, `request-${request.sha256}.json`);
    if (path.resolve(requestPath) !== stagedRequestPath) {
      writeImmutableBytes(stagedRequestPath, request.bytes);
    }
    const childEnv = isolatedReviewerEnvironment(process.env, env);
    childEnv.HOME = isolatedCwd;
    childEnv.TMPDIR = isolatedCwd;
    let executable = command;
    let argv = [...normalizedArgs, "--request-file", stagedRequestPath];
    const isNodeCommand = fs.realpathSync(command) === fs.realpathSync(process.execPath);
    const isolation = selectFilesystemIsolation({
      darwinSandboxAvailable: canApplyDarwinSandbox(),
      nodePermissionModelAvailable: supportsNodePermissionModel(),
      isNodeCommand,
    });
    if (isolation === "darwin_sandbox") {
      const profile = [
        "(version 1)",
        "(deny default)",
        "(allow process*)",
        "(allow sysctl-read)",
        "(allow network*)",
        `(allow file-read* (subpath "${sandboxQuote(isolatedCwd)}") (subpath "/System") (subpath "/usr") (subpath "/Library") (subpath "/Applications") (subpath "/opt") (subpath "/usr/local") (subpath "/dev"))`,
        `(allow file-write* (subpath "${sandboxQuote(isolatedCwd)}") (subpath "/dev"))`,
      ].join("");
      executable = "/usr/bin/sandbox-exec";
      argv = ["-p", profile, command, ...argv];
    } else if (isolation === "node_permission") {
      argv = [
        "--permission",
        `--allow-fs-read=${isolatedCwd}`,
        `--allow-fs-write=${isolatedCwd}`,
        ...argv,
      ];
    }
    const stdout = execFileSync(
      executable,
      argv,
      {
        cwd: isolatedCwd,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return JSON.parse(stdout);
  } finally {
    fs.rmSync(isolatedCwd, { recursive: true, force: true });
  }
}

function invokeIndependentReviewer({
  runDir,
  request,
  command,
  args = [],
  timeoutMs,
  env,
}) {
  const canonicalRunDir = fs.realpathSync(runDir);
  const record = runStore.readRunRecord({ runDir: canonicalRunDir });
  const diff = hashRegularFile(request.diff_path, "review diff");
  const prompt = hashRegularFile(request.prompt_path, "review prompt");
  if (
    fs.realpathSync(request.done_criteria_path) !== record.contract.done_criteria_path
    || request.reviewed_sha !== request.current_sha
  ) {
    throw new Error("review request is not bound to the immutable run and current SHA");
  }
  const stagingDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-stage-")),
  );
  const immutableDiffPath = path.join(stagingDirectory, `review-diff-${diff.sha256}.patch`);
  const immutablePromptPath = path.join(stagingDirectory, `review-prompt-${prompt.sha256}.md`);
  const immutableCriteriaPath = path.join(
    stagingDirectory,
    `done-criteria-${record.contract.done_criteria_sha256}.md`,
  );
  writeImmutableBytes(immutableDiffPath, diff.bytes);
  writeImmutableBytes(immutablePromptPath, prompt.bytes);
  writeImmutableBytes(
    immutableCriteriaPath,
    hashRegularFile(record.contract.done_criteria_path, "frozen Done Criteria").bytes,
  );
  const reviewerInput = Object.freeze({
    schema_version: 1,
    run_id: record.run_id,
    reviewed_sha: request.reviewed_sha,
    done_criteria_path: immutableCriteriaPath,
    done_criteria_sha256: record.contract.done_criteria_sha256,
    diff_path: immutableDiffPath,
    diff_sha256: diff.sha256,
    prompt_path: immutablePromptPath,
    prompt_sha256: prompt.sha256,
  });
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify(reviewerInput))
    .digest("hex");
  const requestPath = path.join(stagingDirectory, `review-request-${digest}.json`);
  writeImmutableJson(requestPath, reviewerInput);
  return invokeJsonProcess({
    command,
    args,
    requestPath,
    timeoutMs,
    env,
    stagingDirectory,
  });
}

function planOperatorMerge({
  runDir,
  lockContext,
  freshObservation,
  operatorAction,
  currentHead,
  currentDoneCriteriaSha256,
  verdict,
  prNumber,
}) {
  const canonicalRunDir = fs.realpathSync(runDir);
  host.assertRunLockHeld(lockContext, { runDir: canonicalRunDir });
  if (
    !issuedFreshObservations.has(freshObservation)
    || freshObservation.lockContext !== lockContext
    || freshObservation.runDir !== canonicalRunDir
  ) {
    throw new Error("an issued fresh observation under the current run lock is required");
  }
  if (!operatorAction?.actor || !operatorAction?.method) {
    throw new Error("an explicit operator merge action is required");
  }
  if (!new Set(["squash", "merge", "rebase"]).has(operatorAction.method)) {
    throw new Error("merge method must be squash, merge, or rebase");
  }
  const binding = validateReviewBinding({
    verdict,
    currentSha: currentHead,
    doneCriteriaSha256: currentDoneCriteriaSha256,
  });
  if (!binding.valid || !new Set(["lgtm", "pass"]).has(verdict?.verdict)) {
    throw new Error("merge review binding is not current");
  }
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error("an observed PR number is required");
  }
  if (
    freshObservation.facts.pr_number !== prNumber
    || freshObservation.facts.pr_head_sha !== currentHead
  ) {
    throw new Error("merge inputs do not match the fresh locked observation");
  }
  const operationId = crypto.randomUUID();
  const authorization = Object.freeze({
    kind: "relay-vnext-merge-authorization",
    authorized: true,
    actor: operatorAction.actor,
    method: operatorAction.method,
    headSha: currentHead,
    doneCriteriaSha256: currentDoneCriteriaSha256,
    prNumber,
    operationId,
    observationNonce: freshObservation.nonce,
    runDir: canonicalRunDir,
    lockContext,
    authorizationId: crypto.randomUUID(),
  });
  const durableFields = {
    schema_version: 1,
    run_id: runStore.readRunRecord({ runDir: canonicalRunDir }).run_id,
    operation_id: operationId,
    authorization_id: authorization.authorizationId,
    observation_nonce: freshObservation.nonce,
    issued_lock_id: lockContext.lock_id,
    pr_number: prNumber,
    pr_head_sha: currentHead,
    done_criteria_sha256: currentDoneCriteriaSha256,
    operator: operatorAction.actor,
    method: operatorAction.method,
  };
  const key = loadOrCreateMergeAuthKey(canonicalRunDir, lockContext);
  writeImmutableJson(
    path.join(canonicalRunDir, `merge-authorization-${operationId}.json`),
    {
      ...durableFields,
      hmac_sha256: mergeAuthorizationMac(durableFields, key),
    },
  );
  issuedMergeAuthorizations.add(authorization);
  return authorization;
}

function resumeOperatorMerge({
  runDir,
  lockContext,
  operationId,
  freshObservation,
}) {
  const canonicalRunDir = fs.realpathSync(runDir);
  host.assertRunLockHeld(lockContext, { runDir: canonicalRunDir });
  if (
    !issuedFreshObservations.has(freshObservation)
    || freshObservation.lockContext !== lockContext
    || freshObservation.runDir !== canonicalRunDir
  ) {
    throw new Error("an issued fresh observation under the resumed run lock is required");
  }
  const durable = readVerifiedDurableAuthorization(
    canonicalRunDir,
    operationId,
    lockContext,
  );
  const record = runStore.readRunRecord({ runDir: canonicalRunDir });
  if (
    durable.operation_id !== operationId
    || durable.run_id !== record.run_id
    || durable.done_criteria_sha256 !== record.contract.done_criteria_sha256
    || durable.pr_number !== freshObservation.facts.pr_number
    || durable.pr_head_sha !== freshObservation.facts.pr_head_sha
  ) {
    throw new Error("durable merge authorization does not match fresh locked observations");
  }
  const authorization = Object.freeze({
    kind: "relay-vnext-merge-authorization",
    authorized: true,
    actor: durable.operator,
    method: durable.method,
    headSha: durable.pr_head_sha,
    doneCriteriaSha256: durable.done_criteria_sha256,
    prNumber: durable.pr_number,
    operationId: durable.operation_id,
    observationNonce: freshObservation.nonce,
    runDir: canonicalRunDir,
    lockContext,
    authorizationId: durable.authorization_id,
  });
  issuedMergeAuthorizations.add(authorization);
  return authorization;
}

async function recordMerge({
  eventsPath,
  at = new Date().toISOString(),
  provenance,
  authorization,
  lockContext,
  observer,
  fault = null,
}) {
  if (!issuedMergeAuthorizations.has(authorization)) {
    throw new Error("an issued explicit merge authorization capability is required");
  }
  if (
    authorization.actor !== provenance.operator
    || authorization.method !== provenance.method
    || authorization.prNumber !== provenance.pr_number
    || authorization.headSha !== provenance.reviewed_source_sha
    || authorization.headSha !== provenance.pr_head_sha
  ) {
    throw new Error("merge provenance does not match its explicit authorization");
  }
  if (authorization.lockContext !== lockContext) {
    throw new Error("merge authorization belongs to a different run-lock capability");
  }
  const runRecord = runStore.readRunRecord({
    runDir: path.dirname(path.resolve(eventsPath)),
  });
  host.assertRunLockHeld(lockContext, { runDir: authorization.runDir });
  const durable = readVerifiedDurableAuthorization(
    authorization.runDir,
    authorization.operationId,
    lockContext,
  );
  if (
    durable.authorization_id !== authorization.authorizationId
    || durable.operator !== authorization.actor
    || durable.run_id !== runRecord.run_id
  ) {
    throw new Error("issued merge capability does not match its durable authorization");
  }
  if (authorization.doneCriteriaSha256 !== runRecord.contract.done_criteria_sha256) {
    throw new Error("merge authorization is not bound to the run's frozen Done Criteria");
  }
  const revalidated = await revalidateExternalFacts({
    runDir: authorization.runDir,
    lockContext,
    observer,
    request: {
      operation_id: authorization.operationId,
      pr_number: authorization.prNumber,
      expected_pr_head_sha: authorization.headSha,
      expected_result_target_sha: provenance.result_target_sha,
      required_state: "MERGED",
    },
    authorize: (observed) => {
      if (
        observed.pr_number !== authorization.prNumber
        || observed.pr_head_sha !== authorization.headSha
        || observed.pr_state !== "MERGED"
        || observed.merge_sha !== provenance.result_target_sha
      ) {
        throw new Error("record-time observer did not prove the exact merged PR and target SHA");
      }
      return { authorized: true };
    },
  });
  const payload = {
    ...provenance,
    operation_id: authorization.operationId,
    authorization_id: authorization.authorizationId,
    observation_nonce: revalidated.observationCapability.nonce,
    done_criteria_sha256: authorization.doneCriteriaSha256,
  };
  const existing = facts.readFacts({ eventsPath }).facts
    .filter((entry) => entry.type === "merge_recorded");
  const converged = existing.find(
    (entry) => entry.payload.operation_id === authorization.operationId,
  );
  if (converged) {
    const stableExisting = { ...converged.payload, observation_nonce: null };
    const stableRequested = { ...payload, observation_nonce: null };
    if (!isDeepStrictEqual(stableExisting, stableRequested)) {
      throw new Error("merge operation already exists with conflicting provenance");
    }
    writeImmutableJson(
      path.join(authorization.runDir, `merge-receipt-${authorization.operationId}.json`),
      {
        schema_version: 1,
        operation_id: authorization.operationId,
        authorization_id: authorization.authorizationId,
        event_id: converged.event_id,
        payload: converged.payload,
      },
    );
    return converged;
  }
  if (existing.length) throw new Error("a different merge operation is already recorded");
  const fact = {
    event_id: crypto.randomUUID(),
    run_id: runRecord.run_id,
    type: "merge_recorded",
    at,
    actor: provenance.operator,
    payload,
  };
  facts.appendFact({ eventsPath, fact, lockContext });
  fault?.("after_fact_append");
  atomicJson(
    path.join(authorization.runDir, `merge-receipt-${authorization.operationId}.json`),
    {
      schema_version: 1,
      operation_id: authorization.operationId,
      authorization_id: authorization.authorizationId,
      event_id: fact.event_id,
      payload,
    },
    { fault },
  );
  return fact;
}

function recoveryReceiptPath(runDir, recoveryKey) {
  const digest = crypto.createHash("sha256").update(recoveryKey).digest("hex");
  return path.join(runDir, `recovery-${digest}.json`);
}

async function recoverRun({ runDir, recoveryKey, observe, apply, fault = null }) {
  if (typeof recoveryKey !== "string" || !recoveryKey) {
    throw new Error("recoveryKey is required");
  }
  const canonicalRunDir = fs.realpathSync(runDir);
  return withRunLock(contractLockOptions(canonicalRunDir, "recover"), async () => {
    const receiptPath = recoveryReceiptPath(canonicalRunDir, recoveryKey);
    const intentPath = receiptPath.replace(/\.json$/, ".intent.json");
    try {
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      fault?.("read", receiptPath);
      return receipt;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let intent;
    try {
      intent = JSON.parse(fs.readFileSync(intentPath, "utf8"));
      fault?.("read", intentPath);
      if (intent.recoveryKey !== recoveryKey || typeof intent.operationId !== "string") {
        throw new Error("recovery intent conflicts with the requested operation");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      intent = {
        schema_version: 1,
        recoveryKey,
        operationId: crypto.randomUUID(),
        created_at: new Date().toISOString(),
      };
      atomicJson(intentPath, intent, { fault });
    }
    if (typeof observe !== "function" || typeof apply !== "function") {
      throw new Error("recovery requires fresh observe and convergent apply functions");
    }
    const first = await observe({
      operationId: intent.operationId,
      phase: "before_apply",
    });
    if (!first || typeof first.converged !== "boolean") {
      throw new Error("recovery observation must report converged boolean");
    }
    let result = null;
    let applied = false;
    if (!first.converged) {
      result = await apply(first, {
        operationId: intent.operationId,
        recoveryKey,
      });
      applied = true;
    }
    const final = await observe({
      operationId: intent.operationId,
      phase: "after_apply",
    });
    if (!final || final.converged !== true) {
      throw new Error("recovery did not converge after fresh external re-observation");
    }
    const receipt = {
      schema_version: 1,
      recoveryKey,
      operationId: intent.operationId,
      applied,
      initial_observation: first,
      final_observation: final,
      result,
    };
    atomicJson(receiptPath, receipt, { fault });
    return receipt;
  });
}

function foldRun({ runRecord, facts: runFacts, gitFacts, githubFacts, hostFacts }) {
  return foldRunFacts({
    runRecord,
    facts: runFacts,
    gitFacts,
    githubFacts,
    hostFacts,
  });
}

async function revalidateExternalFacts({
  runDir,
  lockContext,
  observer,
  request,
  authorize,
}) {
  const canonicalRunDir = fs.realpathSync(runDir);
  host.assertRunLockHeld(lockContext, { runDir: canonicalRunDir });
  if (!observer || typeof observer.command !== "string") {
    throw new Error("a fresh external observer argv process is required");
  }
  const input = Object.freeze({
    schema_version: 1,
    run_id: runStore.readRunRecord({ runDir: canonicalRunDir }).run_id,
    nonce: crypto.randomUUID(),
    request,
  });
  const requestPath = path.join(
    canonicalRunDir,
    `external-observation-request-${input.nonce}.json`,
  );
  writeImmutableJson(requestPath, input);
  const observed = invokeJsonProcess({
    command: observer.command,
    args: observer.args || [],
    requestPath,
    timeoutMs: observer.timeoutMs,
    env: observer.env,
  });
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) {
    throw new Error("fresh external observer must return structured JSON facts");
  }
  if (observed.nonce !== input.nonce) {
    throw new Error("fresh external observer nonce does not match its immutable request");
  }
  const observationCapability = Object.freeze({
    kind: "relay-vnext-fresh-observation",
    nonce: input.nonce,
    facts: Object.freeze({ ...observed }),
    runDir: canonicalRunDir,
    lockContext,
  });
  issuedFreshObservations.add(observationCapability);
  const decision = await authorize(observed, { lockContext, request: input });
  return { decision, facts: observed, observationCapability };
}

function evaluateLegacyShadow({
  manifestPath,
  eventsPath,
  expectedManifest = null,
  expectedEvents = null,
  observations,
  legacyDecision,
  telemetryPath,
  at,
  telemetryIo = null,
}) {
  if (!telemetryPath) throw new Error("production shadow telemetryPath is required");
  const manifestSource = hashRegularFile(manifestPath, "legacy manifest source");
  const { parseFrontmatter } = require("./manifest/store");
  const manifest = parseFrontmatter(manifestSource.bytes.toString("utf8")).data;
  if (
    expectedManifest
    && !isDeepStrictEqual(expectedManifest, manifest)
  ) {
    throw new Error("caller-supplied manifest does not match source bytes");
  }
  let events = [];
  let eventBytes = Buffer.alloc(0);
  let eventsPresent = false;
  if (eventsPath) {
    try {
      const source = hashRegularFile(eventsPath, "legacy events source");
      eventBytes = source.bytes;
      eventsPresent = true;
      events = eventBytes.toString("utf8").split("\n").filter(Boolean).map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`legacy events source line ${index + 1} is invalid: ${error.message}`);
        }
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (expectedEvents && !isDeepStrictEqual(expectedEvents, events)) {
    throw new Error("caller-supplied events do not match source bytes");
  }
  if (legacyDecision && legacyDecision.state !== manifest.state) {
    throw new Error("caller-supplied legacy decision does not match manifest source state");
  }
  const derivedDecision = { ...(legacyDecision || {}), state: manifest.state };
  const provenance = {
    kind: "production-source-bytes",
    manifest_path: fs.realpathSync(manifestPath),
    manifest_sha256: manifestSource.sha256,
    events_path: eventsPath ? path.resolve(eventsPath) : null,
    events_present: eventsPresent,
    events_sha256: crypto.createHash("sha256").update(eventBytes).digest("hex"),
  };
  const projection = projectLegacyRun({ manifest, events, observations });
  return compareShadow({
    legacyDecision: derivedDecision,
    ...projection,
    gitFacts: observations.gitFacts,
    githubFacts: observations.githubFacts,
    hostFacts: observations.hostFacts,
    telemetryPath,
    provenance,
    at,
    telemetryIo,
  });
}

module.exports = {
  appendFact,
  assertTrustedWorktree,
  createRunRecord: runStore.createRunRecord,
  evaluateLegacyShadow,
  foldRun,
  freezeDoneCriteria: runStore.freezeDoneCriteria,
  hashDoneCriteria: runStore.hashDoneCriteria,
  invokeIndependentReviewer,
  planOperatorMerge,
  readFacts: facts.readFacts,
  recordMerge,
  recoverRun,
  repairTornTail,
  resumeOperatorMerge,
  revalidateExternalFacts,
  selectFilesystemIsolation,
  validateReviewBinding,
  withRunLock,
};
