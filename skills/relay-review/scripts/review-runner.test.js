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
  updateManifestState,
  writeManifest,
  readManifest,
} = require("../../relay-dispatch/scripts/relay-manifest");

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

function writeVerdict(repoRoot, name, verdict) {
  const filePath = path.join(repoRoot, name);
  fs.writeFileSync(filePath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");
  return filePath;
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
  ], { encoding: "utf-8", stdio: "pipe" }), /PASS verdict cannot have scope_drift\.missing entries with status not_done or changed/);
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
        { factor: "Coverage", target: ">= 8", observed: "5", status: "fail", notes: "low" },
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
