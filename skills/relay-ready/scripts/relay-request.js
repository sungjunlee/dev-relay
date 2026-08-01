"use strict";

/** Publish one immutable relay-ready request bundle. Conversation state is transient. */

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;
const COMPLETION = "bundle-complete.json";
const WAIT_MS = 1000;
const READINESS_LEVELS = Object.freeze({
  clarity: new Set(["high", "medium", "low"]),
  granularity: new Set(["single_task", "multi_task", "unclear"]),
  dependency: new Set(["none", "internal", "external"]),
  verifiability: new Set(["high", "medium", "low"]),
  risk: new Set(["low", "medium", "high"]),
});

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

function scalar(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function frontmatter(data, indent = 0) {
  return Object.entries(data).map(([key, value]) => {
    const prefix = " ".repeat(indent);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return `${prefix}${key}:\n${frontmatter(value, indent + 2)}`;
    }
    return `${prefix}${key}: ${scalar(value)}`;
  }).join("\n");
}

function artifactBytes(data, body = "") {
  return Buffer.from(`---\n${frontmatter(data)}\n---\n${body.endsWith("\n") ? body : `${body}\n`}`);
}

function parseScalar(value) {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) return JSON.parse(value);
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function parseFrontmatter(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return { data: {}, body: text };
  const close = lines.indexOf("---", 1);
  if (close < 0) fail("invalid request artifact frontmatter", "REQUEST_ARTIFACT_INVALID");
  const source = lines.slice(1, close);
  function block(start, indent) {
    const data = {};
    let index = start;
    while (index < source.length) {
      const raw = source[index];
      if (!raw.trim()) { index += 1; continue; }
      const current = raw.match(/^ */)[0].length;
      if (current < indent) break;
      if (current > indent) fail("invalid request artifact indentation", "REQUEST_ARTIFACT_INVALID");
      const separator = raw.trim().indexOf(":");
      if (separator < 0) fail("invalid request artifact entry", "REQUEST_ARTIFACT_INVALID");
      const entry = raw.trim();
      const key = entry.slice(0, separator).trim();
      const rest = entry.slice(separator + 1).trim();
      if (!rest) {
        const nested = block(index + 1, indent + 2);
        data[key] = nested.data;
        index = nested.index;
      } else {
        data[key] = parseScalar(rest);
        index += 1;
      }
    }
    return { data, index };
  }
  return { data: block(0, 0).data, body: lines.slice(close + 1).join("\n") };
}

function readRequestArtifact(requestPath) {
  // The public request file is deliberately outside its bundle directory for
  // operator ergonomics. It is not, on its own, an authority: a writer can
  // crash after publishing it and before publishing the final marker.
  const publicPath = path.resolve(requestPath);
  const requestId = assertSafeId(path.basename(publicPath, ".md"), "request_id");
  if (path.basename(publicPath) !== `${requestId}.md`) {
    fail("request artifact filename must match its request_id", "REQUEST_PATH_UNTRUSTED");
  }
  const requestsDir = path.dirname(publicPath);
  const requestsStat = fs.lstatSync(requestsDir);
  if (!requestsStat.isDirectory() || requestsStat.isSymbolicLink() || fs.realpathSync(requestsDir) !== requestsDir) {
    fail("request artifact parent must be a real directory", "REQUEST_PATH_UNTRUSTED");
  }
  const requestDir = path.join(requestsDir, requestId);
  const requestDirStat = fs.lstatSync(requestDir);
  if (!requestDirStat.isDirectory() || requestDirStat.isSymbolicLink() || fs.realpathSync(requestDir) !== requestDir) {
    fail("request bundle path is untrusted", "REQUEST_PATH_UNTRUSTED");
  }

  let completion;
  try { completion = JSON.parse(readRegular(path.join(requestDir, COMPLETION), "request completion marker").toString("utf8")); }
  catch (error) {
    if (error.code === "ENOENT") fail("request bundle exists without a completion marker", "REQUEST_BUNDLE_INCOMPLETE");
    if (error instanceof SyntaxError) fail("invalid request completion marker", "REQUEST_ARTIFACT_INVALID");
    throw error;
  }
  if (!completion || typeof completion !== "object" || Array.isArray(completion)
    || completion.schema_version !== 1 || completion.request_id !== requestId
    || typeof completion.bundle_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(completion.bundle_sha256)
    || !completion.files || typeof completion.files !== "object" || Array.isArray(completion.files)) {
    fail("invalid request completion marker", "REQUEST_ARTIFACT_INVALID");
  }
  const entries = Object.entries(completion.files);
  const safeInventoryName = (name) => name === "../request.md" || name === "raw-request.md"
    || /^(?:done-criteria|relay-ready)\/[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.md$/.test(name);
  if (!entries.length || entries.some(([name, digest]) => !safeInventoryName(name)
    || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) {
    fail("request completion marker has an invalid inventory", "REQUEST_ARTIFACT_INVALID");
  }
  const verified = new Map();
  for (const [name, digest] of entries) {
    const target = name === "../request.md" ? publicPath : path.join(requestDir, name);
    const bytes = readRegular(target, name);
    if (sha256(bytes) !== digest) fail(`completed request artifact changed: ${name}`, "REQUEST_ARTIFACT_CONFLICT");
    verified.set(name, bytes);
  }
  if (sha256(Buffer.from(JSON.stringify([...verified.entries()].map(([name, bytes]) => [name, sha256(bytes)]).sort()))) !== completion.bundle_sha256) {
    fail("request completion marker digest does not match its bundle", "REQUEST_ARTIFACT_CONFLICT");
  }
  const requestBytes = verified.get("../request.md");
  if (!requestBytes) fail("request completion marker has an incomplete inventory", "REQUEST_ARTIFACT_INVALID");
  const artifact = parseFrontmatter(requestBytes.toString("utf8"));
  const data = artifact.data;
  if (data.request_id !== requestId || !Number.isInteger(data.leaf_count) || data.leaf_count < 1) {
    fail("request artifact does not match its bundle", "REQUEST_ARTIFACT_INVALID");
  }
  const leafIds = data.leaf_count === 1
    ? [assertSafeId(data.leaf_id, "leaf_id")]
    : (Array.isArray(data.decomposition?.leaf_order) && data.decomposition.leaf_order.map((leafId) => assertSafeId(leafId, "leaf_id")));
  if (!leafIds || leafIds.length !== data.leaf_count || new Set(leafIds).size !== leafIds.length) {
    fail("request artifact has an invalid leaf inventory", "REQUEST_ARTIFACT_INVALID");
  }
  const expectedPaths = {
    raw_request: path.join(requestDir, "raw-request.md"),
    handoffs: leafIds.map((leafId) => path.join(requestDir, "relay-ready", `${leafId}.md`)),
    done_criteria: leafIds.map((leafId) => path.join(requestDir, "done-criteria", `${leafId}.md`)),
  };
  const paths = data.paths;
  const pathMatches = paths && paths.raw_request === expectedPaths.raw_request && (data.leaf_count === 1
    ? paths.handoff === expectedPaths.handoffs[0] && paths.done_criteria === expectedPaths.done_criteria[0]
    : Array.isArray(paths.handoffs) && Array.isArray(paths.done_criteria)
      && JSON.stringify(paths.handoffs) === JSON.stringify(expectedPaths.handoffs)
      && JSON.stringify(paths.done_criteria) === JSON.stringify(expectedPaths.done_criteria));
  if (!pathMatches) fail("request artifact paths do not match its bundle", "REQUEST_ARTIFACT_INVALID");
  const expectedNames = new Set(["../request.md", "raw-request.md"]);
  for (const leafId of leafIds) {
    expectedNames.add(path.posix.join("done-criteria", `${leafId}.md`));
    expectedNames.add(path.posix.join("relay-ready", `${leafId}.md`));
  }
  if (entries.length !== expectedNames.size || entries.some(([name]) => !expectedNames.has(name))) {
    fail("request completion marker has an incomplete or invalid inventory", "REQUEST_ARTIFACT_INVALID");
  }
  return artifact;
}

function stringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`, "REQUEST_CONTRACT_INVALID");
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      fail(`${field}[${index}] must be a non-empty string`, "REQUEST_CONTRACT_INVALID");
    }
    return entry.trim();
  });
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} is required`, "REQUEST_CONTRACT_INVALID");
  return value.trim();
}

function normalizeReadiness(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("readiness must be an object", "REQUEST_CONTRACT_INVALID");
  }
  return Object.fromEntries(Object.entries(READINESS_LEVELS).map(([field, allowed]) => {
    const selected = requiredString(value[field], `readiness.${field}`);
    if (!allowed.has(selected)) fail(`readiness.${field} is invalid`, "REQUEST_CONTRACT_INVALID");
    return [field, selected];
  }));
}

function normalizeLeaf(value, field, defaultOrder) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`, "REQUEST_CONTRACT_INVALID");
  }
  const leafId = assertSafeId(requiredString(value.leaf_id, `${field}.leaf_id`), "leaf_id");
  const order = value.order === undefined ? defaultOrder : value.order;
  if (!Number.isInteger(order) || order < 1) fail(`${field}.order must be a positive integer`, "REQUEST_CONTRACT_INVALID");
  return {
    leafId,
    title: requiredString(value.title, `${field}.title`),
    goal: requiredString(value.goal, `${field}.goal`),
    order,
    dependsOn: stringArray(value.depends_on, `${field}.depends_on`),
    inScope: stringArray(value.in_scope, `${field}.in_scope`),
    outOfScope: stringArray(value.out_of_scope, `${field}.out_of_scope`),
    assumptions: stringArray(value.assumptions, `${field}.assumptions`),
    escalationConditions: stringArray(value.escalation_conditions, `${field}.escalation_conditions`),
    doneCriteriaMarkdown: requiredString(value.done_criteria_markdown, `${field}.done_criteria_markdown`),
    readiness: normalizeReadiness(value.readiness),
  };
}

function normalizeRequestContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    fail("contract must be an object", "REQUEST_CONTRACT_INVALID");
  }
  const sourceKind = requiredString(contract.source?.kind, "source.kind");
  const requestText = requiredString(contract.request_text, "request_text");
  const raw = Array.isArray(contract.handoffs)
    ? contract.handoffs
    : contract.handoff ? [contract.handoff] : [];
  if (!raw.length) fail("handoff is required", "REQUEST_CONTRACT_INVALID");
  const handoffs = raw.map((leaf, index) => normalizeLeaf(
    leaf,
    Array.isArray(contract.handoffs) ? `handoffs[${index}]` : "handoff",
    raw.length === 1 ? 1 : undefined,
  )).sort((left, right) => left.order - right.order);
  const ids = new Set();
  const orders = new Set();
  for (const leaf of handoffs) {
    if (ids.has(leaf.leafId)) fail(`duplicate leaf_id '${leaf.leafId}'`, "REQUEST_CONTRACT_INVALID");
    if (orders.has(leaf.order)) fail(`duplicate leaf order '${leaf.order}'`, "REQUEST_CONTRACT_INVALID");
    ids.add(leaf.leafId); orders.add(leaf.order);
  }
  const orderById = new Map(handoffs.map((leaf) => [leaf.leafId, leaf.order]));
  for (const leaf of handoffs) {
    const dependencies = new Set();
    for (const dependency of leaf.dependsOn) {
      if (!orderById.has(dependency) || orderById.get(dependency) >= leaf.order || dependencies.has(dependency)) {
        fail(`invalid dependency '${dependency}' for leaf '${leaf.leafId}'`, "REQUEST_CONTRACT_INVALID");
      }
      dependencies.add(dependency);
    }
  }
  const requestReadiness = normalizeReadiness(contract.readiness);
  const leafReadiness = handoffs.map((leaf) => leaf.readiness).filter(Boolean);
  for (const readiness of leafReadiness.slice(1)) {
    if (JSON.stringify(readiness) !== JSON.stringify(leafReadiness[0])) {
      fail("leaf readiness values conflict", "REQUEST_CONTRACT_INVALID");
    }
  }
  for (const leaf of handoffs) {
    if (requestReadiness && leaf.readiness && JSON.stringify(requestReadiness) !== JSON.stringify(leaf.readiness)) {
      fail("request and leaf readiness conflict", "REQUEST_CONTRACT_INVALID");
    }
  }
  return { sourceKind, requestText, readiness: requestReadiness || leafReadiness[0], handoffs };
}

function normalizeSingleLeafContract(contract) {
  const normalized = normalizeRequestContract(contract);
  if (normalized.handoffs.length !== 1) fail("contract must contain exactly one leaf", "REQUEST_CONTRACT_INVALID");
  return {
    source: { kind: normalized.sourceKind },
    requestText: normalized.requestText,
    readiness: normalized.readiness,
    handoff: normalized.handoffs[0],
  };
}

function bullets(items) { return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None"; }

function handoffBody(leaf) {
  return [
    "# Relay-Ready Handoff", "", "## Goal", leaf.goal, "", "## In Scope", bullets(leaf.inScope), "",
    "## Out of Scope", bullets(leaf.outOfScope), "", "## Assumptions", bullets(leaf.assumptions), "",
    "## Escalation Conditions", bullets(leaf.escalationConditions), "",
  ].join("\n");
}

function requestBody(normalized, leaves) {
  return [
    "# Relay Intake Request", "", "## Source", `Kind: ${normalized.sourceKind}`, "", "## Raw Request",
    normalized.requestText, "", "## Relay-Ready Leaves", bullets(leaves.map((leaf) => (
      `${leaf.leafId} [order ${leaf.order}] ${leaf.title}: ${leaf.handoffRelative}`
    ))), "", "## Frozen Done Criteria", bullets(leaves.map((leaf) => `${leaf.leafId}: ${leaf.criteriaRelative}`)), "",
  ].join("\n");
}

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function bundleDigest(files) {
  const inventory = [...files.entries()].map(([name, bytes]) => [name, sha256(bytes)]).sort();
  return { inventory, digest: sha256(Buffer.from(JSON.stringify(inventory))) };
}

function waitForCompletion(marker) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    try { return JSON.parse(readRegular(marker, "request completion marker").toString("utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) fail("request completion marker is malformed", "REQUEST_ARTIFACT_INVALID");
      if (error.code !== "ENOENT") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  fail("request bundle exists without a completion marker", "REQUEST_BUNDLE_INCOMPLETE");
}

function persistRequestContract(repoRoot, contract, options = {}) {
  const normalized = normalizeRequestContract(contract);
  const requestId = assertSafeId(options.requestId || createRequestId(), "request_id");
  const requestsDir = getRequestsDir(repoRoot);
  const requestDir = path.join(requestsDir, requestId);
  const requestPath = path.join(requestsDir, `${requestId}.md`);
  const rawRequestPath = path.join(requestDir, "raw-request.md");
  const relayReadyDir = path.join(requestDir, "relay-ready");
  const doneCriteriaDir = path.join(requestDir, "done-criteria");
  const markerPath = path.join(requestDir, COMPLETION);
  const leaves = normalized.handoffs.map((leaf) => ({
    ...leaf,
    handoffPath: path.join(relayReadyDir, `${leaf.leafId}.md`),
    doneCriteriaPath: path.join(doneCriteriaDir, `${leaf.leafId}.md`),
    handoffRelative: path.join(requestId, "relay-ready", `${leaf.leafId}.md`),
    criteriaRelative: path.join(requestId, "done-criteria", `${leaf.leafId}.md`),
  }));
  const files = new Map();
  files.set("raw-request.md", Buffer.from(`${normalized.requestText}\n`));
  for (const leaf of leaves) {
    files.set(path.join("done-criteria", `${leaf.leafId}.md`), Buffer.from(`${leaf.doneCriteriaMarkdown}\n`));
    files.set(path.join("relay-ready", `${leaf.leafId}.md`), artifactBytes({
      request_id: requestId,
      leaf_id: leaf.leafId,
      title: leaf.title,
      goal: leaf.goal,
      order: leaf.order,
      depends_on: leaf.dependsOn,
      done_criteria_path: leaf.doneCriteriaPath,
    }, handoffBody(leaf)));
  }
  const requestData = {
    request_id: requestId,
    state: "relay_ready",
    leaf_count: leaves.length,
    next_action: "relay_plan",
    source: { kind: normalized.sourceKind },
    ...(normalized.readiness ? { readiness: normalized.readiness } : {}),
    paths: {
      raw_request: rawRequestPath,
      ...(leaves.length === 1
        ? { handoff: leaves[0].handoffPath, done_criteria: leaves[0].doneCriteriaPath }
        : { handoffs: leaves.map((leaf) => leaf.handoffPath), done_criteria: leaves.map((leaf) => leaf.doneCriteriaPath) }),
    },
    ...(leaves.length > 1 ? {
      decomposition: {
        leaf_order: leaves.map((leaf) => leaf.leafId),
        dependencies: Object.fromEntries(
          leaves.filter((leaf) => leaf.dependsOn.length).map((leaf) => [leaf.leafId, leaf.dependsOn]),
        ),
      },
    } : {}),
  };
  if (leaves.length === 1) requestData.leaf_id = leaves[0].leafId;
  files.set("../request.md", artifactBytes(requestData, requestBody(normalized, leaves)));
  const expected = bundleDigest(files);
  const completion = {
    schema_version: 1,
    request_id: requestId,
    bundle_sha256: expected.digest,
    files: Object.fromEntries(expected.inventory),
  };

  let owner = false;
  try { fs.mkdirSync(requestDir, { mode: 0o700 }); owner = true; fsyncDirectory(requestsDir); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = fs.lstatSync(requestDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("request bundle path is untrusted", "REQUEST_PATH_UNTRUSTED");
  }
  if (fs.realpathSync(requestDir) !== requestDir || path.dirname(requestDir) !== requestsDir) {
    fail("request bundle path escapes its repository request directory", "REQUEST_PATH_UNTRUSTED");
  }

  if (!owner) {
    const existing = waitForCompletion(markerPath);
    if (JSON.stringify(existing) !== JSON.stringify(completion)) {
      fail("request_id already belongs to a different immutable bundle", "REQUEST_ARTIFACT_CONFLICT");
    }
    for (const [name, bytes] of files) {
      const target = name === "../request.md" ? requestPath : path.join(requestDir, name);
      if (!readRegular(target, name).equals(bytes)) fail(`completed request artifact changed: ${name}`, "REQUEST_ARTIFACT_CONFLICT");
    }
  } else {
    ensurePrivateDirectory(relayReadyDir);
    ensurePrivateDirectory(doneCriteriaDir);
    fsyncDirectory(requestDir);
    try {
      for (const [name, bytes] of files) {
        const target = name === "../request.md" ? requestPath : path.join(requestDir, name);
        writeExclusive(target, bytes, name);
        options.fault?.(`after:${name}`);
      }
      publishAtomicExclusive(
        markerPath,
        Buffer.from(`${JSON.stringify(completion)}\n`),
        "request completion marker",
        () => options.fault?.("after:bundle-complete.temp"),
      );
      fsyncDirectory(requestDir);
    } catch (error) {
      error.message = `incomplete request bundle ${requestId}: ${error.message}`;
      throw error;
    }
  }

  return {
    requestId,
    requestPath,
    requestDir,
    rawRequestPath,
    leafIds: leaves.map((leaf) => leaf.leafId),
    handoffPaths: leaves.map((leaf) => leaf.handoffPath),
    doneCriteriaPaths: leaves.map((leaf) => leaf.doneCriteriaPath),
    leafCount: leaves.length,
    nextAction: "relay_plan",
    readiness: normalized.readiness || null,
    sourceKind: normalized.sourceKind,
    ...(leaves.length === 1 ? {
      leafId: leaves[0].leafId,
      handoffPath: leaves[0].handoffPath,
      doneCriteriaPath: leaves[0].doneCriteriaPath,
      title: leaves[0].title,
    } : {}),
  };
}

module.exports = {
  createRequestId,
  normalizeSingleLeafContract,
  persistRequestContract,
  readRequestArtifact,
};
