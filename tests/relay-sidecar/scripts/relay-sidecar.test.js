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

const TEST_GAP_HEADINGS = [
  "## Run summary",
  "## Required gaps",
  "## Optional hardening",
  "## Done Criteria coverage",
  "## Confidence and limitations",
];

const DOCS_SYNC_HEADINGS = [
  "## Run summary",
  "## Likely stale docs",
  "## Recommended updates",
  "## Optional patch hints",
  "## Confidence and limitations",
];

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
  let promptText = "";
  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "context-recap",
  ], {
    cwd: fixture.repoRoot,
    runOpencode: ({ cwd, args }) => {
      assert.equal(cwd, fixture.worktreePath);
      assert.equal(args[0], "run");
      promptText = args.at(-1);
      assert.match(promptText, /CONTEXT_RECAP_AUGMENTATION_REQUEST/);
      return { code: 0, stdout: "augmented recap output\n", stderr: "" };
    },
  });

  assert.equal(result.exitCode, 0);
  const sidecarId = "context-recap-1234abcd";
  assert.equal(fs.readFileSync(readOutputPath(fixture, sidecarId), "utf-8"), "augmented recap output\n");
  assert.match(promptText, /BASELINE RECAP:/);

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

test("--kind context-recap --executor none writes deterministic output and records result", (t) => {
  const fixture = createFixture(t);
  const record = readManifest(fixture.manifestPath);
  writeManifest(fixture.manifestPath, { ...record.data, pr_number: 448 }, record.body);
  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "context-recap",
    "--executor", "none",
  ], {
    cwd: fixture.repoRoot,
    getPrDiff: () => {
      throw new Error("context-recap deterministic mode must not fetch PR diff");
    },
  });

  assert.equal(result.exitCode, 0);
  const sidecarId = "context-recap-1234abcd";
  const output = fs.readFileSync(readOutputPath(fixture, sidecarId), "utf-8");
  for (const heading of [
    "## Run summary",
    "## Round history",
    "## Repeated reviewer findings",
    "## Unresolved requirements",
    "## Likely misses",
  ]) {
    assert.match(output, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "sidecar_start");
  assert.equal(events[0].executor, "none");
  assert.equal(events[1].event, "sidecar_result");
  assert.equal(events[1].trust_level, "advisory");
  assert.equal(readSidecarIndex(fixture.repoRoot, fixture.runId).sidecars[0].status, "completed");
});

test("--kind test-gap --executor none writes deterministic output and records result", (t) => {
  const fixture = createFixture(t);
  const runDir = getRunDir(fixture.repoRoot, fixture.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), [
    "factors:",
    "  - name: Unit tests",
    "    command: node --test tests/foo.test.js",
    "    target: pass",
    "",
  ].join("\n"), "utf-8");
  fs.writeFileSync(path.join(runDir, "dispatch-prompt.md"), "- Add test-gap sidecar\n", "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-2-diff.patch"), [
    "diff --git a/skills/foo/scripts/foo.js b/skills/foo/scripts/foo.js",
    "+++ b/skills/foo/scripts/foo.js",
    "",
  ].join("\n"), "utf-8");

  const beforeCache = new Set(Object.keys(require.cache));
  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "test-gap",
    "--executor", "none",
  ], {
    cwd: fixture.repoRoot,
    getPrDiff: () => {
      throw new Error("test-gap deterministic mode must use run-dir diff artifacts");
    },
  });
  const loadedDuringRun = Object.keys(require.cache).filter((key) => !beforeCache.has(key));

  assert.equal(result.exitCode, 0);
  assert.deepEqual(loadedDuringRun.filter((key) => /opencode/i.test(key)), []);
  const sidecarId = "test-gap-1234abcd";
  const output = fs.readFileSync(readOutputPath(fixture, sidecarId), "utf-8");
  assert.match(output, /^# Test gap report: /);
  assert.match(output, /tests\/foo\.test\.js/);
  for (const heading of TEST_GAP_HEADINGS) {
    assert.match(output, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "sidecar_start");
  assert.equal(events[0].executor, "none");
  assert.equal(events[0].trust_level, "advisory");
  assert.equal(events[1].event, "sidecar_result");
  assert.equal(events[1].trust_level, "advisory");
  assert.equal(events[1].output_path, `sidecars/${sidecarId}/output.md`);
  assert.equal(readSidecarIndex(fixture.repoRoot, fixture.runId).sidecars[0].status, "completed");
});

test("--kind docs-sync --executor none writes deterministic output and records result", (t) => {
  const fixture = createFixture(t);
  const runDir = getRunDir(fixture.repoRoot, fixture.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.worktreePath, "README.md"), [
    "# Fixture",
    "",
    "The relay foo script lives in baz.js.",
    "",
  ].join("\n"), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-1-diff.patch"), [
    "diff --git a/skills/relay-foo/scripts/baz.js b/skills/relay-foo/scripts/baz.js",
    "+++ b/skills/relay-foo/scripts/baz.js",
    "+function changedBaz() {}",
    "",
  ].join("\n"), "utf-8");

  const beforeCache = new Set(Object.keys(require.cache));
  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "docs-sync",
    "--executor", "none",
  ], {
    cwd: fixture.repoRoot,
    getPrDiff: () => {
      throw new Error("docs-sync deterministic mode must use run-dir diff artifacts");
    },
  });
  const loadedDuringRun = Object.keys(require.cache).filter((key) => !beforeCache.has(key));

  assert.equal(result.exitCode, 0);
  assert.deepEqual(loadedDuringRun.filter((key) => /opencode/i.test(key)), []);
  const sidecarId = "docs-sync-1234abcd";
  const output = fs.readFileSync(readOutputPath(fixture, sidecarId), "utf-8");
  assert.match(output, /^# Docs sync report: /);
  assert.match(output, /README\.md/);
  assert.match(output, /baz\.js/);
  for (const heading of DOCS_SYNC_HEADINGS) {
    assert.match(output, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }

  const events = readRunEvents(fixture.repoRoot, fixture.runId);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "sidecar_start");
  assert.equal(events[0].executor, "none");
  assert.equal(events[0].trust_level, "advisory");
  assert.equal(events[1].event, "sidecar_result");
  assert.equal(events[1].trust_level, "advisory");
  assert.equal(events[1].output_path, `sidecars/${sidecarId}/output.md`);
  assert.equal(readSidecarIndex(fixture.repoRoot, fixture.runId).sidecars[0].status, "completed");
});

test("--kind test-gap --executor none falls back to PR diff when no review diff exists", (t) => {
  const fixture = createFixture(t);
  const record = readManifest(fixture.manifestPath);
  writeManifest(fixture.manifestPath, { ...record.data, pr_number: 448 }, record.body);
  const runDir = getRunDir(fixture.repoRoot, fixture.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), [
    "factors:",
    "  - name: Unit tests",
    "    command: node --test tests/pr/scripts/pr.test.js",
    "    target: pass",
    "",
  ].join("\n"), "utf-8");
  fs.writeFileSync(path.join(runDir, "dispatch-prompt.md"), "- Add test-gap sidecar\n", "utf-8");
  let diffPrNumber = null;

  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "test-gap",
    "--executor", "none",
  ], {
    cwd: fixture.repoRoot,
    getPrDiff: (prNumber) => {
      diffPrNumber = prNumber;
      return [
        "diff --git a/skills/extra/scripts/extra.js b/skills/extra/scripts/extra.js",
        "+++ b/skills/extra/scripts/extra.js",
        "",
      ].join("\n");
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(diffPrNumber, 448);
  const output = fs.readFileSync(readOutputPath(fixture, "test-gap-1234abcd"), "utf-8");
  assert.match(output, /tests\/pr\/scripts\/pr\.test\.js/);
  assert.match(output, /skills\/extra\/scripts\/extra\.js/);
});

test("--kind test-gap refuses symlinked run-context inputs", (t) => {
  const fixture = createFixture(t);
  const runDir = getRunDir(fixture.repoRoot, fixture.runId);
  fs.mkdirSync(runDir, { recursive: true });
  const targetPath = path.join(runDir, "rubric-real.yaml");
  fs.writeFileSync(targetPath, "command: node --test tests/foo.test.js\n", "utf-8");
  fs.symlinkSync(targetPath, path.join(runDir, "rubric.yaml"));

  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "test-gap",
    "--executor", "none",
  ], {
    cwd: fixture.repoRoot,
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /symlinked path|ELOOP|rubric\.yaml/);
  assert.deepEqual(readRunEvents(fixture.repoRoot, fixture.runId), []);
});

test("--kind test-gap --executor opencode uses test-gap augmentation prompt", (t) => {
  const fixture = createFixture(t);
  const runDir = getRunDir(fixture.repoRoot, fixture.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), "command: node --test tests/foo.test.js\n", "utf-8");
  fs.writeFileSync(path.join(runDir, "dispatch-prompt.md"), "- Add test-gap sidecar\n", "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-1-diff.patch"), [
    "diff --git a/tests/foo.test.js b/tests/foo.test.js",
    "+++ b/tests/foo.test.js",
    "",
  ].join("\n"), "utf-8");
  let promptText = "";

  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "test-gap",
    "--executor", "opencode",
  ], {
    cwd: fixture.repoRoot,
    getPrDiff: () => "diff --git a/README.md b/README.md\n",
    runOpencode: ({ args }) => {
      promptText = args.at(-1);
      assert.match(promptText, /TEST_GAP_AUGMENTATION_REQUEST/);
      assert.match(promptText, /BASELINE REPORT/);
      return { code: 0, stdout: "opencode augmented test-gap report\n", stderr: "" };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(fs.readFileSync(readOutputPath(fixture, "test-gap-1234abcd"), "utf-8"), "opencode augmented test-gap report\n");
  assert.match(promptText, /# Test gap report: /);
});

test("--kind docs-sync --executor opencode uses docs-sync augmentation prompt", (t) => {
  const fixture = createFixture(t);
  const runDir = getRunDir(fixture.repoRoot, fixture.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.worktreePath, "README.md"), [
    "# Fixture",
    "",
    "The relay foo script lives at skills/relay-foo/scripts/baz.js.",
    "",
  ].join("\n"), "utf-8");
  fs.writeFileSync(path.join(runDir, "review-round-1-diff.patch"), [
    "diff --git a/skills/relay-foo/scripts/baz.js b/skills/relay-foo/scripts/baz.js",
    "+++ b/skills/relay-foo/scripts/baz.js",
    "+function changedBaz() {}",
    "",
  ].join("\n"), "utf-8");
  let promptText = "";

  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "docs-sync",
    "--executor", "opencode",
  ], {
    cwd: fixture.repoRoot,
    getPrDiff: () => {
      throw new Error("docs-sync opencode mode must use run-dir diff artifacts when present");
    },
    runOpencode: ({ args }) => {
      promptText = args.at(-1);
      assert.match(promptText, /DOCS_SYNC_AUGMENTATION_REQUEST/);
      assert.match(promptText, /BASELINE REPORT/);
      assert.match(promptText, /DOCS_SYNC_BASELINE_UNIQUE_SUBSTRING/);
      return { code: 0, stdout: "opencode augmented docs-sync report\n", stderr: "" };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(fs.readFileSync(readOutputPath(fixture, "docs-sync-1234abcd"), "utf-8"), "opencode augmented docs-sync report\n");
  assert.match(promptText, /# Docs sync report: /);
});

test("--json keeps runner stdout structured without changing sidecar output path", (t) => {
  const fixture = createFixture(t);
  const record = readManifest(fixture.manifestPath);
  writeManifest(fixture.manifestPath, { ...record.data, pr_number: 448 }, record.body);
  let diffPrNumber = null;

  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "test-gap",
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
  const sidecarId = "test-gap-1234abcd";
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

test("--executor none is rejected for kinds without deterministic builders", (t) => {
  const fixture = createFixture(t);
  const result = invoke([
    "--run-id", fixture.runId,
    "--kind", "unregistered-kind",
    "--executor", "none",
  ], {
    cwd: fixture.repoRoot,
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /executor "none".*unregistered-kind|deterministic sidecar builder/);
  assert.deepEqual(readRunEvents(fixture.repoRoot, fixture.runId), []);
  assert.equal(fs.existsSync(getSidecarsIndexPath(fixture.repoRoot, fixture.runId)), false);
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
  assert.match(result.stderr, /supported executors are opencode and none|unsupported sidecar executor/);
  assert.deepEqual(readRunEvents(fixture.repoRoot, fixture.runId), []);
  assert.equal(fs.existsSync(getSidecarsIndexPath(fixture.repoRoot, fixture.runId)), false);
});
