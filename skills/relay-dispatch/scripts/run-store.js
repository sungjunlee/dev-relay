const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RUN_VERSION = 3;
const SHA1_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
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

function validateRunRecord(record) {
  assertExactKeys(
    record,
    [
      "version",
      "run_id",
      "repo",
      "git",
      "contract",
      "roles",
      "parent",
      "ownership_digest",
      "created_at",
    ],
    [],
    "run",
  );
  if (record.version !== RUN_VERSION) {
    fail("UNSUPPORTED_RUN_VERSION", `run.version must be ${RUN_VERSION}`);
  }
  assertString(record.run_id, "run.run_id");

  assertExactKeys(record.repo, ["root", "remote"], [], "run.repo");
  assertString(record.repo.root, "run.repo.root");
  assertString(record.repo.remote, "run.repo.remote");
  if (!path.isAbsolute(record.repo.root)) {
    fail("INVALID_RUN_RECORD", "run.repo.root must be absolute");
  }

  assertExactKeys(
    record.git,
    ["branch", "base_branch", "worktree", "start_sha"],
    [],
    "run.git",
  );
  assertString(record.git.branch, "run.git.branch");
  assertString(record.git.base_branch, "run.git.base_branch");
  assertString(record.git.worktree, "run.git.worktree");
  if (!path.isAbsolute(record.git.worktree)) {
    fail("INVALID_RUN_RECORD", "run.git.worktree must be absolute");
  }
  assertSha(record.git.start_sha, SHA1_RE, "run.git.start_sha");

  assertExactKeys(
    record.contract,
    ["done_criteria_path", "done_criteria_sha256"],
    [],
    "run.contract",
  );
  assertString(record.contract.done_criteria_path, "run.contract.done_criteria_path");
  if (!path.isAbsolute(record.contract.done_criteria_path)) {
    fail("INVALID_RUN_RECORD", "run.contract.done_criteria_path must be absolute");
  }
  assertSha(
    record.contract.done_criteria_sha256,
    SHA256_RE,
    "run.contract.done_criteria_sha256",
  );

  assertExactKeys(
    record.roles,
    ["orchestrator", "executor", "reviewer"],
    [],
    "run.roles",
  );
  for (const role of ["orchestrator", "executor", "reviewer"]) {
    assertString(record.roles[role], `run.roles.${role}`);
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
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") {
      fail("UNTRUSTED_RUN_ARTIFACT", `${label} must be a regular non-symlink file`);
    }
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) {
      fail("UNTRUSTED_RUN_ARTIFACT", `${label} must be a regular non-symlink file`);
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

module.exports = {
  RUN_VERSION,
  assertRunDirectoryIdentity,
  canonicalRunDirectory,
  createRunRecord,
  fsyncDirectory,
  freezeDoneCriteria,
  hashDoneCriteria,
  readRunRecord,
  validateRunRecord,
};
