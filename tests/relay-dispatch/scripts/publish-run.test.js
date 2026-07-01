const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { publishRun } = require("../../../skills/relay-dispatch/scripts/publish-run");
const {
  STATES,
  createManifestSkeleton,
  ensureRunLayout,
  getManifestPath,
  readManifest,
  updateManifestState,
  writeManifest,
} = require("../../../skills/relay-dispatch/scripts/relay-manifest");
const { readRunEvents, EVENTS } = require("../../../skills/relay-dispatch/scripts/relay-events");

function initRepoWithRemote() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-publish-repo-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-publish-remote-"));
  execFileSync("git", ["init", "--bare", remoteRoot], { stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Publish"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-publish@example.com"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteRoot], { cwd: repoRoot, stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoRoot, stdio: "pipe" });

  const relayWorktrees = path.join(process.env.RELAY_HOME, "worktrees");
  fs.mkdirSync(relayWorktrees, { recursive: true });
  const worktree = path.join(fs.mkdtempSync(path.join(relayWorktrees, "relay-publish-wt-")), path.basename(repoRoot));
  execFileSync("git", ["worktree", "add", "-b", "issue-42", worktree], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Publish"], { cwd: worktree, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-publish@example.com"], { cwd: worktree, stdio: "pipe" });
  fs.writeFileSync(path.join(worktree, "README.md"), "base\npublished\n", "utf-8");
  execFileSync("git", ["commit", "-am", "publish change"], { cwd: worktree, stdio: "pipe" });
  return { repoRoot, worktree };
}

function installFakeGh() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-publish-gh-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write("");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  process.stdout.write("https://github.com/example/dev-relay/pull/123\\n");
  process.exit(0);
}
process.stderr.write("Unsupported gh invocation: " + args.join(" "));
process.exit(1);
`, "utf-8");
  fs.chmodSync(ghPath, 0o755);
  return binDir;
}

test("publish-run publishes a publish_pending run and advances to review_pending", async () => {
  const previousRelayHome = process.env.RELAY_HOME;
  const previousPath = process.env.PATH;
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  process.env.PATH = `${installFakeGh()}:${previousPath}`;
  try {
    const { repoRoot, worktree } = initRepoWithRemote();
    const runId = "issue-42-20260412000003000";
    const { runDir } = ensureRunLayout(repoRoot, runId);
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: publish\n", "utf-8");
    fs.writeFileSync(path.join(runDir, "dispatch-result.txt"), "implemented delayed publication\n", "utf-8");

    let manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch: "issue-42",
      baseBranch: "main",
      issueNumber: 42,
      worktreePath: worktree,
      executor: "codex",
      reviewer: "codex",
    });
    manifest = {
      ...manifest,
      anchor: {
        ...(manifest.anchor || {}),
        rubric_path: "rubric.yaml",
      },
    };
    manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
    manifest = updateManifestState(manifest, STATES.INTERNAL_REVIEW_PENDING, "run_internal_review");
    manifest = updateManifestState(manifest, STATES.PUBLISH_PENDING, "publish_pr");
    const reviewedHeadSha = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    manifest = {
      ...manifest,
      git: {
        ...(manifest.git || {}),
        head_sha: reviewedHeadSha,
      },
      review: {
        ...(manifest.review || {}),
        last_reviewed_sha: reviewedHeadSha,
      },
    };
    const manifestPath = getManifestPath(repoRoot, runId);
    writeManifest(manifestPath, manifest);

    const result = await publishRun({ repoArg: repoRoot, runIdArg: runId });
    assert.equal(result.state, STATES.REVIEW_PENDING);
    assert.equal(result.prNumber, 123);
    assert.equal(result.reviewedHeadSha, reviewedHeadSha);

    const updated = readManifest(manifestPath).data;
    assert.equal(updated.state, STATES.REVIEW_PENDING);
    assert.equal(updated.git.pr_number, 123);
    assert.equal(updated.github.pr_created_by_orchestrator, true);

    const events = readRunEvents(repoRoot, runId);
    const publishEvent = events.find((event) => event.event === EVENTS.PUBLISH_RESULT);
    assert.equal(publishEvent.state_from, STATES.PUBLISH_PENDING);
    assert.equal(publishEvent.state_to, STATES.REVIEW_PENDING);
    assert.equal(publishEvent.pr_number, 123);
  } finally {
    process.env.PATH = previousPath;
    if (previousRelayHome === undefined) {
      delete process.env.RELAY_HOME;
    } else {
      process.env.RELAY_HOME = previousRelayHome;
    }
  }
});

test("publish-run refuses to publish when HEAD drifted after internal review", async () => {
  const previousRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  try {
    const { repoRoot, worktree } = initRepoWithRemote();
    const runId = "issue-42-20260412000004000";
    const { runDir } = ensureRunLayout(repoRoot, runId);
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: publish\n", "utf-8");

    let manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch: "issue-42",
      baseBranch: "main",
      issueNumber: 42,
      worktreePath: worktree,
      executor: "codex",
      reviewer: "codex",
    });
    manifest = {
      ...manifest,
      anchor: {
        ...(manifest.anchor || {}),
        rubric_path: "rubric.yaml",
      },
    };
    manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
    manifest = updateManifestState(manifest, STATES.INTERNAL_REVIEW_PENDING, "run_internal_review");
    manifest = updateManifestState(manifest, STATES.PUBLISH_PENDING, "publish_pr");
    const reviewedHeadSha = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    manifest = {
      ...manifest,
      git: {
        ...(manifest.git || {}),
        head_sha: reviewedHeadSha,
      },
      review: {
        ...(manifest.review || {}),
        last_reviewed_sha: reviewedHeadSha,
      },
    };
    const manifestPath = getManifestPath(repoRoot, runId);
    writeManifest(manifestPath, manifest);

    fs.writeFileSync(path.join(worktree, "after-review.txt"), "unreviewed\n", "utf-8");
    execFileSync("git", ["-C", worktree, "add", "after-review.txt"], { encoding: "utf-8", stdio: "pipe" });
    execFileSync("git", ["-C", worktree, "commit", "-m", "Advance after internal review"], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    const driftedHeadSha = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    await assert.rejects(
      () => publishRun({ repoArg: repoRoot, runIdArg: runId }),
      /Refusing to publish unreviewed HEAD/
    );

    const updated = readManifest(manifestPath).data;
    assert.equal(updated.state, STATES.ESCALATED);
    assert.equal(updated.next_action, "inspect_publish_head_drift");
    assert.equal(updated.git.head_sha, driftedHeadSha);
    assert.equal(updated.review.last_reviewed_sha, reviewedHeadSha);
    assert.equal(updated.review.latest_verdict, "publish_head_drift");

    const events = readRunEvents(repoRoot, runId);
    const publishEvent = events.find((event) => event.event === EVENTS.PUBLISH_RESULT);
    assert.equal(publishEvent.state_from, STATES.PUBLISH_PENDING);
    assert.equal(publishEvent.state_to, STATES.ESCALATED);
    assert.equal(publishEvent.head_sha, driftedHeadSha);
    assert.equal(publishEvent.last_reviewed_sha, reviewedHeadSha);
  } finally {
    if (previousRelayHome === undefined) {
      delete process.env.RELAY_HOME;
    } else {
      process.env.RELAY_HOME = previousRelayHome;
    }
  }
});

test("publish-run refuses to publish without an explicit internal review anchor", async () => {
  const previousRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  try {
    const { repoRoot, worktree } = initRepoWithRemote();
    const runId = "issue-42-20260412000005000";
    const { runDir } = ensureRunLayout(repoRoot, runId);
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: publish\n", "utf-8");

    let manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch: "issue-42",
      baseBranch: "main",
      issueNumber: 42,
      worktreePath: worktree,
      executor: "codex",
      reviewer: "codex",
    });
    manifest = {
      ...manifest,
      anchor: { ...(manifest.anchor || {}), rubric_path: "rubric.yaml" },
    };
    manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
    manifest = updateManifestState(manifest, STATES.INTERNAL_REVIEW_PENDING, "run_internal_review");
    manifest = updateManifestState(manifest, STATES.PUBLISH_PENDING, "publish_pr");
    manifest.git.head_sha = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    const manifestPath = getManifestPath(repoRoot, runId);
    writeManifest(manifestPath, manifest);

    await assert.rejects(
      () => publishRun({ repoArg: repoRoot, runIdArg: runId }),
      /requires review\.last_reviewed_sha/
    );

    const updated = readManifest(manifestPath).data;
    assert.equal(updated.state, STATES.ESCALATED);
    assert.equal(updated.review.latest_verdict, "publish_head_drift");
  } finally {
    if (previousRelayHome === undefined) {
      delete process.env.RELAY_HOME;
    } else {
      process.env.RELAY_HOME = previousRelayHome;
    }
  }
});

test("publish-run refuses to publish from a dirty worktree after internal review", async () => {
  const previousRelayHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  try {
    const { repoRoot, worktree } = initRepoWithRemote();
    const runId = "issue-42-20260412000006000";
    const { runDir } = ensureRunLayout(repoRoot, runId);
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: publish\n", "utf-8");

    let manifest = createManifestSkeleton({
      repoRoot,
      runId,
      branch: "issue-42",
      baseBranch: "main",
      issueNumber: 42,
      worktreePath: worktree,
      executor: "codex",
      reviewer: "codex",
    });
    manifest = {
      ...manifest,
      anchor: { ...(manifest.anchor || {}), rubric_path: "rubric.yaml" },
    };
    manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
    manifest = updateManifestState(manifest, STATES.INTERNAL_REVIEW_PENDING, "run_internal_review");
    manifest = updateManifestState(manifest, STATES.PUBLISH_PENDING, "publish_pr");
    const reviewedHeadSha = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    manifest = {
      ...manifest,
      git: { ...(manifest.git || {}), head_sha: reviewedHeadSha },
      review: { ...(manifest.review || {}), last_reviewed_sha: reviewedHeadSha },
    };
    const manifestPath = getManifestPath(repoRoot, runId);
    writeManifest(manifestPath, manifest);
    fs.writeFileSync(path.join(worktree, "dirty.txt"), "not reviewed\n", "utf-8");

    await assert.rejects(
      () => publishRun({ repoArg: repoRoot, runIdArg: runId }),
      /uncommitted worktree changes/
    );

    const updated = readManifest(manifestPath).data;
    assert.equal(updated.state, STATES.ESCALATED);
    assert.equal(updated.review.last_reviewed_sha, reviewedHeadSha);
  } finally {
    if (previousRelayHome === undefined) {
      delete process.env.RELAY_HOME;
    } else {
      process.env.RELAY_HOME = previousRelayHome;
    }
  }
});
