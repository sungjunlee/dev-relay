const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  createRunId,
  ensureRunLayout,
  updateManifestState,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { observeRun } = require("../../../skills/relay-dispatch/scripts/run-observer");

function writeFakeGh(binDir) {
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write("[]");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ number: Number(args[2]), state: "OPEN", url: "https://example.test/pr/" + args[2], headRefName: "issue-827" }));
  process.exit(0);
}
process.stderr.write("unexpected gh args: " + args.join(" "));
process.exit(2);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return ghPath;
}

function setupRun({ state = STATES.DISPATCHED, missingWorktree = false } = {}) {
  const previousRelayHome = process.env.RELAY_HOME;
  const previousGh = process.env.RELAY_GH_BIN;
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-observer-repo-")));
  const relayHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-observer-home-")));
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-observer-gh-")));
  process.env.RELAY_HOME = relayHome;
  process.env.RELAY_GH_BIN = writeFakeGh(binDir);

  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Observer Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-observer@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const worktreePath = path.join(repoRoot, "worktrees", "issue-827");
  if (!missingWorktree) {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    execFileSync("git", ["worktree", "add", worktreePath, "-b", "issue-827"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
  }
  const startHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: missingWorktree ? repoRoot : worktreePath,
    encoding: "utf-8",
  }).trim();
  const runId = createRunId({
    issueNumber: 827,
    branch: "issue-827",
    timestamp: new Date("2026-07-08T00:00:00.000Z"),
  });
  const layout = ensureRunLayout(repoRoot, runId);
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-827",
    baseBranch: "main",
    issueNumber: 827,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "codex",
  });
  manifest.anchor.rubric_path = "rubric.yaml";
  manifest.git.head_sha = startHead;
  manifest = updateManifestState(manifest, state, state === STATES.DISPATCHED ? "await_dispatch_result" : "next");
  writeManifest(layout.manifestPath, manifest);
  fs.writeFileSync(path.join(layout.runDir, "rubric.yaml"), "rubric:\n  size_class: S\n", "utf-8");

  return {
    repoRoot,
    relayHome,
    runId,
    runDir: layout.runDir,
    manifestPath: layout.manifestPath,
    worktreePath,
    restore() {
      if (previousRelayHome === undefined) delete process.env.RELAY_HOME;
      else process.env.RELAY_HOME = previousRelayHome;
      if (previousGh === undefined) delete process.env.RELAY_GH_BIN;
      else process.env.RELAY_GH_BIN = previousGh;
    },
  };
}

function spawnSleep() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

function writeLease(fixture, child, timeoutS = 60) {
  fs.writeFileSync(path.join(fixture.runDir, "lease.json"), JSON.stringify({
    pid: process.pid,
    pgid: child.pid,
    host: os.hostname(),
    started_at: new Date().toISOString(),
    timeout_s: timeoutS,
  }, null, 2), "utf-8");
}

function writeExpiredLease(fixture, child) {
  fs.writeFileSync(path.join(fixture.runDir, "lease.json"), JSON.stringify({
    pid: process.pid,
    pgid: child.pid,
    host: os.hostname(),
    started_at: new Date(Date.now() - 5000).toISOString(),
    timeout_s: 1,
  }, null, 2), "utf-8");
}

function killChild(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
}

test("observer classifies a live run with output", () => {
  const fixture = setupRun();
  const child = spawnSleep();
  try {
    writeLease(fixture, child);
    fs.writeFileSync(path.join(fixture.runDir, "dispatch-stdout.log"), "working\n", "utf-8");
    const row = observeRun({ repo: fixture.repoRoot, runId: fixture.runId });
    assert.equal(row.classification, "running_with_output");
    assert.equal(row.lease.live, true);
    assert.match(row.logs.stdout_tail, /working/);
  } finally {
    killChild(child);
    fixture.restore();
  }
});

test("observer classifies a live silent run", () => {
  const fixture = setupRun();
  const child = spawnSleep();
  try {
    writeLease(fixture, child);
    const row = observeRun({ repo: fixture.repoRoot, runId: fixture.runId });
    assert.equal(row.classification, "running_silent");
    assert.equal(row.logs.last_output_at, null);
  } finally {
    killChild(child);
    fixture.restore();
  }
});

test("observer classifies a live timed-out run", () => {
  const fixture = setupRun();
  const child = spawnSleep();
  try {
    writeExpiredLease(fixture, child);
    const row = observeRun({ repo: fixture.repoRoot, runId: fixture.runId });
    assert.equal(row.classification, "timed_out_live");
    assert.equal(row.lease.live, true);
    assert.equal(row.lease.remaining_s, 0);
  } finally {
    killChild(child);
    fixture.restore();
  }
});

test("observer classifies a dead run with no work", () => {
  const fixture = setupRun();
  try {
    const row = observeRun({ repo: fixture.repoRoot, runId: fixture.runId });
    assert.equal(row.classification, "dead_no_work");
    assert.equal(row.result_file, null);
    assert.equal(row.worktree.reviewable_dirt, false);
    assert.match(row.next_action.command, new RegExp(`--manifest ${JSON.stringify(fixture.manifestPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    fixture.restore();
  }
});

test("observer classifies dead work", () => {
  const fixture = setupRun();
  try {
    fs.writeFileSync(path.join(fixture.worktreePath, "changed.txt"), "work\n", "utf-8");
    const row = observeRun({ repo: fixture.repoRoot, runId: fixture.runId });
    assert.equal(row.classification, "dead_with_work");
    assert.equal(row.worktree.reviewable_dirt, true);
  } finally {
    fixture.restore();
  }
});

test("observer classifies missing worktree", () => {
  const fixture = setupRun({ missingWorktree: true });
  try {
    const row = observeRun({ repo: fixture.repoRoot, runId: fixture.runId });
    assert.equal(row.classification, "missing_worktree");
    assert.equal(row.worktree.exists, false);
  } finally {
    fixture.restore();
  }
});

test("observer reports corrupt lease without mutating", () => {
  const fixture = setupRun();
  try {
    const leasePath = path.join(fixture.runDir, "lease.json");
    fs.writeFileSync(leasePath, "{bad json", "utf-8");
    const before = fs.readFileSync(leasePath, "utf-8");
    const row = observeRun({ repo: fixture.repoRoot, runId: fixture.runId });
    assert.equal(row.lease.status, "corrupt");
    assert.equal(fs.readFileSync(leasePath, "utf-8"), before);
  } finally {
    fixture.restore();
  }
});
