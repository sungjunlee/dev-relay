const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATES,
  createManifestSkeleton,
  ensureRunLayout,
  getRunsDir,
  updateManifestState,
  writeManifest,
  readManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");
const { readRunEvents } = require("../../relay-dispatch/scripts/relay-events");

const SCRIPT = path.join(__dirname, "review-runner.js");

function setupRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-runner-"));
  process.env.RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Relay Review Test"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "relay-review@example.com"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "base\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" });

  const runId = "issue-42-20260403010000000";
  const worktreePath = path.join(repoRoot, "wt", "issue-42");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", worktreePath, "-b", "issue-42"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(worktreePath, "marker.txt"), "worktree\n", "utf-8");

  const manifestPath = ensureRunLayout(repoRoot, runId).manifestPath;
  let manifest = createManifestSkeleton({
    repoRoot,
    runId,
    branch: "issue-42",
    baseBranch: "main",
    issueNumber: 42,
    worktreePath,
    orchestrator: "codex",
    executor: "codex",
    reviewer: "claude",
  });
  manifest = updateManifestState(manifest, STATES.DISPATCHED, "await_dispatch_result");
  manifest = {
    ...manifest,
    anchor: {
      ...(manifest.anchor || {}),
      rubric_grandfathered: true,
    },
  };
  manifest = {
    ...manifest,
    git: {
      ...(manifest.git || {}),
      head_sha: execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim(),
    },
  };
  manifest = updateManifestState(manifest, STATES.REVIEW_PENDING, "run_review");
  writeManifest(manifestPath, manifest);

  const doneCriteriaPath = path.join(repoRoot, "done-criteria.md");
  const diffPath = path.join(repoRoot, "pr.diff");
  fs.writeFileSync(doneCriteriaPath, "# Done Criteria\n\n- Add smoke.txt\n- Do not touch auth\n", "utf-8");
  fs.writeFileSync(diffPath, "diff --git a/smoke.txt b/smoke.txt\n+ok\n", "utf-8");

  return { repoRoot, worktreePath, manifestPath, runId, doneCriteriaPath, diffPath };
}

function setReviewPending(manifestPath) {
  const { data, body } = readManifest(manifestPath);
  let updated = data;
  if (updated.state === STATES.CHANGES_REQUESTED) {
    updated = updateManifestState(updated, STATES.DISPATCHED, "await_dispatch_result");
    updated = updateManifestState(updated, STATES.REVIEW_PENDING, "run_review");
  }
  writeManifest(manifestPath, updated, body);
}

function updateManifestRecord(manifestPath, updater) {
  const { data, body } = readManifest(manifestPath);
  const updated = updater(data);
  writeManifest(manifestPath, updated, body);
  return updated;
}

function configureRubricFixture({ manifestPath, repoRoot, runId, state }) {
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.rmSync(path.join(runDir, "rubric.yaml"), { recursive: true, force: true });
  fs.rmSync(path.join(runDir, "rubric-dir"), { recursive: true, force: true });

  updateManifestRecord(manifestPath, (data) => {
    const anchor = { ...(data.anchor || {}) };
    delete anchor.rubric_grandfathered;
    delete anchor.rubric_path;

    if (state === "loaded" || state === "missing" || state === "empty") {
      anchor.rubric_path = "rubric.yaml";
    } else if (state === "outside_run_dir") {
      anchor.rubric_path = "../escape.yaml";
    } else if (state === "invalid") {
      anchor.rubric_path = "rubric-dir";
    } else if (state === "grandfathered") {
      anchor.rubric_grandfathered = true;
    }

    return {
      ...data,
      anchor,
    };
  });

  if (state === "loaded") {
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: API pagination\n      target: \">= 8/10\"\n", "utf-8");
  } else if (state === "empty") {
    fs.writeFileSync(path.join(runDir, "rubric.yaml"), "   \n", "utf-8");
  } else if (state === "invalid") {
    fs.mkdirSync(path.join(runDir, "rubric-dir"), { recursive: true });
  }

  return runDir;
}

function writeVerdict(repoRoot, name, verdict) {
  const filePath = path.join(repoRoot, name);
  fs.writeFileSync(filePath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");
  return filePath;
}

function writePassVerdict(repoRoot, name = "pass.json") {
  return writeVerdict(repoRoot, name, {
    verdict: "pass",
    summary: "All done criteria are satisfied.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });
}

function prepareReviewRun({ repoRoot, runId, doneCriteriaPath, diffPath }) {
  return JSON.parse(execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8" }));
}

function runPassReview({
  repoRoot,
  runId,
  doneCriteriaPath,
  diffPath,
  reviewFile,
  env,
  noComment = true,
}) {
  const args = [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
  ];
  if (noComment) {
    args.push("--no-comment");
  }
  args.push("--json");
  return JSON.parse(execFileSync("node", args, {
    encoding: "utf-8",
    env,
  }));
}

function writeReviewerScript(repoRoot, name, verdict) {
  const filePath = path.join(repoRoot, name);
  const body = `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(verdict))});
`;
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeMutatingReviewerScript(repoRoot, name, verdict) {
  const filePath = path.join(repoRoot, name);
  const body = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const repoIndex = args.indexOf("--repo");
const repo = repoIndex !== -1 ? args[repoIndex + 1] : process.cwd();
fs.writeFileSync(path.join(repo, "reviewer-mutated.txt"), "bad\\n", "utf-8");
process.stdout.write(${JSON.stringify(JSON.stringify(verdict))});
`;
  fs.writeFileSync(filePath, body, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function runReviewRunnerModule(lines) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-review-module-"));
  const helperPath = path.join(tmpDir, "helper.js");
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const reviewRunner = require(${JSON.stringify(SCRIPT)});`,
    ...lines,
  ].join("\n"), "utf-8");
  return execFileSync("node", [helperPath], { encoding: "utf-8" });
}

function writeFakeGhScript(repoRoot, { prBody, capturePath }) {
  const filePath = path.join(repoRoot, "gh");
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ body: ${JSON.stringify(prBody)} }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "comment") {
  const bodyIndex = args.indexOf("--body");
  const body = bodyIndex !== -1 ? args[bodyIndex + 1] : "";
  fs.writeFileSync(${JSON.stringify(capturePath)}, body, "utf-8");
  process.exit(0);
}
process.stderr.write("Unsupported gh invocation: " + args.join(" "));
process.exit(1);
`, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

test("prepare-only writes a prompt bundle without changing manifest state", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.prepareOnly, true);
  assert.equal(result.round, 1);
  assert.equal(result.state, STATES.REVIEW_PENDING);
  assert.equal(path.basename(result.promptPath), "review-round-1-prompt.md");
  assert.ok(fs.existsSync(result.promptPath));
  assert.ok(fs.existsSync(result.doneCriteriaPath));
  assert.ok(fs.existsSync(result.diffPath));
  assert.equal(readManifest(manifestPath).data.state, STATES.REVIEW_PENDING);
  assert.equal(readManifest(manifestPath).data.run_id, runId);
});

test("prepare-only loads frozen Done Criteria from manifest anchor before GitHub fallbacks", () => {
  const { repoRoot, manifestPath, runId, diffPath } = setupRepo();
  const anchoredDoneCriteriaPath = path.join(repoRoot, "frozen-done-criteria.md");
  fs.writeFileSync(anchoredDoneCriteriaPath, "# Frozen Done Criteria\n\n- Use the persisted intake snapshot\n", "utf-8");

  const record = readManifest(manifestPath);
  const updated = {
    ...record.data,
    anchor: {
      ...(record.data.anchor || {}),
      done_criteria_path: anchoredDoneCriteriaPath,
      done_criteria_source: "request_snapshot",
    },
  };
  writeManifest(manifestPath, updated, record.body);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  const doneCriteriaText = fs.readFileSync(result.doneCriteriaPath, "utf-8");
  assert.match(promptText, /source="request_snapshot"/);
  assert.match(doneCriteriaText, /Use the persisted intake snapshot/);
});

test("missing manifest-anchored Done Criteria fails loudly without fallback", () => {
  const { repoRoot, manifestPath, runId, diffPath } = setupRepo();
  const missingDoneCriteriaPath = path.join(repoRoot, "missing-frozen-done-criteria.md");

  const record = readManifest(manifestPath);
  const updated = {
    ...record.data,
    anchor: {
      ...(record.data.anchor || {}),
      done_criteria_path: missingDoneCriteriaPath,
      done_criteria_source: "request_snapshot",
    },
  };
  writeManifest(manifestPath, updated, record.body);

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), (error) => {
    assert.match(String(error.stderr), /Manifest anchor\.done_criteria_path points to a missing file/);
    return true;
  });
});

test("pass verdict moves review_pending to ready_to_merge", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "pass.json", {
    verdict: "pass",
    summary: "All done criteria are satisfied.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.commentPosted, false);
  assert.ok(fs.existsSync(result.verdictPath));

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.next_action, "await_explicit_merge");
  assert.equal(manifest.git.pr_number, 123);
  assert.equal(manifest.review.rounds, 1);
  assert.equal(manifest.review.latest_verdict, "lgtm");
  assert.ok(manifest.review.last_reviewed_sha);
});

test("pass verdict rejects quality_status=not_run", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "phase1-pass.json", {
    verdict: "pass",
    summary: "No blocking review issues found.",
    contract_status: "pass",
    quality_status: "not_run",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), (error) => {
    assert.match(String(error.stderr), /PASS verdict requires contract_status=pass and quality_status=pass/);
    return true;
  });

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.REVIEW_PENDING);
  assert.equal(manifest.review.latest_verdict, "pending");
});

test("review-runner rejects invalid manifest run_id before creating a sibling run directory", () => {
  const { repoRoot, manifestPath, diffPath } = setupRepo();
  const record = readManifest(manifestPath);
  const victimRunDir = path.resolve(getRunsDir(repoRoot), "../victim-review-run");

  writeManifest(manifestPath, {
    ...record.data,
    run_id: "../victim-review-run",
  }, record.body);

  assert.equal(fs.existsSync(victimRunDir), false);
  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--manifest", manifestPath,
    "--pr", "123",
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), (error) => {
    assert.match(String(error.stderr), /run_id must be a single path segment/);
    return true;
  });
  assert.equal(fs.existsSync(victimRunDir), false);
});

test("changes_requested verdict creates a re-dispatch artifact", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "changes.json", {
    verdict: "changes_requested",
    summary: "One requirement is missing.",
    contract_status: "fail",
    quality_status: "pass",
    next_action: "changes_requested",
    issues: [
      {
        title: "Missing smoke file",
        body: "The PR does not add the required smoke.txt output.",
        file: "src/index.js",
        line: 12,
        category: "contract",
        severity: "high",
      },
    ],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.CHANGES_REQUESTED);
  assert.ok(result.redispatchPath);
  assert.ok(fs.existsSync(result.redispatchPath));
  const redispatchText = fs.readFileSync(result.redispatchPath, "utf-8");
  assert.match(redispatchText, /Fix these review issues in the PR/);
  assert.match(redispatchText, /src\/index.js:12/);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.CHANGES_REQUESTED);
  assert.equal(manifest.next_action, "re_dispatch_requested_changes");
  assert.equal(manifest.review.rounds, 1);
  assert.equal(manifest.review.latest_verdict, "changes_requested");
  assert.equal(manifest.review.repeated_issue_count, 1);
});

test("review-runner records rubric_scores as iteration_score events", () => {
  const { repoRoot, runId, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "changes-with-scores.json", {
    verdict: "changes_requested",
    summary: "Coverage and docs still need work.",
    contract_status: "fail",
    quality_status: "pass",
    next_action: "changes_requested",
    issues: [
      {
        title: "Missing smoke file",
        body: "The PR does not add the required smoke.txt output.",
        file: "src/index.js",
        line: 12,
        category: "contract",
        severity: "high",
      },
    ],
    rubric_scores: [
      {
        factor: "Coverage",
        target: ">= 8",
        observed: "6",
        status: "fail",
        tier: "contract",
        notes: "Still below bar.",
      },
      {
        factor: "Docs",
        target: ">= 8",
        observed: "8",
        status: "pass",
        tier: "quality",
        notes: "Docs are complete.",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  });

  execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const events = readRunEvents(repoRoot, runId);
  assert.equal(events.at(-2).event, "review_apply");
  assert.equal(events.at(-1).event, "iteration_score");
  assert.deepEqual(events.at(-1), {
    ts: events.at(-1).ts,
    event: "iteration_score",
    actor: "Relay Review Test",
    run_id: runId,
    round: 1,
    scores: [
      {
        factor: "Coverage",
        target: ">= 8",
        observed: "6",
        met: false,
        status: "fail",
        tier: "contract",
      },
      {
        factor: "Docs",
        target: ">= 8",
        observed: "8",
        met: true,
        status: "pass",
        tier: "quality",
      },
    ],
  });
  assert.match(events.at(-1).ts, /\d{4}-\d{2}-\d{2}T/);
});

test("review-runner records score divergence and appends warning text to the PR comment", () => {
  const { repoRoot, runId, doneCriteriaPath, diffPath } = setupRepo();
  const commentCapturePath = path.join(repoRoot, "captured-comment.txt");
  writeFakeGhScript(repoRoot, {
    capturePath: commentCapturePath,
    prBody: [
      "## Score Log",
      "",
      "| Factor | Target | Baseline | Iter 1 | Final | Status |",
      "|--------|--------|----------|--------|-------|--------|",
      "| Coverage | >= 8 | — | 9 | 9 | locked |",
      "| Docs & Notes? | >= 8 | — | 8 | — | locked |",
      "| Placeholder | >= 8 | — | n/a | — | — |",
    ].join("\n"),
  });
  const reviewFile = writeVerdict(repoRoot, "changes-with-divergence.json", {
    verdict: "changes_requested",
    summary: "Scores disagree on implementation quality.",
    contract_status: "fail",
    quality_status: "fail",
    next_action: "changes_requested",
    issues: [
      {
        title: "Missing smoke file",
        body: "The PR does not add the required smoke.txt output.",
        file: "src/index.js",
        line: 12,
        category: "contract",
        severity: "high",
      },
    ],
    rubric_scores: [
      {
        factor: "Coverage",
        target: ">= 8",
        observed: "6",
        status: "fail",
        notes: "Still below bar.",
        tier: "contract",
      },
      {
        factor: "Docs & Notes?",
        target: ">= 8",
        observed: "7",
        status: "fail",
        notes: "Clarity still needs work.",
        tier: "quality",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  });

  execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--json",
  ], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${repoRoot}:${process.env.PATH}`,
    },
  });

  const events = readRunEvents(repoRoot, runId);
  assert.equal(events.at(-2).event, "iteration_score");
  assert.equal(events.at(-1).event, "score_divergence");
  assert.deepEqual(events.at(-1).divergences, [
    {
      factor: "Coverage",
      executor: "9",
      reviewer: "6",
      delta: 3,
      tier: "contract",
    },
    {
      factor: "Docs & Notes?",
      executor: "8",
      reviewer: "7",
      delta: 1,
      tier: "quality",
    },
  ]);

  const commentBody = fs.readFileSync(commentCapturePath, "utf-8");
  assert.match(commentBody, /Score divergence warnings:/);
  assert.match(commentBody, /Coverage: executor 9, reviewer 6 \(\+3\)/);
  assert.doesNotMatch(commentBody, /Docs & Notes\?: executor 8, reviewer 7/);
});

test("review-runner keeps event journals on the manifest repo slug when --repo is a symlinked alias", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
  const repoAliasPath = `${repoRoot}-alias`;
  fs.symlinkSync(repoRoot, repoAliasPath, "dir");
  writeFakeGhScript(repoRoot, {
    capturePath: path.join(repoRoot, "unused-comment.txt"),
    prBody: [
      "## Score Log",
      "",
      "| Factor | Target | Baseline | Iter 1 | Final | Status |",
      "|--------|--------|----------|--------|-------|--------|",
      "| Coverage | >= 8 | — | 9 | 9 | locked |",
    ].join("\n"),
  });
  const reviewFile = writeVerdict(repoRoot, "changes-with-alias-divergence.json", {
    verdict: "changes_requested",
    summary: "Coverage still misses the bar.",
    contract_status: "fail",
    quality_status: "pass",
    next_action: "changes_requested",
    issues: [
      {
        title: "Missing smoke file",
        body: "The PR does not add the required smoke.txt output.",
        file: "src/index.js",
        line: 12,
        category: "contract",
        severity: "high",
      },
    ],
    rubric_scores: [
      {
        factor: "Coverage",
        target: ">= 8",
        observed: "6",
        status: "fail",
        notes: "Still below bar.",
        tier: "contract",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoAliasPath,
    "--manifest", manifestPath,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${repoRoot}:${process.env.PATH}`,
    },
  });

  const result = JSON.parse(stdout);
  const canonicalRunDir = path.join(getRunsDir(repoRoot), runId);
  const aliasEventsPath = path.join(getRunsDir(repoAliasPath), runId, "events.jsonl");
  const events = readRunEvents(repoRoot, runId);

  assert.ok(result.verdictPath.startsWith(canonicalRunDir));
  assert.deepEqual(events.map((event) => event.event), [
    "review_apply",
    "iteration_score",
    "score_divergence",
  ]);
  assert.equal(events.at(-1).divergences[0].factor, "Coverage");
  assert.equal(fs.existsSync(aliasEventsPath), false);
  assert.deepEqual(readRunEvents(repoAliasPath, runId), []);
});

test("reviewer-script invocation can drive a round without --review-file", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewerScript = writeReviewerScript(repoRoot, "reviewer-pass.js", {
    verdict: "pass",
    summary: "Automated reviewer passed the change.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer-script", reviewerScript,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.reviewerScript, reviewerScript);
  assert.ok(result.rawResponsePath);
  assert.ok(fs.existsSync(result.rawResponsePath));

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.review.latest_verdict, "lgtm");
  assert.ok(manifest.review.last_reviewed_sha);
});

test("invalid pass verdict is rejected", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "invalid-pass.json", {
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [
      {
        title: "Should not be here",
        body: "PASS verdict cannot carry issues.",
        file: "x.js",
        line: 1,
        category: "contract",
        severity: "low",
      },
    ],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /PASS verdict must not include issues/);
});

test("invalid rubric score entry is rejected", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "invalid-rubric.json", {
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [
      {
        factor: "Contract coverage",
        target: ">= 8",
        observed: "9",
        status: "pass",
        tier: "contract",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /rubric_scores\[0\]\.notes is required/);
});

test("review-runner rejects rubric score without tier", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "invalid-rubric-tier.json", {
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [
      {
        factor: "Contract coverage",
        target: ">= 8",
        observed: "9",
        status: "pass",
        notes: "Matches the contract.",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /rubric_scores\[0\]\.tier is required/);
});

test("pass verdict with not_done scope_drift entry is rejected", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "pass-with-not-done.json", {
    verdict: "pass",
    summary: "All good.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: {
      creep: [],
      missing: [{ criteria: "Add smoke.txt", status: "not_done" }],
    },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /PASS verdict cannot have scope_drift\.missing entries with status not_done, changed, or partial/);
});

test("pass verdict with partial scope_drift entry is rejected", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "pass-with-partial.json", {
    verdict: "pass",
    summary: "Mostly done.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: {
      creep: [],
      missing: [{ criteria: "Add smoke.txt", status: "partial" }],
    },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /PASS verdict cannot have scope_drift\.missing entries with status not_done, changed, or partial/);
});

test("invalid scope_drift missing status is rejected", () => {
  const { repoRoot, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "bad-drift-status.json", {
    verdict: "changes_requested",
    summary: "Missing requirement.",
    contract_status: "fail",
    quality_status: "not_run",
    next_action: "changes_requested",
    issues: [{ title: "Missing", body: "Not implemented", file: "x.js", line: 1, category: "contract", severity: "high" }],
    rubric_scores: [],
    scope_drift: {
      creep: [],
      missing: [{ criteria: "Add smoke.txt", status: "unknown" }],
    },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /scope_drift\.missing\[0\]\.status must be one of/);
});

test("changes_requested verdict with scope_drift includes drift in redispatch", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "drift-changes.json", {
    verdict: "changes_requested",
    summary: "Scope creep and missing requirement.",
    contract_status: "fail",
    quality_status: "not_run",
    next_action: "changes_requested",
    issues: [{ title: "Creep", body: "Unrelated change", file: "extra.js", line: 1, category: "scope", severity: "medium" }],
    rubric_scores: [],
    scope_drift: {
      creep: [{ file: "extra.js", reason: "Not in Done Criteria" }],
      missing: [
        { criteria: "Add smoke.txt", status: "not_done" },
        { criteria: "Update README", status: "verified" },
      ],
    },
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.CHANGES_REQUESTED);
  assert.ok(result.redispatchPath);
  const redispatchText = fs.readFileSync(result.redispatchPath, "utf-8");
  assert.match(redispatchText, /Scope creep/);
  assert.match(redispatchText, /extra\.js: Not in Done Criteria/);
  assert.match(redispatchText, /\[NOT_DONE\] Add smoke\.txt/);
  assert.doesNotMatch(redispatchText, /Update README/);
});

test("reviewer write policy violation escalates the manifest", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath } = setupRepo();
  const reviewerScript = writeMutatingReviewerScript(repoRoot, "reviewer-mutates.js", {
    verdict: "pass",
    summary: "This should not be trusted.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer-script", reviewerScript,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /Reviewer write policy violation detected/);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.next_action, "inspect_review_failure");
  assert.equal(manifest.review.rounds, 1);
  assert.equal(manifest.review.latest_verdict, "policy_violation");
  assert.ok(manifest.review.last_reviewed_sha);
});

test("reviewer runs against the retained worktree, not repo root", () => {
  const { repoRoot, worktreePath, manifestPath, doneCriteriaPath, diffPath, runId } = setupRepo();
  fs.writeFileSync(path.join(repoRoot, "marker.txt"), "repo-root\n", "utf-8");
  fs.writeFileSync(path.join(worktreePath, "marker.txt"), "retained-worktree\n", "utf-8");

  const reviewerScript = path.join(repoRoot, "reviewer-reads-marker.js");
  fs.writeFileSync(reviewerScript, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const repoIndex = args.indexOf("--repo");
const repo = repoIndex !== -1 ? args[repoIndex + 1] : process.cwd();
const marker = fs.readFileSync(path.join(repo, "marker.txt"), "utf-8").trim();
process.stdout.write(JSON.stringify({
  verdict: marker === "retained-worktree" ? "pass" : "changes_requested",
  summary: marker === "retained-worktree" ? "Read retained checkout" : "Wrong checkout",
  contract_status: marker === "retained-worktree" ? "pass" : "fail",
  quality_status: "pass",
  next_action: marker === "retained-worktree" ? "ready_to_merge" : "changes_requested",
  issues: marker === "retained-worktree" ? [] : [{
    title: "Wrong checkout",
    body: marker,
    file: "marker.txt",
    line: 1,
    category: "contract",
    severity: "high"
  }],
  rubric_scores: [],
  scope_drift: { creep: [], missing: [] }
}));
`, "utf-8");
  fs.chmodSync(reviewerScript, 0o755);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--reviewer-script", reviewerScript,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.reviewRepoPath, worktreePath);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.review.latest_verdict, "lgtm");
});

test("review runner enforces max_rounds before starting a new round", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath, runId } = setupRepo();
  const { data, body } = readManifest(manifestPath);
  data.review.rounds = 1;
  data.review.max_rounds = 1;
  writeManifest(manifestPath, data, body);

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /Review round cap exceeded/);

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.review.latest_verdict, "max_rounds_exceeded");
});

test("repeated identical issues escalate on the third consecutive round", () => {
  const { repoRoot, manifestPath, doneCriteriaPath, diffPath, runId } = setupRepo();
  const reviewFile = writeVerdict(repoRoot, "same-issue.json", {
    verdict: "changes_requested",
    summary: "Same issue persists.",
    contract_status: "fail",
    quality_status: "pass",
    next_action: "changes_requested",
    issues: [
      {
        title: "Still missing smoke file",
        body: "The PR still does not add smoke.txt.",
        file: "src/index.js",
        line: 12,
        category: "contract",
        severity: "high",
      },
    ],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  for (let round = 1; round <= 3; round += 1) {
    const stdout = execFileSync("node", [
      SCRIPT,
      "--repo", repoRoot,
      "--run-id", runId,
      "--pr", "123",
      "--done-criteria-file", doneCriteriaPath,
      "--diff-file", diffPath,
      "--review-file", reviewFile,
      "--no-comment",
      "--json",
    ], { encoding: "utf-8" });
    const result = JSON.parse(stdout);
    if (round < 3) {
      assert.equal(result.state, STATES.CHANGES_REQUESTED);
      setReviewPending(manifestPath);
    } else {
      assert.equal(result.state, STATES.ESCALATED);
      assert.equal(result.repeatedIssueCount, 3);
    }
  }

  const manifest = readManifest(manifestPath).data;
  assert.equal(manifest.state, STATES.ESCALATED);
  assert.equal(manifest.review.latest_verdict, "escalated");
  assert.equal(manifest.review.repeated_issue_count, 0);
});

test("formatPriorVerdictSummary produces correct round numbers and rubric summaries", () => {
  // Module-level argv parsing prevents direct require(), so use a helper script
  // that sets process.argv before requiring the module.
  const verdicts = [
    {
      verdict: "changes_requested",
      summary: "Missing tests",
      issues: [{ title: "a", body: "b", file: "x.js", line: 1, category: "contract", severity: "high" }],
      rubric_scores: [
        { factor: "Coverage", target: ">= 8", observed: "5", status: "fail", tier: "contract", notes: "low" },
      ],
    },
    {
      verdict: "changes_requested",
      summary: "No auth guard",
      issues: [
        { title: "c", body: "d", file: "y.js", line: 2, category: "quality", severity: "medium" },
        { title: "e", body: "f", file: "z.js", line: 3, category: "contract", severity: "high" },
      ],
      rubric_scores: [],
    },
  ];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-unit-"));
  const helperPath = path.join(tmpDir, "helper.js");
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { formatPriorVerdictSummary } = require(${JSON.stringify(SCRIPT)});`,
    `const verdicts = ${JSON.stringify(verdicts)};`,
    `const result = formatPriorVerdictSummary(verdicts);`,
    `const empty = formatPriorVerdictSummary([]);`,
    `process.stdout.write(JSON.stringify({ result, empty }));`,
  ].join("\n"), "utf-8");
  const out = JSON.parse(execFileSync("node", [helperPath], { encoding: "utf-8" }));

  assert.match(out.result, /^Prior review rounds:/);
  assert.match(out.result, /- Round 2: changes_requested — Missing tests \[1 issue\(s\), Coverage: 5 \(target >= 8, fail\)\]/);
  assert.match(out.result, /- Round 1: changes_requested — No auth guard \[2 issue\(s\), no rubric scores\]/);
  assert.equal(out.empty, "");
});

test("parseScoreLog extracts final scores and falls back to the last populated iteration", () => {
  const markdown = [
    "# PR",
    "",
    "## Score Log",
    "",
    "| Factor | Target | Baseline | Iter 1 | Iter 2 | Final | Status |",
    "|--------|--------|----------|--------|--------|-------|--------|",
    "| Coverage | >= 8 | — | 6 | 9 | 9 | locked |",
    "| Docs & Notes? | >= 8 | — | 6 | 7 | — | locked |",
    "| Placeholder | >= 8 | — | n/a | — | — | — |",
  ].join("\n");

  const out = JSON.parse(runReviewRunnerModule([
    `const result = reviewRunner.parseScoreLog(${JSON.stringify(markdown)});`,
    `process.stdout.write(JSON.stringify(result));`,
  ]));

  assert.deepEqual(out, [
    { factor: "Coverage", score: "9" },
    { factor: "Docs & Notes?", score: "7" },
  ]);
});

test("parseScoreLog returns [] for missing or malformed tables", () => {
  const out = JSON.parse(runReviewRunnerModule([
    `const missing = reviewRunner.parseScoreLog("No score log here");`,
    `const malformed = reviewRunner.parseScoreLog("| Factor | Final |\\n| bad | row |");`,
    `process.stdout.write(JSON.stringify({ missing, malformed }));`,
  ]));

  assert.deepEqual(out, {
    missing: [],
    malformed: [],
  });
});

test("round 2 review prompt contains Prior Round Context section", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  // Run round 1: changes_requested
  const reviewFile = writeVerdict(repoRoot, "r1-changes.json", {
    verdict: "changes_requested",
    summary: "Smoke file not created.",
    contract_status: "fail",
    quality_status: "pass",
    next_action: "changes_requested",
    issues: [{
      title: "Missing smoke file",
      body: "smoke.txt not found",
      file: "src/index.js",
      line: 10,
      category: "contract",
      severity: "high",
    }],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  // Transition back to review_pending for round 2
  setReviewPending(manifestPath);

  // Round 2: prepare-only to inspect the prompt
  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.round, 2);
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  assert.match(promptText, /## Prior Round Context/);
  assert.match(promptText, /### Round 1: changes_requested/);
  assert.match(promptText, /Smoke file not created\./);
  assert.match(promptText, /Verify whether prior issues were resolved/);
});

test("round 2 redispatch artifact contains prior round summary", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  // Round 1: changes_requested
  const r1File = writeVerdict(repoRoot, "r1.json", {
    verdict: "changes_requested",
    summary: "Missing smoke file.",
    contract_status: "fail",
    quality_status: "pass",
    next_action: "changes_requested",
    issues: [{
      title: "No smoke.txt",
      body: "Add it.",
      file: "src/index.js",
      line: 5,
      category: "contract",
      severity: "high",
    }],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", r1File,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  setReviewPending(manifestPath);

  // Round 2: changes_requested again → triggers redispatch with prior summary
  const r2File = writeVerdict(repoRoot, "r2.json", {
    verdict: "changes_requested",
    summary: "Still missing.",
    contract_status: "fail",
    quality_status: "pass",
    next_action: "changes_requested",
    issues: [{
      title: "No smoke.txt",
      body: "Still not there.",
      file: "src/index.js",
      line: 5,
      category: "contract",
      severity: "high",
    }],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", r2File,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.CHANGES_REQUESTED);
  assert.ok(result.redispatchPath);
  const redispatchText = fs.readFileSync(result.redispatchPath, "utf-8");
  assert.match(redispatchText, /This is round 3/);
  assert.match(redispatchText, /Prior review rounds:/);
  assert.match(redispatchText, /Round 1: changes_requested — Missing smoke file\./);
});

// --- detectChurnGrowth unit tests ---

test("detectChurnGrowth returns null for round < 3", () => {
  const helperPath = path.join(os.tmpdir(), `churn-lt3-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { detectChurnGrowth } = require(${JSON.stringify(SCRIPT)});`,
    `const r1 = detectChurnGrowth("/tmp/fake", 1);`,
    `const r2 = detectChurnGrowth("/tmp/fake", 2);`,
    `const rNull = detectChurnGrowth(null, 5);`,
    `process.stdout.write(JSON.stringify({ r1, r2, rNull }));`,
  ].join("\n"), "utf-8");
  const out = JSON.parse(execFileSync("node", [helperPath], { encoding: "utf-8" }));
  assert.equal(out.r1, null);
  assert.equal(out.r2, null);
  assert.equal(out.rNull, null);
});

test("detectChurnGrowth returns growth object when diffs grow monotonically", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "churn-grow-"));
  // 3 rounds with growing line counts: 2, 5, 10
  fs.writeFileSync(path.join(tmpDir, "review-round-1-diff.patch"), "a\nb\n");
  fs.writeFileSync(path.join(tmpDir, "review-round-2-diff.patch"), "a\nb\nc\nd\ne\n");
  fs.writeFileSync(path.join(tmpDir, "review-round-3-diff.patch"), "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");

  const helperPath = path.join(os.tmpdir(), `churn-grow-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { detectChurnGrowth } = require(${JSON.stringify(SCRIPT)});`,
    `const result = detectChurnGrowth(${JSON.stringify(tmpDir)}, 3);`,
    `process.stdout.write(JSON.stringify(result));`,
  ].join("\n"), "utf-8");
  const out = JSON.parse(execFileSync("node", [helperPath], { encoding: "utf-8" }));
  assert.deepEqual(out, { prevPrevLines: 2, prevLines: 5, curLines: 10 });
});

test("detectChurnGrowth returns null when diffs are not monotonically increasing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "churn-nogrow-"));
  // Round 2 is bigger than round 3 (shrinking)
  fs.writeFileSync(path.join(tmpDir, "review-round-1-diff.patch"), "a\nb\n");
  fs.writeFileSync(path.join(tmpDir, "review-round-2-diff.patch"), "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");
  fs.writeFileSync(path.join(tmpDir, "review-round-3-diff.patch"), "a\nb\nc\n");

  const helperPath = path.join(os.tmpdir(), `churn-nogrow-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { detectChurnGrowth } = require(${JSON.stringify(SCRIPT)});`,
    `const result = detectChurnGrowth(${JSON.stringify(tmpDir)}, 3);`,
    `process.stdout.write(JSON.stringify({ result }));`,
  ].join("\n"), "utf-8");
  const out = JSON.parse(execFileSync("node", [helperPath], { encoding: "utf-8" }));
  assert.equal(out.result, null);
});

test("detectChurnGrowth returns null when prior diff files are missing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "churn-missing-"));
  // Only current round exists, prior rounds missing
  fs.writeFileSync(path.join(tmpDir, "review-round-3-diff.patch"), "a\nb\nc\n");

  const helperPath = path.join(os.tmpdir(), `churn-missing-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { detectChurnGrowth } = require(${JSON.stringify(SCRIPT)});`,
    `const result = detectChurnGrowth(${JSON.stringify(tmpDir)}, 3);`,
    `process.stdout.write(JSON.stringify({ result }));`,
  ].join("\n"), "utf-8");
  const out = JSON.parse(execFileSync("node", [helperPath], { encoding: "utf-8" }));
  assert.equal(out.result, null);
});

test("detectChurnGrowth propagates non-ENOENT errors", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "churn-err-"));
  // Current round file is a directory → EISDIR on read
  fs.mkdirSync(path.join(tmpDir, "review-round-3-diff.patch"));

  const helperPath = path.join(os.tmpdir(), `churn-err-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { detectChurnGrowth } = require(${JSON.stringify(SCRIPT)});`,
    `try { detectChurnGrowth(${JSON.stringify(tmpDir)}, 3); process.stdout.write("no-error"); }`,
    `catch (e) { process.stdout.write(e.code || "unknown"); }`,
  ].join("\n"), "utf-8");
  const out = execFileSync("node", [helperPath], { encoding: "utf-8" });
  assert.equal(out, "EISDIR");
});

// --- buildRedispatchPrompt churnGrowth tests ---

test("buildRedispatchPrompt includes churn WARNING when churnGrowth is provided", () => {
  const helperPath = path.join(os.tmpdir(), `redispatch-churn-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { buildRedispatchPrompt } = require(${JSON.stringify(SCRIPT)});`,
    `const verdict = { verdict: "changes_requested", summary: "test", issues: [{ title: "t", body: "b", file: "x.js", line: 1, category: "contract", severity: "high" }], scope_drift: { creep: [], missing: [] } };`,
    `const churn = { prevPrevLines: 50, prevLines: 80, curLines: 120 };`,
    `const result = buildRedispatchPrompt(verdict, "AC: do X", null, 3, churn);`,
    `process.stdout.write(result);`,
  ].join("\n"), "utf-8");
  const out = execFileSync("node", [helperPath], { encoding: "utf-8" });
  assert.match(out, /WARNING: Diff has grown for 3\+ consecutive rounds \(50 → 80 → 120 lines\)/);
  assert.match(out, /Apply minimal, targeted fixes only/);
});

test("buildRedispatchPrompt omits churn WARNING when churnGrowth is null", () => {
  const helperPath = path.join(os.tmpdir(), `redispatch-nochurn-${Date.now()}.js`);
  fs.writeFileSync(helperPath, [
    `process.argv = ["node", "helper.js", "--repo", "/dev/null", "--branch", "x", "--pr", "1"];`,
    `const { buildRedispatchPrompt } = require(${JSON.stringify(SCRIPT)});`,
    `const verdict = { verdict: "changes_requested", summary: "test", issues: [{ title: "t", body: "b", file: "x.js", line: 1, category: "contract", severity: "high" }], scope_drift: { creep: [], missing: [] } };`,
    `const result = buildRedispatchPrompt(verdict, "AC: do X", null, 3, null);`,
    `process.stdout.write(result);`,
  ].join("\n"), "utf-8");
  const out = execFileSync("node", [helperPath], { encoding: "utf-8" });
  assert.ok(!out.includes("WARNING"));
  assert.ok(!out.includes("Apply minimal"));
});

test("review-runner loads rubric from run dir and includes rubric factor names and targets in the prompt", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  // Write a rubric file to the run dir
  const { data, body } = readManifest(manifestPath);
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), [
    "rubric:",
    "  factors:",
    "    - name: API pagination",
    "      target: \">= 8/10\"",
  ].join("\n"), "utf-8");
  const nextAnchor = { ...(data.anchor || {}), rubric_path: "rubric.yaml" };
  delete nextAnchor.rubric_grandfathered;
  const updated = {
    ...data,
    anchor: nextAnchor,
  };
  writeManifest(manifestPath, updated, body);

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--branch", "issue-42",
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--prepare-only",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.rubricLoaded, "loaded");
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  assert.match(promptText, /## Scoring Rubric/);
  assert.match(promptText, /API pagination/);
  assert.match(promptText, />= 8\/10/);
  assert.match(promptText, /rubric_scores.*REQUIRED/i);
});

// Covers #157 AC(f): a loaded rubric + PASS verdict MUST still advance to ready_to_merge; paired with the fail-closed regressions below at :1598-1660 (missing/outside/empty/invalid/not_set).
test("review-runner advances loaded-rubric PASS reviews to ready_to_merge", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  const { data, body } = readManifest(manifestPath);
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), [
    "rubric:",
    "  factors:",
    "    - name: API pagination",
    "      target: \">= 8/10\"",
  ].join("\n"), "utf-8");
  const nextAnchor = { ...(data.anchor || {}), rubric_path: "rubric.yaml" };
  delete nextAnchor.rubric_grandfathered;
  writeManifest(manifestPath, {
    ...data,
    anchor: nextAnchor,
  }, body);

  const reviewFile = writeVerdict(repoRoot, "loaded-rubric-pass.json", {
    verdict: "pass",
    summary: "All done criteria are satisfied.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [
      {
        factor: "API pagination",
        target: ">= 8/10",
        observed: "9/10",
        status: "pass",
        tier: "contract",
        notes: "Pagination behavior meets the rubric target.",
      },
    ],
    scope_drift: { creep: [], missing: [] },
  });

  const result = runPassReview({
    repoRoot,
    runId,
    doneCriteriaPath,
    diffPath,
    reviewFile,
  });

  const manifest = readManifest(manifestPath).data;
  assert.equal(result.rubricLoaded, "loaded");
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.nextState, STATES.READY_TO_MERGE);
  assert.equal(result.reviewGate, null);
  assert.equal(manifest.state, STATES.READY_TO_MERGE);
  assert.equal(manifest.next_action, "await_explicit_merge");
  assert.equal(manifest.review.latest_verdict, "lgtm");
  assert.equal(manifest.anchor.rubric_path, "rubric.yaml");
  assert.ok(!("rubric_grandfathered" in manifest.anchor));
});

test("review-runner warns visibly when anchor.rubric_path is set but the rubric file is missing", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  configureRubricFixture({ manifestPath, repoRoot, runId, state: "missing" });
  const result = prepareReviewRun({ repoRoot, runId, doneCriteriaPath, diffPath });
  assert.equal(result.rubricLoaded, "missing");
  assert.match(result.rubricWarning, /\[rubric missing\]/i);
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  assert.match(promptText, /## Scoring Rubric/);
  assert.match(promptText, /WARNING: \[rubric missing\]/i);
  assert.match(promptText, /Do NOT return PASS or ready_to_merge/i);
});

test("review-runner distinguishes rubric paths that resolve outside the run dir", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  configureRubricFixture({ manifestPath, repoRoot, runId, state: "outside_run_dir" });
  const result = prepareReviewRun({ repoRoot, runId, doneCriteriaPath, diffPath });
  assert.equal(result.rubricLoaded, "outside_run_dir");
  assert.match(result.rubricWarning, /\[rubric path outside run dir\]/i);
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  assert.match(promptText, /WARNING: \[rubric path outside run dir\]/i);
  assert.match(promptText, /\.\./);
});

test("review-runner warns visibly when anchor.rubric_path is missing from the manifest", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  configureRubricFixture({ manifestPath, repoRoot, runId, state: "not_set" });
  const result = prepareReviewRun({ repoRoot, runId, doneCriteriaPath, diffPath });

  assert.equal(result.rubricLoaded, "not_set");
  assert.match(result.rubricWarning, /\[rubric path not set\]/i);
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  assert.match(promptText, /WARNING: \[rubric path not set\]/i);
  assert.match(promptText, /anchor\.rubric_path is required before review\/merge/i);
});

test("review-runner warns visibly when the anchored rubric file is empty", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  configureRubricFixture({ manifestPath, repoRoot, runId, state: "empty" });
  const result = prepareReviewRun({ repoRoot, runId, doneCriteriaPath, diffPath });

  assert.equal(result.rubricLoaded, "empty");
  assert.match(result.rubricWarning, /\[rubric empty\]/i);
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  assert.match(promptText, /WARNING: \[rubric empty\]/i);
  assert.match(promptText, /rubric file is empty/i);
});

test("review-runner warns visibly when anchor.rubric_path points to an invalid rubric target", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  configureRubricFixture({ manifestPath, repoRoot, runId, state: "invalid" });
  const result = prepareReviewRun({ repoRoot, runId, doneCriteriaPath, diffPath });

  assert.equal(result.rubricLoaded, "invalid");
  assert.match(result.rubricWarning, /\[rubric invalid\]/i);
  const promptText = fs.readFileSync(result.promptPath, "utf-8");
  assert.match(promptText, /WARNING: \[rubric invalid\]/i);
  assert.match(promptText, /must point to a file inside the run directory/i);
});

test("review-runner rejects empty rubric_scores when rubric is present", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  // Write a rubric file to the run dir
  const { data, body } = readManifest(manifestPath);
  const runDir = ensureRunLayout(repoRoot, runId).runDir;
  fs.writeFileSync(path.join(runDir, "rubric.yaml"), "rubric:\n  factors:\n    - name: test\n", "utf-8");
  const nextAnchor = { ...(data.anchor || {}), rubric_path: "rubric.yaml" };
  delete nextAnchor.rubric_grandfathered;
  const updated = {
    ...data,
    anchor: nextAnchor,
  };
  writeManifest(manifestPath, updated, body);

  const reviewFile = writeVerdict(repoRoot, "empty-rubric.json", {
    verdict: "pass",
    summary: "Looks good.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  assert.throws(() => execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8", stdio: "pipe" }), /empty rubric_scores.*rubric was provided/i);
});

test("review-runner allows empty rubric_scores when no rubric file exists", () => {
  const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();

  // No rubric file, no rubric_path in manifest; setupRepo marks the run grandfathered.
  const reviewFile = writeVerdict(repoRoot, "no-rubric-pass.json", {
    verdict: "pass",
    summary: "All done criteria are satisfied.",
    contract_status: "pass",
    quality_status: "pass",
    next_action: "ready_to_merge",
    issues: [],
    rubric_scores: [],
    scope_drift: { creep: [], missing: [] },
  });

  const stdout = execFileSync("node", [
    SCRIPT,
    "--repo", repoRoot,
    "--run-id", runId,
    "--pr", "123",
    "--done-criteria-file", doneCriteriaPath,
    "--diff-file", diffPath,
    "--review-file", reviewFile,
    "--no-comment",
    "--json",
  ], { encoding: "utf-8" });

  const result = JSON.parse(stdout);
  assert.equal(result.state, STATES.READY_TO_MERGE);
  assert.equal(result.rubricLoaded, "grandfathered");
});

[
  {
    state: "missing",
    recovery: /Restore the anchored rubric file in the run directory, or re-dispatch/i,
  },
  {
    state: "outside_run_dir",
    recovery: /Fix anchor\.rubric_path to resolve inside the run directory, then re-dispatch/i,
  },
  {
    state: "empty",
    recovery: /Regenerate the rubric with relay-plan and re-dispatch/i,
  },
  {
    state: "invalid",
    recovery: /Fix or restore the anchored rubric file, then re-dispatch/i,
  },
  {
    state: "not_set",
    recovery: /Re-dispatch from relay-plan with a persisted rubric, or explicitly grandfather/i,
  },
].forEach(({ state, recovery }) => {
  test(`review-runner fail-closes PASS when rubric state is ${state}`, () => {
    const { repoRoot, manifestPath, runId, doneCriteriaPath, diffPath } = setupRepo();
    const commentCapturePath = path.join(repoRoot, `${state}-review-comment.txt`);

    configureRubricFixture({ manifestPath, repoRoot, runId, state });
    writeFakeGhScript(repoRoot, {
      capturePath: commentCapturePath,
      prBody: "",
    });
    const reviewFile = writePassVerdict(repoRoot, `${state}-pass.json`);
    const result = runPassReview({
      repoRoot,
      runId,
      doneCriteriaPath,
      diffPath,
      reviewFile,
      noComment: false,
      env: {
        ...process.env,
        PATH: `${repoRoot}:${process.env.PATH}`,
      },
    });

    const manifest = readManifest(manifestPath).data;
    const verdictRecord = JSON.parse(fs.readFileSync(result.verdictPath, "utf-8"));
    const commentBody = fs.readFileSync(commentCapturePath, "utf-8");

    assert.equal(result.rubricLoaded, state);
    assert.equal(result.state, STATES.REVIEW_PENDING);
    assert.equal(result.nextState, STATES.REVIEW_PENDING);
    assert.equal(result.appliedVerdict, "escalated");
    assert.equal(result.reviewGate.status, "rubric_state_failed_closed");
    assert.equal(result.reviewGate.layer, "review-runner");
    assert.equal(result.reviewGate.rubricState, state);
    assert.match(result.reviewGate.recovery, recovery);

    assert.equal(manifest.state, STATES.REVIEW_PENDING);
    assert.equal(manifest.next_action, "repair_rubric_and_rerun_review");
    assert.equal(manifest.review.latest_verdict, "rubric_state_failed_closed");
    assert.equal(manifest.review.last_gate.layer, "review-runner");
    assert.equal(manifest.review.last_gate.rubric_state, state);
    assert.match(manifest.review.last_gate.recovery, recovery);

    assert.equal(verdictRecord.verdict, "pass");
    assert.equal(verdictRecord.next_action, "ready_to_merge");
    assert.equal(verdictRecord.relay_gate.status, "rubric_state_failed_closed");
    assert.equal(verdictRecord.relay_gate.layer, "review-runner");
    assert.equal(verdictRecord.relay_gate.rubric_state, state);
    assert.match(verdictRecord.relay_gate.recovery, recovery);

    assert.match(commentBody, /Verdict: ESCALATED/);
    assert.match(commentBody, /Layer: review-runner/);
    assert.match(commentBody, new RegExp(`Rubric state: ${state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(commentBody, recovery);
  });
});
