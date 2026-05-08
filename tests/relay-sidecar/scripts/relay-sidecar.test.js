const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createManifestSkeleton,
  createRunId,
  getManifestPath,
  getRunDir,
  getSidecarsIndexPath,
  readManifest,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { readRunEvents } = require("../../../skills/relay-dispatch/scripts/relay-events");
const { readSidecarIndex } = require("../../../skills/relay-dispatch/scripts/sidecar-store");
const { main } = require("../../../skills/relay-sidecar/scripts/relay-sidecar");

function runGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
}

function createCommittedRepo(repoRoot) {
  runGit(repoRoot, ["init", "-b", "main"]);
  runGit(repoRoot, ["config", "user.name", "Relay Sidecar Test"]);
  runGit(repoRoot, ["config", "user.email", "relay-sidecar@example.com"]);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "init"]);
}

function createRelayOwnedWorktree(repoRoot, relayHome, branch = "sidecar-worktree") {
  const relayWorktrees = path.join(relayHome, "worktrees");
  fs.mkdirSync(relayWorktrees, { recursive: true });
  const worktreeParent = fs.mkdtempSync(path.join(relayWorktrees, "owned-"));
  const worktreePath = path.join(worktreeParent, path.basename(repoRoot));
  runGit(repoRoot, ["worktree", "add", worktreePath, "-b", branch]);
  return worktreePath;
}

function createFixture(t) {
  const previousRelayHome = process.env.RELAY_HOME;
  const previousRelayWorktreeBase = process.env.RELAY_WORKTREE_BASE;
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sidecar-home-"));
  process.env.RELAY_HOME = relayHome;
  process.env.RELAY_WORKTREE_BASE = path.join(relayHome, "worktrees");

  t.after(() => {
    if (previousRelayHome === undefined) delete process.env.RELAY_HOME;
    else process.env.RELAY_HOME = previousRelayHome;
    if (previousRelayWorktreeBase === undefined) delete process.env.RELAY_WORKTREE_BASE;
    else process.env.RELAY_WORKTREE_BASE = previousRelayWorktreeBase;
  });

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sidecar-repo-"));
  createCommittedRepo(repoRoot);
  const worktreePath = createRelayOwnedWorktree(repoRoot, relayHome);
  const runId = createRunId({
    issueNumber: 381,
    timestamp: new Date("2026-05-08T01:02:03.000Z"),
  });
  const manifestPath = getManifestPath(repoRoot, runId);
  const manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "sidecar-worktree",
    baseBranch: "main",
    issueNumber: 381,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest.pr_number = null;
  writeManifest(manifestPath, manifest);
  return { relayHome, repoRoot, worktreePath, runId, manifestPath };
}

function invoke(argv, options = {}) {
  let stdout = "";
  let stderr = "";
  const result = main({
    argv,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    entropy: "1234abcd",
    getPrDiff: () => "",
    ...options,
  });
  return { ...result, stdout, stderr };
}

function readOutputPath(fixture, sidecarId, file = "output.md") {
  return path.join(getRunDir(fixture.repoRoot, fixture.runId), "sidecars", sidecarId, file);
}

test("--help exits 0 and lists documented flags", () => {
  const result = invoke(["--help"]);

  assert.equal(result.exitCode, 0);
  for (const flag of ["--run-id", "--kind", "--executor", "--model", "--variant", "--dry-run", "--json", "--help", "-h"]) {
    assert.match(result.stdout, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("--dry-run skips opencode and emits no events", (t) => {
  const fixture = createFixture(t);
  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "context-recap",
    "--dry-run",
    "--json",
  ], {
    cwd: fixture.repoRoot,
    runOpencode: () => {
      throw new Error("opencode mock must not be called during dry-run");
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).status, "dry_run");
  assert.deepEqual(readRunEvents(fixture.repoRoot, fixture.runId), []);
  assert.equal(fs.existsSync(getSidecarsIndexPath(fixture.repoRoot, fixture.runId)), false);
});

test("happy path stores stdout and records advisory result", (t) => {
  const fixture = createFixture(t);
  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "context-recap",
  ], {
    cwd: fixture.repoRoot,
    runOpencode: ({ cwd, args }) => {
      assert.equal(cwd, fixture.worktreePath);
      assert.equal(args[0], "run");
      assert.match(args.at(-1), /kind: context-recap/);
      return { code: 0, stdout: "recap output\n", stderr: "" };
    },
  });

  assert.equal(result.exitCode, 0);
  const sidecarId = "context-recap-1234abcd";
  assert.equal(fs.readFileSync(readOutputPath(fixture, sidecarId), "utf-8"), "recap output\n");

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "sidecar_start");
  assert.equal(events[1].event, "sidecar_result");
  assert.equal(events[1].trust_level, "advisory");
  assert.equal(events[1].output_path, `sidecars/${sidecarId}/output.md`);

  const index = readSidecarIndex(fixture.repoRoot, fixture.runId);
  assert.equal(index.sidecars[0].id, sidecarId);
  assert.equal(index.sidecars[0].status, "completed");
});

test("--json keeps runner stdout structured without changing sidecar output path", (t) => {
  const fixture = createFixture(t);
  const record = readManifest(fixture.manifestPath);
  writeManifest(fixture.manifestPath, { ...record.data, pr_number: 448 }, record.body);
  let diffPrNumber = null;

  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "context-recap",
    "--json",
  ], {
    cwd: fixture.repoRoot,
    getPrDiff: (prNumber) => {
      diffPrNumber = prNumber;
      return "diff --git a/README.md b/README.md\n";
    },
    runOpencode: ({ args }) => {
      assert.match(args.at(-1), /diff --git a\/README\.md b\/README\.md/);
      return { code: 0, stdout: "{\"summary\":\"ok\"}\n", stderr: "" };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(diffPrNumber, 448);
  const sidecarId = "context-recap-1234abcd";
  assert.equal(fs.readFileSync(readOutputPath(fixture, sidecarId), "utf-8"), "{\"summary\":\"ok\"}\n");
  assert.equal(fs.existsSync(readOutputPath(fixture, sidecarId, "output.json")), false);
  assert.equal(JSON.parse(result.stdout).output_path, `sidecars/${sidecarId}/output.md`);
});

test("opencode non-zero emits sidecar_failed and marks index failed", (t) => {
  const fixture = createFixture(t);
  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "test-gap",
  ], {
    cwd: fixture.repoRoot,
    runOpencode: () => ({ code: 7, stdout: "partial\n", stderr: "failed\n" }),
  });

  assert.notEqual(result.exitCode, 0);
  const sidecarId = "test-gap-1234abcd";
  assert.equal(fs.readFileSync(readOutputPath(fixture, sidecarId), "utf-8"), "partial\n");

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(events.at(-1).event, "sidecar_failed");
  assert.match(events.at(-1).failure_reason, /7|exit/);
  assert.equal(readSidecarIndex(fixture.repoRoot, fixture.runId).sidecars[0].status, "failed");
});

test("advisory violation detects worktree drift and fails closed", (t) => {
  const fixture = createFixture(t);
  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "docs-sync",
  ], {
    cwd: fixture.repoRoot,
    runOpencode: ({ cwd }) => {
      fs.writeFileSync(path.join(cwd, "junk.txt"), "mutation\n", "utf-8");
      return { code: 0, stdout: "docs report\n", stderr: "" };
    },
  });

  assert.notEqual(result.exitCode, 0);
  const sidecarId = "docs-sync-1234abcd";
  assert.equal(fs.existsSync(path.join(fixture.worktreePath, "junk.txt")), true);
  assert.equal(fs.readFileSync(readOutputPath(fixture, sidecarId), "utf-8"), "docs report\n");

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(events.at(-1).event, "sidecar_failed");
  assert.equal(events.at(-1).failure_reason, "advisory_violation");
  assert.equal(readSidecarIndex(fixture.repoRoot, fixture.runId).sidecars[0].status, "failed");
});

test("unknown executor exits non-zero without sidecar events or index changes", (t) => {
  const fixture = createFixture(t);
  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "context-recap",
    "--executor", "nonsense",
  ], {
    cwd: fixture.repoRoot,
    runOpencode: () => {
      throw new Error("opencode mock must not be called for unknown executor");
    },
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /only opencode is wired|unsupported sidecar executor/);
  assert.deepEqual(readRunEvents(fixture.repoRoot, fixture.runId), []);
  assert.equal(fs.existsSync(getSidecarsIndexPath(fixture.repoRoot, fixture.runId)), false);
});
