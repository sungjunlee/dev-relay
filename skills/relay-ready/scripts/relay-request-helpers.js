"use strict";

/** Trusted path, identifier, and exclusive artifact IO helpers for relay-request. */

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;

function fail(message, code = "REQUEST_PERSIST_FAILED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function canonicalRepoRoot(input) {
  const checkout = fs.realpathSync(path.resolve(input));
  const common = execFileSync("git", [
    "-C", checkout, "rev-parse", "--path-format=absolute", "--git-common-dir",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return fs.realpathSync(path.dirname(path.resolve(checkout, common)));
}

function repoSlug(repoRoot) {
  const root = canonicalRepoRoot(repoRoot);
  const base = path.basename(root).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  return `${base}-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
}

function assertSafeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value) || value === "." || value === "..") {
    fail(`${label} must be a safe path-independent identifier`, "REQUEST_ID_INVALID");
  }
  return value;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function ensurePrivateDirectory(directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`trusted request directory must be a real directory: ${directory}`, "REQUEST_PATH_UNTRUSTED");
  }
  return fs.realpathSync(directory);
}

function trustedRequestsBase() {
  const explicitBase = process.env.RELAY_REQUESTS_BASE;
  const relayHome = process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  const configured = explicitBase || path.join(relayHome, "requests");
  if (!path.isAbsolute(configured)) {
    fail("request storage base must be absolute", "REQUEST_PATH_UNTRUSTED");
  }
  const parent = path.dirname(configured);
  if (!fs.existsSync(parent)) {
    if (explicitBase || path.dirname(relayHome) !== fs.realpathSync(os.homedir())) {
      fail("request storage parent must already exist", "REQUEST_PATH_UNTRUSTED");
    }
    ensurePrivateDirectory(parent);
  }
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== path.resolve(parent)) {
    fail("request storage parent must be canonical and contain no symlink ancestors", "REQUEST_PATH_UNTRUSTED");
  }
  const base = ensurePrivateDirectory(path.join(fs.realpathSync(parent), path.basename(configured)));
  fsyncDirectory(path.dirname(base));
  return base;
}

function getRequestsDir(repoRoot) {
  const base = trustedRequestsBase();
  const directory = path.join(base, repoSlug(repoRoot));
  const canonical = ensurePrivateDirectory(directory);
  if (path.dirname(canonical) !== base) {
    fail("repository request directory escapes the trusted base", "REQUEST_PATH_UNTRUSTED");
  }
  fsyncDirectory(base);
  return canonical;
}

function createRequestId(timestamp = new Date()) {
  const iso = timestamp.toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  return `req-${iso}-${crypto.randomBytes(8).toString("hex")}`;
}

function readRegular(file, label = path.basename(file)) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
    );
  } catch (error) {
    if (error.code === "ELOOP") fail(`${label} must not be a symlink`, "REQUEST_PATH_UNTRUSTED");
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) fail(`${label} must be a regular file`, "REQUEST_PATH_UNTRUSTED");
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      fail(`${label} changed while being read`, "REQUEST_PATH_UNTRUSTED");
    }
    return bytes;
  } finally { fs.closeSync(descriptor); }
}

function writeExclusive(file, bytes, label) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const written = fs.writeSync(descriptor, buffer, 0, buffer.length);
    if (written !== buffer.length) fail(`short write for ${label}`, "REQUEST_SHORT_WRITE");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!readRegular(file, label).equals(buffer)) {
      fail(`immutable ${label} already exists with different bytes`, "REQUEST_ARTIFACT_CONFLICT");
    }
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  fsyncDirectory(path.dirname(file));
  return file;
}

function publishAtomicExclusive(file, bytes, label, beforePublish) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  let temporaryCreated = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    temporaryCreated = true;
    let offset = 0;
    while (offset < buffer.length) offset += fs.writeSync(descriptor, buffer, offset, buffer.length - offset);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    beforePublish?.();
    try {
      // Hard-link publication is atomic and cannot replace an immutable marker.
      fs.linkSync(temporary, file);
      fsyncDirectory(directory);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!readRegular(file, label).equals(buffer)) {
        fail(`immutable ${label} already exists with different bytes`, "REQUEST_ARTIFACT_CONFLICT");
      }
    }
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    if (temporaryCreated) {
      try { fs.unlinkSync(temporary); fsyncDirectory(directory); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return file;
}

module.exports = {
  assertSafeId,
  canonicalRepoRoot,
  createRequestId,
  ensurePrivateDirectory,
  fail,
  fsyncDirectory,
  getRequestsDir,
  publishAtomicExclusive,
  readRegular,
  repoSlug,
  trustedRequestsBase,
  writeExclusive,
};
