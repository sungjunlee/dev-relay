const { execFileSync, spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const DISPATCH_SCRIPTS = path.join(PROJECT_ROOT, "skills", "relay-dispatch", "scripts");
const RECOVER_COMMIT = path.join(DISPATCH_SCRIPTS, "recover-commit.js");
const CREATE_WORKTREE = path.join(DISPATCH_SCRIPTS, "create-worktree.js");
const FINALIZE_RUN = path.join(PROJECT_ROOT, "skills", "relay-merge", "scripts", "finalize-run.js");
const DISPATCH = path.join(DISPATCH_SCRIPTS, "dispatch.js");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
}

function runNode(script, args, { env, cwd = PROJECT_ROOT } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

function setupRepo(prefix = "relay-runtime-contract-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(root, "repo");
  const remoteRoot = path.join(root, "remote.git");
  const relayHome = path.join(root, "relay-home");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(relayHome, { recursive: true });
  git(repoRoot, ["init", "-b", "main"]);
  git(repoRoot, ["config", "user.name", "Runtime Contract"]);
  git(repoRoot, ["config", "user.email", "runtime-contract@example.test"]);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  git(repoRoot, ["add", "README.md"]);
  git(repoRoot, ["commit", "-m", "initial"]);
  execFileSync("git", ["init", "--bare", remoteRoot], { encoding: "utf-8", stdio: "pipe" });
  git(repoRoot, ["remote", "add", "origin", remoteRoot]);
  git(repoRoot, ["push", "-u", "origin", "main"]);
  return { root, repoRoot, relayHome, remoteRoot, env: { RELAY_HOME: relayHome } };
}

// This adapter is the only bridge to the legacy manifest/state API.  Contract
// tests deliberately use semantic fixture names rather than legacy enum values.
function createLegacyRun(fixture, { kind, branch = "runtime-contract" } = {}) {
  const previousRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = fixture.relayHome;
  try {
  const {
    STATES,
    createManifestSkeleton,
    createRunId,
    ensureRunLayout,
    readManifest,
    updateManifestState,
    writeManifest,
  } = require(path.join(DISPATCH_SCRIPTS, "relay-manifest.js"));
  const worktreePath = path.join(fixture.relayHome, "worktrees", "contract-lane", path.basename(fixture.repoRoot));
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(fixture.repoRoot, ["worktree", "add", worktreePath, "-b", branch]);
  const runId = createRunId({ branch, timestamp: new Date("2026-07-31T00:00:00.000Z") });
  const layout = ensureRunLayout(fixture.repoRoot, runId);
  let data = createManifestSkeleton({
    repoRoot: fixture.repoRoot,
    runId,
    branch,
    baseBranch: "main",
    issueNumber: 901,
    worktreePath,
    orchestrator: "contract-test",
    executor: "contract-test",
    reviewer: "contract-test",
  });
  data = updateManifestState(data, STATES.DISPATCHED, "await_dispatch_result");
  fs.writeFileSync(path.join(layout.runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: frozen-by-contract-fixture\n", "utf-8");
  data.anchor.rubric_path = "rubric.yaml";
  if (kind !== "inflight") {
    data = updateManifestState(data, STATES.REVIEW_PENDING, "run_review");
    data.git.pr_number = 901;
  }
  if (kind === "terminal") {
    data = updateManifestState(data, STATES.READY_TO_MERGE, "await_explicit_merge");
    data = updateManifestState(data, STATES.MERGED, "manual_cleanup_required");
  } else if (kind !== "unreviewed" && kind !== "recoverable" && kind !== "inflight") {
    throw new Error(`unsupported semantic fixture kind: ${kind}`);
  }
  writeManifest(layout.manifestPath, data);
  return {
    ...fixture,
    branch,
    runId,
    runDir: layout.runDir,
    manifestPath: layout.manifestPath,
    worktreePath,
    readLegacyManifest: () => readManifest(layout.manifestPath).data,
  };
  } finally {
    if (previousRelayHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousRelayHome;
  }
}

function frozenContractHash(run) {
  const manifest = run.readLegacyManifest();
  const target = path.join(run.runDir, manifest.anchor.rubric_path);
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function identityProjection(run) {
  const data = run.readLegacyManifest();
  return {
    runId: data.run_id,
    repoRoot: data.paths.repo_root,
    worktree: data.paths.worktree,
    branch: data.git.working_branch,
    baseBranch: data.git.base_branch,
    roles: data.roles,
  };
}

function startLiveLease(run) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  fs.writeFileSync(path.join(run.runDir, "lease.json"), JSON.stringify({
    pid: child.pid,
    pgid: child.pid,
    host: os.hostname(),
    started_at: new Date().toISOString(),
    timeout_s: 60,
  }), "utf-8");
  return () => {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  };
}

function rejectSymlinkedUntrustedWorktree(run) {
  const outside = path.join(run.root, "outside-target");
  const link = path.join(run.relayHome, "worktrees", "untrusted-link");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "safe\n", "utf-8");
  fs.symlinkSync(outside, link);
  const previousRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = run.relayHome;
  try {
    const { readManifest, writeManifest } = require(path.join(DISPATCH_SCRIPTS, "relay-manifest.js"));
    const record = readManifest(run.manifestPath);
    writeManifest(run.manifestPath, { ...record.data, paths: { ...record.data.paths, worktree: link } }, record.body);
  } finally {
    if (previousRelayHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousRelayHome;
  }
  const result = runFinalizeUnreviewed(run);
  return { result, sentinel: fs.readFileSync(path.join(outside, "sentinel.txt"), "utf-8") };
}

function writeFakeGh(fixture) {
  const bin = path.join(fixture.root, "bin");
  const statePath = path.join(fixture.root, "gh-state.json");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ created: 0, pr: null }), "utf-8");
  const executable = path.join(bin, "gh");
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require("fs");
const statePath = process.env.RUNTIME_CONTRACT_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "list") {
  if (state.pr !== null) process.stdout.write(String(state.pr) + "\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  state.created += 1; state.pr = 901;
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
  process.stdout.write("https://example.test/repo/pull/901\\n");
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ number: 901, title: "runtime contract" }) + "\\n");
  process.exit(0);
}
process.stderr.write("unexpected fake gh invocation: " + args.join(" "));
process.exit(2);
`, "utf-8");
  fs.chmodSync(executable, 0o755);
  return {
    ...fixture.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    RUNTIME_CONTRACT_GH_STATE: statePath,
    readGhState() {
      return JSON.parse(fs.readFileSync(statePath, "utf-8"));
    },
  };
}

function runCreateWorktree(fixture, branch) {
  return runNode(CREATE_WORKTREE, [fixture.repoRoot, "--branch", branch, "--json"], { env: fixture.env });
}

function runExecutorWriteDispatch(fixture, branch) {
  const bin = path.join(fixture.root, "executor-bin");
  const rubric = path.join(fixture.root, "runtime-contract-rubric.yaml");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(rubric, "rubric:\n  factors:\n    - name: contained-write\n", "utf-8");
  const codex = path.join(bin, "codex");
  fs.writeFileSync(codex, `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("contract-codex\\n"); process.exit(0); }
if (args[0] !== "exec") process.exit(2);
const cwd = args[args.indexOf("-C") + 1];
const output = args[args.indexOf("-o") + 1];
fs.writeFileSync(cwd + "/executor-owned.txt", "written by executor\\n", "utf8");
execFileSync("git", ["-C", cwd, "add", "executor-owned.txt"], { stdio: "pipe" });
execFileSync("git", ["-C", cwd, "commit", "-m", "contained executor write"], { stdio: "pipe" });
fs.writeFileSync(output, "completed\\n", "utf8");
`, "utf-8");
  fs.chmodSync(codex, 0o755);
  return runNode(DISPATCH, [
    fixture.repoRoot,
    "--branch", branch,
    "--prompt", "Create executor-owned.txt in the assigned worktree",
    "--rubric-file", rubric,
    "--publish-policy", "after-internal-review",
    "--json",
  ], { env: { ...fixture.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, cwd: fixture.repoRoot });
}

function runFinalizeUnreviewed(run) {
  return runNode(FINALIZE_RUN, ["--repo", run.repoRoot, "--run-id", run.runId, "--dry-run", "--json"], { env: run.env });
}

function runRecover(run, env, reason) {
  return runNode(RECOVER_COMMIT, ["--repo", run.repoRoot, "--run-id", run.runId, "--reason", reason, "--json"], { env });
}

function addReviewableChange(run) {
  fs.writeFileSync(path.join(run.worktreePath, "recovered.txt"), "recover me\n", "utf-8");
}

function remoteBranchHead(fixture, branch) {
  return git(fixture.repoRoot, ["rev-parse", `refs/remotes/origin/${branch}`]);
}

function manifestBytes(run) {
  return fs.readFileSync(run.manifestPath, "utf-8");
}

function isExplicitMergeBoundaryRefusal(result) {
  return /Expected relay run to be .* before merge/.test(result.stderr);
}

function isTerminalRecoveryRefusal(result) {
  return /terminal state/.test(result.stderr);
}

module.exports = {
  addReviewableChange,
  createLegacyRun,
  frozenContractHash,
  identityProjection,
  isExplicitMergeBoundaryRefusal,
  isTerminalRecoveryRefusal,
  manifestBytes,
  remoteBranchHead,
  runCreateWorktree,
  runExecutorWriteDispatch,
  runFinalizeUnreviewed,
  runRecover,
  rejectSymlinkedUntrustedWorktree,
  setupRepo,
  startLiveLease,
  writeFakeGh,
};
