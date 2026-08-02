const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { credentialRequest: normalizeCredentialRequest } = require("./adapter-contract");
const host = require("./host");

const RUN_VERSION = 3;
const SHA1_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{0,126}$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function canonicalRepository(input) {
  if (typeof input !== "string" || !input.trim()) fail("INVALID_REPOSITORY_IDENTITY", "repository path is required");
  const checkout = fs.realpathSync(path.resolve(input));
  const result = spawnSync("git", ["-C", checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) fail("INVALID_REPOSITORY_IDENTITY", String(result.stderr || "not a Git repository").trim());
  return fs.realpathSync(path.dirname(fs.realpathSync(path.resolve(checkout, result.stdout.trim()))));
}

function relayHome() {
  const value = process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  if (!path.isAbsolute(value)) fail("INVALID_RELAY_PATH", "RELAY_HOME must be absolute");
  return path.resolve(value);
}

function relayWorktreeBase() {
  const value = process.env.RELAY_WORKTREE_BASE || path.join(relayHome(), "worktrees");
  if (!path.isAbsolute(value)) fail("INVALID_RELAY_PATH", "RELAY_WORKTREE_BASE must be absolute");
  return path.resolve(value);
}

function resolveRunDirectory(repository, runId) {
  const root = canonicalRepository(repository);
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) fail("INVALID_RUN_ID", "runId must be one safe path segment");
  const base = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const slug = `${base}-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
  const runs = process.env.RELAY_RUNS_BASE || path.join(relayHome(), "runs");
  if (!path.isAbsolute(runs)) fail("INVALID_RELAY_PATH", "RELAY_RUNS_BASE must be absolute");
  return path.join(path.resolve(runs), slug, runId);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, required, optional, label) {
  if (!isPlainObject(value)) fail("INVALID_RUN_RECORD", `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("INVALID_RUN_RECORD", `${label}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("INVALID_RUN_RECORD", `${label}.${key} is required`);
    }
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail("INVALID_RUN_RECORD", `${label} must be a non-empty string`);
  }
}

function assertSha(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("INVALID_RUN_RECORD", `${label} has an invalid digest`);
  }
}

// One schema table drives the whole immutable record: exact key sets plus a per-field rule.
// "abs" adds absolute-path containment, "sha1"/"sha256" bind digests; every other field is a
// non-empty string. Sections and field order are the record's canonical shape.
const RUN_SCHEMA = [
  ["repo", { root: "abs", remote: "string" }],
  ["git", { branch: "string", base_branch: "string", worktree: "abs", start_sha: "sha1" }],
  ["contract", { done_criteria_path: "abs", done_criteria_sha256: "sha256" }],
  ["roles", { orchestrator: "string", executor: "string", reviewer: "string" }],
];

function validateRunRecord(record) {
  assertExactKeys(
    record,
    ["version", "run_id", "repo", "git", "contract", "roles", "parent", "ownership_digest", "created_at"],
    [],
    "run",
  );
  if (record.version !== RUN_VERSION) {
    fail("UNSUPPORTED_RUN_VERSION", `run.version must be ${RUN_VERSION}`);
  }
  assertString(record.run_id, "run.run_id");

  for (const [section, fields] of RUN_SCHEMA) {
    assertExactKeys(record[section], Object.keys(fields), [], `run.${section}`);
    for (const [field, rule] of Object.entries(fields)) {
      const label = `run.${section}.${field}`, value = record[section][field];
      if (rule === "sha1" || rule === "sha256") {
        assertSha(value, rule === "sha1" ? SHA1_RE : SHA256_RE, label);
        continue;
      }
      assertString(value, label);
      if (rule === "abs" && !path.isAbsolute(value)) fail("INVALID_RUN_RECORD", `${label} must be absolute`);
    }
  }

  if (record.parent !== null) {
    assertExactKeys(record.parent, ["kind", "id"], [], "run.parent");
    if (record.parent.kind !== "fleet") {
      fail("INVALID_RUN_RECORD", "run.parent.kind must be fleet");
    }
    assertString(record.parent.id, "run.parent.id");
  }
  if (record.ownership_digest !== null) {
    assertString(record.ownership_digest, "run.ownership_digest");
  }
  if (typeof record.created_at !== "string" || Number.isNaN(Date.parse(record.created_at))) {
    fail("INVALID_RUN_RECORD", "run.created_at must be an ISO-8601 timestamp");
  }
  return record;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fsyncDirectory(directory, fsModule = fs) {
  let fd;
  try {
    fd = fsModule.openSync(directory, fs.constants.O_RDONLY);
    fsModule.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fsModule.closeSync(fd);
  }
}

function canonicalRunDirectory(runDir, { create = false } = {}) {
  if (typeof runDir !== "string" || !path.isAbsolute(runDir)) {
    fail("INVALID_RUN_RECORD", "runDir must be an absolute path");
  }
  if (create) fs.mkdirSync(runDir, { recursive: true });
  const canonical = fs.realpathSync(runDir);
  if (!fs.statSync(canonical).isDirectory()) {
    fail("INVALID_RUN_RECORD", "runDir must be a directory");
  }
  return canonical;
}

function assertRunDirectoryIdentity(runDir, runId) {
  const canonical = canonicalRunDirectory(runDir);
  if (path.basename(canonical) !== runId) {
    fail(
      "RUN_ID_PATH_MISMATCH",
      `run_id ${runId} must equal its canonical run directory basename`,
    );
  }
  return canonical;
}

function readRegularFile(filePath, label) {
  let fd;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY
        | (fs.constants.O_NOFOLLOW || 0)
        | (fs.constants.O_NONBLOCK || 0),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") {
      fail("UNTRUSTED_RUN_ARTIFACT", `${label} must be a stable regular non-symlink file`);
    }
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) {
      fail("UNTRUSTED_RUN_ARTIFACT", `${label} must be a stable regular non-symlink file`);
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      fail("UNTRUSTED_RUN_ARTIFACT", `${label} changed identity while being read`);
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function writeExclusiveAtomic(finalPath, bytes, conflictCode) {
  const directory = path.dirname(finalPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(finalPath)}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`,
  );
  let fd;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(temporary, finalPath);
      fsyncDirectory(directory);
      return { created: true };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = readRegularFile(finalPath, path.basename(finalPath));
      if (!existing || !existing.equals(Buffer.from(bytes))) {
        fail(conflictCode, `${path.basename(finalPath)} already exists with different bytes`);
      }
      return { created: false };
    }
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function createRunRecord({ runDir, record }) {
  validateRunRecord(record);
  const canonicalRunDir = assertRunDirectoryIdentity(runDir, record.run_id);
  const expectedCriteriaPath = path.join(canonicalRunDir, "done-criteria.md");
  if (
    record.contract.done_criteria_path !== expectedCriteriaPath
    || fs.realpathSync(record.contract.done_criteria_path) !== expectedCriteriaPath
  ) {
    fail(
      "INVALID_RUN_RECORD",
      "run.contract.done_criteria_path must identify the frozen run-local done-criteria.md",
    );
  }
  const actualCriteriaHash = hashDoneCriteria(record.contract.done_criteria_path);
  if (actualCriteriaHash !== record.contract.done_criteria_sha256) {
    fail("DONE_CRITERIA_HASH_MISMATCH", "frozen Done Criteria bytes do not match run.json");
  }
  const runPath = path.join(canonicalRunDir, "run.json");
  writeExclusiveAtomic(
    runPath,
    Buffer.from(canonicalJson(record), "utf8"),
    "RUN_RECORD_CONFLICT",
  );
  return record;
}

function readRunRecord({ runDir }) {
  const canonicalRunDir = canonicalRunDirectory(runDir);
  const runPath = path.join(canonicalRunDir, "run.json");
  const bytes = readRegularFile(runPath, "run.json");
  if (!bytes) fail("RUN_RECORD_MISSING", `run.json is missing from ${runDir}`);
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("INVALID_RUN_RECORD", `run.json is not valid JSON: ${error.message}`);
  }
  validateRunRecord(record);
  assertRunDirectoryIdentity(canonicalRunDir, record.run_id);
  const expectedCriteriaPath = path.join(canonicalRunDir, "done-criteria.md");
  if (
    record.contract.done_criteria_path !== expectedCriteriaPath
    || fs.realpathSync(record.contract.done_criteria_path) !== expectedCriteriaPath
  ) {
    fail(
      "INVALID_RUN_RECORD",
      "run.contract.done_criteria_path must identify the frozen run-local done-criteria.md",
    );
  }
  if (hashDoneCriteria(record.contract.done_criteria_path) !== record.contract.done_criteria_sha256) {
    fail("DONE_CRITERIA_HASH_MISMATCH", "frozen Done Criteria bytes do not match run.json");
  }
  return record;
}

function hashDoneCriteria(doneCriteriaPath) {
  const bytes = readRegularFile(doneCriteriaPath, "Done Criteria");
  if (!bytes) fail("DONE_CRITERIA_MISSING", `Done Criteria is missing: ${doneCriteriaPath}`);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function freezeDoneCriteria({ sourcePath, runDir }) {
  const source = readRegularFile(sourcePath, "Done Criteria source");
  if (!source) fail("DONE_CRITERIA_MISSING", `Done Criteria is missing: ${sourcePath}`);
  const canonicalRunDir = canonicalRunDirectory(runDir, { create: true });
  const finalPath = path.join(canonicalRunDir, "done-criteria.md");
  writeExclusiveAtomic(finalPath, source, "DONE_CRITERIA_CONFLICT");
  return {
    path: finalPath,
    sha256: crypto.createHash("sha256").update(source).digest("hex"),
  };
}
function readArtifact(filePath, label, { optional = false } = {}) {
  const bytes = readRegularFile(filePath, label);
  if (!bytes) { if (optional) return null; fail("RUN_ARTIFACT_MISSING", `${label} is missing: ${filePath}`); }
  return { path: path.resolve(filePath), bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
function readJsonIfPresent(filePath) {
  const source = readArtifact(filePath, path.basename(filePath), { optional: true });
  return source ? JSON.parse(source.bytes.toString("utf8")) : null;
}
function writeImmutableJson(filePath, value, { fault = null } = {}) {
  const existing = readJsonIfPresent(filePath);
  if (existing) { if (JSON.stringify(existing) !== JSON.stringify(value)) throw new Error(`${path.basename(filePath)} immutable conflict`); return value; }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`), temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600); fault?.("open", filePath); fs.writeFileSync(fd, bytes); fault?.("write", filePath);
    fs.fsyncSync(fd); fault?.("fsync", filePath); fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, filePath); fault?.("rename", filePath);
    fsyncDirectory(path.dirname(filePath)); fault?.("dir_fsync", filePath); return value;
  } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {}; try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}
function assertTrustedWorktree({ repoRoot, activeCheckout, relayWorktreeBase, worktree }) {
  const canonical = (value, label) => { const resolved = fs.realpathSync(value); if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} must be a directory`); return resolved; };
  const repo = canonical(repoRoot, "repoRoot"), active = canonical(activeCheckout, "activeCheckout");
  const base = canonical(relayWorktreeBase, "relayWorktreeBase"), target = canonical(worktree, "worktree");
  if (target === repo || target === active || contained(active, target) || contained(target, active) || !contained(base, target)) throw new Error("worktree is outside the trusted relay worktree boundary");
  return true;
}

const REVIEW_ENV = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM"]);
function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function bindRegularFile(filePath, label) {
  try {
    return Object.freeze(host.sandboxInvocation.bindRegularFile(filePath, label));
  } catch (error) {
    throw new Error(error.message);
  }
}
function verifyRegularFileBinding(binding, label) {
  const observed = bindRegularFile(binding.path, label);
  if (observed.dev !== binding.dev || observed.ino !== binding.ino || observed.size !== binding.size || observed.sha256 !== binding.sha256) {
    throw new Error(`${label} changed after immutable staging`);
  }
  return observed;
}
function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function selectFilesystemIsolation({ darwinSandboxAvailable, nodePermissionModelAvailable, isNodeCommand }) {
  if (darwinSandboxAvailable) return "darwin_sandbox";
  void nodePermissionModelAvailable;
  void isNodeCommand;
  throw new Error("filesystem isolation unavailable: macOS sandbox-exec is required");
}
function isolatedEnvironment(overrides = {}, allowlist = REVIEW_ENV) {
  const env = {};
  for (const key of allowlist) if (typeof process.env[key] === "string") env[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!allowlist.has(key) || typeof value !== "string") throw new Error(`isolated process environment key is not allowed: ${key}`);
    env[key] = value;
  }
  return env;
}
function isolatedFailureReason(result, outcome) {
  if (result.error?.code === "ETIMEDOUT") return "invocation_timeout";
  const stderr = String(result.stderr || "");
  if (/not authenticated|not logged in|authentication|credentials? required|api[_ -]?key.{0,80}(?:missing|required|not set)|unauthorized|forbidden/i.test(stderr)) return "credentials_unavailable";
  if (/sqlite_readonly|readonly database|operation not permitted|permission denied|filesystem\.open|sandbox/i.test(stderr)) return "execution_environment_unavailable";
  if (result.signal) return "invocation_cancelled";
  if (Number.isInteger(result.status) && result.status !== 0) return "cli_nonzero_exit";
  if (outcome?.status !== "succeeded") return "output_protocol_mismatch";
  return "unknown_reviewer_failure";
}
function isolatedFailureSignals(result, outcome) {
  const stderr = String(result.stderr || ""), signals = [];
  if (/\.claude|\.codex|\bHOME\b|config(?:uration)?|session/i.test(stderr)) signals.push("home_or_config");
  if (/auth|credential|login|api[_ -]?key|unauthorized|forbidden/i.test(stderr)) signals.push("authentication");
  if (/readonly|operation not permitted|permission denied|EACCES|sqlite|sandbox/i.test(stderr)) signals.push("filesystem_denied");
  if (/network|connect|DNS|ECONN|ENET/i.test(stderr)) signals.push("network");
  if (/schema|json|output/i.test(stderr) || outcome?.status === "failed") signals.push("output_protocol");
  return [...new Set(signals)];
}
function runIsolated({ invocation, readRoot, writeRoot, timeoutMs = 120000, env, parseOutcome, envAllowlist = REVIEW_ENV, stdinBinding = null, credentials = null, processScope = null }) {
  if (!Array.isArray(invocation?.args) || invocation.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("isolated invocation requires string argv values");
  const childEnv = isolatedEnvironment(env, envAllowlist); childEnv.HOME = credentials?.roots.home || writeRoot; childEnv.XDG_CONFIG_HOME = credentials?.roots.xdg_config || writeRoot;
  childEnv.XDG_DATA_HOME = credentials?.roots.xdg_data || writeRoot; childEnv.TMPDIR = writeRoot;
  Object.assign(childEnv, credentials?.environment || {});
  Object.assign(childEnv, host.sandboxInvocation.privatePathEnvironment(invocation.privateEnvPaths, credentials?.roots || {}, childEnv, "INVALID_INVOCATION"));
  processScope ||= host.sandboxInvocation.beginProcessScope(); Object.assign(childEnv, processScope.env);
  const runtime = host.sandboxInvocation.bindRuntimeFiles({ command: invocation.command, env: childEnv, runtimeDependencies: invocation.runtimeDependencies });
  const runtimeError = (error) => { error.executed_runtime = runtime.runtime_files; return error; };
  const isolated = host.sandboxInvocation({
    role: "reviewer",
    command: runtime.command,
    args: invocation.args,
    readRoots: [readRoot, ...Object.values(credentials?.roots || {})], readFiles: credentials?.readable || [],
    writeRoots: [writeRoot, ...Object.values(credentials?.roots || {})],
    writeFiles: credentials?.writable || [],
    denyWriteFiles: credentials?.readonly || [],
    runtimeDependencies: invocation.runtimeDependencies,
    networkAccess: invocation.networkAccess || "disabled",
    env: childEnv,
  });
  let input;
  if (invocation.stdinPath) {
    const source = fs.realpathSync(invocation.stdinPath);
    if (!contained(readRoot, source)) throw new Error("independent reviewer stdin must be inside the immutable staging directory");
    if (!stdinBinding || source !== stdinBinding.path || invocation.stdinSha256 !== stdinBinding.sha256) {
      throw new Error("independent reviewer stdin is not bound to the verified prompt bytes");
    }
    input = verifyRegularFileBinding(stdinBinding, "independent reviewer stdin").bytes;
  }
  host.sandboxInvocation.verifyRuntimeFiles({ command: runtime.command, runtimeFiles: runtime.runtime_files,
    runtimeDependencies: invocation.runtimeDependencies, env: childEnv });
  const result = spawnSync(isolated.command, isolated.args, { cwd: readRoot, env: isolated.env, input, encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 << 20, detached: process.platform !== "win32" });
  let runtimeIntegrityError = null;
  try { host.sandboxInvocation.verifyRuntimeFiles({ command: runtime.command, runtimeFiles: runtime.runtime_files,
    runtimeDependencies: invocation.runtimeDependencies, env: childEnv, reenumerate: false }); }
  catch (error) { runtimeIntegrityError = error; }
  // The process-group reap must run even when the scope audit throws or times out, or a credential-holding
  // descendant would outlive the reviewer. Both audit failures are aggregated and reported together.
  const auditErrors = [];
  let scopedAudit = null, processGroupAudit = null;
  try { scopedAudit = host.sandboxInvocation.auditProcessScope(processScope); }
  catch (error) { auditErrors.push(error); }
  finally {
    try { processGroupAudit = host.sandboxInvocation.reapProcessGroup(result.pid, processScope.seal); }
    catch (error) { auditErrors.push(error); }
  }
  if (auditErrors.length) {
    const error = new Error(`independent reviewer runtime audit failed: ${auditErrors.map((entry) => entry.message).join("; ")}`);
    error.runtime_audit = { pgid: result.pid || null, process_group_absent: processGroupAudit?.absent === true,
      process_scope_matched: scopedAudit?.matched ?? null, process_scope_reaped: scopedAudit?.reaped ?? null,
      process_scope_remaining: scopedAudit?.remaining ?? null, remaining_identities: scopedAudit?.remaining_identities || [], scope_seal: processScope.seal,
      audit_errors: auditErrors.map((entry) => entry.code || entry.message), quiet_window_ms: 250 };
    throw runtimeError(error);
  }
  if (runtimeIntegrityError) throw runtimeError(runtimeIntegrityError);
  const stdoutPath = path.join(readRoot, "reviewer.stdout"), stderrPath = path.join(readRoot, "reviewer.stderr");
  fs.writeFileSync(stdoutPath, result.stdout || "", { mode: 0o600 }); fs.writeFileSync(stderrPath, result.stderr || "", { mode: 0o600 });
  let resultPath = invocation.resultPath || null;
  if (resultPath && !contained(writeRoot, path.resolve(resultPath))) throw new Error("independent reviewer result must be inside the writable staging child");
  let outcome; try { outcome = parseOutcome({ phase: "primary_review", exitCode: Number.isInteger(result.status) ? result.status : 1, signal: result.signal || null,
    timedOut: result.error?.code === "ETIMEDOUT", cancelled: false, stdoutPath, stderrPath, resultPath }); } catch (error) { throw runtimeError(error); }
  if (processGroupAudit.survived_terminal || !processGroupAudit.absent || scopedAudit.matched > 0) {
    const error = new Error(scopedAudit.remaining > 0 || processGroupAudit.unverified
      ? "independent reviewer cleanup incomplete"
      : "independent reviewer process scope survived terminal result");
    error.runtime_audit = { pgid: result.pid || null, process_group_absent: processGroupAudit.absent && scopedAudit.remaining === 0,
      process_scope_matched: scopedAudit.matched, process_scope_reaped: scopedAudit.reaped, process_scope_remaining: scopedAudit.remaining,
      remaining_identities: scopedAudit.remaining_identities || [], scope_seal: processScope.seal,
      process_group_unverified: processGroupAudit.unverified, quiet_window_ms: 250 };
    throw runtimeError(error);
  }
  if (!outcome || outcome.status !== "succeeded") {
    const reason = isolatedFailureReason(result, outcome), error = new Error(`independent reviewer failed (${reason})`);
    error.failure_reason = reason; error.failure_signals = isolatedFailureSignals(result, outcome); throw runtimeError(error);
  }
  return Object.freeze({ ...outcome, executed_runtime: runtime.runtime_files,
    runtime_audit: Object.freeze({ pgid: result.pid || null, process_group_absent: true, process_scope_remaining: 0, scope_seal: processScope.seal, quiet_window_ms: 250 }) });
}

function stageReviewerCredentials(stage, request) {
  request ||= { metadata: {}, envNames: [], fileSpecs: [], env: {} }; const normalized = normalizeCredentialRequest(request.metadata, request);
  const root = path.join(stage, "reviewer-credentials"), roots = { home: path.join(root, "home"), xdg_config: path.join(root, "xdg-config"), xdg_data: path.join(root, "xdg-data"), scratch: path.join(root, "scratch") };
  fs.mkdirSync(root, { mode: 0o700 }); for (const value of Object.values(roots)) fs.mkdirSync(value, { mode: 0o700 });
  const sources = new Map(normalized.fileSpecs.map((spec) => [spec.slice(0, spec.indexOf("=")), spec.slice(spec.indexOf("=") + 1)]));
  const readable = [], writable = [], readonly = [], environment = {};
  try {
    for (const name of normalized.envNames) {
      if (typeof request.env?.[name] !== "string") throw new Error(`credential environment value is missing: ${name}`);
      environment[name] = request.env[name];
    }
    for (const item of normalized.metadata.files) {
      const source = sources.get(item.id); if (!source) continue;
      const bytes = host.sandboxInvocation.readOwnerCredential(source, `credential '${item.id}'`), target = path.join(roots[item.targetRoot], item.targetRel);
      if (!contained(roots[item.targetRoot], target)) { bytes.fill(0); throw new Error("credential target escapes its private root"); }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(target), 0o700);
      try { fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 }); } finally { bytes.fill(0); }
      readable.push(target); if (item.access === "read_write") writable.push(target); else readonly.push(target);
    }
    return { root, roots, readable, writable, readonly, environment };
  } catch (error) { for (const key of Object.keys(environment)) delete environment[key]; throw error; }
}
function invokeExternalObserver({ observer, request, timeoutMs = 120000 }) {
  const stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-observer-")));
  try {
    const requestBytes = Buffer.from(JSON.stringify(request));
    const requestPath = path.join(stage, `request-${digest(requestBytes)}.json`);
    writeExclusiveAtomic(requestPath, requestBytes, "OBSERVER_INPUT_CONFLICT");
    const args = (observer.args || []).map((entry, index) => {
      if (!entry || !["literal", "staged_file"].includes(entry.kind) || typeof entry.value !== "string") throw new Error(`external observer args[${index}] must match {kind,value}`);
      if (entry.kind === "literal") return entry.value;
      const bytes = readRegularFile(entry.value, `external observer staged arg ${index}`);
      const target = path.join(stage, `observer-${index}-${digest(bytes)}${path.extname(entry.value)}`);
      writeExclusiveAtomic(target, bytes, "OBSERVER_INPUT_CONFLICT"); return target;
    });
    args.push("--request-file", requestPath);
    return runIsolated({ invocation: { command: observer.command, args, runtimeDependencies: observer.runtimeDependencies,
      networkAccess: observer.networkAccess }, readRoot: stage, writeRoot: stage,
      timeoutMs, env: observer.env, envAllowlist: new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "GH_TOKEN", "GITHUB_TOKEN"]),
      parseOutcome: ({ exitCode, stdoutPath, stderrPath }) => {
        if (exitCode !== 0) throw new Error(readRegularFile(stderrPath, "observer stderr").toString("utf8"));
        return { status: "succeeded", output: JSON.parse(readRegularFile(stdoutPath, "observer stdout").toString("utf8")) };
      } }).output;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
function invokeIndependentReviewer({ runDir, request, buildInvocation, parseOutcome, timeoutMs, env, credentialRequest = null }) {
  const record = readRunRecord({ runDir });
  const diff = readRegularFile(request.diff_path, "review diff"), prompt = readRegularFile(request.prompt_path, "review prompt");
  if (!diff || !prompt || request.reviewed_sha !== request.current_sha || request.diff_sha256 !== digest(diff) || request.prompt_sha256 !== digest(prompt)
    || fs.realpathSync(request.done_criteria_path) !== record.contract.done_criteria_path) throw new Error("review request is not bound to the immutable run, current SHA, and initial input digests");
  const criteria = readRegularFile(record.contract.done_criteria_path, "frozen Done Criteria");
  if (digest(criteria) !== record.contract.done_criteria_sha256) throw new Error("frozen Done Criteria bytes do not match the immutable run contract");
  const stage = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "relay-review-"))), stageStat = fs.lstatSync(stage), stageBinding = { dev: stageStat.dev, ino: stageStat.ino };
  let lockContext;
  try { lockContext = host.acquireRunLock({ runDir, attemptId: `review-${crypto.randomUUID()}`, operation: "review-execution",
    hostKind: "local_supervisor", hostHandle: `review:${process.pid}`, worktreeDir: runDir }); }
  catch (error) { host.sandboxInvocation.removeBoundDirectory(stage, stageBinding, "unowned review stage"); throw error; }
  const processScope = host.sandboxInvocation.beginProcessScope(), cleanup = host.retainReviewerCleanup(lockContext,
    { root: stage, binding: stageBinding, scopeSeal: processScope.seal });
  let binding = null, preserveStage = false, outcome, failure; try {
  const inputs = path.join(stage, "inputs"), output = path.join(inputs, "output"); fs.mkdirSync(inputs, { mode: 0o700 }); fs.mkdirSync(output, { mode: 0o700 });
  const paths = { diffPath: path.join(inputs, `review-diff-${digest(diff)}.patch`), promptPath: path.join(inputs, `review-prompt-${digest(prompt)}.md`),
    doneCriteriaPath: path.join(inputs, `done-criteria-${digest(criteria)}.md`) };
  writeExclusiveAtomic(paths.diffPath, diff, "REVIEW_INPUT_CONFLICT"); writeExclusiveAtomic(paths.promptPath, prompt, "REVIEW_INPUT_CONFLICT"); writeExclusiveAtomic(paths.doneCriteriaPath, criteria, "REVIEW_INPUT_CONFLICT");
  const schemaBytes = request.schema ? Buffer.from(JSON.stringify(request.schema)) : null;
  const schemaPath = schemaBytes ? path.join(inputs, `review-schema-${digest(schemaBytes)}.json`) : null;
  if (schemaPath) writeExclusiveAtomic(schemaPath, schemaBytes, "REVIEW_INPUT_CONFLICT");
  const stagedBindings = Object.freeze({
    diff: bindRegularFile(paths.diffPath, "staged review diff"),
    prompt: bindRegularFile(paths.promptPath, "staged review prompt"),
    criteria: bindRegularFile(paths.doneCriteriaPath, "staged Done Criteria"),
    ...(schemaPath ? { schema: bindRegularFile(schemaPath, "staged review schema") } : {}),
  });
  binding = Object.freeze({ diff_sha256: digest(diff), prompt_sha256: digest(prompt), staged_diff_sha256: digest(diff), staged_prompt_sha256: digest(prompt),
    staged_done_criteria_sha256: digest(criteria), staged_schema_sha256: schemaBytes ? digest(schemaBytes) : null,
    executed_prompt_sha256: stagedBindings.prompt.sha256,
    request_sha256: digest(Buffer.from(JSON.stringify({ run_id: record.run_id, reviewed_sha: request.reviewed_sha, ...paths }))) });
    const resultPath = path.join(output, "reviewer-result.json");
    const credentials = stageReviewerCredentials(stage, credentialRequest);
    const invocation = buildInvocation(Object.freeze({ cwd: inputs, ...paths, promptBytes: Buffer.from(stagedBindings.prompt.bytes), requestPath: null, resultPath, schemaPath }));
    for (const [label, fileBinding] of Object.entries(stagedBindings)) verifyRegularFileBinding(fileBinding, `staged review ${label}`);
    outcome = runIsolated({ invocation: { ...invocation, resultPath }, readRoot: inputs, writeRoot: output, timeoutMs, env, parseOutcome, stdinBinding: stagedBindings.prompt, credentials, processScope });
    for (const [label, fileBinding] of Object.entries(stagedBindings)) verifyRegularFileBinding(fileBinding, `staged review ${label}`);
  } catch (error) { if (binding) error.review_binding = binding; failure = error; const audit = error.runtime_audit;
    preserveStage = Boolean(audit && !(audit.process_group_absent === true && audit.process_scope_remaining === 0));
  }
  if (!preserveStage) try { cleanup.complete(outcome ? "completed" : "failed"); }
  catch (error) { failure = error; if (binding) error.review_binding = binding; preserveStage = true; }
  if (preserveStage) {
    failure.review_cleanup_path = cleanup.path;
    failure.review_evidence_preserved = true; failure.review_evidence_path = stage;
  } else host.releaseRunLock(lockContext, { outcome: "review_finished" });
  if (failure) throw failure;
  return Object.freeze({ ...outcome, review_binding: binding });
}

module.exports = {
  RUN_VERSION,
  assertTrustedWorktree,
  assertRunDirectoryIdentity,
  canonicalRunDirectory,
  canonicalRepository,
  createRunRecord,
  fsyncDirectory,
  freezeDoneCriteria,
  hashDoneCriteria,
  invokeIndependentReviewer,
  invokeExternalObserver,
  readArtifact,
  readJsonIfPresent,
  readRunRecord,
  relayWorktreeBase,
  resolveRunDirectory,
  selectFilesystemIsolation,
  validateRunRecord,
  writeImmutableJson,
};
