"use strict";
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const factsModule = require("./facts");
const host = require("./host");
const { execGh, execGit, resolveBranchRemote } = require("./exec");
const { assertTrustedWorktree, readArtifact, readJsonIfPresent, readRunRecord, writeImmutableJson } = require("./run-store");
const runStore = require("./run-store");
const { readFacts } = factsModule;
const inspect = require("./inspect");
const { foldRunFacts } = inspect;
const RECOVERY_STEPS = new Set([
  "close_dead_attempt",
  "commit_work",
  "push_branch",
  "record_or_create_pr",
  "record_verification",
  "record_external_merge",
]);
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function stable(value, { omitVolatile = false } = {}) { return inspect.stable(value, omitVolatile); }
const actionKey = inspect.actionKey;
const RUNTIME_METADATA_ROOTS = Object.freeze([
  ".relay", ".codex", ".claude", ".cursor", ".opencode", ".pi",
  ".antigravity", ".antigravitycli", ".cline",
]);
const RUNTIME_METADATA_COMPONENTS = new Set(RUNTIME_METADATA_ROOTS);
function decodeGitPath(bytes) {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    throw Object.assign(new Error("Git reported a path that is not valid UTF-8"), { code: "UNSUPPORTED_GIT_PATH_ENCODING" });
  }
  return value;
}
function parsePorcelainV1Z(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ""), "utf8");
  if (bytes.length === 0) return [];
  const records = [];
  let offset = 0;
  const token = () => {
    const end = bytes.indexOf(0, offset);
    if (end < 0) throw Object.assign(new Error("unterminated porcelain v1 -z record"), { code: "INVALID_GIT_STATUS" });
    const result = bytes.subarray(offset, end);
    offset = end + 1;
    return result;
  };
  while (offset < bytes.length) {
    const first = token();
    if (first.length < 4 || first[2] !== 0x20) {
      throw Object.assign(new Error("malformed porcelain v1 -z record"), { code: "INVALID_GIT_STATUS" });
    }
    const xy = first.subarray(0, 2).toString("ascii");
    const current = decodeGitPath(first.subarray(3));
    const original = /[RC]/.test(xy) ? decodeGitPath(token()) : null;
    records.push({ xy, current, original });
  }
  return records;
}
function metadataPath(relative) {
  return String(relative || "").split("/").some((component) => RUNTIME_METADATA_COMPONENTS.has(component));
}
function recordPaths(record) { return [record.current, record.original].filter(Boolean); }
function runtimeMetadataRecord(record) { return recordPaths(record).some(metadataPath); }
function classifyRepositoryDirt(value) {
  const records = parsePorcelainV1Z(value);
  const runtimeRecords = records.filter(runtimeMetadataRecord);
  const reviewableRecords = records.filter((record) => !runtimeMetadataRecord(record));
  return {
    hasDirt: records.length > 0,
    hasRuntimeMetadataDirt: runtimeRecords.length > 0,
    hasOnlyRuntimeMetadataDirt: records.length > 0 && reviewableRecords.length === 0,
    hasReviewableDirt: reviewableRecords.length > 0,
    runtimeMetadataStatus: runtimeRecords,
    reviewableStatus: reviewableRecords,
    records,
  };
}
function reviewableStatusPaths(value) {
  return [...new Set(classifyRepositoryDirt(value).reviewableStatus.flatMap(recordPaths))];
}
function artifactDigest(filePath) { return readArtifact(filePath, path.basename(filePath), { optional: true })?.sha256 || sha256(Buffer.alloc(0)); }
function commandFailure(error) {
  return String(error?.stderr || error?.stdout || error?.message || error).trim().split(/\r?\n/)[0];
}
function intentPath(runDir, key) { return path.join(runDir, `recovery-intent-${key}.json`); }
function receiptPath(runDir, key) { return path.join(runDir, `recovery-receipt-${key}.json`); }
function productionRecoveryIo(runDir) {
  return {
    readIntent({ facts = [] } = {}) {
      const active = fs.readdirSync(runDir)
        .filter((name) => /^recovery-intent-[0-9a-f]{64}\.json$/.test(name))
        .map((name) => {
          const actionKeyValue = name.slice("recovery-intent-".length, -".json".length);
          const intent = readJsonIfPresent(path.join(runDir, name));
          if (!intent) return null;
          if (intent.action_key !== actionKeyValue) throw new Error("recovery intent payload does not match its immutable filename");
          const receipt = readJsonIfPresent(receiptPath(runDir, actionKeyValue));
          if (receipt) { validateRecoveryReceipt(receipt, { actionKey: actionKeyValue, facts }); return null; }
          return intent;
        })
        .filter(Boolean);
      if (active.length > 1) throw new Error("multiple active recovery intents require operator attention");
      return active[0] || null;
    },
    writeIntent: ({ intent }) => writeImmutableJson(intentPath(runDir, intent.action_key), intent),
    readReceipt: ({ actionKey: key }) => readJsonIfPresent(receiptPath(runDir, key)),
    writeReceipt: ({ actionKey: key, receipt }) => writeImmutableJson(receiptPath(runDir, key), receipt),
  };
}
function safeRelation(worktree, remoteSha, localSha) {
  if (!remoteSha) return "behind_local";
  if (remoteSha === localSha) return "equal";
  const ancestor = (older, newer) => {
    try {
      execGit(worktree, ["--no-optional-locks", "merge-base", "--is-ancestor", older, newer]);
      return true;
    } catch (error) {
      return error.status === 1 ? false : null;
    }
  };
  const remoteBehind = ancestor(remoteSha, localSha);
  const localBehind = ancestor(localSha, remoteSha);
  return remoteBehind === null || localBehind === null ? "unknown"
    : remoteBehind ? "behind_local" : localBehind ? "ahead_local" : "diverged";
}
function normalizedRemoteIdentity(value, worktree) {
  const remote = String(value || "").trim().replace(/\/$/, "");
  let match = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i)
    || remote.match(/^(?:ssh:\/\/git@|https?:\/\/)github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (match) return `github:${match[1].replace(/\.git$/i, "").toLowerCase()}`;
  if (/^[^/:]+\/[^/]+$/.test(remote)) return `github:${remote.replace(/\.git$/i, "").toLowerCase()}`;
  try {
    const candidate = path.isAbsolute(remote) ? remote : path.resolve(worktree, remote);
    return `file:${fs.realpathSync(candidate)}`;
  } catch {
    return `unknown:${remote}`;
  }
}
function selectGithubPr(rows, { remote, branch, baseBranch, localHeadSha = null, recordedPrNumber = null }) {
  const headRepo = (row) => row?.headRepository?.nameWithOwner
    || (row?.headRepositoryOwner?.login && row?.headRepository?.name
      ? `${row.headRepositoryOwner.login}/${row.headRepository.name}`
      : null);
  const identityMatches = (Array.isArray(rows) ? rows : []).filter((row) => (
    row.headRefName === branch && row.baseRefName === baseBranch && headRepo(row) === remote
  ));
  const byState = (state) => identityMatches.filter((row) => row.state === state);
  const open = byState("OPEN");
  const merged = byState("MERGED");
  const closed = byState("CLOSED");
  const exactHead = (candidates) => localHeadSha ? candidates.filter((row) => row.headRefOid === localHeadSha) : candidates;
  const exactOpen = exactHead(open);
  const exactMerged = exactHead(merged);
  const recordedClosed = Number.isInteger(recordedPrNumber) ? closed.filter((row) => row.number === recordedPrNumber) : [];
  const reusable = [recordedClosed, exactOpen, exactMerged, open, merged].find((group) => group.length) || [];
  return {
    pr: reusable.length === 1 ? reusable[0] : null,
    matchingPrCount: reusable.length,
    identityMatchCount: identityMatches.length,
    openPrCount: open.length,
    mergedPrCount: merged.length,
    closedPrCount: closed.length,
    headRepo,
  };
}
function assertTrustedRecoveryWorktree({ repoRoot, activeCheckout, relayWorktreeBase, worktree }) {
  assertTrustedWorktree({ repoRoot, activeCheckout, relayWorktreeBase, worktree });
  return fs.realpathSync(worktree);
}
function unsafeWorktreeEntries(worktree, statusText) {
  const isSpecial = (entry) => (
    entry.isSymbolicLink() || !entry.isFile()
  );
  if (typeof statusText !== "string" && !Buffer.isBuffer(statusText)) throw new Error("unsafeWorktreeEntries requires reviewable git status bytes");
  return [...new Set(reviewableStatusPaths(statusText))].filter((relative) => {
    const candidate = path.resolve(worktree, relative);
    const relation = path.relative(worktree, candidate);
    if (!relative || path.isAbsolute(relative) || relation === ".." || relation.startsWith(`..${path.sep}`)) return true;
    try {
      const entry = fs.lstatSync(candidate);
      return isSpecial(entry);
    } catch (error) {
      return error.code !== "ENOENT";
    }
  }).sort();
}

function gitBytes(repo, args) {
  return execFileSync(process.env.RELAY_GIT_BIN || "git", ["-C", repo, ...args], {
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function recoveryFail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function containedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalRecoveryCheckout(repository) {
  const checkout = fs.realpathSync(path.resolve(repository));
  const topLevel = fs.realpathSync(execGit(checkout, ["rev-parse", "--show-toplevel"]));
  if (checkout !== topLevel) recoveryFail("INVALID_REPOSITORY", `repo must be the canonical checkout root: ${topLevel}`);
  return {
    checkout,
    repoRoot: runStore.canonicalRepository(checkout),
  };
}

function localBranchRef(checkout, branch) {
  if (typeof branch !== "string" || !branch) recoveryFail("INVALID_BRANCH", "branch is required");
  try {
    execGit(checkout, ["check-ref-format", "--branch", branch]);
  } catch (error) {
    recoveryFail("INVALID_BRANCH", `branch is invalid: ${branch}`);
  }
  return `refs/heads/${branch}`;
}

function parseWorktreeList(value) {
  const entries = [];
  let entry = null;
  for (const line of String(value || "").split("\n")) {
    if (!line) {
      if (entry) { entries.push(entry); entry = null; }
      continue;
    }
    const match = /^(worktree|HEAD|branch) (.+)$/.exec(line);
    if (!match) recoveryFail("INVALID_WORKTREE_REGISTRY", "git worktree list returned an unsupported record");
    if (match[1] === "worktree") {
      if (entry) recoveryFail("INVALID_WORKTREE_REGISTRY", "git worktree list record is missing its separator");
      entry = { worktree: match[2], head: null, branch: null };
    } else if (!entry || entry[match[1].toLowerCase()] !== null) {
      recoveryFail("INVALID_WORKTREE_REGISTRY", "git worktree list returned a malformed record");
    } else {
      entry[match[1].toLowerCase()] = match[2];
    }
  }
  if (entry) entries.push(entry);
  return entries;
}

function branchExists(checkout, ref) {
  try {
    execGit(checkout, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function isAncestor(checkout, older, newer) {
  try {
    execGit(checkout, ["--no-optional-locks", "merge-base", "--is-ancestor", older, newer]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function recoveryRunsBase() {
  const configured = process.env.RELAY_RUNS_BASE || path.join(process.env.RELAY_HOME || path.join(os.homedir(), ".relay"), "runs");
  if (!path.isAbsolute(configured)) recoveryFail("INVALID_RELAY_PATH", "RELAY_RUNS_BASE must be absolute");
  return path.resolve(configured);
}

function validRunReferences({ repoRoot, branch, worktree }) {
  const base = recoveryRunsBase();
  let root;
  try { root = fs.lstatSync(base); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (!root.isDirectory() || root.isSymbolicLink()) recoveryFail("UNTRUSTED_RUNS_BASE", "Relay runs base must be a real directory");
  const references = [];
  for (const repositoryEntry of fs.readdirSync(base, { withFileTypes: true })) {
    const repositoryDir = path.join(base, repositoryEntry.name);
    const repositoryStat = fs.lstatSync(repositoryDir);
    if (repositoryStat.isSymbolicLink()) recoveryFail("UNTRUSTED_RUNS_BASE", `Relay runs base contains a symlink: ${repositoryDir}`);
    if (!repositoryStat.isDirectory()) continue;
    for (const runEntry of fs.readdirSync(repositoryDir, { withFileTypes: true })) {
      const runDir = path.join(repositoryDir, runEntry.name);
      const runStat = fs.lstatSync(runDir);
      if (runStat.isSymbolicLink()) recoveryFail("UNTRUSTED_RUNS_BASE", `Relay run directory is a symlink: ${runDir}`);
      if (!runStat.isDirectory()) continue;
      let record;
      try { record = readRunRecord({ runDir }); }
      catch { continue; }
      let recordRepoRoot = null;
      try { recordRepoRoot = fs.realpathSync(record.repo.root); } catch {}
      let recordWorktree = path.resolve(record.git.worktree);
      try { recordWorktree = fs.realpathSync(recordWorktree); } catch {}
      const sameRepository = recordRepoRoot === repoRoot;
      const sameBranch = sameRepository && record.git.branch === branch;
      const sameWorktree = worktree !== null && recordWorktree === worktree;
      if (sameBranch || sameWorktree) references.push({ run_id: record.run_id, run_dir: runDir, branch: record.git.branch, worktree: record.git.worktree });
    }
  }
  return references;
}

function observeStrandedWorktree({ repository, branch, relayWorktreeBase = null }) {
  const { checkout, repoRoot } = canonicalRecoveryCheckout(repository);
  const ref = localBranchRef(checkout, branch);
  const holders = parseWorktreeList(execGit(checkout, ["worktree", "list", "--porcelain"], { raw: true }))
    .filter((entry) => entry.branch === ref);
  const exists = branchExists(checkout, ref);
  if (!exists) {
    if (holders.length) recoveryFail("STRANDED_WORKTREE_AMBIGUOUS", `branch ${branch} is absent but still has registered worktrees`);
    const references = validRunReferences({ repoRoot, branch, worktree: null });
    if (references.length) recoveryFail("STRANDED_WORKTREE_REFERENCED", `a valid vNext run references branch ${branch}: ${references.map((item) => item.run_id).join(", ")}`);
    return { status: "already_recovered", checkout, repoRoot, branch, ref };
  }
  if (holders.length !== 1) recoveryFail(
    holders.length ? "STRANDED_WORKTREE_AMBIGUOUS" : "STRANDED_WORKTREE_NOT_FOUND",
    `branch ${branch} must be checked out by exactly one registered worktree; found ${holders.length}`,
  );
  const configuredBase = relayWorktreeBase || runStore.relayWorktreeBase();
  let base;
  try { base = fs.realpathSync(configuredBase); }
  catch { recoveryFail("UNTRUSTED_WORKTREE", "Relay worktree base does not exist"); }
  let worktree;
  try { worktree = fs.realpathSync(holders[0].worktree); }
  catch { recoveryFail("UNTRUSTED_WORKTREE", `registered worktree is unavailable: ${holders[0].worktree}`); }
  try {
    assertTrustedRecoveryWorktree({ repoRoot, activeCheckout: checkout, relayWorktreeBase: base, worktree });
  } catch (error) {
    recoveryFail("UNTRUSTED_WORKTREE", error.message);
  }
  const checkedOutBranch = execGit(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (checkedOutBranch !== branch) recoveryFail("STRANDED_WORKTREE_AMBIGUOUS", `registered worktree is not checked out on ${branch}`);
  const head = execGit(worktree, ["rev-parse", "HEAD"]);
  const branchHead = execGit(checkout, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (head !== branchHead) recoveryFail("STRANDED_WORKTREE_CHANGED", `branch ${branch} changed while recovery was observing it`);
  const canonicalHead = execGit(checkout, ["rev-parse", "HEAD"]);
  if (!isAncestor(checkout, branchHead, canonicalHead)) {
    recoveryFail("STRANDED_WORKTREE_UNMERGED", `branch ${branch} has committed work that is not reachable from the canonical checkout HEAD`);
  }
  const status = gitBytes(worktree, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const dirt = classifyRepositoryDirt(status);
  if (dirt.hasReviewableDirt) recoveryFail("STRANDED_WORKTREE_DIRTY", `registered worktree has reviewable changes: ${reviewableStatusPaths(status).join(", ")}`);
  if (dirt.hasDirt) recoveryFail("STRANDED_WORKTREE_DIRTY", "registered worktree has runtime metadata changes; stranded-worktree recovery only removes a clean worktree");
  const references = validRunReferences({ repoRoot, branch, worktree });
  if (references.length) recoveryFail("STRANDED_WORKTREE_REFERENCED", `a valid vNext run references this branch or worktree: ${references.map((item) => item.run_id).join(", ")}`);
  return { status: "ready", checkout, repoRoot, branch, ref, base, worktree, branchHead, canonicalHead };
}

function removeEmptyRelayParents(base, worktree) {
  const removed = [];
  for (let cursor = path.dirname(worktree); cursor !== base && containedPath(base, cursor); cursor = path.dirname(cursor)) {
    try { fs.rmdirSync(cursor); removed.push(cursor); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; break; }
  }
  return removed;
}

function recoverStrandedWorktree({ repository, branch, relayWorktreeBase = null } = {}) {
  const initial = observeStrandedWorktree({ repository, branch, relayWorktreeBase });
  if (initial.status === "already_recovered") {
    return { operation: "recover_stranded_worktree", status: "already_recovered", repo: initial.repoRoot, branch: initial.branch, removed_parent_directories: [] };
  }
  // The inspection is intentionally repeated immediately before the first destructive Git operation.
  // There is no run lock in this pre-run-record window, so every ownership predicate is re-proven.
  const current = observeStrandedWorktree({ repository, branch, relayWorktreeBase: initial.base });
  if (current.status !== "ready" || current.worktree !== initial.worktree
    || current.branchHead !== initial.branchHead || current.canonicalHead !== initial.canonicalHead) {
    recoveryFail("STRANDED_WORKTREE_CHANGED", "stranded worktree changed while recovery was revalidating it");
  }
  execGit(current.checkout, ["worktree", "remove", current.worktree]);
  try {
    execGit(current.checkout, ["update-ref", "-d", current.ref, current.branchHead]);
  } catch (error) {
    recoveryFail("STRANDED_BRANCH_NOT_REMOVED", `worktree was removed but branch ${current.branch} was not deleted safely: ${commandFailure(error)}`);
  }
  const removed = removeEmptyRelayParents(current.base, current.worktree);
  return {
    operation: "recover_stranded_worktree",
    status: "recovered",
    repo: current.repoRoot,
    branch: current.branch,
    worktree: current.worktree,
    removed_parent_directories: removed,
  };
}

function sameFingerprint(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function pathFingerprint(worktree, relative, { allowMissing = false } = {}) {
  if (typeof relative !== "string" || !relative || relative.includes("\0") || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`unsafe reviewable path: ${JSON.stringify(relative)}`), { code: "UNSAFE_WORKTREE_ENTRY" });
  }
  const root = fs.realpathSync(worktree);
  const candidate = path.resolve(root, relative);
  const relation = path.relative(root, candidate);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw Object.assign(new Error(`reviewable path escapes worktree: ${relative}`), { code: "UNSAFE_WORKTREE_ENTRY" });
  }
  const components = relation.split(path.sep);
  let cursor = root;
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]);
    let stat;
    try { stat = fs.lstatSync(cursor, { bigint: true }); }
    catch (error) {
      if (error.code === "ENOENT" && allowMissing) return Object.freeze({ kind: "absent" });
      throw Object.assign(new Error(`reviewable path disappeared or is unavailable: ${relative}`), { code: "WORKTREE_CHANGED", cause: error });
    }
    if (stat.isSymbolicLink()) throw Object.assign(new Error(`reviewable path traverses a symlink: ${relative}`), { code: "UNSAFE_WORKTREE_ENTRY" });
    if (index < components.length - 1) {
      if (!stat.isDirectory()) throw Object.assign(new Error(`reviewable parent is not a directory: ${relative}`), { code: "UNSAFE_WORKTREE_ENTRY" });
      continue;
    }
    if (!stat.isFile()) throw Object.assign(new Error(`reviewable path is not a regular file: ${relative}`), { code: "UNSAFE_WORKTREE_ENTRY" });
  }
  const fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw Object.assign(new Error(`reviewable path is not a regular file: ${relative}`), { code: "UNSAFE_WORKTREE_ENTRY" });
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const fields = (value) => ({
      dev: String(value.dev), ino: String(value.ino), mode: String(value.mode), size: String(value.size),
      mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs),
    });
    if (JSON.stringify(fields(before)) !== JSON.stringify(fields(after))) {
      throw Object.assign(new Error(`reviewable path changed while being read: ${relative}`), { code: "WORKTREE_CHANGED" });
    }
    return Object.freeze({ kind: "file", ...fields(after), sha256: sha256(bytes) });
  } finally { fs.closeSync(fd); }
}

function stagingPlan(status) {
  const records = parsePorcelainV1Z(status);
  const runtimeRecords = records.filter(runtimeMetadataRecord);
  const reviewableRecords = records.filter((record) => !runtimeMetadataRecord(record));
  const requirements = new Map();
  const changedPaths = new Set();
  for (const record of reviewableRecords) {
    const currentMissing = record.xy.includes("D");
    requirements.set(record.current, { allowMissing: currentMissing });
    changedPaths.add(record.current);
    if (record.original && record.xy.includes("R")) changedPaths.add(record.original);
  }
  const paths = [...requirements.keys()].sort();
  return { records, runtimeRecords, reviewableRecords, requirements, paths, changedPaths: [...changedPaths].sort() };
}

function fingerprintPlan(worktree, plan) {
  return new Map(plan.paths.map((relative) => [relative, pathFingerprint(worktree, relative, plan.requirements.get(relative))]));
}

function assertFingerprints(worktree, plan, expected, label) {
  for (const relative of plan.paths) {
    const actual = pathFingerprint(worktree, relative, plan.requirements.get(relative));
    if (!sameFingerprint(actual, expected.get(relative))) {
      throw Object.assign(new Error(`${label}: reviewable path changed: ${relative}`), { code: "WORKTREE_CHANGED" });
    }
  }
}

function recordSignature(records) {
  return JSON.stringify(records.map(({ xy, current, original }) => ({ xy, current, original })).sort((a, b) => (
    `${a.current}\0${a.original || ""}\0${a.xy}`.localeCompare(`${b.current}\0${b.original || ""}\0${b.xy}`)
  )));
}

function parseCachedRaw(raw) {
  const tokens = [];
  let offset = 0;
  while (offset < raw.length) {
    const end = raw.indexOf(0, offset);
    if (end < 0) throw Object.assign(new Error("unterminated cached raw record"), { code: "INVALID_GIT_INDEX" });
    tokens.push(raw.subarray(offset, end));
    offset = end + 1;
  }
  const records = [];
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++].toString("ascii");
    const match = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(header);
    if (!match || match[3] === "R" || match[3] === "C" || index >= tokens.length) {
      throw Object.assign(new Error("malformed or rename-detected cached raw record"), { code: "INVALID_GIT_INDEX" });
    }
    records.push({ oldMode: match[1], newMode: match[2], status: match[3], path: decodeGitPath(tokens[index++]) });
  }
  return records;
}

function parseIndexEntries(raw) {
  const entries = [];
  let offset = 0;
  while (offset < raw.length) {
    const end = raw.indexOf(0, offset);
    if (end < 0) throw Object.assign(new Error("unterminated ls-files record"), { code: "INVALID_GIT_INDEX" });
    const token = raw.subarray(offset, end);
    offset = end + 1;
    const tab = token.indexOf(0x09);
    const header = tab < 0 ? "" : token.subarray(0, tab).toString("ascii");
    const match = /^(\d{6}) [0-9a-f]+ (\d+)$/.exec(header);
    if (!match) throw Object.assign(new Error("malformed ls-files --stage record"), { code: "INVALID_GIT_INDEX" });
    entries.push({ mode: match[1], stage: Number(match[2]), path: decodeGitPath(token.subarray(tab + 1)) });
  }
  return entries;
}

function restoreIndexTree(worktree, tree) {
  execGit(worktree, ["read-tree", tree]);
  const restored = execGit(worktree, ["write-tree"]);
  if (restored !== tree) throw Object.assign(new Error("failed to restore the exact pre-recovery index tree"), { code: "INDEX_ROLLBACK_FAILED" });
}

function stageReviewableWork(worktree, status, { fault = null } = {}) {
  const plan = stagingPlan(status);
  if (!plan.paths.length) throw Object.assign(new Error("reviewable dirt produced an empty explicit path set"), { code: "EMPTY_REVIEWABLE_PATH_SET" });
  const beforeTree = execGit(worktree, ["write-tree"]);
  const fingerprints = fingerprintPlan(worktree, plan);
  let committed = false;
  try {
    fault?.("after_snapshot", { worktree, plan });
    assertFingerprints(worktree, plan, fingerprints, "pre-stage revalidation");
    fault?.("before_git_add", { worktree, plan });
    assertFingerprints(worktree, plan, fingerprints, "immediate pre-stage revalidation");
    execGit(worktree, ["--literal-pathspecs", "add", "-A", "--", ...plan.paths]);
    fault?.("after_git_add", { worktree, plan });
    assertFingerprints(worktree, plan, fingerprints, "post-stage revalidation");

    const freshBytes = gitBytes(worktree, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const fresh = stagingPlan(freshBytes);
    if (recordSignature(fresh.runtimeRecords) !== recordSignature(plan.runtimeRecords)) {
      throw Object.assign(new Error("runtime metadata changed during staging"), { code: "WORKTREE_CHANGED" });
    }
    if (JSON.stringify(fresh.paths) !== JSON.stringify(plan.paths) || fresh.reviewableRecords.some((record) => record.xy[1] !== " ")) {
      throw Object.assign(new Error("reviewable path set changed during staging"), { code: "WORKTREE_CHANGED" });
    }

    const raw = parseCachedRaw(gitBytes(worktree, ["diff", "--cached", "--raw", "-z", "--no-renames"]));
    const cachedPaths = [...new Set(raw.map((record) => record.path))].sort();
    if (JSON.stringify(cachedPaths) !== JSON.stringify(plan.changedPaths)) {
      throw Object.assign(new Error("cached path set differs from the explicit reviewable set"), { code: "INVALID_GIT_INDEX" });
    }
    for (const record of raw) {
      const allowedModes = new Set(["000000", "100644", "100755"]);
      if (!allowedModes.has(record.oldMode) || !allowedModes.has(record.newMode)) {
        throw Object.assign(new Error(`unsupported cached mode ${record.oldMode}->${record.newMode}: ${record.path}`), { code: "INVALID_GIT_INDEX" });
      }
    }
    const index = parseIndexEntries(gitBytes(worktree, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...plan.paths]));
    const expectedPresent = plan.paths.filter((relative) => fingerprints.get(relative).kind === "file").sort();
    const indexedPaths = [...new Set(index.map((entry) => entry.path))].sort();
    if (JSON.stringify(indexedPaths) !== JSON.stringify(expectedPresent)
      || index.some((entry) => entry.stage !== 0 || !new Set(["100644", "100755"]).has(entry.mode))) {
      throw Object.assign(new Error("staged index entries are not exact regular executable/non-executable files"), { code: "INVALID_GIT_INDEX" });
    }
    const stagedTree = execGit(worktree, ["write-tree"]);
    committed = true;
    return Object.freeze({ beforeTree, stagedTree, paths: Object.freeze([...plan.paths]), rollback: () => restoreIndexTree(worktree, beforeTree) });
  } finally {
    if (!committed) restoreIndexTree(worktree, beforeTree);
  }
}

function commitVerifiedStaging(worktree, staged, { runId, reason, expectedHead, fault = null }) {
  let commitSha = null;
  let refUpdated = false;
  try {
    const message = `Recover relay run ${runId}\n\nReason: ${reason}\n`;
    commitSha = execGit(worktree, ["commit-tree", staged.stagedTree, "-p", expectedHead], { input: message });
    fault?.("after_commit_object", { commitSha });
    execGit(worktree, ["update-ref", "-m", `relay recovery ${runId}`, "HEAD", commitSha, expectedHead]);
    refUpdated = true;
    fault?.("after_ref_update", { commitSha });
    if (execGit(worktree, ["rev-parse", "HEAD"]) !== commitSha
      || execGit(worktree, ["rev-parse", "HEAD^{tree}"]) !== staged.stagedTree) {
      throw Object.assign(new Error("recovery commit did not publish the exact verified tree"), { code: "INVALID_RECOVERY_COMMIT" });
    }
    return commitSha;
  } catch (error) {
    let refRollbackError = null;
    let indexRollbackError = null;
    if (refUpdated) {
      try { execGit(worktree, ["update-ref", "-m", `rollback relay recovery ${runId}`, "HEAD", expectedHead, commitSha]); }
      catch (rollbackError) { refRollbackError = rollbackError; }
    }
    try { staged.rollback(); }
    catch (rollbackError) { indexRollbackError = rollbackError; }
    if (refRollbackError || indexRollbackError) {
      const failures = [error, refRollbackError, indexRollbackError].filter(Boolean);
      const details = [
        refRollbackError ? `ref rollback failed: ${refRollbackError.message}` : null,
        indexRollbackError ? `index rollback failed: ${indexRollbackError.message}` : null,
      ].filter(Boolean).join("; ");
      const combined = new AggregateError(failures, `recovery failed: ${error.message}; ${details}`, { cause: error });
      combined.code = refRollbackError && indexRollbackError
        ? "RECOVERY_ROLLBACK_FAILED"
        : refRollbackError ? "REF_ROLLBACK_FAILED" : "INDEX_ROLLBACK_FAILED";
      throw combined;
    }
    throw error;
  }
}
function resolveGithubObserverToken(cwd) {
  const direct = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (direct) return direct;
  try {
    const token = String(execGh(cwd, ["auth", "token"], { timeout: 10_000 })).trim();
    if (token) return token;
  } catch {}
  const error = new Error(
    "isolated GitHub revalidation requires GH_TOKEN/GITHUB_TOKEN or credentials available through `gh auth login`",
  );
  error.code = "GITHUB_AUTH_REQUIRED";
  throw error;
}
function observeGithub(runRecord, { localHeadSha = null, recordedPrNumber = null } = {}) {
  const { remote } = runRecord.repo;
  const { branch, base_branch: baseBranch } = runRecord.git;
  try {
    const rows = JSON.parse(execGh(runRecord.repo.root, [
      "pr", "list", "--repo", remote, "--head", branch, "--state", "all", "--limit", "100",
      "--json", "number,state,url,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner,isCrossRepository,mergedAt,mergeCommit,body",
    ], { timeout: 15_000 }));
    const selection = selectGithubPr(rows, { remote, branch, baseBranch, localHeadSha, recordedPrNumber });
    const pr = selection.pr;
    return {
      available: true,
      lookup_complete: true,
      pr_lookup_complete: true,
      matching_pr_count: selection.matchingPrCount, identity_match_count: selection.identityMatchCount,
      open_pr_count: selection.openPrCount, merged_pr_count: selection.mergedPrCount,
      closed_pr_count: selection.closedPrCount,
      repo: remote,
      pr_number: pr?.number || null, pr_state: pr?.state || null,
      head_ref: pr?.headRefName || branch, base_ref: pr?.baseRefName || baseBranch,
      head_repo: pr ? selection.headRepo(pr) : remote,
      pr_head_sha: pr?.headRefOid || null, merge_sha: pr?.mergeCommit?.oid || null,
      url: pr?.url || null, body: pr?.body || null,
    };
  } catch (error) {
    return {
      available: false, lookup_complete: false, pr_lookup_complete: false, matching_pr_count: null,
      repo: remote,
      pr_number: null, pr_state: null, head_ref: branch, base_ref: baseBranch,
      pr_head_sha: null, merge_sha: null,
      error: commandFailure(error),
    };
  }
}
function externalMergeObserver(record) {
  const token = resolveGithubObserverToken(record.repo.root);
  const expectedRepo = JSON.stringify(record.repo.remote);
  const expectedHead = JSON.stringify(record.git.branch);
  const expectedBase = JSON.stringify(record.git.base_branch);
  const code = [
    "const fs=require('fs'),{execFileSync}=require('child_process');",
    "const i=process.argv.indexOf('--request-file');",
    "if(i<0)throw new Error('missing request');",
    "const input=JSON.parse(fs.readFileSync(process.argv[i+1],'utf8'));",
    "const q=input.request;",
    `const repo=${expectedRepo};`,
    "const b=process.argv.indexOf('--gh-bin');",
    "const bin=b>=0?process.argv[b+1]:'gh';",
    "const ghArgs=['pr','view',String(q.pr_number),'--repo',repo,'--json','number,state,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner,isCrossRepository,mergeCommit'];",
    "const nodeScript=process.argv.includes('--gh-node-script');",
    "const raw=execFileSync(nodeScript?process.execPath:bin,nodeScript?[bin,...ghArgs]:ghArgs,{encoding:'utf8',stdio:['ignore','pipe','pipe']});",
    "const p=JSON.parse(raw);",
    "const hr=p.headRepository&&p.headRepository.nameWithOwner||(p.headRepositoryOwner&&p.headRepositoryOwner.login&&p.headRepository&&p.headRepository.name?`${p.headRepositoryOwner.login}/${p.headRepository.name}`:null);",
    `if((q.repo&&q.repo!==repo)||p.headRefName!==${expectedHead}||p.baseRefName!==${expectedBase}||hr!==repo)throw new Error('exact PR repo/head/base identity mismatch');`,
    "process.stdout.write(JSON.stringify({nonce:input.nonce,repo,head_repo:hr,pr_number:p.number,pr_state:p.state,pr_head_sha:p.headRefOid,head_ref:p.headRefName,base_ref:p.baseRefName,merge_sha:p.mergeCommit&&p.mergeCommit.oid}));",
  ].join("");
  const args = [
    { kind: "literal", value: "-e" },
    { kind: "literal", value: code },
    { kind: "literal", value: "--" },
  ];
  if (process.env.RELAY_GH_BIN) {
    args.push(
      { kind: "literal", value: "--gh-bin" },
      { kind: "staged_file", value: path.resolve(process.env.RELAY_GH_BIN) },
    );
    if (path.extname(process.env.RELAY_GH_BIN) === ".js") {
      args.push({ kind: "literal", value: "--gh-node-script" });
    }
  }
  return {
    command: process.execPath,
    args,
    networkAccess: "enabled",
    runtimeDependencies: { executableParent: 1, interpreterParent: null },
    // Resolve credentials in the trusted parent and disclose the ephemeral
    // token only to this isolated observer, never to a reviewer process.
    env: { GH_TOKEN: token },
    request: {
      repo: record.repo.remote,
    },
  };
}
async function observeProduction({
  runDir,
  runRecord,
  facts: runFacts,
  verificationFile = null,
  activeRecoveryLock = null,
}) {
  const worktree = fs.realpathSync(runRecord.git.worktree);
  if (!fs.statSync(worktree).isDirectory()) throw new Error("run worktree is not a directory");
  const branch = execGit(worktree, ["--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== runRecord.git.branch) throw new Error(`worktree branch ${branch} does not match run identity`);
  const headSha = execGit(worktree, ["--no-optional-locks", "rev-parse", "HEAD"]);
  const treeSha = execGit(worktree, ["--no-optional-locks", "rev-parse", "HEAD^{tree}"]);
  const status = gitBytes(worktree, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const dirt = classifyRepositoryDirt(status);
  const unsafeEntries = unsafeWorktreeEntries(worktree, status);
  const remoteName = resolveBranchRemote(worktree, branch);
  let remoteUrl = null;
  let remoteHeadSha = null;
  const blockers = [];
  try {
    remoteUrl = execGit(worktree, ["--no-optional-locks", "remote", "get-url", remoteName]);
    if (
      normalizedRemoteIdentity(remoteUrl, worktree)
      !== normalizedRemoteIdentity(runRecord.repo.remote, worktree)
    ) {
      blockers.push({
        code: "remote_identity_mismatch",
        message: "tracked Git remote does not match the immutable run repository",
        retryable: false,
      });
    }
    const remoteLine = execGit(worktree, [
      "--no-optional-locks", "ls-remote", "--heads", remoteName, `refs/heads/${branch}`,
    ]);
    remoteHeadSha = remoteLine ? remoteLine.split(/\s+/)[0] : null;
  } catch (error) {
    blockers.push({ code: "remote_observation_failed", message: commandFailure(error), retryable: true });
  }
  const remoteRelation = safeRelation(worktree, remoteHeadSha, headSha);
  if (remoteRelation === "unknown") {
    blockers.push({
      code: "remote_relation_unknown",
      message: "remote head object is unavailable locally; recover will not push from an unproven relation",
      retryable: true,
    });
  }
  const recordedPr = runFacts.filter((fact) => fact.type === "pull_request_recorded").at(-1) || null;
  const github = observeGithub(runRecord, {
    localHeadSha: headSha,
    recordedPrNumber: recordedPr?.payload.pr_number || null,
  });
  if (!github.available) {
    blockers.push({ code: "github_unavailable", message: github.error, retryable: true });
  }
  let hostObservation = { status: "absent" };
  if (unsafeEntries.length) {
    blockers.push({
      code: "unsafe_worktree_entry",
      message: `worktree contains unsupported special entries: ${unsafeEntries.join(", ")}`,
      retryable: false,
      details: { paths: unsafeEntries },
    });
    hostObservation = { status: "unknown", reason: "unsafe_worktree_entry" };
  }
  if (!unsafeEntries.length && fs.existsSync(path.join(runDir, "ownership"))) {
    try {
      hostObservation = host.inspectOwnership({ runDir });
      if (
        activeRecoveryLock
        && hostObservation.owner?.lock_id === activeRecoveryLock.lock_id
        && hostObservation.owner?.operation === activeRecoveryLock.operation
      ) {
        hostObservation = {
          status: "absent",
          reason: `current_${activeRecoveryLock.operation}_lock_is_not_executor_liveness`,
        };
      }
    } catch (error) {
      blockers.push({ code: "host_observation_failed", message: error.message, retryable: true });
      hostObservation = { status: "unknown" };
    }
  }
  return {
    git: {
      head_sha: headSha,
      tree_sha: treeSha,
      branch,
      base_branch: runRecord.git.base_branch,
      reviewable_work: dirt.hasReviewableDirt || headSha !== runRecord.git.start_sha,
      reviewable_dirty: dirt.hasReviewableDirt,
      tree_differs_from_start: dirt.hasReviewableDirt,
      branch_commit_exists: headSha !== runRecord.git.start_sha,
      remote_name: remoteName,
      remote_url: remoteUrl,
      repo_remote: runRecord.repo.remote,
      remote_head_sha: remoteHeadSha,
      remote_relation: remoteRelation,
      status: status.toString("utf8"),
    },
    github,
    host: {
      status: hostObservation.status,
      cleanup_pending: hostObservation.reason === "cleanup_incomplete",
      live: hostObservation.status === "live"
        ? true
        : new Set(["absent", "stale"]).has(hostObservation.status) || hostObservation.reason === "cleanup_incomplete" ? false : null,
    },
    // Input availability is deliberately excluded from observations. The same
    // durable/external state must produce the same action key during inspect
    // and recover; the effect consumes verificationFile only after the key is
    // accepted under the run lock.
    verification: {},
    blockers,
  };
}
const defaultSnapshot = inspect.defaultSnapshot;
const inspectRun = inspect.inspectRun;
const recoverySteps = inspect.recoverySteps;
function blocker(code, message, retryable = false, details = {}) { return { code, message, retryable, details }; }
function deterministicEventId(operationId, step) { return `recovery-${sha256(`${operationId}:${step}`).slice(0, 32)}`; }
function validateRecoveryIntent(intent) {
  const expectedKeys = [
    "action_key", "actor", "before_sha", "created_at", "observed_event_id",
    "operation_id", "reason", "reason_code", "schema_version", "steps",
  ];
  if (!intent || typeof intent !== "object" || Array.isArray(intent)
    || JSON.stringify(Object.keys(intent).sort()) !== JSON.stringify(expectedKeys)
    || intent.schema_version !== 1
    || !/^[0-9a-f]{64}$/.test(intent.action_key)
    || intent.operation_id !== `recover-${intent.action_key.slice(0, 32)}`
    || typeof intent.created_at !== "string" || Number.isNaN(Date.parse(intent.created_at))
    || !Array.isArray(intent.steps) || new Set(intent.steps).size !== intent.steps.length
    || intent.steps.some((step) => !RECOVERY_STEPS.has(step))
    || typeof intent.actor !== "string" || !intent.actor.trim()
    || typeof intent.reason !== "string" || !intent.reason.trim()
    || typeof intent.reason_code !== "string" || !intent.reason_code.trim()
    || typeof intent.observed_event_id !== "string" || !intent.observed_event_id.trim()
    || (intent.before_sha !== null && !/^[0-9a-f]{40}$/i.test(intent.before_sha))
  ) throw new Error("active recovery intent is malformed");
  return intent;
}
function validateRecoveryReceipt(receipt, { actionKey: actionKeyValue, facts }) {
  const expectedKeys = ["action_key", "fact_event_ids", "operation_id", "schema_version"];
  const operationId = `recover-${actionKeyValue.slice(0, 32)}`;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedKeys)
    || receipt.schema_version !== 1
    || receipt.action_key !== actionKeyValue
    || receipt.operation_id !== operationId
    || !Array.isArray(receipt.fact_event_ids) || receipt.fact_event_ids.length === 0
    || new Set(receipt.fact_event_ids).size !== receipt.fact_event_ids.length
    || receipt.fact_event_ids.some((eventId) => typeof eventId !== "string" || !eventId)
  ) throw new Error("recovery receipt schema or identity is invalid");
  const byId = new Map(facts.map((fact) => [fact.event_id, fact]));
  if (receipt.fact_event_ids.some((eventId) => !byId.has(eventId))) throw new Error("recovery receipt references a missing durable fact");
  const recoveryEventId = deterministicEventId(operationId, "recovery_applied");
  const hasRecoveryFact = receipt.fact_event_ids.includes(recoveryEventId)
    && byId.get(recoveryEventId)?.type === "recovery_applied";
  const hasTerminalMergeFact = receipt.fact_event_ids.some((eventId) => {
    const fact = byId.get(eventId);
    return fact?.type === "merge_recorded" && fact.payload?.operation_id === operationId;
  });
  if (!hasRecoveryFact && !hasTerminalMergeFact) throw new Error("recovery receipt is not bound to a completion fact");
  return receipt;
}
function recoveryAppliedFact({ runId, intent, after, applied }) {
  const stepEventIds = new Set(applied.map((entry) => entry.fact_event_id).filter(Boolean));
  const durableOutcomeSha = after.facts.filter((fact) => stepEventIds.has(fact.event_id))
    .map((fact) => fact.payload?.head_sha || fact.payload?.last_known_sha || null).filter(Boolean).at(-1);
  return {
    event_id: deterministicEventId(intent.operation_id, "recovery_applied"),
    run_id: runId,
    type: "recovery_applied",
    at: intent.created_at,
    actor: intent.actor,
    payload: {
      rule: intent.reason_code,
      observed_event_id: intent.observed_event_id,
      before_sha: intent.before_sha,
      // Bind retries to immutable step facts, not a freshly observed HEAD.
      after_sha: durableOutcomeSha || intent.before_sha || null,
      side_effects: [...intent.steps],
      reason: intent.reason,
      operator: intent.actor,
    },
  };
}
function recoveryReceipt(operationId, actionKeyValue, factEventIds) {
  return {
    schema_version: 1,
    operation_id: operationId,
    action_key: actionKeyValue,
    fact_event_ids: factEventIds,
  };
}
function recoverResult({
  before,
  status,
  operationId,
  actionKeyValue,
  blockers = [],
  applied = [],
  receipt = null,
  after = before,
}) {
  return {
    schema_version: 1,
    operation: "recover",
    run_id: before.run_id,
    status,
    operation_id: operationId,
    action_key: actionKeyValue,
    blockers,
    before,
    applied,
    receipt,
    after,
  };
}
async function recoverRun({
  runDir,
  observer,
  actor,
  reason,
  expectedActionKey = null,
  withLock,
  effects,
  appendFact,
  readIntent = async () => null,
  writeIntent,
  readReceipt = async () => null,
  writeReceipt,
  readSnapshot = defaultSnapshot,
} = {}) {
  if (typeof withLock !== "function") throw new Error("recoverRun requires an exclusive withLock function");
  if (!effects || typeof effects.converge !== "function") {
    throw new Error("recoverRun requires idempotent effects.converge");
  }
  if (
    typeof appendFact !== "function"
    || typeof writeIntent !== "function"
    || typeof writeReceipt !== "function"
  ) {
    throw new Error("recoverRun requires appendFact, writeIntent, and writeReceipt functions");
  }
  if (typeof actor !== "string" || !actor.trim()) throw new Error("recoverRun requires actor");
  if (typeof reason !== "string" || !reason.trim()) throw new Error("recoverRun requires reason");
  actor = actor.trim();
  reason = reason.trim();
  if (expectedActionKey !== null && !/^[0-9a-f]{64}$/.test(expectedActionKey)) {
    throw new Error("expectedActionKey must be a lowercase SHA-256 digest");
  }
  return withLock(async () => {
    const before = await inspectRun({ runDir, observer, readSnapshot });
    // A caller retrying a completed inspected action is already converged even
    // when the fresh post-recovery action has changed. Re-observation still
    // happens under the lock, but no intent/effect/fact/receipt write follows.
    if (expectedActionKey) {
      const completedCandidate = await readReceipt({
        runDir,
        actionKey: expectedActionKey,
        operationId: `recover-${expectedActionKey.slice(0, 32)}`,
      });
      const completed = completedCandidate && validateRecoveryReceipt(completedCandidate, {
        actionKey: expectedActionKey,
        facts: before.facts,
      });
      if (completed) {
        return recoverResult({
          before,
          status: "noop",
          operationId: completed.operation_id,
          actionKeyValue: expectedActionKey,
          receipt: completed,
        });
      }
    }
    let intent = await readIntent({ runDir, facts: before.facts });
    const freshActionKey = before.recommended_action.key;
    if (intent) validateRecoveryIntent(intent);
    const actionKeyValue = intent?.action_key || freshActionKey;
    const operationId = intent?.operation_id || `recover-${actionKeyValue.slice(0, 32)}`;
    if (expectedActionKey && expectedActionKey !== actionKeyValue) {
      return recoverResult({
        before,
        status: "refused",
        operationId,
        actionKeyValue,
        blockers: [blocker("stale_action", "inspect action changed before recovery", true)],
      });
    }
    if (!intent && (before.derived.terminal === true || before.recommended_action.kind === "none")) {
      return recoverResult({
        before,
        status: "noop",
        operationId,
        actionKeyValue,
        blockers: before.blockers,
      });
    }
    if (!intent && before.recommended_action.kind !== "recover") {
      return recoverResult({
        before,
        status: "refused",
        operationId,
        actionKeyValue,
        blockers: before.blockers.length
          ? before.blockers
          : [blocker("action_not_recoverable", `derived action is ${before.recommended_action.kind}`)],
      });
    }
    const existingReceiptCandidate = await readReceipt({ runDir, actionKey: actionKeyValue, operationId });
    const existingReceipt = existingReceiptCandidate && validateRecoveryReceipt(existingReceiptCandidate, {
      actionKey: actionKeyValue,
      facts: before.facts,
    });
    if (existingReceipt) {
      return recoverResult({
        before,
        status: "noop",
        operationId,
        actionKeyValue,
        receipt: existingReceipt,
      });
    }
    if (!intent) {
      intent = {
        schema_version: 1,
        action_key: actionKeyValue,
        operation_id: operationId,
        created_at: new Date().toISOString(),
        steps: [...before.recommended_action.steps],
        actor,
        reason,
        reason_code: before.recommended_action.reason,
        observed_event_id: before.snapshot.last_event_id || operationId,
        before_sha: before.derived.head_sha || null,
      };
      await writeIntent({ runDir, intent });
    } else if (intent.actor !== actor || intent.reason !== reason) {
      return recoverResult({
        before, status: "refused", operationId, actionKeyValue,
        blockers: [blocker(
          "active_intent_identity_mismatch",
          "active recovery intent belongs to a different actor or reason; preserve it for audited operator resolution",
          false,
        )],
      });
    }
    if (intent && before.recommended_action.kind === "operator_attention") {
      return recoverResult({
        before, status: "refused", operationId, actionKeyValue,
        blockers: [blocker(
          "active_intent_observation_changed",
          "live observations no longer authorize the active recovery intent; preserve it for audited operator resolution",
          false,
        ), ...before.blockers],
      });
    }
    // An effect may have reached a durable terminal fact before its receipt was
    // published. Never append a non-terminal recovery fact after that terminal;
    // the immutable intent is sufficient to finish the receipt.
    if (before.derived.terminal === true) {
      const matchingTerminalFacts = before.facts.filter((fact) => (
        fact.type === "merge_recorded" && fact.payload.operation_id === operationId
      ));
      if (matchingTerminalFacts.length !== 1) {
        return recoverResult({
          before,
          status: "refused",
          operationId,
          actionKeyValue,
          blockers: [blocker(
            "terminal_intent_mismatch",
            "terminal run is not bound to the active recovery operation",
          )],
        });
      }
      const receipt = recoveryReceipt(operationId, actionKeyValue, matchingTerminalFacts.map((fact) => fact.event_id));
      await writeReceipt({ runDir, actionKey: actionKeyValue, operationId, receipt });
      return recoverResult({
        before,
        status: "converged",
        operationId,
        actionKeyValue,
        receipt,
      });
    }
    const applied = [];
    for (const step of intent.steps) {
      const result = await effects.converge(step, {
        runDir,
        runId: before.run_id,
        operationId,
        actionKey: actionKeyValue,
        actor,
        reason,
        intent,
        before,
      });
      if (result?.blockers?.length) {
        return recoverResult({
          before, status: "refused", operationId, actionKeyValue,
          blockers: result.blockers, applied,
        });
      }
      if (!result || result.converged !== true) {
        throw new Error(`recovery step ${step} did not converge`);
      }
      let factEventId = null;
      if (result.fact) {
        const fact = {
          ...result.fact,
          event_id: deterministicEventId(operationId, step),
          run_id: before.run_id,
        };
        await appendFact(fact);
        factEventId = fact.event_id;
      }
      applied.push({
        step,
        status: result.applied === false ? "already_converged" : "applied",
        fact_event_id: factEventId,
      });
    }
    const afterEffects = await inspectRun({ runDir, observer, readSnapshot });
    if (afterEffects.derived.terminal === true) {
      const receipt = recoveryReceipt(
        operationId,
        actionKeyValue,
        afterEffects.facts
          .filter((fact) => fact.type === "merge_recorded" && fact.payload.operation_id === operationId)
          .map((fact) => fact.event_id),
      );
      await writeReceipt({ runDir, actionKey: actionKeyValue, operationId, receipt });
      return recoverResult({
        before,
        status: "converged",
        operationId,
        actionKeyValue,
        applied,
        receipt,
        after: afterEffects,
      });
    }
    const recoveryFact = recoveryAppliedFact({ runId: before.run_id, intent, after: afterEffects, applied });
    await appendFact(recoveryFact);
    const after = await inspectRun({ runDir, observer, readSnapshot });
    const receipt = recoveryReceipt(operationId, actionKeyValue, [
        ...applied.map((entry) => entry.fact_event_id).filter(Boolean),
        recoveryFact.event_id,
    ]);
    await writeReceipt({ runDir, actionKey: actionKeyValue, operationId, receipt });
    return recoverResult({
      before,
      status: "converged",
      operationId,
      actionKeyValue,
      blockers: after.blockers,
      applied,
      receipt,
      after,
    });
  });
}
function readVerificationPayload(filePath, { record, observed, actor }) {
  if (!filePath) throw new Error("record_verification requires an immutable verification file");
  const source = readArtifact(filePath, "verification source");
  const payload = JSON.parse(source.bytes.toString("utf8"));
  const expectedKeys = [
    "commands", "completed_commands", "done_criteria_sha256", "head_sha",
    "operator", "result_path", "result_sha256", "schema_version", "tree_sha",
  ];
  if (
    !payload || typeof payload !== "object" || Array.isArray(payload)
    || JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expectedKeys)
    || payload.schema_version !== 1
    || !Array.isArray(payload.commands) || payload.commands.length === 0
    || payload.commands.some((command) => typeof command !== "string" || !command.trim())
    || !Array.isArray(payload.completed_commands)
    || payload.completed_commands.length > payload.commands.length
  ) {
    throw new Error("verification source schema is not closed or complete");
  }
  payload.completed_commands.forEach((result, index) => {
    if (
      !result || typeof result !== "object" || Array.isArray(result)
      || JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(["command", "exit_code"])
      || result.command !== payload.commands[index]
      || !Number.isInteger(result.exit_code) || result.exit_code < 0
    ) {
      throw new Error(`verification completed_commands[${index}] is invalid or out of request order`);
    }
  });
  const expected = {
    head_sha: observed.git.head_sha,
    tree_sha: observed.git.tree_sha,
    done_criteria_sha256: record.contract.done_criteria_sha256,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (payload[field] !== value) throw new Error(`verification ${field} does not match the fresh recovery observation`);
  }
  if (payload.operator !== actor) throw new Error("verification operator does not match recovery actor");
  const allCompleted = payload.completed_commands.length === payload.commands.length;
  const failed = payload.completed_commands.find((result) => result.exit_code !== 0);
  if (!allCompleted || failed) throw new Error("only complete passing structured verification can converge recovery");
  const result = readArtifact(payload.result_path, "verification result");
  if (result.sha256 !== payload.result_sha256) {
    throw new Error("verification result_sha256 does not match result_path bytes");
  }
  const request = { schema_version: 1, commands: payload.commands };
  return {
    head_sha: payload.head_sha,
    tree_sha: payload.tree_sha,
    done_criteria_sha256: payload.done_criteria_sha256,
    command: payload.commands.join(" && "),
    verification_request_sha256: sha256(JSON.stringify(stable(request))),
    declared_command_count: payload.commands.length,
    completed_command_count: payload.completed_commands.length,
    result_path: result.path,
    result_sha256: payload.result_sha256,
    exit_code: 0,
    status: "passed",
    operator: payload.operator,
  };
}
function assertCleanVerificationObservation(observed) {
  if (observed.git.reviewable_dirty === true) {
    throw new Error("refusing verification while the reviewable worktree is dirty");
  }
}
function createProductionEffects({ verificationFile = null, getLockContext = () => null } = {}) {
  return {
    async converge(step, context) {
      const snapshot = defaultSnapshot(context.runDir);
      const record = snapshot.runRecord;
      const worktree = record.git.worktree;
      const observed = await observeProduction({
        runDir: context.runDir,
        runRecord: record,
        facts: snapshot.facts,
        verificationFile,
        activeRecoveryLock: getLockContext(),
      });
      if (observed.blockers.length) {
        throw new Error(`recovery observation blocked: ${observed.blockers[0].code}`);
      }
      if (step === "close_dead_attempt") {
        if (observed.host.live !== false) throw new Error("attempt liveness is not proven dead");
        const start = snapshot.facts.filter((fact) => fact.type === "attempt_started").at(-1);
        if (!start) return { converged: true, applied: false };
        const terminal = snapshot.facts.some((fact) => (
          fact.attempt_id === start.attempt_id
          && new Set(["attempt_finished", "attempt_interrupted"]).has(fact.type)
        ));
        if (terminal) return { converged: true, applied: false };
        return {
          converged: true,
          applied: true,
          fact: {
            attempt_id: start.attempt_id,
            type: "attempt_interrupted",
            at: context.intent.created_at,
            actor: context.actor,
            payload: {
              last_known_sha: observed.git.head_sha,
              reason: context.reason,
              host_liveness: "dead",
              reviewable_work: observed.git.reviewable_work,
            },
          },
        };
      }
      if (step === "commit_work") {
        if (!observed.git.reviewable_dirty) return { converged: true, applied: false };
        const staged = stageReviewableWork(worktree, observed.git.status);
        commitVerifiedStaging(worktree, staged, {
          runId: context.runId,
          reason: context.reason,
          expectedHead: observed.git.head_sha,
        });
        return { converged: true, applied: true };
      }
      if (step === "push_branch") {
        if (observed.git.remote_head_sha === observed.git.head_sha) {
          return { converged: true, applied: false };
        }
        if (observed.git.remote_relation !== "behind_local") {
          throw new Error(`refusing push from remote relation ${observed.git.remote_relation}`);
        }
        execGit(worktree, ["push", "-u", observed.git.remote_name, record.git.branch]);
        const after = await observeProduction({
          runDir: context.runDir, runRecord: record, facts: snapshot.facts,
          activeRecoveryLock: getLockContext(),
        });
        if (after.git.remote_head_sha !== after.git.head_sha) {
          throw new Error("remote branch does not contain the exact recovery HEAD after push");
        }
        return { converged: true, applied: true };
      }
      if (step === "record_verification") {
        assertCleanVerificationObservation(observed);
        const payload = readVerificationPayload(verificationFile, {
          record,
          observed,
          actor: context.actor,
        });
        const existing = snapshot.facts.find((fact) => (
          fact.type === "verification_recorded"
          && fact.payload.head_sha === payload.head_sha
          && fact.payload.tree_sha === payload.tree_sha
          && fact.payload.done_criteria_sha256 === payload.done_criteria_sha256
          && fact.payload.result_sha256 === payload.result_sha256
        ));
        if (existing) return { converged: true, applied: false };
        return {
          converged: true,
          applied: true,
          fact: {
            type: "verification_recorded",
            at: context.intent.created_at,
            actor: context.actor,
            payload,
          },
        };
      }
      if (step === "record_or_create_pr") {
        if (observed.git.remote_head_sha !== observed.git.head_sha) {
          throw new Error("refusing PR publication before remote branch equals local HEAD");
        }
        let github = observed.github;
        let created = false;
        const marker = `<!-- relay-recovery-operation:${context.operationId} -->`;
        if (github.matching_pr_count === 0) {
          const title = execGit(worktree, ["log", "-1", "--format=%s", "HEAD"])
            || `Recover ${record.git.branch}`;
          try {
            execGh(worktree, [
              "pr", "create", "--repo", record.repo.remote,
              "--base", record.git.base_branch, "--head", record.git.branch,
              "--title", title,
              "--body", [
                "## Recovery Summary", "", marker, "",
                `- Run: ${record.run_id}`, `- Reason: ${context.reason}`,
              ].join("\n"),
            ], { timeout: 30_000 });
            created = true;
          } catch (createError) {
            // A concurrent publisher may have won after the zero-match
            // observation. Re-observe once and converge only if the exact
            // immutable repo/head/base/SHA identity now exists.
            github = observeGithub(record, { localHeadSha: observed.git.head_sha });
            if (github.matching_pr_count !== 1) throw createError;
          }
          if (created) github = observeGithub(record, { localHeadSha: observed.git.head_sha });
        }
        if (
          github.available !== true
          || github.matching_pr_count !== 1
          || !Number.isInteger(github.pr_number)
          || github.head_ref !== record.git.branch
          || github.base_ref !== record.git.base_branch
          || github.pr_head_sha !== observed.git.head_sha
        ) {
          throw new Error("PR publication did not re-observe one exact repo/head/base/SHA match");
        }
        if (github.pr_state !== "OPEN") {
          return {
            converged: false,
            blockers: [blocker(
              github.pr_state === "CLOSED" ? "github_pr_closed_unmerged" : "active_intent_observation_changed",
              `exact recovery PR is ${github.pr_state || "not open"}; recovery will not publish or overwrite it`,
              false,
            )],
          };
        }
        const existing = snapshot.facts.find((fact) => (
          fact.type === "pull_request_recorded"
          && fact.payload.pr_number === github.pr_number
          && fact.payload.head_sha === github.pr_head_sha
        ));
        if (existing) return { converged: true, applied: false };
        const priorIdentity = snapshot.facts.filter((fact) => (
          fact.type === "pull_request_recorded"
          && fact.payload.pr_number === github.pr_number
          && fact.payload.repo === record.repo.remote
          && fact.payload.head_ref === record.git.branch
          && fact.payload.base_ref === record.git.base_branch
        )).at(-1) || null;
        return {
          converged: true,
          applied: created,
          fact: {
            type: "pull_request_recorded",
            at: context.intent.created_at,
            actor: context.actor,
            payload: {
              pr_number: github.pr_number,
              repo: record.repo.remote,
              head_ref: record.git.branch,
              base_ref: record.git.base_branch,
              head_sha: github.pr_head_sha,
              created_by_relay: created
                || priorIdentity?.payload.created_by_relay === true
                || String(github.body || "").includes(marker),
            },
          },
        };
      }
      if (step === "record_external_merge") {
        const lockContext = getLockContext();
        if (!lockContext) throw new Error("external merge provenance requires the active run lock");
        const descriptor = externalMergeObserver(record);
        const request = {
          ...descriptor.request,
          pr_number: observed.github.pr_number,
          expected_pr_head_sha: observed.github.pr_head_sha,
          expected_result_target_sha: observed.github.merge_sha,
        };
        const fresh = await factsModule.revalidateExternalFacts({
          runDir: context.runDir,
          lockContext,
          observer: descriptor,
          request,
          authorize: (live) => {
            if (
              live.pr_number !== observed.github.pr_number
              || live.pr_state !== "MERGED"
              || live.pr_head_sha !== observed.github.pr_head_sha
              || live.head_ref !== record.git.branch
              || live.base_ref !== record.git.base_branch
              || live.merge_sha !== observed.github.merge_sha
            ) throw new Error("fresh external merge observation changed identity");
            return { authorized: true };
          },
        });
        const authorizationPath = path.join(
          context.runDir,
          `merge-authorization-${context.operationId}.json`,
        );
        const authorization = fs.existsSync(authorizationPath)
          ? factsModule.resumeOperatorMerge({
              runDir: context.runDir,
              lockContext,
              operationId: context.operationId,
              freshObservation: fresh.observationCapability,
            })
          : factsModule.planOperatorMerge({
              runDir: context.runDir,
              lockContext,
              freshObservation: fresh.observationCapability,
              operatorAction: {
                actor: context.actor,
                method: "external",
                overrideReason: context.reason,
                operationId: context.operationId,
              },
              currentHead: observed.github.pr_head_sha,
              currentDoneCriteriaSha256: record.contract.done_criteria_sha256,
              verdict: null,
              prNumber: observed.github.pr_number,
            });
        await factsModule.recordMerge({
          eventsPath: path.join(context.runDir, "events.jsonl"),
          at: context.intent.created_at,
          provenance: {
            pr_number: observed.github.pr_number,
            reviewed_source_sha: observed.github.pr_head_sha,
            pr_head_sha: observed.github.pr_head_sha,
            result_target_sha: observed.github.merge_sha,
            method: "external",
            operator: context.actor,
            override_reason: context.reason,
          },
          authorization,
          lockContext,
          observer: descriptor,
        });
        return { converged: true, applied: true };
      }
      throw new Error(`recovery step ${step} has no safe production implementation`);
    },
  };
}
async function inspectProductionRun({ runDir, activeRunLock = null } = {}) {
  if (activeRunLock !== null) host.assertRunLockHeld(activeRunLock, { runDir });
  return inspectRun({
    runDir,
    observer: (input) => observeProduction({ ...input, activeRecoveryLock: activeRunLock }),
  });
}
async function withProductionRecoveryLock({
  runDir,
  runId,
  worktree,
  reason,
  breakLock = false,
}, callback) {
  const eventsPath = path.join(runDir, "events.jsonl");
  const audit = (fragment, capability) => {
    const eventId = `host-${fragment.audit_key}`;
    const existing = factsModule.readFacts({ eventsPath }).facts.find((fact) => fact.event_id === eventId);
    const fact = factsModule.factFromHostAudit({
      runId,
      eventId,
      at: existing?.at || new Date().toISOString(),
      actor: "relay-host",
      audit: fragment,
    });
    if (existing && JSON.stringify(existing) !== JSON.stringify(fact)) throw Object.assign(
      new Error(`canonical host audit ${eventId} conflicts with its durable replay`),
      { code: "DUPLICATE_EVENT_ID" },
    );
    factsModule.appendFact({ eventsPath, lockContext: capability, fact });
    return { durable: true, idempotent: true, audit_key: fragment.audit_key };
  };
  const options = {
    runDir,
    attemptId: `recover-${crypto.randomBytes(8).toString("hex")}`,
    operation: "recover",
    hostKind: "local_supervisor",
    hostHandle: `recover:${process.pid}`,
    worktreeDir: worktree,
    audit,
  };
  let callbackStarted = false;
  const invoke = (capability) => { callbackStarted = true; return callback(capability); };
  try {
    return await host.withRunLock(options, invoke);
  } catch (error) {
    if (error?.code !== "LOCK_HELD" || callbackStarted) throw error;
  }
  if (!breakLock) throw Object.assign(
    new Error("run lock is held; explicit --break-lock is required for stale-owner recovery"),
    { code: "LOCK_HELD" },
  );
  const status = gitBytes(worktree, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const unsafeEntries = unsafeWorktreeEntries(worktree, status);
  if (unsafeEntries.length) throw Object.assign(new Error(
    `unsafe_worktree_entry: unsupported special entries prevent lock recovery: ${unsafeEntries.join(", ")}`,
  ), { code: "UNSAFE_WORKTREE_ENTRY", paths: unsafeEntries });
  const inspection = host.inspectOwnership({ runDir });
  if (!["stale", "unknown"].includes(inspection.status)) throw Object.assign(
    new Error(`existing run owner is ${inspection.status}; recovery will not break it`),
    { code: "LOCK_HELD" },
  );
  const terminalResultPath = path.join(runDir, `attempt-${inspection.owner.attempt_id}.result.json`);
  const resultPath = fs.existsSync(terminalResultPath) ? terminalResultPath : undefined;
  await host.breakStaleRunLock({
    inspection,
    reason: `Recovery ownership reclaim: ${reason}`,
    resultPath,
    audit,
  });
  return host.withRunLock(options, invoke);
}
async function recoverProductionRun({
  runDir,
  actor,
  reason,
  closeIntent = null,
  expectedActionKey = null,
  verificationFile = null,
  breakLock = false,
  activeCheckout = null,
  relayWorktreeBase = null,
} = {}) {
  const canonicalRunDir = fs.realpathSync(runDir);
  const record = readRunRecord({ runDir: canonicalRunDir });
  const trustedWorktree = assertTrustedRecoveryWorktree({
    repoRoot: record.repo.root,
    activeCheckout: activeCheckout || process.cwd(),
    relayWorktreeBase: relayWorktreeBase || runStore.relayWorktreeBase(),
    worktree: record.git.worktree,
  });
  if (closeIntent !== null) {
    if (!closeIntent || typeof closeIntent !== "object" || Array.isArray(closeIntent)
      || Object.keys(closeIntent).sort().join(",") !== "operator,reason"
      || typeof closeIntent.operator !== "string" || !closeIntent.operator.trim()
      || typeof closeIntent.reason !== "string" || !closeIntent.reason.trim()) {
      throw new Error("closeIntent must contain exactly non-empty operator and reason strings");
    }
    return withProductionRecoveryLock({
      runDir: canonicalRunDir, runId: record.run_id, worktree: trustedWorktree,
      reason: closeIntent.reason, breakLock,
    }, async (capability) => {
      const before = await inspectProductionRun({ runDir: canonicalRunDir, activeRunLock: capability });
      const closes = before.facts.filter((fact) => fact.type === "run_closed");
      const merges = before.facts.filter((fact) => fact.type === "merge_recorded");
      if (closes.length > 1 || merges.length > 1 || (closes.length && merges.length)
        || before.derived?.reason === "fact_conflict") {
        throw Object.assign(new Error("conflicting terminal merge/close facts require operator attention"), { code: "TERMINAL_FACT_CONFLICT" });
      }
      if (merges.length) throw Object.assign(new Error("a merged run cannot accept a close intent"), { code: "TERMINAL_FACT_CONFLICT" });
      if (closes.length) {
        const prior = closes[0].payload;
        if (prior.operator !== closeIntent.operator.trim() || prior.reason !== closeIntent.reason.trim()) {
          throw Object.assign(new Error("close intent conflicts with the immutable terminal fact"), { code: "TERMINAL_FACT_CONFLICT" });
        }
        return { before, after: before, closed: false, idempotent: true };
      }
      if (before.blockers?.some((item) => item.code === "snapshot_changed")) {
        throw Object.assign(new Error("run changed during close inspection; retry"), { code: "SNAPSHOT_CHANGED" });
      }
      const lastSha = before.derived?.head_sha || before.observations?.git?.head_sha || record.git.start_sha;
      const prNumber = before.derived?.pr_number || before.observations?.github?.pr_number || null;
      const payload = { reason: closeIntent.reason.trim(), operator: closeIntent.operator.trim(), last_sha: lastSha,
        pr_number: Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null };
      const eventId = `close-${sha256(JSON.stringify(stable({ run_id: record.run_id, payload }))).slice(0, 32)}`;
      factsModule.appendFact({ eventsPath: path.join(canonicalRunDir, "events.jsonl"), lockContext: capability,
        fact: { event_id: eventId, run_id: record.run_id, type: "run_closed", at: new Date().toISOString(), actor: payload.operator, payload } });
      const after = await inspectProductionRun({ runDir: canonicalRunDir, activeRunLock: capability });
      if (after.derived?.reason !== "closed" || after.derived?.terminal !== true) throw new Error("run close fact did not converge");
      return { before, after, closed: true, idempotent: false };
    });
  }
  let lockContext = null;
  const io = productionRecoveryIo(canonicalRunDir);
  const observer = (request) => observeProduction({
    ...request,
    verificationFile,
    activeRecoveryLock: lockContext,
  });
  return recoverRun({
    runDir: canonicalRunDir,
    observer,
    actor,
    reason,
    expectedActionKey,
    effects: createProductionEffects({ verificationFile, getLockContext: () => lockContext }),
    ...io,
    withLock: (callback) => withProductionRecoveryLock({
      runDir: canonicalRunDir,
      runId: record.run_id,
      worktree: trustedWorktree,
      reason,
      breakLock,
    }, async (capability) => {
      lockContext = capability;
      try {
        return await callback();
      } finally {
        lockContext = null;
      }
    }),
    appendFact: async (fact) => {
      if (!lockContext) throw new Error("recovery fact append requires the active run lock capability");
      return factsModule.appendFact({
        eventsPath: path.join(canonicalRunDir, "events.jsonl"),
        fact,
        lockContext,
      });
    },
  });
}
module.exports = {
  inspectRun,
  inspectProductionRun,
  recoverRun,
  recoverProductionRun,
  recoverStrandedWorktree,
  observeProduction,
  __testing: {
    RUNTIME_METADATA_ROOTS,
    actionKey,
    artifactDigest,
    assertCleanVerificationObservation,
    assertTrustedRecoveryWorktree,
    classifyRepositoryDirt,
    commitVerifiedStaging,
    deterministicEventId,
    recoveryAppliedFact,
    recoverySteps,
    observeStrandedWorktree,
    parsePorcelainV1Z,
    reviewableStatusPaths,
    resolveGithubObserverToken,
    selectGithubPr,
    stable,
    stageReviewableWork,
    unsafeWorktreeEntries,
  },
};
