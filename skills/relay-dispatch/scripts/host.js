"use strict";

const { execFileSync, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizePrivateEnvPaths } = require("./adapter-contract");

const OWNERSHIP = "ownership";
const OWNER_RE = /^(\d{12})\.owner\.json$/;
const ATTEMPT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/;
const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out", "spawn_error"]);
const BREAK_PROBE_MS = 10_000;
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const PROCESS_SCOPE_KEY = "RELAY_PROCESS_SCOPE";
const PROCESS_CONTRACT = "inherited_scope_no_daemon";
const PS_ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;
const SCOPE_RE = new RegExp(`(?:^|\\s)${PROCESS_SCOPE_KEY}=([0-9a-f]{64})(?=\\s|$)`);
const issuedLocks = new WeakSet();
const lockStates = new WeakMap();
const issuedReceipts = new WeakSet();
const receiptStates = new WeakMap();
const issuedInspections = new WeakSet();
const inspectionStates = new WeakMap();
const issuedProcessScopes = new WeakSet();
const processScopeStates = new WeakMap();
const issuedCredentialBundles = new WeakSet();
const credentialBundleStates = new WeakMap();

class HostError extends Error {
  constructor(message, code, details = {}) {
    super(message); this.name = "HostError"; this.code = code; Object.assign(this, details);
  }
}
function fail(message, code, details) { throw new HostError(message, code, details); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function hmac(value, secret) { return crypto.createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex"); }
function equalHex(left, right) {
  return typeof left === "string" && typeof right === "string" && left.length === right.length
    && /^[0-9a-f]+$/i.test(left) && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
function signed(value, secret, field = "auth_sha256") { return { ...value, [field]: hmac(value, secret) }; }
function verifySigned(value, secret, field = "auth_sha256") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { [field]: signature, ...body } = value;
  return equalHex(signature, hmac(body, secret));
}
function safeAttempt(attemptId) {
  if (typeof attemptId !== "string" || !ATTEMPT_RE.test(attemptId)) fail("invalid attempt id", "INVALID_ATTEMPT_ID");
  return attemptId;
}
function normalizedPrivatePaths(value, code = "INVALID_INVOCATION") { try { return normalizePrivateEnvPaths(value); } catch (cause) { fail(cause.message, code, { cause }); } }
function attemptPrivateRoot(runDir, owner, short) {
  const parent = canonicalDir(short ? fs.realpathSync("/tmp") : runDir, "executor private parent"), name = short ? `relay-${sha256(`${owner.lock_id}:${owner.attempt_id}`).slice(0, 32)}` : `executor-credentials-${owner.attempt_id}`;
  const target = path.join(parent, name);
  if (short && Buffer.byteLength(target) > 64) fail("short private root exceeds 64 bytes", "INVALID_INVOCATION"); return target;
}
function privatePathEnvironment(declarations, roots, environment, code) {
  const values = {}; for (const item of normalizedPrivatePaths(declarations, code)) {
    if (Object.hasOwn(environment, item.key)) fail("private environment path collides with caller environment", code);
    const root = roots[item.root], target = root && path.resolve(root, item.relative), relative = root && path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || (item.root === "scratch" && Buffer.byteLength(target) > 83)) fail("private environment path escapes its root or exceeds the short-path limit", code);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 }); fs.chmodSync(target, 0o700); values[item.key] = target;
  } return values;
}
function canonicalDir(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(`${label} must be absolute`, "INVALID_PATH");
  let stat;
  try { stat = fs.lstatSync(value); } catch (cause) { fail(`${label} does not exist`, "INVALID_PATH", { cause }); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory`, "UNTRUSTED_PATH");
  const real = fs.realpathSync(value);
  if (real !== path.resolve(value)) fail(`${label} must be canonical`, "UNTRUSTED_PATH");
  return real;
}
function directChild(root, value, label, { exists = false, directory = false } = {}) {
  const canonical = canonicalDir(root, `${label} root`);
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(`${label} must be absolute`, "INVALID_PATH");
  const resolved = path.resolve(value);
  if (path.dirname(resolved) !== canonical) fail(`${label} must be a direct child of its root`, "UNTRUSTED_PATH");
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail(`${label} has an unsafe type`, "UNTRUSTED_PATH");
    if (fs.realpathSync(resolved) !== resolved) fail(`${label} must be canonical`, "UNTRUSTED_PATH");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (exists) fail(`${label} does not exist`, "INVALID_PATH");
  }
  return resolved;
}
function syncDir(directory) {
  let fd;
  try { fd = fs.openSync(directory, "r"); fs.fsyncSync(fd); }
  catch (error) { if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes(error.code)) throw error; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
function secureRead(filePath, label) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd), pathStat = fs.lstatSync(filePath);
    if (!stat.isFile() || pathStat.isSymbolicLink() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino
      || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
      fail(`${label} is not an owner-only regular file`, "UNTRUSTED_HOST_ARTIFACT", { artifactPath: filePath });
    }
    const bytes = fs.readFileSync(fd);
    return { value: JSON.parse(bytes.toString("utf8")), bytes, stat };
  } finally { fs.closeSync(fd); }
}
function publishOnce(target, value) {
  const directory = path.dirname(target), bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value)}\n`);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined; fs.linkSync(temporary, target); syncDir(directory); return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    fail("immutable artifact publication failed", "HOST_STORAGE_FAILED", { target, cause: error });
  } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {}; try { fs.unlinkSync(temporary); } catch {} }
}
function atomicWrite(target, value) {
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600); fs.writeFileSync(fd, value); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, target); syncDir(directory);
  } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {}; try { fs.unlinkSync(temporary); } catch {} }
}
function quote(value) { return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
function resolveExecutable(command, env = process.env) {
  if (typeof command !== "string" || !command || command.includes("\0") || (!path.isAbsolute(command) && command.includes(path.sep))) {
    fail("command must be a bare name or absolute path", "INVALID_INVOCATION");
  }
  const candidates = path.isAbsolute(command) ? [command] : String(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const candidate of candidates) try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); } catch {}
  fail(`executable not found: ${command}`, "INVALID_INVOCATION");
}
function environmentEntries(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`, "INVALID_INVOCATION");
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const injection = /^(?:SSL_CERT_FILE|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|ZDOTDIR|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|PHPRC|PHP_INI_SCAN_DIR|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|PERL5DB|RUBYOPT|RUBYLIB|GEM_HOME|GEM_PATH|GCONV_PATH|LOCPATH|NLSPATH)$|^(?:DYLD|LD)_|^LUA_(?:INIT|PATH|CPATH)(?:_.*)?$/.test(key);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || injection || typeof entry !== "string" || entry.includes("\0")) {
      fail(`${label} contains an invalid environment entry`, "INVALID_INVOCATION");
    }
    result[key] = entry;
  }
  return result;
}
function minimalEnvironment(source = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (["PATH", "PATHEXT", "LANG", "TERM", "COLORTERM", "NO_COLOR"].includes(key) || /^LC_[A-Z0-9_]+$/.test(key)) {
      if (typeof value === "string" && !value.includes("\0")) result[key] = value;
    }
  }
  return result;
}
function regularFileBinding(filePath, label, { canonical = true } = {}) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd), pathStat = fs.lstatSync(filePath);
    if (!stat.isFile() || pathStat.isSymbolicLink() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino || (canonical && fs.realpathSync(filePath) !== filePath)) {
      fail(`${label} is not an exact regular file`, "UNTRUSTED_PATH");
    }
    const bytes = fs.readFileSync(fd);
    return { path: filePath, size: bytes.length, sha256: sha256(bytes), dev: stat.dev, ino: stat.ino, bytes };
  } finally { fs.closeSync(fd); }
}
function trustedSystemCaFile() {
  let canonical;
  try { canonical = fs.realpathSync("/etc/ssl/cert.pem"); }
  catch (error) {
    // A missing system CA bundle must fail typed like every other trust violation in this function,
    // not surface as a raw ENOENT that callers cannot classify.
    if (error.code === "ENOENT") fail("system CA bundle is absent: /etc/ssl/cert.pem", "UNTRUSTED_SYSTEM_CA");
    throw error;
  }
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd), pathStat = fs.lstatSync(canonical);
    if (!stat.isFile() || pathStat.isSymbolicLink() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino
      || canonical !== path.resolve(canonical) || fs.realpathSync(canonical) !== canonical || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
      fail("system CA bundle is not a canonical root-owned regular file", "UNTRUSTED_SYSTEM_CA");
    const header = Buffer.alloc(4096), count = fs.readSync(fd, header, 0, header.length, 0);
    if (!header.subarray(0, count).includes(Buffer.from("BEGIN CERTIFICATE"))) fail("system CA bundle has no certificate data", "UNTRUSTED_SYSTEM_CA");
  } finally { fs.closeSync(fd); } return canonical;
}
function verifyFileBinding(binding, label) {
  if (!binding || typeof binding !== "object" || typeof binding.path !== "string") fail(`${label} binding is invalid`, "HOST_CONFIG_MISMATCH");
  const observed = regularFileBinding(binding.path, label);
  if (observed.size !== binding.size || observed.sha256 !== binding.sha256 || observed.dev !== binding.dev || observed.ino !== binding.ino) {
    fail(`${label} changed after launch`, "HOST_INPUT_CHANGED");
  }
  return observed.path;
}
function credentialSource(filePath, label) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) fail(`${label} source must be absolute and canonical`, "INVALID_CREDENTIAL");
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const before = fs.fstatSync(fd), named = fs.lstatSync(filePath);
    if (!before.isFile() || named.isSymbolicLink() || before.dev !== named.dev || before.ino !== named.ino || fs.realpathSync(filePath) !== filePath
      || (typeof process.getuid === "function" && before.uid !== process.getuid()) || (before.mode & 0o077) !== 0) fail(`${label} source must be a current-user owner-only regular file`, "UNTRUSTED_CREDENTIAL");
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), renamed = fs.lstatSync(filePath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || after.dev !== renamed.dev || after.ino !== renamed.ino || renamed.isSymbolicLink() || bytes.length !== after.size) {
      bytes.fill(0); fail(`${label} source changed while read`, "CREDENTIAL_CHANGED");
    }
    return { path: filePath, dev: before.dev, ino: before.ino, size: bytes.length, sha: sha256(bytes), bytes };
  } catch (error) {
    if (error instanceof HostError) throw error;
    fail(`${label} source is unavailable`, "UNTRUSTED_CREDENTIAL");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function prepareCredentialBundle({ metadata = {}, envNames = [], fileSpecs = [], env = process.env } = {}) {
  if (!Array.isArray(envNames) || !Array.isArray(fileSpecs)) fail("credential options must be arrays", "INVALID_CREDENTIAL");
  const catalog = new Map((metadata.files || []).map((item) => [item.id, item])), seenEnv = new Set(), seenId = new Set(), seenTarget = new Set(), values = {}, files = [];
  for (const name of envNames) {
    if (seenEnv.has(name) || /^(?:HOME|PATH|TMPDIR|TMP|TEMP|XDG_CONFIG_HOME|XDG_DATA_HOME|RELAY_PROCESS_SCOPE)$|^RELAY_/.test(name || "")) fail(`credential environment name is reserved or duplicated: ${name}`, "INVALID_CREDENTIAL");
    environmentEntries({ [name]: "checked" }, "credential environment");
    if (typeof env[name] !== "string") fail(`credential environment value is missing: ${name}`, "CREDENTIAL_MISSING");
    seenEnv.add(name); values[name] = env[name];
  }
  try { for (const spec of fileSpecs) {
    if (typeof spec !== "string") fail("credential file must be ID=/absolute/source", "INVALID_CREDENTIAL");
    const equals = spec.indexOf("="), id = spec.slice(0, equals), sourcePath = spec.slice(equals + 1), item = catalog.get(id);
    if (equals < 1 || !item) fail(`unknown credential file id: ${id || spec}`, "INVALID_CREDENTIAL");
    if (!/^[a-z][a-z0-9_-]*$/.test(item.id || "") || !["home", "xdg_config", "xdg_data"].includes(item.targetRoot)
      || !["read", "read_write"].includes(item.access) || typeof item.targetRel !== "string" || path.isAbsolute(item.targetRel)
      || !item.targetRel || item.targetRel.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) fail("credential target metadata is invalid", "INVALID_CREDENTIAL");
    const target = `${item.targetRoot}:${item.targetRel}`;
    if (seenId.has(id) || seenTarget.has(target)) fail("credential file id or target collision", "INVALID_CREDENTIAL");
    seenId.add(id); seenTarget.add(target);
    files.push({ ...item, source: credentialSource(sourcePath, `credential '${id}'`) });
  } } catch (error) {
    for (const item of files) item.source.bytes.fill(0);
    for (const key of Object.keys(values)) { values[key] = ""; delete values[key]; }
    throw error;
  }
  const bundle = Object.freeze({ env_names: Object.freeze([...seenEnv]), files: Object.freeze(files.map(({ source, recommendedSource, ...item }) => Object.freeze({ ...item, size: source.size, sha: source.sha }))) });
  issuedCredentialBundles.add(bundle); credentialBundleStates.set(bundle, { values, files }); return bundle;
}
function credentialState(bundle) {
  if (!bundle) return { values: {}, files: [], publicFiles: [], envNames: [] };
  if (!issuedCredentialBundles.has(bundle)) fail("issued credential bundle required", "INVALID_CREDENTIAL");
  const state = credentialBundleStates.get(bundle), files = [];
  try {
    for (const item of state.files) {
      const fresh = credentialSource(item.source.path, `credential '${item.id}'`);
      if (fresh.dev !== item.source.dev || fresh.ino !== item.source.ino || fresh.size !== item.source.size || fresh.sha !== item.source.sha) {
        fresh.bytes.fill(0); fail(`credential '${item.id}' changed after validation`, "CREDENTIAL_CHANGED");
      }
      files.push({ ...item, source: fresh });
    }
    return { values: { ...state.values }, files, publicFiles: bundle.files, envNames: bundle.env_names };
  } catch (error) { for (const item of files) item.source.bytes.fill(0); throw error; }
  finally {
    for (const item of state.files) item.source.bytes.fill(0);
    for (const key of Object.keys(state.values)) { state.values[key] = ""; delete state.values[key]; }
    credentialBundleStates.delete(bundle); issuedCredentialBundles.delete(bundle);
  }
}
function shebangExecutables(executable, env) {
  const found = [], seen = new Set(); let current = executable;
  for (let depth = 0; depth < 4 && current && !seen.has(current); depth += 1) {
    seen.add(current); found.push(current);
    let first;
    try {
      const fd = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try { const buffer = Buffer.alloc(4096), length = fs.readSync(fd, buffer, 0, buffer.length, 0); first = buffer.subarray(0, length).toString("utf8").split(/\r?\n/, 1)[0]; }
      finally { fs.closeSync(fd); }
    } catch { break; }
    if (!first.startsWith("#!")) break;
    const words = first.slice(2).trim().split(/\s+/).filter(Boolean);
    if (!words.length || !path.isAbsolute(words[0])) fail("script interpreter is invalid", "INVALID_INVOCATION");
    const interpreter = resolveExecutable(words[0], env); found.push(interpreter);
    if (path.basename(interpreter) === "env") {
      const name = words.slice(1).find((word) => !word.startsWith("-"));
      if (!name) fail("env shebang has no interpreter", "INVALID_INVOCATION");
      current = resolveExecutable(name, env);
    } else current = interpreter;
  }
  return [...new Set(found)];
}
function sandboxFile(value, label, mustExist) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(`${label} must be absolute`, "INVALID_PATH");
  const resolved = path.resolve(value), parent = canonicalDir(path.dirname(resolved), `${label} parent`);
  if (path.dirname(resolved) !== parent) fail(`${label} parent must be canonical`, "UNTRUSTED_PATH");
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) fail(`${label} is unsafe`, "UNTRUSTED_PATH");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (mustExist) fail(`${label} does not exist`, "INVALID_PATH");
  }
  return resolved;
}
function runtimeDependencyRules(executables, declaration = { executableParent: null, interpreterParent: null }, environment = process.env) {
  if (Object.keys(declaration || {}).sort().join(",") !== "executableParent,interpreterParent") fail("runtime dependency declaration is invalid", "INVALID_INVOCATION");
  const rootFor = (file, depth) => {
    if (depth === null) return null; if (!Number.isInteger(depth) || depth < 0 || depth > 2) fail("runtime dependency parent depth is invalid", "INVALID_INVOCATION");
    let root = path.dirname(file); for (let index = 0; index < depth; index += 1) root = path.dirname(root);
    if (root === path.parse(root).root) fail("runtime dependency declaration is too broad", "INVALID_INVOCATION");
    const canonical = canonicalDir(root, "runtime dependency root"), homes = [os.homedir(), environment.HOME]
      .filter((value) => typeof value === "string" && path.isAbsolute(value)).map((value) => path.resolve(value));
    if (homes.some((home) => { const relative = path.relative(canonical, home); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); })) fail("runtime dependency root cannot include HOME", "INVALID_INVOCATION");
    return canonical;
  };
  const roots = [], commandRoot = rootFor(executables[0], declaration.executableParent);
  if (commandRoot) roots.push(commandRoot); const interpreter = executables.at(-1);
  if (interpreter && interpreter !== executables[0] && path.basename(interpreter) !== "env") {
    const interpreterRoot = rootFor(interpreter, declaration.interpreterParent); if (interpreterRoot) roots.push(interpreterRoot);
  } return [...new Set(roots)];
}
function darwinLinkedLibraryFiles(executables) {
  if (process.platform !== "darwin") return [];
  const main = executables[0], queue = [...executables], seen = new Set(executables), libraries = [];
  const expand = (value, loader) => value.replace(/^@loader_path/, path.dirname(loader)).replace(/^@executable_path/, path.dirname(main));
  while (queue.length) {
    const binary = queue.shift(); let linked, loadCommands;
    try { linked = execFileSync("/usr/bin/otool", ["-L", binary], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
      loadCommands = execFileSync("/usr/bin/otool", ["-l", binary], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
    } catch { continue; }
    const rpaths = [...loadCommands.matchAll(/\n\s*cmd LC_RPATH\n\s*cmdsize \d+\n\s*path (\S+) \(offset \d+\)/g)].map((match) => expand(match[1], binary));
    for (const raw of linked.split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+\(/, 1)[0]).filter(Boolean)) {
      const candidates = raw.startsWith("@rpath/") ? rpaths.map((root) => path.join(root, raw.slice(7))) : [expand(raw, binary)], candidate = candidates.find((file) => path.isAbsolute(file) && fs.existsSync(file)); if (!candidate) continue;
      const canonical = fs.realpathSync(candidate), stat = fs.lstatSync(canonical);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("linked runtime library is unsafe", "INVALID_INVOCATION");
      if (!seen.has(canonical)) { seen.add(canonical); libraries.push(canonical); queue.push(canonical); }
    }
  } return libraries;
}
function darwinRuntimeSupportFiles(libraries) {
  if (process.platform !== "darwin") return []; const files = [];
  for (const library of libraries) {
    const match = /^(.*)\/Cellar\/(openssl(?:@[^/]+)?)\//.exec(library); if (!match) continue;
    for (const name of ["openssl.cnf", "cert.pem"]) {
      const visible = path.join(match[1], "etc", match[2], name); if (!fs.existsSync(visible)) continue;
      const canonical = fs.realpathSync(visible), stat = fs.lstatSync(canonical);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("runtime support file is unsafe", "INVALID_INVOCATION");
      files.push(visible, canonical);
    }
  } return [...new Set(files)];
}
function runtimeBindingSet(command, environment, declaration) {
  const executable = resolveExecutable(command, environment), executables = shebangExecutables(executable, environment);
  runtimeDependencyRules(executables, declaration, environment); const libraries = darwinLinkedLibraryFiles(executables);
  const files = [...executables, ...libraries, ...darwinRuntimeSupportFiles(libraries)].map((file) => fs.realpathSync(file));
  const runtimeFiles = [...new Map(files.map((file) => [file, regularFileBinding(file, "runtime executable dependency")])).values()]
    .map(({ bytes, ...binding }) => binding);
  return { command: executable, runtimeFiles };
}
function verifyRuntimeFileBindings({ command, runtimeFiles, runtimeDependencies, environment = process.env, reenumerate = true }) {
  if (!Array.isArray(runtimeFiles) || runtimeFiles.length === 0) fail("runtime file bindings are unavailable", "HOST_CONFIG_MISMATCH");
  if (reenumerate) {
    const current = runtimeBindingSet(command, environment, runtimeDependencies);
    const same = runtimeFiles.length === current.runtimeFiles.length && runtimeFiles.every((binding, index) => binding.path === current.runtimeFiles[index]?.path
      && ["dev", "ino", "size", "sha256"].every((key) => binding[key] === current.runtimeFiles[index][key]));
    if (current.command !== command || !same) fail("runtime executable closure changed after launch", "HOST_RUNTIME_CHANGED");
  } for (const [index, binding] of runtimeFiles.entries()) verifyFileBinding(binding, `runtime executable dependency ${index}`); return command;
}
function sandboxInvocation({ role, command, args = [], readRoots = [], writeRoots = [], readFiles = [], writeFiles = [], denyWriteFiles = [],
  runtimeDependencies = { executableParent: null, interpreterParent: null }, networkAccess = "disabled", env = process.env, ownershipDir = null, platform = process.platform } = {}) {
  if (platform !== "darwin") fail("macOS sandbox-exec is required", "EXECUTOR_WRITE_ISOLATION_UNAVAILABLE", { recommended_action: "inspect" });
  try { fs.accessSync(SANDBOX_EXEC, fs.constants.X_OK); } catch (cause) {
    fail("macOS sandbox-exec is unavailable", "EXECUTOR_WRITE_ISOLATION_UNAVAILABLE", { cause, recommended_action: "inspect" });
  }
  if (!new Set(["executor", "reviewer"]).has(role)) fail("sandbox role is invalid", "INVALID_INVOCATION");
  if (!new Set(["enabled", "disabled"]).has(networkAccess)) fail("sandbox network policy is invalid", "INVALID_INVOCATION");
  if (Object.hasOwn(env, "SSL_CERT_FILE")) fail("SSL_CERT_FILE is host-reserved", "INVALID_INVOCATION");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) fail("args must be string argv", "INVALID_INVOCATION");
  const executable = resolveExecutable(command, env);
  const reads = [...new Set(readRoots.map((root) => canonicalDir(root, "sandbox read root")))];
  const writes = [...new Set(writeRoots.map((root) => canonicalDir(root, "sandbox write root")))];
  const readableFiles = [...new Set(readFiles.map((file) => sandboxFile(file, "sandbox read file", true)))];
  const writableFiles = [...new Set(writeFiles.map((file) => sandboxFile(file, "sandbox write file", false)))];
  const deniedWriteFiles = [...new Set(denyWriteFiles.map((file) => sandboxFile(file, "sandbox denied write file", true)))];
  const readRules = [...reads.map((root) => `(subpath "${quote(root)}")`), ...readableFiles.map((file) => `(literal "${quote(file)}")`)].join(" ");
  const writeRules = [...writes.map((root) => `(subpath "${quote(root)}")`), ...writableFiles.map((file) => `(literal "${quote(file)}")`)].join(" ");
  const denyOwner = ownershipDir ? `(deny file-read* file-write* (subpath "${quote(path.resolve(ownershipDir))}"))` : "";
  const runtimeExecutables = shebangExecutables(executable, env);
  const linkedLibraries = darwinLinkedLibraryFiles(runtimeExecutables);
  const runtimeRules = [...runtimeExecutables.map((item) => `(literal "${quote(item)}")`), ...linkedLibraries.map((item) => `(literal "${quote(item)}")`),
    ...darwinRuntimeSupportFiles(linkedLibraries).map((item) => `(literal "${quote(item)}")`),
    ...runtimeDependencyRules(runtimeExecutables, runtimeDependencies, env).map((root) => `(subpath "${quote(root)}")`)].join(" ");
  const deniedWrites = deniedWriteFiles.map((file) => `(deny file-write* (literal "${quote(file)}"))`).join(" ");
  const transportMach = networkAccess === "enabled"
    ? '(allow mach-lookup (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.trustd.agent"))'
    : "";
  const systemCa = networkAccess === "enabled" ? trustedSystemCaFile() : null;
  const systemCaRule = systemCa ? `(literal "${quote(systemCa)}")` : "";
  const profile = [
    "(version 1)", "(deny default)", "(allow process*)", "(allow process-fork)", "(allow process-exec*)", "(allow signal (target self))", '(deny process-exec (literal "/usr/bin/osascript"))',
    "(deny appleevent-send)", "(allow sysctl-read)", "(allow file-read-metadata)", transportMach, ...(networkAccess === "enabled" ? ["(allow network*)"] : []),
    `(allow file-read* ${readRules} (literal "/") ${runtimeRules} ${systemCaRule} (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/Library") (subpath "/private/var/db") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`,
    `(allow file-write* ${writeRules} (literal "/dev/null"))`, deniedWrites, denyOwner,
  ].join("");
  return Object.freeze({ command: SANDBOX_EXEC, args: ["-p", profile, executable, ...args], env: { ...env, ...(systemCa ? { SSL_CERT_FILE: systemCa } : {}) } });
}
// macOS exposes only second-resolution `lstart` (no kern.proc.pid start microseconds through a safe CLI),
// so a same-second PID reuse is indistinguishable by identity alone. Every signal target is therefore also
// bound to a random inherited scope token (`inherited_scope_no_daemon`) and revalidated immediately before
// delivery; an unverifiable target is never signalled. This is PID-reuse safety, not a same-UID adversary boundary.
function processRows({ environment = false, pid = null } = {}) {
  const output = execFileSync("/bin/ps", [...(environment ? ["eww"] : []), ...(pid === null ? ["-ax"] : ["-p", String(pid)]),
    "-o", "pid=,ppid=,pgid=,state=,lstart=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, maxBuffer: 8 << 20 });
  return output.split(/\r?\n/).map((line) => PS_ROW_RE.exec(line)).filter(Boolean).map((match) => {
    const started = Date.parse(match[5].replace(/\s+/g, " "));
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[6], scope: (SCOPE_RE.exec(match[6]) || [])[1] || null,
      identity: Number.isFinite(started) ? Object.freeze({ pid: Number(match[1]), pgid: Number(match[3]), state: match[4], started_at: new Date(started).toISOString() }) : null };
  });
}
function scopeSeal(token) { return /^[0-9a-f]{64}$/.test(token || "") ? sha256(token) : null; }
function sealed(scope, seal) { return Boolean(seal) && typeof scope === "string" && equalHex(sha256(scope), seal); }
function probeRow(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") return null;
  try { return processRows({ environment: true, pid })[0] || null; } catch { return null; }
}
function fingerprint(pid) { return probeRow(pid)?.identity || null; }
function sameProcess(left, right) { return Boolean(left && right && left.pid === right.pid && left.pgid === right.pgid && left.started_at === right.started_at); }
function signalScoped(identity, signal, seal) {
  const row = identity ? probeRow(identity.pid) : null;
  if (!row || !sameProcess(row.identity, identity) || !sealed(row.scope, seal)) {
    return { delivered: false, verified: false, absent: !row || !sameProcess(row.identity, identity) };
  }
  try { process.kill(row.identity.pid, signal); return { delivered: true, verified: true, absent: false }; }
  catch (error) { return { delivered: false, verified: true, absent: error.code === "ESRCH" }; }
}
function scopedGroupMembers(pgid, seal) {
  if (!seal || !Number.isInteger(pgid) || pgid <= 0) return [];
  try { return processRows({ environment: true }).filter((row) => row.pgid === pgid && row.identity && sealed(row.scope, seal)).map((row) => row.identity); }
  catch { return []; }
}
function signalScopedGroup(identity, signal, seal) {
  let delivered = false;
  // Never signal a process group as a unit: a same-session outsider can share the
  // PGID. Enumerate and revalidate the inherited scope on every PID instead.
  for (const member of scopedGroupMembers(identity?.pgid, seal)) if (signalScoped(member, signal, seal).delivered) delivered = true;
  return { delivered, absent: !delivered && !groupExists(identity?.pgid) };
}
function exactIdentity(value, label = "process identity") {
  if (!value || !Number.isInteger(value.pid) || value.pid <= 0 || !Number.isInteger(value.pgid) || value.pgid <= 0
    || typeof value.started_at !== "string" || Number.isNaN(Date.parse(value.started_at))) fail(`${label} is invalid`, "HOST_ARTIFACT_INVALID");
  return { pid: value.pid, pgid: value.pgid, started_at: value.started_at };
}
function pollUntil(predicate, timeoutMs, intervalMs = 20) {
  const end = Date.now() + timeoutMs, waiter = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < end) { const value = predicate(); if (value) return value; Atomics.wait(waiter, 0, 0, intervalMs); }
  return predicate();
}
function waitFingerprint(pid, timeoutMs = 5_000) { return pollUntil(() => fingerprint(pid), timeoutMs) || null; }
function probeIdentity(identity) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) return { status: "unknown", reason: "identity_missing" };
  try { process.kill(identity.pid, 0); } catch (error) {
    if (error.code === "ESRCH") return { status: "dead", reason: "pid_missing", identity_matches: false };
    if (error.code !== "EPERM") return { status: "unknown", reason: "pid_probe_failed" };
  }
  const observed = fingerprint(identity.pid);
  if (!observed) return { status: "unknown", reason: "fingerprint_unavailable" };
  if (!sameProcess(observed, identity)) return { status: "dead", reason: "pid_reused", identity_matches: false };
  return { status: "live", reason: "identity_matches", identity_matches: true };
}
function groupExists(pgid) {
  try { process.kill(-Number(pgid), 0); return true; } catch (error) { return error.code === "EPERM"; }
}
function processBaseline() {
  const baseline = new Map();
  for (const row of processRows()) if (row.identity) baseline.set(row.pid, row.identity);
  return baseline;
}
function sameBaselineProcess(baseline, identity) { return sameProcess(baseline.get(identity.pid), identity); }
function escapedProcessAudit({ baseline, tracked = new Map(), scopeToken, gateIdentity }) {
  const seal = scopeSeal(scopeToken);
  const discover = () => {
    const rows = processRows({ environment: true }), candidates = new Map(), trackedParents = new Set(tracked.keys());
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (!trackedParents.has(row.pid) && trackedParents.has(row.ppid)) { trackedParents.add(row.pid); changed = true; }
    }
    for (const row of rows) {
      if (row.pid === process.pid || row.pid === process.ppid) continue;
      if (row.pgid === gateIdentity.pgid) continue;
      if (!trackedParents.has(row.pid) && !sealed(row.scope, seal)) continue;
      const identity = row.identity;
      if (!identity || sameBaselineProcess(baseline, identity)) continue;
      candidates.set(row.pid, identity);
    }
    return candidates;
  };
  const first = discover(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  const second = discover(); for (const [pid, identity] of first) if (!second.has(pid) && sameProcess(fingerprint(pid), identity)) second.set(pid, identity);
  const detected = [...second.values()];
  // A detected escapee that no longer proves the inherited scope token is reported, never signalled.
  const signal = (identity, name) => { if (!sameBaselineProcess(baseline, identity)) signalScoped(identity, name, seal); };
  for (const identity of detected) signal(identity, "SIGTERM");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  let remaining = detected.filter((identity) => sameProcess(fingerprint(identity.pid), identity));
  for (const identity of remaining) signal(identity, "SIGKILL");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  remaining = detected.filter((identity) => sameProcess(fingerprint(identity.pid), identity));
  return { matched: detected.length, reaped: detected.length - remaining.length, remaining: remaining.length,
    remaining_identities: remaining.map((identity) => exactIdentity(identity)) };
}
function beginProcessScope() {
  const token = crypto.randomBytes(32).toString("hex");
  const capability = Object.freeze({ env: Object.freeze({ [PROCESS_SCOPE_KEY]: token }), seal: scopeSeal(token) });
  issuedProcessScopes.add(capability);
  processScopeStates.set(capability, { baseline: processBaseline(), token });
  return capability;
}
function auditProcessScope(capability) {
  if (!issuedProcessScopes.has(capability)) fail("issued process scope required", "PROCESS_SCOPE_INVALID");
  const state = processScopeStates.get(capability);
  const gateIdentity = fingerprint(process.pid);
  if (!gateIdentity) fail("process scope audit identity unavailable", "HOST_IDENTITY_UNAVAILABLE");
  return escapedProcessAudit({ baseline: state.baseline, scopeToken: state.token, gateIdentity });
}
sandboxInvocation.beginProcessScope = beginProcessScope;
sandboxInvocation.auditProcessScope = auditProcessScope;
sandboxInvocation.privatePathEnvironment = privatePathEnvironment;
sandboxInvocation.bindRegularFile = (filePath, label) => regularFileBinding(filePath, label, { canonical: false });
sandboxInvocation.bindRuntimeFiles = ({ command, env = process.env, runtimeDependencies = { executableParent: null, interpreterParent: null } } = {}) => {
  const prepared = runtimeBindingSet(command, env, runtimeDependencies);
  return Object.freeze({ command: prepared.command, runtime_files: Object.freeze(prepared.runtimeFiles.map((binding) => Object.freeze({ ...binding }))) });
};
sandboxInvocation.verifyRuntimeFiles = ({ command, runtimeFiles, runtimeDependencies = { executableParent: null, interpreterParent: null }, env = process.env, reenumerate = true } = {}) =>
  verifyRuntimeFileBindings({ command, runtimeFiles, runtimeDependencies, environment: env, reenumerate });
sandboxInvocation.readOwnerCredential = (filePath, label) => credentialSource(filePath, label).bytes;
sandboxInvocation.removeBoundDirectory = removeBoundDirectory;
function waitForProcessGroupAbsence(pgid, timeoutMs) { return Boolean(pollUntil(() => !groupExists(pgid), timeoutMs, 10)); }
function reapProcessGroup(pgid, seal) {
  if (!Number.isInteger(pgid) || pgid <= 0 || process.platform === "win32" || !groupExists(pgid)) {
    return { survived_terminal: false, absent: true, unverified: false };
  }
  let survived = false;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    const members = scopedGroupMembers(pgid, seal);
    if (!members.length) break;
    survived = true;
    for (const member of members) signalScoped(member, signal, seal);
    if (waitForProcessGroupAbsence(pgid, 250)) return { survived_terminal: true, absent: true, unverified: false };
  }
  const absent = !groupExists(pgid);
  return { survived_terminal: survived, absent, unverified: !absent && !scopedGroupMembers(pgid, seal).length };
}
sandboxInvocation.reapProcessGroup = reapProcessGroup;
function ownerDirectory(runDir, create = false) {
  const run = canonicalDir(runDir, "runDir"), directory = path.join(run, OWNERSHIP);
  if (create) { try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; } syncDir(run); }
  else if (!fs.existsSync(directory)) return null;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory || (stat.mode & 0o077) !== 0) fail("ownership directory is unsafe", "LOCK_LEDGER_INVALID");
  return directory;
}
function base(generation) { return String(generation).padStart(12, "0"); }
function validateOwner(owner) {
  for (const field of ["lock_id", "secret", "attempt_id", "operation", "host", "host_handle", "acquired_at"]) {
    if (typeof owner?.[field] !== "string" || !owner[field]) fail(`owner ${field} is invalid`, "LOCK_LEDGER_INVALID");
  }
  safeAttempt(owner.attempt_id);
  if (!/^[0-9a-f]{64}$/.test(owner.secret) || !Number.isInteger(owner.generation) || owner.generation < 1) fail("owner secret or generation is invalid", "LOCK_LEDGER_INVALID");
  if (!owner.process || owner.process.pid <= 0 || !owner.process.started_at) fail("owner process identity is invalid", "LOCK_LEDGER_INVALID");
  if (!owner.worktree || typeof owner.worktree.path !== "string" || !Number.isInteger(owner.worktree.dev) || !Number.isInteger(owner.worktree.ino)) fail("owner worktree is invalid", "LOCK_LEDGER_INVALID");
  return owner;
}
function readLedger(runDir, create = false) {
  const directory = ownerDirectory(runDir, create);
  if (!directory) return { directory: path.join(canonicalDir(runDir, "runDir"), OWNERSHIP), entries: [], active: null, next: 1 };
  const entries = fs.readdirSync(directory).filter((name) => OWNER_RE.test(name)).sort().map((name) => {
    const generation = Number(name.match(OWNER_RE)[1]), ownerPath = path.join(directory, name);
    const read = secureRead(ownerPath, "lock owner"), owner = validateOwner(read.value);
    if (owner.generation !== generation) fail("owner generation/path mismatch", "LOCK_LEDGER_INVALID");
    const closedPath = path.join(directory, `${base(generation)}.closed.json`);
    let closed = null;
    if (fs.existsSync(closedPath)) {
      closed = secureRead(closedPath, "lock close").value;
      if (!verifySigned(closed, owner.secret) || closed.generation !== generation || closed.lock_id !== owner.lock_id
        || closed.owner_sha256 !== sha256(read.bytes) || !["released", "broken"].includes(closed.outcome)) fail("lock close is invalid", "LOCK_LEDGER_INVALID");
    }
    return { generation, ownerPath, owner, raw: read.bytes, stat: read.stat, closedPath, closed };
  });
  const active = entries.filter((entry) => !entry.closed);
  if (active.length > 1) fail("multiple unresolved lock generations", "LOCK_LEDGER_INVALID");
  return { directory, entries, active: active[0] || null, next: (entries.at(-1)?.generation || 0) + 1 };
}
function auditFragment(type, owner, outcome) {
  return Object.freeze({ audit_key: sha256(`${type}\0${owner.lock_id}\0${outcome || ""}`), type, attempt_id: owner.attempt_id,
    payload: Object.freeze(type === "lock_acquired" ? { lock_id: owner.lock_id, operation: owner.operation, host: owner.host,
      pid: owner.process.pid, process_started_at: owner.process.started_at } : { lock_id: owner.lock_id, operation: owner.operation, outcome }) });
}
function emitAudit(audit, type, state, outcome) { return typeof audit === "function" ? audit(auditFragment(type, state.owner, outcome), state.capability) : undefined; }
function stateFor(capability) {
  if (!issuedLocks.has(capability) || !lockStates.has(capability)) fail("issued lock capability required", "LOCK_CAPABILITY_INVALID");
  return lockStates.get(capability);
}
function acquireRunLock({ runDir, attemptId, operation, host = os.hostname(), hostHandle, pid = process.pid, worktreeDir = process.cwd(), audit } = {}) {
  const run = canonicalDir(runDir, "runDir"), worktree = canonicalDir(worktreeDir, "worktreeDir"); safeAttempt(attemptId);
  if (typeof operation !== "string" || !operation) fail("operation is required", "INVALID_OPERATION");
  const processIdentity = waitFingerprint(pid);
  if (!processIdentity) fail("stable owner identity unavailable", "HOST_IDENTITY_UNAVAILABLE", { recommended_action: "inspect" });
  const worktreeStat = fs.statSync(worktree);
  let ownerPath, owner;
  while (true) {
    const ledger = readLedger(run, true);
    if (ledger.active) fail("run lock is already held", "LOCK_HELD", { lockPath: ledger.active.ownerPath });
    owner = validateOwner({ v: 2, generation: ledger.next, lock_id: crypto.randomUUID(), secret: crypto.randomBytes(32).toString("hex"),
      attempt_id: attemptId, operation, host, host_handle: hostHandle || `${operation}:${process.pid}:${crypto.randomBytes(6).toString("hex")}`,
      process: processIdentity, acquired_at: new Date().toISOString(), worktree: { path: worktree, dev: worktreeStat.dev, ino: worktreeStat.ino } });
    ownerPath = path.join(ledger.directory, `${base(owner.generation)}.owner.json`);
    if (publishOnce(ownerPath, owner)) break;
  }
  const fd = fs.openSync(ownerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const stat = fs.fstatSync(fd), capability = Object.freeze({ lock_id: owner.lock_id, attempt_id: owner.attempt_id, operation,
    run_dir: run, host_kind: "local_supervisor", host_handle: owner.host_handle });
  const state = { capability, runDir: run, ownerPath, fd, inode: { dev: stat.dev, ino: stat.ino }, owner, released: false };
  issuedLocks.add(capability); lockStates.set(capability, state);
  try { emitAudit(audit, "lock_acquired", state); replayReleaseReceipts(state, audit); }
  catch (cause) {
    const body = { v: 2, generation: owner.generation, lock_id: owner.lock_id, owner_sha256: sha256(fs.readFileSync(ownerPath)),
      outcome: "broken", release_outcome: null, reason: "acquisition_audit_failed", proof: null, closed_at: new Date().toISOString() };
    publishOnce(path.join(path.dirname(ownerPath), `${base(owner.generation)}.closed.json`), signed(body, owner.secret));
    state.released = true; fs.closeSync(fd); fail("lock acquisition audit failed", "LOCK_AUDIT_FAILED", { cause });
  }
  return capability;
}
// A crash between the authoritative close and its release receipt leaves no durable outcome. The next
// lock holder replays every closed generation's canonical outcome; the deterministic audit key makes the
// replay idempotent, so each generation materializes exactly one release outcome.
function replayReleaseReceipts(state, audit) {
  if (typeof audit !== "function") return;
  for (const entry of readLedger(state.runDir).entries) {
    if (!entry.closed || entry.generation >= state.owner.generation) continue;
    audit(auditFragment("lock_released", entry.owner, entry.closed.release_outcome || entry.closed.outcome), state.capability);
  }
}
function targetRun(target) {
  const value = typeof target === "string" ? target : target?.runDir || target?.eventsPath;
  if (typeof value !== "string") fail("lock target is required", "INVALID_LOCK_TARGET");
  return path.basename(value) === "events.jsonl" || (fs.existsSync(value) && fs.statSync(value).isFile()) ? path.dirname(path.resolve(value)) : path.resolve(value);
}
function assertRunLockHeld(capability, target) {
  const state = stateFor(capability);
  if (state.released || targetRun(target) !== state.runDir) fail("lock is not held for this run", state.released ? "LOCK_NOT_HELD" : "LOCK_RUN_MISMATCH");
  let fdStat, pathStat;
  try { fdStat = fs.fstatSync(state.fd); pathStat = fs.lstatSync(state.ownerPath); }
  catch (cause) { fail("lock inode is unavailable", "LOCK_INODE_MISMATCH", { cause }); }
  if (fdStat.dev !== state.inode.dev || fdStat.ino !== state.inode.ino || pathStat.dev !== state.inode.dev || pathStat.ino !== state.inode.ino) fail("lock inode changed", "LOCK_INODE_MISMATCH");
  const observed = secureRead(state.ownerPath, "lock owner").value;
  if (observed.lock_id !== state.owner.lock_id || observed.secret !== state.owner.secret) fail("lock owner changed", "LOCK_TOKEN_MISMATCH");
  const ledger = readLedger(state.runDir);
  if (state.receiptWindow) {
    const entry = ledger.entries.find((item) => item.generation === state.owner.generation);
    if (!entry?.closed || entry.owner.lock_id !== state.owner.lock_id) fail("lock close receipt is unavailable", "LOCK_NOT_HELD");
    if (ledger.next !== state.owner.generation + 1) fail("a newer lock generation owns this run", "LOCK_NOT_HELD");
    return true;
  }
  if (!ledger.active || ledger.active.owner.lock_id !== state.owner.lock_id) fail("lock generation is closed", "LOCK_NOT_HELD");
  return true;
}
// The authoritative signed close is published first; only then is the single release outcome materialized,
// inside a receipt window that stays valid exactly while this generation is the newest one.
function closeState(state, outcome, releaseOutcome, reason, proof, audit) {
  const ownerBytes = fs.readFileSync(state.ownerPath);
  const body = { v: 2, generation: state.owner.generation, lock_id: state.owner.lock_id, owner_sha256: sha256(ownerBytes), outcome,
    release_outcome: releaseOutcome, reason, proof, closed_at: new Date().toISOString() };
  const closedPath = path.join(path.dirname(state.ownerPath), `${base(state.owner.generation)}.closed.json`);
  if (!publishOnce(closedPath, signed(body, state.owner.secret))) {
    const existing = secureRead(closedPath, "lock close").value;
    if (!verifySigned(existing, state.owner.secret) || existing.lock_id !== state.owner.lock_id || existing.outcome !== outcome) fail("conflicting lock close", "LOCK_CHANGED");
  }
  state.receiptWindow = true;
  try { emitAudit(audit, "lock_released", state, releaseOutcome || outcome); }
  finally { state.receiptWindow = false; state.released = true; try { fs.closeSync(state.fd); } catch {}; state.fd = undefined; }
  return { released: true, outcome: releaseOutcome || outcome, markerPath: closedPath };
}
function releaseRunLock(capability, { outcome = "released", audit } = {}) {
  const state = stateFor(capability); if (state.released) return { released: false, reason: "already_released" };
  assertRunLockHeld(capability, state.runDir);
  return closeState(state, "released", outcome, null, null, audit);
}
async function withRunLock(options, callback) {
  const capability = acquireRunLock(options); let outcome = "released";
  try { return await callback(capability); } catch (error) { outcome = "failed"; throw error; }
  finally { releaseRunLock(capability, { outcome, audit: options?.audit }); }
}
function attemptPaths(runDir, attemptId) {
  const run = canonicalDir(runDir, "runDir"), id = safeAttempt(attemptId), child = (name, label) => directChild(run, path.join(run, name), label);
  return { run, config: child(`host-attempt-${id}.config.json`, "config"), supervisor: child(`host-attempt-${id}.supervisor.json`, "supervisor"),
    running: child(`host-attempt-${id}.running.json`, "running"), cleanup: child(`host-attempt-${id}.cleanup-incomplete.json`, "cleanup status"),
    settled: child(`host-attempt-${id}.cleanup-settled.json`, "cleanup settled"),
    cancel: child(`host-attempt-${id}.cancel.json`, "cancel") };
}
function readBoundArtifactEnvelope(filePath, label, owner, expected = {}) {
  const read = secureRead(filePath, label), value = read.value;
  if (!verifySigned(value, owner.secret) || value.lock_id !== owner.lock_id || value.attempt_id !== owner.attempt_id
    || Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)) fail(`${label} is unauthenticated`, "HOST_ARTIFACT_INVALID");
  return { value, sha256: sha256(read.bytes) };
}
function readBoundArtifact(filePath, label, owner, expected = {}) { return readBoundArtifactEnvelope(filePath, label, owner, expected).value; }
function validTerminal(result, owner) {
  return verifySigned(result, owner.secret, "result_auth_sha256") && result.lock_id === owner.lock_id && result.attempt_id === owner.attempt_id
    && result.host_handle === owner.host_handle && result.host_kind === "local_supervisor" && TERMINAL.has(result.status);
}
function probeOwner(owner, runDir) {
  if (owner.host !== os.hostname()) return { status: "unknown", reason: "foreign_host" };
  const paths = attemptPaths(runDir, owner.attempt_id);
  const resultPath = path.join(runDir, `attempt-${owner.attempt_id}.result.json`);
  if (fs.existsSync(resultPath)) {
    try { if (validTerminal(secureRead(resultPath, "terminal result").value, owner)) return { status: "dead", reason: "terminal_result", identity_matches: false }; }
    catch { return { status: "unknown", reason: "terminal_result_invalid" }; }
  }
  if (fs.existsSync(paths.cleanup)) return { status: "unknown", reason: "cleanup_incomplete" };
  if (fs.existsSync(paths.running)) {
    try {
      const running = readBoundArtifact(paths.running, "running identity", owner);
      const supervisor = probeIdentity(running.supervisor), executor = probeIdentity(running.executor);
      if (supervisor.status === "live" || executor.status === "live") return { status: "live", reason: "durable_process_live" };
      if (supervisor.status === "dead" && executor.status === "dead" && !groupExists(running.executor.pgid)) return { status: "dead", reason: "durable_processes_dead", identity_matches: false };
      return { status: "unknown", reason: "durable_process_unknown" };
    } catch { return { status: "unknown", reason: "running_identity_invalid" }; }
  }
  if (fs.existsSync(paths.supervisor)) {
    try { return probeIdentity(readBoundArtifact(paths.supervisor, "supervisor identity", owner).supervisor); }
    catch { return { status: "unknown", reason: "supervisor_identity_invalid" }; }
  }
  if (fs.existsSync(paths.config)) return { status: "unknown", reason: "launch_identity_missing" };
  return probeIdentity(owner.process);
}
function inspectOwnership({ runDir } = {}) {
  const run = canonicalDir(runDir, "runDir"), ledger = readLedger(run);
  if (!ledger.active) return Object.freeze({ status: "absent", lockPath: path.join(ledger.directory, "none.owner.json") });
  const liveness = probeOwner(ledger.active.owner, run);
  const status = liveness.status === "live" ? "live" : liveness.status === "dead" ? "stale" : "unknown";
  const inspection = Object.freeze({ status, reason: liveness.reason, lockPath: ledger.active.ownerPath,
    owner: Object.freeze({ ...ledger.active.owner, secret: undefined }), liveness: Object.freeze(liveness) });
  issuedInspections.add(inspection); inspectionStates.set(inspection, { runDir: run, owner: ledger.active.owner, ownerDigest: sha256(ledger.active.raw) });
  return inspection;
}
function cleanupObligation(value, runDir, owner) {
  const obligation = value?.obligation, reviewerRoot = value?.kind === "reviewer" && typeof obligation?.credential_root?.path === "string"
    && path.dirname(obligation.credential_root.path) === fs.realpathSync("/tmp") && /^relay-review-[A-Za-z0-9_-]+$/.test(path.basename(obligation.credential_root.path));
  const expectedRoots = reviewerRoot ? [obligation.credential_root.path] : [attemptPrivateRoot(runDir, owner, false), attemptPrivateRoot(runDir, owner, true)];
  if (!obligation || !Array.isArray(obligation.processes) || !obligation.credential_root || !expectedRoots.includes(obligation.credential_root.path)
    || !((obligation.credential_root.dev === null && obligation.credential_root.ino === null)
      || (Number.isInteger(obligation.credential_root.dev) && Number.isInteger(obligation.credential_root.ino)))) fail("cleanup obligation is invalid", "HOST_ARTIFACT_INVALID");
  const identities = value.identities, terminal = value.terminal;
  if (!identities || (value.kind !== "reviewer" && !identities.supervisor) || (identities.executor !== null && !identities.executor)) fail("cleanup host identities are invalid", "HOST_ARTIFACT_INVALID");
  if (identities.supervisor) exactIdentity(identities.supervisor, "cleanup supervisor"); if (identities.executor) exactIdentity(identities.executor, "cleanup executor");
  const processes = obligation.processes.map((identity, index) => exactIdentity(identity, `cleanup process ${index}`));
  if (new Set(processes.map((identity) => identity.pid)).size !== processes.length) fail("cleanup process identities are duplicated", "HOST_ARTIFACT_INVALID");
  const seal = obligation.scope_seal ?? null;
  if (seal !== null && !/^[0-9a-f]{64}$/.test(seal)) fail("cleanup process scope seal is invalid", "HOST_ARTIFACT_INVALID");
  if (!terminal || !["completed", "failed", "cancelled", "timed_out", "spawn_error"].includes(terminal.status)
    || (terminal.exit_code !== null && !Number.isInteger(terminal.exit_code)) || (terminal.signal !== null && typeof terminal.signal !== "string")) fail("cleanup terminal context is invalid", "HOST_ARTIFACT_INVALID");
  return { kind: value.kind || "executor", processes, credential_root: { ...obligation.credential_root }, scope_seal: seal, terminal };
}
function identityGone(identity, timeoutMs) {
  return Boolean(pollUntil(() => { const row = probeRow(identity.pid); return !sameProcess(row?.identity, identity) || /^Z/.test(row.identity.state); }, timeoutMs));
}
function reapExactIdentity(identity, seal) {
  for (const [signal, settleMs] of [["SIGTERM", 500], ["SIGKILL", 1_000]]) {
    if (identityGone(identity, 0)) return;
    const sent = signalScoped(identity, signal, seal);
    if (!sent.verified && !sent.absent) {
      fail(
        "cleanup process is still live but its inherited Relay scope cannot be proven; Relay did not signal it",
        "HOST_CLEANUP_EXTERNAL_ACTION_REQUIRED",
        {
          recommended_action: "terminate_exact_process_externally_then_retry",
          process_identity: { ...identity },
          relay_signalled: false,
        },
      );
    }
    if (identityGone(identity, settleMs)) return;
  }
  fail("exact cleanup process survived recovery", "HOST_CLEANUP_INCOMPLETE", { recommended_action: "inspect" });
}
function reapSealedScope(seal) {
  if (!seal) return;
  const discover = () => processRows({ environment: true }).filter((row) => row.identity && sealed(row.scope, seal)).map((row) => row.identity);
  for (let round = 0; round < 2; round += 1) {
    for (const identity of discover()) reapExactIdentity(identity, seal); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (discover().length) fail("sealed cleanup process scope survived recovery", "HOST_CLEANUP_INCOMPLETE", { recommended_action: "inspect" });
}
// Resume a quarantine left behind when a previous removal failed and could not be rolled back. Only a
// sibling whose lstat still equals the signed dev/ino is provably the bound directory, so identity, not
// pathname, decides. Returning false means the directory is genuinely gone.
function quarantineSiblings(target, expected) {
  const parent = path.dirname(target), prefix = `.${path.basename(target)}.quarantine.`;
  let entries;
  try { entries = fs.readdirSync(parent); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return entries.filter((entry) => entry.startsWith(prefix)).map((entry) => path.join(parent, entry)).filter((candidate) => {
    let stat; try { stat = fs.lstatSync(candidate); } catch { return false; }
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino;
  });
}
function reclaimQuarantined(target, expected, label, { fault } = {}) {
  const found = quarantineSiblings(target, expected);
  if (!found.length) return false;
  if (found.length > 1) fail(`${label} has multiple quarantined candidates; evidence retained`, "HOST_CLEANUP_INCOMPLETE",
    { recommended_action: "inspect", quarantinePath: found[0] });
  // Removing the candidate by pathname would be racy: a rename between the identity check above and the
  // delete would redirect it. Re-enter the swap-safe primitive instead, which renames the tree to a fresh
  // private quarantine and re-verifies the signed identity on that name before removing anything.
  // `reclaim: false` bounds the re-entry, so a vanished candidate reports genuine absence.
  return removeBoundDirectory(found[0], expected, label, { fault, reclaim: false });
}
// Swap-safe removal: rename the bound directory to a unique sibling quarantine first, then re-verify the
// signed dev/ino on the quarantine target. A mismatch means the path was swapped, so the swapped tree is
// preserved as evidence at its quarantine path and never deleted.
function removeBoundDirectory(target, expected, label, { fault, reclaim = true } = {}) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    // An absent pathname is only proof of cleanup when no quarantine still holds the signed identity.
    // A prior attempt may have renamed the bound directory aside and then failed to remove or roll it
    // back, so resume on the quarantine rather than reading ENOENT as success and orphaning it.
    if (error.code === "ENOENT") return reclaim && expected ? reclaimQuarantined(target, expected, label, { fault }) : false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is not a real directory`, "HOST_CLEANUP_INCOMPLETE", { recommended_action: "inspect" });
  const binding = expected || { dev: stat.dev, ino: stat.ino };
  if (stat.dev !== binding.dev || stat.ino !== binding.ino) fail(`${label} identity changed before cleanup`, "HOST_CLEANUP_INCOMPLETE", { recommended_action: "inspect" });
  const quarantine = path.join(path.dirname(target), `.${path.basename(target)}.quarantine.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  fs.renameSync(target, quarantine);
  const moved = fs.lstatSync(quarantine);
  if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== binding.dev || moved.ino !== binding.ino) {
    fail(`${label} was replaced before quarantined removal`, "HOST_CLEANUP_INCOMPLETE", { recommended_action: "inspect", quarantinePath: quarantine });
  }
  try { fault?.("after_quarantine"); fs.rmSync(quarantine, { recursive: true, force: true }); }
  catch (cause) {
    try {
      const retained = fs.lstatSync(quarantine);
      if (!retained.isDirectory() || retained.isSymbolicLink() || retained.dev !== binding.dev || retained.ino !== binding.ino || fs.existsSync(target)) throw new Error("quarantine identity or original pathname changed before rollback");
      fs.renameSync(quarantine, target);
      const restored = fs.lstatSync(target);
      if (!restored.isDirectory() || restored.isSymbolicLink() || restored.dev !== binding.dev || restored.ino !== binding.ino) throw new Error("rolled-back directory identity changed");
      syncDir(path.dirname(target));
    } catch (rollbackCause) { fail(`${label} quarantined removal and rollback failed; evidence retained`, "HOST_CLEANUP_INCOMPLETE",
      { recommended_action: "inspect", quarantinePath: quarantine, cause, rollbackCause }); }
    fail(`${label} quarantined removal failed and was rolled back`, "HOST_CLEANUP_INCOMPLETE", { recommended_action: "inspect", cause });
  }
  syncDir(path.dirname(target)); return true;
}
function removeExactCredentialRoot(root, runDir, owner, fault) {
  const target = root.path, reviewerRoot = path.dirname(target) === fs.realpathSync("/tmp") && /^relay-review-[A-Za-z0-9_-]+$/.test(path.basename(target));
  if (![attemptPrivateRoot(runDir, owner, false), attemptPrivateRoot(runDir, owner, true)].includes(target) && !reviewerRoot) fail("cleanup credential root is outside the attempt boundary", "HOST_ARTIFACT_INVALID");
  if (root.dev === null) {
    if (fs.existsSync(target)) fail("credential root identity changed before recovery", "HOST_CLEANUP_INCOMPLETE", { recommended_action: "inspect" });
    return;
  }
  const binding = { dev: root.dev, ino: root.ino };
  removeBoundDirectory(target, binding, "cleanup credential root",
    { fault: fault ? (stage) => fault(`credential_${stage}`) : null });
  // Removal unlinks a pathname, so a rename racing the delete could leave the bound tree alive under a
  // quarantine name while the delete still reported success. Settling is only honest if nothing carrying
  // the signed identity survives, so re-scan and fail closed instead of trusting the delete's return.
  const surviving = quarantineSiblings(target, binding);
  if (surviving.length) fail("cleanup credential root survived removal under a quarantine name", "HOST_CLEANUP_INCOMPLETE",
    { recommended_action: "inspect", quarantinePath: surviving[0] });
}
function settleCleanup({ state, cleanupPath, fault, terminalStatus = "failed" }) {
  const read = secureRead(cleanupPath, "cleanup-incomplete status"), owner = state.owner;
  if (!verifySigned(read.value, owner.secret) || read.value.lock_id !== owner.lock_id || read.value.attempt_id !== owner.attempt_id
    || read.value.host_handle !== owner.host_handle) fail("cleanup status is unauthenticated", "HOST_ARTIFACT_INVALID");
  const obligation = cleanupObligation(read.value, state.runDir, owner), paths = attemptPaths(state.runDir, owner.attempt_id);
  for (const identity of obligation.processes) reapExactIdentity(identity, obligation.scope_seal);
  if (obligation.kind === "reviewer") reapSealedScope(obligation.scope_seal);
  removeExactCredentialRoot(obligation.credential_root, state.runDir, owner, fault); fault?.("after_cleanup");
  const settledBody = { v: 2, attempt_id: owner.attempt_id, lock_id: owner.lock_id, host_handle: owner.host_handle,
    cleanup_sha256: sha256(read.bytes), settled_at: new Date().toISOString() };
  if (!publishOnce(paths.settled, signed(settledBody, owner.secret))) readBoundArtifact(paths.settled, "cleanup settled", owner, { cleanup_sha256: settledBody.cleanup_sha256 });
  fault?.("after_settled");
  const resultPath = path.join(state.runDir, `attempt-${owner.attempt_id}.result.json`), body = {
    attempt_id: owner.attempt_id, lock_id: owner.lock_id, host_kind: "local_supervisor", host_handle: owner.host_handle,
    status: terminalStatus, exit_code: obligation.terminal.exit_code, signal: obligation.terminal.signal,
    error: terminalStatus === "completed" ? null : `cleanup recovered after incomplete host settlement: ${read.value.error}`, completed_at: new Date().toISOString(),
  };
  if (!publishOnce(resultPath, signed(body, owner.secret, "result_auth_sha256"))
    && !validTerminal(secureRead(resultPath, "terminal result").value, owner)) fail("terminal result conflicts with cleanup recovery", "HOST_ARTIFACT_INVALID");
  fault?.("after_terminal"); return resultPath;
}
function retainReviewerCleanup(capability, { root, binding, scopeSeal } = {}) {
  const state = stateFor(capability); assertRunLockHeld(capability, state.runDir);
  const paths = attemptPaths(state.runDir, state.owner.attempt_id), body = { v: 2, kind: "reviewer", attempt_id: state.owner.attempt_id,
    lock_id: state.owner.lock_id, host_handle: state.owner.host_handle, identities: { supervisor: null, executor: null }, error: "reviewer cleanup pending",
    terminal: { status: "failed", exit_code: null, signal: null }, obligation: { processes: [],
      credential_root: { path: root, dev: binding.dev, ino: binding.ino }, scope_seal: scopeSeal }, observed_at: new Date().toISOString() };
  if (!publishOnce(paths.cleanup, signed(body, state.owner.secret))) readBoundArtifact(paths.cleanup, "cleanup-incomplete status", state.owner);
  return Object.freeze({ path: paths.cleanup, complete(terminalStatus) {
    const resultPath = settleCleanup({ state, cleanupPath: paths.cleanup, terminalStatus });
    releaseRunLock(capability, { outcome: terminalStatus === "completed" ? "review_finished" : "review_failed" }); return resultPath;
  } });
}
async function breakStaleRunLock({ inspection, reason, resultPath, audit, fault } = {}) {
  if (!issuedInspections.has(inspection) || typeof reason !== "string" || !reason.trim()) fail("issued inspection and reason required", "INSPECTION_CAPABILITY_INVALID");
  const observedState = inspectionStates.get(inspection); let proof;
  const cleanupPath = attemptPaths(observedState.runDir, observedState.owner.attempt_id).cleanup;
  if (!resultPath && fs.existsSync(cleanupPath)) {
    const ledger = readLedger(observedState.runDir), active = ledger.active;
    if (!active || sha256(active.raw) !== observedState.ownerDigest) fail("owner changed after inspection", "LOCK_CHANGED");
    resultPath = settleCleanup({ state: { runDir: observedState.runDir, owner: active.owner }, cleanupPath, fault });
  }
  if (resultPath && fs.existsSync(resultPath)) {
    const safe = directChild(observedState.runDir, resultPath, "terminal result", { exists: true });
    const read = secureRead(safe, "terminal result");
    if (!validTerminal(read.value, observedState.owner)) fail("terminal result is unauthenticated", "BREAK_EVIDENCE_INSUFFICIENT");
    proof = { kind: "terminal_result", result_sha256: sha256(read.bytes) };
  } else {
    if (inspection.status !== "stale") fail("unknown owner requires terminal proof", "BREAK_EVIDENCE_INSUFFICIENT");
    const first = probeOwner(observedState.owner, observedState.runDir);
    if (first.status !== "dead" || first.identity_matches !== false) fail("first liveness probe is not dead", "BREAK_EVIDENCE_INSUFFICIENT");
    await new Promise((resolve) => setTimeout(resolve, BREAK_PROBE_MS));
    const second = probeOwner(observedState.owner, observedState.runDir);
    if (second.status !== "dead" || second.identity_matches !== false) fail("second liveness probe is not dead", "BREAK_EVIDENCE_INSUFFICIENT");
    proof = { kind: "two_dead_probes", first_at: new Date(Date.now() - BREAK_PROBE_MS).toISOString(), second_at: new Date().toISOString() };
  }
  const ledger = readLedger(observedState.runDir), active = ledger.active;
  if (!active || sha256(active.raw) !== observedState.ownerDigest) fail("owner changed after inspection", "LOCK_CHANGED");
  const fd = fs.openSync(active.ownerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), stat = fs.fstatSync(fd);
  const capability = Object.freeze({ lock_id: active.owner.lock_id, attempt_id: active.owner.attempt_id, operation: active.owner.operation,
    run_dir: observedState.runDir, host_kind: "local_supervisor", host_handle: active.owner.host_handle });
  const state = { capability, runDir: observedState.runDir, ownerPath: active.ownerPath, fd, inode: { dev: stat.dev, ino: stat.ino }, owner: active.owner, released: false };
  issuedLocks.add(capability); lockStates.set(capability, state);
  try { assertRunLockHeld(capability, state.runDir); return closeState(state, "broken", null, reason, proof, audit); }
  catch (error) { try { fs.closeSync(fd); } catch {}; throw error; }
}
function waitForStartup({ child, paths, owner, configSha, timeoutMs }) {
  const end = Date.now() + timeoutMs, waiter = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < end) {
    const resultPath = path.join(paths.run, `attempt-${owner.attempt_id}.result.json`);
    if (fs.existsSync(resultPath)) {
      const result = secureRead(resultPath, "startup result").value;
      if (!validTerminal(result, owner)) fail("startup result is invalid", "HOST_START_FAILED");
      return { terminal: true, started_at: result.completed_at };
    }
    if (fs.existsSync(paths.running)) {
      const running = readBoundArtifact(paths.running, "running identity", owner, { config_sha256: configSha });
      if (running.supervisor.pid !== child.pid || !sameProcess(fingerprint(child.pid), running.supervisor)) fail("supervisor identity changed", "HOST_START_FAILED");
      return { terminal: false, started_at: running.started_at };
    }
    if (fs.existsSync(paths.supervisor)) readBoundArtifact(paths.supervisor, "supervisor identity", owner, { config_sha256: configSha });
    try { process.kill(child.pid, 0); } catch (error) { if (error.code === "ESRCH") fail("supervisor exited before running", "HOST_START_FAILED", { recommended_action: "inspect" }); }
    Atomics.wait(waiter, 0, 0, 10);
  }
  fail("supervisor startup timed out", "HOST_START_FAILED", { recommended_action: "inspect" });
}
function launchLocalSupervisor({ runDir, attemptId, command, args = [], trustedWorktreeRoot, cwd, stdoutPath, stderrPath, resultPath,
  inputFiles = [], stdinPath = null, stdinSha256 = null, executorResultPath = null, executorSandbox = "workspace-write", executorNetworkAccess = "disabled", timeoutMs = 30_000,
  cancelGraceMs = 1_000, supervisorStartupTimeoutMs = 30_000, executorEnv = {}, ephemeralEnv = {}, credentialRequest = null, processContainment = PROCESS_CONTRACT,
  runtimeDependencies = { executableParent: null, interpreterParent: null }, privateEnvPaths = [], testCredentialPrepared = null, testCleanupFailurePath = null, testGateBarrierPath = null, lockContext } = {}) {
  if (lockContext === undefined) fail("production launch requires a lock capability", "HOST_LOCK_REQUIRED");
  const state = stateFor(lockContext), run = canonicalDir(runDir, "runDir"); assertRunLockHeld(lockContext, run);
  if (attemptId !== state.owner.attempt_id) fail("attempt does not match lock", "HOST_LOCK_IDENTITY_MISMATCH"); safeAttempt(attemptId);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) fail("args must be string argv", "INVALID_INVOCATION");
  if (processContainment !== PROCESS_CONTRACT) fail(`executor must honor ${PROCESS_CONTRACT}`, "INVALID_INVOCATION");
  const worktree = canonicalDir(trustedWorktreeRoot || state.owner.worktree.path, "trustedWorktreeRoot"), stat = fs.statSync(worktree);
  if (worktree !== state.owner.worktree.path || stat.dev !== state.owner.worktree.dev || stat.ino !== state.owner.worktree.ino
    || canonicalDir(cwd || worktree, "cwd") !== worktree) fail("worktree does not match lock", "HOST_LOCK_IDENTITY_MISMATCH");
  if (!["workspace-write", "read-only"].includes(executorSandbox) || !["enabled", "disabled"].includes(executorNetworkAccess)) fail("sandbox options are invalid", "INVALID_INVOCATION");
  if (!Array.isArray(inputFiles)) fail("inputFiles must be an array", "INVALID_INVOCATION");
  if (Boolean(stdinPath) !== Boolean(stdinSha256) || (stdinSha256 && !/^[0-9a-f]{64}$/.test(stdinSha256))) fail("stdinPath and stdinSha256 must form an exact binding", "INVALID_INVOCATION");
  const declaredInputs = [...new Set([...inputFiles, ...(stdinPath ? [stdinPath] : [])])];
  const inputSources = declaredInputs.map((file) => directChild(run, file, "executor input", { exists: true }));
  const explicitEnvironment = environmentEntries(executorEnv, "executorEnv"), ephemeralEnvironment = environmentEntries(ephemeralEnv, "ephemeralEnv");
  const privatePaths = normalizedPrivatePaths(privateEnvPaths);
  if (Object.hasOwn(explicitEnvironment, PROCESS_SCOPE_KEY) || Object.hasOwn(ephemeralEnvironment, PROCESS_SCOPE_KEY)) fail(`${PROCESS_SCOPE_KEY} is host-reserved`, "INVALID_INVOCATION");
  ephemeralEnvironment[PROCESS_SCOPE_KEY] = crypto.randomBytes(32).toString("hex");
  if (Object.keys(ephemeralEnvironment).some((key) => Object.hasOwn(explicitEnvironment, key))) fail("ephemeralEnv keys must be distinct", "INVALID_INVOCATION");
  if ((testGateBarrierPath || testCredentialPrepared || testCleanupFailurePath) && !process.env.NODE_TEST_CONTEXT) fail("test host seam is unavailable", "INVALID_INVOCATION");
  if (testCredentialPrepared !== null && typeof testCredentialPrepared !== "function") fail("test credential seam is invalid", "INVALID_INVOCATION");
  const gateBarrier = testGateBarrierPath ? directChild(run, testGateBarrierPath, "test gate barrier") : null;
  const cleanupFailure = testCleanupFailurePath ? directChild(run, testCleanupFailurePath, "test cleanup failure", { exists: true }) : null;
  const runtime = sandboxInvocation.bindRuntimeFiles({ command, env: process.env, runtimeDependencies });
  const paths = attemptPaths(run, attemptId), stdout = directChild(run, stdoutPath || path.join(run, `attempt-${attemptId}.stdout.log`), "stdout"),
    stderr = directChild(run, stderrPath || path.join(run, `attempt-${attemptId}.stderr.log`), "stderr"),
    result = directChild(run, resultPath || path.join(run, `attempt-${attemptId}.result.json`), "result"),
    executorResult = executorResultPath ? directChild(run, executorResultPath, "executor result") : null,
    tmp = directChild(run, path.join(run, `executor-tmp-${attemptId}`), "executor tmp", { directory: true }),
    credentialRoot = directChild(path.dirname(attemptPrivateRoot(run, state.owner, privatePaths.some((item) => item.root === "scratch"))), attemptPrivateRoot(run, state.owner, privatePaths.some((item) => item.root === "scratch")), "executor private root", { directory: true });
  const preparedCredentials = credentialRequest ? prepareCredentialBundle(credentialRequest) : null;
  if (testCredentialPrepared) testCredentialPrepared();
  const credentials = credentialState(preparedCredentials);
  if (privatePaths.some((item) => Object.hasOwn(explicitEnvironment, item.key) || Object.hasOwn(ephemeralEnvironment, item.key) || credentials.envNames.includes(item.key))) fail("private environment path collides with caller environment", "INVALID_INVOCATION");
  const inputStages = inputSources.map((unused, index) => directChild(run, path.join(run, `host-input-${attemptId}-${index}.bin`), "staged executor input"));
  for (const target of [paths.config, paths.supervisor, paths.running, paths.cleanup, paths.settled, paths.cancel, stdout, stderr, result, executorResult, credentialRoot, ...inputStages].filter(Boolean)) {
    if (fs.existsSync(target)) fail("attempt artifact already exists", "HOST_ATTEMPT_ALREADY_LAUNCHED", { artifactPath: target, recommended_action: "inspect" });
  }
  fs.mkdirSync(tmp, { mode: 0o700 });
  const inputBindings = inputSources.map((source, index) => {
    const sourceBinding = regularFileBinding(source, "executor input");
    if (!publishOnce(inputStages[index], sourceBinding.bytes)) fail("staged executor input already exists", "HOST_ATTEMPT_ALREADY_LAUNCHED");
    const { bytes, ...binding } = regularFileBinding(inputStages[index], "staged executor input");
    return binding;
  });
  const stdinSource = stdinPath ? directChild(run, stdinPath, "executor stdin", { exists: true }) : null;
  const stdinIndex = stdinSource ? inputSources.indexOf(stdinSource) : -1;
  if (stdinSource && stdinIndex < 0) fail("stdin source is not a declared executor input", "INVALID_INVOCATION");
  if (stdinIndex >= 0 && inputBindings[stdinIndex].sha256 !== stdinSha256) fail("stdin bytes do not match invocation binding", "HOST_INPUT_CHANGED");
  const replacements = new Map(inputSources.map((source, index) => [source, inputStages[index]]));
  const stagedArgs = args.map((argument) => {
    if (replacements.has(argument)) return replacements.get(argument);
    if (argument.startsWith("@") && replacements.has(argument.slice(1))) return `@${replacements.get(argument.slice(1))}`;
    return argument;
  });
  const executorEnvironment = { ...minimalEnvironment(process.env), ...explicitEnvironment, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  const secretPayload = Buffer.from(JSON.stringify({ owner_secret: state.owner.secret, ephemeral_env: ephemeralEnvironment, credential_env: credentials.values,
    credential_files: credentials.files.map((item) => ({ id: item.id, bytes: item.source.bytes.toString("base64") })) }), "utf8");
  for (const item of credentials.files) item.source.bytes.fill(0);
  for (const key of Object.keys(credentials.values)) { credentials.values[key] = ""; delete credentials.values[key]; }
  if (secretPayload.length > 8 * 1024 * 1024) { secretPayload.fill(0); fail("ephemeral credential payload is too large", "INVALID_INVOCATION"); }
  const config = { v: 2, attempt_id: attemptId, lock_id: state.owner.lock_id, host_kind: "local_supervisor", host_handle: state.owner.host_handle,
    nonce: crypto.randomBytes(32).toString("hex"), command: runtime.command, args: stagedArgs, process_contract: processContainment, input_files: inputBindings,
    stdin_binding: stdinIndex < 0 ? null : { index: stdinIndex, size: inputBindings[stdinIndex].size, sha256: stdinSha256 }, env: executorEnvironment,
    ephemeral_env_keys: Object.keys(ephemeralEnvironment), credential_env_keys: credentials.envNames, credentials: credentials.publicFiles, credential_root: credentialRoot, private_env_paths: privatePaths,
    scope_seal: scopeSeal(ephemeralEnvironment[PROCESS_SCOPE_KEY]),
    worktree, cwd: worktree, stdout, stderr, result, executor_result: executorResult,
    tmp, sandbox: executorSandbox, network: "enabled", tool_network: executorNetworkAccess, runtime_dependencies: runtimeDependencies, runtime_files: runtime.runtime_files, timeout_ms: timeoutMs, grace_ms: cancelGraceMs,
    supervisor: paths.supervisor, running: paths.running, cleanup: paths.cleanup, cancel: paths.cancel, ownership: path.dirname(state.ownerPath), test_gate_barrier: gateBarrier, test_cleanup_failure: cleanupFailure };
  if (!publishOnce(paths.config, config)) fail("attempt has already been launched", "HOST_ATTEMPT_ALREADY_LAUNCHED");
  const configSha = sha256(fs.readFileSync(paths.config)), stdoutFd = fs.openSync(stdout, "wx", 0o600), stderrFd = fs.openSync(stderr, "wx", 0o600);
  const secretPath = path.join(run, `.host-secret-${attemptId}-${crypto.randomBytes(8).toString("hex")}`), secretFd = fs.openSync(secretPath, "wx+", 0o600);
  let child;
  try {
    fs.writeFileSync(secretFd, secretPayload); fs.fsyncSync(secretFd); fs.unlinkSync(secretPath); syncDir(run);
    child = spawn(process.execPath, [__filename, "--supervise", paths.config, configSha], { cwd: run, detached: true,
      env: { ...minimalEnvironment(process.env), [PROCESS_SCOPE_KEY]: ephemeralEnvironment[PROCESS_SCOPE_KEY] },
      stdio: ["ignore", "ignore", stderrFd, secretFd, stdoutFd, stderrFd] });
  } finally {
    secretPayload.fill(0); try { fs.unlinkSync(secretPath); } catch {}
    fs.closeSync(secretFd); fs.closeSync(stdoutFd); fs.closeSync(stderrFd);
  }
  child.unref();
  let started;
  try { started = waitForStartup({ child, paths, owner: state.owner, configSha, timeoutMs: supervisorStartupTimeoutMs }); }
  catch (error) {
    try { atomicWrite(paths.cancel, `${JSON.stringify({ reason: "startup_failed", requested_at: new Date().toISOString() })}\n`); } catch {}
    const observed = fingerprint(child.pid);
    if (observed) for (const signal of ["SIGTERM", "SIGKILL"]) signalScopedGroup(observed, signal, config.scope_seal);
    throw error;
  }
  const receipt = Object.freeze({ attempt_id: attemptId, lock_id: state.owner.lock_id, host_kind: "local_supervisor", host_handle: state.owner.host_handle,
    started_at: started.started_at, timeout_ms: timeoutMs, stdout_path: stdout, stderr_path: stderr, result_path: result, cancel_path: paths.cancel, run_dir: run,
    runtime_files: runtime.runtime_files });
  issuedReceipts.add(receipt); receiptStates.set(receipt, { owner: state.owner, paths }); return receipt;
}
function cancelHost(receipt, { reason = "operator_cancelled" } = {}) {
  if (!issuedReceipts.has(receipt)) fail("issued receipt required", "HOST_RECEIPT_INVALID");
  const { paths } = receiptStates.get(receipt);
  if (!fs.existsSync(paths.cancel)) atomicWrite(paths.cancel, `${JSON.stringify({ attempt_id: receipt.attempt_id, lock_id: receipt.lock_id, reason, requested_at: new Date().toISOString() })}\n`);
  return { requested: true, cancel_path: paths.cancel };
}
async function waitForTerminalResult(receipt, { timeoutMs = receipt.timeout_ms + 10_000 } = {}) {
  if (!issuedReceipts.has(receipt)) fail("issued receipt required", "HOST_RECEIPT_INVALID");
  const owner = receiptStates.get(receipt).owner, end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(receipt.result_path)) {
      const result = secureRead(receipt.result_path, "terminal result").value;
      if (!validTerminal(result, owner)) fail("terminal result does not match receipt", "HOST_RESULT_MISMATCH");
      return result;
    }
    const cleanupPath = receiptStates.get(receipt).paths.cleanup;
    if (fs.existsSync(cleanupPath)) {
      const cleanup = readBoundArtifactEnvelope(cleanupPath, "cleanup-incomplete status", owner);
      fail("executor cleanup is incomplete; no terminal result was published", "HOST_CLEANUP_INCOMPLETE", { cleanup_sha256: cleanup.sha256, recommended_action: "inspect" });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fail("timed out waiting for terminal result", "HOST_RESULT_TIMEOUT");
}

function stageCredentials(config, secretFiles, state = {}) {
  const root = directChild(path.dirname(config.credential_root), config.credential_root, "executor credential root", { directory: true });
  fs.mkdirSync(root, { mode: 0o700 }); fs.chmodSync(root, 0o700); const rootStat = fs.lstatSync(root);
  Object.assign(state, { root, binding: { dev: rootStat.dev, ino: rootStat.ino } });
  const roots = { home: path.join(root, "home"), xdg_config: path.join(root, "xdg-config"), xdg_data: path.join(root, "xdg-data"), scratch: path.join(root, "scratch") };
  for (const value of Object.values(roots)) fs.mkdirSync(value, { mode: 0o700 });
  const readable = [], writable = [], readonly = [], secrets = new Map((secretFiles || []).map((item) => [item.id, item.bytes]));
  for (const item of config.credentials || []) {
    if (!/^[a-z][a-z0-9_-]*$/.test(item.id || "") || !Object.hasOwn(roots, item.targetRoot) || !["read", "read_write"].includes(item.access)
      || typeof item.targetRel !== "string" || path.isAbsolute(item.targetRel) || item.targetRel.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) fail("credential target is invalid", "HOST_CONFIG_MISMATCH");
    const encoded = secrets.get(item.id); if (typeof encoded !== "string") fail("credential bytes are unavailable", "HOST_CONFIG_MISMATCH");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== item.size || sha256(bytes) !== item.sha) { bytes.fill(0); fail("credential bytes do not match binding", "HOST_CONFIG_MISMATCH"); }
    const target = path.join(roots[item.targetRoot], item.targetRel), relative = path.relative(roots[item.targetRoot], target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) { bytes.fill(0); fail("credential target escapes root", "HOST_CONFIG_MISMATCH"); }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    for (let parent = path.dirname(target); parent.startsWith(root) && parent !== root; parent = path.dirname(parent)) fs.chmodSync(parent, 0o700);
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 }); fs.chmodSync(target, 0o600); bytes.fill(0); readable.push(target);
    if (item.access === "read_write") writable.push(target); else readonly.push(target);
  }
  if (secrets.size !== (config.credentials || []).length) fail("credential descriptors do not match payload", "HOST_CONFIG_MISMATCH");
  return Object.assign(state, { roots, readable, writable, readonly });
}
function credentialRootBinding(root, binding = null) { return { path: path.resolve(root), dev: binding?.dev ?? null, ino: binding?.ino ?? null }; }
function cleanupCredentialRoot(root, config, binding = null) {
  if (config.test_cleanup_failure && fs.existsSync(config.test_cleanup_failure)) fail("injected cleanup failure", "TEST_CLEANUP_FAILURE");
  if (!binding) { if (fs.existsSync(root)) fail("credential root binding is unavailable", "HOST_CLEANUP_INCOMPLETE"); return false; }
  removeBoundDirectory(path.resolve(root), binding, "executor credential root");
}

function runExecutorGate(configPath, configSha) {
  const bytes = fs.readFileSync(configPath); if (sha256(bytes) !== configSha) fail("gate config mismatch", "HOST_CONFIG_MISMATCH");
  const config = JSON.parse(bytes), release = Buffer.alloc(1), hold = () => {}, ephemeralBytes = fs.readFileSync(5);
  if (config.process_contract !== PROCESS_CONTRACT) fail("executor process containment contract is invalid", "HOST_CONFIG_MISMATCH");
  if (ephemeralBytes.length > 8 * 1024 * 1024) fail("ephemeral environment payload is invalid", "HOST_CONFIG_MISMATCH");
  let gateSecrets, ephemeralEnvironment, credentialEnvironment, stagedCredentials = null;
  try { gateSecrets = JSON.parse(ephemeralBytes.toString("utf8")); ephemeralEnvironment = environmentEntries(gateSecrets.ephemeral_env, "ephemeral environment");
    credentialEnvironment = environmentEntries(gateSecrets.credential_env, "credential environment"); } finally { ephemeralBytes.fill(0); }
  process.on("SIGTERM", hold); process.on("SIGINT", hold);
  if (fs.readSync(3, release, 0, 1, null) !== 1 || release[0] !== 1) return;
  let settled = false;
  const publish = (fields) => { if (settled) return; settled = true; fs.writeSync(4, `${JSON.stringify({ attempt_id: config.attempt_id, ...fields })}\n`); };
  try {
    const verifyInputs = () => config.input_files.map((binding, index) => verifyFileBinding(binding, `staged executor input ${index}`));
    const inputPaths = verifyInputs();
    let stdinBytes = null;
    if (config.stdin_binding) {
      const binding = config.input_files[config.stdin_binding.index];
      if (!binding || binding.size !== config.stdin_binding.size || binding.sha256 !== config.stdin_binding.sha256) fail("executor stdin binding is invalid", "HOST_CONFIG_MISMATCH");
      stdinBytes = regularFileBinding(inputPaths[config.stdin_binding.index], "executor stdin").bytes;
    }
    const runtimeEnvironment = environmentEntries(config.env, "config env");
    if (!Array.isArray(config.ephemeral_env_keys) || config.ephemeral_env_keys.length !== Object.keys(ephemeralEnvironment).length) fail("ephemeral environment keys are invalid", "HOST_CONFIG_MISMATCH");
    for (const key of config.ephemeral_env_keys) {
      if (!Object.hasOwn(ephemeralEnvironment, key)) fail("ephemeral environment is unavailable", "HOST_CONFIG_MISMATCH");
      runtimeEnvironment[key] = ephemeralEnvironment[key];
    }
    if (!Array.isArray(config.credential_env_keys) || config.credential_env_keys.length !== Object.keys(credentialEnvironment).length
      || config.credential_env_keys.some((key) => !Object.hasOwn(credentialEnvironment, key))) fail("credential environment binding is invalid", "HOST_CONFIG_MISMATCH");
    Object.assign(runtimeEnvironment, credentialEnvironment);
    stagedCredentials = { root: config.credential_root };
    stageCredentials(config, gateSecrets.credential_files, stagedCredentials);
    Object.assign(runtimeEnvironment, privatePathEnvironment(config.private_env_paths, stagedCredentials.roots, runtimeEnvironment, "HOST_CONFIG_MISMATCH"));
    runtimeEnvironment.HOME = stagedCredentials.roots.home; runtimeEnvironment.XDG_CONFIG_HOME = stagedCredentials.roots.xdg_config; runtimeEnvironment.XDG_DATA_HOME = stagedCredentials.roots.xdg_data;
    const privateRoots = Object.values(stagedCredentials.roots), writes = [config.tmp, ...privateRoots, ...(config.sandbox === "workspace-write" ? [config.worktree] : [])];
    const invocation = sandboxInvocation({ role: "executor", command: config.command, args: config.args, readRoots: [config.worktree, ...privateRoots],
      readFiles: [...inputPaths, ...stagedCredentials.readable], writeRoots: writes, writeFiles: [...(config.executor_result ? [config.executor_result] : []), ...stagedCredentials.writable],
      denyWriteFiles: stagedCredentials.readonly, runtimeDependencies: config.runtime_dependencies, networkAccess: config.network, ownershipDir: config.ownership,
      env: runtimeEnvironment });
    // `sandboxInvocation` resolves Mach-O and support paths for its profile.
    // Verify immediately before pathname spawn, then again after it exits.
    // The two observations deliberately do not claim an atomic exec/dyld byte
    // pin; any observed closure mutation makes the terminal non-successful.
    sandboxInvocation.verifyRuntimeFiles({ command: config.command, runtimeFiles: config.runtime_files, runtimeDependencies: config.runtime_dependencies, env: runtimeEnvironment });
    const baseline = processBaseline(), tracked = new Map(), gateIdentity = fingerprint(process.pid);
    if (!gateIdentity) fail("executor gate identity unavailable", "HOST_IDENTITY_UNAVAILABLE");
    const scopeToken = runtimeEnvironment[PROCESS_SCOPE_KEY];
    if (!/^[0-9a-f]{64}$/.test(scopeToken || "") || scopeSeal(scopeToken) !== config.scope_seal) fail("executor process scope is unavailable", "HOST_CONFIG_MISMATCH");
    const worker = spawn(invocation.command, invocation.args, { cwd: config.cwd, env: invocation.env, stdio: [stdinBytes ? "pipe" : "ignore", "inherit", "inherit"] });
    try { verifyInputs(); }
    catch (error) { try { worker.kill("SIGKILL"); } catch {}; if (stdinBytes) stdinBytes.fill(0); throw error; }
    if (stdinBytes) worker.stdin.end(stdinBytes, () => stdinBytes.fill(0));
    const workerIdentity = waitFingerprint(worker.pid); if (workerIdentity) tracked.set(worker.pid, workerIdentity);
    const lineagePoll = setInterval(() => {
      try {
        const rows = processRows(); let changed = true;
        while (changed) {
          changed = false;
          for (const row of rows) if (!tracked.has(row.pid) && tracked.has(row.ppid)) {
            const identity = row.identity;
            if (identity && !sameBaselineProcess(baseline, identity)) { tracked.set(row.pid, identity); changed = true; }
          }
        }
      } catch {}
    }, 10);
    for (const values of [ephemeralEnvironment, credentialEnvironment]) for (const key of Object.keys(values)) { values[key] = ""; runtimeEnvironment[key] = ""; }
    gateSecrets = null;
    const finishWorker = (fields) => {
      if (settled) return;
      clearInterval(lineagePoll);
      const credentialRoot = credentialRootBinding(stagedCredentials.root, stagedCredentials.binding); let cleanupError = null, audit = null;
      try { cleanupCredentialRoot(stagedCredentials.root, config, stagedCredentials.binding); } catch (error) { cleanupError = error; }
      try {
        audit = escapedProcessAudit({ baseline, tracked, scopeToken, gateIdentity });
        if (cleanupError || audit.remaining) return publish({ status: "cleanup_incomplete", exit_code: fields.exit_code, signal: fields.signal,
          error: cleanupError ? `credential cleanup failed: ${cleanupError.message}`
            : `escaped process audit cleanup incomplete: matched=${audit.matched} reaped=${audit.reaped} remaining=${audit.remaining}`,
          obligation: { processes: audit.remaining_identities, credential_root: credentialRoot, scope_seal: config.scope_seal } });
        if (audit.matched) return publish({ status: "failed", exit_code: fields.exit_code, signal: fields.signal,
          error: `escaped process audit failed: matched=${audit.matched} reaped=${audit.reaped} remaining=${audit.remaining}` });
        try { sandboxInvocation.verifyRuntimeFiles({ command: config.command, runtimeFiles: config.runtime_files, runtimeDependencies: config.runtime_dependencies, env: runtimeEnvironment, reenumerate: false }); }
        catch (error) { return publish({ status: "failed", exit_code: fields.exit_code, signal: fields.signal,
          error: `runtime executable closure changed during execution: ${error.message}` }); }
        return publish(fields);
      } catch (error) {
        const processes = [...tracked.values()].filter((identity) => sameProcess(fingerprint(identity.pid), identity)).map((identity) => exactIdentity(identity));
        return publish({ status: "cleanup_incomplete", exit_code: fields.exit_code, signal: fields.signal,
          error: `escaped process audit unavailable: ${error.message}`, obligation: { processes, credential_root: credentialRoot, scope_seal: config.scope_seal } });
      }
    };
    worker.once("error", (error) => finishWorker({ status: "spawn_error", exit_code: null, signal: null, error: error.message }));
    worker.once("close", (code, signal) => finishWorker({ status: code === 0 ? "completed" : "failed", exit_code: code, signal: signal || null, error: null }));
  } catch (error) { for (const values of [ephemeralEnvironment, credentialEnvironment]) if (values) for (const key of Object.keys(values)) values[key] = "";
    let cleanupFailed = false;
    if (stagedCredentials) try { cleanupCredentialRoot(stagedCredentials.root, config, stagedCredentials.binding); } catch { cleanupFailed = true; }
    publish({ status: cleanupFailed ? "cleanup_incomplete" : "spawn_error", exit_code: null, signal: null, error: cleanupFailed ? "credential cleanup failed" : error.message,
      ...(cleanupFailed ? { obligation: { processes: [], credential_root: credentialRootBinding(stagedCredentials.root, stagedCredentials.binding), scope_seal: config.scope_seal } } : {}) }); }
}
function runSupervisor(configPath, configSha) {
  const bytes = fs.readFileSync(configPath); if (sha256(bytes) !== configSha) fail("supervisor config mismatch", "HOST_CONFIG_MISMATCH");
  const secretSize = fs.fstatSync(3).size; if (secretSize > 8 * 1024 * 1024) fail("host secret payload is invalid", "HOST_CONFIG_MISMATCH");
  const secretBuffer = Buffer.alloc(secretSize); if (fs.readSync(3, secretBuffer, 0, secretSize, 0) !== secretSize) fail("host secret payload is truncated", "HOST_CONFIG_MISMATCH");
  let secretPayload; try { secretPayload = JSON.parse(secretBuffer.toString("utf8")); } finally { secretBuffer.fill(0); }
  const secret = secretPayload?.owner_secret, ephemeralEnvironment = environmentEntries(secretPayload?.ephemeral_env || {}, "ephemeral environment"),
    credentialEnvironment = environmentEntries(secretPayload?.credential_env || {}, "credential environment");
  if (!/^[0-9a-f]{64}$/.test(secret)) fail("host secret is invalid", "HOST_CONFIG_MISMATCH");
  const config = JSON.parse(bytes), supervisor = waitFingerprint(process.pid); if (!supervisor) fail("supervisor identity unavailable", "HOST_IDENTITY_UNAVAILABLE");
  const scopeToken = process.env[PROCESS_SCOPE_KEY];
  if (scopeSeal(scopeToken) !== config.scope_seal) fail("supervisor process scope is unavailable", "HOST_CONFIG_MISMATCH");
  if (!Array.isArray(config.ephemeral_env_keys) || config.ephemeral_env_keys.length !== Object.keys(ephemeralEnvironment).length
    || config.ephemeral_env_keys.some((key) => !Object.hasOwn(ephemeralEnvironment, key))) fail("ephemeral environment binding is invalid", "HOST_CONFIG_MISMATCH");
  if (!Array.isArray(config.credential_env_keys) || config.credential_env_keys.length !== Object.keys(credentialEnvironment).length
    || config.credential_env_keys.some((key) => !Object.hasOwn(credentialEnvironment, key))) fail("credential environment binding is invalid", "HOST_CONFIG_MISMATCH");
  publishOnce(config.supervisor, signed({ v: 2, attempt_id: config.attempt_id, lock_id: config.lock_id, host_handle: config.host_handle,
    config_sha256: configSha, nonce: config.nonce, supervisor, started_at: new Date().toISOString() }, secret));
  let child, childClosed = false, executorIdentity = null, finished = false, requested = null, pendingClose = null, deadline, escalation, cancelPoll, barrierPoll, outcome = "", overflow = false;
  const cleanupCredentials = () => { if (fs.existsSync(config.credential_root)) fail("executor credential root remains without a trusted binding", "HOST_CLEANUP_INCOMPLETE"); };
  const cleanupIncomplete = (error, obligation = null, terminal = {}) => {
    if (finished) return; finished = true; clearTimeout(deadline); clearTimeout(escalation); clearInterval(cancelPoll); clearInterval(barrierPoll);
    const priorStatus = TERMINAL.has(terminal.status) ? terminal.status : "failed", provided = obligation?.processes || [];
    const processes = [supervisor, executorIdentity, ...provided].filter(Boolean).map((identity) => exactIdentity(identity));
    publishOnce(config.cleanup, signed({ v: 2, attempt_id: config.attempt_id, lock_id: config.lock_id, host_handle: config.host_handle,
      identities: { supervisor: exactIdentity(supervisor), executor: executorIdentity ? exactIdentity(executorIdentity) : null },
      error: error.message, terminal: { status: priorStatus, exit_code: terminal.exit_code ?? null, signal: terminal.signal || null },
      obligation: { processes: [...new Map(processes.map((identity) => [identity.pid, identity])).values()], credential_root: obligation?.credential_root || credentialRootBinding(config.credential_root),
        scope_seal: config.scope_seal }, observed_at: new Date().toISOString() }, secret));
  };
  function finish(fields) {
    if (finished) return;
    try { cleanupCredentials(); } catch (error) { return cleanupIncomplete(new Error(`credential cleanup failed: ${error.message}`), null, fields); }
    finished = true; clearTimeout(deadline); clearTimeout(escalation); clearInterval(cancelPoll); clearInterval(barrierPoll);
    const body = { attempt_id: config.attempt_id, lock_id: config.lock_id, host_kind: "local_supervisor", host_handle: config.host_handle,
      ...fields, completed_at: new Date().toISOString() };
    atomicWrite(config.result, `${JSON.stringify(signed(body, secret, "result_auth_sha256"))}\n`);
  }
  const unverifiedGroup = (status) => cleanupIncomplete(new Error("executor process group could not be bound to the run process scope"), null, { status });
  function terminate(status) {
    if (finished || requested || !child) return; requested = status;
    const identity = { pid: child.pid, pgid: child.pid, started_at: config.executor_started_at };
    const term = signalScopedGroup(identity, "SIGTERM", config.scope_seal);
    if (!term.delivered && !term.absent) return unverifiedGroup(status);
    if (term.absent && pendingClose) return finish(pendingClose);
    escalation = setTimeout(() => {
      if (finished) return;
      if (pendingClose && !groupExists(child.pid)) return finish(pendingClose);
      const killed = signalScopedGroup(identity, "SIGKILL", config.scope_seal);
      if (!killed.delivered && !killed.absent) return unverifiedGroup(status);
      if (killed.absent) return finish(pendingClose || { status, exit_code: null, signal: "SIGKILL", error: null });
      const end = Date.now() + Math.max(1_000, config.grace_ms), poll = setInterval(() => {
        if (!groupExists(child.pid)) { clearInterval(poll); finish(pendingClose || { status, exit_code: null, signal: "SIGKILL", error: null }); }
        else if (Date.now() >= end) { clearInterval(poll); cleanupIncomplete(new Error(`process group cleanup bound elapsed; prior_status=${pendingClose?.status || status}`)); }
      }, 25);
    }, config.grace_ms);
  }
  try {
    child = spawn(process.execPath, [__filename, "--executor-gate", configPath, configSha], { cwd: config.cwd, detached: true,
      env: { ...minimalEnvironment(process.env), [PROCESS_SCOPE_KEY]: scopeToken }, stdio: ["ignore", 4, 5, "pipe", "pipe", "pipe"] });
    const ephemeralPipe = Buffer.from(JSON.stringify({ ephemeral_env: ephemeralEnvironment, credential_env: credentialEnvironment, credential_files: secretPayload.credential_files || [] })); child.stdio[5].end(ephemeralPipe, () => ephemeralPipe.fill(0));
    for (const values of [ephemeralEnvironment, credentialEnvironment]) for (const key of Object.keys(values)) { values[key] = ""; }
    secretPayload.ephemeral_env = {}; secretPayload.credential_env = {}; secretPayload.credential_files = [];
    child.stdio[4].setEncoding("utf8"); child.stdio[4].on("data", (chunk) => { if (outcome.length + chunk.length > 16_384) overflow = true; else outcome += chunk; });
    const executor = waitFingerprint(child.pid); if (!executor || executor.pgid !== child.pid) fail("executor group identity unavailable", "HOST_IDENTITY_UNAVAILABLE"); executorIdentity = executor;
    config.executor_started_at = executor.started_at;
    publishOnce(config.running, signed({ v: 2, attempt_id: config.attempt_id, lock_id: config.lock_id, host_handle: config.host_handle,
      config_sha256: configSha, nonce: config.nonce, supervisor, executor, started_at: new Date().toISOString() }, secret));
    child.once("error", (error) => finish({ status: "spawn_error", exit_code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => {
      childClosed = true; let parsed = null; try { parsed = overflow ? null : JSON.parse(outcome); } catch {}
      if (!requested && parsed?.attempt_id === config.attempt_id && parsed.status === "cleanup_incomplete") {
        cleanupIncomplete(new Error(parsed.error || "executor cleanup is incomplete"), parsed.obligation, parsed); return;
      }
      const fields = requested ? { status: requested, exit_code: code, signal: signal || null, error: null }
        : parsed && parsed.attempt_id === config.attempt_id && TERMINAL.has(parsed.status)
          ? { status: parsed.status, exit_code: parsed.exit_code, signal: parsed.signal, error: parsed.error }
          : { status: "failed", exit_code: code, signal: signal || null, error: "executor gate returned no valid outcome" };
      if (groupExists(child.pid)) { pendingClose = fields; if (!requested) terminate(fields.status); }
      else finish(fields);
    });
    if (config.test_gate_barrier) barrierPoll = setInterval(() => { if (fs.existsSync(config.test_gate_barrier)) { clearInterval(barrierPoll); child.stdio[3].end(Buffer.from([1])); } }, 10);
    else child.stdio[3].end(Buffer.from([1]));
    deadline = setTimeout(() => terminate("timed_out"), config.timeout_ms);
    cancelPoll = setInterval(() => { if (fs.existsSync(config.cancel)) terminate("cancelled"); }, 25);
    process.once("SIGTERM", () => terminate("cancelled")); process.once("SIGINT", () => terminate("cancelled"));
  } catch (error) { finish({ status: "spawn_error", exit_code: null, signal: null, error: error.message }); }
}
function cliError(error) { return `${error.stack || error.message}\nHOST_DIAGNOSTIC ${JSON.stringify({ code: error.code || null, message: error.message, recommended_action: error.recommended_action })}\n`; }
if (require.main === module) {
  try {
    if (process.argv[2] === "--supervise") runSupervisor(process.argv[3], process.argv[4]);
    else if (process.argv[2] === "--executor-gate") runExecutorGate(process.argv[3], process.argv[4]);
    else { process.stderr.write("Usage: host.js --supervise <config> <sha256>\n"); process.exitCode = 2; }
  } catch (error) { process.stderr.write(cliError(error)); process.exitCode = 1; }
}

module.exports = {
  acquireRunLock,
  assertRunLockHeld,
  releaseRunLock,
  withRunLock,
  launchLocalSupervisor,
  waitForTerminalResult,
  cancelHost,
  inspectOwnership,
  breakStaleRunLock,
  retainReviewerCleanup,
  sandboxInvocation,
};
