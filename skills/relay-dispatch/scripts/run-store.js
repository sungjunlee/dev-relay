const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  contained,
  fsyncDirectory,
  invokeExternalObserver,
  invokeIndependentReviewer,
  readRegularFile,
  writeExclusiveAtomic,
} = require("./run-store-helpers");

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

// Resolve platform aliases (notably macOS /tmp -> /private/tmp) before a
// caller records a durable path. Only the existing prefix is followed; the
// worktree writer separately lstat-walks its Relay-owned suffix before writing.
function canonicalPathPrefix(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("INVALID_RELAY_PATH", `${label} must be absolute`);
  const resolved = path.resolve(value);
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) fail("INVALID_RELAY_PATH", `${label} must not be a symlink`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let prefix = resolved;
  while (!fs.existsSync(prefix)) {
    const parent = path.dirname(prefix);
    if (parent === prefix) fail("INVALID_RELAY_PATH", `${label} has no existing parent`);
    prefix = parent;
  }
  const canonicalPrefix = fs.realpathSync(prefix);
  if (!fs.statSync(canonicalPrefix).isDirectory()) fail("INVALID_RELAY_PATH", `${label} existing prefix must be a directory`);
  const suffix = path.relative(prefix, resolved);
  if (suffix.startsWith("..") || path.isAbsolute(suffix)) fail("INVALID_RELAY_PATH", `${label} escapes its existing prefix`);
  return suffix ? path.join(canonicalPrefix, suffix) : canonicalPrefix;
}

function relayHome() {
  const value = process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  return canonicalPathPrefix(value, "RELAY_HOME");
}

function relayWorktreeBase() {
  const value = process.env.RELAY_WORKTREE_BASE || path.join(relayHome(), "worktrees");
  return canonicalPathPrefix(value, "RELAY_WORKTREE_BASE");
}

function resolveRunDirectory(repository, runId) {
  const root = canonicalRepository(repository);
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) fail("INVALID_RUN_ID", "runId must be one safe path segment");
  const base = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const slug = `${base}-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
  const runs = canonicalPathPrefix(process.env.RELAY_RUNS_BASE || path.join(relayHome(), "runs"), "RELAY_RUNS_BASE");
  return path.join(runs, slug, runId);
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
function readArtifact(filePath, label, { optional = false, expectedIdentity = null } = {}) {
  const bytes = readRegularFile(filePath, label, { expectedIdentity });
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
  validateRunRecord,
  writeImmutableJson,
};
