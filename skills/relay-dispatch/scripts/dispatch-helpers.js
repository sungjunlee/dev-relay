"use strict";

/** Git identity, publication base, and retained-worktree helpers for dispatch. */

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const runStore = require("./run-store");

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

function tryGit(checkout, args) {
  try { return git(checkout, args); } catch { return null; }
}

function publicationBaseName(ref) {
  const raw = String(ref || "").trim();
  if (!raw || raw.startsWith("-")) fail(`publication base must be a branch name: ${JSON.stringify(ref)}`, "BASE_INVALID");
  const name = raw.replace(/^refs\/remotes\/origin\//, "").replace(/^refs\/heads\//, "").replace(/^origin\//, "");
  if (!name || name === "HEAD" || name.includes("..")) fail(`publication base is not a branch name: ${ref}`, "BASE_INVALID");
  return name;
}

function assertBranchName(checkout, name, label) {
  try { git(checkout, ["check-ref-format", "--branch", name]); }
  catch { fail(`${label} is not a branch name: ${name}`, "BASE_INVALID"); }
}

function rejectRunBranchBase(name, runBranch) {
  if (name === runBranch) fail(`publication base cannot be the run branch: ${name}`, "BASE_INVALID");
}

function resolveExplicitBase(checkout, requestedBase, runBranch) {
  const name = publicationBaseName(requestedBase);
  rejectRunBranchBase(name, runBranch);
  assertBranchName(checkout, name, "--base");
  if (tryGit(checkout, ["remote", "get-url", "origin"])) {
    const startSha = tryGit(checkout, ["rev-parse", "--verify", `refs/remotes/origin/${name}`]);
    if (!startSha) fail(`--base is not a fetched origin branch: ${name}`, "BASE_NOT_ON_ORIGIN");
    return { baseBranch: name, startSha };
  }
  const startSha = tryGit(checkout, ["rev-parse", "--verify", `refs/heads/${name}`]);
  if (!startSha) fail(`--base does not resolve to a local branch: ${name}`, "BASE_UNRESOLVED");
  return { baseBranch: name, startSha };
}

function resolveDefaultBase(checkout, runBranch) {
  if (!tryGit(checkout, ["remote", "get-url", "origin"])) {
    fail("no origin default branch; pass --base <ref>", "BASE_UNRESOLVED");
  }
  const ref = tryGit(checkout, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const name = ref && /^refs\/remotes\/origin\/(.+)$/.exec(ref)?.[1];
  if (!name) fail("repository default branch is unresolved; set origin/HEAD or pass --base", "BASE_UNRESOLVED");
  rejectRunBranchBase(name, runBranch);
  const startSha = tryGit(checkout, ["rev-parse", "--verify", `refs/remotes/origin/${name}`]);
  if (!startSha) fail(`origin/HEAD ${name} does not resolve`, "BASE_UNRESOLVED");
  return { baseBranch: name, startSha };
}

function resolvePublicationBase(checkout, { requestedBase, runBranch }) {
  return requestedBase
    ? resolveExplicitBase(checkout, requestedBase, runBranch)
    : resolveDefaultBase(checkout, runBranch);
}

function createRetainedWorktree(identity, runId, branch, publicationBase) {
  git(identity.checkout, ["check-ref-format", "--branch", branch]);
  const { baseBranch, startSha } = publicationBase;
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

module.exports = {
  branchExists,
  branchExistsMessage,
  canonicalCheckout,
  createRetainedWorktree,
  createWorktreeBase,
  fail,
  git,
  observeAttemptWorktree,
  removeUnpublishedRun,
  repositoryIdentity,
  resolvePublicationBase,
  worktreeBase,
};
